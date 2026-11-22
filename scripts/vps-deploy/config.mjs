// Application-owned deployment configuration file (vps-deploy-config.schema.json v1).
// The file is an alternative to the inline topology inputs of vps-deploy.yml so
// that vps-deploy.yml and release-config-check.yml read one source of truth. It
// is translated into the exact inline input strings and then validated by the
// same parsers, so a setting behaves identically wherever it is declared.
// Identity inputs (environment, stack-name) and transport (ssh-port) stay
// inline: GitHub evaluates environment and concurrency before any step runs.
import { fail, isRecord, parseJsonStrict, printable } from "./contract.mjs";

export const deployConfigBytes = 64 * 1024;

const fields = new Set([
  "version", "composeFiles", "remoteDeploymentPath", "componentServiceMap", "migrationService", "migrationTimeoutSeconds",
  "healthServices", "healthChecks", "healthTimeoutSeconds", "rollbackOnHealthFailure",
]);

/** Inline vps-deploy inputs replaced by the file, with their workflow defaults. */
export const fileOwnedInputs = Object.freeze({
  COMPOSE_FILES: "",
  REMOTE_DEPLOYMENT_PATH: "",
  COMPONENT_SERVICE_MAP: "{}",
  MIGRATION_SERVICE: "",
  MIGRATION_TIMEOUT_SECONDS: "600",
  HEALTH_SERVICES: "",
  HEALTH_CHECKS: "[]",
  HEALTH_TIMEOUT_SECONDS: "300",
  ROLLBACK_ON_HEALTH_FAILURE: "true",
});

const pathSegment = /^[A-Za-z0-9._-]{1,128}$/u;
const lineBreaks = /[\u0000-\u001f\u007f]/u;

function invalid(message) {
  fail("validation", `deployment configuration: ${message}`);
}

function inputName(variable) {
  return variable.toLowerCase().replaceAll("_", "-");
}

/** A repository-relative file path using '/', without '.'/'..' segments; dot directories such as `.github/` are allowed. */
export function validateRepositoryFilePath(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.startsWith("/") || value.includes("\\") || lineBreaks.test(value)) {
    fail("validation", `${label} '${printable(value)}' must be a repository-relative path using '/'`);
  }
  if (value.split("/").some((segment) => !pathSegment.test(segment) || segment === "." || segment === "..")) {
    fail("validation", `${label} '${printable(value)}' contains an unsafe path segment`);
  }
  return value;
}

/** A repository-relative `.json` path. */
export function validateRepositoryJsonPath(value, label) {
  validateRepositoryFilePath(value, label);
  if (!value.endsWith(".json")) fail("validation", `${label} '${printable(value)}' must use a .json extension`);
  return value;
}

function lines(value, label) {
  if (value === undefined) return "";
  if (!Array.isArray(value)) invalid(`${label} must be an array of strings`);
  return value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "" || lineBreaks.test(item)) invalid(`${label}[${index}] must be a non-empty single-line string`);
    return item;
  }).join("\n");
}

function integer(value, label, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value)) invalid(`${label} must be an integer`);
  return String(value);
}

/** Translate a configuration document into vps-deploy inline input strings. */
export function deploymentSettingsFromConfig(text) {
  if (typeof text !== "string" || text.trim() === "") invalid("file is empty");
  if (Buffer.byteLength(text, "utf8") > deployConfigBytes) invalid(`file exceeds ${deployConfigBytes / 1024} KiB`);
  let value;
  try { value = parseJsonStrict(text, "deployment configuration"); } catch (error) { invalid(error.message); }
  if (!isRecord(value)) invalid("root must be an object");
  const unknown = Object.keys(value).filter((key) => !fields.has(key));
  if (unknown.length) invalid(`unknown field '${printable(unknown[0])}'`);
  if (value.version !== 1) invalid("version must be 1");
  if (!Array.isArray(value.composeFiles) || value.composeFiles.length === 0) invalid("composeFiles must list at least one Compose file");
  if (typeof value.remoteDeploymentPath !== "string") invalid("remoteDeploymentPath must be a string");
  if (value.componentServiceMap !== undefined && !isRecord(value.componentServiceMap)) invalid("componentServiceMap must be an object");
  if (value.migrationService !== undefined && typeof value.migrationService !== "string") invalid("migrationService must be a string");
  if (value.healthChecks !== undefined && !Array.isArray(value.healthChecks)) invalid("healthChecks must be an array");
  if (value.rollbackOnHealthFailure !== undefined && typeof value.rollbackOnHealthFailure !== "boolean") invalid("rollbackOnHealthFailure must be a boolean");
  return {
    COMPOSE_FILES: lines(value.composeFiles, "composeFiles"),
    REMOTE_DEPLOYMENT_PATH: value.remoteDeploymentPath,
    COMPONENT_SERVICE_MAP: JSON.stringify(value.componentServiceMap ?? {}),
    MIGRATION_SERVICE: value.migrationService ?? "",
    MIGRATION_TIMEOUT_SECONDS: integer(value.migrationTimeoutSeconds, "migrationTimeoutSeconds", fileOwnedInputs.MIGRATION_TIMEOUT_SECONDS),
    HEALTH_SERVICES: lines(value.healthServices, "healthServices"),
    HEALTH_CHECKS: JSON.stringify(value.healthChecks ?? []),
    HEALTH_TIMEOUT_SECONDS: integer(value.healthTimeoutSeconds, "healthTimeoutSeconds", fileOwnedInputs.HEALTH_TIMEOUT_SECONDS),
    ROLLBACK_ON_HEALTH_FAILURE: String(value.rollbackOnHealthFailure ?? true),
  };
}

/**
 * Return the effective input environment. Without DEPLOY_CONFIG_PATH the inline
 * inputs are used unchanged. With it, every file-owned inline input must still
 * hold its workflow default, so a setting can never be declared in two places.
 */
export function applyDeployConfig(env, readConfig) {
  const path = String(env.DEPLOY_CONFIG_PATH ?? "").trim();
  if (path === "") return env;
  validateRepositoryJsonPath(path, "deploy-config-path");
  for (const [name, fallback] of Object.entries(fileOwnedInputs)) {
    const supplied = env[name];
    if (supplied !== undefined && String(supplied).trim() !== fallback) {
      fail("validation", `${inputName(name)} cannot be combined with deploy-config-path; declare it in the deployment configuration file`);
    }
  }
  return { ...env, ...deploymentSettingsFromConfig(readConfig(path)) };
}
