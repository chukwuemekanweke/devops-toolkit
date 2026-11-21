"""Validate repository YAML, public workflow contracts, and security policy."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from typing import Any

import yaml

from validation import ValidationError, validate_document

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
CONTRACTS = ROOT / "docs" / "workflow-contracts.md"
SHA = re.compile(r"^[0-9a-f]{40}$")
PLANNED = {
    "dotnet-ci.yml",
    "nextjs-ci.yml",
    "docker-publish.yml",
    "vps-deploy.yml",
    "vps-rollback.yml",
}
SECRET_SIGNATURES = {
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "GitHub token": re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b"),
    "AWS access key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
}


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def construct_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode, deep: bool = False) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise ValidationError(f"duplicate YAML key {key!r} at line {key_node.start_mark.line + 1}")
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping
)
# GitHub Actions uses YAML 1.2-like booleans; PyYAML otherwise turns `on` into True.
for first_character, resolvers in list(UniqueKeyLoader.yaml_implicit_resolvers.items()):
    UniqueKeyLoader.yaml_implicit_resolvers[first_character] = [
        resolver for resolver in resolvers if resolver[0] != "tag:yaml.org,2002:bool"
    ]
UniqueKeyLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool", re.compile(r"^(?:true|false)$", re.IGNORECASE), list("tTfF")
)


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        value = yaml.load(path.read_text(encoding="utf-8"), Loader=UniqueKeyLoader)
    except yaml.YAMLError as exc:
        raise ValidationError(f"{path.relative_to(ROOT)}: invalid YAML: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"{path.relative_to(ROOT)}: YAML root must be a mapping")
    return value


def contract_section(document: str, filename: str) -> str:
    match = re.search(
        rf"^## `{re.escape(filename)}`\s*$([\s\S]*?)(?=^## `|\Z)", document, re.MULTILINE
    )
    if not match:
        raise ValidationError(f"{filename}: no authoritative section in docs/workflow-contracts.md")
    return match.group(1)


def table_rows(section: str, heading: str) -> list[list[str]]:
    match = re.search(
        rf"^### {heading}\s*$([\s\S]*?)(?=^### |\Z)", section, re.MULTILINE
    )
    if not match:
        raise ValidationError(f"missing {heading} table in documented workflow contract")
    rows: list[list[str]] = []
    for line in match.group(1).splitlines():
        if not line.startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in line.strip("|").split("|")]
        if not cells or cells[0] in {"Name", "---"}:
            continue
        rows.append(cells)
    return rows


def normalize_default(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def validate_contract(path: Path, workflow: dict[str, Any], document: str) -> None:
    call = workflow.get("on", {}).get("workflow_call")
    if not isinstance(call, dict):
        return
    section = contract_section(document, path.name)
    documented_inputs = {row[0]: row for row in table_rows(section, "Inputs")}
    actual_inputs = call.get("inputs", {}) or {}
    if set(documented_inputs) != set(actual_inputs):
        raise ValidationError(f"{path.name}: workflow_call inputs differ from the documented contract")
    for name, definition in actual_inputs.items():
        row = documented_inputs[name]
        expected_required = row[2].lower() == "yes"
        if definition.get("type") != row[1] or bool(definition.get("required", False)) != expected_required:
            raise ValidationError(f"{path.name}: input {name!r} type/required metadata differs from docs")
        if not expected_required and row[3] not in {"—", "â€”"} and not row[3].startswith("current "):
            expected_default = row[3].strip('"')
            if normalize_default(definition.get("default")).strip('"') != expected_default:
                raise ValidationError(f"{path.name}: input {name!r} default differs from docs")

    for heading, key in (("Secrets", "secrets"), ("Outputs", "outputs")):
        documented = {row[0] for row in table_rows(section, heading)}
        actual = set((call.get(key, {}) or {}).keys())
        if documented != actual:
            raise ValidationError(f"{path.name}: workflow_call {key} differ from the documented contract")
        if key == "secrets":
            documented_rows = {row[0]: row for row in table_rows(section, heading)}
            for name, definition in (call.get("secrets", {}) or {}).items():
                if bool(definition.get("required", False)) != (documented_rows[name][1].lower() == "yes"):
                    raise ValidationError(f"{path.name}: secret {name!r} required flag differs from docs")

    permissions_match = re.search(
        r"^### Permissions\s*$([\s\S]*?)(?=^### |\Z)", section, re.MULTILINE
    )
    documented_permissions = set(
        re.findall(r"`([a-z-]+): (read|write)`", permissions_match.group(1) if permissions_match else "")
    )
    minimum_permissions = set(
        re.findall(
            r"minimum:\s*`([a-z-]+): (read|write)`",
            permissions_match.group(1) if permissions_match else "",
            re.IGNORECASE,
        )
    )
    actual_permissions: set[tuple[str, str]] = set()
    permission_blocks = [workflow.get("permissions", {})]
    permission_blocks.extend(
        job.get("permissions", {})
        for job in (workflow.get("jobs", {}) or {}).values()
        if isinstance(job, dict)
    )
    for block in permission_blocks:
        if isinstance(block, dict):
            actual_permissions.update((str(scope), str(level)) for scope, level in block.items())
    if not actual_permissions.issubset(documented_permissions):
        raise ValidationError(f"{path.name}: declared permissions differ from the documented contract")
    if not minimum_permissions.issubset(actual_permissions):
        raise ValidationError(f"{path.name}: documented minimum permissions are not declared")


def validate_security(path: Path, workflow: dict[str, Any]) -> None:
    triggers = workflow.get("on", {})
    if isinstance(triggers, dict) and "pull_request_target" in triggers:
        raise ValidationError(f"{path.name}: pull_request_target is prohibited")
    if "permissions" not in workflow:
        raise ValidationError(f"{path.name}: declare top-level least-privilege permissions")

    text = path.read_text(encoding="utf-8")
    if re.search(r"secrets\s*:\s*inherit", text):
        raise ValidationError(f"{path.name}: secrets: inherit is prohibited")

    for job_name, job in (workflow.get("jobs", {}) or {}).items():
        if not isinstance(job, dict):
            continue
        nodes = [job, *((job.get("steps", []) or []))]
        for node in nodes:
            if not isinstance(node, dict):
                continue
            uses = node.get("uses")
            if uses and not str(uses).startswith("./"):
                reference = str(uses).rsplit("@", 1)
                if len(reference) != 2 or not SHA.fullmatch(reference[1]):
                    raise ValidationError(
                        f"{path.name}:{job_name}: third-party action {uses!r} is not pinned to a full SHA"
                    )
            command = node.get("run")
            if command and re.search(r"\$\{\{\s*inputs\.", str(command)):
                raise ValidationError(
                    f"{path.name}:{job_name}: do not interpolate workflow inputs directly into run scripts"
                )


def main() -> int:
    errors: list[str] = []
    workflows: dict[Path, dict[str, Any]] = {}
    yaml_paths = sorted(
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.suffix.lower() in {".yml", ".yaml"}
        and ".git" not in path.parts
    )
    for path in yaml_paths:
        try:
            load_yaml(path)
        except ValidationError as exc:
            errors.append(str(exc))
    for path in sorted(WORKFLOWS.glob("*.y*ml")):
        try:
            workflow = load_yaml(path)
            workflows[path] = workflow
            validate_security(path, workflow)
        except ValidationError as exc:
            errors.append(str(exc))

    documentation = CONTRACTS.read_text(encoding="utf-8")
    for path, workflow in workflows.items():
        try:
            validate_contract(path, workflow, documentation)
        except ValidationError as exc:
            errors.append(str(exc))

    for planned in sorted(PLANNED):
        path = WORKFLOWS / planned
        if path.exists() and not isinstance(workflows.get(path, {}).get("on", {}).get("workflow_call"), dict):
            errors.append(f"{planned}: planned capability exists without a workflow_call contract")

    schema_cases = (
        (ROOT / "examples/dotnet/docker-images.json", ROOT / "docs/schemas/docker-images.schema.json"),
        (ROOT / "examples/nextjs/docker-images.json", ROOT / "docs/schemas/docker-images.schema.json"),
    )
    for document, schema in schema_cases:
        try:
            validate_document(document, schema)
        except ValidationError as exc:
            errors.append(str(exc))

    for path in sorted(item for item in ROOT.rglob("*") if item.is_file() and ".git" not in item.parts):
        if path.suffix.lower() not in {".md", ".py", ".json", ".yml", ".yaml", ".txt"}:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for label, pattern in SECRET_SIGNATURES.items():
            if pattern.search(text):
                errors.append(f"{path.relative_to(ROOT)}: possible committed {label}")

    if errors:
        print("Repository validation failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1
    print(
        f"Validated {len(workflows)} workflow(s), {len(yaml_paths)} YAML file(s), "
        "documented contracts, schemas, and security policy."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

