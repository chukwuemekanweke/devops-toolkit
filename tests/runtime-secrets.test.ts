import { chmod, chown, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateInstance, validateManifest, validatePayload } from "../scripts/runtime-secrets/config.mjs";
import { parseStrictJson } from "../scripts/runtime-secrets/json.mjs";
import { classifyProviderFailure, ProviderProcessError, retrieveDoppler } from "../scripts/runtime-secrets/provider.mjs";
import { GenerationStore } from "../scripts/runtime-secrets/store.mjs";

const baseManifest = () => validateManifest({
  version: 1,
  secrets: [
    { name: "DATABASE__PASSWORD", required: true, allowEmpty: false, maxBytes: 32 },
    { name: "OPTIONAL__TOKEN", required: false, allowEmpty: true, maxBytes: 32 },
  ],
});

function instance(root: string) {
  return validateInstance({
    version: 1,
    application: "example",
    environment: "prd",
    service: "webapi",
    expectedDopplerProject: "example",
    expectedDopplerConfig: "prd_webapi",
    outputDirectory: join(root, "example", "prd", "webapi"),
    serviceGroupId: Math.max(process.getgid?.() ?? 1, 1),
    keyManifestPath: join(root, "keys.json"),
    providerRetries: 0,
  }, { generationRoot: root, manifestRoot: root });
}

async function temporaryRoot() {
  const root = join(tmpdir(), `runtime-secrets-${process.pid}-${crypto.randomUUID()}`);
  await mkdir(join(root, "example", "prd"), { recursive: true, mode: 0o755 });
  return root;
}

