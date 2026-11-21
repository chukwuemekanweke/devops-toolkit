# Repository validation and contribution

## What validation covers

`.github/workflows/validate.yml` runs for pull requests targeting `main`, pushes to `main`, and manual dispatches with only `contents: read`. It performs four independent checks:

1. `actionlint` validates GitHub Actions syntax and expressions through a reviewed wrapper pinned to a full commit SHA. The wrapper executes a digest-pinned actionlint container.
2. Vitest unit tests validate positive and negative fixtures against the image-configuration and deployment-manifest schemas. They also assert that the reference backend still has four images and the frontend has three; exercise .NET CI input/path validation, deterministic discovery, multi-project failure propagation, Docker-skip detection, coverage expectations, artifact staging, and result outputs; and cover Next.js CI input, filter, package-manager, build-config, artifact, and result behavior.
3. Repository validation parses YAML with duplicate-key rejection, validates both example image configurations, and enforces security rules such as full-SHA Action pins, no `pull_request_target`, no `secrets: inherit`, and no direct `${{ inputs.* }}` interpolation in `run` scripts.
4. Every real reusable workflow is compared with the matching inputs, outputs, secrets, types, defaults, and required flags in `docs/workflow-contracts.md`. The Markdown tables remain authoritative; there is no second handwritten contract manifest.

Some requirements remain review responsibilities: dependency source/release-note review, whether granted permissions are operationally necessary, indirect shell/data-flow safety, secret scope, and compatibility classification.

## Local commands

Use Node.js 22 and the committed npm lockfile:

```text
npm ci
npm run typecheck
npm test
npm run validate
```

Run actionlint locally after changing workflow YAML when the binary is available. The GitHub workflow's SHA-pinned wrapper and digest-pinned container remain the authoritative actionlint execution.

## Adding a reusable workflow

Only add a workflow when it performs its advertised capability and can fail meaningfully. Place it directly in `.github/workflows/`, implement `workflow_call`, preserve its documented contract, pin external Actions to reviewed full SHAs, and grant least privilege. Add behavior tests, failure cases, contract checks, documentation, examples, and a changelog entry in the same pull request.

Each implementation ticket also adds a consumer smoke workflow or fixture that invokes the workflow as a job and proves input enforcement, explicit secrets, restricted permissions, outputs, and failure propagation. Before a release exists, test the feature branch or immutable commit SHA; do not create a runnable `@v1` smoke caller. The DEVOPS-002 repository pipeline is not itself a public reusable capability, so no artificial echo/file-existence smoke workflow is included.

`.NET CI` is implemented by DEVOPS-003 and Next.js CI by DEVOPS-004. Image publishing, VPS deployment, and VPS rollback remain deferred to their own tickets.

