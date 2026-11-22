# Illustrative .NET consumer

These files model consumer-owned content for `dotnet-core-project-template`. The caller uses the DEVOPS-003 and DEVOPS-005 feature branches for development smoke testing; replace mutable references with validated immutable release tags or full commit SHAs before adoption. No `v1` alias exists yet.

- `ci.yml` is a thin caller that owns push/pull-request filters, verifies the `.slnx`, and publishes only after a successful trusted push to `main`.
- `docker-images.json` is proposed application-owned `.github/docker-images.json` content for WebAPI, Consumer, Jobs, and DatabaseMigrator using verified current Dockerfile paths.

CI receives `contents: read` and `packages: read`, and read-only GitHub Packages credentials are explicitly mapped to the optional paired NuGet secrets. Testcontainers owns integration infrastructure; CI checks Docker but does not invoke Compose. No runtime application secret is passed.

Publishing explicitly maps Docker Hub credentials and the read-only package pair for all four current Dockerfiles. Buildx mounts them only as `GITHUB_USERNAME` and `GITHUB_PAT`; they are never build arguments. The caller grants only `contents: read`. Replace the illustrative `docker.io/example/...` repositories before smoke testing. Publishing emits digest references and a manifest but does not deploy or change application topology.

## Deployment

- `compose.production.yml` is illustrative application-owned `deploy/compose.production.yml` content. Release components (WebAPI, Consumer, Jobs, DatabaseMigrator) receive their digests from the toolkit's generated override. The migrator is a one-shot service in the `migration` profile that the long-running services do not depend on. Each secret-bearing service mounts only its own DEVOPS-007 generation. PostgreSQL, RabbitMQ, and Redis are optional, private, digest-pinned infrastructure with persistent named volumes and no published ports. Host-specific group IDs come from the host-owned `stack.env`.
- `vps-deploy-stack.json` is the matching root-owned host stack registry (`/etc/vps-deploy/stacks/example-backend-production.json`). It authorizes the repository, image namespace, deployment root, the four runtime-secret instances (the migrator is not started at boot), and the read-only PostgreSQL configuration bind.
- The `deploy-production` job in `ci.yml` deploys the publish job's manifest to the `production` GitHub Environment with `migration-service: database-migrator` and a loopback WebAPI health check. Its SSH and pull-only registry credentials are separate from the CI and publishing credentials. A failed migration blocks rollout and is reported as `migration-status: failed`, `timed-out`, or `not-started`.
- The `notify-deployment-failure` job is caller-owned alerting: when the deployment job fails or is cancelled, it posts the sanitized `deployment-outcome`, `failed-phase`, `migration-status`, and `restoration-outcome` to the webhook in the caller secret `DEPLOY_ALERT_WEBHOOK_URL`. Adapt the payload to your provider. The job fails if the secret is missing, so a missing alert is visible.

The current backend template's migrator loops after migrating, and its production Compose file has build sections and published ports. Adopt the [migration guide](../../docs/migration-guide.md#adopting-vps-deployment-before-the-first-release) changes before deploying it with the toolkit.
