import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeploymentEngine } from "../scripts/vps-deploy/engine.mjs";
import { generationLabel } from "../scripts/vps-deploy/compose-policy.mjs";
import { validateRegistry } from "../scripts/vps-deploy/registry.mjs";
import { StackState } from "../scripts/vps-deploy/state.mjs";
import { commit, digest, manifestObject, requestObject } from "./helpers/vps-deploy-fixtures.js";

type Entry = { id: string; service: string; state: string; health: string; exitCode: number | null; oneOff: boolean };
type Op = { ok: boolean; category?: string };

const stack = "example-backend-production";
const instances: Record<string, { service: string; application: string; environment: string; outputDirectory: string }> = {
  "exb-prd-api": { service: "webapi", application: "example-backend", environment: "prd", outputDirectory: "/run/runtime-secrets/example-backend/prd/webapi" },
  "exb-prd-mig": { service: "database-migrator", application: "example-backend", environment: "prd", outputDirectory: "/run/runtime-secrets/example-backend/prd/database-migrator" },
};

function makeRegistry(overrides: Record<string, unknown> = {}) {
  return validateRegistry({
    version: 1,
    stackName: stack,
    environment: "production",
    deploymentPath: "/srv/example-backend/production",
    allowedSourceRepositories: ["example/backend"],
    allowedImageRepositories: ["docker.io/example/"],
    runtimeSecrets: { services: { webapi: { instance: "exb-prd-api" }, "database-migrator": { instance: "exb-prd-mig", startAtBoot: false } } },
    lockTimeoutSeconds: 30,
    ...overrides,
  });
}

/** Compose model derived from the generated images override, as docker compose config would produce. */
function composeModel(files: string[], { allProfiles, secretMounts = true }: { allProfiles: boolean; secretMounts?: boolean }) {
  const override = files.find((file) => file.endsWith("images.override.json"));
  const images = override ? JSON.parse(readFileSync(override, "utf8")).services as Record<string, { image: string }> : {};
  const mount = (service: string) => ({ type: "bind", source: `/run/runtime-secrets/example-backend/prd/${service}/current`, target: "/run/secrets/app", read_only: true, bind: { create_host_path: false } });
  const services: Record<string, Record<string, unknown>> = {
    webapi: { image: images.webapi?.image, restart: "no", security_opt: ["no-new-privileges:true"], volumes: secretMounts ? [mount("webapi")] : [] },
    worker: { image: `docker.io/library/busybox@${digest("e")}`, user: "10002" },
  };
  if (allProfiles) services["database-migrator"] = { image: images["database-migrator"]?.image, restart: "no", security_opt: ["no-new-privileges:true"], volumes: secretMounts ? [mount("database-migrator")] : [] };
  return { services };
}

class FakeSecrets {
  pointers = new Map<string, { current: string | null; previous: string | null; pending: string | null; generations: string[] }>();
  calls: string[] = [];
  failures = new Map<string, Op>();
  counter = 0;

  state(id: string) {
    if (!this.pointers.has(id)) this.pointers.set(id, { current: null, previous: null, pending: null, generations: [] });
    return this.pointers.get(id)!;
  }

  async status(id: string) { const s = this.state(id); return { ...s, generations: [...s.generations] }; }

  async render(id: string): Promise<Op> {
    this.calls.push(`render:${id}`);
    const failure = this.failures.get(`render:${id}`);
    if (failure) return failure;
    const s = this.state(id);
    if (s.pending) return { ok: false, category: "conflict" };
    this.counter += 1;
    s.pending = `gen-20261122T0000${String(this.counter).padStart(2, "0")}Z-${String(this.counter).padStart(8, "0")}`;
    s.generations.push(s.pending);
    return { ok: true };
  }

