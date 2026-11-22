import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyDeployConfig, deploymentSettingsFromConfig, fileOwnedInputs, validateRepositoryJsonPath } from "../scripts/vps-deploy/config.mjs";
import { prepareBundle, validateInputs } from "../scripts/vps-deploy.mjs";
import { commit, manifestObject, repository } from "./helpers/vps-deploy-fixtures.js";

const root = join(import.meta.dirname, "..");

const config = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  composeFiles: ["deploy/compose.yml"],
  remoteDeploymentPath: "/srv/example-backend/production",
  componentServiceMap: { migrator: "database-migrator" },
  migrationService: "database-migrator",
  migrationTimeoutSeconds: 900,
  healthServices: ["webapi"],
  healthChecks: [{ name: "api", url: "http://127.0.0.1:8080/health", expectedStatus: [200, 204] }],
  healthTimeoutSeconds: 120,
  rollbackOnHealthFailure: false,
  ...overrides,
});

function workspace(configText = JSON.stringify(config())) {
  const directory = mkdtempSync(join(tmpdir(), "vps-deploy-config-"));
  mkdirSync(join(directory, "deploy"));
  mkdirSync(join(directory, ".github"));
  writeFileSync(join(directory, "deploy", "compose.yml"), "services:\n  webapi:\n    image: placeholder\n");
  writeFileSync(join(directory, ".github", "vps-deploy.production.json"), configText);
  return directory;
}

/** Identity, transport, manifest, and run inputs only: every topology input is left unset. */
function env(directory: string, overrides: Record<string, string> = {}) {
  return {
    ENVIRONMENT: "production", DEPLOYMENT_ID: commit, STACK_NAME: "example-backend-production",
    MANIFEST_JSON: JSON.stringify(manifestObject()), MANIFEST_ARTIFACT: "", SSH_PORT: "22",
    DEPLOY_CONFIG_PATH: ".github/vps-deploy.production.json",
    CALLER_WORKSPACE: directory, CALLER_REPOSITORY: repository, CALLER_SHA: commit, CALLER_WORKFLOW_REF: "example/backend/.github/workflows/ci.yml@refs/heads/main",
    RUN_ID: "42", RUN_ATTEMPT: "1", ACTOR: "octocat", EVENT_NAME: "push", SERVER_URL: "https://github.com",
    TOOLKIT_REPOSITORY: "example/devops-toolkit", TOOLKIT_SHA: commit,
    ...overrides,
  };
}

