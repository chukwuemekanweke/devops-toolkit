#!/usr/bin/env node
// GitHub Actions runner helper for vps-deploy.yml. Commands:
//   inputs   validate workflow inputs and choose the manifest source
//   prepare  validate the manifest and Compose files and write a non-secret bundle
//   remote   send the bundle plus pull-only registry credentials over SSH stdin
//   record   write the sanitized audit record and job summary (deploy job)
//   record-artifact  name the audit record artifact (secret-free report job)
//   report   export the workflow outputs from the downloaded record (secret-free report job)
// Workflow inputs arrive as environment variables and are never evaluated as shell.
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeployError, classifyDeploymentOutcome, classifyMigrationStatus, limits, parseBooleanInput, parseComponentServiceMap, parseComposeFileList, parseHealthChecks,
  parseIntegerInput, parseServiceList, printable, selectManifestSource, validateDeploymentRequest, validateEnvironment,
  validateReleaseManifest, validateRemoteDeploymentPath, validateRequestAgainstManifest, validateStackName,
} from "./vps-deploy/contract.mjs";
import { applyDeployConfig, deployConfigBytes } from "./vps-deploy/config.mjs";

const hostnamePattern = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
const ipv4Pattern = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/u;
const ipv6Pattern = /^[0-9A-Fa-f:]{2,39}$/u;
const sshUserPattern = /^[a-z_][a-z0-9_-]{0,31}$/u;
const statuses = new Set(["succeeded", "failed", "restored-after-failure"]);
const recordStackPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/u;
const recordFileName = "deployment-record.json";
const maxRecordBytes = 1024 * 1024;

function directory(env) {
  const value = env.VPS_DEPLOY_DIRECTORY ?? (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, "vps-deploy") : "");
  if (!value || !isAbsolute(value)) throw new DeployError("internal", "VPS_DEPLOY_DIRECTORY or RUNNER_TEMP must be an absolute path");
  mkdirSync(value, { recursive: true, mode: 0o700 });
  return value;
}