  async activate(id: string): Promise<Op> {
    this.calls.push(`activate:${id}`);
    const failure = this.failures.get(`activate:${id}`);
    if (failure) return failure;
    const s = this.state(id);
    if (!s.pending) return { ok: false, category: "conflict" };
    if (s.current) s.previous = s.current;
    s.current = s.pending;
    s.pending = null;
    return { ok: true };
  }

  async discard(id: string): Promise<Op> { this.calls.push(`discard:${id}`); this.state(id).pending = null; return { ok: true }; }

  async restore(id: string): Promise<Op> {
    this.calls.push(`restore:${id}`);
    const failure = this.failures.get(`restore:${id}`);
    if (failure) return failure;
    const s = this.state(id);
    if (!s.previous || !s.current) return { ok: false, category: "conflict" };
    [s.current, s.previous] = [s.previous, s.current];
    return { ok: true };
  }

  async prune(id: string, generations: string[]): Promise<Op> {
    this.calls.push(`prune:${id}:${generations.join(",")}`);
    const s = this.state(id);
    s.generations = s.generations.filter((item) => !generations.includes(item));
    return { ok: true };
  }
}

class FakeDocker {
  calls: unknown[][] = [];
  pullFailures = new Set<string>();
  configFailure = false;
  migration: { timedOut: boolean; exitCode: number | null } = { timedOut: false, exitCode: 0 };
  healthByDirectory = new Map<string, string>();
  running: { directory: string; generations: Record<string, string> } | null = null;
  containerId = 0;
  ids = new Map<string, string>();
  credentials: unknown = undefined;
  credentialHistory: unknown[] = [];
  pullGate: Promise<void> | null = null;
  defaultHealth = "healthy";
  upFailure = false;
  secretMounts = true;

  async useCredentials(credentials: unknown) { this.credentials = credentials; this.credentialHistory.push(credentials); }
  async forgetCredentials() { this.credentials = undefined; }
  async pull(reference: string) {
    this.calls.push(["pull", reference]);
    if (this.pullGate) await this.pullGate;
    return !this.pullFailures.has(reference);
  }
  async imageUser() { return "10001"; }
  async config(project: { files: string[] }, { allProfiles = false } = {}) {
    this.calls.push(["config", allProfiles]);
    if (this.configFailure) {
      const { DeployError } = await import("../scripts/vps-deploy/contract.mjs");
      throw new DeployError("compose", "docker compose config rejected the configuration: services.webapi.ports must be a list");
    }
    return composeModel(project.files, { allProfiles, secretMounts: this.secretMounts });
  }
  async up(project: { directory: string; files: string[] }, services: string[], options: Record<string, unknown>) {
    this.calls.push(["up", project.directory, services, options]);
    if (this.upFailure) return { ok: false, code: 1, timedOut: false, diagnostic: "" };
    const generationsFile = project.files.find((file) => file.endsWith("generations.override.json"));
    const generations = generationsFile ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(generationsFile, "utf8")).services as Record<string, { labels: Record<string, string> }>).map(([service, value]) => [service, value.labels[generationLabel]!])) : {};
    for (const service of services) {
      const key = `${service}:${project.directory}:${generations[service] ?? ""}`;
      const previousKey = this.ids.get(`${service}:key`);
      if (previousKey !== key) { this.containerId += 1; this.ids.set(service, `c${this.containerId}`); this.ids.set(`${service}:key`, key); }
    }
    this.running = { directory: project.directory, generations };
    return { ok: true, code: 0, timedOut: false, diagnostic: "" };
  }
  async stop() { this.calls.push(["stop"]); return true; }
  async runOneShot(_project: unknown, service: string, name: string, options: { timeoutMs: number }) {
    this.calls.push(["run", service, name, options.timeoutMs]);
    return { ...this.migration, created: true, running: false };
  }
  async removeContainer(name: string) { this.calls.push(["rm", name]); return true; }
  async oneShotContainers() { return []; }
  async ps(): Promise<Entry[]> {
    if (!this.running) return [];
    const health = this.healthByDirectory.get(this.running.directory) ?? this.defaultHealth;
    return ["webapi", "worker"].map((service) => ({ id: this.ids.get(service) ?? "", service, state: "running", health: service === "webapi" ? health : "", exitCode: null, oneOff: false }));
  }
  async generationLabels() {
    return this.running ? Object.entries(this.running.generations).map(([service, generation]) => ({ service, generation })) : [];
  }
}

