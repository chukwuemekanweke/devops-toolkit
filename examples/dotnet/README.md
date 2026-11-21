# Illustrative .NET consumer

These files model future content in `dotnet-core-project-template`; they are not functional until the reusable workflows are implemented.

- `ci.yml` is a thin caller that owns push/pull-request filters, passes the `.slnx` and test patterns to `dotnet-ci.yml`, and calls publishing only after verification on a main-branch push.
- `docker-images.json` is proposed application-owned `.github/docker-images.json` content for WebAPI, Consumer, Jobs, and DatabaseMigrator using verified current Dockerfile paths.

CI receives `contents: read` and `packages: read`; publishing receives only `contents: read`. Docker Hub write credentials and read-only GitHub Packages credentials are explicitly mapped. The `package-auth-components` list scopes `GITHUB_USERNAME`/`GITHUB_PAT` BuildKit mounts to the four Dockerfiles that currently require them. No runtime application secret is passed.

`docker-publish.yml` aggregates component digests and exposes `manifest-json` plus the canonical `release-manifest-<deployment-id>` artifact. A later caller supplies exactly one of those to `vps-deploy.yml`. The deployment maps `migrator` to the application Compose migration service, requires its one-shot success, then releases and health-checks dependent services.
