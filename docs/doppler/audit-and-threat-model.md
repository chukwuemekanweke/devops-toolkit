# Audit, access reviews, and threat model

Status: **Threat model and operating policy for DEVOPS-006/007.** Audit capabilities marked *Verified* were checked against official Doppler documentation and pricing on 2026-11-21 ([sources](architecture.md#sources-and-verification)).

## Audit sources

| Source | What it records | Developer-plan availability | Retention |
| --- | --- | --- | --- |
| Doppler activity (workplace) logs | Actions by team members, including secret changes and membership (Verified). Whether token creation and revocation appear is **unverified** | Yes | **3 days** (Team 90, Enterprise 1095 or custom) |
| Doppler access logs | Per secret: actor (service token, personal or CLI token, API, and others), access method, first and last read (Verified). Source IP is not documented | Yes | **Unverified** for Developer; assume no more than 3 days of history |
| Doppler config logs and versioning | Every change to a config, with rollback; secret versions retained for the secret's lifetime (Verified) | Yes | Versions: secret lifetime. Rollback window on Developer: **unverified** |
| Doppler webhooks | Notifications on config changes to an external endpoint | Yes (5 webhooks) | Determined by the receiver |
| Log forwarding to a SIEM | — | **No** | — |
| Host render journal and `.metadata.json` | Every render: instance, generation, key count, outcome. No values or value hashes | Toolkit (DEVOPS-007) | Shipped off-host; at least 1 year |
| Deployment history | Manifest hash, generation IDs, actor, outcome | Toolkit (DEVOPS-008) | At least 1 year |
| Change log | Every Doppler administrative action, with reason and ticket | Process | Indefinite (version control or ticket system) |

**The Developer plan does not provide long-term audit retention.** Doppler-side evidence older than about 3 days cannot be relied upon. This design does not claim otherwise.

### Compensating controls for short retention

1. **Review cadence.** Review the activity log at least every 3 days during periods of change (onboarding, rotation, incidents), and weekly otherwise. Record the review in the change log with a short summary, not screenshots of values.
2. **Change webhooks.** Configure Doppler webhooks on production configs to post change notifications to an access-restricted, append-only receiver outside the VPS (for example a private repository, ticket queue, or log store). The payload contents must be confirmed at provisioning. Never configure a webhook to include secret values.
3. **Host evidence is the primary record of machine reads.** Every legitimate token read corresponds to a render recorded in the host journal and deployment history. A Doppler access-log "last read" time with no matching render is an incident signal.
4. **Evidence capture on incident.** The first step of every [emergency runbook](rotation-and-revocation.md#emergency-revocation) is capturing Doppler logs before they expire.
5. **Upgrade trigger.** When an application needs provable audit history (client contract, regulation, payment-provider requirement), move to Team (90 days) or Enterprise (custom retention, log forwarding).

## Audit procedure

| Area | What to examine | Source | Frequency |
| --- | --- | --- | --- |
| Workplace membership | Only secrets administrators in the production-capable workplace; owners ≤ 2 | Workplace members | Monthly and on every change |
| Service tokens | Every token maps to a live host and config, follows `<host>-<date>`, is read-only, has an expiry, is under 90 days old, and is in the change log. No token on a root config | Each config's Access tab | Monthly |
| Root configs | `dev`, `stg`, `prd` roots hold no secrets and are locked | Config view | Monthly, and after any provisioning change |
| Machine reads | Access-log last-read times match renders in host and deployment history | Access logs vs host journal | Weekly where possible |
| Secret changes | Every change maps to a rotation or change ticket; read-only tokens made no writes | Activity and config logs, webhook receiver | Within the 3-day window; webhook record monthly |
| Duplicated values | Shared provider keys have the same version across all consumer configs after rotation | Config logs, inventory | After each rotation |
| Token budget | Count against the 50-token limit; headroom for rotation | Token listing | Monthly |
| Personal configs | Disabled, or present only in `dev` | Project settings | Quarterly |
| Rotation ages | Provider credentials within schedule | Change log | Monthly |

## Periodic access review

| Item | Policy |
| --- | --- |
| Frequency | Monthly operational review; quarterly full review of people and tokens; also after every incident, departure, and host change |
| Responsible role | Secrets administrator. A second person countersigns where available. With a single maintainer, record a self-review and the compensating controls ([access policy](access-policy.md#human-access)) |
| Evidence | Token listing (names, configs, expiry; no values); membership listing; change-log entries; acceptance-test results for changed tokens; completed checklist |
| Retention | At least 1 year, outside the VPS |

### Access review checklist

- [ ] Every production-capable workplace member is a named secrets administrator. Owners number two or fewer, with MFA.
- [ ] No developer, contractor, or automation account is a member of the production-capable workplace.
- [ ] Every service token is read-only, has an expiry, belongs to a branch (service) config, follows the naming convention, and maps to a live host.
- [ ] No token is older than 90 days. No two tokens exist for one config and host outside an active rotation.
- [ ] No CLI or personal token is installed on any host.
- [ ] Root configs are empty and locked.
- [ ] Every service config holds only keys listed in the application's key list and the [inventory](secret-inventory.md).
- [ ] Decommissioned hosts have no tokens. Departed people have no membership.
- [ ] Access-log reads correspond to recorded renders. Activity-log reviews were performed at the required cadence.
- [ ] Webhooks are active and the receiver has records for the period.
- [ ] Rotation schedule is current. Overdue rotations have tickets.

### Escalation

| Finding | Severity | Action |
| --- | --- | --- |
| Token without expiry, with write access, on a root config, or not in the change log | Medium | Revoke and reissue within 1 working day; run acceptance tests |
| Secret present in a root config | Medium (High if read) | Follow [value written to the wrong config](rotation-and-revocation.md#value-written-to-the-wrong-config-or-to-a-root) |
| Read with no matching render, or a membership or token change without a ticket | High | Open an incident; follow [emergency revocation](rotation-and-revocation.md#emergency-revocation) |
| Evidence of host compromise or credential misuse | Critical | [Compromised VPS](rotation-and-revocation.md#compromised-vps) |
| Missed review cadence (Doppler evidence expired unreviewed) | Medium | Record the gap; any incident in the gap is unverifiable from Doppler |

## Threat model

Scope: Doppler (Developer plan), the Linux VPS, Docker Compose services, the render mechanism, and the GitHub Actions deployment path. Out of scope: application vulnerabilities other than as an entry point, and compromise of Doppler itself (vendor risk).

**Explicit acknowledgement:** a compromised VPS root account can read every service token on the host and every secret delivered to containers on that host. Doppler reduces credential sprawl and makes rotation and revocation tractable. It does not remove the consequences of a host compromise, and on the Developer plan it cannot restrict where a stolen token is used.

### T1. Leaked service token

- **Scenario:** a token leaks through an administrator's clipboard or terminal, a misdirected file, a backup, or a screenshot.
- **Assets at risk:** every secret in that one config (one service, one environment).
- **Preventive controls:** one token per config per host; read-only; 120-day expiry; 90-day rotation; encrypted systemd credential; installation by `read -rs` and a pipe; no `configure set token`; backup exclusions.
- **Detection:** access-log reads with no matching render; provider-side anomalies.
- **Recovery:** [leaked token runbook](rotation-and-revocation.md#leaked-doppler-service-token-no-host-compromise).
- **Residual risk:** **higher than with an exchange-based or IP-restricted credential.** Without Trusted IPs (Team+), a leaked token works from anywhere until revoked or expired, and short log retention may hide its use.

### T2. Compromised application container

- **Scenario:** remote code execution in WebAPI.
- **Assets at risk:** that service's mounted secrets and what they can reach.
- **Preventive controls:** only the service's own directory is mounted, read-only; non-root container user; no Doppler token or CLI inside containers; per-service database, broker, and storage credentials (planned); the migrator owner credential is not resident.
- **Detection:** application and provider anomaly monitoring; database audit; unusual egress.
- **Recovery:** redeploy a fixed image; rotate that service's secrets, including duplicated provider keys (and their copies in other configs).
- **Residual risk:** secrets are plaintext inside the container by necessity. A duplicated provider key is exposed to every consumer.

### T3. Compromised non-root host user

- **Scenario:** a local account (not root, not in `docker`) is compromised.
- **Assets at risk:** none, if permissions are correct.
- **Preventive controls:** `0700` application-environment directories owned by render users; `0400` root-owned credentials; render users without login shell or Docker access; tokens never in argument lists; CLI `HOME` on a private tmpfs.
- **Residual risk:** a compromised **render user** can use its unit's decrypted token during a run and read all generations for its application environment. A compromised **deploy user** is root-equivalent (T4, T12).

### T4. Compromised VPS root account

- **Scenario:** root through a kernel exploit, the Docker socket, a stolen admin key, or the provider console.
- **Assets at risk:** every token on the host, every generation, container memory, the registry pull token.
- **Preventive controls:** patching; SSH hardening; minimal administrators; no Docker group for ordinary users; disk encryption (offline access only).
- **Detection:** host and provider intrusion alerts; Doppler reads outside deployment windows.
- **Recovery:** [compromised VPS runbook](rotation-and-revocation.md#compromised-vps).
- **Residual risk:** **high and accepted.** Stolen tokens remain usable off-host until revoked, because the Developer plan has no IP restriction. The design limits exposure to this host's configs and makes full rotation tractable.

### T5. Malicious deployment artifacts

- **Scenario:** a tampered image or Compose file mounts other services' secret directories or exfiltrates its own.
- **Preventive controls:** digest-pinned images with scan, SBOM, and provenance; validated manifests; reviewed application Compose files; protected GitHub Environments.
- **Residual risk:** Compose runs with root-equivalent Docker privileges. Code review is the control. DEVOPS-009 should reject mounts under `/run/runtime-secrets` that do not match the service's own directory.

### T6. Misplaced or over-broad secrets

- **Scenario:** a value is written to a root config (reaching every service), a sibling config, or a token is issued with write access or on a root config.
- **Preventive controls:** empty, locked roots; host key-list enforcement fails renders on unexpected keys; read-only tokens only; acceptance tests; review checklist.
- **Detection:** render failure on unexpected keys; monthly review.
- **Recovery:** [value written to the wrong config](rotation-and-revocation.md#value-written-to-the-wrong-config-or-to-a-root).
- **Residual risk:** the token's API response contains the misplaced value even though the host refuses to deliver it, so a host compromise in that window exposes it.

### T7. Unauthorized Doppler administrative changes or reads

- **Scenario:** a compromised member account reads production values, creates a token, or changes secrets.
- **Assets at risk:** every secret in the workplace: on the Developer plan every member is assumed to have full access.
- **Preventive controls:** production-capable workplace limited to secrets administrators; at most two owners; strong unique passwords and MFA; no administrative credential on hosts or in workflows.
- **Detection:** activity-log review within 3 days; webhooks on production configs; token review.
- **Recovery:** [compromised administrator account](rotation-and-revocation.md#compromised-doppler-administrator-account).
- **Residual risk:** **high on the Developer plan.** There are no environment-scoped roles, change requests, or SSO, and detection is limited by retention.

### T8. Secret exposure through logs

- **Preventive controls:** payload captured only in bounded memory, never printed; no `set -x`; no CLI debug output; sanitized `.metadata.json`; GitHub Actions never holds values; `LimitCORE=0`; applications must not log configuration.
- **Recovery:** [secret exposed in logs](rotation-and-revocation.md#secret-exposed-in-logs).
- **Residual risk:** application code can still log configuration; an application responsibility.

### T9. Secret exposure through process environment

- **Scenario:** `docker inspect`, `/proc/<pid>/environ`, child processes, or diagnostics reveal values.
- **Preventive controls:** key-per-file delivery by default; no `doppler run` environment injection; environment variables only through a recorded [exception](vps-bootstrap.md#environment-variable-exception); the token is placed only in the CLI child's environment, readable by the same user and root.
- **Residual risk:** accepted exceptions remain visible to anyone with Docker access.

### T10. Secret exposure through backups or CLI caches

- **Scenario:** a host backup, snapshot, or a Doppler CLI fallback or configuration file contains tokens or values.
- **Preventive controls:** backup path exclusions; host key excluded so encrypted credentials in a backup cannot be decrypted; `--no-file --no-fallback`; private tmpfs `HOME` for the CLI; acceptance test 11; restored hosts receive new tokens.
- **Residual risk:** provider whole-disk snapshots cannot exclude paths; snapshot access is treated as secret access.

### T11. Unauthorized human reads

- **Scenario:** a developer or other person reads production values without a business need.
- **Preventive controls:** no developer membership in the production-capable workplace; optional separate development workplace.
- **Detection:** activity-log review (3 days).
- **Residual risk:** any member can read any environment on the Developer plan. Membership is the only control.

### T12. Compromised GitHub Actions deployment path

- **Scenario:** a malicious workflow change, compromised Action, or stolen deploy key runs commands on the VPS.
- **Assets at risk:** the deploy account is in `docker`, so effectively host root (T4), plus the registry pull token.
- **Preventive controls:** GitHub Actions holds no Doppler credential and no application values; SHA-pinned Actions; protected Environments with required reviewers and ref restrictions; no `pull_request_target`. Recommended for DEVOPS-008: an SSH forced command and mount validation.
- **Residual risk:** while the deploy account has Docker access, a compromised deployment path can reach host secrets. The design ensures this requires compromising the **protected deployment path**, not merely reading CI configuration or logs.

### T13. Doppler outage, rate limiting, or token expiry

- **Assets at risk:** availability of deployments and rotations.
- **Preventive controls:** runtime refresh failure never mutates `current`; tmpfs boot initialization is ordered before secret-bearing stacks; bounded retry covers only transient failures; token expiry is tracked monthly.
- **Recovery:** follow [boot and outage recovery](vps-bootstrap.md#boot-ordering-and-outage-recovery) and the token replacement runbook.
- **Residual risk:** a provider outage blocks boot after tmpfs loss and blocks emergency rotation. Already running containers remain available only while the host stays up. Provider revocation still takes precedence for containment.

## Summary of residual risks

| Risk | Level | Owner decision required |
| --- | --- | --- |
| Host root compromise exposes all secrets and tokens on the host | High (inherent) | Accept; mitigate with patching, minimal access, and the rebuild-and-rotate runbook |
| No IP restriction: stolen tokens usable from anywhere | High on Developer | Accept with expiry, rotation, and review, or upgrade to Team for Trusted IPs |
| No human RBAC: every member can read production | High on Developer | Restrict membership; consider a separate development workplace or Team |
| 3-day activity-log retention | Medium | Review cadence and webhooks, or upgrade |
| Deploy account has Docker (root-equivalent) access | High | DEVOPS-008: forced commands and mount validation; consider rootless Docker |
| Root-config inheritance leaks a misplaced value to all branch tokens | Medium | Empty locked roots and host key-list enforcement |
| Duplicated provider keys across configs | Medium | Inventory tracking; rotation checks |
| Environment-variable exception for profiler credentials | Low to medium | Collector design or recorded acceptance |
| Single maintainer: no separation of duties | Medium | Compensating controls until a second reviewer exists |
