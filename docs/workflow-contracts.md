# Reusable workflow contracts

This document is the authoritative public interface for reusable workflows. `.NET CI`, Next.js CI, and OCI image publishing are implemented; deployment and rollback remain planned. Later implementation tickets must either conform to these contracts or apply the compatibility process in [versioning.md](versioning.md). Repository validation compares every implemented `workflow_call` interface with the matching tables in this document, so the Markdown remains the single contract authority rather than being duplicated in another manifest.

The interfaces follow GitHub's current [reusable workflow](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows), [workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), and [secure use](https://docs.github.com/en/actions/reference/security/secure-use) documentation.

## Contract conventions

- Files live directly in `.github/workflows/` and expose `on.workflow_call`.
- Inputs use only GitHub-supported `string`, `boolean`, and `number` types. Collections are UTF-8 JSON strings whose schemas are defined here.
- Workflow outputs are strings because `workflow_call.outputs` does not declare types. Values described as Boolean contain lowercase `true` or `false`; structured values contain compact JSON.
- Paths are repository-relative, use `/`, and must remain inside `GITHUB_WORKSPACE` after canonicalization.
- Newline-separated lists are used only for simple paths, package filters, or service names. Blank lines are ignored.
- Every structured input is parsed with a JSON parser and schema-validated before use. Shell fragments are not accepted as configuration.
- A caller may grant fewer permissions than listed, but the workflow cannot elevate them and will fail if a required operation is denied.
- Secrets are mapped by name. `secrets: inherit` is deliberately absent from the examples.
- Artifact names are unique per run. Outputs intended for orchestration are small; artifacts are the durable transport for reports and manifests.

## `dotnet-ci.yml`

### Purpose and callers

Runs .NET verification in distinct build, unit-test, integration-test, and coverage/reporting jobs. It is intended for .NET repositories, including the current four-container backend template, but contains no knowledge of its solution or project names. It does not publish images.

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `solution-path` | string | yes | — | Solution, solution filter, `.slnx`, or project path to restore and build |
| `dotnet-version` | string | no | `10.0.x` | SDK version accepted by `actions/setup-dotnet` |
| `working-directory` | string | no | `.` | Repository-relative command root |
| `build-configuration` | string | no | `Release` | Validated MSBuild configuration name |
| `run-format` | boolean | no | `true` | Run `dotnet format` validation before build |
| `format-diagnostics` | string | no | `IDE0005` | Comma-separated diagnostic IDs; empty means all configured formatting checks |
| `run-unit-tests` | boolean | no | `true` | Enable the unit-test job |
| `unit-test-projects` | string | no | `tests/unit/**/*.UnitTests.csproj` | Newline-separated glob patterns resolved by the workflow |
| `run-integration-tests` | boolean | no | `true` | Enable the integration-test job |
| `integration-test-projects` | string | no | `tests/integration/**/*.IntegrationTests.csproj` | Newline-separated glob patterns resolved separately from unit tests |
| `fail-on-empty-test-set` | boolean | no | `true` | Fail when an enabled test category discovers no projects |
| `collect-coverage` | boolean | no | `true` | Collect and combine Cobertura coverage from enabled test categories |
| `upload-test-artifacts` | boolean | no | `true` | Upload available TRX diagnostics even when tests fail where possible |
| `artifact-retention-days` | number | no | `14` | Retention from 1 through 90 days, validated before artifact upload |

### Secrets

No secret is universally required.

| Name | Required | Purpose |
| --- | --- | --- |
| `nuget-username` | no | Username for a private NuGet source configured by the caller's `nuget.config` |
| `nuget-token` | no | Token for that private source; must be supplied with `nuget-username` |

Private NuGet authentication remains caller-controlled. A repository should check in a `nuget.config` containing the source URL and `GITHUB_USERNAME`/`GITHUB_PAT` environment-variable credential references, then explicitly map a read-only package token. The two secrets must be supplied together; neither is required for public-only restores. A fine-grained token or `GITHUB_TOKEN` with `packages: read` is preferred where supported. Credentials are exposed only to restore steps and must not be placed in inputs, command-line arguments, cache keys, outputs, or artifacts.

