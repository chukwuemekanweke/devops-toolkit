# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

### Changed

- Reconciled the DEVOPS-006 design with the implemented contract: `/run/runtime-secrets` tmpfs is now the default, key-per-file is definitive, runtime refresh retention is distinguished from reboot loss, activation is separated from health validation, and container recreation is required after pointer activation.
- Replaced the planned Infisical runtime-secrets provider with Doppler. Earlier documentation named Infisical only as a later design; no Infisical integration was ever implemented. Linked the Doppler design from the README, architecture, security, deployment-model, workflow-contract, and migration documentation. Recorded the rules that the planned `vps-deploy.yml` and `vps-rollback.yml` implementations must follow: deployment-time secret rendering order, ephemeral migrator secrets, and secret-generation rollback policy. Public workflow contracts and manifest schemas are unchanged.
- Reconciled the unreleased .NET CI contract around template-owned Testcontainers by removing Compose inputs and the integration environment secret; the consumer example now demonstrates verification only and avoids an uncreated `v1` reference.