function output(env, name, value) {
  if (!env.GITHUB_OUTPUT) return;
  const text = String(value ?? "");
  if (/[\r\n]/u.test(text)) throw new DeployError("internal", `output ${name} contains a newline`);
  writeFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`, { flag: "a" });
}

function writeFailure(env, error, phase) {
  try {
    const safe = error instanceof DeployError ? { category: error.category, message: error.message.slice(0, 500) } : { category: "internal", message: "vps-deploy runner helper failed" };
    writeFileSync(join(directory(env), "failure.json"), `${JSON.stringify({ phase, ...safe })}\n`, { mode: 0o600 });
  } catch { /* best effort */ }
}

function callerWorkspace(env) {
  return env.CALLER_WORKSPACE ?? env.GITHUB_WORKSPACE ?? process.cwd();
}

/** Inline inputs, or the deploy-config-path file's settings in their place. */
export function resolveDeploymentSettings(env) {
  return applyDeployConfig(env, (path) => readWorkspaceFile(callerWorkspace(env), path, deployConfigBytes, "deployment configuration"));
}

export function validateInputs(rawEnv) {
  const env = resolveDeploymentSettings(rawEnv);
  const source = selectManifestSource(env.MANIFEST_JSON ?? "", env.MANIFEST_ARTIFACT ?? "");
  return {
    environment: validateEnvironment(env.ENVIRONMENT),
    stackName: validateStackName(env.STACK_NAME),
    remoteDeploymentPath: validateRemoteDeploymentPath(env.REMOTE_DEPLOYMENT_PATH),
    composeFiles: parseComposeFileList(env.COMPOSE_FILES),
    componentServiceMap: parseComponentServiceMap(env.COMPONENT_SERVICE_MAP ?? "{}"),
    sshPort: parseIntegerInput(env.SSH_PORT ?? "22", "ssh-port", { min: 1, max: 65535 }),
    migrationService: (env.MIGRATION_SERVICE ?? "").trim(),
    migrationTimeoutSeconds: parseIntegerInput(env.MIGRATION_TIMEOUT_SECONDS ?? "600", "migration-timeout-seconds", limits.migrationTimeout),
    healthServices: parseServiceList(env.HEALTH_SERVICES ?? "", "health-services"),
    healthChecks: parseHealthChecks(env.HEALTH_CHECKS ?? "[]"),
    healthTimeoutSeconds: parseIntegerInput(env.HEALTH_TIMEOUT_SECONDS ?? "300", "health-timeout-seconds", limits.healthTimeout),
    rollbackOnHealthFailure: parseBooleanInput(env.ROLLBACK_ON_HEALTH_FAILURE ?? "true", "rollback-on-health-failure"),
    manifestSource: source,
  };
}

export function readWorkspaceFile(workspace, path, maxBytes, label = "compose file") {
  const root = realpathSync(workspace);
  const candidate = resolve(root, path);
  if (!existsSync(candidate)) throw new DeployError("validation", `${label} '${printable(path)}' does not exist in the caller checkout`);
  if (lstatSync(candidate).isSymbolicLink()) throw new DeployError("validation", `${label} '${printable(path)}' must not be a symbolic link`);
  const actual = realpathSync(candidate);
  const inside = relative(root, actual);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new DeployError("validation", `${label} '${printable(path)}' escapes the caller checkout`);
  const info = statSync(actual);
  if (!info.isFile()) throw new DeployError("validation", `${label} '${printable(path)}' is not a regular file`);
  if (info.size > maxBytes) throw new DeployError("validation", `${label} '${printable(path)}' exceeds ${maxBytes} bytes`);
  return readFileSync(actual, "utf8");
}

function readManifestText(env, inputs) {
  if (inputs.manifestSource.kind === "inline") return env.MANIFEST_JSON;
  const folder = env.MANIFEST_ARTIFACT_DIRECTORY;
  if (!folder) throw new DeployError("internal", "MANIFEST_ARTIFACT_DIRECTORY is required for manifest-artifact");
  const path = join(folder, "deployment-manifest.json");
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new DeployError("validation", "manifest artifact does not contain a regular deployment-manifest.json file");
  }
  if (statSync(path).size > limits.manifestBytes) throw new DeployError("validation", "release manifest exceeds 256 KiB");
  return readFileSync(path, "utf8");
}

export function workflowIdentity(env) {
  return {
    repository: env.CALLER_REPOSITORY ?? "",
    ref: env.CALLER_WORKFLOW_REF ?? "",
    sha: env.CALLER_SHA ?? "",
    runId: env.RUN_ID ?? "",
    runAttempt: env.RUN_ATTEMPT ?? "",
    actor: env.ACTOR ?? "",
    eventName: env.EVENT_NAME ?? "",
    toolkitRepository: env.TOOLKIT_REPOSITORY ?? "",
    toolkitSha: env.TOOLKIT_SHA ?? "",
    runUrl: `${env.SERVER_URL ?? "https://github.com"}/${env.CALLER_REPOSITORY ?? ""}/actions/runs/${env.RUN_ID ?? ""}`,
  };
}

export function prepareBundle(env) {
  const inputs = validateInputs(env);
  if (env.DEPLOYMENT_ID === undefined) throw new DeployError("validation", "deployment-id is required");
  const workspace = callerWorkspace(env);
  const composeFiles = inputs.composeFiles.map((path) => ({ path, content: readWorkspaceFile(workspace, path, limits.composeFileBytes) }));
  const request = validateDeploymentRequest({
    version: 1,
    environment: inputs.environment,
    deploymentId: env.DEPLOYMENT_ID,
    stackName: inputs.stackName,
    remoteDeploymentPath: inputs.remoteDeploymentPath,
    composeFiles,
    componentServiceMap: inputs.componentServiceMap,
    migrationService: inputs.migrationService,
    migrationTimeoutSeconds: inputs.migrationTimeoutSeconds,
    healthServices: inputs.healthServices,
    healthChecks: inputs.healthChecks,
    healthTimeoutSeconds: inputs.healthTimeoutSeconds,
    rollbackOnHealthFailure: inputs.rollbackOnHealthFailure,
    workflow: workflowIdentity(env),
  });
  const manifestText = readManifestText(env, inputs);
  const release = validateReleaseManifest(manifestText, { deploymentId: request.deploymentId, sourceRepository: request.workflow.repository });
  validateRequestAgainstManifest(request, release);
  return { request, manifest: release.canonical, manifestSha256: release.sha256, sshPort: inputs.sshPort };
}

export function validateSshTarget({ host, user, privateKey, knownHosts, port }) {
  if (typeof host !== "string" || host.startsWith("-") || !(hostnamePattern.test(host) || ipv4Pattern.test(host) || (host.includes(":") && ipv6Pattern.test(host)))) {
    throw new DeployError("validation", "ssh-host must be a hostname or IP address");
  }
  if (typeof user !== "string" || !sshUserPattern.test(user)) throw new DeployError("validation", "ssh-user must be a valid Linux account name");
  const key = String(privateKey ?? "").replaceAll("\r\n", "\n").trim();
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----\n[\s\S]+\n-----END [A-Z ]*PRIVATE KEY-----$/u.test(key)) throw new DeployError("validation", "ssh-private-key must be a PEM/OpenSSH private key");
  const entries = String(knownHosts ?? "").replaceAll("\r\n", "\n").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (entries.length === 0) throw new DeployError("validation", "ssh-known-hosts must contain at least one pinned host key");
  const expected = port === 22 ? host.toLowerCase() : `[${host.toLowerCase()}]:${port}`;
  let matched = false;
  for (const entry of entries) {
    const fields = entry.split(/\s+/u);
    const marker = fields[0].startsWith("@") ? fields.shift() : "";
    if (marker && marker !== "@revoked" && marker !== "@cert-authority") throw new DeployError("validation", "ssh-known-hosts contains an unsupported marker");
    if (fields.length < 3) throw new DeployError("validation", "ssh-known-hosts contains a malformed entry");
    const patternsField = fields[0];
    if (patternsField.startsWith("|1|")) { matched = true; continue; }
    const hostPatterns = patternsField.split(",");
    if (hostPatterns.some((pattern) => /[*?!]/u.test(pattern))) throw new DeployError("validation", "ssh-known-hosts must pin explicit hosts; wildcard and negated patterns are not accepted");
    if (!marker && hostPatterns.map((pattern) => pattern.toLowerCase()).includes(expected)) matched = true;
  }
  if (!matched) throw new DeployError("validation", "ssh-known-hosts has no entry for the configured ssh-host and ssh-port");
  return { key: `${key}\n`, knownHosts: `${entries.join("\n")}\n` };
}

export function sshArguments({ host, user, port, keyPath, knownHostsPath }) {
  return [
    "-F", "/dev/null", "-T", "-p", String(port), "-l", user, "-i", keyPath,
    "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "UpdateHostKeys=no", "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes",
    "-o", "ConnectTimeout=30", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=10", "-o", "LogLevel=ERROR",
    "--", host, "deploy",
  ];
}

export function relayStderrLine(line, log = console.log) {
  const text = line.trim();
  if (!text) return;
  try {
    const event = JSON.parse(text);
    if (event && event.event === "phase" && typeof event.phase === "string" && /^[a-z-]{1,32}$/u.test(event.phase)) { log(`vps-deploy: ${event.phase}`); return; }
  } catch { /* not a helper progress event */ }
  log(`remote: ${printable(text).slice(0, 300)}`);
}

export function parseRemoteResult(stdout) {
  const line = String(stdout ?? "").trim().split(/\r?\n/u).pop() ?? "";
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

async function remoteCommand(env) {
  const folder = directory(env);
  const bundle = JSON.parse(readFileSync(join(folder, "bundle.json"), "utf8"));
  const target = validateSshTarget({ host: env.SSH_HOST, user: env.SSH_USER, privateKey: env.SSH_PRIVATE_KEY, knownHosts: env.SSH_KNOWN_HOSTS, port: bundle.sshPort });
  if (!env.REGISTRY_USERNAME || !env.REGISTRY_TOKEN) throw new DeployError("validation", "registry-username and registry-token are required");
  const sshDirectory = mkdtempSync(join(folder, "ssh-"));
  chmodSync(sshDirectory, 0o700);
  const keyPath = join(sshDirectory, "id");
  const knownHostsPath = join(sshDirectory, "known_hosts");
  writeFileSync(keyPath, target.key, { mode: 0o600 });
  writeFileSync(knownHostsPath, target.knownHosts, { mode: 0o600 });
  const envelope = JSON.stringify({ version: 1, request: bundle.request, manifest: bundle.manifest, registry: { username: env.REGISTRY_USERNAME, token: env.REGISTRY_TOKEN } });
  try {
    const { code, stdout } = await new Promise((resolveRun) => {
      const child = spawn("ssh", sshArguments({ host: env.SSH_HOST, user: env.SSH_USER, port: bundle.sshPort, keyPath, knownHostsPath }), { stdio: ["pipe", "pipe", "pipe"], shell: false, env: { PATH: process.env.PATH, HOME: sshDirectory } });
      const out = [];
      let size = 0;
      let pending = "";
      child.stdout.on("data", (chunk) => { if (size < 1024 * 1024) { out.push(chunk); size += chunk.length; } });
      child.stderr.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        lines.forEach((line) => relayStderrLine(line));
      });
      child.on("error", () => resolveRun({ code: 255, stdout: "" }));
      child.on("close", (exitCode) => { if (pending) relayStderrLine(pending); resolveRun({ code: exitCode ?? 255, stdout: Buffer.concat(out).toString("utf8") }); });
      child.stdin.on("error", () => {});
      child.stdin.end(envelope);
    });
    const result = parseRemoteResult(stdout);
    if (!result) {
      throw new DeployError("transport", code === 255
        ? "SSH connection failed (host key verification, authentication, or network); no deployment result was returned"
        : `the host returned no deployment result (exit ${code})`);
    }
    writeFileSync(join(folder, "result.json"), `${JSON.stringify(result)}\n`, { mode: 0o600 });
    if (result.status !== "succeeded") process.exitCode = 1;
  } finally {
    rmSync(sshDirectory, { recursive: true, force: true });
  }
}

function text(value, max = 500) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, max) : "";
}

/**
 * Outcome when the host returned no result: runner-side validation failures
 * happen before any connection (nothing changed); a transport failure leaves the
 * host-side outcome unknown, so operators must consult the host history.
 */
function outcomeOf(result, failure) {
  if (result) {
    if (result.restoration === undefined && result.phase === undefined && result.status === "failed") return "failed-before-rollout";
    return classifyDeploymentOutcome(result);
  }
  return failure && failure.phase !== "transport" ? "failed-before-rollout" : "unknown";
}

function migrationOf(result, bundle, failure) {
  const failedPhase = result?.failedPhase ?? result?.phase;
  if (result?.migration) {
    const migration = result.migration;
    const status = classifyMigrationStatus(migration, failedPhase);
    // Older host helpers do not report `started`; assume a migration that produced an outcome ran.
    const started = typeof migration.started === "boolean" ? migration.started : ["failed", "timed-out", "succeeded"].includes(status);
    return {
      configured: migration.configured === true,
      status,
      started,
      databaseMayHaveChanged: migration.databaseMayHaveChanged === true || started,
      exitCode: Number.isInteger(migration.exitCode) ? migration.exitCode : null,
      timedOut: migration.timedOut === true,
      durationSeconds: Number.isInteger(migration.durationSeconds) ? migration.durationSeconds : null,
    };
  }
  if (!bundle) return null;
  const configured = typeof bundle.request?.migrationService === "string" && bundle.request.migrationService !== "";
  if (!configured) return { configured: false, status: "not-configured", started: false, databaseMayHaveChanged: false, exitCode: null, timedOut: false, durationSeconds: null };
  // No host result: before connection nothing ran; after a transport failure the migration may have run.
  const unknown = !result && failure?.phase === "transport";
  return { configured: true, status: unknown ? "unknown" : "not-run", started: false, databaseMayHaveChanged: unknown, exitCode: null, timedOut: false, durationSeconds: null };
}

export function buildRecord(env, { bundle, result, failure }) {
  const status = result && statuses.has(result.status) ? result.status : "failed";
  const generationIds = {};
  if (result?.secrets && typeof result.secrets === "object") {
    for (const [service, item] of Object.entries(result.secrets)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u.test(service) || !item || typeof item !== "object") continue;
      generationIds[service] = { pending: text(item.pending, 40), previousCurrent: text(item.previousCurrent, 40), activated: item.activated === true };
    }
  }
  return {
    schemaVersion: 1,
    status,
    outcome: status === "succeeded" ? "succeeded" : outcomeOf(result, failure),
    stackName: text(bundle?.request?.stackName ?? result?.stackName ?? env.STACK_NAME, 64),
    environment: text(bundle?.request?.environment ?? env.ENVIRONMENT, 64),
    deploymentId: text(bundle?.request?.deploymentId ?? env.DEPLOYMENT_ID, 128),
    deployedId: status === "succeeded" ? text(result?.deployedId, 128) : "",
    previousDeploymentId: text(result?.previousDeploymentId, 128),
    manifestSha256: text(result?.manifestSha256 ?? bundle?.manifestSha256, 64),
    phase: text(result?.failedPhase ?? result?.phase ?? failure?.phase, 32),
    failure: result?.failure ? { category: text(result.failure.category, 32), message: text(result.failure.message) } : (failure ? { category: text(failure.category, 32), message: text(failure.message) } : null),
    restoration: result?.restoration ? { attempted: result.restoration.attempted === true, outcome: text(result.restoration.outcome, 40), targetDeploymentId: text(result.restoration.targetDeploymentId, 128), reason: text(result.restoration.reason) } : null,
    migration: migrationOf(result, bundle, failure),
    health: result?.health ? { healthy: result.health.healthy === true, reason: text(result.health.reason), durationSeconds: Number.isInteger(result.health.durationSeconds) ? result.health.durationSeconds : null } : null,
    runtimeSecretGenerations: generationIds,
    release: text(result?.release, 200),
    workflow: workflowIdentity(env),
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Audit record artifact name. The deploy job (upload) and the secret-free report
 * job (download) both derive it from the same stack-name input and run identity,
 * so the report job never needs an output from the secret-bearing job.
 */
export function recordArtifactName({ stackName, runId, runAttempt }) {
  const stack = typeof stackName === "string" && recordStackPattern.test(stackName) ? stackName : "invalid-stack";
  const number = (value, fallback) => (typeof value === "string" && /^[0-9]{1,20}$/u.test(value) ? value : fallback);
  return `vps-deployment-record-${stack}-${number(runId, "0")}-${number(runAttempt, "1")}`;
}

function recordCommand(env) {
  const folder = directory(env);
  const read = (name) => { try { return JSON.parse(readFileSync(join(folder, name), "utf8")); } catch { return null; } };
  const bundle = read("bundle.json");
  const record = buildRecord(env, { bundle, result: read("result.json"), failure: read("failure.json") });
  writeFileSync(join(folder, recordFileName), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  // Step outputs only: they drive the upload and the final status gate inside the
  // deploy job. Workflow outputs come from the secret-free report job.
  output(env, "deployment-status", record.status);
  output(env, "record-artifact", recordArtifactName({ stackName: env.STACK_NAME, runId: env.RUN_ID, runAttempt: env.RUN_ATTEMPT }));
  if (env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `### VPS deployment: ${record.status}`, "",
      "| Field | Value |", "| --- | --- |",
      `| Outcome | \`${record.outcome}\` |`,
      `| Stack | \`${record.stackName}\` |`, `| Environment | \`${record.environment}\` |`,
      `| Deployment ID | \`${record.deploymentId}\` |`, `| Previous deployment | \`${record.previousDeploymentId || "none"}\` |`,
      `| Manifest SHA-256 | \`${record.manifestSha256 || "n/a"}\` |`,
    ];
    if (record.migration) lines.push(`| Migration | \`${record.migration.status}\`${record.migration.exitCode !== null ? ` (exit ${record.migration.exitCode})` : ""} |`);
    if (record.failure) lines.push(`| Failed phase | \`${record.phase}\` |`, `| Failure | ${record.failure.message.replaceAll("|", "\\|")} |`);
    if (record.restoration?.attempted || record.restoration?.outcome === "no-previous-release") lines.push(`| Restoration | ${record.restoration.outcome} |`);
    if (record.status !== "succeeded" && record.migration?.databaseMayHaveChanged) {
      lines.push("", "> **Database caution:** the migration started, so the database may have been changed. Restoration never reverses migrations; assess the schema before redeploying.");
    }
    writeFileSync(env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, { flag: "a" });
  }
  if (record.failure) console.error(`vps-deploy ${record.status} (${record.outcome}) in phase '${record.phase}': ${record.failure.message}`);
  if (record.restoration?.attempted) console.error(`vps-deploy restoration: ${record.restoration.outcome}${record.restoration.reason ? ` - ${record.restoration.reason}` : ""}`);
}

