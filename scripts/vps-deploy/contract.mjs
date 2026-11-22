// Shared deployment-request and release-manifest validation for vps-deploy.
// Used by the GitHub Actions runner helper and re-applied by the host helper:
// the host never trusts validation performed on the runner.
import { createHash } from "node:crypto";
import { parseJsonStrict, stableStringify, validateDeploymentId } from "../docker-publish.mjs";

export { parseJsonStrict, stableStringify };

export const limits = Object.freeze({
  manifestBytes: 256 * 1024,
  composeFileBytes: 256 * 1024,
  composeFiles: 10,
  envelopeBytes: 4 * 1024 * 1024,
  healthChecks: 20,
  healthServices: 100,
  migrationTimeout: { min: 1, max: 7200 },
  healthTimeout: { min: 10, max: 3600 },
});

export const patterns = Object.freeze({
  stackName: /^[a-z0-9][a-z0-9_-]{0,62}$/u,
  environment: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u,
  service: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u,
  component: /^[a-z0-9][a-z0-9._-]{0,127}$/u,
  remotePath: /^(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}){2,16}$/u,
  composeSegment: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u,
  sourceRepository: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u,
  commit: /^[0-9a-fA-F]{40}$/u,
  digest: /^sha256:[0-9a-f]{64}$/u,
  dockerHubRepository: /^docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u,
  artifactName: /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u,
  checkName: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u,
  dateTime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u,
  generation: /^gen-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/u,
  actor: /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/u,
  eventName: /^[a-z_]{1,64}$/u,
});

const controlCharacters = /[\u0000-\u001f\u007f]/u;

export class DeployError extends Error {
  constructor(category, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DeployError";
    this.category = category;
    if (options.phase) this.phase = options.phase;
  }
}

export function fail(category, message, options) {
  throw new DeployError(category, message, options);
}

function invalid(message) {
  fail("validation", message);
}

export function validateStackName(value) {
  if (typeof value !== "string" || !patterns.stackName.test(value)) invalid("stack-name must be a lowercase Compose project name of 1-63 characters ([a-z0-9][a-z0-9_-]*)");
  return value;
}

export function validateEnvironment(value) {
  if (typeof value !== "string" || !patterns.environment.test(value)) invalid("environment must be 1-64 characters from [A-Za-z0-9._-] starting with a letter or digit");
  return value;
}

export function validateServiceName(value, label = "service") {
  if (typeof value !== "string" || !patterns.service.test(value)) invalid(`${label} '${printable(value)}' is not a valid Compose service name`);
  return value;
}

export function validateRemoteDeploymentPath(value) {
  if (typeof value !== "string" || !patterns.remotePath.test(value)) {
    invalid("remote-deployment-path must be an absolute normalized path with at least two segments of [A-Za-z0-9._-] and no '.' or '..' segments");
  }
  return value;
}

export function parseBooleanInput(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  invalid(`${label} must be true or false`);
}

export function parseIntegerInput(value, label, { min, max }) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/u.test(text)) invalid(`${label} must be an integer from ${min} to ${max}`);
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < min || number > max) invalid(`${label} must be an integer from ${min} to ${max}`);
  return number;
}

export function splitLines(value) {
  return String(value ?? "").replaceAll("\r\n", "\n").split("\n").map((item) => item.trim()).filter(Boolean);
}

export function validateComposeFilePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    invalid(`compose file '${printable(value)}' must be a repository-relative path using '/'`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => !patterns.composeSegment.test(segment) || segment === "." || segment === "..")) {
    invalid(`compose file '${printable(value)}' contains an unsafe path segment`);
  }
  if (!/\.ya?ml$/u.test(value)) invalid(`compose file '${printable(value)}' must use a .yml or .yaml extension`);
  return value;
}

export function parseComposeFileList(value) {
  const entries = splitLines(value);
  if (entries.length === 0) invalid("compose-files must list at least one repository-relative Compose file");
  if (entries.length > limits.composeFiles) invalid(`compose-files may list at most ${limits.composeFiles} files`);
  entries.forEach(validateComposeFilePath);
  if (new Set(entries).size !== entries.length) invalid("compose-files contains a duplicate path");
  return entries;
}

