# Runtime secret inventory

Status: **Design (DEVOPS-006).** This inventory records where runtime configuration lives **today** in the reference templates and where each secret should live in Doppler after the later implementation and migration tickets. No values are recorded here, and none were copied from the templates.

Sources inspected on 2026-11-21:

- Backend: `chukwuemekanweke/dotnet-core-project-template` at commit `81343c0` (`appsettings*.json` for all four deployables, options classes, service registrations in each `Program.cs`, `docker-compose.yml`, `.env.example`, Dockerfiles).
- Frontend: `chukwuemekanweke/nextjs-project-template` at commit `450c405` (`packages/config`, each app's `env.ts`/`server-env.ts`, `.env.example`, Dockerfiles).

Re-run this inventory whenever a template adds an integration. A future application keeps its own inventory in its repository, using the same columns.

## Vocabulary

| Status | Meaning |
| --- | --- |
| **Verified** | The configuration key is bound by application code and present in `appsettings` and/or Compose |
| **Verified (code only)** | Bound by an options class, but absent from `appsettings`, `.env.example`, and Compose |
| **Planned** | Proposed by this design or required by a recommended application change; does not exist yet |

| Sensitivity | Meaning |
| --- | --- |
| Critical | Grants write access to data, money movement, or identity (database owner, payment secret, JWT signing key) |
| High | Grants read/write to a production integration (broker, cache, object storage, email sending) |
| Moderate | Grants a limited or billable capability (geolocation API, telemetry ingestion) |
| Confidential config | Not a credential, but business-sensitive (for example settlement account details) |
| Not secret | Kept out of Doppler |

## Common properties

Unless a row says otherwise:

- **Environment:** every secret exists independently in `dev`, `stg`, and `prd`, with distinct values. Production values are never copied downward.
- **Doppler location** uses the form `<project> / <config>`, for example `example-backend / prd_webapi`. Service configs are branch configs of the environment root ([architecture](architecture.md#recommended-hierarchy)). Root configs (`dev`, `stg`, `prd`) hold **no** runtime secrets.
- **Privilege:** the consuming service's read-only service token for that one config, on that one host ([access policy](access-policy.md)).
- **Doppler secret name:** the .NET configuration key in upper case with `__` as the section separator, for example `CONNECTIONSTRINGS__POSTGRESWRITE` for `ConnectionStrings:PostgresWrite`. Doppler secret names are upper case ([architecture](architecture.md#secret-naming)). .NET configuration keys are case-insensitive, so the delivered file binds to the existing options classes unchanged ([delivery](vps-bootstrap.md#file-format-and-naming)). The tables below show the .NET key for readability.
- **Restart:** all reference services read configuration at startup, so every change needs a re-render and service recreation ([rotation](rotation-and-revocation.md)).

## Backend: current storage summary

| Mechanism | What it holds today |
| --- | --- |
| `appsettings.json` (committed) | Local development connection strings with a development password, development RabbitMQ credentials, a non-empty JWT signing-key placeholder, and empty placeholders for other secrets |
| `JwtOptions` C# default | The same signing-key placeholder, used when configuration supplies no value |
| `docker-compose.yml` environment | Values interpolated from a local `.env` file (`DATABASE_URL`, `DATABASE_URL_POOLED`, `REDIS_CONNECTION_STRING`, `RABBITMQ_*`, `CLOUDFLARE_R2_*`, `MAILTRAP_*`, `OTEL_*`, `PYROSCOPE_*`), plus a literal `Jwt__SigningKey` |
| `.env` (ignored by Git, from `.env.example`) | Developer-supplied values for the variables above |
| User secrets | WebAPI declares a `UserSecretsId`, used only in the Development environment |
| Not mapped anywhere | Kycaid, Bachs, Credo, SafeHaven, IpInfo, IpWhoIs secrets |

No secret manager and no file-based configuration source exists in the backend today. All four deployables use `WebApplication.CreateBuilder`/host defaults.

## Backend inventory

### PostgreSQL

| Key | Consumers (verified) | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today | Proposed split |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ConnectionStrings:PostgresWrite` | webapi, consumer, jobs, database-migrator | Verified | Critical | `appsettings.json` dev value; Compose `DATABASE_URL` | `prd_webapi`, `prd_consumer`, `prd_jobs`, `prd_database-migrator` (different value in each, after the split) | Yes, one credential for all four | Distinct login roles per service |
| `ConnectionStrings:PostgresRead` | webapi, consumer, jobs | Verified | High | `appsettings.json` dev value; Compose `DATABASE_URL_POOLED` | `prd_webapi`, `prd_consumer`, `prd_jobs` | Yes | Read-only role per service, or the service's DML role through the pooler |

Findings: the migrator connects to the `postgres` maintenance database, issues `CREATE DATABASE` when missing, runs SQL scripts and EF Core migrations, and seeds authorization data. It uses the same write string as the API. The template contains no `CREATE ROLE` or `GRANT` statements.

Proposed (Planned) role model:

| Role (placeholder) | Used by | Privileges |
| --- | --- | --- |
| `<app>_owner` | database-migrator only | Owns schema objects; DDL; no `CREATEDB` in production (the database is created by provisioning) |
| `<app>_webapi`, `<app>_consumer`, `<app>_jobs` | Respective service | `CONNECT`, `USAGE`, DML on application tables through default privileges; no DDL |
| `<app>_reader` (optional) | Read connections | `SELECT` only |

The split requires template changes (role provisioning, `ALTER DEFAULT PRIVILEGES`, and a migrator that no longer creates the database in production). Until then, the transitional state stores the **same** write value in each service config, records the duplication here, and rotates all copies together.

- Rotation: alternate two login roles per service that inherit from a privilege-holding `NOLOGIN` role (zero downtime), or change the password in place (new connections fail until the services are recreated).
- The migrator credential is rendered only for a migration run ([ephemeral migrator secrets](vps-bootstrap.md#ephemeral-migrator-secrets)).

### Redis

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `ConnectionStrings:Redis` | webapi, consumer (caching); jobs (readiness check opens a Redis connection) | Verified | High | `appsettings.json` localhost value; Compose `REDIS_CONNECTION_STRING` | `prd_webapi`, `prd_consumer`, `prd_jobs` | Yes |

- Proposed split (Planned): one Redis ACL user per service where the provider supports ACLs (Redis 6+). Otherwise one password stored in each config and rotated together.
- Rotation: ACL users can hold two passwords at once, which allows overlap. A single `requirepass` password does not.

### RabbitMQ

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `Messaging:RabbitMq:UserName` | consumer, jobs (WebAPI does not connect) | Verified | High (paired identifier) | `appsettings.json` dev default; Compose `RABBITMQ_USERNAME` | `prd_consumer`, `prd_jobs` | Yes |
| `Messaging:RabbitMq:Password` | consumer, jobs | Verified | High | `appsettings.json` dev default; Compose `RABBITMQ_PASSWORD` | `prd_consumer`, `prd_jobs` | Yes |

- Not secret (kept in Compose): `HostName`, `Port`, `VirtualHost`, `EventsExchange`, `CommandsExchange`, `ServiceName`.
- Proposed split (Planned): one broker user per service, with `configure`/`write`/`read` permissions limited to its virtual host, exchanges, and queues.
- Rotation: a broker user has one password. For zero downtime, create a second user, switch the service, then delete the first.
- `RabbitMqMessagingOptions.Validate()` requires the values at startup.

### JWT

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `Jwt:SigningKey` | webapi | Verified | Critical | `appsettings.json` placeholder, `JwtOptions` C# default, literal in `docker-compose.yml` | `prd_webapi` | No |
| `Jwt:AdditionalValidationKeys:0` | webapi | Planned | Critical | — | `prd_webapi` | No |

- Not secret (kept in configuration): `Issuer`, `Audience`, `LifetimeMinutes`.
- The key is a symmetric HMAC key used both to sign and to validate. The hardcoded fallback means a missing secret silently enables a publicly known key. Removing the default and failing at startup is a prerequisite for production.
- Rotation without overlap invalidates every outstanding access token when WebAPI restarts. Zero-downtime rotation needs a template change that accepts additional validation keys for one access-token lifetime (Planned).

### Cloudflare R2

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `ObjectStorage:CloudflareR2:AccessKeyId` | webapi, consumer (register object storage). Compose also maps it to jobs, but Jobs does not register object storage | Verified | High (paired identifier) | `appsettings.json` empty; Compose `CLOUDFLARE_R2_ACCESS_KEY_ID` | `prd_webapi`, `prd_consumer` | Yes |
| `ObjectStorage:CloudflareR2:SecretAccessKey` | Same | Verified | High | `appsettings.json` empty; Compose `CLOUDFLARE_R2_SECRET_ACCESS_KEY` | Same | Yes |

- Not secret (kept in configuration): `Endpoint`, `ApplicationFolder`, `PublicBucketName`, `PrivateBucketName`, `PublicBaseUrl`.
- Jobs is **not** granted R2 credentials. Remove the Compose mapping from Jobs in the template.
- Proposed split (Planned): one R2 API token per service, limited to the buckets and access level that service needs.
- Rotation: tokens can coexist, so rotation is zero-downtime (create, deliver, delete old).
- No start-up validation exists, so a missing value fails at first use. The template should validate on start.

### Email (Mailtrap)

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `Notifications:Email:Mailtrap:ApiToken` | consumer | Verified | High | `appsettings.json` empty; Compose `MAILTRAP_TOKEN` | `prd_consumer` | No |
| `Notifications:Email:Mailtrap:WebhookSigningSecret` | webapi (signature validator). The key also appears empty in Consumer `appsettings` without verified use | Verified | High | `appsettings.json` empty; Compose `MAILTRAP_WEBHOOK_SIGNING_SECRET` | `prd_webapi` | No |

- `FromAddress`/`FromName` are not secrets.
- Rotation: API tokens can overlap. Webhook signing-secret overlap is provider-defined and **unverified**; expect some webhooks to fail verification during the switch and rely on provider retries.

### Payments

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `Payments:Bachs:ApiKey` | Registered in webapi, consumer, jobs | Verified | Critical | `appsettings.json` (WebAPI) empty; not mapped in Compose | Each **confirmed** consumer's config | Provider-issued single key |
| `Payments:Bachs:WebhookSecret` | webapi (webhook receiver) | Verified | Critical | Same | `prd_webapi` | No |
| `Payments:Credo:SecretKey` | Registered in webapi, consumer, jobs | Verified (code only) | Critical | Options class only | Each confirmed consumer's config | Provider-issued single key |
| `Payments:Credo:PublicKey` | Same | Verified (code only) | Not secret (publishable) unless the provider says otherwise | Options class only | Configuration | — |
| `Payments:SafeHaven:ClientAssertion` | Registered in webapi, consumer, jobs | Verified (code only) | Critical | Options class only | Each confirmed consumer's config | Provider-issued |
| `Payments:SafeHaven:ClientId` | Same | Verified (code only) | High (paired identifier) | Options class only | Each confirmed consumer's config | Provider-issued |
| `Payments:SafeHaven:SettlementAccountNumber`, `AutoSweepAccountNumber`, `SettlementBankCode` | Same | Verified (code only) | Confidential config | Options class only | Each confirmed consumer's config | — |

- Registration in shared infrastructure (`AddPaymentServices`) does not by itself justify access. Before production, the application owner must confirm which services call each provider. Only those service configs receive the values.
- `ClientAssertion` is typically a signed assertion with its own expiry. Its lifetime and renewal must be confirmed with the provider (**unverified**).
- Rotation: provider dashboards. Overlap support is **unverified** for all three providers. Plan a maintenance window unless the provider confirms overlap.

### KYC and IP geolocation

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `Kyc:Kycaid:ApiKey` | webapi, jobs | Verified | High | `appsettings.json` empty (validated on start); not mapped in Compose | `prd_webapi`, `prd_jobs` | Provider-issued |
| `IpGeolocation:IpInfo:AccessToken` | webapi, jobs | Verified | Moderate | `appsettings.json` empty; not mapped | `prd_webapi`, `prd_jobs` | Provider-issued |
| `IpGeolocation:IpWhoIs:ApiKey` | webapi, jobs | Verified | Moderate | `appsettings.json` empty; not mapped | `prd_webapi`, `prd_jobs` | Provider-issued |

`IpGeolocation:IpApiCom` has only a `BaseUrl` and uses no credential. It is not secret.

### Telemetry and profiling

| Key | Consumers | Status | Sensitivity | Current storage | Proposed Doppler config | Shared today |
| --- | --- | --- | --- | --- | --- | --- |
| `OTEL_EXPORTER_OTLP_HEADERS` | webapi, consumer, jobs (read by the OpenTelemetry SDK from the process environment) | Verified | Moderate (ingestion credential) | Compose environment from `.env` | **Proposed:** `prd_otel-collector` only | Yes |
| `PYROSCOPE_BASIC_AUTH_USER`, `PYROSCOPE_BASIC_AUTH_PASSWORD` | webapi, consumer, jobs (native profiler, environment only) | Verified | Moderate | Compose environment from `.env` | **Proposed:** collector/agent config only | Yes |

- Proposed (Planned): services send telemetry without credentials to a host-local OpenTelemetry Collector (or Grafana Alloy) on a private Compose network. Only the collector holds the export credential. This removes a shared credential from three services and avoids the environment-variable exception.
- If profiling must authenticate directly from application containers, it is the only approved **environment-variable exception** ([delivery](vps-bootstrap.md#environment-variable-exception)).
- These names are already upper case, so they are stored in Doppler unchanged.

### Credentials found in runtime configuration that do not belong there

| Key | Finding | Disposition |
| --- | --- | --- |
| `GITHUB_USERNAME`, `GITHUB_PAT` | Correctly used as BuildKit secret mounts, but **also** passed as runtime environment to all four application containers in `docker-compose.yml` | Remove from runtime. They are CI/build credentials mapped by `docker-publish.yml` and never belong in Doppler runtime configs |
| ASP.NET Core Data Protection key ring | Not persisted; keys are per-container and ephemeral, but used for payment authorization protection | Application-managed key ring persisted to protected storage. Not a Doppler static secret |

### Backend configuration that stays out of Doppler

`Jwt:Issuer`, `Jwt:Audience`, `Jwt:LifetimeMinutes`, `Authentication:*` (including Google `ClientIds`, which are public OAuth client IDs; no client secret is used), `Authentication:Passkeys:*`, `Authentication:RefreshTokens:*`, `Authorization:AdministratorBootstrap:*` (`Enabled`, `UserId`), `RateLimiting:*`, object storage bucket and endpoint settings, `Messaging:RabbitMq` host/port/vhost/exchanges, `Kyc:Kycaid` URLs and form ID, `Payments:*` URLs and callback settings, `IpGeolocation:*:BaseUrl`, `OpenTelemetry:ServiceName`, `OpenTelemetry:OtlpEndpoint`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `PYROSCOPE_SERVER_ADDRESS`, `Database:InitializeOnStartup` (must be `false` in production), `Logging`, `AllowedHosts`.

These remain in application-owned `appsettings` or Compose files. Putting non-secret configuration in Doppler would widen what each token returns without adding protection.

## Per-service summary (backend)

What each service config holds after the recommended changes. Items marked ¹ apply only if the application owner confirms the consumer.

| Config | Keys |
| --- | --- |
| `<env>_webapi` | `PostgresWrite`, `PostgresRead`, `Redis`, `Jwt:SigningKey`, R2 key pair, Mailtrap webhook secret, Kycaid, IpInfo, IpWhoIs, Bachs webhook secret, payment provider keys ¹ |
| `<env>_consumer` | `PostgresWrite`, `PostgresRead`, `Redis`, RabbitMQ user/password, R2 key pair, Mailtrap API token, payment provider keys ¹ |
| `<env>_jobs` | `PostgresWrite`, `PostgresRead`, `Redis`, RabbitMQ user/password, Kycaid, IpInfo, IpWhoIs, payment provider keys ¹ |
| `<env>_database-migrator` | `PostgresWrite` (schema-owner credential) |
| `<env>_otel-collector` (planned) | Telemetry export credential(s) |

## Frontend inventory

**No sensitive runtime configuration exists in the frontend template today.** No Doppler project is required for it until a server-only secret is introduced.

| Configuration | Apps | Kind | Sensitivity | Current storage | Disposition |
| --- | --- | --- | --- | --- | --- |
| `API_BASE_URL` | all | Server runtime (`server-only`) | Not secret (private endpoint) | `.env.example`; runtime `process.env` | Compose environment (application-owned) |
| `TENANT_ID`, `APP_ENVIRONMENT`, `APPLICATION_NAME`, `APPLICATION_VERSION` | all | Server runtime | Not secret | Same | Compose environment |
| `ADMIN_REQUIRED_ROLE` | admin-portal | Server runtime | Not secret (policy) | Same | Compose environment |
| `NEXT_PUBLIC_*` (API base URL, tenant, environment, branding, site URLs, `NEXT_PUBLIC_GOOGLE_CLIENT_ID`) | all | Inlined into the browser bundle at build time | Public by definition | `.env.example`; build environment | Checked-in or build-time configuration. **Never** in Doppler runtime delivery and never a secret |
| Future server-only secrets (for example a session-encryption key or a server-to-server API credential) | user-portal, admin-portal (the BFF apps) | Planned | Depends | — | `example-frontend / <env>_user-portal` or `<env>_admin-portal` |

Notes:

- `user-portal`'s `server-env.ts` declares an empty server schema. `admin-portal`'s declares only `ADMIN_REQUIRED_ROLE`.
- `public-portal` has no route handlers, proxy, or server actions. It is not expected to need runtime secrets.
- The Dockerfiles declare no build arguments. Supplying `NEXT_PUBLIC_*` values at image build time is an image-publishing concern, not a secrets concern. Those values are public and must not be routed through Doppler runtime delivery.
- If a server-only secret is added, the Next.js server reads it from the delivered directory at startup through a small loader in `server-env.ts` (Planned template change). The secret does not need to enter the container environment ([Next.js server runtime](vps-bootstrap.md#nextjs-server-runtime)).

## Doppler service-token credentials

| Credential | Owner | Status | Sensitivity | Proposed storage | Rotation |
| --- | --- | --- | --- | --- | --- |
| Read-only service token, one per config per host | Secrets administrator | Planned | Critical for its config: it is a bearer credential that reads every secret in that config directly | Encrypted systemd credential on the host ([bootstrap](vps-bootstrap.md#installing-a-service-token)) | Every 90 days with a hard expiry, and on any incident ([runbook](rotation-and-revocation.md#doppler-service-token)) |

Unlike an exchange-based machine identity, a Doppler service token is not swapped for a short-lived access token. The bootstrap credential **is** the access credential. Its protection, scope, and expiry therefore determine exposure.

## Deployment credentials (outside Doppler runtime delivery)

These remain GitHub Environment secrets mapped explicitly to deployment workflows, as documented in [security.md](../security.md). They are listed here only to separate them from runtime secrets.

| Credential | Where | Notes |
| --- | --- | --- |
| SSH deploy key, host, user, known hosts | Protected GitHub Environment | Initiates deployment; not an application secret |
| Registry pull token | Protected GitHub Environment | Used on the VPS for image pulls during deploy |
| Registry push token, package-read token | Publish/CI jobs only | Never on the VPS at runtime |

## Rotation summary

| Integration | Per-service split possible | Overlap (zero-downtime) | Consumers to recreate |
| --- | --- | --- | --- |
| PostgreSQL | Yes (roles) | Yes, with alternating roles | Each affected service; migrator on next migration |
| Redis | Yes with ACLs | Yes with ACL dual passwords | webapi, consumer, jobs |
| RabbitMQ | Yes (users) | Via second user | consumer, jobs |
| Cloudflare R2 | Yes (tokens) | Yes | webapi, consumer |
| JWT signing key | Not applicable | Only after the planned template change | webapi |
| Mailtrap API token | Single consumer | Yes | consumer |
| Mailtrap webhook secret | Single consumer | Unverified | webapi |
| Payment providers | Provider-dependent | Unverified | Confirmed consumers only |
| Kycaid, IpInfo, IpWhoIs | Provider-dependent | Provider-dependent | webapi, jobs |
| Telemetry export | Collector only (proposed) | Yes | otel-collector |
| Doppler service token | One per config per host | Yes (several tokens per config) | None (used at the next render) |

Every duplicated value (the same provider key in several service configs) is updated in **every** listed config during rotation. The [rotation runbooks](rotation-and-revocation.md#duplicated-values) include a check that no config still holds the old value.