### Permissions

Minimum: `contents: read`. Add `packages: read` only when `GITHUB_TOKEN` is used for GitHub Packages. No write permission is required.

### Outputs

| Name | Value |
| --- | --- |
| `build-result` | Job result: `success`, `failure`, `cancelled`, or `skipped` |
| `unit-test-result` | Unit job result, including `skipped` when disabled |
| `integration-test-result` | Integration job result, including `skipped` when disabled |
| `verification-passed` | `true` only when build and every enabled test category succeed |
| `test-results-artifact` | Combined diagnostic artifact name containing available TRX files, or empty when uploads are disabled or no test category ran |
| `coverage-artifact` | Combined coverage artifact name, or empty when coverage is disabled/unavailable |

### Execution and failure behavior

Restore and format precede build. The build job uploads its compiled `bin/<configuration>` outputs; isolated test runners restore assets, download those exact outputs, and run with `--no-build`. This costs artifact transfer but prevents the unit and integration jobs from compiling a different result. Unit and integration jobs depend on a successful build but run independently of each other.

GitHub-hosted Ubuntu runners provide Docker for Testcontainers-based integration suites. The workflow verifies the Docker daemon before testing and rejects a successful `dotnet test` result whose TRX diagnostics say Docker was unavailable. Testcontainers fixtures own infrastructure lifecycle; this workflow does not accept Compose configuration or start an application stack. Docker Compose remains appropriate for application-owned local and deployment orchestration, not this CI contract.

Discovery is deterministic, supports multiple newline-separated `*`, `**`, and `?` project globs, preserves paths containing spaces, and rejects absolute paths, traversal, unsupported glob syntax, and symlink escape. Every discovered project runs even after an earlier failure, and any failed project fails its category. An enabled empty category fails by default; setting `fail-on-empty-test-set: false` makes it a successful no-op. Disabled jobs report `skipped`.

The coverage/report job uses `if: always()` to retain available diagnostics without concealing upstream failures. Coverage collection uses each test project's `coverlet.collector`, and the report job combines Cobertura inputs into HTML and Cobertura outputs with pinned ReportGenerator `5.6.1`. Missing coverage from an otherwise successful enabled category is a failure. Coverage is not expected when collection is disabled, both test categories are disabled, or a failed test did not produce a coverage file. Internal raw coverage artifacts transport files between isolated jobs; `coverage-artifact` names only the combined report. Downstream caller jobs that need this reusable-workflow job do not run after verification failure unless the caller deliberately overrides the condition.

Untrusted pull-request code may use this workflow with no privileged secrets. Fork pull requests must not receive private package or integration secrets; callers should use a trusted dependency strategy or avoid running secret-dependent checks for forks.

### Example call

```yaml
verify:
  permissions:
    contents: read
    packages: read
  # Development smoke test only. Replace this branch with the resulting immutable
  # commit SHA or validated release tag before adoption.
  uses: chukwuemekanweke/devops-toolkit/.github/workflows/dotnet-ci.yml@feature/devops-003-dotnet-ci
  with:
    solution-path: BackendProjectTemplate.slnx
    dotnet-version: 10.0.x
    unit-test-projects: tests/unit/**/*.UnitTests.csproj
    integration-test-projects: tests/integration/**/*.IntegrationTests.csproj
  secrets:
    nuget-username: ${{ secrets.GH_PKG_USERNAME }}
    nuget-token: ${{ secrets.GH_PKG_PAT }}
```

Adding an optional check is minor-version compatible. Renaming a test input, combining the test categories, or making a formerly optional secret required is breaking.

## `nextjs-ci.yml`

### Purpose and callers