/** Non-sensitive, single-line values for caller-owned failure notification jobs. */
export function notificationOutputs(record) {
  const token = (value, fallback = "") => (typeof value === "string" && /^[a-z0-9-]{1,40}$/u.test(value) ? value : fallback);
  return {
    "deployment-outcome": token(record.outcome, "unknown"),
    "failed-phase": record.status === "succeeded" ? "" : token(record.phase, "unknown"),
    "failure-category": record.failure ? token(record.failure.category, "unknown") : "",
    "migration-status": token(record.migration?.status, "unknown"),
    "restoration-outcome": token(record.restoration?.outcome, ["succeeded", "failed-before-rollout"].includes(record.outcome) ? "not-required" : "unknown"),
  };
}

/**
 * Reads the record the deploy job uploaded. Returns `present: false` when no
 * artifact was downloaded (the deploy job ended before uploading it) and
 * `record: null` when the file is not a well-formed version-1 record.
 */
export function readDeploymentRecord(folder) {
  const path = join(folder, recordFileName);
  let info;
  try { info = lstatSync(path); } catch { return { present: false, record: null }; }
  if (!info.isFile() || info.size > maxRecordBytes) return { present: true, record: null };
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    const valid = value && typeof value === "object" && !Array.isArray(value) && value.schemaVersion === 1 && statuses.has(value.status);
    return { present: true, record: valid ? value : null };
  } catch {
    return { present: true, record: null };
  }
}

