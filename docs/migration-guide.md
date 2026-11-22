# Consumer migration guide

The `.NET CI`, Next.js CI, OCI publishing, and VPS deployment workflows are implemented, as is the DEVOPS-007 host-side Doppler runtime-secret delivery. Rollback remains planned. No `v1` release alias exists yet.

## General migration

1. Keep existing CI/CD operational while adding a thin caller on a feature branch.
2. Move component, image repository, Dockerfile, and context definitions into the application's `.github/docker-images.json`; keep paths, filters, Compose files, and environments caller-owned.
3. Create separate read-only package, registry-write, registry-read, and VPS credentials. Store deployment credentials only in protected GitHub Environments.
4. Grant explicit job permissions and map each named secret; do not use `secrets: inherit`.
5. Validate CI parity before removing old verification jobs.
6. Publish images in parallel without deploying; compare tags, digests, SBOM/provenance, and manifest contents.
7. Test deployment and rollback in a non-production environment, including a deliberate health failure and an eligible prior manifest.
8. Pin an immutable toolkit release for initial rollout, then choose whether the compatible major alias fits the repository's update policy.
9. Remove duplicated workflow implementation only after equivalent evidence is retained.

## .NET template mapping

- Pass the actual `.slnx` path and keep unit/integration patterns separate.
- Configure private NuGet sources in `nuget.config`; map read-only credentials explicitly.
- Keep integration infrastructure in the template's Testcontainers fixtures. The reusable workflow verifies Docker and runs the projects; it does not accept Compose inputs or start the application stack. Compose remains application-owned for local/deployment orchestration.
- The current template's fixtures turn a Docker-unavailable exception into an xUnit skip. The reusable workflow guards against a false green with a Docker preflight and TRX inspection; preserve that evidence while comparing the old and new CI results.
- Add WebAPI, Consumer, Jobs, and DatabaseMigrator as four entries in `.github/docker-images.json`; the publishing caller passes its path. Stable component names map to Compose services.
- Pass all four component IDs through `package-auth-components` while the verified Dockerfiles require the `GITHUB_USERNAME` and `GITHUB_PAT` BuildKit mounts; map the fixed read-only package credentials explicitly.
- Model the migrator as a one-shot Compose service and assess backward compatibility before enabling rollback for a release.

## Next.js template mapping

- Match Node and pnpm versions to `engines` and `packageManager`.
- Use an empty filter for repository-wide Turborepo validation or a caller matrix with explicit `@template/...` filters for application-specific builds.
- Keep User, Admin, and Public portals as independent entries in `.github/docker-images.json` and independent deployment lifecycles.
- Keep build-time configuration non-secret and checked in where appropriate. Never put secrets in `NEXT_PUBLIC_*` variables or image `buildArgs`.

## Adopting VPS deployment before the first release