function harness({ registryOverrides = {}, root = mkdtempSync(join(tmpdir(), "vps-deploy-engine-")) } = {}) {
  let clock = Date.parse("2026-11-22T00:00:00Z");
  const docker = new FakeDocker();
  const secrets = new FakeSecrets();
  const progress: string[] = [];
  const registry = makeRegistry(registryOverrides);
  const engine = new DeploymentEngine({
    stack,
    docker,
    secrets,
    loadRegistry: async () => registry,
    loadInstance: async (id: string) => instances[id],
    createState: () => new StackState(root, { expectedUid: null, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); } }),
    now: () => new Date(clock),
    sleep: async (ms: number) => { clock += ms; },
    healthIntervalMs: 1000,
    progress: (event: { phase: string }) => progress.push(event.phase),
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  return { engine, docker, secrets, root, progress, advance: (ms: number) => { clock += ms; } };
}

function envelope(request: Record<string, unknown> = {}, manifest: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: 1,
    request: requestObject({ healthChecks: [], ...request }),
    manifest: JSON.stringify(manifestObject(manifest)),
    registry: { username: "deploy-reader", token: "dckr_pat_synthetic" },
    ...extra,
  });
}

const secondId = "1111111111111111111111111111111111111111";
function secondRelease() {
  return {
    request: { deploymentId: secondId },
    manifest: { deployment_id: secondId, components: [
      { name: "webapi", image: "docker.io/example/backend-webapi", digest: digest("f") },
      { name: "migrator", image: "docker.io/example/backend-migrator", digest: digest("9") },
    ] },
  };
}

