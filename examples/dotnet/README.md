# Illustrative .NET consumer

These files model consumer-owned content for `dotnet-core-project-template`. The caller uses the DEVOPS-003 and DEVOPS-005 feature branches for development smoke testing; replace mutable references with validated immutable release tags or full commit SHAs before adoption. No `v1` alias exists yet.

- `ci.yml` is a thin caller that owns push/pull-request filters, verifies the `.slnx`, and publishes only after a successful trusted push to `main`.
- `docker-images.json` is proposed application-owned `.github/docker-images.json` content for WebAPI, Consumer, Jobs, and DatabaseMigrator using verified current Dockerfile paths.

CI receives `contents: read` and `packages: read`, and read-only GitHub Packages credentials are explicitly mapped to the optional paired NuGet secrets. Testcontainers owns integration infrastructure; CI checks Docker but does not invoke Compose. No runtime application secret is passed.

Publishing explicitly maps Docker Hub credentials and the read-only package pair for all four current Dockerfiles. Buildx mounts them only as `GITHUB_USERNAME` and `GITHUB_PAT`; they are never build arguments. The caller grants only `contents: read`. Replace the illustrative `docker.io/example/...` repositories before smoke testing. Publishing emits digest references and a manifest but does not deploy or change application topology.
