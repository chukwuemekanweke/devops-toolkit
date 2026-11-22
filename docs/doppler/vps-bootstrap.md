# VPS runtime-secret delivery

Status: **Implemented host primitive (DEVOPS-007), orchestrated by `vps-deploy.yml` (DEVOPS-009).** This
covers the toolkit helper and the contract that deployment consumes; deployment ordering and the stack boot
unit are in [VPS deployment operations](../vps-deployment.md#runtime-secrets-devops-007-integration). It does
not implement application changes (DEVOPS-008) or provisioning automation (DEVOPS-010).

## Data flow and boundaries

```text
Doppler Cloud -> Doppler CLI 3.77.0 -> strict validation
  -> /run/runtime-secrets/<application>/<environment>/<service>/gen-*
  -> atomic pending/current/previous pointers
  -> read-only Compose mount at /run/secrets/app
```

The service token exists only as an encrypted systemd credential and in the short-lived Doppler child
environment. It is never placed in Compose, a container, an argument, a GitHub workflow, an image, or a
generation. The helper never invokes `doppler run`, configures a CLI token store, or writes download JSON
to a file.

The default and supported root is the tmpfs mount `/run/runtime-secrets`. Plaintext generations do not
survive reboot. Persistent storage is outside the default contract and requires a recorded security
exception covering encryption keys, snapshots, backups and secure deletion.

## Supported hosts and pinned dependencies

- Ubuntu 24.04 (systemd 255) and Debian 12 (systemd 252).
- Node.js 22 and Docker Engine with Compose v2.
- Doppler CLI **3.77.0** at `/usr/local/bin/doppler`, installed from a signed release asset. Verify the
  signature and platform digest from Doppler's `checksums.txt`; do not use a floating version.

The adapter executes exactly:

```text
doppler secrets download --no-file --no-fallback --format json
```

`--no-file` sends JSON to stdout and `--no-fallback` prevents fallback reads/writes. The token is supplied
only as `DOPPLER_TOKEN` in the child environment. stdout is bounded and parsed in memory; provider stderr
is used only for failure classification and is never relayed.

## Versioned configuration contracts

Both schemas reject unknown fields:

- [`runtime-secrets-instance.schema.json`](../schemas/runtime-secrets-instance.schema.json)
- [`runtime-secrets-key-manifest.schema.json`](../schemas/runtime-secrets-key-manifest.schema.json)

The root-owned instance declares version `1`, identities, expected Doppler project/config, exact output,
numeric service group, absolute key-manifest path and bounded operational settings. Output must be exactly
`/run/runtime-secrets/<application>/<environment>/<service>`; traversal and arbitrary paths are rejected.

The application-owned key manifest contains no values:

```json
{
  "version": 1,
  "secrets": [
    { "name": "CONNECTIONSTRINGS__POSTGRESWRITE", "required": true, "allowEmpty": false, "maxBytes": 4096 }
  ]
}
```

Names use Doppler Classic uppercase naming and may use `__` for nesting. `DOPPLER_*` is reserved. Duplicate
names/properties, non-string values, missing required keys, disallowed empty values, oversized values,
unknown keys and unexpected metadata fail the complete render. `DOPPLER_PROJECT` and `DOPPLER_CONFIG`
must match the instance. `DOPPLER_ENVIRONMENT` is removed; other returned `DOPPLER_*` keys are rejected.

## Filesystem and generation model

Each service directory is `0700`, owned by its render identity. A complete generation is `0550`; secret
files and `.metadata.json` are `0440`, owned by the render user and service numeric group. Values are
created exclusively with no-follow flags and contain exact UTF-8 bytes without an added newline. Metadata
contains identity, time, provider scope and key count only—never values or value hashes.

```text
/run/runtime-secrets/example-backend/prd/webapi/
  gen-20261121T120000Z-7f3a19c0/
    CONNECTIONSTRINGS__POSTGRESWRITE
    .metadata.json
  current  -> gen-...
  previous -> gen-...
  pending  -> gen-...
```

Operations serialize through an exclusive per-service lock. Existing path components and generations may
not be symlinks. Pointer targets are single valid `gen-*` names. A complete generation is flushed and
permissioned before same-filesystem atomic rename publishes `pending`; failure removes the incomplete
directory and never changes `current`.

## CLI contract

`/opt/runtime-secrets/scripts/runtime-secrets.mjs` emits one non-secret JSON result:

```text
runtime-secrets render   --instance /etc/runtime-secrets/instances/<id>.json
runtime-secrets activate --instance /etc/runtime-secrets/instances/<id>.json
runtime-secrets discard  --instance /etc/runtime-secrets/instances/<id>.json
runtime-secrets restore  --instance /etc/runtime-secrets/instances/<id>.json
runtime-secrets prune    --instance /etc/runtime-secrets/instances/<id>.json --eligible gen-...
runtime-secrets status   --instance /etc/runtime-secrets/instances/<id>.json
```

| Exit | Stable category |
| ---: | --- |
| 0 | success |
| 2 | usage |
| 10 | configuration |
| 20 | authentication |
| 21 | provider |
| 30 | validation/scope |
| 40 | filesystem |
| 41 | conflict |

`render` stages `pending` and never activates. `activate` retains former `current` as `previous` and does
not assert application health. `discard` removes only the pending pointer and retains the immutable files
until a later proven-safe prune. `restore` swaps current and previous without Doppler. `prune` accepts
explicitly named eligible generations and refuses pointer targets.
Future deployment code supplies eligibility only after proving no live container bind-mounts the generation.
The helper has no Docker access and deliberately does not guess.

## Failure semantics

Authentication/authorization/scope/validation failures do not retry. Network failures, timeouts, 429 and
502/503/504-class failures receive bounded exponential retries. Errors never contain provider stderr,
payloads, values or hashes.

- First startup failure creates no `current`; the application cannot start.
- Refresh failure leaves `current` and running containers untouched.
- Success creates only `pending`; there is no implicit stale or Doppler fallback mode.

## Installation and one-service setup

From a reviewed immutable checkout:

```bash
sudo bash ./scripts/install-runtime-secrets.sh "$PWD"
sudo install -d -o root -g root -m 0755 /etc/runtime-secrets/{instances,manifests}
sudo install -o root -g root -m 0644 app.keys.json /etc/runtime-secrets/manifests/app-webapi.json
sudo install -o root -g root -m 0644 host.instance.json /etc/runtime-secrets/instances/exb-prd-api.json
```

Create a short non-login render identity and the numeric group in the instance. It must not be in `docker`.
Keep application/environment parents root-owned so the render user cannot replace path components; only
the exact service directory is writable:

```bash
sudo groupadd --gid 21001 rsec-exb-prd-api
sudo useradd --system --no-create-home --shell /usr/sbin/nologin --gid 21001 rsec-exb-prd-api
sudo install -d -o root -g root -m 0711 /run/runtime-secrets/example-backend/prd
sudo install -d -o rsec-exb-prd-api -g rsec-exb-prd-api -m 0700 /run/runtime-secrets/example-backend/prd/webapi
```

Because these directories are also lost with tmpfs, install an equivalent root-owned `tmpfiles.d` entry
from [`runtime-secrets-instance.tmpfiles.example`](../../systemd/runtime-secrets-instance.tmpfiles.example).
Test it with `systemd-tmpfiles --create <file>`; do not make application/environment parents writable by a
render identity.

For render, activate, discard and restore, add a per-instance drop-in that resets the broad base grant:

```ini
# /etc/systemd/system/runtime-secrets-render@exb-prd-api.service.d/paths.conf
[Service]
ReadWritePaths=
ReadWritePaths=/run/runtime-secrets/example-backend/prd/webapi
```

The `0700` application/environment hierarchy and distinct numeric groups remain mandatory cross-service
boundaries.

### Install or replace a token

Issue one read-only expiring token on exactly the expected branch config. In a private root terminal:

```bash
sudo install -d -o root -g root -m 0700 /etc/credstore.encrypted
sudo systemd-ask-password --no-tty "Doppler token for exb-prd-api" |
  sudo systemd-creds encrypt --name=doppler-token - \
    /etc/credstore.encrypted/runtime-secrets-exb-prd-api.token
sudo chmod 0400 /etc/credstore.encrypted/runtime-secrets-exb-prd-api.token
```

The value never enters history, a file, an argument or cloud-init. `LoadCredentialEncrypted=` decrypts it
into the unit's private credential directory. Exclude the systemd host key and runtime tree from backups.
For rotation, encrypt to a root-only temporary name, atomically replace the blob, test render, then revoke
the old token.

### Operate the lifecycle

```bash
sudo systemctl start runtime-secrets-render@exb-prd-api.service
# status verifies the service directory belongs to the caller, so run it as the render identity
sudo runuser -u rsec-exb-prd-api -- /usr/bin/node /opt/runtime-secrets/scripts/runtime-secrets.mjs status \
  --instance /etc/runtime-secrets/instances/exb-prd-api.json
sudo systemctl start runtime-secrets-activate@exb-prd-api.service
sudo systemctl start runtime-secrets-discard@exb-prd-api.service
sudo systemctl start runtime-secrets-restore@exb-prd-api.service
```

Use discard only for a rejected pending generation. After restore, recreate and health-check the container.

## Boot ordering and outage recovery

`run-runtime\x2dsecrets.mount` creates a `nodev,nosuid,noexec` tmpfs before Docker. One
`runtime-secrets-initialize@<id>.service` runs per boot-time secret-bearing service. The application stack
unit (`vps-deploy-stack@<stack>.service`) declares `Requires=` and `After=` on every initializer through
a generated drop-in, which pulls the initializers into the boot transaction. The initializer units have no
`[Install]` section and are not enabled directly. Secret-bearing Compose services use `restart: "no"` so
Docker cannot bypass initialization.

```bash
sudo systemctl enable 'run-runtime\x2dsecrets.mount'
sudo systemctl enable vps-deploy-stack@example-backend-production.service   # after installing its boot drop-in
```

The Node.js units run with `--jitless` so `MemoryDenyWriteExecute=yes` can stay enabled. The render unit
re-allows `@chown` after denying `@privileged`, because generation files are chowned to the service group.

The mount is enabled so it exists before `systemd-tmpfiles-setup.service` recreates the root-owned parent
and service leaf directories. The initializer is ordered after both.

Boot waits for network, then renders and activates. Only then may the stack start. Missing token, unavailable
Doppler, invalid credentials or payload leaves it stopped. No last-known-good plaintext survives default
tmpfs shutdown. Recover by restoring provider/token access, restarting initializers, then starting the stack;
never create an empty `current`.

During an ordinary refresh outage, the already running container keeps its old bind mount and `current`
does not change. This availability property lasts only while the host remains running.

## Compose and recreation contract

[`examples/runtime-secrets/compose.yaml`](../../examples/runtime-secrets/compose.yaml) uses a non-root user,
numeric supplemental service group, read-only bind at `/run/secrets/app`, and `create_host_path: false`.
There is no Docker socket, token, Doppler binary or secret-valued environment variable in the container.

Docker resolves `current` when creating the bind mount. Pointer replacement does not retarget an existing
container. Activation therefore requires container **recreation** followed by application health validation;
plain restart is not the contract, and activation is not a health verdict.

## Adding, troubleshooting and decommissioning

To add a service, create a distinct config/token, manifest, group/render user, instance, credential and
exact-path drop-ins; enable its initializer; mount only its `current`. During provider outage do not enable
fallback or copy values to disk. Running services keep current; boot fails closed. Replace expired/revoked
tokens and rerun render.

To decommission: stop/remove containers; disable units; revoke the token; remove encrypted credential and
root-owned configuration; prove no bind mount remains; then remove the tmpfs service tree and identity.
Never remove a generation merely because a pointer no longer names it.

## Validation

```bash
npm run test:runtime-secrets:linux
npm run validate:systemd
sudo bash ./tests/integration/runtime-secrets-linux.sh
```

The privileged harness fails when Docker is unavailable. It checks real modes, static systemd validity,
absence of values/token markers from `docker inspect`, and recreation semantics. Live Doppler authorization,
multi-identity systemd execution and reboot require a disposable VPS/VM and synthetic non-production token;
simulated scope-denial tests are not evidence of provider-side authorization.