function readJson(path: string) { return JSON.parse(readFileSync(path, "utf8")); }
function history(root: string) {
  const path = join(root, "history", "deployments.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("vps-deploy engine", () => {
  it("completes a valid first deployment", async () => {
    const { engine, docker, secrets, root, progress } = harness();
    const result = await engine.deploy(envelope());
    expect(result.failure).toBeNull();
    expect(result).toMatchObject({ ok: true, status: "succeeded", deployedId: commit, previousDeploymentId: "" });
    expect(progress).toEqual(["validate", "lock", "stage", "pull", "secrets", "migration", "rollout", "health", "commit"]);
    const active = readJson(join(root, "active.json"));
    expect(active).toMatchObject({ deploymentId: commit, migrationService: "database-migrator", longRunningServices: ["webapi", "worker"] });
    expect(active.generations.webapi).toMatch(/^gen-/u);
    expect(readFileSync(join(root, "manifests", `${commit}.json`), "utf8")).toContain(digest("a"));
    expect(existsSync(join(root, "lock"))).toBe(false);
    expect(history(root)).toHaveLength(1);
    expect(docker.calls.filter((call) => call[0] === "pull").map((call) => call[1])).toContain(`docker.io/example/backend-webapi@${digest("a")}`);
    expect(secrets.calls.indexOf("activate:exb-prd-mig")).toBeLessThan(secrets.calls.indexOf("activate:exb-prd-api"));
    expect(docker.calls.findIndex((call) => call[0] === "run")).toBeLessThan(docker.calls.findIndex((call) => call[0] === "up"));
    expect(docker.credentials).toBeUndefined();
    const historyText = readFileSync(join(root, "history", "deployments.jsonl"), "utf8");
    expect(historyText).not.toContain("dckr_pat_synthetic");
    expect(historyText).not.toContain("deploy-reader");
  });

  it("activates a subsequent release and preserves the previous record", async () => {
    const { engine, root } = harness();
    await engine.deploy(envelope());
    const next = secondRelease();
    const result = await engine.deploy(envelope(next.request, next.manifest));
    expect(result).toMatchObject({ status: "succeeded", deployedId: secondId, previousDeploymentId: commit });
    expect(readJson(join(root, "active.json")).deploymentId).toBe(secondId);
    expect(readJson(join(root, "previous.json")).deploymentId).toBe(commit);
    expect(readFileSync(join(root, "previous-manifest.json"), "utf8")).toContain(commit);
    expect(history(root).map((item) => item.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("recreates secret-bearing containers when generations change", async () => {
    const { engine, docker } = harness();
    await engine.deploy(envelope());
    const webapiBefore = docker.ids.get("webapi");
    const generationsBefore = { ...docker.running!.generations };
    await engine.deploy(envelope());
    expect(docker.running!.generations.webapi).not.toBe(generationsBefore.webapi);
    expect(docker.ids.get("webapi")).not.toBe(webapiBefore);
  });

  it.each([
    ["invalid manifest", () => envelope({}, { schema_version: "9.9" }), /unsupported/u],
    ["missing image digest", () => envelope({}, { components: [{ name: "webapi", image: "docker.io/example/backend-webapi" }] }), /digest/u],
    ["mismatched deployment", () => envelope({ deploymentId: secondId }), /does not match/u],
    ["unbound stack", () => envelope({ stackName: "example-frontend-production" }), /bound to this deploy identity/u],
    ["registry path mismatch", () => envelope({ remoteDeploymentPath: "/srv/example-frontend/production" }), /registry/u],
    ["environment mismatch", () => envelope({ environment: "staging" }), /registry/u],
    ["unauthorized health host", () => envelope({ healthChecks: [{ name: "metadata", url: "http://169.254.169.254/latest" }] }), /does not allow/u],
    ["malicious compose", () => envelope({ composeFiles: [{ path: "deploy/compose.yml", content: "include:\n  - /etc/shadow\n" }] }), /include/u],
    ["oversized token", () => envelope({}, {}, { registry: { username: "u", token: "x y" } }), /registry-token/u],
  ])("rejects %s before any remote mutation", async (_label, build, message) => {
    const { engine, root, secrets } = harness();
    const result = await engine.deploy(build());
    expect(result.status).toBe("failed");
    expect(result.failedPhase).toBe("validate");
    expect(result.failure.message).toMatch(message);
    expect(readdirSync(root)).toEqual([]);
    expect(secrets.calls).toEqual([]);
  });

  it("leaves the running application unchanged when an image pull fails", async () => {
    const { engine, docker, secrets, root } = harness();
    await engine.deploy(envelope());
    const running = docker.running;
    const next = secondRelease();
    docker.pullFailures.add(`docker.io/example/backend-webapi@${digest("f")}`);
    const result = await engine.deploy(envelope(next.request, next.manifest));
    expect(result).toMatchObject({ status: "failed", failedPhase: "pull" });
    expect(result.restoration.outcome).toBe("not-required");
    expect(docker.running).toBe(running);
    expect(secrets.calls.filter((call) => call.startsWith("render")).length).toBe(2);
    expect(readJson(join(root, "active.json")).deploymentId).toBe(commit);
  });

  it("fails before rollout on invalid Compose configuration", async () => {
    const { engine, docker } = harness();
    docker.configFailure = true;
    const result = await engine.deploy(envelope());
    expect(result).toMatchObject({ status: "failed", failedPhase: "stage" });
    expect(result.failure.message).toMatch(/ports must be a list/u);
    expect(docker.calls.some((call) => call[0] === "up")).toBe(false);
  });

  it.each([
    ["missing required runtime secret", "validation"],
    ["Doppler render failure", "provider"],
  ])("rejects deployment on %s and keeps running services", async (_label, category) => {
    const { engine, docker, secrets, root } = harness();
    await engine.deploy(envelope());
    const running = docker.running;
    const currentBefore = (await secrets.status("exb-prd-api")).current;
    secrets.failures.set("render:exb-prd-mig", { ok: false, category });
    const result = await engine.deploy(envelope());
    expect(result).toMatchObject({ status: "failed", failedPhase: "secrets" });
    expect(result.failure.message).toContain(category);
    expect(docker.running).toBe(running);
    expect((await secrets.status("exb-prd-api")).current).toBe(currentBefore);
    expect((await secrets.status("exb-prd-api")).pending).toBeNull();
    expect(readJson(join(root, "active.json")).deploymentId).toBe(commit);
  });

  it.each([
    ["failure", { timedOut: false, exitCode: 1 }, /exited with status 1/u],
    ["timeout", { timedOut: true, exitCode: null }, /did not finish within 600 seconds/u],
  ])("blocks application rollout on migration %s", async (_label, migration, message) => {
    const { engine, docker, secrets } = harness();
    await engine.deploy(envelope());
    const running = docker.running;
    const apiCurrent = (await secrets.status("exb-prd-api")).current;
    docker.migration = migration;
    const result = await engine.deploy(envelope());
    expect(result).toMatchObject({ status: "failed", failedPhase: "migration" });
    expect(result.failure.message).toMatch(message);
    expect(result.migration.container).toMatch(/migration/u);
    expect(docker.running).toBe(running);
    expect((await secrets.status("exb-prd-api")).current).toBe(apiCurrent);
    expect(docker.calls.filter((call) => call[0] === "run").at(-1)?.[3]).toBe(600_000);
  });

  it("skips the migration stage entirely when no migration service is configured", async () => {
    const { engine, docker } = harness({ registryOverrides: { runtimeSecrets: undefined } });
    docker.secretMounts = false;
    const result = await engine.deploy(envelope({ migrationService: "", componentServiceMap: { migrator: "database-migrator" } }));
    expect(result.failure).toBeNull();
    expect(result.migration).toEqual({ configured: false });
    expect(docker.calls.some((call) => call[0] === "run")).toBe(false);
  });

  it("restores the previous release after an unhealthy rollout and still reports failure", async () => {
    const { engine, docker, secrets, root } = harness();
    await engine.deploy(envelope());
    const previousDirectory = docker.running!.directory;
    const previousGeneration = (await secrets.status("exb-prd-api")).current;
    docker.defaultHealth = "unhealthy";
    docker.healthByDirectory.set(previousDirectory, "healthy");
    const next = secondRelease();
    const result = await engine.deploy(envelope(next.request, next.manifest));
    expect(result.ok).toBe(false);
    expect(result.status).toBe("restored-after-failure");
    expect(result.failedPhase).toBe("health");
    expect(result.restoration).toMatchObject({ attempted: true, outcome: "restored", targetDeploymentId: commit });
    expect(secrets.calls).toContain("restore:exb-prd-api");
    expect((await secrets.status("exb-prd-api")).current).toBe(previousGeneration);
    expect(docker.running!.directory).toBe(previousDirectory);
    const lastUp = docker.calls.filter((call) => call[0] === "up").at(-1)!;
    expect(lastUp[3]).toMatchObject({ pull: "missing", removeOrphans: true });
    expect(readJson(join(root, "active.json")).deploymentId).toBe(commit);
    expect(history(root).at(-1)).toMatchObject({ status: "restored-after-failure", deploymentId: secondId });
  });

  it("reports an explicit failure with diagnostics when restoration also fails", async () => {
    const { engine, docker, root } = harness();
    await engine.deploy(envelope());
    docker.defaultHealth = "unhealthy";
    const next = secondRelease();
    const result = await engine.deploy(envelope(next.request, next.manifest));
    expect(result.status).toBe("failed");
    expect(result.restoration.outcome).toBe("failed");
    expect(result.restoration.reason).toMatch(/did not become healthy/u);
    expect(result.restoration.manualRecovery).toMatch(/recovery/u);
    expect(history(root).at(-1).restoration.outcome).toBe("failed");
  });

  it("does not invent a rollback target for a failed initial deployment", async () => {
    const { engine, docker, secrets } = harness();
    docker.defaultHealth = "unhealthy";
    const result = await engine.deploy(envelope());
    expect(result.status).toBe("failed");
    expect(result.restoration.outcome).toBe("no-previous-release");
    expect(secrets.calls.some((call) => call.startsWith("restore"))).toBe(false);
  });

  it("honours rollback-on-health-failure: false", async () => {
    const { engine, docker, secrets } = harness();
    await engine.deploy(envelope());
    docker.defaultHealth = "unhealthy";
    const result = await engine.deploy(envelope({ rollbackOnHealthFailure: false }));
    expect(result.restoration.outcome).toBe("disabled");
    expect(secrets.calls.some((call) => call.startsWith("restore"))).toBe(false);
  });

  it("treats a failed compose up as a rollout failure eligible for restoration", async () => {
    const { engine, docker } = harness();
    await engine.deploy(envelope());
    docker.upFailure = true;
    const result = await engine.deploy(envelope());
    expect(result.failedPhase).toBe("rollout");
    expect(result.restoration.attempted).toBe(true);
  });

  it("rejects re-use of a deployment id with different manifest content", async () => {
    const { engine } = harness();
    await engine.deploy(envelope());
    const result = await engine.deploy(envelope({}, { build_reference: "https://github.com/example/backend/actions/runs/99" }));
    expect(result.failure.message).toMatch(/immutable/u);
  });

  it("serializes concurrent deployments to the same stack", async () => {
    const root = mkdtempSync(join(tmpdir(), "vps-deploy-concurrent-"));
    const first = harness({ root });
    const second = harness({ root });
    let release!: () => void;
    first.docker.pullGate = new Promise((resolve) => { release = resolve; });
    const firstRun = first.engine.deploy(envelope());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const secondRun = second.engine.deploy(envelope());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(second.docker.calls.length).toBe(0);
    release();
    const [a, b] = await Promise.all([firstRun, secondRun]);
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
    expect(b.lockWaited).toBe(true);
    expect(b.previousDeploymentId).toBe(commit);
  });

  it("keeps separate stacks independent", async () => {
    const backend = harness();
    const frontend = harness();
    let release!: () => void;
    backend.docker.pullGate = new Promise((resolve) => { release = resolve; });
    const backendRun = backend.engine.deploy(envelope());
    const frontendResult = await frontend.engine.deploy(envelope());
    expect(frontendResult.status).toBe("succeeded");
    expect(frontendResult.lockWaited).toBe(false);
    release();
    expect((await backendRun).status).toBe("succeeded");
    expect(backend.root).not.toBe(frontend.root);
  });

  it("prunes only unreferenced runtime-secret generations after success", async () => {
    const { engine, secrets } = harness();
    await engine.deploy(envelope());
    await engine.deploy(envelope());
    await engine.deploy(envelope());
    const status = await secrets.status("exb-prd-api");
    expect(status.generations).toContain(status.current);
    expect(status.generations).toContain(status.previous);
    expect(status.generations).toHaveLength(2);
  });

  it("starts the active release at boot only when required generations exist", async () => {
    const { engine, docker, secrets } = harness();
    await engine.deploy(envelope());
    expect((await engine.start()).started).toBe(true);
    secrets.pointers.get("exb-prd-api")!.current = null; // tmpfs lost and initialization failed
    await expect(engine.start()).rejects.toThrow(/fail closed/u);
    expect(docker.calls.filter((call) => call[0] === "up").length).toBe(2);
  });
});
