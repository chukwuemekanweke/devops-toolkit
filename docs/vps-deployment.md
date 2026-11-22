# VPS deployment operations

Status: **Implemented (DEVOPS-009).** This guide covers preparing a Linux VPS for `vps-deploy.yml`, the host-side execution interface, application-owned Compose requirements, health and restoration behavior, and recovery. The public workflow interface is in [workflow-contracts.md](workflow-contracts.md#vps-deployyml); runtime-secret delivery is DEVOPS-007 ([VPS runtime-secret delivery](doppler/vps-bootstrap.md)).

Initial scope: one VPS, one deployment environment, several independent application stacks, Docker Compose, Docker Hub. Nothing in the engine names an environment, host, application, or path; separate Development/Staging/Production hosts later need only their own registries, credentials, and GitHub Environments.

## Lifecycle

```text
GitHub Actions (protected Environment)          VPS (root-owned helper, one stack lock)
-------------------------------------          -----------------------------------------
validate inputs, manifest, Compose paths  ->   validate again against /etc/vps-deploy/stacks/<stack>.json
send one JSON request over SSH stdin      ->   lock -> stage release -> compose config + policy
  (pinned host key, stack-bound key)           pull every image by digest (temporary pull credential)
                                               render pending runtime-secret generations (DEVOPS-007)
                                               run one-shot migration (optional; exit 0 required)
                                               activate generations -> compose up (recreate changed)
                                               verify service state + HTTP checks
record outputs + sanitized audit artifact <-   commit active release + append history | restore on failure
```

Failures before rollout (validation, staging, pull, Compose policy, secret rendering, migration) leave running containers, `current` secret generations, and the active release record untouched. Failures after rollout (activation, `compose up`, health) trigger restoration when `rollback-on-health-failure` is true and a previous release exists. The job always fails unless the new release passed health verification.

## Trust model and the constrained host interface

Docker access is root-equivalent, so the deploy identity is **not** placed in the `docker` group. Instead:

1. The SSH account `vps-deploy` authenticates with one key per application. Each `authorized_keys` line uses `restrict` and a forced command that binds the key to exactly one stack:
   `restrict,command="/opt/vps-deploy/bin/vps-deploy-ssh example-backend-production" ssh-ed25519 AAAA… deploy-example-backend`
2. The forced command accepts only the fixed operation `deploy` (no client-supplied text reaches a shell) and runs `sudo -n /usr/bin/node /opt/vps-deploy/scripts/vps-deploy-host.mjs deploy --stack <bound-stack>`.
3. sudoers permits exactly that command line per stack ([`systemd/vps-deploy-operator.sudoers`](../systemd/vps-deploy-operator.sudoers)); nothing else runs as root.
4. The root helper reads one bounded JSON request from stdin, re-validates everything, and requires it to agree with the root-owned **host stack registry** for the bound stack. A request can never widen what the registry authorizes.
5. Before any container changes, the helper rejects Compose constructs that escape the stack boundary (see [Compose policy](#compose-ownership-and-policy)).

A key from the frontend repository therefore cannot deploy the backend stack, cannot run arbitrary commands, cannot reach the Docker socket, and cannot reference host files outside the registry's allowlist. **Residual risk:** whoever controls an authorized deploy key and the GitHub Environment can deploy any image from the registry-approved namespaces to that stack, and application containers can read their own secrets. Host root compromise still exposes every stack ([threat model](doppler/audit-and-threat-model.md)).

## Initial VPS preparation

Prerequisites (server provisioning, not CI/CD): Ubuntu 24.04 or Debian 12, Docker Engine with the Compose v2 plugin, Node.js 22 at `/usr/bin/node`, `sudo`, OpenSSH, firewall rules, backups excluding `/run/runtime-secrets`, and—for stacks with runtime secrets—the DEVOPS-007 helper and units installed and provisioned per [vps-bootstrap.md](doppler/vps-bootstrap.md).

### Install the helper

From a reviewed immutable toolkit checkout:

```bash
sudo bash ./scripts/install-vps-deploy.sh "$PWD"
```

This installs `/opt/vps-deploy` (helper, its runtime dependencies, the forced-command wrapper), creates `/etc/vps-deploy/stacks`, and installs `vps-deploy-stack@.service`.

### Create the deploy account (once per host)

```bash
sudo useradd --create-home --shell /bin/sh vps-deploy   # a shell is required to execute the forced command
sudo usermod -p '*' vps-deploy                          # no password; key authentication only
sudo install -d -o vps-deploy -g vps-deploy -m 0700 /home/vps-deploy/.ssh
```

Do not add `vps-deploy` to `docker` or any group with access to `/run/runtime-secrets`. Harden sshd:

```text
Match User vps-deploy
    AuthenticationMethods publickey
    PasswordAuthentication no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTTY no
```

Record the host key fingerprint out of band (for example from the provider console) and store `[host]:port` entries in the GitHub Environment secret `ssh-known-hosts`. Never populate it with `ssh-keyscan` over an untrusted network.

### Register each stack

1. **Deployment root** (dedicated per application/environment, root-owned):
   `sudo install -d -o root -g root -m 0750 /srv/example-backend/production`
2. **Host stack registry** `/etc/vps-deploy/stacks/<stack>.json` (root-owned, `0644`), validated by [vps-deploy-stack.schema.json](schemas/vps-deploy-stack.schema.json). Examples: [backend](../examples/dotnet/vps-deploy-stack.json), [frontend](../examples/nextjs/vps-deploy-stack.json).

   | Field | Meaning |
   | --- | --- |
   | `stackName`, `environment`, `deploymentPath` | Must equal the workflow's `stack-name`, `environment`, and `remote-deployment-path` |
   | `allowedSourceRepositories` | Repositories whose manifests may deploy here (provenance) |
   | `allowedImageRepositories` | `docker.io` namespaces (ending in `/`) or exact repositories that release components may use |
   | `runtimeSecrets.services` | Compose service → DEVOPS-007 instance id; `startAtBoot: false` for services not started at boot (the migrator) |
   | `publicPorts` | Host ports that may be published on non-loopback interfaces (default: none) |
   | `allowedBindSources` | Read-only host directories that services may bind (default: none) |
   | `allowedExternalNetworks`, `allowedExternalVolumes` | Pre-existing networks/volumes a stack may join (for example a shared reverse-proxy network) |
   | `allowedCapabilities` | Extra Linux capabilities (dangerous ones are refused) |
   | `healthCheckHosts` | Hosts HTTP checks may target (default loopback only) |
   | `lockTimeoutSeconds` | How long a deployment waits for the stack lock (default 1800) |

   The helper refuses registries whose deployment paths overlap, whose runtime-secret instances are shared, or that point at reserved system locations.
3. **Optional `stack.env`** in the deployment root (root-owned, not group/world writable): non-secret Compose interpolation values that are host-specific, such as runtime-secret group IDs or `APP_UID`. It is passed with `--env-file`; no other environment reaches Compose. Never put secret values in it.
4. **sudoers**: one line per stack from [`vps-deploy-operator.sudoers`](../systemd/vps-deploy-operator.sudoers), checked with `visudo -cf`.
5. **authorized_keys**: one `restrict,command="/opt/vps-deploy/bin/vps-deploy-ssh <stack>"` line per application deploy key.
6. **Runtime secrets** (stacks that declare them): provision one DEVOPS-007 instance, render identity, numeric group, tmpfiles entry, encrypted credential, and exact-path drop-ins per secret-bearing service ([vps-bootstrap.md](doppler/vps-bootstrap.md#installation-and-one-service-setup)). The instance `service` must equal the Compose service name.
7. **Boot integration**:

   ```bash
   sudo install -d /etc/systemd/system/vps-deploy-stack@example-backend-production.service.d
   sudo node /opt/vps-deploy/scripts/vps-deploy-host.mjs boot-dropin --stack example-backend-production \
     | sudo tee /etc/systemd/system/vps-deploy-stack@example-backend-production.service.d/runtime-secrets.conf
   sudo systemctl daemon-reload
   sudo systemctl enable 'run-runtime\x2dsecrets.mount' vps-deploy-stack@example-backend-production.service
   ```

   The generated drop-in declares `Requires=` and `After=` on `runtime-secrets-initialize@<instance>.service` for every boot-time secret service. Enabling the stack unit pulls the initializers into the boot transaction; the initializer units have no `[Install]` section and are not enabled directly.

### Reverse proxy

A shared reverse proxy (TLS termination, domains) is an **infrastructure prerequisite** with its own lifecycle and owner; the toolkit does not install or reconfigure it. Recommended: application services publish only on `127.0.0.1` and the proxy forwards to those ports, or the proxy and stacks join a pre-created external network listed in each registry's `allowedExternalNetworks`.

## Required credentials

Store these as secrets of the protected GitHub Environment (required reviewers, restricted deployment branches/tags) and map them explicitly; never use `secrets: inherit`.

| Secret | Content |
| --- | --- |
| `ssh-host` | VPS hostname or IP |
| `ssh-user` | `vps-deploy` |
| `ssh-private-key` | The application's dedicated deploy key (bound to one stack on the host) |
| `ssh-known-hosts` | Pinned host key line(s) for the host and port; wildcards are rejected |
| `registry-username`, `registry-token` | Docker Hub **read-only** access token for pulls |

The pull token travels only inside the SSH stdin request and is written to a private temporary Docker client configuration under `/run` for the duration of the operation; it never appears in process arguments, environment variables, root's persistent Docker configuration, history, or artifacts. No Doppler token or application secret value is a workflow input.

## Compose ownership and policy

The application repository owns its Compose files (for example `deploy/compose.production.yml`). The toolkit transfers only the files listed in `compose-files`, adds a generated image override (release components → `image@sha256:…`) and a runtime-generation label override, and runs Compose with `--project-name <stack-name>` so stacks never share a project.

Recommended structure: see the [backend](../examples/dotnet/compose.production.yml) and [frontend](../examples/nextjs/compose.production.yml) references.

The host rejects, before any container changes:

- `include`, `env_file`, `extends.file`, and file-backed top-level `configs`/`secrets` (only transferred files define the stack);
- release-component images that do not resolve to the manifest digest, and any other image not pinned by `@sha256:` digest;
- `privileged`, host or foreign-container `network_mode`/`pid`/`ipc`/`uts`/`userns_mode`/`cgroup`, `devices`, `volumes_from`, `external_links`, `container_name`, `cgroup_parent`, disabled seccomp/AppArmor/SELinux profiles, and capabilities not allowed by the registry;
- bind mounts other than a service's own runtime-secret generation or registry-approved read-only directories (the Docker socket is always refused), named volumes with `driver_opts`, and external networks/volumes not allowed by the registry;
- ports published on non-loopback interfaces unless listed in `publicPorts`;
- release-component and secret-bearing services whose effective user (Compose `user` or image `USER`) is root.

Secret-bearing services (registry `runtimeSecrets.services`) must mount exactly their own `/run/runtime-secrets/<application>/<environment>/<service>/current` at `/run/secrets/app` with `read_only: true` and `bind.create_host_path: false`, use `restart: "no"`, and set `no-new-privileges:true`. Further recommendations: private networks, persistent named volumes, `read_only: true` root filesystems with `tmpfs` scratch space, health checks, and `depends_on` with `condition: service_healthy` for infrastructure ordering. Do not publish database, Redis, RabbitMQ, or worker ports.

## Runtime secrets (DEVOPS-007 integration)

The helper never contacts Doppler. For every registered secret-bearing service it uses the documented DEVOPS-007 interface: `systemctl start runtime-secrets-{render,activate,discard,restore}@<instance>.service` and `runtime-secrets status|prune` run as the instance's render identity.

1. A stale `pending` from an interrupted earlier operation is discarded (recorded in history).
2. Every service is rendered to `pending` **before** migration or rollout. Any failure (for example a missing required key, an authorization failure, or a Doppler outage) discards the generations rendered so far and stops; running services keep their mounts.
3. The migrator's generation is activated only for the migration run.
4. After a successful migration the remaining generations are activated, and the generation ids are written as container labels. Changed labels make Compose **recreate** exactly the affected containers; a plain restart is never relied upon.
5. On rollout failure, `restore` swaps each activated service back to its previous generation (services new in the release have none) and containers are recreated with the previous images.
6. After success, generations that no pointer retains and no container of the stack references are pruned.

Only sanitized generation ids appear in results and history. DEVOPS-007 has no operation to deactivate a `current` generation, so the migrator's last generation stays on tmpfs (root/render-identity readable only) until the next deployment prunes older ones or the host reboots.

## Database migrations

When `migration-service` is set, it must be the Compose service of a release component (so the release's migration image runs), should be in a non-default Compose profile, and must not be a dependency of long-running services. The helper runs it with `docker compose run` (its declared infrastructure dependencies start first), enforces `migration-timeout-seconds`, requires exit status `0`, and removes the container on success. A failed or timed-out migration container is retained, stopped, for `docker logs` on the host and removed by the next attempt. A healthy, still-running migrator is never treated as success.

Database compatibility: a successful forward migration cannot be undone by image restoration, and the toolkit never runs reverse migrations. Use expand/migrate/contract changes so the previous application release keeps working against the migrated schema; otherwise automatic restoration can restore images that are incompatible with the database. The [backend template's migrator](doppler/architecture.md#template-findings-that-affect-adoption) currently keeps running after migrating and must be changed to exit before it can satisfy this contract.

## Health verification

Required services are `health-services`, or every long-running service (default-profile services other than the migration service) when empty. The service-state contract:

- every container of the service must be `running`;
- with a Docker health check, it must report `healthy`;
- without one, the same container must stay `running` for a stability window of `min(10s, health-timeout-seconds / 2)`;
- `exited`, `dead`, or `unhealthy` fails immediately.

`health-checks` are HTTP(S) requests made **from the host** to registry-approved hosts (loopback by default) with bounded retries every 3 seconds; each must return one of its `expectedStatus` codes (default `200`; redirects are not followed). Response bodies are never read or logged. Success requires every service and check to pass in the same round before `health-timeout-seconds`.

## Remote state

```text
/srv/example-backend/production/            root:root 0750 (registry deploymentPath)
  lock                                      exclusive stack lock (stale after reboot or holder exit)
  active.json                               authoritative active release record (commit point)
  active-manifest.json                      copy of the active immutable manifest
  previous.json, previous-manifest.json     last superseded successful release
  manifests/<deployment-id>.json            write-once canonical manifests (0444)
  releases/<deployment-id>/<attempt>/       compose-N.yml, images.override.json, manifest.json, request.json (0440)
  history/deployments.jsonl                 append-only sanitized records
  runtime/generations.override.json         derived generation labels
  stack.env                                 optional operator-owned interpolation values
```

All writes use exclusive no-follow creation and same-directory atomic rename. Re-deploying a deployment id requires a byte-identical canonical manifest. History records contain the deployment and previous ids, manifest hash, source repository/commit, workflow identity, phases, migration and health outcomes, restoration outcome, and generation ids—never secret values, tokens, credentials, or raw command output. Release directories are retained; prune old ones manually when no longer needed for audit or rollback.

## Boot behavior

`vps-deploy-stack@<stack>.service` starts the **active** release after `docker.service` and, through the generated drop-in, after every boot-time runtime-secret initializer. If Doppler is unavailable at boot the initializer fails, the stack unit fails with a dependency error, and secret-bearing containers stay stopped: `restart: "no"` prevents Docker from starting them, and `create_host_path: false` makes a container fail if its `current` generation is missing. The helper's `start` also refuses to start when a long-running secret service has no `current` generation. Containers are recreated at start because generation labels change. A Doppler outage during an ordinary refresh does not touch running services.

Caution: `Requires=` propagates stop/restart. Restarting an initializer on a running host restarts the stack; during a provider outage, use the render/activate units (which do not propagate) instead.

## Recovery

| Situation | Action |
| --- | --- |
| Job failed, status `restored-after-failure` | The previous release is running and healthy. Investigate the failed release using the audit artifact and `history/deployments.jsonl`, fix, and deploy a new deployment id |
| Restoration failed (`restoration.outcome: failed`) | Inspect `docker compose --project-name <stack> ps` and container logs on the host, and `active.json` (still the last good release). Fix the cause (for example `stack.env`, a missing image, database compatibility), then redeploy the last good deployment id through the workflow |
| Failed initial deployment | Containers are left for diagnosis. Fix and redeploy; there is no release to restore |
| Migration failed or timed out | No application container changed. Read the retained container's logs (`docker logs <stack>-migration-<attempt>`), assess database state, fix forward, redeploy |
| Secret render failed | Running services are unchanged. Restore Doppler/token access ([rotation and revocation](doppler/rotation-and-revocation.md)), then redeploy |
| Stack lock held after a crash | A lock from a previous boot or a dead process is reclaimed automatically. Otherwise confirm no deployment is running before removing `<root>/lock` |
| Manual rollback before `vps-rollback.yml` exists | Redeploy the earlier deployment id with its recorded manifest through `vps-deploy.yml`; its manifest copy under `manifests/` guarantees identical content |

## Limitations

- One host: host, Docker daemon, or reverse-proxy failure interrupts every stack; health gates reduce but do not remove deployment downtime.
- The `vps-rollback.yml` workflow is not implemented yet; `DeploymentEngine.restore` is the reusable primitive for it.
- Docker Hub is the only registry. Image signatures are not verified; digests, provenance checks, and the registry namespace allowlist are the release authority.
- Health checks run from the host; external reachability through the reverse proxy is not verified.
