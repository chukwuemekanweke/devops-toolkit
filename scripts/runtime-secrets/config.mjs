import { isAbsolute, relative, resolve, sep } from "node:path";
import { lstat } from "node:fs/promises";
import { ExitCode, fail } from "./errors.mjs";
import { readStrictJson } from "./json.mjs";

const identityPattern = /^[a-z][a-z0-9-]{0,62}$/u;
export const secretNamePattern = /^(?![0-9])[A-Z0-9_]{1,200}$/u;
const instanceFields = new Set([
  "version", "application", "environment", "service", "expectedDopplerProject",
  "expectedDopplerConfig", "outputDirectory", "serviceGroupId", "keyManifestPath",
  "maxPayloadBytes", "maxSecretBytes", "providerTimeoutSeconds", "providerRetries",
  "dopplerExecutable", "dopplerCliVersion",
]);
const manifestFields = new Set(["version", "secrets"]);
const secretFields = new Set(["name", "required", "allowEmpty", "maxBytes"]);

export async function loadContracts(instancePath, options = {}) {
  await assertTrustedConfigurationFile(instancePath, "instance configuration");
  const instance = validateInstance(await readStrictJson(instancePath, "instance configuration"), options);
  await assertTrustedConfigurationFile(instance.keyManifestPath, "key manifest");
  const manifest = validateManifest(await readStrictJson(instance.keyManifestPath, "key manifest"));
  return { instance, manifest };
}

export function validateInstance(value, { generationRoot = "/run/runtime-secrets", manifestRoot = "/etc/runtime-secrets/manifests" } = {}) {
  const object = requireObject(value, "instance configuration");
  rejectUnknown(object, instanceFields, "instance configuration");
  requireVersion(object, "instance configuration");
  for (const field of ["application", "environment", "service"]) {
    if (typeof object[field] !== "string" || !identityPattern.test(object[field])) {
      fail("configuration", `${field} must match ${identityPattern}`, ExitCode.CONFIG);
    }
  }
  for (const field of ["expectedDopplerProject", "expectedDopplerConfig", "outputDirectory", "keyManifestPath"]) {
    if (typeof object[field] !== "string" || object[field].length === 0) {
      fail("configuration", `${field} must be a non-empty string`, ExitCode.CONFIG);
    }
  }
  if (!isAbsolute(object.outputDirectory) || !isAbsolute(object.keyManifestPath)) {
    fail("configuration", "outputDirectory and keyManifestPath must be absolute", ExitCode.CONFIG);
  }
  if (!isContained(manifestRoot, object.keyManifestPath)) {
    fail("configuration", `keyManifestPath must be contained by ${resolve(manifestRoot)}`, ExitCode.CONFIG);
  }
  const expectedOutput = resolve(generationRoot, object.application, object.environment, object.service);
  if (resolve(object.outputDirectory) !== expectedOutput || !isContained(generationRoot, expectedOutput)) {
    fail("configuration", `outputDirectory must be ${expectedOutput}`, ExitCode.CONFIG);
  }
  const serviceGroupId = boundedInteger(object.serviceGroupId, "serviceGroupId", 1, 2147483647);
  const dopplerExecutable = optionalString(object.dopplerExecutable, "/usr/local/bin/doppler");
  const dopplerCliVersion = optionalString(object.dopplerCliVersion, "3.77.0");
  if (dopplerExecutable !== "/usr/local/bin/doppler" || dopplerCliVersion !== "3.77.0") {
    fail("configuration", "Doppler executable and CLI version must match the pinned 3.77.0 installation", ExitCode.CONFIG);
  }
  const config = {
    ...object,
    outputDirectory: expectedOutput,
    serviceGroupId,
    maxPayloadBytes: optionalInteger(object.maxPayloadBytes, "maxPayloadBytes", 1024, 16 * 1024 * 1024, 1024 * 1024),
    maxSecretBytes: optionalInteger(object.maxSecretBytes, "maxSecretBytes", 1, 1024 * 1024, 64 * 1024),
    providerTimeoutSeconds: optionalInteger(object.providerTimeoutSeconds, "providerTimeoutSeconds", 1, 300, 30),
    providerRetries: optionalInteger(object.providerRetries, "providerRetries", 0, 5, 2),
    dopplerExecutable,
    dopplerCliVersion,
  };
  return Object.freeze(config);
}

