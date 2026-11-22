#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const componentPattern = /^[a-z0-9][a-z0-9._-]*$/u;
const repositoryPattern = /^docker\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/u;
const sourceRepositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const commitPattern = /^[0-9a-fA-F]{40}$/u;
const deploymentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const platformPattern = /^linux\/(?:amd64|arm64)$/u;
const buildArgNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const suspiciousName = /(?:auth|credential|key|password|private|secret|token)/iu;
const suspiciousValue = /(?:-----BEGIN|(?:https?:\/\/)[^\s/@:]+:[^\s/@]+@|github_pat_|\bgh[pousr]_[A-Za-z0-9])/iu;
const topFields = new Set(["schemaVersion", "images"]);
const imageFields = new Set(["component", "image", "dockerfile", "context", "buildArgs"]);
const resultFields = new Set(["component", "image", "digest", "immutableReference", "tag", "platforms", "scan", "sbom", "provenance"]);
export const manifestOutputLimit = 256 * 1024;

export function parseJsonStrict(text, label = "JSON") {
  const parser = new StrictJsonParser(String(text), label);
  return parser.parse();
}

class StrictJsonParser {
  constructor(text, label) { this.text = text; this.label = label; this.index = 0; }
  parse() {
    const value = this.value();
    this.space();
    if (this.index !== this.text.length) this.fail("unexpected trailing content");
    return value;
  }
  value() {
    this.space();
    const char = this.text[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"') return this.string();
    if (char === "t" && this.take("true")) return true;
    if (char === "f" && this.take("false")) return false;
    if (char === "n" && this.take("null")) return null;
    const match = this.text.slice(this.index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (match) { this.index += match[0].length; return Number(match[0]); }
    this.fail("invalid value");
  }
  object() {
    this.index += 1; this.space();
    const result = {};
    if (this.text[this.index] === "}") { this.index += 1; return result; }
    while (true) {
      this.space();
      if (this.text[this.index] !== '"') this.fail("object property must be a string");
      const key = this.string();
      if (Object.hasOwn(result, key)) throw new Error(`${this.label} contains duplicate property '${key}'`);
      this.space();
      if (this.text[this.index] !== ":") this.fail("expected ':'");
      this.index += 1; result[key] = this.value(); this.space();
      if (this.text[this.index] === "}") { this.index += 1; return result; }
      if (this.text[this.index] !== ",") this.fail("expected ',' or '}'");
      this.index += 1;
    }
  }
  array() {
    this.index += 1; this.space(); const result = [];
    if (this.text[this.index] === "]") { this.index += 1; return result; }
    while (true) {
      result.push(this.value()); this.space();
      if (this.text[this.index] === "]") { this.index += 1; return result; }
      if (this.text[this.index] !== ",") this.fail("expected ',' or ']'");
      this.index += 1;
    }
  }
  string() {
    const start = this.index; this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index];
      if (char === '"') {
        this.index += 1;
        try { return JSON.parse(this.text.slice(start, this.index)); } catch { this.fail("invalid string"); }
      }
      if (char === "\\") this.index += 2;
      else { if (char.charCodeAt(0) < 0x20) this.fail("control character in string"); this.index += 1; }
    }
    this.fail("unterminated string");
  }
  take(value) { if (!this.text.startsWith(value, this.index)) return false; this.index += value.length; return true; }
  space() { while (/\s/u.test(this.text[this.index] ?? "")) this.index += 1; }
  fail(message) { throw new Error(`${this.label} is malformed near character ${this.index}: ${message}`); }
}

export function normalizeDeploymentTag(deploymentId) {
  validateDeploymentId(deploymentId);
  const candidate = `release-${deploymentId.toLowerCase()}`;
  if (candidate.length <= 128) return candidate;
  const suffix = createHash("sha256").update(deploymentId).digest("hex").slice(0, 8);
  return `${candidate.slice(0, 119)}-${suffix}`;
}

export function validateDeploymentId(value) {
  if (!deploymentPattern.test(String(value ?? ""))) throw new Error("deployment-id has an invalid format");
  return String(value);
}

export function parsePlatforms(value) {
  const entries = String(value ?? "linux/amd64").split(",").map((item) => item.trim()).filter(Boolean);
  if (entries.length === 0 || entries.length > 2 || new Set(entries).size !== entries.length || entries.some((item) => !platformPattern.test(item))) {
    throw new Error("platforms must be a unique comma-separated selection of linux/amd64 and linux/arm64");
  }
  return entries;
}

export function parsePackageAuthComponents(value, knownComponents) {
  const entries = String(value ?? "").replaceAll("\r\n", "\n").split("\n").map((item) => item.trim()).filter(Boolean);
  if (new Set(entries).size !== entries.length) throw new Error("package-auth-components contains a duplicate component");
  const known = new Set(knownComponents);
  for (const entry of entries) {
    if (!componentPattern.test(entry) || !known.has(entry)) throw new Error(`package-auth-components contains unknown component '${entry}'`);
  }
  return entries;
}

