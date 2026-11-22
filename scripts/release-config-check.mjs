#!/usr/bin/env node
// GitHub Actions runner helper for release-config-check.yml. It validates the
// caller's release configuration with the same code that docker-publish.yml and
// vps-deploy.yml (runner and host) run later, so misconfiguration fails on a pull
// request instead of at publish or deploy time. It needs no credentials,
// registry, or VPS: the release manifest it checks against uses deterministic
// placeholder digests, and Compose is rendered from the caller's files plus a
// checked-in, non-secret stand-in for the host's stack.env.
// Workflow inputs arrive as environment variables and are never evaluated as shell.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateRelease, createComponentResult, validatePrepareInputs } from "./docker-publish.mjs";
import { prepareBundle, readWorkspaceFile } from "./vps-deploy.mjs";
import {
  imagesOverride, prescanComposeFiles, runtimeSecretTarget, selectHealthServices, selectLongRunningServices, validateMergedConfig,
} from "./vps-deploy/compose-policy.mjs";
import { validateRepositoryFilePath, validateRepositoryJsonPath } from "./vps-deploy/config.mjs";
import {
  DeployError, fail, isRecord, parseJsonStrict, printable, validateReleaseManifest, validateRequestAgainstManifest,
} from "./vps-deploy/contract.mjs";
import { DockerCompose } from "./vps-deploy/docker.mjs";
import { assertHealthCheckHosts } from "./vps-deploy/health.mjs";
import { assertProvenance, validateRegistry } from "./vps-deploy/registry.mjs";

const registryBytes = 64 * 1024;
const composeEnvBytes = 64 * 1024;
// DEVOPS-007 fixes every instance's output directory to <root>/<application>/<environment>/<service>.
const secretSourcePattern = /^\/run\/runtime-secrets\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9-]{0,62})\/current$/u;

/** A well-formed digest that cannot collide with a real image build. */
export function placeholderDigest(component) {
  return `sha256:${createHash("sha256").update(`devops-toolkit release-config-check placeholder ${component}`).digest("hex")}`;
}

function text(value) {
  return String(value ?? "").trim();
}

/**
 * The host derives each secret-bearing service's bind source from its runtime-secret
 * instance, which a pull request cannot see. Check the rendered source against the
 * fixed DEVOPS-007 layout instead (own service, one application/environment for the
 * whole stack) and hand that source to the host policy for every remaining rule.
 */
export function deriveSecretServices(config, registry) {
  const services = isRecord(config?.services) ? config.services : {};
  const resolved = new Map();
  let identity;
  for (const [service, entry] of registry.secretServices) {
    const definition = services[service];
    if (!isRecord(definition)) fail("compose", `registered secret-bearing service '${service}' is not defined by the Compose configuration`);
    const mounts = (Array.isArray(definition.volumes) ? definition.volumes : []).filter((mount) => isRecord(mount) && mount.target === runtimeSecretTarget);
    if (mounts.length !== 1) fail("compose", `service '${service}' must mount exactly its own runtime-secret generation at ${runtimeSecretTarget}`);
    const source = String(mounts[0].source ?? "");
    const match = secretSourcePattern.exec(source);
    if (!match || match[3] !== service) {
      fail("compose", `service '${service}' mounts ${runtimeSecretTarget} from '${printable(source)}'; expected /run/runtime-secrets/<application>/<environment>/${service}/current`);
    }
    const key = `${match[1]}/${match[2]}`;
    if (identity !== undefined && identity !== key) fail("compose", "all runtime-secret mounts of one stack must share an application and environment");
    identity = key;
    resolved.set(service, { ...entry, bindSource: source });
  }
  return resolved;
}