Verifies pnpm-based Next.js repositories and Turborepo monorepos. A caller may run all workspaces once or invoke the workflow through a caller-owned matrix for independent applications. It does not assume portal names and does not publish images.

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `node-version` | string | no | `22.13.0` | Node.js version |
| `node-version-file` | string | no | `""` | Optional repository-relative version file such as `.node-version`; when set, it overrides `node-version` after path validation |
| `pnpm-version` | string | no | `11.20.0` | pnpm version; must agree with the repository `packageManager` field |
| `working-directory` | string | no | `.` | Directory containing the root package and lockfile |
| `workspace-filters` | string | no | `""` | Newline-separated pnpm `--filter` selectors; empty targets the root scripts/all configured workspaces |
| `frozen-lockfile` | boolean | no | `true` | Install with the frozen lockfile policy |
| `run-lint` | boolean | no | `true` | Run the repository `lint` script |
| `run-typecheck` | boolean | no | `true` | Run the repository `typecheck` script |
| `run-tests` | boolean | no | `true` | Run the repository `test` script |
| `run-build` | boolean | no | `true` | Run the repository `build` script |
| `build-config-files` | string | no | `{}` | JSON object mapping build destination paths to checked-in safe source files, for example portal `.env.local` files copied from `.env.example` |
| `upload-build-artifacts` | boolean | no | `false` | Upload caller-selected build output for diagnostics, not deployment |
| `build-artifact-paths` | string | no | `""` | Newline-separated paths; required when artifact upload is enabled |
| `artifact-retention-days` | number | no | `14` | Retention from 1 through 90 days |

Filters are passed as discrete, quoted arguments after validation; they are never concatenated into an evaluated shell command. The implementation uses the named scripts, allowing the repository's Turborepo configuration to define task dependencies.

### Secrets

No secret is required for a public dependency graph.

| Name | Required | Purpose |
| --- | --- | --- |
| `npm-token` | no | Read-only token for private npm-compatible packages |

Build-time configuration is application-owned. `build-config-files` supports the current frontend CI behavior of copying each checked-in `.env.example` to its portal `.env.local` before `pnpm build`; source and destination paths must stay within the checkout. Public `NEXT_PUBLIC_*` values are intentionally browser-visible and must never contain secrets. Server runtime secrets are not a CI build input and are supplied later by the runtime secret-delivery design. A future need for confidential package installation uses only the explicitly mapped `npm-token`.

### Permissions

Minimum: `contents: read`. Add `packages: read` only when private GitHub Packages are restored with `GITHUB_TOKEN`.

### Outputs

| Name | Value |
| --- | --- |
| `lint-result` | `success`, `failure`, `cancelled`, or `skipped` |
| `typecheck-result` | Result of the type-check job/step |
| `test-result` | Result of the test job/step |
| `build-result` | Result of the build job/step |
| `verification-passed` | `true` only when every enabled check succeeds |
| `build-artifact` | Artifact name, or empty when upload is disabled |

### Execution and failure behavior

Checkout, Corepack/pnpm setup, dependency caching, and a frozen install occur once per workflow invocation. Checked-in safe build config is copied after strict path validation and before build. Enabled quality checks run explicitly; a failed check fails verification and blocks the build unless implementation safely preserves independent diagnostic jobs. Missing scripts, invalid filters, lockfile drift, or absent required build configuration fail rather than being silently skipped. Build output is not a deployment release; container publishing remains a separate workflow.

### Example call

```yaml
verify-user-portal:
  permissions:
    contents: read
  uses: chukwuemekanweke/devops-toolkit/.github/workflows/nextjs-ci.yml@v1
  with:
    node-version: 22.13.0
    pnpm-version: 11.20.0
    workspace-filters: '@template/user-portal...'
```

Changing the package manager or script semantics for established inputs is breaking. Adding an optional quality check defaulted off is minor-version compatible.

## `docker-publish.yml`

### Purpose and callers