export function validateCredentialPair(required, username, token) {
  const hasUsername = Boolean(username);
  const hasToken = Boolean(token);
  if (hasUsername !== hasToken) throw new Error("GitHub Packages credentials must be supplied as a complete pair");
  if (required && !hasUsername) throw new Error("package-auth-components requires GitHub Packages credentials");
}

/** Validates the package credential pair for one matrix component. Never reports credential values. */
export function checkPackageCredentials(environment) {
  const flag = environment.PACKAGE_AUTH_REQUIRED;
  if (flag !== "true" && flag !== "false") throw new Error("PACKAGE_AUTH_REQUIRED must be 'true' or 'false'");
  validateCredentialPair(flag === "true", environment.PACKAGE_USERNAME, environment.PACKAGE_TOKEN);
}

export function validateAndNormalizeConfig(configText, options) {
  const workspace = realpathSync(options.workspace);
  if (Buffer.byteLength(configText, "utf8") > 256 * 1024) throw new Error("image configuration exceeds 256 KiB");
  if (options.registry !== "docker.io") throw new Error("registry must be docker.io");
  const platforms = parsePlatforms(options.platforms);
  const config = parseJsonStrict(configText, "image configuration");
  if (!isRecord(config)) throw new Error("image configuration must be an object");
  rejectUnknown(config, topFields, "image configuration");
  if (config.schemaVersion !== 1) throw new Error("image configuration schemaVersion must be 1");
  if (!Array.isArray(config.images) || config.images.length < 1 || config.images.length > 100) throw new Error("image configuration images must contain between 1 and 100 entries");
  const components = new Set();
  const normalized = config.images.map((entry, index) => normalizeImage(entry, index, workspace, components));
  const packageAuth = parsePackageAuthComponents(options.packageAuthComponents, normalized.map((item) => item.component));
  // Credential presence is checked per component in build_publish (check-credentials), never here.
  const selected = new Set(packageAuth);
  return {
    schemaVersion: 1,
    registry: "docker.io",
    platforms,
    images: normalized.map((item) => ({
      ...item,
      buildArgsText: buildArgsList(item.buildArgs),
      packageAuth: selected.has(item.component),
    })),
  };
}

function normalizeImage(entry, index, workspace, components) {
  const label = `images[${index}]`;
  if (!isRecord(entry)) throw new Error(`${label} must be an object`);
  rejectUnknown(entry, imageFields, label);
  const component = entry.component;
  if (typeof component !== "string" || !componentPattern.test(component)) throw new Error(`${label}.component has an invalid format`);
  if (components.has(component)) throw new Error(`duplicate component '${component}'`);
  components.add(component);
  if (typeof entry.image !== "string" || entry.image.length > 255 || !repositoryPattern.test(entry.image)) throw new Error(`${component}.image must be an untagged docker.io repository`);
  const dockerfile = resolveContained(workspace, entry.dockerfile, `${component}.dockerfile`, "file");
  const context = resolveContained(workspace, entry.context ?? ".", `${component}.context`, "directory");
  if (!isWithin(context.absolute, dockerfile.absolute)) throw new Error(`${component}.dockerfile must be inside its build context`);
  const buildArgs = validateBuildArgs(entry.buildArgs, component);
  return { component, image: entry.image, dockerfile: dockerfile.relative, context: context.relative, buildArgs };
}

function validateBuildArgs(value, component) {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > 50) throw new Error(`${component}.buildArgs must be an object with at most 50 entries`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (!buildArgNamePattern.test(key) || suspiciousName.test(key)) throw new Error(`${component}.buildArgs contains a prohibited key '${key}'`);
    if (typeof item !== "string" || item.length > 4096 || suspiciousValue.test(item)) throw new Error(`${component}.buildArgs value for '${key}' is invalid or appears sensitive`);
    result[key] = item;
  }
  return result;
}

