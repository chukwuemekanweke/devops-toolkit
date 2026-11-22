// Integration with the DEVOPS-007 host runtime-secret helper through its
// documented interface. vps-deploy never contacts Doppler and never reads secret
// values; it triggers lifecycle operations and reads sanitized generation ids.
import { join } from "node:path";
import { fail, patterns } from "./contract.mjs";
import { runCommand } from "./docker.mjs";

const categories = new Map([[2, "usage"], [10, "configuration"], [20, "authentication"], [21, "provider"], [30, "validation"], [40, "filesystem"], [41, "conflict"]]);
const instancePattern = /^[a-z][a-z0-9-]{0,26}$/u;

function checkInstance(id) {
  if (!instancePattern.test(id)) fail("secrets", "invalid runtime-secret instance identifier");
}

function parseStatus(text) {
  let value;
  try { value = JSON.parse(String(text).trim().split(/\r?\n/u).pop() ?? ""); } catch { fail("secrets", "runtime-secrets status produced unreadable output"); }
  const pointer = (name) => {
    const item = value?.[name];
    if (item === null || item === undefined) return null;
    if (typeof item !== "string" || !patterns.generation.test(item)) fail("secrets", `runtime-secrets status returned an invalid ${name} pointer`);
    return item;
  };
  const generations = Array.isArray(value?.generations) ? value.generations.filter((item) => typeof item === "string" && patterns.generation.test(item)) : [];
  return { current: pointer("current"), previous: pointer("previous"), pending: pointer("pending"), generations };
}

/**
 * Production adapter: render/activate/discard/restore through the hardened
 * DEVOPS-007 systemd units (runs as root from the constrained deploy helper),
 * status/prune through the documented CLI as the instance's render identity.
 */
export class SystemdRuntimeSecrets {
  constructor({ run = runCommand, node = "/usr/bin/node", helper = "/opt/runtime-secrets/scripts/runtime-secrets.mjs", instanceDirectory = "/etc/runtime-secrets/instances" } = {}) {
    this.run = run;
    this.node = node;
    this.helper = helper;
    this.instanceDirectory = instanceDirectory;
  }

  async operation(operation, id) {
    checkInstance(id);
    const unit = `runtime-secrets-${operation}@${id}.service`;
    const result = await this.run("/usr/bin/systemctl", ["start", unit], { timeoutMs: 600_000 });
    if (result.code === 0 && !result.timedOut) return { ok: true };
    const show = await this.run("/usr/bin/systemctl", ["show", "--property=ExecMainStatus", "--value", unit], { timeoutMs: 30_000 });
    const status = Number.parseInt(show.stdout.trim(), 10);
    return { ok: false, category: categories.get(status) ?? (result.timedOut ? "timeout" : "unit-failed"), exitCode: Number.isInteger(status) ? status : null };
  }

  async cli(id, args) {
    checkInstance(id);
    return await this.run("/usr/sbin/runuser", ["-u", `rsec-${id}`, "--", this.node, this.helper, ...args, "--instance", join(this.instanceDirectory, `${id}.json`)], { timeoutMs: 120_000 });
  }

  async status(id) {
    const result = await this.cli(id, ["status"]);
    if (result.code !== 0) fail("secrets", `runtime-secrets status failed for instance '${id}' (${categories.get(result.code) ?? "error"})`);
    return parseStatus(result.stdout);
  }

  render(id) { return this.operation("render", id); }
  activate(id) { return this.operation("activate", id); }
  discard(id) { return this.operation("discard", id); }
  restore(id) { return this.operation("restore", id); }

  async prune(id, generations) {
    if (generations.length === 0) return { ok: true };
    generations.forEach((item) => { if (!patterns.generation.test(item)) fail("secrets", "invalid generation for prune"); });
    const result = await this.cli(id, ["prune", ...generations.flatMap((item) => ["--eligible", item])]);
    return result.code === 0 ? { ok: true } : { ok: false, category: categories.get(result.code) ?? "error" };
  }
}

/**
 * Direct-CLI adapter for hosts or harnesses without the systemd units. It runs
 * the same DEVOPS-007 helper code as the current user with an explicit
 * credential directory. It is used by the privileged Linux integration harness.
 */
export class CliRuntimeSecrets {
  constructor({ run = runCommand, node = process.execPath, helper, instanceDirectory = "/etc/runtime-secrets/instances", credentialDirectory }) {
    this.run = run;
    this.node = node;
    this.helper = helper;
    this.instanceDirectory = instanceDirectory;
    this.credentialDirectory = credentialDirectory;
  }

  async invoke(id, args) {
    checkInstance(id);
    const extra = args[0] === "render" ? ["--credential", join(this.credentialDirectory, `${id}.token`)] : [];
    return await this.run(this.node, [this.helper, ...args, "--instance", join(this.instanceDirectory, `${id}.json`), ...extra], { timeoutMs: 120_000 });
  }

  async operation(operation, id) {
    const result = await this.invoke(id, [operation]);
    return result.code === 0 ? { ok: true } : { ok: false, category: categories.get(result.code) ?? "error", exitCode: result.code };
  }

  async status(id) {
    const result = await this.invoke(id, ["status"]);
    if (result.code !== 0) fail("secrets", `runtime-secrets status failed for instance '${id}' (${categories.get(result.code) ?? "error"})`);
    return parseStatus(result.stdout);
  }

  render(id) { return this.operation("render", id); }
  activate(id) { return this.operation("activate", id); }
  discard(id) { return this.operation("discard", id); }
  restore(id) { return this.operation("restore", id); }

  async prune(id, generations) {
    if (generations.length === 0) return { ok: true };
    const result = await this.invoke(id, ["prune", ...generations.flatMap((item) => ["--eligible", item])]);
    return result.code === 0 ? { ok: true } : { ok: false, category: categories.get(result.code) ?? "error" };
  }
}
