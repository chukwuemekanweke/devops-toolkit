# DevOps Toolkit

`devops-toolkit` is the central home for reusable GitHub Actions CI/CD capabilities shared by application repositories. It separates maintained implementation from application-owned triggers, topology, configuration, environments, and approvals.

The initial consumers are:

- .NET 10 solutions with independently testable unit and integration suites and one or more container images.
- pnpm/Turborepo Next.js monorepos with independently deployable applications.
- Linux VPS environments that run immutable releases with Docker Compose.

## Status

This repository provides the governance and validation foundation for public contracts and the implemented .NET, Next.js, OCI image publishing, and VPS deployment capabilities. Rollback stays explicitly planned until its implementation ticket lands.

| Workflow | Status | Capability |
| --- | --- | --- |
| `dotnet-ci.yml` | Implemented | Restore, format, build, unit test, Testcontainers integration test, and report coverage |
| `nextjs-ci.yml` | Implemented | Install, lint, type-check, test, and build all or selected pnpm workspaces |
| `docker-publish.yml` | Implemented | Validate, build, scan, and publish one or many OCI images and produce an immutable release manifest |
| `vps-deploy.yml` | Implemented | Deploy an immutable manifest to an independent Docker Compose stack on a VPS: runtime secrets, optional one-shot migration, health verification, automatic restoration, audit history |
| `release-config-check.yml` | Implemented | Validate image and deployment configuration on pull requests with the publish and deploy validation code, without secrets |
| `vps-rollback.yml` | Planned | Restore a recorded manifest without rebuilding source |

DEVOPS-007 implements the host-side portion of the Doppler Developer-plan architecture: a pinned CLI adapter, strict versioned instance/key-manifest validation, isolated tmpfs key-per-file generations, atomic lifecycle commands, hardened systemd templates, and a read-only Compose contract. GitHub Actions and application containers never receive Doppler tokens or production values. See [Doppler runtime secrets](docs/doppler/architecture.md) and the [VPS operating guide](docs/doppler/vps-bootstrap.md).

DEVOPS-009 implements `vps-deploy.yml`. It deploys an application-owned Compose stack through a constrained host interface: each deploy key is bound to one stack by an SSH forced command, sudo allows only the toolkit's root helper, and a root-owned stack registry authorizes paths, provenance, and secrets. The helper locks the stack, stages and policy-checks the Compose model, pulls images by digest, renders DEVOPS-007 secrets before an optional one-shot migration, recreates only changed containers, verifies health, and either commits the release or restores the previous one. A systemd stack unit starts the active release at boot only after runtime-secret initialization. See [VPS deployment operations](docs/vps-deployment.md).

DEVOPS-010 hardens that lifecycle for migration safety:

- A migration is accepted only when its container has terminated with exit code `0`.
- A migrator still running from an interrupted deployment blocks the next deployment instead of being removed.
- Containers restarted during health verification fail the release.
- Restoration recreates only application images from recorded digests and never touches the database.
- Every deployment reports a machine-readable outcome, failed phase, migration status, and restoration outcome for caller-owned alerting.

Deployment is health-gated, not zero-downtime. Schema changes must follow [expand/migrate/contract](docs/vps-deployment.md#database-compatibility-expand-migrate-contract).

The toolkit validates itself on pull requests and pushes to `main` through `.github/workflows/validate.yml`. It checks workflow syntax, YAML structure, schema fixtures, reference topologies, implemented reusable-workflow interfaces, and security invariants. It is a repository maintenance workflow, not a public reusable capability.

## Design principles

- Centralized implementation, decentralized configuration.
- Small, independently composable workflows instead of a single pipeline.
- Application-specific paths, names, and topology are caller inputs.
- Deployable definitions live in each application's `.github/docker-images.json`; callers pass its path rather than an inline matrix.
- Least-privilege permissions and explicitly named secrets.
- Digests and deployment manifests, not `latest`, identify deployed releases.
- Stable public contracts governed by Semantic Versioning.

## Repository layout

```text
.github/workflows/   Repository validation plus later reusable workflow implementations
actions/             Composite actions only when step-level reuse is justified
src/validation/      TypeScript repository, contract, schema, and security validation
scripts/             Small, testable helpers used by workflows
systemd/             Runtime-secret and deployment stack unit templates and sudoers policy examples
tests/               Vitest suites, schema fixtures, and privileged Linux integration harnesses
examples/
  dotnet/            Thin .NET caller, production Compose, and host stack registry examples
  nextjs/            Thin pnpm/Next.js caller, production Compose, and host stack registry examples
  runtime-secrets/   Application-owned host and Compose contract example
docs/                Architecture, contracts, security, and operating policy
```

Directories without an implementation artifact are intentionally not created. Reusable workflows must live directly in `.github/workflows/`; GitHub does not discover reusable workflows in subdirectories. Composite actions are step-level building blocks and cannot replace a reusable workflow's jobs, permissions, environments, or orchestration. Scripts must remain implementation details rather than public caller interfaces.

## Application-owned image definitions

An application declares component IDs, Docker Hub repositories, Dockerfiles, and optional build contexts in `.github/docker-images.json`. The publishing caller supplies `deployment-id` and `image-config-path`; the toolkit validates the caller file, builds its matrix, publishes images, and generates the immutable digest manifest used by deploy and rollback. Static image configuration and generated release manifests are deliberately separate. See [image configuration](docs/image-configuration.md).

## Consuming the toolkit

A consuming repository owns event triggers, filters, explicit permissions, secret mapping, environment selection, approvals, and job orchestration. It calls a toolkit workflow as an entire job:

```yaml
jobs:
  verify:
    permissions:
      contents: read
    # Use a validated immutable release tag or full commit SHA when adopting.
    uses: chukwuemekanweke/devops-toolkit/.github/workflows/dotnet-ci.yml@<full-commit-sha>
    with:
      solution-path: Example.slnx
      dotnet-version: 10.0.x
```

No `v1` alias has been promoted yet. During development, smoke-test the feature branch or an immutable feature commit. Adopt only a validated immutable release tag or full commit SHA; use a mutable `@v1` alias only after the documented release process creates it. `@main` is not a supported production reference. See [versioning](docs/versioning.md).

Never use `secrets: inherit` as the default. Map only the secrets named by the selected workflow contract. Deployment jobs must be isolated from pull-request verification and protected by GitHub Environments. See [security](docs/security.md).

## Documentation

- [Architecture and ownership](docs/architecture.md)
- [Authoritative workflow contracts](docs/workflow-contracts.md)
- [Application-owned image configuration](docs/image-configuration.md)
- [Deployment and manifest model](docs/deployment-model.md)
- [VPS deployment operations](docs/vps-deployment.md) (host preparation, Compose policy, health, recovery)
- [Security architecture](docs/security.md)
- [Doppler runtime secrets architecture](docs/doppler/architecture.md) (design)
  - [Secret inventory](docs/doppler/secret-inventory.md)
  - [Access policy and service tokens](docs/doppler/access-policy.md)
  - [VPS bootstrap and runtime delivery](docs/doppler/vps-bootstrap.md)
  - [Rotation and revocation](docs/doppler/rotation-and-revocation.md)
  - [Audit and threat model](docs/doppler/audit-and-threat-model.md)
- [Runtime-secret example](examples/runtime-secrets/README.md)
- [Versioning and compatibility](docs/versioning.md)
- [Consumer migration guide](docs/migration-guide.md)
- [Repository validation and contribution](docs/repository-validation.md)
- [Release preparation and promotion](docs/releasing.md)
- [.NET consumer example](examples/dotnet/README.md)
- [Next.js consumer example](examples/nextjs/README.md)
