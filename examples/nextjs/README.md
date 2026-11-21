# Next.js consumer example

`ci.yml` is a thin caller for the implemented reusable Next.js CI workflow. It preserves application-owned pull-request and main-branch path filters, reads Node from `.node-version`, verifies the complete pnpm/Turborepo monorepo, and copies the three checked-in safe `.env.example` files before build.

The commented single-portal job demonstrates filtered verification without placing portal names in the toolkit. Newline-separated `workspace-filters` values are pnpm selectors, so a selector such as `@template/user-portal...` includes that application and its required workspace dependencies. A caller-owned matrix can invoke the same workflow independently for several deployable applications.

During DEVOPS-004 smoke testing, the example uses the feature branch. Production consumers must replace it with a validated immutable release tag or full commit SHA. No `v1` alias exists yet, and `@main` is not a supported production reference.

Both public and private dependency cases require only `contents: read` from this workflow. Private registries may additionally require caller-granted package read permission and an explicitly mapped read-only `npm-token`; never use `secrets: inherit`. `NEXT_PUBLIC_*` values are browser-visible and must not contain secrets. Build configuration must come from checked-in safe examples, while runtime secrets remain outside this verification workflow.

Optional build artifacts are diagnostics only. Set `upload-build-artifacts: true`, provide explicit repository-relative `build-artifact-paths`, and choose retention from 1 through 90 days. The helper rejects traversal, missing paths, globs, and sensitive filenames such as `.env*`, `.npmrc`, credentials, tokens, and private keys.

`docker-images.json` remains proposed application-owned input for the planned publishing capability. DEVOPS-004 does not publish containers or create deployment artifacts.
