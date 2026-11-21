import { constants } from "node:fs";
import {
  chmod, chown, lstat, mkdir, open, readFile, readlink, readdir, rename, rm, symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { ExitCode, fail } from "./errors.mjs";
import { secretNamePattern } from "./config.mjs";

const generationPattern = /^gen-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/u;
const pointerNames = new Set(["current", "previous", "pending"]);

export class GenerationStore {
  constructor(instance, { now = () => new Date(), random = () => randomBytes(4).toString("hex"), beforePublish = async () => {} } = {}) {
    this.instance = instance;
    this.output = instance.outputDirectory;
    this.now = now;
    this.random = random;
    this.beforePublish = beforePublish;
  }

  async initialize() {
    await assertSafeAncestors(this.output);
    let created = false;
    try {
      await mkdir(this.output, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await rejectSymlink(this.output, "service output directory");
    if (created && process.platform !== "win32") await chown(this.output, process.getuid(), this.instance.serviceGroupId);
    if (created) await chmod(this.output, 0o700);
    const stat = await lstat(this.output);
    if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)) {
      fail("filesystem", "Service output directory has unsafe permissions", ExitCode.FILESYSTEM);
    }
    if (process.platform !== "win32" && (stat.uid !== process.getuid() || stat.gid !== this.instance.serviceGroupId)) {
      fail("filesystem", "Service output directory has incorrect ownership", ExitCode.FILESYSTEM);
    }
    if (process.platform === "win32") return { base: this.output, handle: null };
    const handle = await open(this.output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      await handle.close();
      fail("filesystem", "Service output directory changed during validation", ExitCode.FILESYSTEM);
    }
    return { base: `/proc/self/fd/${handle.fd}`, handle };
  }

  async withLock(operation) {
    const directory = await this.initialize();
    const lockPath = join(directory.base, ".operation-lock");
    try {
      await acquireLock(lockPath);
    } catch (error) {
      await directory.handle?.close();
      if (error?.code === "EEXIST") fail("conflict", "Another runtime-secrets operation is active", ExitCode.CONFLICT);
      fail("filesystem", "Cannot acquire the service operation lock", ExitCode.FILESYSTEM, { cause: error });
    }
    try {
      return await operation(directory.base);
    } finally {
      await rm(lockPath, { recursive: true, force: true });
      await directory.handle?.close();
    }
  }

  async render(secrets) {
    return await this.withLock(async (base) => {
      if (await this.pointer("pending", base)) fail("conflict", "A pending generation already exists", ExitCode.CONFLICT);
      const generation = makeGenerationId(this.now(), this.random());
      const path = join(base, generation);
      let created = false;
      try {
        await mkdir(path, { mode: 0o700 });
        created = true;
        for (const [name, value] of [...secrets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          if (!secretNamePattern.test(name) || name.startsWith("DOPPLER_") || basename(name) !== name) {
            fail("validation", "Secret map contains an unsafe key", ExitCode.VALIDATION);
          }
          await writeExclusive(join(path, name), value, this.instance.serviceGroupId, 0o440);
        }
        const metadata = JSON.stringify({
          version: 1,
          generation,
          createdAt: this.now().toISOString(),
          application: this.instance.application,
          environment: this.instance.environment,
          service: this.instance.service,
          dopplerProject: this.instance.expectedDopplerProject,
          dopplerConfig: this.instance.expectedDopplerConfig,
          keyCount: secrets.size,
          healthVerified: false,
        });
        await writeExclusive(join(path, ".metadata.json"), `${metadata}\n`, this.instance.serviceGroupId, 0o440);
        if (process.platform !== "win32") await chown(path, process.getuid(), this.instance.serviceGroupId);
        await chmod(path, 0o550);
        await this.beforePublish({ generation, path });
        await this.replacePointer("pending", generation, base);
        return { operation: "render", generation, pointer: "pending", keyCount: secrets.size };
      } catch (error) {
        if (created) await rm(path, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async activate() {
    return await this.withLock(async (base) => {
      const pending = await this.requirePointer("pending", base);
      const current = await this.pointer("current", base);
      await this.assertGeneration(pending, base);
      if (current) await this.replacePointer("previous", current, base);
      await this.replacePointer("current", pending, base);
      await rm(join(base, "pending"));
      return { operation: "activate", generation: pending, previous: current ?? null, healthVerified: false };
    });
  }

  async discard() {
    return await this.withLock(async (base) => {
      const pending = await this.requirePointer("pending", base);
      if (pending === await this.pointer("current", base) || pending === await this.pointer("previous", base)) {
        fail("conflict", "Pending generation is retained by another pointer", ExitCode.CONFLICT);
      }
      await rm(join(base, "pending"));
      return { operation: "discard", generation: pending, retainedUntilPrune: true };
    });
  }

  async restore() {
    return await this.withLock(async (base) => {
      const previous = await this.requirePointer("previous", base);
      const current = await this.requirePointer("current", base);
      if (previous === current) fail("conflict", "Previous and current refer to the same generation", ExitCode.CONFLICT);
      await this.assertGeneration(previous, base);
      await this.replacePointer("previous", current, base);
      await this.replacePointer("current", previous, base);
      return { operation: "restore", generation: previous, previous: current, healthVerified: false };
    });
  }

  async prune(eligible) {
    return await this.withLock(async (base) => {
      const retained = new Set(await Promise.all(["current", "previous", "pending"].map((name) => this.pointer(name, base))));
      retained.delete(null);
      const removed = [];
      for (const generation of new Set(eligible)) {
        validateGenerationName(generation);
        if (retained.has(generation)) fail("conflict", `Generation '${generation}' is retained by a pointer`, ExitCode.CONFLICT);
        await this.assertGeneration(generation, base);
        await rm(join(base, generation), { recursive: true });
        removed.push(generation);
      }
      return { operation: "prune", removed: removed.sort() };
    });
  }

  async status() {
    const directory = await this.initialize();
    try {
      const [current, previous, pending] = await Promise.all(["current", "previous", "pending"].map((name) => this.pointer(name, directory.base)));
      const generations = (await readdir(directory.base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && generationPattern.test(entry.name))
        .map((entry) => entry.name).sort();
      return { operation: "status", current, previous, pending, generations };
    } finally { await directory.handle?.close(); }
  }

  async pointer(name, base = this.output) {
    if (!pointerNames.has(name)) throw new Error("invalid internal pointer name");
    const path = join(base, name);
    try {
      const stat = await lstat(path);
      if (!stat.isSymbolicLink()) fail("filesystem", `${name} is not a symbolic link`, ExitCode.FILESYSTEM);
      const target = await readlink(path);
      validateGenerationName(target);
      if (basename(target) !== target) fail("filesystem", `${name} has an unsafe target`, ExitCode.FILESYSTEM);
      return target;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async requirePointer(name, base) {
    const value = await this.pointer(name, base);
    if (!value) fail("conflict", `No ${name} generation exists`, ExitCode.CONFLICT);
    return value;
  }

  async assertGeneration(name, base = this.output) {
    validateGenerationName(name);
    const path = join(base, name);
    const stat = await lstat(path).catch((error) => {
      fail("filesystem", `Generation '${name}' does not exist`, ExitCode.FILESYSTEM, { cause: error });
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("filesystem", `Generation '${name}' is not a real directory`, ExitCode.FILESYSTEM);
    const metadata = await readFile(join(path, ".metadata.json"), "utf8").catch((error) => {
      fail("filesystem", `Generation '${name}' is incomplete`, ExitCode.FILESYSTEM, { cause: error });
    });
    if (!metadata.includes(`"generation":"${name}"`)) fail("filesystem", `Generation '${name}' metadata is invalid`, ExitCode.FILESYSTEM);
  }

  async replacePointer(name, generation, base = this.output) {
    validateGenerationName(generation);
    await this.assertGeneration(generation, base);
    const temporary = join(base, `.${name}-${process.pid}-${this.random()}`);
    await symlink(generation, temporary, "dir");
    try {
      await rename(temporary, join(base, name));
    } catch (error) {
      await rm(temporary, { force: true });
      fail("filesystem", `Cannot publish ${name} pointer`, ExitCode.FILESYSTEM, { cause: error });
    }
  }
}

async function writeExclusive(path, value, groupId, mode) {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    if (process.platform !== "win32") await handle.chown(process.getuid(), groupId);
    await handle.chmod(mode);
  } catch (error) {
    fail("filesystem", `Cannot create generation file '${basename(path)}'`, ExitCode.FILESYSTEM, { cause: error });
  } finally {
    await handle?.close();
  }
}
async function assertSafeAncestors(path) {
  let current = dirname(resolve(path));
  for (let depth = 0; depth < 3; depth += 1) {
    const stat = await lstat(current).catch((error) => {
      fail("filesystem", "Provisioned output parent is missing", ExitCode.FILESYSTEM, { cause: error });
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("filesystem", "Output path parent is unsafe", ExitCode.FILESYSTEM);
    if (process.platform !== "win32" && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
      fail("filesystem", "Output path parents must be root-owned and not group/world writable", ExitCode.FILESYSTEM);
    }
    current = dirname(current);
  }
}
async function rejectSymlink(path, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) fail("filesystem", `${label} may not be a symlink`, ExitCode.FILESYSTEM);
}
function makeGenerationId(date, suffix) {
  const timestamp = date.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const generation = `gen-${timestamp}-${suffix}`;
  validateGenerationName(generation);
  return generation;
}
function validateGenerationName(value) {
  if (typeof value !== "string" || !generationPattern.test(value)) fail("filesystem", "Invalid generation identifier", ExitCode.FILESYSTEM);
}
async function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(join(lockPath, "owner"), `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readFile(join(lockPath, "owner"), "utf8").catch(() => "");
      const pid = Number.parseInt(owner, 10);
      if (Number.isSafeInteger(pid) && pid > 0 && !processExists(pid)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      throw error;
    }
  }
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}