export function validateManifest(value) {
  const object = requireObject(value, "key manifest");
  rejectUnknown(object, manifestFields, "key manifest");
  requireVersion(object, "key manifest");
  if (!Array.isArray(object.secrets) || object.secrets.length === 0) {
    fail("configuration", "key manifest secrets must be a non-empty array", ExitCode.CONFIG);
  }
  const names = new Set();
  const secrets = object.secrets.map((entry, index) => {
    const item = requireObject(entry, `secrets[${index}]`);
    rejectUnknown(item, secretFields, `secrets[${index}]`);
    if (typeof item.name !== "string" || !secretNamePattern.test(item.name) || item.name.startsWith("DOPPLER_")) {
      fail("configuration", `secrets[${index}].name is not a safe Doppler Classic name`, ExitCode.CONFIG);
    }
    if (names.has(item.name)) fail("configuration", `duplicate manifest key '${item.name}'`, ExitCode.CONFIG);
    names.add(item.name);
    if (typeof item.required !== "boolean" || typeof item.allowEmpty !== "boolean") {
      fail("configuration", `${item.name}: required and allowEmpty must be booleans`, ExitCode.CONFIG);
    }
    return Object.freeze({
      name: item.name,
      required: item.required,
      allowEmpty: item.allowEmpty,
      ...(item.maxBytes === undefined ? {} : { maxBytes: boundedInteger(item.maxBytes, `${item.name}.maxBytes`, 1, 1024 * 1024) }),
    });
  });
  return Object.freeze({ version: 1, secrets: Object.freeze(secrets) });
}

export function validatePayload(value, instance, manifest) {
  const payload = requireObject(value, "Doppler payload", ExitCode.VALIDATION);
  for (const [key, item] of Object.entries(payload)) {
    if (typeof item !== "string") fail("validation", `Doppler payload key '${key}' is not a string`, ExitCode.VALIDATION);
  }
  if (payload.DOPPLER_PROJECT !== instance.expectedDopplerProject) {
    fail("scope", "Doppler project does not match the instance configuration", ExitCode.VALIDATION);
  }
  if (payload.DOPPLER_CONFIG !== instance.expectedDopplerConfig) {
    fail("scope", "Doppler config does not match the instance configuration", ExitCode.VALIDATION);
  }
  const approvedMetadata = new Set(["DOPPLER_PROJECT", "DOPPLER_CONFIG", "DOPPLER_ENVIRONMENT"]);
  for (const key of Object.keys(payload)) {
    if (key.startsWith("DOPPLER_") && !approvedMetadata.has(key)) {
      fail("validation", `Unexpected reserved Doppler metadata key '${key}'`, ExitCode.VALIDATION);
    }
  }
  const allowed = new Map(manifest.secrets.map((entry) => [entry.name, entry]));
  const result = new Map();
  for (const [key, secret] of Object.entries(payload)) {
    if (approvedMetadata.has(key)) continue;
    if (!secretNamePattern.test(key) || !allowed.has(key)) {
      fail("validation", `Doppler payload contains unapproved key '${key}'`, ExitCode.VALIDATION);
    }
    const rule = allowed.get(key);
    const bytes = Buffer.byteLength(secret, "utf8");
    const limit = rule.maxBytes ?? instance.maxSecretBytes;
    if (!rule.allowEmpty && bytes === 0) fail("validation", `Secret '${key}' may not be empty`, ExitCode.VALIDATION);
    if (bytes > limit) fail("validation", `Secret '${key}' exceeds its byte limit`, ExitCode.VALIDATION);
    result.set(key, secret);
  }
  for (const rule of manifest.secrets) {
    if (rule.required && !result.has(rule.name)) fail("validation", `Required secret '${rule.name}' is missing`, ExitCode.VALIDATION);
  }
  return result;
}

function requireObject(value, label, exitCode = ExitCode.CONFIG) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("configuration", `${label} must be an object`, exitCode);
  return value;
}
function rejectUnknown(object, allowed, label) {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) fail("configuration", `${label} has unknown field(s): ${unknown.join(", ")}`, ExitCode.CONFIG);
}
function requireVersion(object, label) {
  if (object.version !== 1) fail("configuration", `${label} version must be 1`, ExitCode.CONFIG);
}
function boundedInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail("configuration", `${label} must be an integer from ${minimum} to ${maximum}`, ExitCode.CONFIG);
  return value;
}
function optionalInteger(value, label, minimum, maximum, fallback) {
  return value === undefined ? fallback : boundedInteger(value, label, minimum, maximum);
}
function optionalString(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail("configuration", "Executable/version values must be non-empty strings", ExitCode.CONFIG);
  return value;
}
function isContained(root, child) {
  const value = relative(resolve(root), resolve(child));
  return value !== "" && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
async function assertTrustedConfigurationFile(path, label) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    fail("configuration", `Cannot inspect ${label}`, ExitCode.CONFIG, { cause: error });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("configuration", `${label} must be a regular non-symlink file`, ExitCode.CONFIG);
  if (process.platform !== "win32" && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) {
    fail("configuration", `${label} must be root-owned and not group/world writable`, ExitCode.CONFIG);
  }
}