export function validatePrepareInputs(environment, workspace) {
  const deploymentId = validateDeploymentId(environment.DEPLOYMENT_ID);
  const sourceRepository = environment.SOURCE_REPOSITORY || environment.CALLER_REPOSITORY;
  const sourceCommit = environment.SOURCE_COMMIT || environment.CALLER_SHA;
  const buildReference = environment.BUILD_REFERENCE || environment.DEFAULT_BUILD_REFERENCE;
  if (!sourceRepositoryPattern.test(sourceRepository ?? "")) throw new Error("source-repository must use owner/repository format");
  if (!commitPattern.test(sourceCommit ?? "")) throw new Error("source-commit must be a full 40-character commit SHA");
  if (typeof buildReference !== "string" || buildReference.length < 1 || buildReference.length > 2048 || /[\u0000\r\n]/u.test(buildReference)) throw new Error("build-ref has an invalid format");
  const retentionDays = integer(environment.ARTIFACT_RETENTION_DAYS);
  if (retentionDays < 1 || retentionDays > 90) throw new Error("artifact-retention-days must be between 1 and 90");
  const configPath = resolveContained(realpathSync(workspace), environment.IMAGE_CONFIG_PATH ?? ".github/docker-images.json", "image-config-path", "file");
  const normalized = validateAndNormalizeConfig(readFileSync(configPath.absolute, "utf8"), {
    workspace,
    registry: environment.REGISTRY ?? "docker.io",
    platforms: environment.PLATFORMS ?? "linux/amd64",
    packageAuthComponents: environment.PACKAGE_AUTH_COMPONENTS,
  });
  const matrix = { include: normalized.images.map(({ buildArgs: _buildArgs, ...image }) => image) };
  return { buildReference, configPath: configPath.relative, deploymentId, matrix, normalized, retentionDays, sourceCommit: sourceCommit.toLowerCase(), sourceRepository, tag: normalizeDeploymentTag(deploymentId) };
}

export function buildArgsList(buildArgs) {
  return Object.keys(buildArgs).sort().map((key) => `${key}=${buildArgs[key]}`).join("\n");
}

export function createComponentResult(values) {
  if (!componentPattern.test(values.component ?? "")) throw new Error("component result has an invalid component");
  if (!repositoryPattern.test(values.image ?? "")) throw new Error(`${values.component}.image is invalid`);
  if (!digestPattern.test(values.digest ?? "")) throw new Error(`${values.component}.digest is invalid`);
  const scan = values.scanEnabled ? "passed" : "disabled";
  return {
    component: values.component,
    image: values.image,
    digest: values.digest,
    immutableReference: `${values.image}@${values.digest}`,
    tag: values.tag,
    platforms: parsePlatforms(values.platforms),
    scan,
    sbom: values.sbomEnabled ? "registry-attestation" : "disabled",
    provenance: values.provenanceEnabled ? "registry-attestation" : "disabled",
  };
}

export function aggregateRelease(values) {
  const normalized = typeof values.normalized === "string" ? parseJsonStrict(values.normalized, "normalized configuration") : values.normalized;
  if (!isRecord(normalized) || !Array.isArray(normalized.images)) throw new Error("normalized configuration is invalid");
  const expected = new Map(normalized.images.map((item) => [item.component, item]));
  const seen = new Map();
  for (const raw of values.results) {
    const result = typeof raw === "string" ? parseJsonStrict(raw, "component result") : raw;
    validateResult(result, expected, Boolean(values.scanImages), Boolean(values.generateSbom), Boolean(values.generateProvenance));
    if (seen.has(result.component)) throw new Error(`duplicate component result '${result.component}'`);
    seen.set(result.component, result);
  }
  for (const component of expected.keys()) if (!seen.has(component)) throw new Error(`missing component result '${component}'`);
  const components = normalized.images.map((image) => ({ name: image.component, image: image.image, digest: seen.get(image.component).digest }));
  const manifest = {
    schema_version: "1.0",
    deployment_id: validateDeploymentId(values.deploymentId),
    source_repository: values.sourceRepository,
    source_commit: values.sourceCommit,
    build_reference: values.buildReference,
    created_at: new Date(values.createdAt || Date.now()).toISOString(),
    components,
  };
  if (!sourceRepositoryPattern.test(manifest.source_repository) || !commitPattern.test(manifest.source_commit) || manifest.build_reference.length > 2048) throw new Error("release source metadata is invalid");
  const manifestJson = stableStringify(manifest);
  if (Buffer.byteLength(manifestJson, "utf8") > manifestOutputLimit) throw new Error("manifest exceeds the 256 KiB workflow output limit");
  const publishedImages = stableStringify(Object.fromEntries(normalized.images.map((image) => [image.component, `${image.image}@${seen.get(image.component).digest}`])));
  return { manifest, manifestJson, publishedImages };
}

function validateResult(result, expected, scanRequired, sbomRequired, provenanceRequired) {
  if (!isRecord(result)) throw new Error("component result must be an object");
  rejectUnknown(result, resultFields, "component result");
  const configured = expected.get(result.component);
  if (!configured) throw new Error(`unexpected component result '${String(result.component)}'`);
  if (result.image !== configured.image) throw new Error(`${result.component}.image does not match configuration`);
  if (!digestPattern.test(result.digest ?? "") || result.immutableReference !== `${result.image}@${result.digest}`) throw new Error(`${result.component}.digest or immutable reference is invalid`);
  if (scanRequired && result.scan !== "passed") throw new Error(`${result.component} is missing required successful vulnerability scan evidence`);
  if (sbomRequired && result.sbom !== "registry-attestation") throw new Error(`${result.component} is missing required SBOM evidence`);
  if (provenanceRequired && result.provenance !== "registry-attestation") throw new Error(`${result.component} is missing required provenance evidence`);
}