Builds and publishes the images declared by the calling repository, then emits an immutable release manifest. Docker Hub is the initial registry. Deployable topology lives in the caller's version-controlled image configuration, never in a toolkit preset or a large workflow input.

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `deployment-id` | string | yes | — | Caller-selected immutable release identifier, normally the commit SHA or release ID |
| `image-config-path` | string | no | `.github/docker-images.json` | Repository-relative path to the caller-owned configuration described in [image-configuration.md](image-configuration.md) |
| `package-auth-components` | string | no | `""` | Newline-separated component IDs whose Dockerfiles require the fixed private GitHub Packages/NuGet BuildKit credentials |
| `source-repository` | string | no | current caller repository | Expected `owner/repository`; validated against caller context unless explicitly overridden for an approved promotion flow |
| `source-commit` | string | no | current caller SHA | Full source commit SHA |
| `build-ref` | string | no | current workflow run URL/reference | Human-auditable build or release reference |
| `registry` | string | no | `docker.io` | Registry host supported by the implementation |
| `platforms` | string | no | `linux/amd64` | Comma-separated OCI target platforms applied to configured images |
| `enable-cache` | boolean | no | `true` | Use GitHub Actions BuildKit cache with component-scoped keys |
| `scan-images` | boolean | no | `true` | Run the documented vulnerability policy before producing a deployable release |
| `generate-sbom` | boolean | no | `true` | Generate an SBOM alongside each image where supported |
| `generate-provenance` | boolean | no | `true` | Generate BuildKit provenance where supported |
| `artifact-retention-days` | number | no | `30` | Retention for manifest, SBOM, and provenance artifacts |

The called workflow checks out the caller commit, resolves and validates `image-config-path`, and converts the file's `images` collection into its internal matrix. It does not read a similarly named file from the toolkit. `package-auth-components` must contain only unique components present in the validated file. Publishing creates an immutable discoverability tag such as `release-<normalized-deployment-id>`; the registry digest remains authoritative. The file schema and validation rules are defined in [image-configuration.md](image-configuration.md).

### Secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `registry-username` | yes | Docker Hub username for the initial implementation |
| `registry-token` | yes | Least-privilege registry access token, never an account password |
| `github-packages-username` | no | Private GitHub Packages/NuGet username mapped to BuildKit ID `GITHUB_USERNAME` only for `package-auth-components` |
| `github-packages-token` | no | Read-only package token mapped to BuildKit ID `GITHUB_PAT`; required with the username when package-auth components are selected |

### Permissions

Docker Hub minimum: `contents: read`. If GitHub artifact attestations are implemented, the contract version that enables them must also document `id-token: write` and `attestations: write`. Future GHCR support requires `packages: write`; callers must not grant it for Docker Hub.

### Outputs

| Name | Value |
| --- | --- |
| `deployment-id` | Validated deployment identifier |
| `manifest-json` | Compact deployment manifest JSON; input/schema limits keep it beneath the toolkit's conservative output cap |
| `manifest-artifact` | Canonical artifact name `release-manifest-<deployment-id>` |
| `published-images` | Compact JSON object mapping component to `image@sha256:...` |

GitHub job outputs are limited to 1 MB per job (50 MB per run) and may be suppressed when secret redaction heuristics match content. The workflow enforces a conservative 256 KiB manifest output limit; a larger release definition fails validation rather than emitting a truncated value. The uploaded manifest artifact is authoritative for promotion, audit, and long-lived retention. Callers must not fan this workflow out as a matrix and expect a combined workflow output—the last successful matrix call controls a reusable-workflow output. The workflow itself owns its internal image matrix and aggregation.

### Execution and failure behavior

The intended implementation sequence is: checkout caller; read and validate image configuration; normalize it into an internal matrix; build configured images with Buildx; publish to Docker Hub using deployment-derived immutable tags; scan according to policy; capture each registry digest; upload per-component result artifacts such as `image-result-<component>`; aggregate those artifacts in a non-matrix job; create `release-manifest-<deployment-id>`; and expose the compact outputs above. The aggregation job, not a matrix workflow output, is the single writer of the manifest.

