// Real Linux/Docker Compose integration checks for vps-deploy. Invoked by
// vps-deploy-linux.sh inside a disposable privileged host; every check must
// pass and none may be skipped.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../../scripts/vps-deploy-host.mjs";
import { CliRuntimeSecrets } from "../../scripts/vps-deploy/secrets.mjs";

const work = "/work";
const digests = JSON.parse(readFileSync("/itest/digests.json", "utf8"));
const helper = join(work, "scripts", "runtime-secrets.mjs");
const credentialDirectory = "/etc/itest-credentials";
const passed = [];
let sequence = 0;

async function check(name, action) {
  process.stdout.write(`- ${name} ... `);
  try {
    await action();
    passed.push(name);
    process.stdout.write("ok\n");
  } catch (error) {
    process.stdout.write("FAILED\n");
    console.error(error);
    process.exit(1);
  }
}

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function tryRun(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", ...options });
}

function writeRootFile(path, content, mode = 0o644) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o755 });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

// ---------------------------------------------------------------- host setup
const dopplerStub = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "v3.77.0"; exit 0; fi
[ "$*" = "secrets download --no-file --no-fallback --format json" ] || { echo "unexpected arguments" >&2; exit 64; }
[ -f /etc/doppler-stub/unavailable ] && { echo "Unable to reach Doppler: connection refused" >&2; exit 1; }
case "$DOPPLER_TOKEN" in ""|*[!a-z0-9-]*) echo "401 invalid token" >&2; exit 1;; esac
[ -f "/etc/doppler-stub/$DOPPLER_TOKEN.json" ] || { echo "401 unauthorized" >&2; exit 1; }
cat "/etc/doppler-stub/$DOPPLER_TOKEN.json"
`;

function payload(token, config, values) {
  writeRootFile(`/etc/doppler-stub/${token}.json`, JSON.stringify({ DOPPLER_PROJECT: "itest-backend", DOPPLER_CONFIG: config, DOPPLER_ENVIRONMENT: "prd", ...values }), 0o600);
}

function mountSecretTmpfs() {
  mkdirSync("/run/runtime-secrets", { recursive: true });
  tryRun("umount", ["/run/runtime-secrets"]);
  sh("mount", ["-t", "tmpfs", "-o", "mode=0755,nodev,nosuid,noexec,size=16M", "tmpfs", "/run/runtime-secrets"]);
  for (const path of ["/run/runtime-secrets/itest-backend", "/run/runtime-secrets/itest-backend/prd"]) {
    mkdirSync(path, { mode: 0o711 });
    chmodSync(path, 0o711);
  }
}

function setupHost() {
  writeRootFile("/usr/local/bin/doppler", dopplerStub, 0o755);
  for (const [id, service, gid, keys] of [
    ["itb-api", "api", 31101, [{ name: "API__KEY", required: true, allowEmpty: false, maxBytes: 256 }]],
    ["itb-mig", "migrator", 31102, [{ name: "DB__OWNER", required: true, allowEmpty: false, maxBytes: 256 }]],
  ]) {
    writeRootFile(`/etc/runtime-secrets/manifests/itest-${service}.json`, JSON.stringify({ version: 1, secrets: keys }));
    writeRootFile(`/etc/runtime-secrets/instances/${id}.json`, JSON.stringify({
      version: 1, application: "itest-backend", environment: "prd", service,
      expectedDopplerProject: "itest-backend", expectedDopplerConfig: `prd_${service}`,
      outputDirectory: `/run/runtime-secrets/itest-backend/prd/${service}`, serviceGroupId: gid,
      keyManifestPath: `/etc/runtime-secrets/manifests/itest-${service}.json`, providerRetries: 0, providerTimeoutSeconds: 10,
    }));
    writeRootFile(`${credentialDirectory}/${id}.token`, `tok-${service}\n`, 0o600);
  }
  payload("tok-api", "prd_api", { API__KEY: "api-secret-one" });
  payload("tok-migrator", "prd_migrator", { DB__OWNER: "owner-secret-one" });
  mountSecretTmpfs();
  writeRootFile("/etc/vps-deploy/stacks/itest-backend.json", JSON.stringify({
    version: 1, stackName: "itest-backend", environment: "production", deploymentPath: "/srv/itest-backend/production",
    allowedSourceRepositories: ["itest/backend"], allowedImageRepositories: ["docker.io/itest/"],
    runtimeSecrets: { services: { api: { instance: "itb-api" }, migrator: { instance: "itb-mig", startAtBoot: false } } },
    lockTimeoutSeconds: 600,
  }));
  writeRootFile("/etc/vps-deploy/stacks/itest-frontend.json", JSON.stringify({
    version: 1, stackName: "itest-frontend", environment: "production", deploymentPath: "/srv/itest-frontend/production",
    allowedSourceRepositories: ["itest/frontend"], allowedImageRepositories: ["docker.io/itest/app"],
  }));
  for (const path of ["/srv/itest-backend/production", "/srv/itest-frontend/production"]) {
    mkdirSync(path, { recursive: true, mode: 0o750 });
    chmodSync(path, 0o750);
  }
  setStackEnv("HEALTH_PATH=/health\nMIGRATION_EXIT=0\nMIGRATION_SLEEP=0\n");
}

function setStackEnv(text) { writeRootFile("/srv/itest-backend/production/stack.env", text, 0o644); }

// ------------------------------------------------------------- deployments
const backendCompose = (extraWorker = "") => `services:
  api:
    user: "10001"
    group_add: ["31101"]
    read_only: true
    restart: "no"
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080\${HEALTH_PATH:-/health}"]
      interval: 1s
      timeout: 2s
      retries: 3
      start_period: 1s
    ports: ["127.0.0.1:18080:8080"]
    volumes:
      - type: bind
        source: /run/runtime-secrets/itest-backend/prd/api/current
        target: /run/secrets/app
        read_only: true
        bind:
          create_host_path: false
    networks: [private]
  worker:
    user: "10001"
    read_only: true
    command: ["sh", "-c", "while true; do sleep 3600; done"]
    networks: [private]${extraWorker}
  migrator:
    profiles: ["migration"]
    user: "10001"
    group_add: ["31102"]
    restart: "no"
    security_opt: ["no-new-privileges:true"]
    environment:
      MIGRATION_EXIT: "\${MIGRATION_EXIT:-0}"
      MIGRATION_SLEEP: "\${MIGRATION_SLEEP:-0}"
    volumes:
      - type: bind
        source: /run/runtime-secrets/itest-backend/prd/migrator/current
        target: /run/secrets/app
        read_only: true
        bind:
          create_host_path: false
    networks: [private]
