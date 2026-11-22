# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Reusable `release-config-check.yml`. It validates an application's image configuration, deployment configuration, and an optional repository copy of the host stack registry on pull requests, using the same validation code as `docker-publish.yml` and `vps-deploy.yml` against a placeholder-digest manifest. It also renders the Compose files with `docker compose config` exactly as the host stages them (with an optional `compose-env-file` standing in for the host `stack.env`) and, with a registry copy, applies the host's Compose policy; runtime-secret mounts are checked against the fixed DEVOPS-007 layout because the instance files exist only on the host. It needs no secrets, registry, GitHub Environment, or VPS, and it publishes a job summary of what it checked.
- Optional `deploy-config-path` input for `vps-deploy.yml`: an application-owned deployment configuration file ([vps-deploy-config.schema.json](docs/schemas/vps-deploy-config.schema.json) v1) that replaces the inline topology inputs and is validated by the same rules. `compose-files` and `remote-deployment-path` are now optional at the workflow level and still required when no file is given. Declaring a setting in both places is rejected. The caller is now checked out before input validation. Minor, backward compatible: existing callers need no change.
- `docker-publish.yml` appends the release (deployment ID, source commit, and one immutable `image@digest` reference per component) to the `aggregate` job summary.
- Both consumer examples move their deploy settings into `vps-deploy-config.json` and run `release-config-check.yml` before publishing.
- DEVOPS-010 deployment outcome and alerting contract for `vps-deploy.yml`. These are additive workflow outputs: `deployment-outcome`, `failed-phase`, `failure-category`, `migration-status`, and `restoration-outcome`.
  - Results, host history, and the audit record gain `outcome` and `migration.status`/`started`/`databaseMayHaveChanged`.
  - Outcomes distinguish success, failure before rollout, restored after failure, failed restoration, restoration disabled, no previous release, and an unknown host result.
  - Migration status distinguishes a migrator that never started from one that ran.
  - The job summary flags that the database may have changed.
  - Older host helpers are still classified from their existing result fields.
  - Both consumer examples add a provider-neutral, caller-owned `notify-deployment-failure` job.
- Operations documentation:
  - expand/migrate/contract schema compatibility;
  - recovery for partial migrations, interrupted migrators, failed restoration, incompatible schema changes, and database restore;
  - single-VPS downtime and availability limitations.
- Unit tests for the health contract, migration evidence in the Docker adapter, outcome classification, and record sanitization. Linux harness checks for an unavailable migration dependency, an interrupted migrator, and a restart-looping container.
- DEVOPS-009 reusable `vps-deploy.yml`. It deploys a `docker-publish.yml` manifest to an independent, application-owned Docker Compose stack on a Linux VPS over SSH, with a pinned host key and a deploy key bound to one stack by a forced command. On the host it uses a sudo-constrained root helper and a root-owned stack registry (`vps-deploy-stack.schema.json` v1) that authorizes environment, path, source repository, image namespaces, runtime-secret instances, ports, binds, and networks. The helper:
  - takes a stack-scoped lock and stages releases with atomic state transitions;
  - generates a digest image override;
  - applies a Compose policy that rejects privileged mode, host namespaces, Docker socket and foreign secret mounts, unapproved binds/ports/networks, mutable images, and root release containers;
  - pulls by digest with a temporary pull-only credential;
  - renders DEVOPS-007 runtime secrets before an optional time-bounded one-shot migration (exit 0 required);
  - uses generation-label-driven container recreation;
  - verifies service state and host-side HTTP health;
  - writes write-once manifests, append-only sanitized history, and a 90-day audit artifact;
  - automatically restores the previous images and secret pointers after a failed rollout (the job still fails).
