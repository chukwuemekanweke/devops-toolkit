# DevOps Toolkit

`devops-toolkit` is the central home for reusable GitHub Actions CI/CD capabilities shared by application repositories. It separates maintained implementation from application-owned triggers, topology, configuration, environments, and approvals.

The initial consumers are:

- .NET 10 solutions with independently testable unit and integration suites and one or more container images.
- pnpm/Turborepo Next.js monorepos with independently deployable applications.
- Linux VPS environments that run immutable releases with Docker Compose.

## Status

This repository currently provides the governance and validation foundation for the public contracts. The five capability workflows below are **planned and not implemented yet**. Example callers are illustrative and will not run until later tickets add the corresponding files under `.github/workflows/`.

| Planned workflow | Capability |
| --- | --- |
| `dotnet-ci.yml` | Restore, format, build, unit test, integration test, and report coverage |
| `nextjs-ci.yml` | Install, lint, type-check, test, and build selected pnpm workspaces |
| `docker-publish.yml` | Build and publish one or many images and produce an immutable release manifest |
| `vps-deploy.yml` | Deploy a manifest to a Docker Compose VPS and verify health |
| `vps-rollback.yml` | Restore a recorded manifest without rebuilding source |

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
scripts/             Small, testable helpers used by workflows
tests/               Positive and negative schema/validation fixtures
examples/
  dotnet/            Thin .NET caller examples
  nextjs/            Thin pnpm/Next.js caller examples
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
    uses: chukwuemekanweke/devops-toolkit/.github/workflows/dotnet-ci.yml@v1
    with:
      solution-path: Example.slnx
      dotnet-version: 10.0.x
```

Production consumers may use the compatible mutable `@v1` alias. Consumers that need reproducible workflow code should pin an immutable `@v1.2.3` tag or full commit SHA. `@main` is not a supported production reference. See [versioning](docs/versioning.md).

Never use `secrets: inherit` as the default. Map only the secrets named by the selected workflow contract. Deployment jobs must be isolated from pull-request verification and protected by GitHub Environments. See [security](docs/security.md).

## Documentation

- [Architecture and ownership](docs/architecture.md)
- [Authoritative workflow contracts](docs/workflow-contracts.md)
- [Application-owned image configuration](docs/image-configuration.md)
- [Deployment and manifest model](docs/deployment-model.md)
- [Security architecture](docs/security.md)
- [Versioning and compatibility](docs/versioning.md)
- [Consumer migration guide](docs/migration-guide.md)
- [Repository validation and contribution](docs/repository-validation.md)
- [Release preparation and promotion](docs/releasing.md)
- [.NET consumer example](examples/dotnet/README.md)
- [Next.js consumer example](examples/nextjs/README.md)
