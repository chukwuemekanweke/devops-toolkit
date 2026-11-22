# Repository validation and contribution

## What validation covers

`.github/workflows/validate.yml` runs for pull requests targeting `main`, pushes to `main`, and manual dispatches with only `contents: read`. It performs four independent checks:

1. `actionlint` validates GitHub Actions syntax and expressions through a reviewed wrapper pinned to a full commit SHA. The wrapper executes a digest-pinned actionlint container.
2. Vitest unit tests validate positive and negative fixtures against the image-configuration and deployment-manifest schemas. They also assert that the reference backend still has four images and the frontend has three; exercise OCI configuration normalization, path and credential safety, matrix data, digest evidence, scan gating, and manifest aggregation; exercise .NET CI input/path validation, deterministic discovery, multi-project failure propagation, Docker-skip detection, coverage expectations, artifact staging, and result outputs; and cover Next.js CI input, filter, package-manager, build-config, artifact, and result behavior.
3. Repository validation parses YAML with duplicate-key rejection, validates both example image configurations, and enforces security rules such as full-SHA Action pins, no `pull_request_target`, no `secrets: inherit`, and no direct `${{ inputs.* }}` interpolation in `run` scripts.
4. Every real reusable workflow is compared with the matching inputs, outputs, secrets, types, defaults, and required flags in `docs/workflow-contracts.md`. The Markdown tables remain authoritative; there is no second handwritten contract manifest.

VPS deployment adds unit tests for manifest and request validation, malicious input, SSH target and host-key handling, the Compose policy, the host stack registry, and the deployment state machine with injected adapters (first and subsequent deployment, pull/Compose/secret/migration failures, unhealthy rollout with successful and failed restoration, rollback disabled, concurrency, separate stacks, pruning, and fail-closed start). Example host stack registries are validated against `docs/schemas/vps-deploy-stack.schema.json`, and example deployment configuration files against `docs/schemas/vps-deploy-config.schema.json`. Unit tests cover the deployment configuration file (translation to inline inputs, conflicts with inline inputs, path and symlink rejection, malformed documents) and `release-config-check.mjs` (image, request, and registry-copy agreement, host-identical Compose staging, the Compose policy, and runtime-secret mount layout, including rejection cases). A Linux-only test runs the same check through the real Docker Compose CLI when it is available.

A separate `vps-deploy-linux` job runs two privileged harnesses. Neither reports success when a check is skipped or cannot run:

- `npm run test:vps-deploy:linux` (`tests/integration/vps-deploy-docker.sh`) starts a disposable Docker-in-Docker host with a local registry mirror for `docker.io` digests. It installs the helper with its installer, configures a real `sshd` forced command and sudoers policy, and runs the real engine with real Docker Compose, DEVOPS-007 tmpfs generations, and a stub `doppler` binary. The checks cover deployment, restoration, recreation, secret mounts, `docker inspect` exposure, filesystem modes, concurrency, separate stacks, a simulated reboot, and both reference topologies.
- `npm run test:vps-deploy:systemd` (`tests/integration/vps-deploy-systemd.sh`) boots a disposable Debian 12 systemd container. It provisions the real DEVOPS-007 and vps-deploy units (encrypted credential, render identity, tmpfiles, generated boot drop-in), then restarts the container to prove fail-closed boot with Doppler unavailable, ordered startup with Doppler available, and refresh-outage isolation.

Live Doppler authorization, a real VPS reboot, Docker Hub pulls with a real token, and GitHub Environment approvals are outside these harnesses and must be verified on a disposable VPS before production use.

Some requirements remain review responsibilities: dependency source/release-note review, whether granted permissions are operationally necessary, indirect shell/data-flow safety, secret scope, and compatibility classification.

## Local commands

Use Node.js 22 and the committed npm lockfile:

```text
npm ci
npm run typecheck
npm test
npm run validate
```

Run actionlint locally after changing workflow YAML when the binary is available. The VPS deployment harnesses need a Docker daemon that permits `--privileged` containers:

```text
npm run test:vps-deploy:linux
npm run test:vps-deploy:systemd
``` The GitHub workflow's SHA-pinned wrapper and digest-pinned container remain the authoritative actionlint execution.

## Adding a reusable workflow

Only add a workflow when it performs its advertised capability and can fail meaningfully. Place it directly in `.github/workflows/`, implement `workflow_call`, preserve its documented contract, pin external Actions to reviewed full SHAs, and grant least privilege. Add behavior tests, failure cases, contract checks, documentation, examples, and a changelog entry in the same pull request.

Each implementation ticket also adds a consumer smoke workflow or fixture that invokes the workflow as a job and proves input enforcement, explicit secrets, restricted permissions, outputs, and failure propagation. Before a release exists, test the feature branch or immutable commit SHA; do not create a runnable `@v1` smoke caller. The DEVOPS-002 repository pipeline is not itself a public reusable capability, so no artificial echo/file-existence smoke workflow is included.

`.NET CI` is implemented by DEVOPS-003, Next.js CI by DEVOPS-004, OCI publishing by DEVOPS-005, and VPS deployment by DEVOPS-009. VPS rollback remains deferred to its own ticket.