No deployable manifest is produced unless every configured image builds, publishes, scans successfully under policy, and contributes exactly one digest result. A partial publish fails; already pushed content may remain for registry retention cleanup. `latest` is never a deploy/rollback identifier. Package secrets are masked and mounted only in selected builds. Config, results, SBOMs, provenance, logs, and manifests contain no secret values.

Buildx publishes registry-native SPDX SBOM and provenance attestations when their switches are enabled; these are associated with the image index in Docker Hub and are not GitHub artifact attestations. The workflow therefore needs no `id-token` or `attestations` permission. The SHA-pinned Trivy action scans the published digest using the vulnerability database it updates at run time, writes a JSON report covering `HIGH` and `CRITICAL` findings, and blocks the release on any known `CRITICAL` finding, including one without a fix. `HIGH` findings are retained as diagnostics but do not block. A database update or scanner failure is a workflow failure. When scanning is explicitly disabled, component evidence records `disabled`.

The `release-<normalized-deployment-id>` tag is write-once under this workflow: publishing fails if it already exists for a configured repository or if the registry cannot prove it is absent. Calls for the same repository/deployment identity are serialized. This prevents a retry from silently moving a release tag to different content. Retry with a new deployment identity after investigating a partial publication. Successfully pushed images from a partial run are not automatically deleted.

### Example call

```yaml
publish:
  needs: verify
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  permissions:
    contents: read
  uses: chukwuemekanweke/devops-toolkit/.github/workflows/docker-publish.yml@v1
  with:
    deployment-id: ${{ github.sha }}
    image-config-path: .github/docker-images.json
    package-auth-components: |
      webapi
      consumer
      jobs
      migrator
  secrets:
    registry-username: ${{ secrets.DOCKERHUB_USERNAME }}
    registry-token: ${{ secrets.DOCKERHUB_TOKEN }}
    github-packages-username: ${{ secrets.GH_PKG_USERNAME }}
    github-packages-token: ${{ secrets.GH_PKG_PAT }}
```

The example assumes the application repository contains the four-component file shown under `examples/dotnet/`; it is illustrative until DEVOPS-005 implements the workflow. Adding an optional image-schema field or another registry under compatible semantics can be minor. Replacing `image-config-path`, changing fixed secret meaning, or reinterpreting a supported schema version is breaking.

## `vps-deploy.yml`

### Purpose and callers

Deploys an already-built immutable manifest to a provisioned Linux VPS using Docker Compose. It transfers only approved configuration, records previous state, optionally runs a Compose migration service, starts the release, and verifies Compose health. It does not provision the host or build images.

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `environment` | string | yes | — | Caller GitHub Environment name and deployment/audit label |
| `deployment-id` | string | yes | — | Must equal the manifest deployment ID |
| `manifest-json` | string | one of manifest inputs | `""` | Inline manifest conforming to [deployment-model.md](deployment-model.md) |
| `manifest-artifact` | string | one of manifest inputs | `""` | Canonical manifest artifact name from `docker-publish.yml`; mutually exclusive with `manifest-json` |
| `compose-files` | string | yes | — | Newline-separated repository-relative Compose files, applied in order |
| `stack-name` | string | yes | — | Validated application stack/Compose project name; distinguishes independent stacks on one VPS |
| `component-service-map` | string | no | `{}` | JSON object mapping manifest component names to Compose service names; omitted entries use the same name |
| `remote-deployment-path` | string | yes | — | Absolute allow-listed directory dedicated to this application/environment |
| `ssh-port` | number | no | `22` | Remote SSH port |
| `migration-service` | string | no | `""` | Compose one-shot service whose declared command performs forward migration; empty disables migration |
| `migration-timeout-seconds` | number | no | `600` | Migration timeout |
| `health-services` | string | no | `""` | Newline-separated services that must become healthy/running; empty verifies all long-running services |
| `health-checks` | string | no | `[]` | JSON array of environment-owned HTTP checks with `name`, `url`, and optional `expectedStatus` (default `200`) |
| `health-timeout-seconds` | number | no | `300` | Post-start health deadline |
| `rollback-on-health-failure` | boolean | no | `true` | Attempt to restore the recorded previous manifest after a failed health check; the deployment workflow still fails |

