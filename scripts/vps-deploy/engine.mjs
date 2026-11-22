// vps-deploy orchestration. All side effects go through injected adapters so the
// state machine is unit-testable; the host CLI wires the production adapters.
//
// Lifecycle (one stack, under the stack lock):
//   validate -> lock -> stage -> pull -> secrets (render pending) -> migration
//   -> rollout (activate + compose up) -> health -> commit
// Failures before rollout leave running services and active state untouched.
// Failures after rollout optionally restore the previous release's images and
// runtime-secret pointers, verify its health, and always report failure.
import {
  DeployError, fail, isRecord, parseJsonStrict, patterns, printable, sha256, validateDeploymentRequest,
  validateReleaseManifest, validateRequestAgainstManifest, limits,
} from "./contract.mjs";
import {
  generationLabel, generationsOverride, imagesOverride, isRootUser, prescanComposeFiles, selectHealthServices,
  selectLongRunningServices, validateMergedConfig,
} from "./compose-policy.mjs";
import { assertHealthCheckHosts, verifyHealth } from "./health.mjs";
import { assertProvenance, resolveSecretServices } from "./registry.mjs";

const credentialUser = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;

export function parseEnvelope(text) {
  if (typeof text !== "string" || text.length === 0) fail("validation", "no deployment request was received");
  if (Buffer.byteLength(text, "utf8") > limits.envelopeBytes) fail("validation", "deployment request exceeds 4 MiB");
  let value;
  try { value = parseJsonStrict(text, "deployment request envelope"); } catch (error) { fail("validation", printable(error.message)); }
  if (!isRecord(value) || value.version !== 1) fail("validation", "deployment request envelope version must be 1");
  const unknown = Object.keys(value).filter((key) => !["version", "request", "manifest", "registry"].includes(key));
  if (unknown.length) fail("validation", `deployment request envelope contains unknown property '${printable(unknown[0])}'`);
  if (typeof value.manifest !== "string") fail("validation", "deployment request envelope manifest must be the manifest JSON text");
  const registry = value.registry;
  if (!isRecord(registry) || Object.keys(registry).some((key) => key !== "username" && key !== "token")) fail("validation", "registry credentials must contain username and token");
  if (typeof registry.username !== "string" || !credentialUser.test(registry.username)) fail("validation", "registry-username is invalid");
  if (typeof registry.token !== "string" || registry.token.length < 1 || registry.token.length > 4096 || /[\u0000-\u001f\u007f\s]/u.test(registry.token)) fail("validation", "registry-token is invalid");
  return { request: value.request, manifest: value.manifest, registry: { username: registry.username, token: registry.token } };
}

function sanitizeError(error) {
  if (error instanceof DeployError) return { category: error.category, message: error.message.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 500) };
  return { category: "internal", message: `internal error${error?.code ? ` (${String(error.code).slice(0, 32)})` : ""}` };
}

async function currentGenerations(secrets, secretServices, services) {
  const generations = {};
  for (const service of services) {
    const entry = secretServices.get(service);
    if (!entry) continue;
    const status = await secrets.status(entry.instance);
    if (status.current) generations[service] = status.current;
  }
  return generations;
}

function validateActiveRecord(record) {
  if (!isRecord(record) || record.version !== 1) fail("filesystem", "recorded active release is not a version-1 record");
  const names = (value, pattern) => Array.isArray(value) && value.every((item) => typeof item === "string" && pattern.test(item));
  if (typeof record.deploymentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(record.deploymentId)
    || !names(record.composeFiles, /^compose-\d{1,2}\.ya?ml$/u)
    || !names(record.overrideFiles, /^images\.override\.json$/u)
    || !names(record.longRunningServices, patterns.service)
    || !names(record.healthServices, patterns.service)
    || !Array.isArray(record.healthChecks)
    || !Number.isInteger(record.healthTimeoutSeconds)) {
    fail("filesystem", "recorded active release is malformed; restore requires operator review");
  }
  return record;
}

export class DeploymentEngine {
  constructor(deps) {
    this.deps = {
      prescan: prescanComposeFiles,
      now: () => new Date(),
      progress: () => {},
      fetchImpl: globalThis.fetch,
      sleep: undefined,
      healthIntervalMs: 3000,
      ...deps,
    };
  }

  phase(result, name) {
    result.phase = name;
    this.deps.progress({ event: "phase", phase: name, at: this.deps.now().toISOString() });
  }