- `vps-deploy-stack@.service` and a generated boot drop-in that start the active release only after DEVOPS-007 initialization (fail closed when Doppler is unavailable), plus a forced-command wrapper, installer, sudoers template, and an operations guide (`docs/vps-deployment.md`).
- Production Compose and host stack registry examples for the four-component backend (one-shot migration profile) and three-portal frontend (no migration), plus deploy jobs in both consumer callers.
- VPS deployment unit tests and two privileged Linux harnesses: Docker-in-Docker with real Compose, sshd, and sudo; and a booted systemd host. They run in a new `vps-deploy-linux` validation job.
- DEVOPS-007 host-side Doppler delivery: pinned CLI adapter, strict versioned instance and key-manifest contracts, key-per-file tmpfs generations, atomic render/activate/discard/restore/prune lifecycle, stable automation errors, hardened systemd templates, fail-closed boot ordering, service-isolated Compose example, portable negative tests, and an explicit privileged Linux/Docker integration harness.
- Doppler runtime-secrets design (DEVOPS-006, documentation only) under `docs/doppler/`, targeting the Developer (free) plan with capabilities and limits verified on 2026-11-21. It covers: one project per application with `dev`/`stg`/`prd` environments, one branch config per service, and empty, locked root configs. Each service config on each host gets its own read-only, expiring service token. Host-side systemd rendering writes atomic key-per-file generations, enforces an application-owned key list and a token scope check, writes no CLI fallback files, and is mounted read-only by Compose. Also included: a verified backend and frontend secret inventory, isolation analysis and alternatives, acceptance tests, bootstrap, failure and outage behavior, rotation, emergency revocation, audit, access-review, and threat-model documentation, plus the Free-plan limitations and their compensating controls. No Doppler integration is operational yet.
- Reusable OCI image publishing with strict caller configuration validation, dynamic Buildx matrices, Docker Hub digest identity, component-scoped cache and package secrets, Trivy policy enforcement, registry-native SBOM/provenance attestations, artifact-based aggregation, and atomic release-manifest outputs.
- Docker publishing behavior and contract tests covering duplicate JSON properties, paths and symlinks, image/tag/platform identity, package credential selection, result evidence, complete aggregation, security invariants, and public workflow compatibility.
- Reusable Next.js/pnpm monorepo CI with exact pnpm contract checks, full or filtered workspace verification, safe build-configuration copying, explicit result outputs, and optional diagnostic build artifacts.
- Tested Next.js CI helper validation for selector argument safety, package scripts and versions, repository-contained configuration paths, artifact exclusions, failure gating, and workflow security invariants.
- Reusable `.NET 10` CI with restore, IDE0005 formatting validation, Release build reuse, deterministic multi-project unit and Testcontainers integration testing, combined coverage, explicit verification outputs, and optional paired NuGet authentication.
- Tested .NET CI helper validation for repository-contained paths/globs, failure aggregation, Docker-unavailable skip detection, coverage expectations, and artifact/output behavior.
- Repository governance through CODEOWNERS, weekly GitHub Actions Dependabot updates, and a focused pull-request review checklist.
- TypeScript toolkit validation with strict type checking and Vitest coverage for Actions syntax, YAML/JSON structure, schema-positive and schema-negative fixtures, reference topologies, workflow contract drift, and security invariants.
- SHA-pinned `devops-actions/actionlint` integration backed by a digest-pinned actionlint container.
- Contributor and release guidance covering local validation, consumer smoke-test growth, compatibility review, immutable tags, and explicitly approved major-alias promotion.
- Initial reusable CI/CD architecture and repository responsibility boundaries.
- Public contracts for .NET CI, Next.js CI, Docker image publishing, VPS deployment, and VPS rollback.
- Versioned application-owned Docker image configuration with four-backend and three-frontend examples.
- Immutable multi-image deployment manifest contract.
- Security, versioning, ownership, migration, and release policies.
- Illustrative thin callers for the four-image .NET template and multi-application Next.js template.

### Fixed

- `docker-publish.yml` no longer loses its image matrix to GitHub Actions job-output masking.
  - Before this fix, the `prepare` job read `github-packages-username`/`github-packages-token` to check credential presence. When the package username also appeared in public metadata (repository owner, Docker Hub namespace, image names), GitHub skipped the `matrix`, `source-repository`, and `build-reference` outputs as possibly secret. No image jobs were scheduled and no manifest was produced.
  - `prepare` and `aggregate` now reference no secrets. Each `build_publish` matrix job checks credential presence with the new internal `docker-publish.mjs check-credentials` command, before Docker Hub login, immutable-tag inspection, and push.
  - The credential rules and error messages are unchanged. So are the workflow inputs, secrets, outputs, matrix shape, BuildKit secret IDs, artifact names, and manifest schema.
  - Missing package credentials now fail the affected component jobs rather than `prepare`. A public component configured alongside an authenticated one can therefore be pushed before the run fails, and no release manifest is produced.