export function parseServiceList(value, label) {
  const entries = splitLines(value);
  if (entries.length > limits.healthServices) invalid(`${label} may list at most ${limits.healthServices} services`);
  entries.forEach((entry) => validateServiceName(entry, label));
  if (new Set(entries).size !== entries.length) invalid(`${label} contains a duplicate service`);
  return entries;
}

export function parseComponentServiceMap(value) {
  const text = typeof value === "string" ? (value.trim() === "" ? "{}" : value) : JSON.stringify(value ?? {});
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) invalid("component-service-map exceeds 64 KiB");
  let parsed;
  try { parsed = parseJsonStrict(text, "component-service-map"); } catch (error) { invalid(error.message); }
  if (!isRecord(parsed)) invalid("component-service-map must be a JSON object");
  const result = {};
  for (const key of Object.keys(parsed).sort()) {
    if (!patterns.component.test(key)) invalid(`component-service-map key '${printable(key)}' is not a valid component name`);
    result[key] = validateServiceName(parsed[key], `component-service-map value for '${key}'`);
  }
  return result;
}

export function parseHealthChecks(value) {
  const text = typeof value === "string" ? (value.trim() === "" ? "[]" : value) : JSON.stringify(value ?? []);
  if (Buffer.byteLength(text, "utf8") > 64 * 1024) invalid("health-checks exceeds 64 KiB");
  let parsed;
  try { parsed = parseJsonStrict(text, "health-checks"); } catch (error) { invalid(error.message); }
  if (!Array.isArray(parsed)) invalid("health-checks must be a JSON array");
  if (parsed.length > limits.healthChecks) invalid(`health-checks may contain at most ${limits.healthChecks} checks`);
  const names = new Set();
  return parsed.map((entry, index) => {
    const label = `health-checks[${index}]`;
    if (!isRecord(entry)) invalid(`${label} must be an object`);
    const unknown = Object.keys(entry).filter((key) => !["name", "url", "expectedStatus"].includes(key));
    if (unknown.length) invalid(`${label} contains unknown property '${printable(unknown[0])}'`);
    if (typeof entry.name !== "string" || !patterns.checkName.test(entry.name)) invalid(`${label}.name must be 1-64 characters from [A-Za-z0-9 ._-]`);
    if (names.has(entry.name)) invalid(`health-checks contains duplicate name '${entry.name}'`);
    names.add(entry.name);
    return { name: entry.name, url: validateHealthUrl(entry.url, label), expectedStatus: parseExpectedStatus(entry.expectedStatus, label) };
  });
}

