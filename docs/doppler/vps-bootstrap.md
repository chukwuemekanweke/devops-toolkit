# VPS bootstrap and runtime secret delivery

Status: **Design (DEVOPS-006).** This is the specification that **DEVOPS-007** implements. Nothing here is implemented, and no real host has been configured. All names and values are placeholders.

Commands are illustrative. They must be re-validated against the pinned Doppler CLI and systemd versions during implementation. Where a flag or behavior is not confirmed by official documentation it is marked **unverified**.

## Host prerequisites

| Prerequisite | Requirement | Reason |
| --- | --- | --- |
| Linux distribution | systemd **≥ 250** (for example Ubuntu 24.04 or Debian 12) | `LoadCredentialEncrypted=` and `systemd-creds encrypt`. Older systemd uses the [plaintext fallback](#fallback-for-older-systemd) |
| Docker Engine + Compose v2 | Long-syntax bind mounts with `create_host_path: false` | A missing secret directory must fail container start, not create an empty directory |
| Retrieval client | Doppler CLI from Doppler's official package repository, version pinned and upgraded through change control, **or** a REST client (DEVOPS-007 decides; see [retrieval](#retrieval)) | Reproducible download behavior |
| Time synchronization | `systemd-timesyncd` or chrony | TLS validation and token expiry |
| Swap | Disabled or encrypted | Secrets in render-process memory must not persist on disk |
| Disk encryption | Recommended where the provider supports it | Protects persisted generations and credentials against offline disk access |

## Administrative versus automated actions

| Action | Who | Frequency | Automated? |
| --- | --- | --- | --- |
| Create project, environments, service configs; lock empty roots | Secrets administrator | Once per application | No |
| Issue read-only service token with expiry | Secrets administrator | Per service config per host, on rotation | No |
| Create Unix users, groups, directories, units, egress rules, backup exclusions | Server provisioning | Per host, per application environment | Provisioning automation may do this. It never handles tokens |
| Install a token on the host | Secrets administrator, interactive SSH session | Per token | **No.** Never through GitHub Actions or provisioning automation |
| Render, activate, discard generations | `runtime-secrets-*` systemd units, triggered by `vps-deploy` or an operator | Each deployment or rotation | Yes |
| Write and rotate secret values | Secrets administrator | Per rotation runbook | No |
| Revoke tokens | Secrets administrator | On rotation, decommission, or incident | No |

## Host layout

Short Unix names are used because user and group names are limited to 32 characters. Each application has a registered short alias (for example `exb` for `example-backend`), and long service names have a short alias (for example `migrator` for `database-migrator`).

| Path | Owner:group | Mode | Contents |
| --- | --- | --- | --- |
| `/etc/runtime-secrets/<app>/<env>/<service>.conf` | `root:root` | `0644` | Non-secret instance configuration ([below](#instance-configuration)) |
| `/etc/credstore.encrypted/rsec.<app>.<env>.<service>.token` | `root:root` | `0400` | Encrypted Doppler service token |
| `/etc/systemd/system/runtime-secrets-render@<app>:<env>:<service>.service.d/10-instance.conf` | `root:root` | `0644` | Per-instance drop-in: `User=`, credential, configuration path |
| `/var/lib/runtime-secrets/` | `root:root` | `0755` | Root of rendered secrets |
| `/var/lib/runtime-secrets/<app>/<env>/` | `rsec-<alias>-<env>` : same | `0700` | Per application environment, owned by its render user |
| `.../<service>/` | `rsec-<alias>-<env>` : `rsec-<alias>-<env>-<svc>` | `0750` | Per service |
| `.../<service>/gen-<utc-timestamp>-<random>/` | same | `0750` | One immutable generation |
| `.../<service>/gen-.../<KEY>` | same | `0440` | One secret value per file |
| `.../<service>/gen-....meta` | `rsec-<alias>-<env>` : same | `0600` | Non-secret metadata |
| `.../<service>/current`, `previous`, `pending` | symlinks | — | Generation pointers |

Example:

```text
/var/lib/runtime-secrets/example-backend/prd/          rsec-exb-prd  0700
├── webapi/                                           rsec-exb-prd:rsec-exb-prd-webapi 0750
│   ├── gen-20261121T120000Z-7f3a/                    0750
│   │   ├── CONNECTIONSTRINGS__POSTGRESWRITE          0440
│   │   ├── CONNECTIONSTRINGS__POSTGRESREAD           0440
│   │   └── JWT__SIGNINGKEY                           0440
│   ├── gen-20261121T120000Z-7f3a.meta                0600
│   ├── current -> gen-20261121T120000Z-7f3a
│   └── previous -> gen-20261101T090000Z-c210
├── consumer/ ...
└── jobs/ ...
```

Container processes run as non-root UIDs (`$APP_UID` 1654 in the .NET images, `node` 1000 in the Next.js images). Several services share a UID, so file permissions use a **per-service group**, added to the container with Compose `group_add`, rather than UID ownership. Docker (running as root) resolves the bind-mount source, so the container needs no traverse rights on parent directories.

### Unix identities

| Unix account | Purpose | Shell | Groups | Docker access |
| --- | --- | --- | --- | --- |
| `rsec-<alias>-<env>` (system user) | Runs render units for one application environment | `/usr/sbin/nologin` | Every `rsec-<alias>-<env>-<svc>` group | **No** |
| `rsec-<alias>-<env>-<svc>` (group only) | Grants read on one service's files | — | — | — |
| `deploy` (existing deployment account) | Triggers units through narrow sudo rules | Restricted | `docker` | Yes. Root-equivalent ([threat model](audit-and-threat-model.md#t12-compromised-github-actions-deployment-path)) |
| Administrators | Bootstrap and incident response | Login | `sudo` | Through sudo |

```sh
# Server provisioning (placeholders). Run once per application environment.
sudo useradd --system --no-create-home --shell /usr/sbin/nologin rsec-exb-prd
for svc in webapi consumer jobs migrator; do
  sudo groupadd --system "rsec-exb-prd-${svc}"
  sudo usermod --append --groups "rsec-exb-prd-${svc}" rsec-exb-prd
done
sudo install -d -o root -g root -m 0755 /var/lib/runtime-secrets
sudo install -d -o rsec-exb-prd -g rsec-exb-prd -m 0700 /var/lib/runtime-secrets/example-backend/prd
sudo install -d -o root -g root -m 0700 /etc/credstore.encrypted
```

## Instance configuration

Each render instance has a non-secret configuration file. The helper validates every field and rejects unknown keys.

```ini
# /etc/runtime-secrets/example-backend/prd/webapi.conf  (root:root 0644, no secret values)
RSEC_PROVIDER=doppler
RSEC_EXPECTED_PROJECT=example-backend
RSEC_EXPECTED_CONFIG=prd_webapi
RSEC_OUTPUT_DIR=/var/lib/runtime-secrets/example-backend/prd/webapi
RSEC_SERVICE_GROUP=rsec-exb-prd-webapi
RSEC_FORMAT=key-per-file
RSEC_KEYS_FILE=/srv/example-backend/production/secrets/webapi.keys
```

- `RSEC_EXPECTED_PROJECT` and `RSEC_EXPECTED_CONFIG` are **not** sent to Doppler; the token alone selects the config. They are compared with the built-in `DOPPLER_PROJECT` and `DOPPLER_CONFIG` values returned in the download, so a token installed in the wrong slot fails the render instead of delivering another service's secrets.
- `RSEC_KEYS_FILE` is **required**. It points to an **application-owned**, version-controlled key list deployed with the application's Compose files. It names every key the service may receive, each marked `required` or `optional`, and contains no values. Its exact format and schema are defined and versioned by DEVOPS-007. The key list is the host-side defense against [root-config inheritance leakage](architecture.md#isolation-analysis).

## Installing a service token

Performed by the secrets administrator in an interactive SSH session. The token is never placed on a command line, in shell history, in a file outside the credential store, in chat, in email, in a ticket, or in GitHub.

1. In Doppler, open project `example-backend`, config `prd_webapi`, and generate a service token named `vps01-20261121` with **read** access and an expiry of 120 days. Do not select write access. Keep the value in the administrator's password manager only until it is installed.
2. On the host:

```sh
# Interactive administrator session on vps01. Placeholders only.
sudo -v
IFS= read -rs RSEC_TOKEN          # paste; not echoed, not stored in history
printf '%s' "$RSEC_TOKEN" \
  | sudo systemd-creds encrypt --name=doppler-token - \
      /etc/credstore.encrypted/rsec.example-backend.prd.webapi.token
unset RSEC_TOKEN
sudo chmod 0400 /etc/credstore.encrypted/rsec.example-backend.prd.webapi.token
```

`printf` is a shell builtin, so the value never appears in a process argument list. `systemd-creds encrypt` uses the TPM2 when one is present and otherwise the host key in `/var/lib/systemd/credential.secret`. `--name` must match the credential name used by the unit.

3. Clear the clipboard. Delete the value from the password manager. The recovery path is to issue a new token, never to recover an old one.
4. Run a test render ([below](#render-procedure)) and discard the pending generation if no delivery is needed. Confirm the `.meta` key count and scope check.
5. Record the config, token name (not value), host, issue date, and expiry date in the change log.

Do **not** use `doppler configure set token --scope /`, even though Doppler recommends it for virtual machines. It stores the token in plaintext in the CLI configuration file of the user who runs it, outside the encrypted credential store, and applies it to every CLI invocation in that scope.

### Fallback for older systemd

With systemd older than 250, use `LoadCredential=doppler-token:/etc/credstore/rsec.<app>.<env>.<service>.token` with a `root:root 0400` plaintext file in `/etc/credstore` (mode `0700`). This loses encryption at rest. Record the exception and plan an operating-system upgrade.

## Systemd units

Three template units share one toolkit-owned helper (DEVOPS-007). Instances are named `<app>:<env>:<service>`.

| Unit | Credentials | Effect |
| --- | --- | --- |
| `runtime-secrets-render@.service` | Service token | Download, validate, write a new generation, point `pending` at it |
| `runtime-secrets-activate@.service` | None | Atomically set `previous` to the old `current` and `current` to `pending` |
| `runtime-secrets-discard@.service` | None | Remove a `pending` generation that was not activated, and prune old generations |

Illustrative render unit:

```ini
# /etc/systemd/system/runtime-secrets-render@.service
[Unit]
Description=Render runtime secrets for %i
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
# User=, Group=, LoadCredentialEncrypted=, EnvironmentFile= and ReadWritePaths= come from the drop-in.
ExecStart=/usr/local/libexec/devops-toolkit/runtime-secrets render %i
UMask=0077
RuntimeDirectory=runtime-secrets-render/%i
RuntimeDirectoryMode=0700
Environment=HOME=%t/runtime-secrets-render/%i
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
CapabilityBoundingSet=
SystemCallArchitectures=native
SystemCallFilter=@system-service
LimitCORE=0
TimeoutStartSec=120
```

```ini
# /etc/systemd/system/runtime-secrets-render@example-backend:prd:webapi.service.d/10-instance.conf
[Service]
User=rsec-exb-prd
Group=rsec-exb-prd
EnvironmentFile=/etc/runtime-secrets/example-backend/prd/webapi.conf
LoadCredentialEncrypted=doppler-token:/etc/credstore.encrypted/rsec.example-backend.prd.webapi.token
ReadWritePaths=/var/lib/runtime-secrets/example-backend/prd/webapi
```

systemd decrypts the credential into a private, per-run `$CREDENTIALS_DIRECTORY` readable only by the unit's user, and removes it when the run ends. `RuntimeDirectory=` gives the CLI a private, empty `HOME` on tmpfs that is deleted when the unit stops, so no Doppler CLI configuration or cache can persist. The render user never has standing read access to the encrypted file or to the host key.

## Retrieval

DEVOPS-007 chooses one client and pins it:

| Client | Command shape | Notes |
| --- | --- | --- |
| **Doppler CLI** (default) | `doppler secrets download --no-file --no-fallback --format json` with `DOPPLER_TOKEN` in the child environment | Documented path for service tokens. `--no-file` writes to stdout; `--no-fallback` disables reading and writing the encrypted fallback file (CLI source). By default the CLI writes a fallback file under `~/.doppler/fallback/`, so both flags are mandatory. The private tmpfs `HOME` is a second guard |
| REST API | `GET https://api.doppler.com/v3/configs/config/secrets/download?format=json` with the token in an `Authorization` header read from a file descriptor | No local caching behavior. The exact authorization header form must be confirmed (**unverified**). Never pass the token in the URL or as a command argument |

Never use `doppler run` (environment injection), `doppler run --mount`, `--fallback-only`/`--offline`, or a `--passphrase` that would make a fallback file portable.

## Render procedure

The sketch shows the security-relevant shape only. It is not the implementation.

```sh
# Sketch only. Runs as rsec-<alias>-<env> inside runtime-secrets-render@<app>:<env>:<service>.service.
set -euo pipefail                       # never set -x
umask 077
exec 9>"${RSEC_OUTPUT_DIR}/.lock" && flock -w 60 9

# Token is passed by environment to the CLI child only, never by argument.
DOPPLER_TOKEN="$(cat "${CREDENTIALS_DIRECTORY}/doppler-token")" \
  doppler secrets download --no-file --no-fallback --format json --silent \
  | runtime-secrets-write-generation \
      --output "${RSEC_OUTPUT_DIR}" --group "${RSEC_SERVICE_GROUP}" \
      --keys "${RSEC_KEYS_FILE}" \
      --expect-project "${RSEC_EXPECTED_PROJECT}" --expect-config "${RSEC_EXPECTED_CONFIG}"
```

Notes:

- `$(cat ...)` briefly places the token in the helper's memory and in the CLI child's environment, which only the same user and root can read. It never enters an argument list, which other local users can read through `/proc`.
- The download is piped straight into the writer. No intermediate file holds the payload.
- Retry at most twice with back-off, only on network or `5xx` errors. Never retry on `401`/`403`: those mean the token is revoked, expired, or mis-scoped.
- Whether `--silent` exists on the pinned CLI version is **unverified**; the requirement is that the CLI prints nothing except the payload.

### Generation writer requirements

The writer is a small toolkit-owned program with unit tests (language chosen by DEVOPS-007). It must:

1. Parse the payload with a real JSON parser. Reject duplicate keys, non-object payloads, non-string values, and anything it cannot parse.
2. **Verify scope.** Require the built-in `DOPPLER_PROJECT` and `DOPPLER_CONFIG` to equal the expected values. Then remove `DOPPLER_PROJECT`, `DOPPLER_ENVIRONMENT`, and `DOPPLER_CONFIG`. Reject any other key starting with `DOPPLER_`.
3. Validate every key against `^[A-Z_][A-Z0-9_]{0,199}$` (Doppler Classic naming). This rejects `/`, `.`, `..`, lower case, empty names, and leading dots, which prevents path traversal and hidden files.
4. **Enforce the key list.** Fail if any `required` key is missing. Fail if the payload contains a key that is not in the list (this catches values inherited from a non-empty root config, or written to the wrong config). Report only key **counts** and, for unexpected keys, the key **names**. Never values.
5. Reject empty values and values larger than 50 KiB (Doppler's per-value limit), unless the key list explicitly allows an empty value.
6. Create the generation with `mkdir` under the service directory (same filesystem, mode `0700` while writing). Refuse to continue if the service directory or any existing pointer is not owned by the render user, or is a symlink pointing outside the service directory.
7. Create each file with `O_CREAT | O_EXCL | O_NOFOLLOW`, write the exact bytes with no added trailing newline, `fsync`, then set mode `0440` and the service group.
8. `fsync` the generation directory, then set its mode to `0750`.
9. Write the `.meta` file (non-secret): generation ID, UTC time, project, config, token name if known, key count, key-list result, outcome.
10. Point `pending` at the generation by creating a temporary symlink and `rename(2)`-ing it over `pending`. This is atomic.
11. On any failure, remove the partial generation and leave `current` untouched. A trap removes temporary files on exit.
12. Log only sanitized lines: instance, generation ID, key count, duration, outcome. Never log values, never echo the payload, and never pass values to `logger`.

Activation (`runtime-secrets-activate`) replaces `previous` and `current` with the same atomic-rename technique.

## File format and naming

- **One file per key.** The file name is the Doppler secret name, which is the application's configuration key in upper case with `__` as the hierarchy separator. The contents are the raw value.
- **Fixed in-container path:** `/run/secrets/app`. The convention is the same for every service and application.
- Key-per-file is application-agnostic. The toolkit never interprets key names, beyond the character validation above.
- Application-owned Compose files may instead list individual files through Compose `secrets:` with `file:` sources pointing into `current`. On a single Docker host (not Swarm), Compose implements these as bind mounts, so the security properties are equivalent. The directory mount is preferred because it does not duplicate the key list in Compose.

## Temporary filesystem usage

| Location | Used for | Lifetime |
| --- | --- | --- |
| Process memory and pipes | Token and download payload | One render run |
| `$CREDENTIALS_DIRECTORY` (systemd, non-swappable ramfs) | Decrypted token | Removed when the unit stops |
| `RuntimeDirectory` under `/run` (tmpfs) | CLI `HOME`, so no CLI file reaches persistent disk | Removed when the unit stops |
| `PrivateTmp` | Any library temporary file | Removed when the unit stops |
| `/var/lib/runtime-secrets` (persistent, default) | Generations | Until pruned ([cleanup](#secret-file-cleanup)) |
| `/run/runtime-secrets` (tmpfs, hardened mode) | Generations | Until shutdown ([startup and reboot](#startup-and-reboot)) |

No secret value is written to a temporary file on persistent storage at any time.

## Compose integration

Application-owned production Compose file (illustrative):

```yaml
services:
  webapi:
    # The image is supplied by the deployment's generated digest override.
    group_add:
      - "<gid of rsec-exb-prd-webapi>"   # numeric GID recorded by provisioning
    volumes:
      - type: bind
        source: /var/lib/runtime-secrets/example-backend/prd/webapi/current
        target: /run/secrets/app
        read_only: true
        bind:
          create_host_path: false
    environment:                          # non-secret configuration only
      ASPNETCORE_ENVIRONMENT: Production
```

Rules:

- Each service mounts **only** its own service directory.
- Mounts are read-only with `create_host_path: false`.
- No secret value appears in `environment:`, `labels:`, `command:`, healthcheck commands, or `.env` files used for interpolation.
- No Doppler token appears anywhere in Compose.
- Use the numeric GID in `group_add`, unless the same group name exists inside the image.

## .NET configuration

All four backend deployables currently use default host-builder providers and have no file-based provider (Verified). The recommended template change is one registration per deployable:

```csharp
var builder = WebApplication.CreateBuilder(args);

// Toolkit runtime secrets convention: one file per configuration key, '__' as separator.
builder.Configuration.AddKeyPerFile(
    directoryPath: "/run/secrets/app",
    optional: true,          // absent in local development; required keys are validated at startup
    reloadOnChange: false);  // secrets change only through re-render and recreation
```

This uses `Microsoft.Extensions.Configuration.KeyPerFile`, whose default section delimiter is `__`. The file `CONNECTIONSTRINGS__POSTGRESWRITE` becomes the key `CONNECTIONSTRINGS:POSTGRESWRITE`. .NET configuration keys are case-insensitive, so it binds to `ConnectionStrings:PostgresWrite` and existing `IOptions` bindings are unchanged. This is the application's only integration point: **no Doppler SDK or client is added to any application layer.**

Resulting precedence (lowest to highest):

| Order | Source | Production use |
| --- | --- | --- |
| 1 | `appsettings.json` | Non-secret defaults. Secret keys present only as **empty** values |
| 2 | `appsettings.{Environment}.json` | Non-secret environment overrides |
| 3 | User secrets | Development only |
| 4 | Environment variables | Non-secret Compose configuration |
| 5 | Command-line arguments | Not used |
| 6 | Key-per-file `/run/secrets/app` | **Secrets.** Highest precedence, so a stray environment variable cannot override a delivered secret |

Template follow-ups (not part of this ticket): validate every required secret at startup (`ValidateOnStart`), remove hardcoded secret defaults, replace non-empty secret placeholders in `appsettings.json` with empty values, and remove `GITHUB_USERNAME`/`GITHUB_PAT` and the literal `Jwt__SigningKey` from Compose.

| Service | Mounted directory | Keys (see [inventory](secret-inventory.md#per-service-summary-backend)) |
| --- | --- | --- |
| WebAPI | `.../webapi/current` | Database, Redis, JWT, R2, Mailtrap webhook secret, KYC, geolocation, confirmed payment keys |
| Consumer | `.../consumer/current` | Database, Redis, RabbitMQ, R2, Mailtrap API token, confirmed payment keys |
| Jobs | `.../jobs/current` | Database, Redis, RabbitMQ, KYC, geolocation, confirmed payment keys |
| DatabaseMigrator | `.../database-migrator/current`, only during migration | Schema-owner connection string |

## Next.js server runtime

The frontend has no runtime secrets today. When a server-only secret is introduced, the application's `server-env.ts` (already `server-only`) reads `/run/secrets/app/<KEY>` files at server start and merges them into its validated server configuration. It does not copy them into `process.env`. Secrets must never use `NEXT_PUBLIC_*` names or Docker build arguments, and must never be passed to client components.

## Environment-variable exception

A consumer that can read configuration only from the process environment (today: the Pyroscope native profiler) may receive a dotenv-format file rendered by the same helper (`RSEC_FORMAT=dotenv`) and referenced by Compose `env_file`. This exception:

- requires a recorded risk acceptance naming the service and keys,
- exposes the values through `docker inspect`, the container's `/proc/<pid>/environ`, child processes, and the deploy account (Compose reads `env_file` as the invoking user),
- is preferably avoided by routing the data through a local collector that holds the credential ([inventory](secret-inventory.md#telemetry-and-profiling)).

## Lifecycle behavior

### Deployment ordering

```text
vps-deploy (GitHub Actions, no secret values)
  1. validate inputs and manifest; lock stack            (existing contract)
  2. stage release, pull image digests                   (existing contract)
  3. render every service that has secrets               -> pending generations
       failure: discard pending; deployment fails; nothing changed
  4. render + activate database-migrator only; run the one-shot migration;
     then remove the migrator generation                 (ephemeral migrator secrets)
       failure: deployment fails; no automatic reverse migration (existing contract)
  5. activate the remaining services
  6. docker compose up -d with the image override; force-recreate services whose
     generation changed
  7. health checks
       failure: restore previous images AND previous generations (both recorded)
  8. record deployment history: manifest hash plus generation IDs (never values)
  9. prune generations no longer referenced
```

Generation IDs, not values or hashes of values, are recorded. Hashing low-entropy secrets would allow offline guessing.

### Ephemeral migrator secrets

The schema-owner credential is the most dangerous runtime secret. It is rendered immediately before the migration run, mounted only into the one-shot migrator container, and its generation is deleted when the run ends, whether it succeeds or fails. It is never kept as `current` between deployments. This requires the template's migrator to exit after migrating ([template findings](architecture.md#template-findings-that-affect-adoption)).

### First-start behavior

| Situation | Behavior |
| --- | --- |
| No token installed for a service | Render fails before any network call; the deployment fails at step 3 |
| First render fails (network, auth, validation) | No `current` exists. Compose cannot create the bind mount (`create_host_path: false`), so the service **fails to start** rather than starting without secrets |
| Required key missing | Render fails; nothing is activated |
| Application starts but a secret is invalid | Application startup validation fails; the deployment health gate fails and restores the previous state |

A service never starts with an empty or partial secret directory.

### Last-known-good policy

- `current` is the last-known-good generation: it passed key-list validation and its deployment passed health checks.
- `previous` is kept for one-step restoration.
- A failed render never modifies `current`. Running containers keep working.
- The helper never falls back silently to an older generation, and never serves Doppler's own fallback file. Reusing `current` without a successful render is an explicit operator or deployment decision, recorded in the history ([provider outage](#provider-outage)).

### Startup and reboot

- **Persistent mode (default):** generations live under `/var/lib`. After a reboot, Docker restart policies start containers with their last-known-good `current` generation. Boot does not depend on Doppler being available.
- **Hardened tmpfs mode (optional):** generations live under `/run/runtime-secrets` and disappear at shutdown. Stacks must then be started by a systemd unit ordered after successful renders, not by Docker restart policies, and a Doppler outage at boot prevents the stack from starting. Choose this only where the confidentiality of data at rest outweighs availability.

### Restart requirements

Running containers keep the generation they were created with, because Docker resolves the `current` symlink when it creates the mount. Applications load configuration once (`reloadOnChange: false`). A new generation takes effect only when the service is recreated with `docker compose up -d --force-recreate --no-deps <service>`. A plain `restart` is not relied upon to re-resolve the mount.

### Rollback behavior

| Situation | Images | Secret generation |
| --- | --- | --- |
| `vps-deploy` health failure with automatic restoration | Previous digests | Previous generations restored, because they were part of the failed change set |
| `vps-rollback` to an older release | Target digests | **Current** generation kept. Secrets are environment state, and older generations may contain revoked credentials. If the older release needs a key that no longer exists, rollback health fails and the operator decides |
| Bad value written to Doppler | Unchanged | Re-activate `previous` and recreate the service, or fix the value in Doppler (config-log rollback) and re-render |

### Provider outage

| Situation | Effect | Response |
| --- | --- | --- |
| Doppler unavailable during deployment | Render fails at step 3; deployment fails before migration or restarts; running services are unaffected | Retry after recovery. A future "reuse current generations" deployment mode may be added by the deploy ticket, but it must be explicit, approved, and recorded |
| Doppler unavailable at reboot (persistent mode) | None | — |
| Doppler unavailable during an emergency rotation | New values cannot be delivered | Contain at the provider first (revoke or disable the exposed credential), accept degradation, deliver when Doppler recovers. Never hand-place secret files outside the helper |
| Rate limited (`429`) | Render fails after bounded retries | Retry later; investigate unexpected request volume |

### Token expiry and revocation

| Situation | Effect | Response |
| --- | --- | --- |
| Token expired (Doppler deletes it) | Render fails with an authentication error; running containers unaffected | Issue and install a new token; the monthly review should prevent this |
| Token revoked | Same | Expected during rotation or incident response. Install the replacement |
| Token installed in the wrong slot | Scope check fails (`DOPPLER_CONFIG` mismatch); nothing written | Reinstall the correct token |

### Secret-file cleanup

- **Pruning** keeps `current`, `previous`, and at most one older generation. It runs only after the deploy step has recreated affected services, because deleting files on the host also removes them from a running container's bind mount. The render user has no Docker access, so pruning is driven by the deploy step.
- **Discarded** pending generations are deleted immediately.
- **Migrator** generations are deleted after every migration run.
- **Deletion** uses ordinary unlink. Overwriting files before deletion is not reliable on journaling or copy-on-write filesystems and is not required. Disk encryption is the control for data at rest.
- **Decommissioning** removes the whole application-environment directory, the tokens, and the units ([below](#reinitialization-and-decommissioning)).

### Rotation

Rotation is: write the new value in Doppler, then for each consuming service run render → activate → recreate → verify health. Revoke the old value at the provider afterwards. Procedures are in [rotation and revocation](rotation-and-revocation.md).

## Deployment trigger without secret access

The deploy account may only start the instances for the stacks and environments it deploys:

```text
# /etc/sudoers.d/rsec-deploy-example-backend  (illustrative; validate with visudo -c)
# Enumerate exact instances. Sudoers argument wildcards also match spaces.
Cmnd_Alias RSEC_EXB_PRD = \
  /usr/bin/systemctl start runtime-secrets-render@example-backend\:prd\:webapi.service, \
  /usr/bin/systemctl start runtime-secrets-activate@example-backend\:prd\:webapi.service, \
  /usr/bin/systemctl start runtime-secrets-discard@example-backend\:prd\:webapi.service
  # ...one line per action and service, generated by provisioning
deploy ALL=(root) NOPASSWD: RSEC_EXB_PRD
```

The deploy step reads only unit exit status and sanitized `.meta` fields. It never reads generation contents or tokens. Because the deploy account is in the `docker` group, this separation guards against mistakes and log leakage. It is not a security boundary against a malicious deploy account. DEVOPS-008 should evaluate an SSH forced command that limits the deploy key to the toolkit's deployment entry point.

## Logs

- Unit output goes to journald and contains only sanitized lines. The payload is piped into the writer, never to the unit's standard output.
- Never enable shell tracing in the helper, or debug or verbose output in the CLI, on a production host.
- `LimitCORE=0` and disabled or encrypted swap keep values out of core dumps and swap.
- Deployment logs and artifacts in GitHub Actions contain only unit names, generation IDs, key counts, and outcomes.

## Backups

Exclude from every host backup and snapshot policy:

- `/var/lib/runtime-secrets/` (and `/run/runtime-secrets/` in hardened mode)
- `/etc/credstore.encrypted/` and `/etc/credstore/`
- `/var/lib/systemd/credential.secret`

Doppler is the system of record for values. Restoring a host never restores tokens: a restored or cloned host gets new tokens. Provider whole-disk snapshots cannot exclude paths. If they are used, treat snapshot access as secret access and delete snapshots under a retention policy.

## Host-root compromise

Root on the host, and any account with Docker access, can decrypt every installed token (systemd host key or TPM), read every generation, and read container memory. Because Doppler service tokens have no IP restriction on the Developer plan, a stolen token can be used **from anywhere** until it is revoked or expires. Per-service tokens limit what one leaked token exposes, but not what a root compromise exposes. The response is the [compromised VPS runbook](rotation-and-revocation.md#compromised-vps): revoke every token on the host, rotate every secret delivered to it, and rebuild.

## Reinitialization and decommissioning

| Scenario | Procedure |
| --- | --- |
| Replace or rebuild a host | Treat it as a new host: issue new tokens named for the new host, install, deploy, verify, cut over. Then revoke the old host's tokens and destroy its disks and snapshots |
| Reinstall the operating system | Same as a new host. Never reuse an old token, even if it was recovered |
| Move an application to another host | New tokens on the target. Revoke the source host's tokens for that application after cut-over |
| Decommission an application environment | Stop the stack; revoke its tokens; remove units, drop-ins, credentials, generations, users, and groups; archive evidence; optionally delete the configs' values after the retention period |
| Lost control of a host | Follow [compromised VPS](rotation-and-revocation.md#compromised-vps) |

## Recovery checklist for a failed render

1. `systemctl status runtime-secrets-render@<app>:<env>:<service>.service` and `journalctl -u ...`: read the sanitized reason.
2. Authentication failure (`401`/`403`): check token expiry and whether it was revoked. Do not retry in a loop.
3. Scope failure: the installed token belongs to another config. Reinstall.
4. Key-list failure: compare the config's key names with the application's key list. Check that the environment root is still empty. Fix through review.
5. Network failure: check DNS, egress rules, and Doppler status.
6. Re-run the render. Confirm the `.meta` key count. Activate and recreate only as part of a deployment or rotation.
