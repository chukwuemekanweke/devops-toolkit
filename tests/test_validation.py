from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from validation import ValidationError, validate_document  # noqa: E402
from validate_repository import load_yaml, validate_contract, validate_security  # noqa: E402


class SchemaFixtureTests(unittest.TestCase):
    def assert_fixture_sets(self, contract: str, schema_name: str) -> None:
        schema = ROOT / "docs" / "schemas" / schema_name
        fixture_root = ROOT / "tests" / "fixtures" / contract
        valid = sorted((fixture_root / "valid").glob("*.json"))
        invalid = sorted((fixture_root / "invalid").glob("*.json"))
        self.assertTrue(valid, f"{contract} needs at least one positive fixture")
        self.assertTrue(invalid, f"{contract} needs at least one negative fixture")
        for path in valid:
            with self.subTest(path=path):
                validate_document(path, schema)
        for path in invalid:
            with self.subTest(path=path):
                with self.assertRaises(ValidationError):
                    validate_document(path, schema)

    def test_docker_image_configuration_fixtures(self) -> None:
        self.assert_fixture_sets("docker-images", "docker-images.schema.json")

    def test_deployment_manifest_fixtures(self) -> None:
        self.assert_fixture_sets("deployment-manifest", "deployment-manifest.schema.json")

    def test_reference_topologies(self) -> None:
        schema = ROOT / "docs" / "schemas" / "docker-images.schema.json"
        for path, expected_count in (
            (ROOT / "examples" / "dotnet" / "docker-images.json", 4),
            (ROOT / "examples" / "nextjs" / "docker-images.json", 3),
        ):
            with self.subTest(path=path):
                validate_document(path, schema)
                import json

                self.assertEqual(expected_count, len(json.loads(path.read_text())["images"]))


class SecurityPolicyTests(unittest.TestCase):
    def assert_rejected(self, body: str) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid.yml"
            path.write_text(body, encoding="utf-8")
            workflow = load_yaml(path)
            with self.assertRaises(ValidationError):
                validate_security(path, workflow)

    def test_unpinned_action_is_rejected(self) -> None:
        self.assert_rejected(
            "on: workflow_dispatch\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - uses: actions/checkout@v4\n"
        )

    def test_secrets_inherit_is_rejected(self) -> None:
        self.assert_rejected(
            "on: workflow_dispatch\npermissions: {}\njobs:\n  test:\n"
            "    uses: owner/repository/.github/workflows/test.yml@0123456789012345678901234567890123456789\n"
            "    secrets: inherit\n"
        )

    def test_pull_request_target_is_rejected(self) -> None:
        self.assert_rejected(
            "on:\n  pull_request_target:\npermissions: {}\njobs:\n"
            "  test:\n    runs-on: ubuntu-latest\n    steps: []\n"
        )

    def test_input_interpolation_in_shell_is_rejected(self) -> None:
        self.assert_rejected(
            "on:\n  workflow_call:\n    inputs:\n      value:\n        type: string\n"
            "permissions: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
            "    steps:\n      - run: echo '${{ inputs.value }}'\n"
        )


class ContractValidationTests(unittest.TestCase):
    CONTRACT = """## `sample.yml`

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `name` | string | yes | — | Example name |
| `enabled` | boolean | no | `true` | Example switch |

### Secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `token` | yes | Example token |

### Permissions

Minimum: `contents: read`.

### Outputs

| Name | Value |
| --- | --- |
| `result` | Example result |
"""

    def workflow(self) -> dict:
        return {
            "on": {
                "workflow_call": {
                    "inputs": {
                        "name": {"type": "string", "required": True},
                        "enabled": {"type": "boolean", "default": True},
                    },
                    "secrets": {"token": {"required": True}},
                    "outputs": {"result": {"value": "value"}},
                }
            },
            "permissions": {"contents": "read"},
            "jobs": {},
        }

    def test_matching_contract_is_accepted(self) -> None:
        validate_contract(Path("sample.yml"), self.workflow(), self.CONTRACT)

    def test_contract_drift_is_rejected(self) -> None:
        workflow = self.workflow()
        workflow["on"]["workflow_call"]["inputs"]["enabled"]["default"] = False
        with self.assertRaises(ValidationError):
            validate_contract(Path("sample.yml"), workflow, self.CONTRACT)


if __name__ == "__main__":
    unittest.main()