function validateHealthUrl(value, label) {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048 || controlCharacters.test(value) || /\s/u.test(value)) invalid(`${label}.url must be an absolute http(s) URL without whitespace`);
  let url;
  try { url = new URL(value); } catch { invalid(`${label}.url is not a valid URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") invalid(`${label}.url must use http or https`);
  if (url.username || url.password) invalid(`${label}.url must not contain credentials`);
  if (!url.hostname) invalid(`${label}.url must include a host`);
  return url.toString();
}

function parseExpectedStatus(value, label) {
  if (value === undefined) return [200];
  const values = Array.isArray(value) ? value : [value];
  if (values.length < 1 || values.length > 10) invalid(`${label}.expectedStatus must be a status code or an array of 1-10 status codes`);
  const result = values.map((item) => {
    if (!Number.isInteger(item) || item < 100 || item > 599) invalid(`${label}.expectedStatus values must be integers from 100 to 599`);
    return item;
  });
  if (new Set(result).size !== result.length) invalid(`${label}.expectedStatus contains a duplicate code`);
  return result.sort((a, b) => a - b);
}

export function validateManifestArtifactName(value) {
  if (value === "") return "";
  if (typeof value !== "string" || !patterns.artifactName.test(value)) invalid("manifest-artifact must be a valid artifact name ([A-Za-z0-9._-], 1-200 characters)");
  return value;
}

export function selectManifestSource(manifestJson, manifestArtifact) {
  const hasJson = typeof manifestJson === "string" && manifestJson.trim() !== "";
  const hasArtifact = typeof manifestArtifact === "string" && manifestArtifact.trim() !== "";
  if (hasJson === hasArtifact) invalid("exactly one of manifest-json or manifest-artifact must be supplied");
  return hasJson ? { kind: "inline" } : { kind: "artifact", name: validateManifestArtifactName(manifestArtifact.trim()) };
}

/**
 * Validate a release manifest generated by docker-publish.yml.
 * Schema 1.0 rejects unknown fields; a later 1.x minor may add optional fields,
 * which are ignored after the supported core validates. Other majors are rejected.
 */
export function validateReleaseManifest(text, { deploymentId, sourceRepository } = {}) {
  if (typeof text !== "string" || text.trim() === "") invalid("release manifest is empty");
  if (Buffer.byteLength(text, "utf8") > limits.manifestBytes) invalid("release manifest exceeds 256 KiB");
  let value;
  try { value = parseJsonStrict(text, "release manifest"); } catch (error) { invalid(error.message); }
  if (!isRecord(value)) invalid("release manifest must be a JSON object");
  const version = typeof value.schema_version === "string" ? /^1\.(0|[1-9]\d{0,3})$/u.exec(value.schema_version) : null;
  if (!version) invalid("release manifest schema_version is unsupported; this toolkit reads 1.x");
  const strict = version[1] === "0";
  const core = ["schema_version", "deployment_id", "source_repository", "source_commit", "build_reference", "created_at", "components"];
  for (const key of core) if (!Object.hasOwn(value, key)) invalid(`release manifest is missing '${key}'`);
  if (strict) {
    const unknown = Object.keys(value).filter((key) => !core.includes(key));
    if (unknown.length) invalid(`release manifest contains unknown property '${printable(unknown[0])}'`);
  }
  let id;
  try { id = validateDeploymentId(value.deployment_id); } catch { invalid("release manifest deployment_id has an invalid format"); }
  if (id.length > 128) invalid("release manifest deployment_id exceeds 128 characters");
  if (deploymentId !== undefined && id !== deploymentId) invalid("release manifest deployment_id does not match the requested deployment-id");
  if (typeof value.source_repository !== "string" || !patterns.sourceRepository.test(value.source_repository)) invalid("release manifest source_repository is invalid");
  if (sourceRepository !== undefined && value.source_repository.toLowerCase() !== String(sourceRepository).toLowerCase()) {
    invalid("release manifest source_repository does not match the calling repository");
  }
  if (typeof value.source_commit !== "string" || !patterns.commit.test(value.source_commit)) invalid("release manifest source_commit must be a full commit SHA");
  if (typeof value.build_reference !== "string" || value.build_reference.length < 1 || value.build_reference.length > 2048 || controlCharacters.test(value.build_reference)) {
    invalid("release manifest build_reference is invalid");
  }
  if (typeof value.created_at !== "string" || !patterns.dateTime.test(value.created_at) || Number.isNaN(Date.parse(value.created_at))) invalid("release manifest created_at must be an RFC 3339 date-time");
  if (!Array.isArray(value.components) || value.components.length < 1 || value.components.length > 100) invalid("release manifest components must contain 1-100 entries");
  const names = new Set();
  const components = value.components.map((entry, index) => {
    const label = `release manifest components[${index}]`;
    if (!isRecord(entry)) invalid(`${label} must be an object`);
    for (const key of ["name", "image", "digest"]) if (!Object.hasOwn(entry, key)) invalid(`${label} is missing '${key}'`);
    if (strict) {
      const unknown = Object.keys(entry).filter((key) => !["name", "image", "digest"].includes(key));
      if (unknown.length) invalid(`${label} contains unknown property '${printable(unknown[0])}'`);
    }
    if (typeof entry.name !== "string" || !patterns.component.test(entry.name)) invalid(`${label}.name is invalid`);
    if (names.has(entry.name)) invalid(`release manifest contains duplicate component '${entry.name}'`);
    names.add(entry.name);
    if (typeof entry.image !== "string" || entry.image.length > 255 || !patterns.dockerHubRepository.test(entry.image)) {
      invalid(`${entry.name}: image must be an untagged docker.io repository`);
    }
    if (typeof entry.digest !== "string" || !patterns.digest.test(entry.digest)) invalid(`${entry.name}: digest must be sha256 followed by 64 lowercase hexadecimal characters`);
    return { name: entry.name, image: entry.image, digest: entry.digest, reference: `${entry.image}@${entry.digest}` };
  });
  const canonical = stableStringify(value);
  return {
    manifest: value,
    components,
    canonical,
    sha256: createHash("sha256").update(canonical, "utf8").digest("hex"),
  };
}

/** Resolve the effective component -> service mapping for a validated manifest. */
export function resolveComponentServices(components, componentServiceMap) {
  const names = new Set(components.map((component) => component.name));
  for (const key of Object.keys(componentServiceMap)) {
    if (!names.has(key)) invalid(`component-service-map references unknown component '${key}'`);
  }
  const services = new Map();
  for (const component of components) {
    const service = componentServiceMap[component.name] ?? component.name;
    validateServiceName(service, `service for component '${component.name}'`);
    if (services.has(service)) invalid(`components '${services.get(service).component}' and '${component.name}' both map to service '${service}'`);
    services.set(service, { component: component.name, reference: component.reference, image: component.image, digest: component.digest });
  }
  return services;
}

const workflowFields = ["repository", "ref", "sha", "runId", "runAttempt", "actor", "eventName", "toolkitRepository", "toolkitSha", "runUrl"];

function validateWorkflowIdentity(value) {
  if (!isRecord(value)) invalid("request.workflow must be an object");
  const unknown = Object.keys(value).filter((key) => !workflowFields.includes(key));
  if (unknown.length) invalid(`request.workflow contains unknown property '${printable(unknown[0])}'`);
  const text = (key, pattern, max = 512) => {
    const item = value[key];
    if (typeof item !== "string" || item.length < 1 || item.length > max || controlCharacters.test(item) || (pattern && !pattern.test(item))) invalid(`request.workflow.${key} is invalid`);
    return item;
  };
  return {
    repository: text("repository", patterns.sourceRepository, 200),
    ref: text("ref", null, 512),
    sha: text("sha", patterns.commit, 40).toLowerCase(),
    runId: text("runId", /^\d{1,20}$/u, 20),
    runAttempt: text("runAttempt", /^\d{1,6}$/u, 6),
    actor: text("actor", patterns.actor, 64),
    eventName: text("eventName", patterns.eventName, 64),
    toolkitRepository: text("toolkitRepository", patterns.sourceRepository, 200),
    toolkitSha: text("toolkitSha", patterns.commit, 40).toLowerCase(),
    runUrl: text("runUrl", /^https:\/\/[^\s]+$/u, 2048),
  };
}

const requestFields = [
  "version", "environment", "deploymentId", "stackName", "remoteDeploymentPath", "composeFiles", "componentServiceMap",
  "migrationService", "migrationTimeoutSeconds", "healthServices", "healthChecks", "healthTimeoutSeconds",
  "rollbackOnHealthFailure", "workflow",
];

/**
 * Validate a structured deployment request. The runner builds it from workflow
 * inputs; the host re-validates the identical structure from untrusted stdin.
 */
export function validateDeploymentRequest(value) {
  if (!isRecord(value)) invalid("deployment request must be an object");
  const unknown = Object.keys(value).filter((key) => !requestFields.includes(key));
  if (unknown.length) invalid(`deployment request contains unknown property '${printable(unknown[0])}'`);
  if (value.version !== 1) invalid("deployment request version must be 1");
  let deploymentId;
  try { deploymentId = validateDeploymentId(value.deploymentId); } catch { invalid("deployment-id has an invalid format"); }
  if (deploymentId.length > 128) invalid("deployment-id exceeds 128 characters");
  if (!Array.isArray(value.composeFiles) || value.composeFiles.length < 1 || value.composeFiles.length > limits.composeFiles) {
    invalid(`compose-files must contain 1-${limits.composeFiles} files`);
  }
  const seen = new Set();
  const composeFiles = value.composeFiles.map((file, index) => {
    if (!isRecord(file) || Object.keys(file).some((key) => key !== "path" && key !== "content")) invalid(`composeFiles[${index}] must contain only path and content`);
    const path = validateComposeFilePath(file.path);
    if (seen.has(path)) invalid("compose-files contains a duplicate path");
    seen.add(path);
    if (typeof file.content !== "string" || file.content.length === 0) invalid(`compose file '${path}' is empty`);
    if (Buffer.byteLength(file.content, "utf8") > limits.composeFileBytes) invalid(`compose file '${path}' exceeds 256 KiB`);
    if (file.content.includes("\0")) invalid(`compose file '${path}' contains NUL characters`);
    return { path, content: file.content };
  });
  const migrationService = value.migrationService === "" ? "" : validateServiceName(value.migrationService, "migration-service");
  if (!Array.isArray(value.healthServices)) invalid("health-services must be a list");
  const healthServices = parseServiceList(value.healthServices.join("\n"), "health-services");
  if (migrationService && healthServices.includes(migrationService)) invalid("health-services must not include the one-shot migration-service");
  return {
    version: 1,
    environment: validateEnvironment(value.environment),
    deploymentId,
    stackName: validateStackName(value.stackName),
    remoteDeploymentPath: validateRemoteDeploymentPath(value.remoteDeploymentPath),
    composeFiles,
    componentServiceMap: parseComponentServiceMap(value.componentServiceMap),
    migrationService,
    migrationTimeoutSeconds: parseIntegerInput(value.migrationTimeoutSeconds, "migration-timeout-seconds", limits.migrationTimeout),
    healthServices,
    healthChecks: parseHealthChecks(value.healthChecks),
    healthTimeoutSeconds: parseIntegerInput(value.healthTimeoutSeconds, "health-timeout-seconds", limits.healthTimeout),
    rollbackOnHealthFailure: parseBooleanInput(value.rollbackOnHealthFailure, "rollback-on-health-failure"),
    workflow: validateWorkflowIdentity(value.workflow),
  };
}

/** Validate that request-level cross references agree with the manifest. */
export function validateRequestAgainstManifest(request, release) {
  const services = resolveComponentServices(release.components, request.componentServiceMap);
  if (request.migrationService && !services.has(request.migrationService)) {
    invalid("migration-service must be the Compose service of a release component so the release's migration image is used");
  }
  return services;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Render an untrusted value safely inside an error message. */
export function printable(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.replace(/[\u0000-\u001f\u007f]/gu, "?").slice(0, 80);
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Public deployment outcomes (workflow output `deployment-outcome`). Derived only
 * from fields every version-1 host result carries, so a runner newer than the
 * installed host helper still classifies correctly.
 */
export const deploymentOutcomes = Object.freeze([
  "succeeded", "failed-before-rollout", "restored-after-failure", "restoration-failed",
  "failed-restoration-disabled", "failed-no-previous-release", "unknown",
]);

const restorationOutcomes = new Map([
  ["not-required", "failed-before-rollout"],
  ["restored", "restored-after-failure"],
  ["failed", "restoration-failed"],
  ["disabled", "failed-restoration-disabled"],
  ["no-previous-release", "failed-no-previous-release"],
]);

export function classifyDeploymentOutcome(result) {
  if (!isRecord(result)) return "unknown";
  if (result.status === "succeeded") return "succeeded";
  const restoration = isRecord(result.restoration) ? result.restoration.outcome : undefined;
  return restorationOutcomes.get(restoration) ?? "unknown";
}

/** Public migration statuses (workflow output `migration-status`). */
export const migrationStatuses = Object.freeze(["not-configured", "not-run", "not-started", "failed", "timed-out", "succeeded", "unknown"]);

export function classifyMigrationStatus(migration, failedPhase) {
  if (!isRecord(migration)) return "unknown";
  if (migration.configured !== true) return "not-configured";
  if (migrationStatuses.includes(migration.status)) return migration.status;
  // Results from host helpers that predate `migration.status`.
  if (migration.timedOut === true) return "timed-out";
  if (migration.exitCode === 0) return "succeeded";
  if (Number.isInteger(migration.exitCode)) return "failed";
  return failedPhase === "migration" ? "failed" : "not-run";
}
