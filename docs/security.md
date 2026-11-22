# Security architecture

## Principles

Every caller grants the smallest token permission set and maps only named secrets required by the selected capability. A called workflow can reduce caller permissions but cannot elevate them. Build/test, publishing, and deployment identities are separate so compromise in one stage does not automatically cross trust boundaries.

## Credential contracts

| Capability | Credential | Minimum scope and handling |
| --- | --- | --- |
| Repository checkout | `GITHUB_TOKEN` | `contents: read`; persist credentials only when required |
| Private NuGet/npm restore | Explicit package token or `GITHUB_TOKEN` | Read-only for the exact packages; mapped only to CI jobs that restore them |
| Docker Hub publish | `registry-username`, `registry-token` | Dedicated token with write access only to intended repositories |
| Docker build package restore | `github-packages-username`, `github-packages-token` | Read-only package access, mounted only for explicitly selected components as `GITHUB_USERNAME`/`GITHUB_PAT` |
| Docker Hub deploy/rollback | Separate registry read token | Pull-only; stored in the protected deployment environment |
| Future GHCR publish | `GITHUB_TOKEN` | `contents: read`, `packages: write`; do not pre-grant until supported |
| VPS access | Host, user, private key, pinned known-hosts entry | Dedicated `vps-deploy` account outside the `docker` group; one key per application bound by a forced command to one stack; sudo permits only the constrained deploy helper for that stack ([operations guide](vps-deployment.md#trust-model-and-the-constrained-host-interface)) |
| Runtime application secrets | Doppler service token per service config per host (host delivery implemented in DEVOPS-007) | Read-only, expiring, scoped to one branch config; encrypted systemd credential on the VPS; values delivered from restricted tmpfs as read-only service-scoped key files; never stored in GitHub Actions, containers, images, manifests, or durable plaintext by default |

Do not use `secrets: inherit` as the normal contract. Never pass secrets as regular inputs or image-configuration values. Rotate package, registry, and SSH credentials on a defined schedule, immediately on suspected disclosure, and when maintainers lose access. Test replacement credentials before revoking the old value where safe.

## Trust boundaries

1. **Caller repository to toolkit:** caller code and string inputs are untrusted. The toolkit validates JSON schemas, path containment, identifiers, numeric ranges, registry hosts, and service/filter lists before use. It quotes arguments and never evaluates input as shell.
2. **Source repository to registry:** Docker builds execute repository-controlled Dockerfiles. Publishing secrets use BuildKit secret mounts, not build arguments. Digests returned by the registry become the release authority.
3. **Runner to production VPS:** the runner authenticates a pinned host key (`StrictHostKeyChecking=yes`, no wildcard entries) and a stack-bound deploy identity. Only deploy/rollback workflows receive SSH and pull credentials. The host treats the request as untrusted and re-validates it against a root-owned stack registry.
4. **Deployment to runtime:** Compose and the application own runtime configuration and health meaning. The deployment process provides immutable images and does not leak its SSH/registry identity into containers.
5. **Third-party Actions:** every action is reviewed and pinned to a full commit SHA. Human-readable version comments and automated dependency updates keep pins maintainable. Reusable toolkit releases are pinned to a major tag, immutable release tag, or SHA according to risk.

## Untrusted pull requests

- Verification may run on `pull_request` with `contents: read` and no deployment or registry-write credentials.
- Workflows handling untrusted code must not use `pull_request_target` to check out and execute the pull request head.
- Fork pull requests do not receive package secrets. If private dependencies are unavoidable, use a separately reviewed trusted workflow design rather than weakening the boundary.
- Publish and deploy jobs use push, release, or manual triggers in the caller and must include explicit event/ref conditions. They must never be reachable from an untrusted pull-request job through an artifact or cache without validating provenance.
- Deployment credentials live in protected GitHub Environments with required reviewers and branch/tag restrictions. The reusable deployment job selects that environment from its validated input.
- Build artifacts and manifests are treated as untrusted until schema, source repository, source commit, run identity, and digest format are verified.

This separation prevents code submitted in an ordinary pull request from gaining deployment secrets: the PR workflow is not granted those secrets, does not target the protected environment, and cannot cause a called workflow to elevate permissions.

## Input and shell safety

- Canonicalize all repository paths and reject absolute paths, `..` traversal, symlink escape, NULs, and newline ambiguity.
- Parse image configuration and release manifests with a real parser; reject duplicate properties/components, unknown fields, unsupported schemas, invalid references, and empty collections.
- Convert lists into argument arrays. Do not embed `${{ inputs.* }}` directly in a shell program.
- Allow-list registry hosts and validate image/component/Compose names.
- Send fixed package credentials directly through BuildKit secret mounts only to selected component builds. Do not serialize them into the image config, matrix artifacts, or generic secret bundles.
- Do not place secret material in cache keys, outputs, summaries, command lines, manifests, or uploaded logs.
- Scope caches by repository, lockfile, platform, and component. Never use a cache from an untrusted workflow as executable release output.
- The .NET CI workflow validates that `nuget-username` and `nuget-token` are paired, exposes them only as the caller's expected `GITHUB_USERNAME`/`GITHUB_PAT` restore environment variables, and never includes them in cache keys, output metadata, test diagnostics, or build artifacts.
- Toolkit helper code used by reusable jobs is checked out from the repository and exact called-workflow commit identified by `job.workflow_repository` and `job.workflow_sha`. It never fetches helper code from the caller or the toolkit's moving default branch.

## Runtime secrets

The [Doppler runtime secrets design](doppler/architecture.md) separates runtime application credentials from build, publish, and deployment credentials:

- GitHub Actions holds no Doppler token, service account, or application secret value. Deployment triggers host-side rendering and reads only exit status and sanitized metadata.
- Each runtime token is read-only and scoped to one service's branch config in one environment. Root configs stay empty, and the host refuses keys outside the application-owned key list. Negative acceptance tests must prove sibling and cross-environment denial before production use ([access policy](doppler/access-policy.md)).
- Secrets reach containers as read-only, per-service key-per-file mounts. Doppler CLI fallback files and environment injection are not used. Environment-variable delivery is a recorded exception only.
- `/run/runtime-secrets` is tmpfs. Boot fails closed until required services render and activate; no last-known-good plaintext survives reboot. Runtime refresh failure leaves `current` and running bind mounts unchanged.
- Lifecycle operations use exclusive/no-follow creation, restricted ownership, an operation lock, immutable generations and atomic pointer replacement. Pruning requires explicit deployment-layer eligibility because the helper has no Docker access.
- The Doppler Developer plan provides no IP allowlisting, no human role-based access, and 3 days of activity logs. Compensating controls (expiry and rotation, membership limited to secrets administrators, frequent review, change webhooks, host evidence) are defined in [audit and threat model](doppler/audit-and-threat-model.md).

**Residual risk:** a compromised VPS root account, or a deploy account with Docker access, can read every service token and every secret delivered to containers on that host. Without IP allowlisting, stolen tokens remain usable off-host until revoked or expired. Doppler narrows the blast radius and makes rotation and revocation tractable; it does not remove the consequences of host compromise. See [rotation and revocation](doppler/rotation-and-revocation.md) for containment runbooks.

## Deployment host interface

`vps-deploy.yml` never runs remote shell commands built from inputs. Its only remote operation is the fixed word `deploy`, with one bounded JSON request on SSH stdin:

- **Command injection:** the forced command ignores client-supplied text other than the exact operation `deploy`; the root helper receives the stack from the key binding and spawns Docker, Compose, `systemctl`, and `runuser` with argument arrays and a scrubbed environment, never a shell.
- **Authorization:** the stack registry (`/etc/vps-deploy/stacks/<stack>.json`, root-owned) must agree with `environment`, `stack-name`, and `remote-deployment-path`, and authorizes source repositories and image namespaces (manifest provenance). Registries may not overlap paths or share runtime-secret instances.
- **Docker daemon escalation:** before any container changes, the merged Compose model is rejected if it is privileged, joins host or foreign namespaces, mounts the Docker socket, another service's or stack's runtime secrets, or unapproved host paths, adds unapproved capabilities, publishes non-loopback ports outside the allowlist, uses `container_name`, `volumes_from`, `devices`, `env_file`, `include`, or `extends.file`, references a mutable image tag, or runs a release or secret-bearing service as root.
- **Path traversal and symlinks:** Compose paths are validated on the runner (repository-contained, non-symlink) and only their content is transferred; host state uses fixed names, no-follow exclusive creation, atomic renames, and root-owned directories without symlinks.
- **Credentials:** the pull-only registry token is written only to a private temporary Docker client configuration on tmpfs and removed after the operation; it is not in arguments, environment, history, or artifacts. Runtime secrets stay in DEVOPS-007 tmpfs generations; only generation ids are recorded, and `docker inspect` shows no values.
- **Concurrency and corruption:** a stack-scoped lock serializes deploy and restore operations; `active.json` is replaced atomically only after health verification; manifests are write-once per deployment id. A migrator still running from an interrupted deployment blocks a new migration rather than being force-removed or raced.
- **Database safety:** restoration recreates only application containers from recorded digests; it never runs migrations, reverse migrations, schema downgrades, backup restores, or destructive cleanup.

Residual risk: an attacker holding a stack's deploy key and passing the GitHub Environment can deploy any image from that stack's approved namespaces, and that image runs with access to that stack's runtime secrets. Root or Docker-daemon compromise on the host still exposes every stack. The helper runs as root, so its own correctness is security-critical; changes to it require security review.

## Supply-chain controls

- Pin third-party actions to reviewed full-length commit SHAs; a moving tag is not immutable.
- Enable Dependabot for Actions and review release notes/source before updating pins.
- Prefer official or verified-publisher actions with narrow behavior. Avoid actions for simple shell-free platform features.
- Generate SBOM and provenance during publishing where supported, retain them with the manifest, and verify registry digests before deploy.
- OCI publishing uses BuildKit registry-native SBOM and provenance attestations, not GitHub artifact attestations, and scans the pushed digest with a SHA-pinned Trivy action. Known `CRITICAL` findings and scanner failures block manifest generation; `HIGH` findings remain diagnostic.
- Protect `main`, release tags, and the mutable `v1` alias. Only the release process may advance aliases.
- Review changes to workflow code, composite actions, scripts, dependency pins, permissions, secrets, manifest schemas, and remote commands as security-sensitive.

## Production controls and audit

Production environments require approvals, restricted refs, serialized deployment, immutable manifest artifacts, and a pull-only runtime registry identity. GitHub Actions deploys release identity; the host-side Doppler delivery designed in [doppler/architecture.md](doppler/architecture.md) provides service runtime secrets without exposing them to the pipeline. Records capture actor, source repository/commit, toolkit ref, workflow run, environment, manifest hash, previous and new deployment IDs, timestamps, health result, rollback reason, and final outcome.

Audit records exclude secrets and should be retained both as GitHub artifacts and protected remote history. Monitoring must alert on failed deploys, failed restoration, unexpected alias movement, credential use anomalies, and repeated authentication failures.

Deployment failure alerting is a caller-owned job driven by the sanitized `vps-deploy.yml` outputs (`deployment-outcome`, `failed-phase`, `failure-category`, `migration-status`, `restoration-outcome`), as described in [Failure notification](workflow-contracts.md#failure-notification). Notification endpoints and credentials stay in caller GitHub secrets and run only on the GitHub runner. They never reach the VPS, the host helper, or the toolkit, and the toolkit hardcodes no provider or recipient. The outputs are fixed-vocabulary tokens validated before they are written. Failure messages, response bodies, and command output are not exposed as outputs. A failed GitHub job is not treated as alert delivery.

If a workflow supply-chain compromise is suspected, stop alias advancement, disable affected workflows/environments, rotate exposed credentials, identify consumers and runs from audit logs, publish an advisory/fixed immutable release, and require consumers to pin the safe SHA or tag before resuming.

## Repository validation controls

The toolkit validation pipeline automatically rejects unpinned external Actions, `pull_request_target`, `secrets: inherit`, direct workflow-input interpolation in shell steps, duplicate YAML/JSON keys, schema-invalid fixtures, and undocumented implemented `workflow_call` interfaces. Publishing tests cover duplicate JSON properties, repository/path containment, image identity, package credential pairing, digest and scan evidence, and complete aggregation. The .NET helper also rejects absolute paths, traversal, unsupported glob syntax, path escape through symlinks, invalid configurations/diagnostic IDs, unpaired credentials, and artifact retention outside 1–90 days. Actionlint runs through a reviewed wrapper pinned to a full commit SHA, and that wrapper executes a digest-pinned actionlint container. VPS deployment tests cover manifest, request, SSH-target, Compose-policy, registry, and state-machine rejection cases, and two privileged Linux harnesses (Docker-in-Docker with real Compose, the SSH forced command, and sudo; and a booted systemd host) exercise real deployment, restoration, secret mounts, and boot ordering.

Automation does not replace review of an Action's source and release notes, credential scope, whether a permission is operationally necessary, shell argument construction that is indirect, or the trustworthiness of test fixtures. Pull requests changing workflows, dependencies, permissions, secrets, schemas, or deployment behavior must record that manual review and testing evidence.