- `vps-deploy.yml` outputs can no longer be lost to job-output masking (#12).
  - Before this fix, the `deploy` job exported all nine outputs and also referenced the SSH and registry secrets. GitHub skipped any output that contained one of those values, so callers received empty strings after the host had already been updated. For example, an `ssh-user` of `deploy` emptied `deployment-record-artifact` (`vps-deployment-record-…`), and a registry username equal to the repository owner could empty owner-derived deployment IDs.
  - `deploy` now exports no job outputs. A new secret-free `report` job (`needs: deploy`, `if: always()`, no environment) downloads the sanitized record and exports the outputs, using the internal `vps-deploy.mjs record-artifact` and `report` commands.
  - Output names, vocabularies, and meanings are unchanged, as are the inputs, secrets, permissions, artifact name, record schema, host interface, and job pass/fail rule.
  - When the deploy job ends before uploading its record, outputs now report `deployment-status: failed` and `unknown` for the outcome fields instead of empty strings. Callers that default empty values to `unknown`, as both examples do, see no difference.
- On Windows, the host-state module used by the `vps-deploy` engine tests failed every second deployment at commit with `EPERM`: Windows refuses to rename over the read-only (`0444`) `active-manifest.json`. On Windows only, it now clears the read-only attribute and retries once. Linux, the only supported host, is unchanged.
- The runtime-secrets ancestor-ownership test failed when the suite ran as root (for example in a container), because the fixture's ancestors were then root-owned. As root, the test now gives an ancestor to an unprivileged uid, so the rejection is still exercised.
- DEVOPS-007 units failed on every real systemd host. This was found by the new systemd harness:
  - `runtime-secrets-{render,activate,discard,restore}@` ran Node.js under `MemoryDenyWriteExecute=yes`, which aborts V8's JIT. They now run `node --jitless` and keep the hardening.
  - `runtime-secrets-render@`'s `SystemCallFilter=~@privileged` also denied `@chown`, which killed the helper with SIGSYS while it set generation file ownership. `@chown` is now explicitly re-allowed.

### Changed

- DEVOPS-010 hardens `vps-deploy` migration and health gates. Each previously risked an incorrect success or the loss of an in-flight migration.
  - A migration now succeeds only when its container exists, has stopped, and recorded exit code `0`. A zero CLI status without a terminated container, or a still-running (even healthy) migrator, fails.
  - A migrator still running from an interrupted deployment now blocks the deployment instead of being force-removed.
  - A required container restarted by Docker during health verification now fails health.
- `workflow-contracts.md` documents the implemented `vps-deploy.yml` validation, execution, restoration, and audit behavior without changing its inputs, outputs, secrets, or permissions. The same-run `manifest-artifact` download needs only `contents: read`.
- Reconciled the DEVOPS-006 design with the implemented contract: `/run/runtime-secrets` tmpfs is now the default, key-per-file is definitive, runtime refresh retention is distinguished from reboot loss, activation is separated from health validation, and container recreation is required after pointer activation.
- Replaced the planned Infisical runtime-secrets provider with Doppler. Earlier documentation named Infisical only as a later design; no Infisical integration was ever implemented. Linked the Doppler design from the README, architecture, security, deployment-model, workflow-contract, and migration documentation. Recorded the rules that the planned `vps-deploy.yml` and `vps-rollback.yml` implementations must follow: deployment-time secret rendering order, ephemeral migrator secrets, and secret-generation rollback policy. Public workflow contracts and manifest schemas are unchanged.
- Reconciled the unreleased .NET CI contract around template-owned Testcontainers by removing Compose inputs and the integration environment secret; the consumer example now demonstrates verification only and avoids an uncreated `v1` reference.
