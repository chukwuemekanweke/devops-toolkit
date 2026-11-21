# Secret rotation and revocation

Status: **Operating policy.** The DEVOPS-007 helper and units exist; the runbooks become operational for a consumer only after its Doppler resources and host identities are provisioned. Provider behavior marked **unverified** must be confirmed before relying on zero-downtime rotation.

## Terms

- **Render cycle** for a service: `runtime-secrets-render` → `runtime-secrets-activate` → `docker compose up -d --force-recreate --no-deps <service>` → health verification. For `database-migrator`, the credential is picked up at the next migration run instead ([ephemeral migrator secrets](vps-bootstrap.md#ephemeral-migrator-secrets)).
- **Consumers** of a secret: every service config listed for it in the [secret inventory](secret-inventory.md), on every host and environment where the value is used.
- **Evidence**: change-log entry (who, what, when, why, ticket), Doppler activity and access-log observations captured within the 3-day retention window, render `.metadata.json` generation IDs, health results. Never secret values.

## Rotation schedule

| Credential | Routine interval | Additional triggers |
| --- | --- | --- |
| Doppler service tokens | 90 days (expiry 120 days) | Administrator departure, host incident, suspected exposure |
| PostgreSQL service and owner roles | 180 days | Administrator departure, database incident |
| Redis, RabbitMQ credentials | 180 days | Same |
| Cloudflare R2 tokens | 180 days | Same |
| JWT signing key | 180 days after the multi-key template change; until then only on suspicion | Any suspected exposure |
| Email, KYC, geolocation, payment, telemetry credentials | 365 days, or the provider's policy if stricter | Provider advisory, administrator departure |
| Deployment credentials (SSH, registry) | Per [security.md](../security.md#credential-contracts) | — |

Departing administrators trigger rotation of everything they could read. On the Developer plan every workplace member is assumed to have read every environment ([access policy](access-policy.md#human-access)), so a departure from the production-capable workplace means rotating **all** production secrets, prioritizing Critical ones.

## Generic routine rotation procedure

1. **Plan.** From the inventory, identify consumers, environments, duplicated copies, whether the provider supports overlap, and the services to recreate. Rotate `stg` first, then `prd`.
2. **Create** the new credential at the provider. Where the provider supports overlap, the old credential stays valid.
3. **Write** the new value to **every** consuming service config in Doppler ([duplicated values](#duplicated-values)). Never write it to a root config.
4. **Deliver** with a render cycle for each consumer, one service at a time. Confirm that each `.metadata.json` shows a new generation and the expected key count.
5. **Verify** service health, and confirm at the provider that the new credential is in use (last-used timestamps, connection listing, provider logs).
6. **Revoke** the old credential at the provider, after every consumer on every host has switched.
7. **Verify** again, with no errors after revocation.
8. **Record** the evidence. Doppler secret versioning keeps the old value; once revoked at the provider it is useless. Redact the old version in Doppler if policy requires.

Without overlap support, steps 4–6 become a short maintenance window: change the credential, deliver immediately, and accept failed requests in between.

### Duplicated values

The Developer plan has no config inheritance or cross-config references, so a provider-issued key used by several services exists in several configs. For every rotation of such a key:

1. List every config holding it from the inventory, for example `prd_webapi` and `prd_jobs` for `KYC__KYCAID__APIKEY`.
2. Update all of them in the same change.
3. Before revoking at the provider, confirm that every listed config shows the new version in its config log, and that every consumer rendered a new generation.
4. Record any config that was missed as an inventory defect.

## Credential-specific procedures

### PostgreSQL

**Zero-downtime (recommended, Planned role model):** each service has two login roles, `<app>_<svc>_a` and `<app>_<svc>_b`, both members of a `NOLOGIN` role `<app>_<svc>` that holds the privileges.

1. Set a new password on the inactive login role from an administrator session with statement logging disabled for that session.
2. Write a connection string using `_b` to the service's config, then run the render cycle.
3. When no sessions remain for `_a` (`pg_stat_activity`), set a random unknown password on `_a` or mark it `NOLOGIN`.

**In-place (transitional, single role):** `ALTER ROLE ... PASSWORD`. Existing connections stay open and new connections fail until the render cycle completes. While the template still shares one write credential across four services, all four configs and services must be cycled.

**Owner role:** rotate just before a planned migration. The next migration run's ephemeral render picks up the new value.

### Redis

- **ACL users (Redis 6+):** `ACL SETUSER <svc> >newpass` adds a second password. Deliver, verify, then `ACL SETUSER <svc> <oldpass` removes the old one.
- **Single `requirepass` or a managed provider without ACLs:** change the password and immediately cycle `webapi`, `consumer`, and `jobs`.

### RabbitMQ

A user has one password. For zero downtime, create `<svc>-v2` with the same virtual-host permissions, deliver it, verify consumers are attached, then delete the old user. Otherwise change the password and immediately cycle `consumer` and `jobs`.

### Cloudflare R2

Create a new API token with the same bucket scope, deliver, verify uploads and downloads, then delete the old token. Zero-downtime.

### JWT signing key

- **Current template (single key, no overlap):** rotation invalidates every outstanding access token when WebAPI restarts. Clients use their refresh tokens. Impact is bounded by `Jwt:LifetimeMinutes`.
- **After the planned template change (`Jwt:AdditionalValidationKeys`):** add the new key as an additional validation key and deliver; swap signing and validation keys and deliver; after one access-token lifetime, remove the old key and deliver.
- Generate keys with at least 256 bits from a CSPRNG (for example `openssl rand -base64 48` in an administrator session), and paste directly into Doppler.

### Email (Mailtrap)

- API token: create a new token, deliver to `consumer`, send a test message, revoke the old token.
- Webhook signing secret: overlap is **unverified**. Rotate at the provider and immediately deliver to `webapi`. Webhooks signed during the switch may fail verification and rely on provider retries.

### Payment providers (Bachs, Credo, SafeHaven)

Overlap support is **unverified** for all three. Before the first production rotation, confirm with each provider whether two keys can be active at once, how webhook secret changes are handled, and, for SafeHaven, the client assertion's lifetime and renewal. Until then:

1. Schedule a maintenance window. Pause payment-initiating jobs if the application supports it.
2. Write the new credential to every confirmed consumer's config and run render cycles.
3. Run a sandbox or low-value verification transaction where permitted, and check reconciliation.
4. Revoke the old credential.

### KYC, IP geolocation

Create a new key if the provider allows several, write it to `<env>_webapi` and `<env>_jobs`, deliver, verify, and revoke the old key. Otherwise rotate and deliver immediately.

### Telemetry

Create a new Grafana Cloud access-policy token, deliver to the collector (planned) or, until then, to each service holding the telemetry credentials, verify ingestion, then delete the old token.

### Doppler service token

1. In Doppler, generate a **second** read-only token for the same config, named `<host>-<new date>`, with a 120-day expiry.
2. Install it on the host using atomic encrypted-credential replacement ([installation](vps-bootstrap.md#install-or-replace-a-token)).
3. Run `runtime-secrets-render` for the instance. Confirm success and the scope check, then `runtime-secrets-discard` the pending generation if no delivery is needed.
4. Revoke the old token by name in Doppler.
5. Record the config, old and new token names, host, and dates.

No service restart is needed. The token is used only at the next render. Keep two tokens per config only for the duration of the rotation, because of the 50-token plan limit.

## Emergency revocation

The general order is: **contain first**, then **replace**, then **recover**, then **investigate**. Doppler's activity log keeps only 3 days on the Developer plan, so **capture provider evidence first**, within minutes, before it expires.

| Phase | Actions |
| --- | --- |
| Detection | Alert, unexpected access-log read, provider notification, secret-scanning hit, or report |
| Evidence capture | Screenshot or export the Doppler activity log, the affected configs' access logs, and config logs for the window, before the 3-day window closes. Preserve host journals and `.metadata.json` files |
| Containment | Revoke at the source of authority (provider credential, Doppler token), even if service is degraded |
| Replacement | Issue new credentials and write them to every consuming config |
| Recovery | Render cycles; deploy a clean host if host integrity is in doubt |
| Verification | Health checks; provider confirms the old credential is rejected; acceptance tests for affected tokens |
| Post-incident review | Within 5 working days: timeline, root cause, detection gap, actions with owners |

### Suspected disclosure of an application secret

1. Contain: revoke or rotate the credential at the provider immediately. Do not wait for overlap.
2. Write the replacement to every consuming config, and run render cycles.
3. Check the provider's logs for use of the old credential from unexpected sources.
4. Find and remove the disclosure path (logs, screenshots, tickets, repositories, backups).

### Leaked Doppler service token (no host compromise)

A Doppler service token is a direct bearer credential with no IP restriction on the Developer plan. Treat a leak as **disclosure of every secret in that config**.

1. Revoke the token immediately in Doppler. Revocation is immediate.
2. Check the config's access logs for reads by that token at unexpected times (outside deployments and rotations).
3. Rotate every secret in that config at its provider. If access logs are inconclusive, assume all were read.
4. Issue and install a replacement token. Run a render cycle.

### Compromised VPS

The attacker may hold every token and every rendered secret on that host, plus anything visible to the Docker daemon ([threat model](audit-and-threat-model.md#t4-compromised-vps-root-account)).

1. Contain:
   - Revoke **all** Doppler service tokens issued to that host (token names carry the host).
   - Revoke the host's registry pull token and SSH deploy key.
   - Block the deploy workflow's GitHub Environment.
2. Isolate the host at the provider's firewall. Snapshot for forensics only if the snapshot will be access-restricted and later deleted.
3. Rotate **every** application secret delivered to that host, in every environment it served, starting with Critical ones (database owner, payment, JWT). Remember duplicated copies.
4. Build a replacement host from a clean image, issue new tokens, and deploy the last known-good manifest.
5. Review Doppler access and activity logs (if still within retention) and provider logs for use of the stolen credentials.
6. Destroy the old host and its disks after the investigation.

### Compromised Doppler administrator account

1. Change the account's password and MFA, and remove the member from the workplace if needed (from another owner account).
2. Review the activity log for token creation, membership changes, and secret changes during the window. Revoke any token not in the change log.
3. Because every member can read every environment on the Developer plan, treat **all** secrets in the workplace as disclosed. Rotate them, Critical first.

### Departing administrator

1. Remove their Doppler workplace membership, host accounts and SSH keys, GitHub access and Environment reviewer rights, and provider console access.
2. Rotate the service tokens they issued or could have observed during installation.
3. Rotate production application secrets they could read (on the Developer plan: all of them), Critical first.
4. Re-run the access review checklist.

### Value written to the wrong config (or to a root)

1. Remove the value from the wrong config. If it was a root config, it has already propagated to every branch in that environment.
2. Determine from config logs and access logs whether any token read it before removal. The host key list blocks delivery of unexpected keys, but the token's API response still contained the value.
3. If any token read it, treat the value as disclosed to that token's host and rotate it.
4. Add a review check that would have caught it.

### Secret exposed in logs

1. Rotate the secret (treat it as disclosed).
2. Purge or restrict the log entries in every sink: journald, the log aggregator, GitHub Actions run logs, ticket systems.
3. Fix the cause: a debug flag, an unsanitized exception, `set -x`, or a value in an argument list or environment.
4. If the leak came from toolkit code, publish a fixed release and advisory per [security.md](../security.md#production-controls-and-audit).

### Loss of control over a deployment host

Examples: provider account compromise, account suspension with data retained, lost root access with unknown state. Treat the host as compromised and follow **Compromised VPS**. Also rotate the provider account credentials and review the provider's console audit trail.

## Verification after any rotation or revocation

- Every consumer shows a new generation (`.metadata.json`) and passes health checks.
- The provider shows the old credential as revoked or unused.
- For revoked tokens: a render using the old token fails (acceptance test 8).
- No config listed in the inventory still holds the old value.
- The change-log entry links the ticket, generation IDs, and captured evidence.