  project(stack, directory, files, envFile) {
    return { name: stack, directory, files, envFile: envFile ?? undefined };
  }

  async health(services, checks, timeoutSeconds, stack) {
    return await verifyHealth({
      services, checks, timeoutSeconds,
      inspect: () => this.deps.docker.ps(stack),
      fetchImpl: this.deps.fetchImpl,
      now: () => this.deps.now().getTime(),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      intervalMs: this.deps.healthIntervalMs,
    });
  }

  async deploy(text) {
    const { docker, secrets, now } = this.deps;
    const stack = this.deps.stack;
    const startedAt = now().toISOString();
    const result = {
      ok: false, status: "failed", stackName: stack, environment: "", deploymentId: "", deployedId: "", previousDeploymentId: "",
      manifestSha256: "", phase: "validate", startedAt, finishedAt: "", failure: null, release: "",
      migration: { configured: false }, secrets: {}, health: null,
      restoration: { attempted: false, outcome: "not-required" },
    };
    let lock;
    let state;
    let request;
    let rolloutStarted = false;
    let previous = null;
    const prepared = [];
    let envelope;
    try {
      this.phase(result, "validate");
      envelope = parseEnvelope(text);
      request = validateDeploymentRequest(envelope.request);
      result.environment = request.environment;
      result.deploymentId = request.deploymentId;
      if (request.stackName !== stack) fail("validation", "stack-name is not the stack bound to this deploy identity");
      const registry = await this.deps.loadRegistry(stack);
      if (request.environment !== registry.environment) fail("validation", "environment does not match the host stack registry");
      if (request.remoteDeploymentPath !== registry.deploymentPath) fail("validation", "remote-deployment-path does not match the host stack registry");
      const release = validateReleaseManifest(envelope.manifest, { deploymentId: request.deploymentId, sourceRepository: request.workflow.repository });
      result.manifestSha256 = release.sha256;
      assertProvenance(registry, release);
      const componentServices = validateRequestAgainstManifest(request, release);
      assertHealthCheckHosts(request.healthChecks, registry.healthCheckHosts);
      await this.deps.prescan(request.composeFiles);
      const secretServices = await resolveSecretServices(registry, { loadInstance: this.deps.loadInstance });
      state = this.deps.createState(registry.deploymentPath);
      await state.ensureLayout();

      this.phase(result, "lock");
      lock = await state.acquireLock({ timeoutSeconds: registry.lockTimeoutSeconds, operation: "deploy", deploymentId: request.deploymentId });
      result.lockWaited = lock.waited;
      const activeRecord = await state.readActive();
      previous = activeRecord ? validateActiveRecord(activeRecord) : null;
      result.previousDeploymentId = previous?.deploymentId ?? "";

      this.phase(result, "stage");
      await state.storeManifest(request.deploymentId, release.canonical);
      const staged = await state.createRelease(request.deploymentId);
      result.release = staged.relative;
      const composeFiles = [];
      for (const [index, file] of request.composeFiles.entries()) {
        const name = `compose-${index + 1}${file.path.endsWith(".yaml") ? ".yaml" : ".yml"}`;
        await state.writeExclusive(`${staged.path}/${name}`, file.content);
        composeFiles.push(name);
      }
      await state.writeExclusive(`${staged.path}/manifest.json`, `${release.canonical}\n`);
      await state.writeExclusive(`${staged.path}/images.override.json`, `${JSON.stringify(imagesOverride(componentServices))}\n`);
      await state.writeExclusive(`${staged.path}/request.json`, `${JSON.stringify({
        ...request,
        composeFiles: request.composeFiles.map((file, index) => ({ path: file.path, storedAs: composeFiles[index], sha256: sha256(file.content) })),
      })}\n`);
      const envFile = await state.stackEnvironmentFile();
      const files = [...composeFiles.map((name) => `${staged.path}/${name}`), `${staged.path}/images.override.json`];
      const project = this.project(stack, staged.path, files, envFile);
      const allConfig = await docker.config(project, { allProfiles: true });
      validateMergedConfig(allConfig, { componentServices, secretServices, migrationService: request.migrationService, registry });
      const longRunning = selectLongRunningServices(await docker.config(project), request.migrationService);
      const healthServices = selectHealthServices(request.healthServices, longRunning);
      const definedSecretServices = [...secretServices.keys()].sort();

      this.phase(result, "pull");
      await docker.useCredentials(envelope.registry);
      const images = [...new Set(Object.values(allConfig.services).map((service) => service.image))].sort();
      for (const image of images) {
        if (!await docker.pull(image)) {
          const owner = Object.entries(allConfig.services).find(([, service]) => service.image === image)?.[0];
          fail("pull", `image for service '${owner}' could not be pulled by digest`);
        }
      }
      for (const [service, definition] of Object.entries(allConfig.services)) {
        if (!componentServices.has(service) && !secretServices.has(service)) continue;
        const user = definition.user ?? await docker.imageUser(definition.image);
        if (isRootUser(user)) fail("compose-policy", `service '${service}' would run as root; set a non-root USER in the image or Compose user`);
      }

      this.phase(result, "secrets");
      for (const service of definedSecretServices) {
        const entry = secretServices.get(service);
        const before = await secrets.status(entry.instance);
        const record = { instance: entry.instance, previousCurrent: before.current, pending: null, activated: false, staleDiscarded: null };
        result.secrets[service] = record;
        if (before.pending) {
          const discarded = await secrets.discard(entry.instance);
          if (!discarded.ok) fail("secrets", `stale pending runtime-secret generation for '${service}' could not be discarded (${discarded.category})`);
          record.staleDiscarded = before.pending;
        }
        const rendered = await secrets.render(entry.instance);
        if (!rendered.ok) fail("secrets", `runtime secrets for '${service}' could not be rendered (${rendered.category}); running services were not changed`);
        const after = await secrets.status(entry.instance);
        if (!after.pending) fail("secrets", `render for '${service}' did not produce a pending generation`);
        record.pending = after.pending;
        prepared.push({ service, instance: entry.instance, pending: after.pending, previousCurrent: before.current });
      }

      if (request.migrationService) {
        this.phase(result, "migration");
        const migration = { configured: true, service: request.migrationService, exitCode: null, timedOut: false, durationSeconds: 0, container: "" };
        result.migration = migration;
        const migratorSecret = prepared.find((item) => item.service === request.migrationService);
        if (migratorSecret) {
          const activated = await secrets.activate(migratorSecret.instance);
          if (!activated.ok) fail("secrets", `migration runtime secrets could not be activated (${activated.category})`);
          result.secrets[request.migrationService].activated = true;
          migratorSecret.activated = true;
        }
        for (const id of await docker.oneShotContainers(stack, request.migrationService)) await docker.removeContainer(id);
        const generations = await currentGenerations(secrets, secretServices, definedSecretServices);
        const generationsFile = await state.writeGenerationsOverride(generationsOverride(generations));
        const migrationProject = this.project(stack, staged.path, [...files, generationsFile], envFile);
        const name = `${stack}-migration-${staged.attempt}`.replace(/[^a-zA-Z0-9_.-]/gu, "-");
        migration.container = name;
        const began = now().getTime();
        const outcome = await docker.runOneShot(migrationProject, request.migrationService, name, { timeoutMs: request.migrationTimeoutSeconds * 1000 });
        migration.durationSeconds = Math.round((now().getTime() - began) / 1000);
        migration.timedOut = outcome.timedOut;
        migration.exitCode = outcome.exitCode;
        if (outcome.timedOut) fail("migration", `migration did not finish within ${request.migrationTimeoutSeconds} seconds; it was stopped and application rollout was blocked`);
        if (outcome.exitCode !== 0) fail("migration", `migration exited with status ${outcome.exitCode ?? "unknown"}; application rollout was blocked`);
        await docker.removeContainer(name);
        migration.container = "";
      }

      this.phase(result, "rollout");
      rolloutStarted = true;
      for (const item of prepared) {
        if (item.activated) continue;
        const activated = await secrets.activate(item.instance);
        if (!activated.ok) fail("secrets", `runtime secrets for '${item.service}' could not be activated (${activated.category})`);
        item.activated = true;
        result.secrets[item.service].activated = true;
      }
      const generations = await currentGenerations(secrets, secretServices, definedSecretServices);
      const generationsFile = await state.writeGenerationsOverride(generationsOverride(generations));
      const up = await docker.up(this.project(stack, staged.path, [...files, generationsFile], envFile), longRunning, { pull: "never" });
      if (!up.ok) fail("rollout", `docker compose up failed${up.timedOut ? " (timeout)" : ""}${up.diagnostic ? `: ${up.diagnostic}` : ""}`);

      this.phase(result, "health");
      const health = await this.health(healthServices, request.healthChecks, request.healthTimeoutSeconds, stack);
      result.health = health;
      if (!health.healthy) fail("health", health.reason);

      this.phase(result, "commit");
      await state.commitActive({
        version: 1,
        deploymentId: request.deploymentId,
        manifestSha256: release.sha256,
        sourceRepository: release.manifest.source_repository,
        sourceCommit: release.manifest.source_commit,
        release: staged.relative,
        composeFiles,
        overrideFiles: ["images.override.json"],
        longRunningServices: longRunning,
        migrationService: request.migrationService,
        secretServices: Object.fromEntries(definedSecretServices.map((service) => [service, secretServices.get(service).instance])),
        generations,
        healthServices,
        healthChecks: request.healthChecks,
        healthTimeoutSeconds: request.healthTimeoutSeconds,
        deployedAt: now().toISOString(),
        workflow: request.workflow,
      }, release.canonical);
      result.ok = true;
      result.status = "succeeded";
      result.deployedId = request.deploymentId;
      result.generations = generations;
      result.prune = await this.prune(stack, secretServices, definedSecretServices);
    } catch (error) {
      result.failure = sanitizeError(error);
      result.failedPhase = result.phase;
      if (!rolloutStarted) {
        for (const item of prepared) {
          if (item.activated) continue;
          const discarded = await secrets.discard(item.instance).catch(() => ({ ok: false, category: "error" }));
          if (result.secrets[item.service]) result.secrets[item.service].discarded = discarded.ok;
        }
        result.restoration = { attempted: false, outcome: "not-required", reason: "failure occurred before application rollout; running services were not changed" };
      } else if (!request.rollbackOnHealthFailure) {
        result.restoration = { attempted: false, outcome: "disabled", reason: "rollback-on-health-failure is false; the failed release was left in place for investigation" };
      } else if (!previous) {
        result.restoration = { attempted: false, outcome: "no-previous-release", reason: "initial deployment failed; there is no recorded release to restore and diagnostics were retained" };
      } else {
        this.phase(result, "restore");
        result.restoration = await this.restore(stack, state, previous, prepared);
        if (result.restoration.outcome === "restored") result.status = "restored-after-failure";
      }
    } finally {
      await docker.forgetCredentials().catch(() => {});
      result.finishedAt = now().toISOString();
      if (lock) {
        try {
          await state.appendHistory({ recordedAt: result.finishedAt, ...result, workflow: request?.workflow ?? null });
        } catch {
          result.historyWriteFailed = true;
        }
        await lock.release().catch(() => {});
      }
    }
    return result;
  }