describe("runtime secret contracts", () => {
  it("accepts a scoped string payload and removes metadata", () => {
    const root = "/run/runtime-secrets";
    const values = validatePayload({ DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi", DOPPLER_ENVIRONMENT: "prd", DATABASE__PASSWORD: "synthetic" }, instance(root), baseManifest());
    expect([...values]).toEqual([["DATABASE__PASSWORD", "synthetic"]]);
  });

  it.each([
    ["missing required", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi" }, /missing/u],
    ["unknown key", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi", DATABASE__PASSWORD: "x", EXTRA: "x" }, /unapproved/u],
    ["empty rejected", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi", DATABASE__PASSWORD: "" }, /empty/u],
    ["oversized", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi", DATABASE__PASSWORD: "x".repeat(33) }, /byte limit/u],
    ["wrong project", { DOPPLER_PROJECT: "other", DOPPLER_CONFIG: "prd_webapi", DATABASE__PASSWORD: "x" }, /project/u],
    ["wrong config", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_jobs", DATABASE__PASSWORD: "x" }, /config/u],
    ["non-string", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi", DATABASE__PASSWORD: 2 }, /not a string/u],
    ["reserved metadata", { DOPPLER_PROJECT: "example", DOPPLER_CONFIG: "prd_webapi", DOPPLER_TOKEN: "x", DATABASE__PASSWORD: "x" }, /reserved/u],
  ])("rejects %s", (_label, payload, message) => {
    expect(() => validatePayload(payload, instance("/run/runtime-secrets"), baseManifest())).toThrow(message);
  });

  it("rejects malformed and duplicate JSON without echoing values", () => {
    expect(() => parseStrictJson('{"A":"secret","A":"other"}', "payload")).toThrow(/duplicate/u);
    expect(() => parseStrictJson('{"A":', "payload")).toThrow(/valid JSON/u);
    try { parseStrictJson('{"A":"secret","A":"other"}', "payload"); } catch (error) { expect(String(error)).not.toContain("other"); }
  });

  it("rejects unsafe names, traversal, unknown fields and duplicate manifest keys", () => {
    expect(() => validateManifest({ version: 1, secrets: [{ name: "../TOKEN", required: true, allowEmpty: false }] })).toThrow(/safe/u);
    expect(() => validateManifest({ version: 1, secrets: [{ name: "TOKEN", required: true, allowEmpty: false }, { name: "TOKEN", required: false, allowEmpty: true }] })).toThrow(/duplicate/u);
    expect(() => validateInstance({ ...instance("/run/runtime-secrets"), outputDirectory: "/run/runtime-secrets/example/prd/../jobs" }, { generationRoot: "/run/runtime-secrets", manifestRoot: "/run/runtime-secrets" })).toThrow(/outputDirectory/u);
    expect(() => validateInstance({ ...instance("/run/runtime-secrets"), surprise: true }, { generationRoot: "/run/runtime-secrets", manifestRoot: "/run/runtime-secrets" })).toThrow(/unknown/u);
  });
});

describe.skipIf(process.platform === "win32")("generation lifecycle", () => {
  it("renders exact bytes, atomically activates, restores, discards and prunes", async () => {
    const root = await temporaryRoot();
    try {
      let suffix = 0;
      const store = new GenerationStore(instance(root), { now: () => new Date("2026-11-21T12:00:00Z"), random: () => (++suffix).toString(16).padStart(8, "0") });
      const first = await store.render(new Map([["DATABASE__PASSWORD", "first"]]));
      expect(await readFile(join(instance(root).outputDirectory, first.generation, "DATABASE__PASSWORD"), "utf8")).toBe("first");
      if (process.platform !== "win32") expect((await lstat(join(instance(root).outputDirectory, first.generation, "DATABASE__PASSWORD"))).mode & 0o777).toBe(0o440);
      await store.activate();
      const second = await store.render(new Map([["DATABASE__PASSWORD", "second\ninside"]]));
      await store.activate();
      expect(await readlink(join(instance(root).outputDirectory, "current"))).toBe(second.generation);
      await store.restore();
      expect(await readlink(join(instance(root).outputDirectory, "current"))).toBe(first.generation);
      const third = await store.render(new Map([["DATABASE__PASSWORD", "third"]]));
      await store.discard();
      expect((await lstat(join(instance(root).outputDirectory, third.generation))).isDirectory()).toBe(true);
      await store.render(new Map([["DATABASE__PASSWORD", "fourth"]]));
      await store.activate();
      const result = await store.prune([second.generation]);
      expect(result.removed).toEqual([second.generation]);
      expect((await store.prune([third.generation])).removed).toEqual([third.generation]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("leaves current unchanged and removes an interrupted generation", async () => {
    const root = await temporaryRoot();
    try {
      let fail = false;
      let suffix = 0;
      const store = new GenerationStore(instance(root), { now: () => new Date("2026-11-21T12:00:00Z"), random: () => (++suffix).toString(16).padStart(8, "0"), beforePublish: async () => { if (fail) throw new Error("simulated interruption"); } });
      const current = await store.render(new Map([["DATABASE__PASSWORD", "stable"]]));
      await store.activate();
      fail = true;
      await expect(store.render(new Map([["DATABASE__PASSWORD", "never-published"]]))).rejects.toThrow(/interruption/u);
      expect((await store.status()).current).toBe(current.generation);
      expect((await store.status()).generations).toEqual([current.generation]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("serializes operations and rejects unsafe pointers and retained pruning", async () => {
    const root = await temporaryRoot();
    try {
      const store = new GenerationStore(instance(root));
      const active = store.withLock(async () => await new Promise((resolve) => setTimeout(resolve, 30)));
      await new Promise((resolve) => setTimeout(resolve, 5));
      await expect(store.withLock(async () => undefined)).rejects.toThrow(/operation is active/u);
      await active;
      const rendered = await store.render(new Map([["DATABASE__PASSWORD", "x"]]));
      await expect(store.prune([rendered.generation])).rejects.toThrow(/retained/u);
      await rm(join(instance(root).outputDirectory, "pending"));
      await symlink("../../unsafe", join(instance(root).outputDirectory, "pending"));
      await expect(store.status()).rejects.toThrow(/Invalid generation/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers a lock left by a terminated operation", async () => {
    const root = await temporaryRoot();
    try {
      const store = new GenerationStore(instance(root));
      await store.status();
      const lock = join(instance(root).outputDirectory, ".operation-lock");
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, "owner"), "2147483647\n", { mode: 0o600 });
      await expect(store.withLock(async () => "recovered")).resolves.toBe("recovered");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects incorrect existing directory permissions", async () => {
    if (process.platform === "win32") return;
    const root = await temporaryRoot();
    try {
      const output = instance(root).outputDirectory;
      await mkdir(output, { recursive: true, mode: 0o755 });
      await chmod(output, 0o755);
      await expect(new GenerationStore(instance(root)).status()).rejects.toThrow(/unsafe permissions/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects incorrect ownership and symlinked output parents", async () => {
    if (process.platform === "win32" || process.getuid?.() !== 0) return;
    const ownershipRoot = await temporaryRoot();
    const symlinkRoot = await temporaryRoot();
    try {
      const output = instance(ownershipRoot).outputDirectory;
      await mkdir(output, { mode: 0o700 });
      await chown(output, 0, instance(ownershipRoot).serviceGroupId + 1);
      await expect(new GenerationStore(instance(ownershipRoot)).status()).rejects.toThrow(/incorrect ownership/u);

      const parent = join(symlinkRoot, "example", "prd");
      const target = join(symlinkRoot, "target");
      await rm(parent, { recursive: true });
      await mkdir(target, { mode: 0o755 });
      await symlink(target, parent, "dir");
      await expect(new GenerationStore(instance(symlinkRoot)).status()).rejects.toThrow(/parent is unsafe/u);
    } finally {
      await rm(ownershipRoot, { recursive: true, force: true });
      await rm(symlinkRoot, { recursive: true, force: true });
    }
  });
});

describe("provider failures", () => {
  it.each([
    ["invalid or revoked token", "403 revoked token", { authentication: true, transient: false }],
    ["provider outage", "503 connection unavailable", { authentication: false, transient: true }],
    ["rate limiting", "429 rate limit", { authentication: false, transient: true }],
    ["timeout", "request timed out", { authentication: false, transient: true }],
    ["other failure", "bad request", { authentication: false, transient: false }],
  ])("classifies %s without retaining provider text", (_label, text, expected) => {
    expect(classifyProviderFailure(text)).toEqual(expected);
  });

  it("fails closed when the service-token credential is missing", async () => {
    await expect(retrieveDoppler(instance("/run/runtime-secrets"), { credentialPath: join(tmpdir(), crypto.randomUUID()) })).rejects.toMatchObject({ category: "authentication" });
  });

  it("bounds transient retries and never retries authentication failure", async () => {
    const root = await temporaryRoot();
    const credential = join(root, "credential");
    await writeFile(credential, "synthetic-token", { mode: 0o400 });
    try {
      let attempts = 0;
      const configured = { ...instance("/run/runtime-secrets"), providerRetries: 2 };
      await expect(retrieveDoppler(configured, {
        credentialPath: credential,
        sleep: async () => undefined,
        downloadImpl: async () => { attempts += 1; throw new ProviderProcessError("outage", true, false); },
      })).rejects.toMatchObject({ category: "provider" });
      expect(attempts).toBe(3);

      attempts = 0;
      await expect(retrieveDoppler(configured, {
        credentialPath: credential,
        sleep: async () => undefined,
        downloadImpl: async () => { attempts += 1; throw new ProviderProcessError("revoked", false, true); },
      })).rejects.toMatchObject({ category: "authentication" });
      expect(attempts).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
