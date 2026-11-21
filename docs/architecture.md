# Architecture and ownership

## Purpose

This repository centralizes reusable CI/CD implementation while leaving application policy with each consuming repository. The boundary prevents workflow logic from being copied without turning the toolkit into an application configuration store.

## Responsibility boundaries

| Owner | Responsibilities |
| --- | --- |
| Toolkit | Reusable workflow implementation, validation, documented interfaces, secure defaults, release compatibility, and toolkit changelog |
| Consuming repository | Triggers, branch/path filters, topology and paths, `.github/docker-images.json`, Docker/Compose definitions, input values, explicit permissions and secrets, job dependencies, deployment environment selection, and approvals |
| Server provisioning | Operating system, Docker/Compose installation, firewall, users, SSH policy, directories, storage, backups, and observability prerequisites |
| Docker Compose | Environment-specific service wiring, networks, volumes, runtime configuration, health checks, and mapping manifest image references into services |
| Application | Startup behavior, application health semantics, migration compatibility, configuration validation, and graceful shutdown |

Terraform may provision future servers and prerequisites, but is not a dependency of deployment workflows. CI/CD consumes a ready target and must fail clearly if its prerequisites are absent.

## Capability model

The implemented .NET CI workflow and four planned reusable workflows form a pipeline without requiring a single orchestrator:

```text
dotnet-ci / nextjs-ci
          |
          v
  docker-publish  --> immutable deployment manifest
                              |
                              v
                         vps-deploy
                              |
                    recorded deployment state
                              |
                              v
                         vps-rollback
```

The caller connects jobs with `needs` and chooses which capabilities to use. CI workflows never receive production credentials. Publishing produces release identity; it does not select an environment. Deployment consumes a release identity; it does not build source. Rollback consumes recorded state; it does not rebuild an old commit.

## Repository boundaries

- `.github/workflows/` contains directly callable job-level workflows. Files must be at this exact depth.
- `actions/` contains composite actions used inside jobs when several workflows need the same steps.
- `scripts/` contains narrow helpers whose inputs can be validated and tested outside Actions.
- `examples/` contains caller-owned workflow examples, not toolkit implementation.
- `docs/` is the authoritative public architecture and operating policy.

No empty placeholder directory is retained. Later tickets create implementation directories only with real content.

## Topology support

The contracts model topology as application-owned versioned data:

- The current .NET reference has WebAPI, Consumer, Jobs, and DatabaseMigrator Dockerfiles, while CI separately builds, runs unit tests, runs Testcontainers-based integration tests, and combines coverage. CI verifies Docker availability but does not start a Compose stack; the application fixtures own PostgreSQL, RabbitMQ, Redis, Tempo, and OpenTelemetry Collector lifecycle.
- The current frontend reference is a pnpm 11/Turborepo workspace with User, Admin, and Public portals. Each portal owns its build and deployment lifecycle.

Neither topology is embedded in toolkit code or discovered dynamically. Each application commits its fixed known deployables to `.github/docker-images.json`, and the caller passes `image-config-path`. The backend example declares four components; the frontend example declares three. Other consumers may declare a different fixed count without selecting a toolkit-specific preset. Publishing converts the validated file into an internal matrix and the generated release manifest maps stable component names to immutable image digests.

Static image configuration belongs to the application and describes how to build. A generated release manifest belongs to a specific publish run and describes exactly what was built. Environment-specific Compose files map those release components to runtime services. Long-lived runtime application secrets are delivered separately by the later Infisical design; the toolkit repository and deployment workflow do not store them.

## Ownership and change management

The initial model assumes one maintainer:

- `.github/CODEOWNERS` assigns public workflows, scripts, schemas, security, and versioning material to `@chukwuemekanweke`. CODEOWNERS records ownership; enforcement depends on branch-protection review settings.
- All changes use pull requests, even for the sole maintainer, so validation and review evidence are retained.
- Public contract, permissions, secret, deployment, or third-party dependency changes require an explicit contract/security review in the pull request.
- Security-sensitive changes should receive a second knowledgeable reviewer when one is available. If none is available, record the risk review and test evidence before release.
- Releases require passing validation, an updated changelog, and an approved compatibility classification.
- Deprecations are documented before removal, retain behavior throughout the current major line, and include a migration path. Removal occurs only in the next major release unless an active vulnerability requires an exceptional response.

Repository settings that must be configured manually:

1. Protect `main`; require pull requests and required validation checks.
2. Protect release tags and restrict who can create or move `v*` tags.
3. Require review for production GitHub Environments and restrict deployment branches/tags.
4. Limit allowed Actions and reusable workflows; require SHA pins where repository policy permits.
5. Enable secret scanning, push protection, Dependabot, and audit retention supported by the account plan.
6. Enable required code-owner review when the repository's collaboration model requires it.

These are recommendations, not claims about current GitHub settings.

## Architectural decision rules

A new input is preferred over application detection when callers can express the difference. A new workflow is preferred when a capability has distinct credentials, lifecycle, or failure semantics. A composite action is preferred only when reusable steps do not require job-level permissions or environments. A script is preferred when parsing, validation, or remote state transitions need focused tests.

Avoid provider-neutral abstractions until a second provider is implemented. The Docker contract makes registry host and image names explicit so GHCR can be added compatibly, while the first implementation may support only Docker Hub.