networks:
  private: {}
`;

const frontendCompose = `services:
  web:
    user: "10001"
    read_only: true
    restart: unless-stopped
    ports: ["127.0.0.1:18090:8080"]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
      interval: 1s
      timeout: 2s
      retries: 3
      start_period: 1s
`;

const sha = (char) => char.repeat(40);
function workflow(repository) {
  return { repository, ref: `${repository}/.github/workflows/deploy.yml@refs/heads/main`, sha: sha("a"), runId: "1", runAttempt: "1", actor: "itest", eventName: "workflow_dispatch", toolkitRepository: "itest/devops-toolkit", toolkitSha: sha("b"), runUrl: `https://github.com/${repository}/actions/runs/1` };
}

function backendManifest(id, { app = "v1", worker = "v1", migrator = "v1", missing = false } = {}) {
  return JSON.stringify({
    schema_version: "1.0", deployment_id: id, source_repository: "itest/backend", source_commit: sha("c"),
    build_reference: "https://github.com/itest/backend/actions/runs/1", created_at: "2026-11-22T00:00:00Z",
    components: [
      { name: "api", image: "docker.io/itest/app", digest: missing ? `sha256:${"0".repeat(64)}` : digests[`app-${app}`] },
      { name: "worker", image: "docker.io/itest/app", digest: digests[`app-${worker}`] },
      { name: "migrator", image: "docker.io/itest/migrator", digest: digests[`migrator-${migrator}`] },
    ],
  });
}

