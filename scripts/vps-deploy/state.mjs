// Stack-scoped deployment state under the registry-owned deployment root.
//
// <root>/
//   lock                              exclusive stack operation lock
//   active.json                       authoritative active release record (commit point)
//   active-manifest.json              copy of the active immutable manifest
//   previous.json / previous-manifest.json   last superseded successful release
//   manifests/<deployment-id>.json    write-once canonical manifest copies
//   releases/<deployment-id>/<attempt>/   staged Compose files, overrides, request
//   history/deployments.jsonl         append-only sanitized records
//   runtime/generations.override.json derived runtime-secret generation labels
//   stack.env                         optional operator-owned, non-secret interpolation values
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fail, parseJsonStrict } from "./contract.mjs";

const posix = process.platform !== "win32";
const noFollow = posix ? constants.O_NOFOLLOW : 0;
const attemptPattern = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/u;

export class StackState {
  /**
   * expectedUid defaults to root (0) on POSIX. Passing `expectedUid: null`
   * explicitly disables ownership checks for unprivileged test fixtures.
   */
  constructor(root, options = {}) {
    const {
      now = () => new Date(),
      random = () => randomBytes(4).toString("hex"),
      sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      pid = process.pid,
      bootId = readBootId,
      processAlive = defaultProcessAlive,
    } = options;
    this.root = root;
    this.expectedUid = Object.hasOwn(options, "expectedUid") ? options.expectedUid : (posix ? 0 : null);
    this.now = now;
    this.random = random;
    this.sleep = sleep;
    this.pid = pid;
    this.bootId = bootId;
    this.processAlive = processAlive;
  }

  path(...parts) { return join(this.root, ...parts); }

  /** The root is a provisioning prerequisite: it must exist, be a real directory chain and be root-controlled. */
  async verifyRoot() {
    if (posix) {
      let current = "/";
      for (const segment of this.root.split("/").filter(Boolean)) {
        current = join(current, segment);
        const info = await lstat(current).catch((error) => fail("configuration", "deployment root does not exist; provision it before deploying", { cause: error }));
        if (info.isSymbolicLink() || !info.isDirectory()) fail("configuration", "deployment root path must not contain symbolic links");
      }
    }
    const info = await lstat(this.root).catch((error) => fail("configuration", "deployment root does not exist; provision it before deploying", { cause: error }));
    if (!info.isDirectory() || info.isSymbolicLink()) fail("configuration", "deployment root must be a real directory");
    if (posix && this.expectedUid != null && (info.uid !== this.expectedUid || (info.mode & 0o022) !== 0)) {
      fail("configuration", "deployment root must be owned by root and not group/world writable");
    }
  }

  async ensureLayout() {
    await this.verifyRoot();
    for (const name of ["manifests", "releases", "history", "runtime"]) await this.ensureDirectory(this.path(name));
  }