async function renderCompose(compose, request, componentServices, envText) {
  const directory = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "release-config-check-"));
  try {
    // Same layout as the host's staged release: compose-N files, then the digest override.
    const files = request.composeFiles.map((file, index) => {
      const path = join(directory, `compose-${index + 1}${file.path.endsWith(".yaml") ? ".yaml" : ".yml"}`);
      writeFileSync(path, file.content, { flag: "wx" });
      return path;
    });
    const override = join(directory, "images.override.json");
    writeFileSync(override, `${JSON.stringify(imagesOverride(componentServices))}\n`, { flag: "wx" });
    let envFile;
    if (envText !== undefined) {
      mkdirSync(join(directory, "host"));
      envFile = join(directory, "host", "stack.env");
      writeFileSync(envFile, envText, { flag: "wx" });
    }
    const project = { name: request.stackName, directory, files: [...files, override], envFile };
    return { all: await compose.config(project, { allProfiles: true }), defaults: await compose.config(project) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Validate the image configuration and, when deploy-config-path is set, the
 * deployment request, the rendered Compose model, and the optional repository
 * copy of the host stack registry. Returns a summary of what was checked.
 * Throws on the first problem.
 */
export async function checkReleaseConfiguration(env, workspace, { compose = new DockerCompose({ temporaryRoot: tmpdir() }) } = {}) {
  const deployConfigPath = text(env.DEPLOY_CONFIG_PATH);
  const registryPath = text(env.STACK_REGISTRY_PATH);
  const composeEnvPath = text(env.COMPOSE_ENV_FILE);
  if (!deployConfigPath && (registryPath || composeEnvPath || text(env.ENVIRONMENT) || text(env.STACK_NAME))) {
    throw new Error("environment, stack-name, stack-registry-path, and compose-env-file require deploy-config-path");
  }

  const prepared = validatePrepareInputs({
    DEPLOYMENT_ID: env.CALLER_SHA,
    IMAGE_CONFIG_PATH: env.IMAGE_CONFIG_PATH,
    PACKAGE_AUTH_COMPONENTS: env.PACKAGE_AUTH_COMPONENTS,
    CALLER_REPOSITORY: env.CALLER_REPOSITORY,
    CALLER_SHA: env.CALLER_SHA,
    DEFAULT_BUILD_REFERENCE: `${env.SERVER_URL ?? "https://github.com"}/${env.CALLER_REPOSITORY ?? ""}/actions/runs/${env.RUN_ID ?? ""}`,
    ARTIFACT_RETENTION_DAYS: "1",
  }, workspace);
  const normalized = /** @type {{ platforms: string[], images: Array<{ component: string, image: string, dockerfile: string, packageAuth: boolean }> }} */ (prepared.normalized);
  const summary = {
    images: normalized.images.map(({ component, image, dockerfile, packageAuth }) => ({ component, image, dockerfile, packageAuth })),
    deployment: undefined,
  };
  if (!deployConfigPath) return summary;

  const release = aggregateRelease({
    normalized,
    results: normalized.images.map((image) => createComponentResult({
      component: image.component, image: image.image, digest: placeholderDigest(image.component), tag: prepared.tag,
      platforms: normalized.platforms.join(","), scanEnabled: false, sbomEnabled: false, provenanceEnabled: false,
    })),
    deploymentId: prepared.deploymentId,
    sourceRepository: prepared.sourceRepository,
    sourceCommit: prepared.sourceCommit,
    buildReference: prepared.buildReference,
    scanImages: false,
  });
  const bundle = prepareBundle({
    ENVIRONMENT: env.ENVIRONMENT,
    STACK_NAME: env.STACK_NAME,
    DEPLOYMENT_ID: prepared.deploymentId,
    MANIFEST_JSON: release.manifestJson,
    DEPLOY_CONFIG_PATH: deployConfigPath,
    CALLER_WORKSPACE: workspace,
    CALLER_REPOSITORY: env.CALLER_REPOSITORY,
    CALLER_SHA: env.CALLER_SHA,
    CALLER_WORKFLOW_REF: env.CALLER_WORKFLOW_REF,
    RUN_ID: env.RUN_ID,
    RUN_ATTEMPT: env.RUN_ATTEMPT,
    ACTOR: env.ACTOR,
    EVENT_NAME: env.EVENT_NAME,
    SERVER_URL: env.SERVER_URL,
    TOOLKIT_REPOSITORY: env.TOOLKIT_REPOSITORY,
    TOOLKIT_SHA: env.TOOLKIT_SHA,
  });
  const { request } = bundle;
  const validated = validateReleaseManifest(bundle.manifest, { deploymentId: request.deploymentId, sourceRepository: request.workflow.repository });
  const componentServices = validateRequestAgainstManifest(request, validated);

  let registry;
  if (registryPath) {
    validateRepositoryJsonPath(registryPath, "stack-registry-path");
    const registryText = readWorkspaceFile(workspace, registryPath, registryBytes, "stack registry");
    let parsed;
    try { parsed = parseJsonStrict(registryText, "host stack registry"); } catch (error) { fail("configuration", `host stack registry: ${error.message}`); }
    registry = validateRegistry(parsed, { expectedStack: request.stackName });
    if (request.environment !== registry.environment) fail("validation", "environment does not match the host stack registry");
    if (request.remoteDeploymentPath !== registry.deploymentPath) fail("validation", "remote-deployment-path does not match the host stack registry");
    assertProvenance(registry, validated);
    assertHealthCheckHosts(request.healthChecks, registry.healthCheckHosts);
  }

  // Compose: the host's pre-parse, then a render with every profile and the digest override.
  let envText;
  if (composeEnvPath) {
    validateRepositoryFilePath(composeEnvPath, "compose-env-file");
    envText = readWorkspaceFile(workspace, composeEnvPath, composeEnvBytes, "compose env file");
  }
  await prescanComposeFiles(request.composeFiles);
  const rendered = await renderCompose(compose, request, componentServices, envText);
  const names = new Set(Object.keys(isRecord(rendered.all?.services) ? rendered.all.services : {}));
  for (const [service] of componentServices) {
    if (!names.has(service)) fail("compose", `release component service '${service}' is not defined by the Compose configuration`);
  }
  if (request.migrationService && !names.has(request.migrationService)) fail("compose", `migration-service '${request.migrationService}' is not defined by the Compose configuration`);
  const longRunning = selectLongRunningServices(rendered.defaults, request.migrationService);
  const healthServices = selectHealthServices(request.healthServices, longRunning);
  let secretServices = new Map();
  if (registry) {
    secretServices = deriveSecretServices(rendered.all, registry);
    validateMergedConfig(rendered.all, { componentServices, secretServices, migrationService: request.migrationService, registry });
  }

  summary.deployment = {
    environment: request.environment,
    stackName: request.stackName,
    remoteDeploymentPath: request.remoteDeploymentPath,
    composeFiles: request.composeFiles.map((file) => file.path),
    componentServices: normalized.images.map(({ component }) => ({ component, service: request.componentServiceMap[component] ?? component })),
    migrationService: request.migrationService,
    longRunningServices: longRunning,
    healthServices,
    healthChecks: request.healthChecks.map((check) => check.name),
    secretServices: [...secretServices.keys()],
    composeEnvFile: composeEnvPath,
    registryChecked: Boolean(registry),
  };
  return summary;
}

/** Markdown job summary. Every value was validated against a restrictive pattern. */
export function configurationSummary(summary) {
  const lines = ["### Release configuration check passed", "", "| Component | Image | Dockerfile | Package auth |", "| --- | --- | --- | --- |"];
  for (const image of summary.images) lines.push(`| ${image.component} | \`${image.image}\` | \`${image.dockerfile}\` | ${image.packageAuth ? "yes" : "no"} |`);
  const deployment = summary.deployment;
  if (deployment) {
    const list = (values) => (values.length ? values.map((value) => `\`${value}\``).join(", ") : "—");
    lines.push(
      "",
      `Deployment of stack \`${deployment.stackName}\` to \`${deployment.environment}\` at \`${deployment.remoteDeploymentPath}\`:`,
      "",
      `- Compose files: ${list(deployment.composeFiles)}${deployment.composeEnvFile ? ` (rendered with \`${deployment.composeEnvFile}\`)` : " (rendered without an env file)"}`,
      `- Release services: ${deployment.componentServices.map(({ component, service }) => (component === service ? `\`${service}\`` : `\`${component}\` → \`${service}\``)).join(", ")}`,
      `- Migration service: ${deployment.migrationService ? `\`${deployment.migrationService}\`` : "none"}`,
      `- Long-running services: ${list(deployment.longRunningServices)}`,
      `- Health services: ${list(deployment.healthServices)}`,
      `- Health checks: ${list(deployment.healthChecks)}`,
      deployment.registryChecked
        ? `- Host stack registry copy: checked, including the Compose policy; runtime-secret mounts: ${list(deployment.secretServices)}`
        : "- Host stack registry copy: not provided, so the Compose policy was not checked",
    );
  }
  lines.push("", "No image was built or pushed and nothing was deployed. The host re-validates everything at deploy time against its own registry, stack.env, and runtime-secret instances.", "");
  return lines.join("\n");
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const summary = await checkReleaseConfiguration(process.env, process.env.CALLER_WORKSPACE ?? process.env.GITHUB_WORKSPACE ?? process.cwd());
    if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, configurationSummary(summary), { flag: "a" });
    console.log(`Release configuration is valid: ${summary.images.length} image(s)${summary.deployment ? `, stack ${summary.deployment.stackName}` : ""}.`);
  } catch (error) {
    const message = error instanceof DeployError || error instanceof Error ? error.message : String(error);
    console.error(`release-config-check: ${message}`);
    process.exitCode = 1;
  }
}
