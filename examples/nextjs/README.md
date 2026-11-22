# Next.js consumer example

`ci.yml` is a thin caller for the implemented reusable Next.js CI and OCI publishing workflows. It preserves application-owned pull-request and main-branch path filters, reads Node from `.node-version`, verifies the complete pnpm/Turborepo monorepo, copies the three checked-in safe `.env.example` files before build, and publishes only after a successful trusted push to `main`.

The commented single-portal job demonstrates filtered verification without placing portal names in the toolkit. Newline-separated `workspace-filters` values are pnpm selectors, so a selector such as `@template/user-portal...` includes that application and its required workspace dependencies. A caller-owned matrix can invoke the same workflow independently for several deployable applications.

During DEVOPS-004 smoke testing, the example uses the feature branch. Production consumers must replace it with a validated immutable release tag or full commit SHA. No `v1` alias exists yet, and `@main` is not a supported production reference.

Both public and private dependency cases require only `contents: read` from this workflow. Private registries may additionally require caller-granted package read permission and an explicitly mapped read-only `npm-token`; never use `secrets: inherit`. `NEXT_PUBLIC_*` values are browser-visible and must not contain secrets. Build configuration must come from checked-in safe examples, while runtime secrets remain outside this verification workflow.

Optional build artifacts are diagnostics only. Set `upload-build-artifacts: true`, provide explicit repository-relative `build-artifact-paths`, and choose retention from 1 through 90 days. The helper rejects traversal, missing paths, globs, and sensitive filenames such as `.env*`, `.npmrc`, credentials, tokens, and private keys.

`docker-images.json` declares the three independently built portal images. Publishing maps only Docker Hub credentials, uses no package BuildKit secrets, scans the published digests, and produces a complete release manifest. Replace the illustrative `docker.io/example/...` repositories before smoke testing. The workflow does not deploy the images.

Current reference-template limitation: a local non-publishing build of `apps/user-portal/Dockerfile` reaches Next.js page-data collection and then fails because required build-time environment values such as `API_BASE_URL`, `APP_ENVIRONMENT`, `APPLICATION_NAME`, and `APPLICATION_VERSION` are absent. The current `.dockerignore` excludes `.env*` (other than examples), and the Dockerfiles do not promote an example or accept the required public settings. Resolve that application-owned Dockerfile/build-configuration contract in the consumer before expecting an end-to-end three-image publish; the toolkit does not inject server secrets or rewrite consumer Dockerfiles.

## Deployment

`compose.production.yml` runs the three portals as one independent stack (`example-frontend-production`). Each portal is non-root, uses a read-only root filesystem with tmpfs scratch space, publishes only on loopback for the host reverse proxy, and has a health check. The portals hold no runtime secrets, so there are no DEVOPS-007 mounts, and `migration-service` stays empty, which skips the migration stage. `vps-deploy-stack.json` is the matching host registry and allows exactly the three portal repositories. The `deploy-production` job in `ci.yml` deploys from the publish run's `manifest-artifact` and checks every portal from the host.