  async ensureDirectory(path) {
    try { await mkdir(path, { mode: 0o750 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) fail("filesystem", "deployment state directory is not a real directory");
    if (posix && this.expectedUid != null && (info.uid !== this.expectedUid || (info.mode & 0o022) !== 0)) fail("filesystem", "deployment state directory has unsafe ownership or permissions");
  }

  /**
   * Exclusive stack lock. A live holder makes later operations wait (bounded);
   * a holder from a previous boot or a dead process is reclaimed.
   */
  async acquireLock({ timeoutSeconds, operation, deploymentId = "" }) {
    const path = this.path("lock");
    const deadline = Date.now() + timeoutSeconds * 1000;
    const owner = JSON.stringify({ pid: this.pid, bootId: await this.bootId(), operation, deploymentId, acquiredAt: this.now().toISOString() });
    let waited = false;
    for (;;) {
      try {
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
        try { await handle.writeFile(`${owner}\n`); await handle.sync(); } finally { await handle.close(); }
        return { waited, release: async () => { await rm(path, { force: true }); } };
      } catch (error) {
        if (error?.code !== "EEXIST") fail("lock", "cannot create the stack lock", { cause: error });
      }
      if (await this.isStale(path)) { await rm(path, { force: true }); continue; }
      if (Date.now() >= deadline) fail("lock", `another operation holds the stack lock; gave up after ${timeoutSeconds} seconds`);
      waited = true;
      await this.sleep(1000);
    }
  }

  async isStale(path) {
    let text;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) fail("lock", "stack lock is not a regular file");
      text = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    let owner;
    try { owner = JSON.parse(text); } catch { return false; }
    if (!owner || !Number.isSafeInteger(owner.pid)) return false;
    const bootId = await this.bootId();
    if (owner.bootId && bootId && owner.bootId !== bootId) return true;
    return !this.processAlive(owner.pid);
  }

  async readJson(name) {
    const path = this.path(name);
    let info;
    try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (info.isSymbolicLink() || !info.isFile()) fail("filesystem", `${name} is not a regular file`);
    try {
      return parseJsonStrict(await readFile(path, "utf8"), name);
    } catch (error) {
      fail("filesystem", `${name} is corrupt; repair deployment state before deploying`, { cause: error });
    }
  }

  readActive() { return this.readJson("active.json"); }
  readPrevious() { return this.readJson("previous.json"); }

  async createRelease(deploymentId) {
    if (typeof deploymentId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(deploymentId)) fail("internal", "invalid deployment id");
    const attempt = `${this.now().toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}-${this.random()}`;
    if (!attemptPattern.test(attempt)) fail("internal", "invalid release attempt identifier");
    const parent = this.path("releases", deploymentId);
    await this.ensureDirectory(parent);
    const path = join(parent, attempt);
    await mkdir(path, { mode: 0o750 });
    return { attempt, path, relative: `releases/${deploymentId}/${attempt}` };
  }

  releasePath(relative) {
    if (typeof relative !== "string" || !/^releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/\d{8}T\d{6}Z-[a-f0-9]{8}$/u.test(relative)) {
      fail("filesystem", "recorded release path is invalid");
    }
    return this.path(...relative.split("/"));
  }

  async writeExclusive(path, content, mode = 0o440) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, mode);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); } finally { await handle.close(); }
  }

  /** Atomic replace through an exclusive temporary file in the same directory. */
  async writeAtomic(path, content, mode = 0o640) {
    const temporary = join(dirname(path), `.tmp-${this.pid}-${this.random()}`);
    await this.writeExclusive(temporary, content, mode);
    try { await rename(temporary, path); } catch (error) { await rm(temporary, { force: true }); throw error; }
    await syncDirectory(dirname(path));
  }

  /** Write-once manifest copy. Re-deploying an id requires byte-identical canonical content. */
  async storeManifest(deploymentId, canonical) {
    const path = this.path("manifests", `${deploymentId}.json`);
    try {
      await this.writeExclusive(path, `${canonical}\n`, 0o444);
      await syncDirectory(dirname(path));
      return { created: true };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) fail("filesystem", "recorded manifest copy is not a regular file");
    const existing = (await readFile(path, "utf8")).replace(/\n$/u, "");
    if (existing !== canonical) fail("validation", "a different manifest was already recorded for this deployment-id; deployment ids are immutable");
    return { created: false };
  }

  /** Commit a healthy release. active.json is the commit point and is written last but one. */
  async commitActive(record, canonicalManifest) {
    const active = await this.readActive();
    if (active) {
      await this.writeAtomic(this.path("previous.json"), `${JSON.stringify(active)}\n`);
      const activeManifest = await readOptional(this.path("active-manifest.json"));
      if (activeManifest !== null) await this.writeAtomic(this.path("previous-manifest.json"), activeManifest);
    }
    await this.writeAtomic(this.path("active.json"), `${JSON.stringify(record)}\n`);
    await this.writeAtomic(this.path("active-manifest.json"), `${canonicalManifest}\n`, 0o444);
  }

  async appendHistory(record) {
    await this.ensureDirectory(this.path("history"));
    const handle = await open(this.path("history", "deployments.jsonl"), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o640);
    try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  }

  async writeGenerationsOverride(content) {
    const path = this.path("runtime", "generations.override.json");
    await this.writeAtomic(path, `${JSON.stringify(content)}\n`);
    return path;
  }

  async stackEnvironmentFile() {
    const path = this.path("stack.env");
    let info;
    try { info = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
    if (info.isSymbolicLink() || !info.isFile()) fail("configuration", "stack.env must be a regular non-symlink file");
    if (posix && this.expectedUid != null && (info.uid !== this.expectedUid || (info.mode & 0o022) !== 0)) fail("configuration", "stack.env must be root-owned and not group/world writable");
    return path;
  }

  async listReleases() {
    const releases = [];
    for (const id of await readdir(this.path("releases")).catch(() => [])) {
      for (const attempt of await readdir(this.path("releases", id)).catch(() => [])) releases.push(`releases/${id}/${attempt}`);
    }
    return releases.sort();
  }
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function syncDirectory(path) {
  if (!posix) return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readBootId() {
  try { return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); } catch { return ""; }
}

function defaultProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function pathExists(path) {
  try { await stat(path); return true; } catch { return false; }
}