describe("vps-deploy deployment configuration file", () => {
  it("translates every field into the inline input it replaces", () => {
    expect(deploymentSettingsFromConfig(JSON.stringify(config()))).toEqual({
      COMPOSE_FILES: "deploy/compose.yml",
      REMOTE_DEPLOYMENT_PATH: "/srv/example-backend/production",
      COMPONENT_SERVICE_MAP: '{"migrator":"database-migrator"}',
      MIGRATION_SERVICE: "database-migrator",
      MIGRATION_TIMEOUT_SECONDS: "900",
      HEALTH_SERVICES: "webapi",
      HEALTH_CHECKS: '[{"name":"api","url":"http://127.0.0.1:8080/health","expectedStatus":[200,204]}]',
      HEALTH_TIMEOUT_SECONDS: "120",
      ROLLBACK_ON_HEALTH_FAILURE: "false",
    });
  });

  it("gives omitted optional fields the inline input defaults", () => {
    const minimal = deploymentSettingsFromConfig(JSON.stringify({ version: 1, composeFiles: ["a.yml"], remoteDeploymentPath: "/srv/a/b" }));
    expect(minimal).toEqual({ ...fileOwnedInputs, COMPOSE_FILES: "a.yml", REMOTE_DEPLOYMENT_PATH: "/srv/a/b" });
  });

  it("validates the file with the same rules as the inline inputs", () => {
    const directory = workspace();
    const inputs = validateInputs(env(directory));
    expect(inputs).toMatchObject({
      composeFiles: ["deploy/compose.yml"], remoteDeploymentPath: "/srv/example-backend/production", componentServiceMap: { migrator: "database-migrator" },
      migrationService: "database-migrator", migrationTimeoutSeconds: 900, healthServices: ["webapi"], healthTimeoutSeconds: 120, rollbackOnHealthFailure: false,
    });
    expect(inputs.healthChecks).toEqual([{ name: "api", url: "http://127.0.0.1:8080/health", expectedStatus: [200, 204] }]);
    const bundle = prepareBundle(env(directory));
    expect(bundle.request.composeFiles[0]?.content).toContain("webapi");
  });

  it("produces the same deployment request as the equivalent inline inputs", () => {
    const directory = workspace();
    const inline = { ...env(directory, deploymentSettingsFromConfig(JSON.stringify(config()))), DEPLOY_CONFIG_PATH: "" };
    expect(prepareBundle(env(directory)).request).toEqual(prepareBundle(inline).request);
  });

  it("matches each example caller's previous inline deployment inputs", () => {
    const dotnet = deploymentSettingsFromConfig(readFileSync(join(root, "examples", "dotnet", "vps-deploy-config.json"), "utf8"));
    expect(dotnet).toMatchObject({
      COMPOSE_FILES: "deploy/compose.production.yml", REMOTE_DEPLOYMENT_PATH: "/srv/example-backend/production", COMPONENT_SERVICE_MAP: '{"migrator":"database-migrator"}',
      MIGRATION_SERVICE: "database-migrator", MIGRATION_TIMEOUT_SECONDS: "900", HEALTH_TIMEOUT_SECONDS: "300", ROLLBACK_ON_HEALTH_FAILURE: "true",
    });
    const nextjs = deploymentSettingsFromConfig(readFileSync(join(root, "examples", "nextjs", "vps-deploy-config.json"), "utf8"));
    expect(nextjs).toMatchObject({ COMPOSE_FILES: "deploy/compose.production.yml", REMOTE_DEPLOYMENT_PATH: "/srv/example-frontend/production", MIGRATION_SERVICE: "" });
    expect(JSON.parse(nextjs.HEALTH_CHECKS)).toHaveLength(3);
  });

  it.each(Object.entries({
    COMPOSE_FILES: "deploy/compose.yml",
    REMOTE_DEPLOYMENT_PATH: "/srv/example-backend/production",
    COMPONENT_SERVICE_MAP: '{"migrator":"database-migrator"}',
    MIGRATION_SERVICE: "database-migrator",
    MIGRATION_TIMEOUT_SECONDS: "900",
    HEALTH_SERVICES: "webapi",
    HEALTH_CHECKS: '[{"name":"api","url":"http://127.0.0.1:8080/health"}]',
    HEALTH_TIMEOUT_SECONDS: "120",
    ROLLBACK_ON_HEALTH_FAILURE: "false",
  }))("rejects %s declared both inline and in the file", (name, value) => {
    expect(() => validateInputs(env(workspace(), { [name]: value }))).toThrow(/cannot be combined with deploy-config-path/u);
  });

  it("accepts inline inputs left at their workflow defaults", () => {
    expect(() => validateInputs(env(workspace(), { ...fileOwnedInputs }))).not.toThrow();
  });

  it.each([
    ["malformed JSON", "{", /malformed/u],
    ["duplicate key", '{"version":1,"version":1}', /duplicate/u],
    ["array root", "[]", /root must be an object/u],
    ["unknown field", JSON.stringify(config({ stackName: "x" })), /unknown field 'stackName'/u],
    ["unsupported version", JSON.stringify(config({ version: 2 })), /version must be 1/u],
    ["missing composeFiles", JSON.stringify(config({ composeFiles: undefined })), /composeFiles/u],
    ["empty composeFiles", JSON.stringify(config({ composeFiles: [] })), /composeFiles/u],
    ["newline smuggled into a list", JSON.stringify(config({ composeFiles: ["deploy/compose.yml\nother.yml"] })), /single-line/u],
    ["string composeFiles", JSON.stringify(config({ composeFiles: "deploy/compose.yml" })), /composeFiles must list/u],
    ["string healthServices", JSON.stringify(config({ healthServices: "webapi" })), /array of strings/u],
    ["numeric path", JSON.stringify(config({ remoteDeploymentPath: 7 })), /remoteDeploymentPath/u],
    ["string map", JSON.stringify(config({ componentServiceMap: "{}" })), /componentServiceMap/u],
    ["fractional timeout", JSON.stringify(config({ migrationTimeoutSeconds: 1.5 })), /integer/u],
    ["string boolean", JSON.stringify(config({ rollbackOnHealthFailure: "true" })), /boolean/u],
    ["string health checks", JSON.stringify(config({ healthChecks: "[]" })), /healthChecks/u],
  ])("rejects %s", (_label, text, message) => {
    expect(() => deploymentSettingsFromConfig(text)).toThrow(message);
  });

  it("applies the inline input rules to translated values", () => {
    expect(() => validateInputs(env(workspace(JSON.stringify(config({ composeFiles: ["../escape.yml"] })))))).toThrow(/unsafe path segment/u);
    expect(() => validateInputs(env(workspace(JSON.stringify(config({ remoteDeploymentPath: "/srv" })))))).toThrow(/remote-deployment-path/u);
    expect(() => validateInputs(env(workspace(JSON.stringify(config({ migrationTimeoutSeconds: 99999 })))))).toThrow(/migration-timeout-seconds/u);
    expect(() => validateInputs(env(workspace(JSON.stringify(config({ healthChecks: [{ name: "x", url: "ftp://h/" }] })))))).toThrow(/http or https/u);
    expect(() => prepareBundle(env(workspace(JSON.stringify(config({ migrationService: "worker" })))))).toThrow(/release component/u);
  });

  it.each([
    [".github/vps-deploy.json", true],
    ["deploy/production.json", true],
    ["/etc/vps-deploy.json", false],
    ["../vps-deploy.json", false],
    ["deploy/./vps-deploy.json", false],
    ["deploy\\vps-deploy.json", false],
    ["deploy/vps-deploy.yml", false],
    ["deploy/vps deploy.json", false],
  ])("validates deploy-config-path %s", (path, valid) => {
    if (valid) expect(validateRepositoryJsonPath(path, "deploy-config-path")).toBe(path);
    else expect(() => validateRepositoryJsonPath(path, "deploy-config-path")).toThrow(/deploy-config-path/u);
  });

  it("reports a missing file and leaves inline inputs untouched without a path", () => {
    expect(() => validateInputs(env(workspace(), { DEPLOY_CONFIG_PATH: ".github/missing.json" }))).toThrow(/deployment configuration '.github\/missing.json' does not exist/u);
    const inline = { COMPOSE_FILES: "a.yml", DEPLOY_CONFIG_PATH: "  " };
    expect(applyDeployConfig(inline, () => { throw new Error("must not read"); })).toBe(inline);
  });

  it("keeps compose-files and remote-deployment-path required without a configuration file", () => {
    expect(() => validateInputs(env(workspace(), { DEPLOY_CONFIG_PATH: "", REMOTE_DEPLOYMENT_PATH: "/srv/example-backend/production" }))).toThrow(/compose-files must list/u);
    expect(() => validateInputs(env(workspace(), { DEPLOY_CONFIG_PATH: "", COMPOSE_FILES: "deploy/compose.yml" }))).toThrow(/remote-deployment-path/u);
  });

  it.runIf(process.platform !== "win32")("rejects a configuration file reached through a symbolic link", () => {
    const directory = workspace();
    const outside = mkdtempSync(join(tmpdir(), "vps-deploy-config-outside-"));
    writeFileSync(join(outside, "config.json"), JSON.stringify(config()));
    symlinkSync(join(outside, "config.json"), join(directory, ".github", "linked.json"));
    expect(() => validateInputs(env(directory, { DEPLOY_CONFIG_PATH: ".github/linked.json" }))).toThrow(/symbolic link/u);
  });
});