1. Prepare the host as described in [VPS deployment operations](vps-deployment.md#initial-vps-preparation): install the helper, create the `vps-deploy` account (not in `docker`), register the stack, add its sudoers line and stack-bound `authorized_keys` entry, provision DEVOPS-007 instances for secret-bearing services, and enable the stack unit with its generated boot drop-in.
2. Commit an application-owned production Compose file. Use the [backend](../examples/dotnet/compose.production.yml) and [frontend](../examples/nextjs/compose.production.yml) references: no tags for release components, digest-pinned infrastructure images, loopback or registry-approved ports, own-generation secret mounts with `restart: "no"`, and non-root users.
3. Backend only: make the DatabaseMigrator a run-to-completion process, move it into a non-default profile, and remove `depends_on` from WebAPI, Consumer, and Jobs to the migrator. The current template's migrator is a `WebApplication` whose background worker migrates and then loops forever while serving `/health/*`. Under `vps-deploy.yml` that run reaches `migration-timeout-seconds`, is killed, and is reported as `timed-out`, even though the database was migrated. The migrator must instead:
   - apply migrations and pre/post-deployment scripts, then **exit** with code `0` on success and a nonzero code on any failure (for example a console host or `Host` that sets `Environment.ExitCode` and returns, rather than catching the exception and idling);
   - drop the HTTP health endpoints and the Compose `healthcheck` (exit status is the only success signal);
   - keep each migration idempotent, because a retried deployment re-runs it;
   - follow [expand/migrate/contract](vps-deployment.md#database-compatibility-expand-migrate-contract) so the previous release still works if rollout fails after the migration.

   The template's `docker-compose.production.yml` also has `build:` sections and published ports, so it does not yet satisfy the host policy.
4. Create a protected GitHub Environment holding the six named secrets, with a Docker Hub **read-only** token and a dedicated deploy key, and require reviewers.
5. Commit a [deployment configuration file](workflow-contracts.md#deployment-configuration-file) (for example `.github/vps-deploy.production.json`, see the consumer examples) and add a `release-config-check.yml` job that runs on every pull request, so configuration mistakes fail before merge. Optionally commit a copy of the host stack registry entry and pass it as `stack-registry-path` (this enables the Compose policy check), and commit non-secret placeholder values for the variables your Compose files interpolate (for example `deploy/stack.env.example`) and pass them as `compose-env-file`.
6. Add a deploy job after publishing (see the consumer examples). Point it at the toolkit feature branch only for smoke testing on a non-production VPS, and rehearse a deliberate health failure (expect `restored-after-failure`) and a migration failure (expect `failed-before-rollout` with `migration-status: failed`).
7. Add a caller-owned failure notification job ([Failure notification](workflow-contracts.md#failure-notification)) with the alert endpoint in a caller GitHub secret, and confirm an alert actually arrives during the rehearsal. A red workflow run alone does not notify anyone.
8. Replace the reference with an immutable release tag or full commit SHA before production use.

### Moving deploy settings into a configuration file

Existing `vps-deploy.yml` callers need no change: the inline inputs remain supported. To move to `deploy-config-path`, copy `compose-files`, `remote-deployment-path`, `component-service-map`, `migration-service`, `migration-timeout-seconds`, `health-services`, `health-checks`, `health-timeout-seconds`, and `rollback-on-health-failure` into the file's camelCase fields (lists become JSON arrays, JSON strings become JSON values), remove them from the `with:` block, and pass `deploy-config-path`. Keep `environment`, `stack-name`, and `ssh-port` inline. Leaving any moved input in `with:` fails validation, so a setting cannot silently differ between the two places. Callers that verified their deployment inputs or rendered their production Compose file with custom steps can replace those steps with a `release-config-check.yml` job, and callers that re-verified the published manifest can rely on `docker-publish.yml`, which now writes the release references to the job summary.

Callers that already consume `vps-deploy.yml` need no change for DEVOPS-010: the new outputs are additive. The host-side hardening takes effect only after reinstalling the helper (`install-vps-deploy.sh`) from the matching toolkit revision. Until then, the runner still derives the new outputs from an older helper's result. Behavior is stricter in three cases, all of which used to risk an incorrect success:

- A migrator that leaves no terminated container is now `not-started` and fails.
- A migration container still running from an interrupted deployment now blocks the deployment instead of being force-removed.
- A required container that Docker restarts during health verification now fails health.

## Adopting OCI publishing before the first release

1. Commit the appropriate four-backend or three-frontend `.github/docker-images.json` file and replace illustrative `docker.io/example/...` repositories with approved Docker Hub repositories.
2. Point the caller at `feature/devops-005-docker-publish` only for development smoke testing, or at an immutable feature commit after it has been pushed. Replace it with an immutable release tag or SHA for production adoption.
3. Run publishing only after verification on a trusted push/release event. Map `registry-username` and `registry-token` explicitly; map the package credential pair only for backend components listed by `package-auth-components`.
4. Confirm each published digest, Trivy report, registry-native SBOM/provenance attestation, per-component result, final manifest, and workflow output. A real Docker Hub smoke test requires explicit authorization and credentials.
5. Treat a deployment ID as write-once. If a partial run has already created one or more release tags, investigate it and use a new deployment identity; the workflow will not move an existing tag.

## Preparing for Doppler runtime secrets

Runtime secret delivery is designed in [docs/doppler](doppler/architecture.md) but not implemented. Earlier documents referred to a planned Infisical provider; no Infisical integration was ever implemented, so there is nothing to migrate away from. No consumer action is required yet. To prepare without changing production behavior:

1. Review the [Developer-plan limitations](doppler/access-policy.md#free-plan-limitations-and-compensating-controls): no IP allowlisting, no human role-based access, and 3 days of activity logs. Decide whether they are acceptable for the application's production data, or whether the Team plan is needed. The hierarchy and host delivery are the same on both.
2. Review the application's entries in the [secret inventory](doppler/secret-inventory.md). Confirm which services actually use each shared provider credential (payments in particular), and record any new integrations.
3. Plan template changes in the application repository:
   - load `/run/secrets/app` with a key-per-file provider (no Doppler SDK),
   - commit a per-service key list naming every secret each service may receive,
   - validate required secrets at startup and remove hardcoded secret defaults,
   - stop passing build-only package credentials to runtime containers,
   - make the migrator exit after migrating,
   - split database, broker, and storage credentials per service where the provider supports it.
4. Use upper-case secret names with `__` as the hierarchy separator (Doppler's default Classic naming), for example `CONNECTIONSTRINGS__POSTGRESWRITE`. .NET binds them case-insensitively.
5. Keep `NEXT_PUBLIC_*` and other public build-time configuration out of Doppler. Keep non-secret runtime configuration in application-owned Compose files.
6. Do not add Doppler tokens or application secret values to GitHub Actions secrets, images, or Compose files. The deployment workflows will not accept them.

Provisioning Doppler, issuing tokens, migrating credentials, and switching Compose mounts happen in the implementation tickets, staging first. Rotate each credential as it moves, so that values previously held in `.env` files or Compose are retired.

## Compatibility upgrades

Patch/minor updates within a major should first run on a feature branch against the repository's normal CI scenarios. Read every changelog entry since the pinned version. Major upgrades require the release-specific mapping of workflow names, inputs, secrets, permissions, output/manifest formats, and changed behavior; deploy and rollback must be rehearsed outside production.

Do not delete historical manifests when upgrading toolkit code. Confirm the new reader supports the recorded schema or complete the documented remote-state migration first.

## Adopting Next.js CI before the first release

1. Keep the template's existing `.github/workflows/frontend-ci.yml` active while testing a thin caller on a feature branch.
2. Point the caller at `feature/devops-004-nextjs-ci` only for development smoke testing, or at an immutable feature commit after it has been pushed. Do not use `@main` or an uncreated `@v1` alias.
3. Prefer `node-version-file: .node-version`, set `pnpm-version` to the exact root `packageManager` version, and copy only checked-in non-secret examples through `build-config-files`.
4. First compare a full monorepo run with the existing workflow. Then exercise a caller-owned matrix or a single selector such as `@template/user-portal...` and confirm its required workspace dependencies remain selected.
5. If private packages are required, grant the caller only the necessary read permission and explicitly map a read-only token to `npm-token`; public pull requests should not receive it.
6. Compare lint, type-check, test, build, failure gating, and missing-config behavior. After release validation, replace the development reference with an immutable release tag or full commit SHA before removing duplicated application CI.

## Adopting .NET CI before the first release

1. Keep the template's existing `.github/workflows/ci.yml` active while testing a thin caller on a feature branch.
2. Point the caller at `feature/devops-003-dotnet-ci` only for development smoke testing, or at an immutable feature commit after it has been pushed. Do not use `@main` or an uncreated `@v1` alias.
3. Pass `BackendProjectTemplate.slnx`, keep the default unit/integration patterns, and explicitly map the existing read-only `GH_PKG_USERNAME` and `GH_PKG_PAT` secrets to `nuget-username` and `nuget-token`.
4. Compare project discovery, format/build failures, all ten current test projects, Testcontainers behavior, TRX files, and combined Cobertura/HTML reports with the application workflow.
5. After toolkit release validation, replace the development reference with the immutable release tag or full commit SHA. Remove duplicated application CI only after parity is demonstrated.
