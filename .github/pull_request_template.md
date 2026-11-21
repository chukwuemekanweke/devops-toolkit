## Summary

Describe the change and the capability it affects.

## Public contract and security review

- [ ] I classified compatibility (patch, minor, major, or no public-contract change).
- [ ] Inputs, outputs, secrets, permissions, defaults, schemas, artifacts, and failure behavior remain compatible or have an approved migration plan.
- [ ] Token permissions and named-secret mappings use least privilege; no `secrets: inherit` dependency was introduced.
- [ ] New or updated third-party Actions are reviewed and pinned to full commit SHAs.
- [ ] Untrusted pull-request code cannot reach publishing or deployment credentials.

## Evidence

- [ ] `python -m unittest discover -s tests -v`
- [ ] `python scripts/validate_repository.py`
- [ ] `actionlint` (or the repository validation workflow)
- [ ] Relevant positive, negative, and consumer smoke scenarios are documented.
- [ ] `CHANGELOG.md` and affected documentation/examples are updated.

