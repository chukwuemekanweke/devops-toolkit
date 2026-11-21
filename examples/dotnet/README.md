# Illustrative .NET consumer

These files model consumer-owned content for `dotnet-core-project-template`. The CI caller is runnable against the DEVOPS-003 feature branch for development smoke testing; replace that mutable reference with the validated immutable release tag or full commit SHA before adoption. No `v1` alias exists yet.

- `ci.yml` is a thin caller that owns push/pull-request filters and passes the `.slnx` and test patterns to `dotnet-ci.yml`.
- `docker-images.json` is proposed application-owned `.github/docker-images.json` content for WebAPI, Consumer, Jobs, and DatabaseMigrator using verified current Dockerfile paths.

CI receives `contents: read` and `packages: read`, and read-only GitHub Packages credentials are explicitly mapped to the optional paired NuGet secrets. Testcontainers owns integration infrastructure; CI checks Docker but does not invoke Compose. No runtime application secret is passed.

`docker-images.json` remains the proposed four-image publishing contract for a later ticket. DEVOPS-003 does not publish images, deploy, or change application topology.