Exactly one of `manifest-json` or `manifest-artifact` is logically required and validated before mutation. The reusable workflow's deployment job sets `environment: ${{ inputs.environment }}` and concurrency group `deploy-<caller repository>-<environment>-<stack-name>`, with no cancellation of an in-progress deployment. The caller configures its GitHub Environment approvals and branch/tag restrictions. A caller job that invokes a reusable workflow cannot attach arbitrary steps around it.

### Secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `ssh-host` | yes | Target hostname or IP |
| `ssh-user` | yes | Dedicated, minimally privileged deployment account |
| `ssh-private-key` | yes | Rotatable key restricted to the deployment account |
| `ssh-known-hosts` | yes | Pinned host key entry; permissive host-key checking is forbidden |
| `registry-username` | yes | Read-only registry identity used on the VPS |
| `registry-token` | yes | Read-only token for image pulls |

Production application secrets are not a deployment-workflow secret input. Application-owned Compose definitions consume the later Infisical-delivered, service-scoped read-only files described by DEVOPS-006/007. GitHub Actions needs deployment and registry credentials, not long-lived database, messaging, signing, or application credentials.

### Permissions

Minimum: `contents: read`. Add `actions: read` when `manifest-artifact` is used. The workflow needs no repository, package, or deployment write permission for Docker Hub.

### Outputs

| Name | Value |
| --- | --- |
| `deployment-status` | `succeeded`, `failed`, or `restored-after-failure` |
| `deployed-id` | Deployment ID that passed health, empty on failure |
| `previous-deployment-id` | Previously active recorded deployment, empty on first deployment |
| `deployment-record-artifact` | Sanitized audit record artifact name |

### Execution and failure behavior

The implementation validates manifest, paths, names, and host key before connection. It acquires remote stack locking, snapshots the active manifest, creates a staged release directory, transfers approved Compose configuration, logs into the registry without exposing the token, pulls every digest, and materializes a generated image override. When `migration-service` is set, it runs that release-scoped one-shot service and requires an explicit zero exit result before starting dependent services; a perpetual container health check is not a migration-success signal. An empty migration service disables this stage for applications such as the current Next.js portals. The workflow then starts Compose and waits for both service health and configured endpoint checks before atomically marking the new manifest active and appending sanitized history.

Failures before activation leave the prior deployment active. Health failure triggers best-effort restore when enabled, but the job remains failed so operators see the incident. A migration failure stops deployment and does not auto-reverse the database. Remote output and artifacts exclude environment files, credentials, and raw secret-bearing commands.

### Example call

```yaml
deploy:
  needs: publish
  permissions:
    contents: read
  uses: chukwuemekanweke/devops-toolkit/.github/workflows/vps-deploy.yml@v1
  with:
    environment: production
    deployment-id: ${{ needs.publish.outputs.deployment-id }}
    manifest-json: ${{ needs.publish.outputs.manifest-json }}
    compose-files: deploy/compose.yml
    stack-name: example-production
    component-service-map: '{"migrator":"database-migrator"}'
    remote-deployment-path: /srv/example/production
  secrets:
    ssh-host: ${{ secrets.VPS_HOST }}
    ssh-user: ${{ secrets.VPS_USER }}
    ssh-private-key: ${{ secrets.VPS_SSH_KEY }}
    ssh-known-hosts: ${{ secrets.VPS_KNOWN_HOSTS }}
    registry-username: ${{ secrets.DOCKERHUB_USERNAME }}
    registry-token: ${{ secrets.DOCKERHUB_READ_TOKEN }}
```