/**
 * The nine workflow outputs. Without a usable record nothing is known about the
 * host, so the outcome is `unknown` and the status is never `succeeded`.
 */
export function reportOutputs({ present, record }, artifactName) {
  const artifact = present ? artifactName : "";
  if (!record) {
    return {
      "deployment-status": "failed", "deployed-id": "", "previous-deployment-id": "", "deployment-record-artifact": artifact,
      "deployment-outcome": "unknown", "failed-phase": "unknown", "failure-category": "unknown", "migration-status": "unknown", "restoration-outcome": "unknown",
    };
  }
  const id = (value) => (typeof value === "string" && /^[^\u0000-\u001f\u007f]{0,128}$/u.test(value) ? value : "");
  return {
    "deployment-status": record.status,
    "deployed-id": record.status === "succeeded" ? id(record.deployedId) : "",
    "previous-deployment-id": id(record.previousDeploymentId),
    "deployment-record-artifact": artifact,
    ...notificationOutputs(record),
  };
}

function reportCommand(env) {
  const folder = env.VPS_DEPLOY_RECORD_DIRECTORY;
  if (!folder || !isAbsolute(folder)) throw new DeployError("internal", "VPS_DEPLOY_RECORD_DIRECTORY must be an absolute path");
  const name = recordArtifactName({ stackName: env.STACK_NAME, runId: env.RUN_ID, runAttempt: env.RUN_ATTEMPT });
  const loaded = readDeploymentRecord(folder);
  if (!loaded.present) console.log(`::warning::Deployment record '${name}' was not uploaded; the deploy job ended before recording. Reporting outcome 'unknown'; consult the host history before retrying.`);
  else if (!loaded.record) console.log(`::warning::Deployment record '${name}' is not a valid version-1 record. Reporting outcome 'unknown'.`);
  const outputs = reportOutputs(loaded, name);
  for (const [key, value] of Object.entries(outputs)) output(env, key, value);
  console.log(`vps-deploy report: status=${outputs["deployment-status"]} outcome=${outputs["deployment-outcome"]}`);
}

