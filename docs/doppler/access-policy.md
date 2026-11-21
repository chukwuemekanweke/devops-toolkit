# Access policy and service tokens

Status: **Design (DEVOPS-006).** No tokens, projects, or memberships exist yet. Product behavior marked *Verified* was checked against official Doppler documentation on 2026-11-21 ([sources](architecture.md#sources-and-verification)). Everything else is proposed policy.

## Machine credential: Doppler service tokens

On the Developer plan, the **service token** is the only machine credential (service accounts and identity-based authentication are Team+). Verified properties:

| Property | Behavior |
| --- | --- |
| Scope | Exactly one config in one project. The token determines project and config; no other selection is needed |
| Access | Read-only by default. Write access is an explicit option at creation |
| Expiry | Optional. An expired token is automatically deleted. CLI flag `--max-age` |
| Visibility | The value is shown once, at creation |
| Revocation | Immediate and irreversible (`doppler configs tokens revoke`, or the dashboard) |
| Format | Prefix `dp.st.` (optionally `dp.st.<env>.`) |
| Exchange | None. The token is presented directly on every request. There is no short-lived access token |
| Network restriction | Trusted IPs are Team+. **Not available** on Developer |
| Plan limit | 50 service tokens (scope of the limit **unverified**; assumed per workplace) |

Doppler warns against using CLI tokens (`dp.ct.`) or personal tokens (`dp.pt.`) in live environments, because they carry the full permissions of the user who created them, including write access. **Only service tokens are ever installed on hosts.**

## Token allocation

### Options evaluated

| Scope | Independent revocation | Blast radius of one leaked token | Attribution in access logs | Tokens (backend, one host, stg + prd) |
| --- | --- | --- | --- | --- |
| One token per environment root | Environment | Root only. **Unusable**: roots are empty and services need branch values | — | — |
| One token per application and environment (a single "union" config) | Environment | Every service's secrets in that environment | Environment | 2 |
| **One token per service config per host** | **One service on one host** | **One service's secrets in one environment** | **Service and host** (token name) | **8 (10 with the planned collector)** |

### Decision

**One read-only service token per service config per host.**

| Attribute | Value |
| --- | --- |
| Config | `<env>_<service>`, for example `prd_webapi`. Never a root config |
| Name | `<host>-<yyyymmdd>`, for example `vps01-20261121`. The config already identifies the application, environment, and service, so the name records host and issue date for attribution and rotation |
| Access | Read (default). Write access is never selected |
| Expiry | Hard expiry of **120 days**, rotated every **90 days**. The exact `--max-age` syntax and the maximum allowed value must be confirmed at provisioning |
| Holder | One host. Never copied to a second host, a workstation, GitHub, a container, an image, or a release artifact |
| Storage | Encrypted systemd credential, root-owned ([bootstrap](vps-bootstrap.md#installing-a-service-token)) |

Why per service when one host renders every service? Each service has its own systemd credential and its own render run. A token exposed through a misconfiguration, a backup, or an operator's terminal then exposes only one service. Revoking one service's token on one host does not interrupt the others. Doppler access logs identify which token, and therefore which service and host, read a secret. Separate tokens do **not** protect against host root compromise, which can read every token on the host ([threat model](audit-and-threat-model.md#t4-compromised-vps-root-account)).

### Token budget

| Application | Configs with tokens (per environment) | stg tokens per host | prd tokens per host |
| --- | --- | --- | --- |
| example-backend | webapi, consumer, jobs, database-migrator, otel-collector (planned) | 4–5 | 4–5 |
| example-frontend | none today | 0 | 0 |

Rotation needs a second token per config for a short overlap. Keep at least 25% of the 50-token limit free for rotation and incident replacement. When this cannot be met, upgrade to Team (500 tokens) rather than share tokens.

### Shared-token alternative

**Requires a recorded risk acceptance.** One token per application, environment, and host, reading a single union config (for example `prd_runtime`), with the host helper splitting keys per service using the application's per-service key lists.

- **Retained:** host-side file isolation between containers (each service still mounts only its own keys).
- **Lost:** per-service revocation and attribution. A single leaked token exposes the whole stack for that environment, including database-owner and payment credentials.
- **Rule:** even under this alternative, production `database-migrator` (schema owner) and any service holding payment secrets keep dedicated configs and tokens.

### Development

- Developers do not receive tokens for `stg` or `prd`, and do not hold Doppler membership in a workplace containing production configs ([human access](#human-access)).
- A `dev` service token is issued only for a shared development server, using the same per-service pattern.
- Development values must be unusable against staging or production providers (separate provider accounts, sandboxes, or keys).

### Denied access (enforced by token scope)

For a token issued for `stg_webapi`:

| Attempt | Expected result |
| --- | --- |
| Read `stg_webapi` | Allowed: its own secrets, plus anything inherited from the `stg` root (kept empty) |
| Read `stg_consumer` (sibling service) | Denied |
| Read `prd_webapi` or `dev_webapi` (other environment) | Denied |
| Read the `stg` root config directly | Denied |
| Read any config in another project | Denied |
| Create, change, or delete any secret | Denied (read-only token) |
| List or create tokens, change project settings, read logs | Denied |

These are verified only by the documented single-config scope. They become **mandatory acceptance tests** before production ([below](#acceptance-tests)).

## Token lifecycle

| Stage | Behavior |
| --- | --- |
| Issuance | The secrets administrator creates the token from an administrator workstation (dashboard or CLI logged in as themselves), read-only, with an expiry, named `<host>-<date>` |
| Transfer | Directly into the host's encrypted credential store in an interactive session. Never through chat, email, tickets, GitHub, or provisioning automation |
| Bootstrap storage | `systemd-creds` encrypted file, `root:root 0400`, decrypted by systemd only into the render unit's private credentials directory for the duration of one run |
| Host authentication | The render helper passes the token to the Doppler CLI child through the `DOPPLER_TOKEN` environment variable (never an argument), or as an HTTP header read from a file descriptor. TLS certificate validation is mandatory |
| Use | Once per render run: deployments, rotations, and explicit refreshes. Never polled continuously |
| Expiry | Doppler deletes the token at expiry. Renders then fail closed and running containers keep their current generation. Expiry dates are tracked in the monthly review |
| Rotation | Issue a second token for the same config, install it, verify a render, revoke the old token ([runbook](rotation-and-revocation.md#doppler-service-token)) |
| Revocation | Immediate. It does not affect running containers, which keep their mounted generation. Revocation stops new reads, but it does **not** un-disclose secrets already read: rotate the secrets themselves if the token may have been misused |

## Human access

### What the Developer plan provides

Role-based access and environment-scoped roles are Team+ (Verified). The Developer plan documentation does not state what roles members receive. A Doppler guide describes every Developer-plan member as having full access. **This design assumes that every member of a Developer-plan workplace can read and change every secret in every environment.**

### Policy

| Role | Holder | Doppler access | Notes |
| --- | --- | --- | --- |
| Workplace owner (break-glass) | At most two named people | Owner | Strong unique password and MFA on the Doppler account. Used for billing, workplace settings, and recovery |
| Secrets administrator | Named maintainer(s) | Member of the workplace that holds `stg`/`prd` | Creates configs and tokens, writes values, rotates, reviews logs |
| Application developer | Team members | **No membership** in a workplace holding `stg` or `prd` | Uses local development configuration, or a separate development workplace ([architecture option D](architecture.md#alternatives-evaluated)) |
| Auditor / reviewer | Second person where available | No Doppler membership on Free (a read-only reviewer role needs Team+) | Reviews exported evidence and the change log instead |
| Deployment approver | GitHub Environment reviewers | None | Approves releases in GitHub |

Membership of the production-capable workplace **is** production secret access. Adding a member is therefore treated as granting production read and write access, recorded in the change log, and reviewed monthly.

The repository currently has a single maintainer ([architecture.md](../architecture.md#ownership-and-change-management)). Until a second person exists, the secrets administrator, approver, and reviewer roles are held by one person. The compensating controls are a change log for every Doppler administrative action, frequent log review within Doppler's 3-day window, and the checklists in this document set.

## Free-plan limitations and compensating controls

| Missing on Developer | Risk | Compensating control |
| --- | --- | --- |
| Trusted IPs | A stolen service token works from any network until revoked or expired | Per-service, per-host tokens; encrypted storage; 120-day expiry and 90-day rotation; host egress limited to HTTPS for render users; access-log review for unexpected last-read times; immediate revocation runbook |
| Human RBAC and environment-scoped roles | Any member can read and change production | Production-capable workplace limited to secrets administrators; developers excluded; optional separate development workplace; monthly membership review |
| Activity log retention beyond 3 days | Investigations beyond 3 days lack provider evidence | Review at least every 3 days during active change and weekly otherwise; change-notification webhooks to durable storage; change log; host render logs shipped off-host ([audit](audit-and-threat-model.md)) |
| Service accounts and OIDC | No exchange-based or short-lived machine credential | Service tokens only, scoped to one config, read-only, expiring |
| Config inheritance and cross-config references | Shared provider keys cannot have one source | Duplicate into each consumer config; inventory records duplicates; rotation updates every copy |
| Change requests and approvals | A single member can change production immediately | Change log, webhooks for change detection, versioning for recovery |
| SSO and SCIM | Account lifecycle is manual | Departure checklist ([runbook](rotation-and-revocation.md#departing-administrator)) |

When an application holds payment, identity, or regulated data in production, the owner should review whether these compensations are sufficient, or move to the Team plan. The hierarchy and host delivery do not change on upgrade.

## Acceptance tests

DEVOPS-007 or provisioning must run these against a non-production project on the Developer plan **before** issuing production tokens, and keep the evidence (outcome only, never values):

| # | Action with a read-only `stg_webapi` token | Expected |
| --- | --- | --- |
| 1 | Download `stg_webapi` | Success. Only `stg_webapi` keys, plus the three built-in `DOPPLER_*` keys, plus anything in the `stg` root (expected: nothing) |
| 2 | Request `stg_consumer` using the same token with explicit project/config parameters | Denied, or the token's own config is returned. Never sibling values |
| 3 | Request `prd_webapi` and `dev_webapi` | Denied, or own config returned. Never other-environment values |
| 4 | Request the `stg` root config | Denied, or own config returned |
| 5 | Create, update, or delete a secret | Denied |
| 6 | Request a config in another project | Denied |
| 7 | List tokens, read activity logs, change settings | Denied |
| 8 | Use the token after revocation | Denied immediately |
| 9 | Use the token after its expiry | Denied |
| 10 | Add a secret to the `stg` root, then render `stg_webapi` | Doppler returns it (inheritance); the **host helper fails** the render because the key is not in the allowlist. Remove the root secret afterwards |
| 11 | Run the helper's retrieval command, then search the render user's filesystem and `/tmp` | No fallback file, cache, or configuration file containing secrets or the token |
| 12 | Create a config named with a hyphenated service segment (for example `stg_database-migrator`) | Accepted. If rejected, record the underscore mapping |

If test 2, 3, 4, or 6 returns another config's values, the model must not be used. Fall back to [option C](architecture.md#alternatives-evaluated) (project per service) and re-test.

## Network and egress

| Control | Recommendation | Limitation |
| --- | --- | --- |
| Inbound | Default deny; allow SSH (restricted sources where possible) and reverse-proxy ports | Unchanged by this design |
| Render users' egress | nftables `meta skuid` rules: render users may reach only DNS and TCP 443 | Doppler's API addresses are not pinned, so destination-IP restriction is impractical |
| Domain-restricted egress (optional) | Route render users through a local forward proxy that allows only `api.doppler.com` | Adds a component; depends on confirmed proxy support in the chosen client |
| TLS | Certificate validation always on; never pass options that disable verification | — |
| Container egress | Application-owned | Containers usually need broad egress to providers |

## Change control

Every change to a project, config, token, or workplace membership:

1. Has a reason recorded in the change log (ticket or PR reference), with token names and configs but never values.
2. Is made by a secrets administrator, never by automation that also holds runtime tokens.
3. Is followed by the relevant acceptance tests.
4. Is reviewed at the next [access review](audit-and-threat-model.md#periodic-access-review).

Automating Doppler provisioning (API or Terraform) is a later decision. Any credential used for it is an administrative credential, separate from runtime tokens, never stored on application hosts, and never available to deployment workflows.
