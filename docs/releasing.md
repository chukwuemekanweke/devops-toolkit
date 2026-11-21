# Release preparation and promotion

Toolkit releases follow `docs/versioning.md`. A release is eligible only after a genuinely usable reusable workflow exists; repository governance alone is not published as `v1`.

## Release checklist

1. Record the compatibility classification and review public inputs, outputs, secrets, permissions, defaults, artifacts, schemas, and failure behavior.
2. Require successful repository validation plus applicable unit, behavior, negative, and consumer smoke tests.
3. Review every dependency change and its immutable pin.
4. Update the changelog, contracts, migration guidance, and examples.
5. Create the immutable Semantic Versioning tag, such as `v1.0.0`, through the protected release process.
6. Verify the remote tag target and run representative consumers against that exact tag.
7. Obtain explicit release approval.
8. Only then move the protected mutable major alias, such as `v1`, to the already validated commit and verify its target.

Validation never creates or advances tags. A release operator must not move an immutable tag, advance `v1` after every merge, or recommend `main` to production consumers. Protected tag rules, authorized release actors, and required approvals are repository settings configured outside source control.

