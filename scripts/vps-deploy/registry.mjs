// Root-owned host stack registry: the host administrator's authorization for
// what a stack-bound deploy identity may change. Workflow inputs must agree with
// it; they can never widen it.
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { fail, isRecord, parseJsonStrict, patterns, printable, validateEnvironment, validateRemoteDeploymentPath, validateServiceName, validateStackName } from "./contract.mjs";

export const defaultRegistryDirectory = "/etc/vps-deploy/stacks";
export const defaultInstanceDirectory = "/etc/runtime-secrets/instances";
const instancePattern = /^[a-z][a-z0-9-]{0,26}$/u;
const fields = new Set([
  "version", "stackName", "environment", "deploymentPath", "allowedSourceRepositories", "allowedImageRepositories",
  "runtimeSecrets", "publicPorts", "allowedBindSources", "allowedExternalNetworks", "allowedExternalVolumes",
  "allowedCapabilities", "healthCheckHosts", "lockTimeoutSeconds",
]);
const reservedPrefixes = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var/run",
  "/var/lib/docker", "/var/lib/containerd",
];
// Bind prefixes must be at least two segments deep and must not overlap these.
const protectedBindRoots = [
  "/proc", "/sys", "/dev", "/boot", "/root", "/home", "/run", "/var/run", "/var/lib/docker", "/var/lib/containerd",
  "/etc/vps-deploy", "/etc/runtime-secrets", "/etc/credstore", "/etc/credstore.encrypted", "/etc/ssh", "/etc/sudoers",
  "/etc/sudoers.d", "/etc/shadow", "/etc/gshadow", "/etc/passwd", "/etc/group", "/etc/docker", "/etc/systemd",
  "/usr/bin", "/usr/sbin", "/usr/lib",
];

function invalid(message) {
  fail("configuration", `host stack registry: ${message}`);
}