  /** Restore the previously active release (reusable primitive for a later vps-rollback workflow). */
  async restore(stack, state, previous, prepared) {
    const { docker, secrets } = this.deps;
    const outcome = { attempted: true, outcome: "failed", targetDeploymentId: previous.deploymentId, secrets: {}, health: null, reason: "" };
    try {
      for (const item of prepared) {
        if (!item.activated) {
          await secrets.discard(item.instance).catch(() => {});
          continue;
        }
        if (!item.previousCurrent) { outcome.secrets[item.service] = "no-previous-generation"; continue; }
        const restored = await secrets.restore(item.instance);
        outcome.secrets[item.service] = restored.ok ? "restored" : `failed:${restored.category}`;
        if (!restored.ok) fail("restore", `runtime-secret pointer for '${item.service}' could not be restored (${restored.category})`);
      }
      const registry = await this.deps.loadRegistry(stack);
      const secretServices = await resolveSecretServices(registry, { loadInstance: this.deps.loadInstance });
      const recorded = Object.keys(isRecord(previous.secretServices) ? previous.secretServices : {}).filter((service) => secretServices.has(service));
      const generations = await currentGenerations(secrets, secretServices, recorded);
      const generationsFile = await state.writeGenerationsOverride(generationsOverride(generations));
      const directory = state.releasePath(previous.release);
      const files = [...previous.composeFiles, ...previous.overrideFiles].map((name) => `${directory}/${name}`);
      const envFile = await state.stackEnvironmentFile();
      const up = await docker.up(this.project(stack, directory, [...files, generationsFile], envFile), previous.longRunningServices, { pull: "missing", removeOrphans: true });
      if (!up.ok) fail("restore", `docker compose up of the previous release failed${up.diagnostic ? `: ${up.diagnostic}` : ""}`);
      const health = await this.health(previous.healthServices, previous.healthChecks, previous.healthTimeoutSeconds, stack);
      outcome.health = health;
      if (!health.healthy) fail("restore", `previous release did not become healthy: ${health.reason}`);
      outcome.outcome = "restored";
      outcome.reason = "previous release images and runtime-secret pointers were restored and passed health verification";
      outcome.generations = generations;
    } catch (error) {
      outcome.outcome = "failed";
      outcome.reason = sanitizeError(error).message;
      outcome.manualRecovery = "Inspect `docker compose ps` for the stack on the host, the history record and the previous release directory; see docs/vps-deployment.md#recovery.";
    }
    return outcome;
  }