async function run(command, env) {
  if (command === "inputs") {
    const inputs = validateInputs(env);
    output(env, "manifest-artifact", inputs.manifestSource.kind === "artifact" ? inputs.manifestSource.name : "");
    return;
  }
  if (command === "prepare") {
    const bundle = prepareBundle(env);
    writeFileSync(join(directory(env), "bundle.json"), `${JSON.stringify(bundle)}\n`, { mode: 0o600 });
    console.log(`Validated release ${bundle.request.deploymentId} (manifest sha256 ${bundle.manifestSha256}) for stack ${bundle.request.stackName}`);
    return;
  }
  if (command === "remote") return await remoteCommand(env);
  if (command === "record") return recordCommand(env);
  if (command === "record-artifact") {
    output(env, "record-artifact", recordArtifactName({ stackName: env.STACK_NAME, runId: env.RUN_ID, runAttempt: env.RUN_ATTEMPT }));
    return;
  }
  if (command === "report") return reportCommand(env);
  throw new DeployError("usage", "usage: vps-deploy.mjs <inputs|prepare|remote|record|record-artifact|report>");
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const command = process.argv[2];
  run(command, process.env).catch((error) => {
    writeFailure(process.env, error, command === "remote" ? "transport" : "validate");
    console.error(`vps-deploy: ${error instanceof DeployError ? error.message : "unexpected runner helper failure"}`);
    process.exitCode = 1;
  });
}
