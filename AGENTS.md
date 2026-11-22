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

## Runtime-secret contracts

- Treat the version-1 instance and key-manifest schemas, CLI commands/categories, `/run/runtime-secrets` layout, and `/run/secrets/app` target as public contracts.
- Default generations are tmpfs-only. Do not reintroduce persistent plaintext, Doppler fallback files, `doppler run`, container/pipeline tokens, secret environment variables, or automatic stale fallback.
- Preserve service isolation, key allowlisting, provider scope checks, no-follow/exclusive writes, atomic pointers, conservative explicit pruning, and fail-closed boot ordering.
- Activation is not application-health validation. Existing bind mounts change only after container recreation; deployment orchestration remains outside the host helper.
- Linux-only security behavior must have an explicit runnable harness and must never be reported as passing when skipped.

## VPS deployment contracts

- Treat the host stack registry schema (`vps-deploy-stack.schema.json` v1), the forced-command/sudo interface (`vps-deploy-ssh` → `vps-deploy-host.mjs deploy --stack <stack>`), the remote state layout, and `vps-deploy-stack@.service` as public contracts alongside `vps-deploy.yml`.
- Never accept remote shell text from workflow inputs, add the deploy identity to the `docker` group, relax strict host-key checking, or let a request widen what the host registry authorizes.
- Keep the Compose policy fail-closed: new Compose features that can reach host resources are rejected until reviewed and explicitly allowed.
- Failures before rollout must not change running containers, `current` generations, or `active.json`; the job fails whenever the new release did not pass health, including after a successful restoration.
- Migration success is only a terminated migrator container with recorded exit code `0`. Never treat health, a CLI status, or a still-running container as success, never remove a migrator left running by an interrupted deployment, and never report the database as unchanged once the migrator ran. Restoration must never run migrations or touch the database.
- The `deployment-outcome`, `migration-status`, and `restoration-outcome` vocabularies are public contracts. Keep alert delivery caller-owned and outside the deployment job and the host.
- Deployment and systemd behavior changes must pass `npm run test:vps-deploy:linux` and `npm run test:vps-deploy:systemd`.

## Local validation

Install the locked Node.js 22 dependencies, then run:

```text
npm ci
npm run typecheck
npm test
npm run validate
```

Run `actionlint` against `.github/workflows/` after changing workflow YAML. The repository validation workflow uses a reviewed wrapper pinned to a full commit SHA; the wrapper runs a digest-pinned actionlint container.
