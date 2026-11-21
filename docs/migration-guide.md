# Consumer migration guide

The `.NET CI` and Next.js CI workflows are implemented. Publishing, deployment, and rollback remain planned. No `v1` release alias exists yet.

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
- Supply private build configuration through one explicitly mapped environment secret per invocation. Never put secrets in `NEXT_PUBLIC_*` variables.

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
