# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- Reconciled the unreleased .NET CI contract around template-owned Testcontainers by removing Compose inputs and the integration environment secret; the consumer example now demonstrates verification only and avoids an uncreated `v1` reference.