function backendEnvelope(id, options = {}) {
  return JSON.stringify({
    version: 1,
    request: {
      version: 1, environment: "production", deploymentId: id, stackName: "itest-backend", remoteDeploymentPath: "/srv/itest-backend/production",
      composeFiles: [{ path: "deploy/compose.production.yml", content: options.compose ?? backendCompose() }],
      componentServiceMap: {}, migrationService: "migrator", migrationTimeoutSeconds: options.migrationTimeout ?? 60,
      healthServices: options.healthServices ?? ["api"], healthChecks: [{ name: "api", url: "http://127.0.0.1:18080/version" }],
      healthTimeoutSeconds: options.healthTimeout ?? 30, rollbackOnHealthFailure: options.rollback ?? true, workflow: workflow("itest/backend"),
    },
    manifest: backendManifest(id, options),
    registry: { username: "itest-reader", token: "itest-pull-token-synthetic" },
  });
}

function backendEngine() {
  return createEngine("itest-backend", {
    secrets: new CliRuntimeSecrets({ helper, credentialDirectory }),
    progress: () => {},
  });
}

const nextId = () => `itest-${String(++sequence).padStart(3, "0")}`;

function container(project, service) {
  return sh("docker", ["ps", "-a", "-q", "--no-trunc", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`, "--filter", "label=com.docker.compose.oneoff=False"]);
}
function state(id) { return sh("docker", ["inspect", "-f", "{{.State.Status}}", id]); }
function imageOf(id) { return sh("docker", ["inspect", "-f", "{{.Config.Image}}", id]); }
function readSecret(id, key) { return sh("docker", ["exec", id, "cat", `/run/secrets/app/${key}`]); }
function active() { return JSON.parse(readFileSync("/srv/itest-backend/production/active.json", "utf8")); }
function pointer(service, name) { return sh("readlink", [`/run/runtime-secrets/itest-backend/prd/${service}/${name}`]); }
function mode(path) { return (statSync(path).mode & 0o777).toString(8); }

// -------------------------------------------------------------------- run
setupHost();
let current = "";

await check("first backend deployment succeeds with migration, secrets and health", async () => {
  const id = nextId();
  const result = await backendEngine().deploy(backendEnvelope(id, { healthServices: [] }));
  assert.equal(result.failure, null, JSON.stringify(result.failure));
  assert.equal(result.status, "succeeded");
  assert.equal(result.previousDeploymentId, "");
  assert.equal(result.migration.exitCode, 0);
  const api = container("itest-backend", "api");
  assert.equal(state(api), "running");
  assert.equal(readSecret(api, "API__KEY"), "api-secret-one");
  assert.equal(imageOf(api), `docker.io/itest/app@${digests["app-v1"]}`);
  assert.equal(container("itest-backend", "migrator"), "", "migration container must be removed after success");
  current = id;
});

await check("deployment state uses restricted permissions, write-once manifests and sanitized history", () => {
  const root = "/srv/itest-backend/production";
  assert.equal(mode(root), "750");
  assert.equal(mode(join(root, "active.json")), "640");
  assert.equal(mode(join(root, "manifests", `${current}.json`)), "444");
  const release = active().release;
  assert.equal(mode(join(root, release, "compose-1.yml")), "440");
  assert.equal(mode(join(root, release, "images.override.json")), "440");
  assert.equal(existsSync(join(root, "lock")), false);
  const history = readFileSync(join(root, "history", "deployments.jsonl"), "utf8");
  for (const forbidden of ["itest-pull-token-synthetic", "itest-reader", "api-secret-one", "owner-secret-one"]) assert.equal(history.includes(forbidden), false, forbidden);
  assert.match(history, /gen-\d{8}T\d{6}Z-[a-f0-9]{8}/u);
  assert.equal(existsSync("/root/.docker/config.json"), false, "registry credentials must not persist in root's Docker config");
  assert.equal(sh("sh", ["-c", "ls -d /run/vps-deploy-registry-* 2>/dev/null || true"]), "");
});

await check("docker inspect exposes neither secret values nor provider tokens", () => {
  const inspect = sh("docker", ["inspect", container("itest-backend", "api")]);
  for (const forbidden of ["api-secret-one", "owner-secret-one", "tok-api", "DOPPLER_TOKEN"]) assert.equal(inspect.includes(forbidden), false, forbidden);
});

let frontendWeb = "";
await check("end-to-end SSH deployment through the forced command and sudo policy", () => {
  mkdirSync("/itest/frontend/deploy", { recursive: true });
  writeFileSync("/itest/frontend/deploy/compose.yml", frontendCompose);
  const manifest = JSON.stringify({
    schema_version: "1.0", deployment_id: "fe-001", source_repository: "itest/frontend", source_commit: sha("d"),
    build_reference: "https://github.com/itest/frontend/actions/runs/7", created_at: "2026-11-22T00:00:00Z",
    components: [{ name: "web", image: "docker.io/itest/app", digest: digests["app-v1"] }],
  });
  const env = {
    PATH: process.env.PATH, VPS_DEPLOY_DIRECTORY: "/itest/runner", ENVIRONMENT: "production", DEPLOYMENT_ID: "fe-001",
    STACK_NAME: "itest-frontend", MANIFEST_JSON: manifest, MANIFEST_ARTIFACT: "", COMPOSE_FILES: "deploy/compose.yml",
    COMPONENT_SERVICE_MAP: "{}", REMOTE_DEPLOYMENT_PATH: "/srv/itest-frontend/production", SSH_PORT: "2222",
    MIGRATION_SERVICE: "", MIGRATION_TIMEOUT_SECONDS: "600", HEALTH_SERVICES: "", HEALTH_CHECKS: '[{"name":"web","url":"http://127.0.0.1:18090/health"}]',
    HEALTH_TIMEOUT_SECONDS: "30", ROLLBACK_ON_HEALTH_FAILURE: "true", CALLER_WORKSPACE: "/itest/frontend",
    CALLER_REPOSITORY: "itest/frontend", CALLER_SHA: sha("d"), CALLER_WORKFLOW_REF: "itest/frontend/.github/workflows/deploy.yml@refs/heads/main",
    RUN_ID: "7", RUN_ATTEMPT: "1", ACTOR: "itest", EVENT_NAME: "push", SERVER_URL: "https://github.com",
    TOOLKIT_REPOSITORY: "itest/devops-toolkit", TOOLKIT_SHA: sha("b"),
    SSH_HOST: "127.0.0.1", SSH_USER: "vps-deploy", SSH_PRIVATE_KEY: readFileSync("/itest/ssh/itest-frontend", "utf8"),
    SSH_KNOWN_HOSTS: readFileSync("/itest/ssh/known_hosts", "utf8"), REGISTRY_USERNAME: "itest-reader", REGISTRY_TOKEN: "itest-pull-token-synthetic",
  };
  const runner = join(work, "scripts", "vps-deploy.mjs");
  sh("node", [runner, "inputs"], { env });
  sh("node", [runner, "prepare"], { env });
  const remote = tryRun("node", [runner, "remote"], { env });
  assert.equal(remote.status, 0, remote.stdout + remote.stderr);
  const result = JSON.parse(readFileSync("/itest/runner/result.json", "utf8"));
  assert.equal(result.status, "succeeded", JSON.stringify(result.failure));
  sh("node", [runner, "record"], { env: { ...env, GITHUB_OUTPUT: "/itest/runner/outputs" } });
  assert.match(readFileSync("/itest/runner/outputs", "utf8"), /deployment-status=succeeded/u);
  assert.equal(readFileSync("/itest/runner/deployment-record.json", "utf8").includes("itest-pull-token-synthetic"), false);
  frontendWeb = container("itest-frontend", "web");
  assert.equal(state(frontendWeb), "running");

  const wrongHost = tryRun("node", [runner, "remote"], { env: { ...env, SSH_KNOWN_HOSTS: readFileSync("/itest/ssh/wrong_known_hosts", "utf8") } });
  assert.notEqual(wrongHost.status, 0, "an unpinned host key must be rejected");
  assert.match(wrongHost.stderr, /SSH connection failed/u);
  const crossStack = tryRun("node", [runner, "remote"], { env: { ...env, SSH_PRIVATE_KEY: readFileSync("/itest/ssh/itest-backend", "utf8") } });
  assert.notEqual(crossStack.status, 0, "a key bound to another stack must not deploy this stack");
  assert.match(readFileSync("/itest/runner/result.json", "utf8"), /bound to this deploy identity/u);
  const shell = tryRun("ssh", ["-F", "/dev/null", "-T", "-p", "2222", "-i", "/itest/ssh/itest-frontend", "-o", "StrictHostKeyChecking=yes", "-o", "UserKnownHostsFile=/itest/ssh/known_hosts", "-o", "BatchMode=yes", "vps-deploy@127.0.0.1", "id; cat /etc/shadow"]);
  assert.equal(shell.status, 2, "arbitrary remote commands must be refused");
  assert.match(shell.stdout, /only the deploy operation/u);
  const sudoShell = tryRun("su", ["-s", "/bin/sh", "vps-deploy", "-c", "sudo -n /bin/sh -c id"]);
  assert.notEqual(sudoShell.status, 0, "the deploy account must not gain arbitrary sudo");
  assert.equal(sh("id", ["-nG", "vps-deploy"]).split(/\s+/u).includes("docker"), false);
});

await check("subsequent deployment activates the new release and rotates secret generations", async () => {
  const apiBefore = container("itest-backend", "api");
  const workerBefore = container("itest-backend", "worker");
  const generationBefore = pointer("api", "current");
  payload("tok-api", "prd_api", { API__KEY: "api-secret-two" });
  const id = nextId();
  const result = await backendEngine().deploy(backendEnvelope(id, { app: "v2" }));
  assert.equal(result.status, "succeeded", JSON.stringify(result.failure));
  assert.equal(result.previousDeploymentId, current);
  const api = container("itest-backend", "api");
  assert.notEqual(api, apiBefore, "secret/image change must recreate api");
  assert.equal(readSecret(api, "API__KEY"), "api-secret-two");
  assert.equal(imageOf(api), `docker.io/itest/app@${digests["app-v2"]}`);
  assert.equal(pointer("api", "previous"), generationBefore);
  assert.equal(container("itest-backend", "worker"), workerBefore, "unchanged worker must not be recreated");
  assert.equal(JSON.parse(readFileSync("/srv/itest-backend/production/previous.json", "utf8")).deploymentId, current);
  current = id;
});

await check("secret-generation change alone recreates the secret-bearing container", async () => {
  const apiBefore = container("itest-backend", "api");
  payload("tok-api", "prd_api", { API__KEY: "api-secret-three" });
  const result = await backendEngine().deploy(backendEnvelope(current, { app: "v2" }));
  assert.equal(result.status, "succeeded", JSON.stringify(result.failure));
  const api = container("itest-backend", "api");
  assert.notEqual(api, apiBefore);
  assert.equal(readSecret(api, "API__KEY"), "api-secret-three");
});

async function expectUnchanged(label, action, phase) {
  const api = container("itest-backend", "api");
  const generation = pointer("api", "current");
  const result = await action();
  assert.equal(result.status, "failed", `${label}: ${JSON.stringify(result)}`);
  assert.equal(result.failedPhase, phase, `${label}: ${JSON.stringify(result.failure)}`);
  assert.equal(result.restoration.outcome, "not-required");
  assert.equal(container("itest-backend", "api"), api, `${label}: running container changed`);
  assert.equal(state(api), "running");
  assert.equal(pointer("api", "current"), generation, `${label}: current generation changed`);
  assert.equal(existsSync("/run/runtime-secrets/itest-backend/prd/api/pending"), false, `${label}: pending generation left behind`);
  assert.equal(active().deploymentId, current);
  return result;
}

await check("image pull failure leaves the previous application unchanged", async () => {
  await expectUnchanged("pull", () => backendEngine().deploy(backendEnvelope(nextId(), { missing: true })), "pull");
});

await check("invalid Compose configuration fails before rollout", async () => {
  await expectUnchanged("compose", () => backendEngine().deploy(backendEnvelope(nextId(), { compose: backendCompose("\n    ports: 12") })), "stage");
});

await check("Compose policy rejects a Docker socket mount after real normalization", async () => {
  const compose = backendCompose("\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock");
  const result = await expectUnchanged("socket", () => backendEngine().deploy(backendEnvelope(nextId(), { compose })), "stage");
  assert.equal(result.failure.category, "compose-policy");
});

await check("root-running component images are rejected before rollout", async () => {
  const compose = backendCompose().replace('  worker:\n    user: "10001"\n', "  worker:\n");
  const id = nextId();
  const envelope = JSON.parse(backendEnvelope(id, { compose }));
  const manifest = JSON.parse(envelope.manifest);
  manifest.components[1] = { name: "worker", image: "docker.io/itest/root", digest: digests["root-v1"] };
  envelope.manifest = JSON.stringify(manifest);
  const result = await expectUnchanged("root", () => backendEngine().deploy(JSON.stringify(envelope)), "pull");
  assert.match(result.failure.message, /run as root/u);
});

await check("missing required runtime secret rejects the deployment", async () => {
  payload("tok-api", "prd_api", {});
  const result = await expectUnchanged("missing secret", () => backendEngine().deploy(backendEnvelope(current, { app: "v2" })), "secrets");
  assert.match(result.failure.message, /validation/u);
  payload("tok-api", "prd_api", { API__KEY: "api-secret-three" });
});

await check("Doppler render failure leaves the running application unchanged", async () => {
  writeRootFile("/etc/doppler-stub/unavailable", "");
  const result = await expectUnchanged("provider", () => backendEngine().deploy(backendEnvelope(current, { app: "v2" })), "secrets");
  assert.match(result.failure.message, /provider/u);
  rmSync("/etc/doppler-stub/unavailable");
});

await check("database migration failure blocks application rollout", async () => {
  setStackEnv("HEALTH_PATH=/health\nMIGRATION_EXIT=3\nMIGRATION_SLEEP=0\n");
  const result = await expectUnchanged("migration", () => backendEngine().deploy(backendEnvelope(current, { app: "v2" })), "migration");
  assert.equal(result.migration.exitCode, 3);
  assert.equal(result.migration.status, "failed");
  assert.equal(result.migration.databaseMayHaveChanged, true);
  assert.equal(result.outcome, "failed-before-rollout");
  assert.notEqual(container("itest-backend", "migrator") || sh("docker", ["ps", "-aq", "--filter", `name=${result.migration.container}`]), "", "failed migration container is retained for diagnosis");
});

await check("database migration timeout fails the deployment", async () => {
  setStackEnv("HEALTH_PATH=/health\nMIGRATION_EXIT=0\nMIGRATION_SLEEP=30\n");
  const result = await expectUnchanged("migration timeout", () => backendEngine().deploy(backendEnvelope(current, { app: "v2", migrationTimeout: 3 })), "migration");
  assert.equal(result.migration.timedOut, true);
  assert.equal(result.migration.status, "timed-out");
  setStackEnv("HEALTH_PATH=/health\nMIGRATION_EXIT=0\nMIGRATION_SLEEP=0\n");
});

await check("unhealthy release is restored automatically and the deployment still fails", async () => {
  const previousApi = container("itest-backend", "api");
  const previousGeneration = pointer("api", "current");
  const result = await backendEngine().deploy(backendEnvelope(nextId(), { app: "v3" }));
  assert.equal(result.status, "restored-after-failure", JSON.stringify(result));
  assert.equal(result.ok, false);
  assert.equal(result.failedPhase, "health");
  assert.equal(result.restoration.outcome, "restored");
  const api = container("itest-backend", "api");
  assert.equal(imageOf(api), `docker.io/itest/app@${digests["app-v2"]}`);
  assert.equal(pointer("api", "current"), previousGeneration);
  assert.equal(readSecret(api, "API__KEY"), "api-secret-three");
  assert.equal(sh("docker", ["inspect", "-f", "{{.State.Health.Status}}", api]), "healthy");
  assert.notEqual(api, previousApi);
  assert.equal(active().deploymentId, current);
});

await check("failed restoration is reported explicitly with diagnostics", async () => {
  setStackEnv("HEALTH_PATH=/broken\nMIGRATION_EXIT=0\nMIGRATION_SLEEP=0\n");
  const result = await backendEngine().deploy(backendEnvelope(nextId(), { app: "v1" }));
  assert.equal(result.status, "failed");
  assert.equal(result.restoration.outcome, "failed");
  assert.match(result.restoration.manualRecovery, /docs\/vps-deployment\.md/u);
  const last = readFileSync("/srv/itest-backend/production/history/deployments.jsonl", "utf8").trim().split("\n").pop();
  assert.equal(JSON.parse(last).restoration.outcome, "failed");
  setStackEnv("HEALTH_PATH=/health\nMIGRATION_EXIT=0\nMIGRATION_SLEEP=0\n");
  const recovered = await backendEngine().deploy(backendEnvelope(current, { app: "v2" }));
  assert.equal(recovered.status, "succeeded", "operator recovery by redeploying the known-good release");
});

await check("unavailable migration dependency blocks rollout and reports a migrator that never started", async () => {
  const compose = backendCompose().replace("    networks: [private]\nnetworks:\n", `    networks: [private]
    depends_on:
      blocker:
        condition: service_healthy
  blocker:
    profiles: ["migration"]
    image: docker.io/itest/app@${digests["app-v1"]}
    user: "10001"
    read_only: true
    command: ["sh", "-c", "sleep 600"]
    healthcheck:
      test: ["CMD", "false"]
      interval: 1s
      timeout: 1s
      retries: 1
    networks: [private]
networks:
`);
  assert.match(compose, /blocker:/u);
  try {
    const result = await expectUnchanged("migration dependency", () => backendEngine().deploy(backendEnvelope(nextId(), { app: "v2", compose })), "migration");
    assert.equal(result.migration.status, "not-started", JSON.stringify(result.migration));
    assert.equal(result.migration.started, false);
    assert.equal(result.migration.databaseMayHaveChanged, false);
    assert.equal(result.outcome, "failed-before-rollout");
    assert.match(result.failure.message, /could not be started/u);
  } finally {
    const blockers = sh("docker", ["ps", "-aq", "--filter", "label=com.docker.compose.project=itest-backend", "--filter", "label=com.docker.compose.service=blocker"]);
    if (blockers) tryRun("docker", ["rm", "-f", ...blockers.split(/\s+/u)]);
  }
});

await check("a migrator left running by an interrupted deployment blocks the next deployment and is not removed", async () => {
  const leftover = sh("docker", [
    "run", "-d", "--name", "itest-interrupted-migrator",
    "--label", "com.docker.compose.project=itest-backend", "--label", "com.docker.compose.service=migrator", "--label", "com.docker.compose.oneoff=True",
    "--entrypoint", "sleep", `docker.io/itest/migrator@${digests["migrator-v1"]}`, "300",
  ]);
  try {
    const result = await expectUnchanged("interrupted migration", () => backendEngine().deploy(backendEnvelope(nextId(), { app: "v2" })), "migration");
    assert.match(result.failure.message, /interrupted deployment is still running/u);
    assert.equal(result.migration.status, "not-started");
    assert.equal(state(leftover), "running", "the interrupted migrator must not be stopped or removed");
  } finally {
    tryRun("docker", ["rm", "-f", leftover]);
  }
});

await check("a container restarted by its restart policy fails health and the previous release is restored", async () => {
  const compose = backendCompose().replace('command: ["sh", "-c", "while true; do sleep 3600; done"]', 'command: ["sh", "-c", "sleep 2; exit 1"]\n    restart: always');
  assert.match(compose, /restart: always/u);
  const previousWorker = container("itest-backend", "worker");
  const result = await backendEngine().deploy(backendEnvelope(nextId(), { app: "v2", compose, healthServices: ["api", "worker"] }));
  assert.equal(result.status, "restored-after-failure", JSON.stringify(result.failure));
  assert.equal(result.outcome, "restored-after-failure");
  assert.equal(result.failedPhase, "health");
  assert.match(result.failure.message, /worker/u);
  assert.equal(result.migration.status, "succeeded");
  assert.equal(active().deploymentId, current);
  const worker = container("itest-backend", "worker");
  assert.notEqual(worker, previousWorker);
  assert.equal(state(worker), "running");
  assert.equal(sh("docker", ["inspect", "-f", "{{.HostConfig.RestartPolicy.Name}}", worker]), "no");
});

await check("concurrent deployments to the same stack are serialized", async () => {
  const [first, second] = await Promise.all([
    backendEngine().deploy(backendEnvelope(current, { app: "v2" })),
    backendEngine().deploy(backendEnvelope(current, { app: "v2" })),
  ]);
  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal([first.lockWaited, second.lockWaited].filter(Boolean).length, 1);
});

await check("separate stacks keep independent state, locks and containers", () => {
  assert.equal(container("itest-frontend", "web"), frontendWeb, "backend deployments must not touch the frontend stack");
  assert.equal(state(frontendWeb), "running");
  assert.equal(existsSync("/srv/itest-frontend/production/history/deployments.jsonl"), true);
  const frontendHistory = readFileSync("/srv/itest-frontend/production/history/deployments.jsonl", "utf8");
  assert.equal(frontendHistory.includes("itest-backend"), false);
});

await check("reboot with Doppler unavailable keeps the secret-bearing stack stopped", async () => {
  const engine = backendEngine();
  await engine.stop();
  const api = container("itest-backend", "api");
  mountSecretTmpfs(); // tmpfs content is lost across reboot
  writeRootFile("/etc/doppler-stub/unavailable", "");
  const render = tryRun("node", [helper, "render", "--instance", "/etc/runtime-secrets/instances/itb-api.json", "--credential", `${credentialDirectory}/itb-api.token`]);
  assert.equal(render.status, 21, "initializer render must fail with the provider category");
  await assert.rejects(() => engine.start(), /fail closed/u);
  assert.notEqual(state(api), "running");
  const direct = tryRun("docker", ["start", api]);
  assert.notEqual(direct.status, 0, "Docker must not start the container without its generation (create_host_path: false)");
  rmSync("/etc/doppler-stub/unavailable");
  for (const command of ["render", "activate"]) {
    const args = [helper, command, "--instance", "/etc/runtime-secrets/instances/itb-api.json"];
    if (command === "render") args.push("--credential", `${credentialDirectory}/itb-api.token`);
    assert.equal(tryRun("node", args).status, 0, `initializer ${command}`);
  }
  const started = await engine.start();
  assert.equal(started.started, true);
  const restarted = container("itest-backend", "api");
  assert.equal(state(restarted), "running");
  assert.equal(readSecret(restarted, "API__KEY"), "api-secret-three");
});

await check("backend and frontend reference topologies pass real Compose normalization and host policy", async () => {
  const { selectLongRunningServices, validateMergedConfig } = await import("../../scripts/vps-deploy/compose-policy.mjs");
  const { validateRegistry } = await import("../../scripts/vps-deploy/registry.mjs");
  const cases = [
    { example: "dotnet", map: { migrator: "database-migrator" }, migration: "database-migrator", longRunning: ["consumer", "jobs", "postgres", "rabbitmq", "redis", "webapi"] },
    { example: "nextjs", map: {}, migration: "", longRunning: ["admin-portal", "public-portal", "user-portal"] },
  ];
  for (const item of cases) {
    const directory = `/itest/examples/${item.example}`;
    mkdirSync(directory, { recursive: true });
    const images = JSON.parse(readFileSync(join(work, "examples", item.example, "docker-images.json"), "utf8")).images;
    const componentServices = new Map(images.map((image, index) => [item.map[image.component] ?? image.component, { reference: `${image.image}@sha256:${String(index).repeat(64)}` }]));
    writeFileSync(join(directory, "compose-1.yml"), readFileSync(join(work, "examples", item.example, "compose.production.yml"), "utf8"));
    writeFileSync(join(directory, "images.override.json"), JSON.stringify({ services: Object.fromEntries([...componentServices].map(([service, value]) => [service, { image: value.reference }])) }));
    writeFileSync(join(directory, "stack.env"), "APP_UID=10001\nWEBAPI_SECRETS_GID=21001\nCONSUMER_SECRETS_GID=21002\nJOBS_SECRETS_GID=21003\nDATABASE_MIGRATOR_SECRETS_GID=21004\n");
    const base = ["compose", "--project-name", `example-${item.example}`, "--project-directory", directory, "--env-file", join(directory, "stack.env"), "--file", join(directory, "compose-1.yml"), "--file", join(directory, "images.override.json")];
    const all = JSON.parse(sh("docker", [base[0], "--profile", "*", ...base.slice(1), "config", "--format", "json"]));
    const defaults = JSON.parse(sh("docker", [...base, "config", "--format", "json"]));
    const registry = validateRegistry(JSON.parse(readFileSync(join(work, "examples", item.example, "vps-deploy-stack.json"), "utf8")));
    const secretServices = new Map([...registry.secretServices.keys()].map((service) => [service, { bindSource: `/run/runtime-secrets/example-backend/prd/${service}/current` }]));
    validateMergedConfig(all, { componentServices, secretServices, migrationService: item.migration, registry });
    assert.deepEqual(selectLongRunningServices(defaults, item.migration), item.longRunning);
  }
});

console.log(`\n${passed.length} vps-deploy Linux integration checks passed`);