export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

function rejectUnknown(value, allowed, label) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unknown property '${unknown[0]}'`);
}
function resolveContained(root, input, label, kind) {
  if (typeof input !== "string" || input.length < 1 || input.length > 512 || isAbsolute(input) || input.includes("\0") || input.includes("\\") || input.split("/").includes("..")) throw new Error(`${label} must be a safe repository-relative path`);
  const candidate = resolve(root, input);
  if (!existsSync(candidate)) throw new Error(`${label} does not exist`);
  const info = lstatSync(candidate);
  if (info.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  const actual = realpathSync(candidate);
  if (!isWithin(root, actual)) throw new Error(`${label} escapes the repository`);
  const stats = statSync(actual);
  if (kind === "file" ? !stats.isFile() : !stats.isDirectory()) throw new Error(`${label} must identify a ${kind}`);
  return { absolute: actual, relative: toPosix(relative(root, actual)) || "." };
}
function isWithin(root, candidate) { const value = relative(root, candidate); return value === "" || (!value.startsWith("..") && !isAbsolute(value)); }
function toPosix(value) { return value.replaceAll("\\", "/"); }
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value) { if (!/^\d+$/u.test(String(value ?? ""))) return Number.NaN; return Number(value); }
function output(name, value) { if (!process.env.GITHUB_OUTPUT) return; writeFileSync(process.env.GITHUB_OUTPUT, `${name}=${String(value)}\n`, { flag: "a" }); }

function prepareCommand() {
  const prepared = validatePrepareInputs(process.env, process.env.GITHUB_WORKSPACE ?? process.cwd());
  const directory = process.env.PREPARED_DIRECTORY ?? resolve(process.cwd(), ".docker-publish-prepared");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, "normalized.json"), `${stableStringify(prepared.normalized)}\n`);
  output("matrix", stableStringify(prepared.matrix)); output("deployment-id", prepared.deploymentId); output("tag", prepared.tag);
  output("source-repository", prepared.sourceRepository); output("source-commit", prepared.sourceCommit); output("build-reference", prepared.buildReference); output("retention-days", prepared.retentionDays);
}
function componentCommand() {
  const result = createComponentResult({
    component: process.env.COMPONENT, image: process.env.IMAGE, digest: process.env.DIGEST, tag: process.env.TAG,
    platforms: process.env.PLATFORMS, scanEnabled: process.env.SCAN_IMAGES === "true", sbomEnabled: process.env.GENERATE_SBOM === "true", provenanceEnabled: process.env.GENERATE_PROVENANCE === "true",
  });
  const directory = process.env.RESULT_DIRECTORY; mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${result.component}.json`), `${stableStringify(result)}\n`);
}
function aggregateCommand() {
  const normalized = readFileSync(resolve(process.env.PREPARED_DIRECTORY, "normalized.json"), "utf8");
  const resultFiles = readdirSync(process.env.RESULT_DIRECTORY).filter((name) => name.endsWith(".json")).sort();
  const release = aggregateRelease({ normalized, results: resultFiles.map((name) => readFileSync(resolve(process.env.RESULT_DIRECTORY, name), "utf8")), deploymentId: process.env.DEPLOYMENT_ID, sourceRepository: process.env.SOURCE_REPOSITORY, sourceCommit: process.env.SOURCE_COMMIT, buildReference: process.env.BUILD_REFERENCE, createdAt: process.env.CREATED_AT, scanImages: process.env.SCAN_IMAGES === "true", generateSbom: process.env.GENERATE_SBOM === "true", generateProvenance: process.env.GENERATE_PROVENANCE === "true" });
  mkdirSync(process.env.MANIFEST_DIRECTORY, { recursive: true });
  writeFileSync(resolve(process.env.MANIFEST_DIRECTORY, "deployment-manifest.json"), `${release.manifestJson}\n`);
  output("manifest-json", release.manifestJson); output("published-images", release.publishedImages);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    if (process.argv[2] === "prepare") prepareCommand();
    else if (process.argv[2] === "check-credentials") checkPackageCredentials(process.env);
    else if (process.argv[2] === "component") componentCommand();
    else if (process.argv[2] === "aggregate") aggregateCommand();
    else throw new Error("usage: docker-publish.mjs <prepare|check-credentials|component|aggregate>");
  } catch (error) { console.error(`docker-publish: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
