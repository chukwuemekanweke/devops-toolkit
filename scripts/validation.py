"""Shared validation helpers for repository schemas and fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


class ValidationError(ValueError):
    """Raised when a toolkit document is invalid."""


def load_json(path: Path) -> Any:
    """Load JSON while rejecting duplicate object properties."""

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValidationError(f"{path}: duplicate JSON property {key!r}")
            result[key] = value
        return result

    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=reject_duplicates)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ValidationError(f"{path}: invalid JSON: {exc}") from exc


def validate_document(document_path: Path, schema_path: Path) -> None:
    """Validate a JSON document and toolkit-wide uniqueness invariants."""

    document = load_json(document_path)
    schema = load_json(schema_path)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(document), key=lambda item: list(item.absolute_path))
    if errors:
        details = "; ".join(
            f"{'.'.join(map(str, error.absolute_path)) or '<root>'}: {error.message}"
            for error in errors
        )
        raise ValidationError(f"{document_path}: schema validation failed: {details}")

    collection = document.get("images") or document.get("components")
    if collection:
        identity_key = "component" if "images" in document else "name"
        identities = [item[identity_key] for item in collection]
        duplicates = sorted({value for value in identities if identities.count(value) > 1})
        if duplicates:
            raise ValidationError(
                f"{document_path}: duplicate {identity_key} values: {', '.join(duplicates)}"
            )