Changing remote state layout or activation/health semantics incompatibly is breaking. Adding an optional verification mode is minor-version compatible.

## `vps-rollback.yml`

### Purpose and callers

Restores a previously recorded, eligible deployment state using its immutable image digests. It is a separately approved operational workflow, not an automatic rebuild of an earlier Git commit.

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `environment` | string | yes | — | Protected GitHub Environment |
| `target-deployment-id` | string | yes | — | Previously successful deployment to restore |
| `target-manifest-json` | string | no | `""` | Optional exact manifest; when present it must match the remote recorded copy |
| `reason` | string | yes | — | Non-secret operator reason stored in the audit record |
| `compose-files` | string | yes | — | Compose files used for the environment |
| `stack-name` | string | yes | — | Same independent stack name used by deployment |
| `component-service-map` | string | no | `{}` | Same component-to-service mapping used by deployment |
| `remote-deployment-path` | string | yes | — | Same dedicated path used by deployment |
| `ssh-port` | number | no | `22` | Remote SSH port |
| `health-services` | string | no | `""` | Services that must pass health verification |
| `health-checks` | string | no | `[]` | Same endpoint checks used to accept the deployment |
| `health-timeout-seconds` | number | no | `300` | Health deadline |

Rollback uses the same environment-scoped concurrency group as deploy, so deploy and rollback cannot mutate the same target concurrently.

### Secrets

`ssh-host`, `ssh-user`, `ssh-private-key`, `ssh-known-hosts`, `registry-username`, and `registry-token` have the same meanings and constraints as deployment. They must be mapped explicitly again. Runtime application credentials remain outside GitHub Actions.

### Permissions

Minimum: `contents: read`. No source or package write permission is required.

### Outputs

| Name | Value |
| --- | --- |
| `rollback-status` | `succeeded`, `failed`, or `restore-failed` |
| `restored-deployment-id` | Target ID after successful health verification |
| `replaced-deployment-id` | Deployment active when rollback began |
| `rollback-record-artifact` | Sanitized audit record artifact name |

### Eligibility, execution, and failure behavior

A target is eligible only when its manifest passed schema validation, exists in protected remote history, all referenced digests still exist and are pullable, its Compose/config contract remains supported, and the operator has assessed database compatibility. The workflow verifies the optional supplied manifest against the recorded hash, locks the target, snapshots current state, pulls target digests, applies the recorded image mapping, and verifies health before marking rollback complete.

Rollback never runs reverse database migrations automatically. Deployments that include destructive or backward-incompatible schema changes may make an older application ineligible. Applications should use expand/migrate/contract changes and keep the previous application compatible for the documented rollback window. If rollback health fails, the workflow attempts to restore the state active when rollback began; if that also fails it reports `restore-failed`, retains both records, and requires operator intervention. Every attempt records actor, run, reason, source and target IDs, timestamps, and outcome without secrets.

### Example call

```yaml
rollback:
  permissions:
    contents: read
  uses: chukwuemekanweke/devops-toolkit/.github/workflows/vps-rollback.yml@v1
  with:
    environment: production
    target-deployment-id: 0123456789abcdef0123456789abcdef01234567
    reason: Restore previous release after health regression
    compose-files: deploy/compose.yml
    stack-name: example-production
    remote-deployment-path: /srv/example/production
  secrets:
    ssh-host: ${{ secrets.VPS_HOST }}
    ssh-user: ${{ secrets.VPS_USER }}
    ssh-private-key: ${{ secrets.VPS_SSH_KEY }}
    ssh-known-hosts: ${{ secrets.VPS_KNOWN_HOSTS }}
    registry-username: ${{ secrets.DOCKERHUB_USERNAME }}
    registry-token: ${{ secrets.DOCKERHUB_READ_TOKEN }}
```

Relaxing an eligibility check is security/behavior sensitive and requires explicit review. Changing recorded-state compatibility requires a major release or an in-place migration that preserves all supported `v1` history.
