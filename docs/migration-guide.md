# Consumer migration guide

The workflows described here are not implemented yet. Repository governance and validation are implemented, but they do not make the illustrative consumer calls runnable. This guide prepares application repositories for later adoption and will be expanded as real capability workflows and releases are published.

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
- If integration tests require services, check in a safe Compose file or continue using repository-owned Testcontainers. Do not hide service startup in an arbitrary command input.
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