function overlaps(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`) || prefix.startsWith(`${path}/`);
}

function stringList(value, label, check) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) invalid(`${label} must be an array of at most 100 entries`);
  const result = value.map((item) => {
    if (typeof item !== "string") invalid(`${label} entries must be strings`);
    return check(item);
  });
  if (new Set(result).size !== result.length) invalid(`${label} contains duplicates`);
  return result;
}

export function validateRegistry(value, { expectedStack } = {}) {
  if (!isRecord(value)) invalid("root must be an object");
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length) invalid(`unknown field '${printable(unknown[0])}'`);
  if (value.version !== 1) invalid("version must be 1");
  let stackName;
  let environment;
  let deploymentPath;
  try {
    stackName = validateStackName(value.stackName);
    environment = validateEnvironment(value.environment);
    deploymentPath = validateRemoteDeploymentPath(value.deploymentPath);
  } catch (error) { invalid(error.message); }
  if (expectedStack !== undefined && stackName !== expectedStack) invalid("stackName does not match the registry file name");
  if (reservedPrefixes.some((prefix) => overlaps(deploymentPath, prefix))) invalid("deploymentPath overlaps a reserved system directory");
  const allowedSourceRepositories = stringList(value.allowedSourceRepositories, "allowedSourceRepositories", (item) => {
    if (!patterns.sourceRepository.test(item)) invalid(`allowedSourceRepositories entry '${printable(item)}' must be owner/repository`);
    return item.toLowerCase();
  });
  if (allowedSourceRepositories.length === 0) invalid("allowedSourceRepositories must list at least one repository");
  const allowedImageRepositories = stringList(value.allowedImageRepositories, "allowedImageRepositories", (item) => {
    if (!/^docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/?)*$/u.test(item)) {
      invalid(`allowedImageRepositories entry '${printable(item)}' must be a docker.io repository or namespace prefix ending with '/'`);
    }
    return item;
  });
  if (allowedImageRepositories.length === 0) invalid("allowedImageRepositories must list at least one docker.io namespace or repository");
  const publicPorts = value.publicPorts === undefined ? [] : value.publicPorts;
  if (!Array.isArray(publicPorts) || publicPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) invalid("publicPorts must be an array of port numbers");
  const allowedBindSources = stringList(value.allowedBindSources, "allowedBindSources", (item) => {
    const normalized = posix.normalize(item);
    if (!item.startsWith("/") || !item.endsWith("/") || normalized !== item || item === "/" || item.includes("..")) invalid(`allowedBindSources entry '${printable(item)}' must be a normalized absolute directory ending with '/'`);
    const bare = item.slice(0, -1);
    if (bare.split("/").length < 3 || protectedBindRoots.some((prefix) => overlaps(bare, prefix))) {
      invalid(`allowedBindSources entry '${printable(item)}' exposes a protected host location`);
    }
    if (overlaps(bare, deploymentPath)) invalid(`allowedBindSources entry '${printable(item)}' overlaps the deployment state directory`);
    return item;
  });
  const nameCheck = (label) => (item) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(item)) invalid(`${label} entry '${printable(item)}' is invalid`);
    return item;
  };
  const allowedExternalNetworks = stringList(value.allowedExternalNetworks, "allowedExternalNetworks", nameCheck("allowedExternalNetworks"));
  const allowedExternalVolumes = stringList(value.allowedExternalVolumes, "allowedExternalVolumes", nameCheck("allowedExternalVolumes"));
  const allowedCapabilities = stringList(value.allowedCapabilities, "allowedCapabilities", (item) => {
    const normalized = item.toUpperCase().replace(/^CAP_/u, "");
    if (!/^[A-Z_]{2,32}$/u.test(normalized) || ["ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO", "DAC_READ_SEARCH", "SYS_BOOT", "MAC_ADMIN", "MAC_OVERRIDE", "BPF", "PERFMON"].includes(normalized)) {
      invalid(`allowedCapabilities entry '${printable(item)}' is not permitted`);
    }
    return normalized;
  });
  const healthCheckHosts = value.healthCheckHosts === undefined ? ["127.0.0.1", "::1", "localhost"] : stringList(value.healthCheckHosts, "healthCheckHosts", (item) => {
    if (!/^[A-Za-z0-9.:-]{1,253}$/u.test(item)) invalid(`healthCheckHosts entry '${printable(item)}' is invalid`);
    return item.toLowerCase();
  });
  const lockTimeoutSeconds = value.lockTimeoutSeconds === undefined ? 1800 : value.lockTimeoutSeconds;
  if (!Number.isInteger(lockTimeoutSeconds) || lockTimeoutSeconds < 1 || lockTimeoutSeconds > 7200) invalid("lockTimeoutSeconds must be an integer from 1 to 7200");
  const secretServices = new Map();
  if (value.runtimeSecrets !== undefined) {
    if (!isRecord(value.runtimeSecrets) || Object.keys(value.runtimeSecrets).some((key) => key !== "services") || !isRecord(value.runtimeSecrets.services)) {
      invalid("runtimeSecrets must be an object containing only 'services'");
    }
    for (const [service, entry] of Object.entries(value.runtimeSecrets.services)) {
      try { validateServiceName(service, "runtimeSecrets service"); } catch (error) { invalid(error.message); }
      if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "instance" && key !== "startAtBoot")) invalid(`runtimeSecrets.services.${service} must contain instance and optional startAtBoot`);
      if (typeof entry.instance !== "string" || !instancePattern.test(entry.instance)) invalid(`runtimeSecrets.services.${service}.instance must match ${instancePattern}`);
      if (entry.startAtBoot !== undefined && typeof entry.startAtBoot !== "boolean") invalid(`runtimeSecrets.services.${service}.startAtBoot must be a boolean`);
      secretServices.set(service, { instance: entry.instance, startAtBoot: entry.startAtBoot ?? true });
    }
    const instances = [...secretServices.values()].map((entry) => entry.instance);
    if (new Set(instances).size !== instances.length) invalid("runtimeSecrets instances must be unique");
  }
  return Object.freeze({
    stackName, environment, deploymentPath, allowedSourceRepositories, allowedImageRepositories, publicPorts: [...publicPorts],
    allowedBindSources, allowedExternalNetworks, allowedExternalVolumes, allowedCapabilities, healthCheckHosts,
    lockTimeoutSeconds, secretServices,
  });
}

export async function assertTrustedFile(path, label, { requireRoot = process.platform !== "win32" } = {}) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    fail("configuration", `${label} is not installed`, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("configuration", `${label} must be a regular non-symlink file`);
  if (requireRoot && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) fail("configuration", `${label} must be root-owned and not group/world writable`);
}

/** Load a stack registry and prove it does not overlap another registered stack. */
export async function loadRegistry(stackName, { directory = defaultRegistryDirectory, requireRoot } = {}) {
  validateStackName(stackName);
  const path = join(directory, `${stackName}.json`);
  await assertTrustedFile(path, `host stack registry for '${stackName}'`, { requireRoot });
  const registry = validateRegistry(parseJsonStrict(await readFile(path, "utf8"), "host stack registry"), { expectedStack: stackName });
  const entries = (await readdir(directory)).filter((name) => name.endsWith(".json") && name !== `${stackName}.json`).sort();
  const instances = new Set([...registry.secretServices.values()].map((entry) => entry.instance));
  for (const name of entries) {
    const otherPath = join(directory, name);
    await assertTrustedFile(otherPath, `host stack registry '${name}'`, { requireRoot });
    let other;
    try {
      other = validateRegistry(parseJsonStrict(await readFile(otherPath, "utf8"), name), { expectedStack: name.slice(0, -5) });
    } catch (error) {
      fail("configuration", `another host stack registry (${printable(name)}) is invalid; refusing to deploy until the host configuration is consistent`, { cause: error });
    }
    if (overlaps(other.deploymentPath, registry.deploymentPath)) fail("configuration", `deploymentPath overlaps registered stack '${other.stackName}'`);
    for (const entry of other.secretServices.values()) {
      if (instances.has(entry.instance)) fail("configuration", `runtime-secret instance '${entry.instance}' is also registered by stack '${other.stackName}'`);
    }
  }
  return registry;
}

/**
 * Resolve each registered secret-bearing service to its DEVOPS-007 instance and
 * verify identity agreement. The bind source is derived from the instance's
 * validated output directory, never from caller input.
 */
export async function resolveSecretServices(registry, { loadInstance }) {
  const resolved = new Map();
  let identity;
  for (const [service, entry] of registry.secretServices) {
    const instance = await loadInstance(entry.instance);
    if (instance.service !== service) fail("configuration", `runtime-secret instance '${entry.instance}' belongs to service '${instance.service}', not '${service}'`);
    const key = `${instance.application}/${instance.environment}`;
    if (identity !== undefined && identity !== key) fail("configuration", "all runtime-secret instances of one stack must share an application and environment");
    identity = key;
    resolved.set(service, { ...entry, outputDirectory: instance.outputDirectory, bindSource: `${instance.outputDirectory}/current` });
  }
  return resolved;
}

/** Default instance loader reusing the DEVOPS-007 trusted-configuration validation. */
export async function loadRuntimeSecretInstance(id, { directory = defaultInstanceDirectory } = {}) {
  if (!instancePattern.test(id)) fail("configuration", "invalid runtime-secret instance identifier");
  const { loadContracts } = await import("../runtime-secrets/config.mjs");
  try {
    const { instance } = await loadContracts(join(directory, `${id}.json`));
    return instance;
  } catch (error) {
    fail("configuration", `runtime-secret instance '${id}' is not usable: ${printable(error.message)}`, { cause: error });
  }
}

export function assertProvenance(registry, release) {
  if (!registry.allowedSourceRepositories.includes(release.manifest.source_repository.toLowerCase())) {
    fail("validation", "release manifest source_repository is not authorized for this stack by the host registry");
  }
  for (const component of release.components) {
    const allowed = registry.allowedImageRepositories.some((prefix) => (prefix.endsWith("/") ? component.image.startsWith(prefix) : component.image === prefix));
    if (!allowed) fail("validation", `${component.name}: image repository is not authorized for this stack by the host registry`);
  }
}