  /**
   * Prune runtime-secret generations that no pointer retains and no container of
   * this stack references. Containers mounting a service directory without a
   * recorded generation label block pruning for that service (conservative).
   */
  async prune(stack, secretServices, services) {
    const summary = {};
    let labels;
    try { labels = await this.deps.docker.generationLabels(stack, generationLabel); } catch { labels = null; }
    if (labels === null) return { skipped: "container labels unavailable" };
    for (const service of services) {
      const entry = secretServices.get(service);
      try {
        const status = await this.deps.secrets.status(entry.instance);
        const retained = new Set([status.current, status.previous, status.pending, ...labels.filter((item) => item.service === service).map((item) => item.generation)].filter(Boolean));
        const eligible = status.generations.filter((generation) => !retained.has(generation));
        if (eligible.length === 0) { summary[service] = { removed: [] }; continue; }
        const pruned = await this.deps.secrets.prune(entry.instance, eligible);
        summary[service] = pruned.ok ? { removed: eligible } : { removed: [], error: pruned.category };
      } catch {
        summary[service] = { removed: [], error: "status-unavailable" };
      }
    }
    return summary;
  }

  /** Boot-time start of the active release. Fails closed without current secret generations. */
  async start() {
    const { docker, secrets } = this.deps;
    const stack = this.deps.stack;
    const registry = await this.deps.loadRegistry(stack);
    const state = this.deps.createState(registry.deploymentPath);
    await state.verifyRoot();
    const lock = await state.acquireLock({ timeoutSeconds: registry.lockTimeoutSeconds, operation: "start" });
    try {
      const recorded = await state.readActive();
      if (!recorded) return { ok: true, started: false, reason: "no active release is recorded for this stack" };
      const active = validateActiveRecord(recorded);
      const secretServices = await resolveSecretServices(registry, { loadInstance: this.deps.loadInstance });
      for (const service of active.longRunningServices) {
        const entry = secretServices.get(service);
        if (!entry) continue;
        const status = await secrets.status(entry.instance);
        if (!status.current) fail("secrets", `service '${service}' has no current runtime-secret generation; refusing to start (fail closed)`);
      }
      const generations = await currentGenerations(secrets, secretServices, Object.keys(active.secretServices ?? {}).filter((service) => secretServices.has(service)));
      const generationsFile = await state.writeGenerationsOverride(generationsOverride(generations));
      const directory = state.releasePath(active.release);
      const files = [...active.composeFiles, ...active.overrideFiles].map((name) => `${directory}/${name}`);
      const up = await docker.up(this.project(stack, directory, [...files, generationsFile], await state.stackEnvironmentFile()), active.longRunningServices, { pull: "never" });
      if (!up.ok) fail("rollout", `docker compose up failed during start${up.diagnostic ? `: ${up.diagnostic}` : ""}`);
      return { ok: true, started: true, deploymentId: active.deploymentId, generations };
    } finally {
      await lock.release();
    }
  }

  async stop() {
    const registry = await this.deps.loadRegistry(this.deps.stack);
    const state = this.deps.createState(registry.deploymentPath);
    const recorded = await state.readActive();
    if (!recorded) return { ok: true, stopped: false };
    const active = validateActiveRecord(recorded);
    const directory = state.releasePath(active.release);
    const files = [...active.composeFiles, ...active.overrideFiles].map((name) => `${directory}/${name}`);
    const stopped = await this.deps.docker.stop(this.project(this.deps.stack, directory, files, await state.stackEnvironmentFile()));
    if (!stopped) fail("rollout", "docker compose stop failed");
    return { ok: true, stopped: true, deploymentId: active.deploymentId };
  }
}
