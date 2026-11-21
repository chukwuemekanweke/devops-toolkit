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
| VPS access | Host, user, private key, pinned known-hosts entry | Dedicated deploy account limited to the application directory and required Docker operations |
| Runtime application secrets | Infisical machine identities/files (later tickets) | Service-scoped delivery on the VPS; not stored in this repository or passed as long-lived GitHub Actions deployment secrets |

Do not use `secrets: inherit` as the normal contract. Never pass secrets as regular inputs or image-configuration values. Rotate package, registry, and SSH credentials on a defined schedule, immediately on suspected disclosure, and when maintainers lose access. Test replacement credentials before revoking the old value where safe.

## Trust boundaries

1. **Caller repository to toolkit:** caller code and string inputs are untrusted. The toolkit validates JSON schemas, path containment, identifiers, numeric ranges, registry hosts, and service/filter lists before use. It quotes arguments and never evaluates input as shell.
2. **Source repository to registry:** Docker builds execute repository-controlled Dockerfiles. Publishing secrets use BuildKit secret mounts, not build arguments. Digests returned by the registry become the release authority.
3. **Runner to production VPS:** the runner authenticates a pinned host key and a restricted deploy identity. Only deploy/rollback workflows receive SSH and pull credentials.
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

## Supply-chain controls

- Pin third-party actions to reviewed full-length commit SHAs; a moving tag is not immutable.
- Enable Dependabot for Actions and review release notes/source before updating pins.
- Prefer official or verified-publisher actions with narrow behavior. Avoid actions for simple shell-free platform features.
- Generate SBOM and provenance during publishing where supported, retain them with the manifest, and verify registry digests before deploy.
- Protect `main`, release tags, and the mutable `v1` alias. Only the release process may advance aliases.
- Review changes to workflow code, composite actions, scripts, dependency pins, permissions, secrets, manifest schemas, and remote commands as security-sensitive.

## Production controls and audit

Production environments require approvals, restricted refs, serialized deployment, immutable manifest artifacts, and a pull-only runtime registry identity. GitHub Actions deploys release identity; later Infisical components provide service runtime secrets without exposing them to the pipeline. Records capture actor, source repository/commit, toolkit ref, workflow run, environment, manifest hash, previous and new deployment IDs, timestamps, health result, rollback reason, and final outcome.

Audit records exclude secrets and should be retained both as GitHub artifacts and protected remote history. Monitoring must alert on failed deploys, failed restoration, unexpected alias movement, credential use anomalies, and repeated authentication failures.

If a workflow supply-chain compromise is suspected, stop alias advancement, disable affected workflows/environments, rotate exposed credentials, identify consumers and runs from audit logs, publish an advisory/fixed immutable release, and require consumers to pin the safe SHA or tag before resuming.

## Repository validation controls

The toolkit validation pipeline automatically rejects unpinned external Actions, `pull_request_target`, `secrets: inherit`, direct workflow-input interpolation in shell steps, duplicate YAML/JSON keys, schema-invalid fixtures, and undocumented implemented `workflow_call` interfaces. The .NET helper also rejects absolute paths, traversal, unsupported glob syntax, path escape through symlinks, invalid configurations/diagnostic IDs, unpaired credentials, and artifact retention outside 1–90 days. Actionlint runs through a reviewed wrapper pinned to a full commit SHA, and that wrapper executes a digest-pinned actionlint container.

Automation does not replace review of an Action's source and release notes, credential scope, whether a permission is operationally necessary, shell argument construction that is indirect, or the trustworthiness of test fixtures. Pull requests changing workflows, dependencies, permissions, secrets, schemas, or deployment behavior must record that manual review and testing evidence.
