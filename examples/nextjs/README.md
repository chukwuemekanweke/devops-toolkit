# Illustrative Next.js consumer

These files model future content in `nextjs-project-template`; they are schema-validated by this repository but are not runnable until the reusable workflows are implemented.

- `ci.yml` preserves caller-owned monorepo path filters, invokes shared pnpm lint/type-check/test/build behavior, copies the three checked-in safe `.env.example` files for the build, and publishes only after successful verification on a main-branch push.
- `docker-images.json` is proposed application-owned `.github/docker-images.json` content for User, Admin, and Public portals using verified current Dockerfile paths.

Both jobs receive only `contents: read`. Publishing explicitly maps Docker Hub write credentials. The verified frontend Dockerfiles currently need no private-package BuildKit credential, so none is mapped. `NEXT_PUBLIC_*` values are public build configuration, never a place for secrets; server runtime secrets belong to the separate runtime delivery mechanism.

`docker-publish.yml` aggregates all three portal digests into `manifest-json` and the canonical `release-manifest-<deployment-id>` artifact. Deployment consumes the manifest without rebuilding source. Application-owned Compose and health configuration may roll out and verify the portals independently; rollback restores their recorded immutable digests. Migration is disabled for this stack unless a future application requirement explicitly adds it.
