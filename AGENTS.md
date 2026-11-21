# Agent instructions

This repository publishes public CI/CD contracts. Treat workflow filenames, inputs, outputs, secrets, permissions, manifest schemas, and established behavior as versioned API surface.

## Before changing the toolkit

1. Read `docs/architecture.md`, `docs/workflow-contracts.md`, `docs/security.md`, and `docs/versioning.md` for the affected capability.
2. Inspect the current consuming template repositories when a change depends on application topology; do not rely on stale assumptions.
3. Check `CHANGELOG.md` and the migration guide for compatibility commitments.

## Implementation rules

- Preserve documented public contracts. A breaking change requires an explicit major-version decision and migration plan.
- Keep deployable definitions application-owned through the versioned image configuration contract. Do not move component topology into toolkit presets or inline caller matrices.
- Keep reusable workflows independently composable and application agnostic. Never hardcode solution names, project names, portal names, image names, deployment paths, hosts, or registry namespaces.
- Use `workflow_call` inputs supported by GitHub (`boolean`, `number`, or `string`) and document every input, output, secret, permission, default, and failure mode.
- Require callers to map named secrets explicitly; do not make `secrets: inherit` the normal integration path.
- Apply least privilege to `GITHUB_TOKEN` and separate build/test credentials from deployment credentials.
- Treat workflow inputs as untrusted data. Validate structured input and quote shell values; never interpolate unchecked input into shell programs.
- Pin third-party actions to reviewed full commit SHAs in implemented workflows. Record the human-readable release beside the pin.
- Keep workflow capabilities separate. Extract a composite action only for genuine step-level reuse, and a script only when it improves testability or safe argument handling.
- Update relevant documentation and examples whenever a contract or behavior changes.
- Update both image/release schemas and the four-backend/three-frontend examples when either contract evolves.
- Validate changes against both reference topologies and preserve migration-first backend deployment semantics.
- Add proportionate syntax, schema, and behavior validation with workflow implementations.
- Add an entry under `CHANGELOG.md` > `Unreleased` for user-visible changes.

Do not create placeholder workflows that report success. A workflow file is added only when its capability is implemented and testable.
