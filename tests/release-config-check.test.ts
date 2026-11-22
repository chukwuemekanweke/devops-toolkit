import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkReleaseConfiguration, configurationSummary, placeholderDigest } from "../scripts/release-config-check.mjs";
import { DockerCompose } from "../scripts/vps-deploy/docker.mjs";
import { commit, repository } from "./helpers/vps-deploy-fixtures.js";

const images = {
  schemaVersion: 1,
  images: [
    { component: "webapi", image: "docker.io/example/backend-webapi", dockerfile: "src/WebAPI/Dockerfile" },
    { component: "migrator", image: "docker.io/example/backend-migrator", dockerfile: "src/Migrator/Dockerfile" },
  ],
};

const deployConfig = {
  version: 1,
  composeFiles: ["deploy/compose.production.yml"],
  remoteDeploymentPath: "/srv/example-backend/production",
  componentServiceMap: { migrator: "database-migrator" },
  migrationService: "database-migrator",
  healthServices: ["webapi"],
  healthChecks: [{ name: "webapi", url: "http://127.0.0.1:8080/health" }],
};

const registry = {
  version: 1,
  stackName: "example-backend-production",
  environment: "production",
  deploymentPath: "/srv/example-backend/production",
  allowedSourceRepositories: [repository],
  allowedImageRepositories: ["docker.io/example/"],
  runtimeSecrets: {
    services: {
      webapi: { instance: "exb-prd-api" },
      "database-migrator": { instance: "exb-prd-mig", startAtBoot: false },
    },
  },
};

const secretMount = (service: string) => `
      - type: bind
        source: \${RUNTIME_SECRETS_ROOT:-/run/runtime-secrets}/\${RUNTIME_SECRETS_APPLICATION:?required}/\${RUNTIME_SECRETS_ENVIRONMENT:?required}/${service}/current
        target: /run/secrets/app
        read_only: true
        bind:
          create_host_path: false`;

const compose = `services:
  database-migrator:
    image: release-component
    profiles: ["migration"]
    restart: "no"
    security_opt: ["no-new-privileges:true"]
    volumes:${secretMount("database-migrator")}
  webapi:
    image: release-component
    restart: "no"
    security_opt: ["no-new-privileges:true"]
    ports:
      - "127.0.0.1:8080:8080"
    volumes:${secretMount("webapi")}
`;

const stackEnv = "RUNTIME_SECRETS_APPLICATION=example-backend\nRUNTIME_SECRETS_ENVIRONMENT=prd\n";

interface Files { images?: unknown; deploy?: unknown; registry?: unknown; compose?: string; stackEnv?: string }

function workspace(files: Files = {}) {
  const directory = mkdtempSync(join(tmpdir(), "release-config-check-"));
  for (const folder of [".github", "deploy", "src/WebAPI", "src/Migrator"]) mkdirSync(join(directory, folder), { recursive: true });
  writeFileSync(join(directory, "src/WebAPI/Dockerfile"), "FROM scratch\n");
  writeFileSync(join(directory, "src/Migrator/Dockerfile"), "FROM scratch\n");
  writeFileSync(join(directory, "deploy/compose.production.yml"), files.compose ?? compose);
  writeFileSync(join(directory, "deploy/stack.env.example"), files.stackEnv ?? stackEnv);
  writeFileSync(join(directory, ".github/docker-images.json"), JSON.stringify(files.images ?? images));
  writeFileSync(join(directory, ".github/vps-deploy.production.json"), JSON.stringify(files.deploy ?? deployConfig));
  writeFileSync(join(directory, "deploy/vps-deploy-stack.production.json"), JSON.stringify(files.registry ?? registry));
  return directory;
}

function env(overrides: Record<string, string> = {}) {
  return {
    IMAGE_CONFIG_PATH: ".github/docker-images.json", PACKAGE_AUTH_COMPONENTS: "webapi\nmigrator",
    DEPLOY_CONFIG_PATH: ".github/vps-deploy.production.json", ENVIRONMENT: "production", STACK_NAME: "example-backend-production",
    STACK_REGISTRY_PATH: "deploy/vps-deploy-stack.production.json", COMPOSE_ENV_FILE: "deploy/stack.env.example",
    CALLER_REPOSITORY: repository, CALLER_SHA: commit, CALLER_WORKFLOW_REF: `${repository}/.github/workflows/ci.yml@refs/pull/7/merge`,
    RUN_ID: "42", RUN_ATTEMPT: "1", ACTOR: "octocat", EVENT_NAME: "pull_request", SERVER_URL: "https://github.com",
    TOOLKIT_REPOSITORY: "example/devops-toolkit", TOOLKIT_SHA: commit,
    ...overrides,
  };
}

interface Project { name: string; directory: string; files: string[]; envFile?: string }
type Json = Record<string, unknown>;

/**
 * Minimal stand-in for `docker compose config --format json`: variable
 * interpolation from the env file, file merging, long-syntax ports, and profile
 * selection. The real CLI is exercised by the Linux-only test below.
 */
class FakeCompose {
  public readonly projects: Array<{ project: Project; allProfiles: boolean; envText: string | undefined }> = [];

  public async config(project: Project, { allProfiles = false } = {}): Promise<Json> {
    const envText = project.envFile ? readFileSync(project.envFile, "utf8") : undefined;
    this.projects.push({ project, allProfiles, envText });
    const variables = new Map((envText ?? "").split("\n").filter((line) => line.includes("=")).map((line) => line.split("=", 2) as [string, string]));
    const interpolate = (text: string) => text.replace(/\$\{([A-Z_]+)(?::([-?])([^}]*))?\}/gu, (_all, name: string, kind?: string, word?: string) => {
      const value = variables.get(name);
      if (value) return value;
      if (kind === "?") throw new Error(`docker compose config rejected the configuration: required variable ${name} is missing a value: ${word}`);
      return kind === "-" ? word ?? "" : "";
    });
    const services: Record<string, Json> = {};
    for (const file of project.files) {
      const document = parse(interpolate(readFileSync(file, "utf8"))) as { services?: Record<string, Json> };
      for (const [name, definition] of Object.entries(document.services ?? {})) services[name] = { ...services[name], ...definition };
    }
    for (const definition of Object.values(services)) {
      if (Array.isArray(definition.ports)) {
        definition.ports = definition.ports.map((port) => {
          const [hostIp, published, target] = String(port).split(":");
          return { host_ip: hostIp, published, target: Number(target) };
        });
      }
    }
    const selected = Object.fromEntries(Object.entries(services).filter(([, definition]) => allProfiles || !definition.profiles));
    return { name: project.name, services: selected };
  }
}

const run = (values = env(), files: Files = {}, fake = new FakeCompose()) => checkReleaseConfiguration(values, workspace(files), { compose: fake });

describe("release configuration check", () => {
  it("validates images, the request, the registry copy, and the Compose policy without credentials", async () => {
    const summary = await run();
    expect(summary.images).toEqual([
      { component: "webapi", image: "docker.io/example/backend-webapi", dockerfile: "src/WebAPI/Dockerfile", packageAuth: true },
      { component: "migrator", image: "docker.io/example/backend-migrator", dockerfile: "src/Migrator/Dockerfile", packageAuth: true },
    ]);
    expect(summary.deployment).toMatchObject({
      environment: "production", stackName: "example-backend-production", composeFiles: ["deploy/compose.production.yml"],
      componentServices: [{ component: "webapi", service: "webapi" }, { component: "migrator", service: "database-migrator" }],
      migrationService: "database-migrator", longRunningServices: ["webapi"], healthServices: ["webapi"], healthChecks: ["webapi"],
      secretServices: ["webapi", "database-migrator"], composeEnvFile: "deploy/stack.env.example", registryChecked: true,
    });
  });

  it("renders like the host: staged compose-N files, the digest override, the env file, and every profile", async () => {
    const fake = new FakeCompose();
    await run(env(), {}, fake);
    expect(fake.projects.map((entry) => entry.allProfiles)).toEqual([true, false]);
    const { project, envText } = fake.projects[0]!;
    expect(project.name).toBe("example-backend-production");
    expect(project.files.map((file) => file.slice(project.directory.length + 1))).toEqual(["compose-1.yml", "images.override.json"]);
    expect(envText).toBe(stackEnv);
  });

  it("checks only the image configuration when no deployment configuration is given", async () => {
    const fake = new FakeCompose();
    const summary = await run(env({ DEPLOY_CONFIG_PATH: "", ENVIRONMENT: "", STACK_NAME: "", STACK_REGISTRY_PATH: "", COMPOSE_ENV_FILE: "" }), {}, fake);
    expect(summary.deployment).toBeUndefined();
    expect(fake.projects).toHaveLength(0);
    expect(configurationSummary(summary)).not.toContain("Deployment of stack");
  });

  it("renders Compose but skips the registry-dependent policy without a registry copy", async () => {
    const insecure = compose.replace('    restart: "no"\n    security_opt: ["no-new-privileges:true"]\n    ports:', "    privileged: true\n    ports:");
    const summary = await run(env({ STACK_REGISTRY_PATH: "" }), { compose: insecure });
    expect(summary.deployment).toMatchObject({ registryChecked: false, secretServices: [], longRunningServices: ["webapi"] });
    expect(configurationSummary(summary)).toContain("the Compose policy was not checked");
  });

  it("uses well-formed placeholder digests that differ per component", () => {
    expect(placeholderDigest("webapi")).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(placeholderDigest("webapi")).not.toBe(placeholderDigest("migrator"));
  });

  it("summarizes what was checked and states that nothing was published", async () => {
    const text = configurationSummary(await run());
    expect(text).toContain("| webapi | `docker.io/example/backend-webapi` | `src/WebAPI/Dockerfile` | yes |");
    expect(text).toContain("`migrator` → `database-migrator`");
    expect(text).toContain("(rendered with `deploy/stack.env.example`)");
    expect(text).toContain("including the Compose policy; runtime-secret mounts: `webapi`, `database-migrator`");
    expect(text).toContain("No image was built or pushed");
  });

  const otherSource = compose.replace("/webapi/current", "/consumer/current");
  it.each<[string, Record<string, string>, Files, RegExp]>([
    ["deployment inputs without a configuration file", { DEPLOY_CONFIG_PATH: "" }, {}, /require deploy-config-path/u],
    ["an unknown package-auth component", { PACKAGE_AUTH_COMPONENTS: "worker" }, {}, /unknown component 'worker'/u],
    ["a missing Dockerfile", {}, { images: { schemaVersion: 1, images: [{ component: "webapi", image: "docker.io/example/backend-webapi", dockerfile: "src/Missing/Dockerfile" }] } }, /dockerfile/u],
    ["a tagged image", {}, { images: { schemaVersion: 1, images: [{ component: "webapi", image: "docker.io/example/webapi:latest", dockerfile: "src/WebAPI/Dockerfile" }] } }, /untagged/u],
    ["a missing stack name", { STACK_NAME: "" }, {}, /stack/iu],
    ["a missing environment", { ENVIRONMENT: "" }, {}, /environment/u],
    ["a migration service that is not a release component", {}, { deploy: { ...deployConfig, migrationService: "worker" } }, /release component/u],
    ["a component mapped to an unknown component", {}, { deploy: { ...deployConfig, componentServiceMap: { jobs: "jobs" } } }, /unknown component 'jobs'/u],
    ["an unknown deployment configuration field", {}, { deploy: { ...deployConfig, stackName: "x" } }, /unknown field/u],
    ["a registry for another stack", {}, { registry: { ...registry, stackName: "other-stack" } }, /stackName does not match/u],
    ["a registry for another environment", {}, { registry: { ...registry, environment: "staging" } }, /environment does not match the host stack registry/u],
    ["a registry with another deployment path", {}, { registry: { ...registry, deploymentPath: "/srv/other/production" } }, /remote-deployment-path does not match/u],
    ["an unauthorized source repository", {}, { registry: { ...registry, allowedSourceRepositories: ["someone/else"] } }, /source_repository is not authorized/u],
    ["an unauthorized image namespace", {}, { registry: { ...registry, allowedImageRepositories: ["docker.io/other/"] } }, /image repository is not authorized/u],
    ["a health check host the registry does not allow", {}, { deploy: { ...deployConfig, healthChecks: [{ name: "webapi", url: "http://10.0.0.5:8080/health" }] } }, /does not allow/u],
    ["an invalid registry document", {}, { registry: { ...registry, version: 2 } }, /version must be 1/u],
    ["a registry path outside the repository rules", { STACK_REGISTRY_PATH: "../stack.json" }, {}, /stack-registry-path/u],
    ["a Compose env file outside the repository", { COMPOSE_ENV_FILE: "../stack.env" }, {}, /compose-env-file/u],
    ["a missing Compose env file", { COMPOSE_ENV_FILE: "deploy/missing.env" }, {}, /compose env file 'deploy\/missing.env' does not exist/u],
    ["a Compose file that needs host values the env file lacks", { COMPOSE_ENV_FILE: "" }, {}, /required variable/u],
    ["a Compose include", {}, { compose: `include: [other.yml]\n${compose}` }, /include/u],
    ["a service env_file", {}, { compose: compose.replace("  webapi:\n", "  webapi:\n    env_file: app.env\n") }, /env_file/u],
    // The digest override itself defines every release service, as on the host, so a
    // renamed service surfaces through the registry's secret-mount rule.
    ["a renamed release service", {}, { compose: compose.replace("  webapi:", "  api:") }, /service 'webapi' must mount exactly its own runtime-secret generation/u],
    ["a health service that is not long-running", {}, { deploy: { ...deployConfig, healthServices: ["worker"] } }, /health service 'worker' is not a long-running/u],
    ["a privileged service", {}, { compose: compose.replace("  webapi:\n", "  webapi:\n    privileged: true\n") }, /must not be privileged/u],
    ["a public port the registry does not allow", {}, { compose: compose.replace("127.0.0.1:8080:8080", "0.0.0.0:8080:8080") }, /non-loopback/u],
    ["a mutable infrastructure image", {}, { compose: `${compose}  redis:\n    image: redis:7\n` }, /pinned by sha256/u],
    ["a long-running service that starts the migrator", {}, { compose: compose.replace("  webapi:\n", "  webapi:\n    depends_on:\n      database-migrator:\n        condition: service_completed_successfully\n") }, /depends on migration-service/u],
    ["a secret-bearing service with a restart policy", {}, { compose: compose.replace('    restart: "no"\n    security_opt: ["no-new-privileges:true"]\n    ports:', '    restart: unless-stopped\n    security_opt: ["no-new-privileges:true"]\n    ports:') }, /restart: "no"/u],
    ["a secret mount from another service's generation", {}, { compose: otherSource }, /expected \/run\/runtime-secrets\/<application>\/<environment>\/webapi\/current/u],
    ["secret mounts from different applications", {}, { stackEnv: "RUNTIME_SECRETS_APPLICATION=example-backend\nRUNTIME_SECRETS_ENVIRONMENT=prd\n", compose: compose.replace("${RUNTIME_SECRETS_APPLICATION:?required}/${RUNTIME_SECRETS_ENVIRONMENT:?required}/webapi", "other-app/prd/webapi") }, /share an application and environment/u],
    ["a registered secret service without its mount", {}, { compose: compose.replace(`    volumes:${secretMount("webapi")}`, "") }, /must mount exactly its own runtime-secret generation/u],
  ])("rejects %s", async (_label, overrides, files, message) => {
    await expect(run(env(overrides), files)).rejects.toThrow(message);
  });
});

const dockerAvailable = process.platform === "linux" && spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

describe.runIf(dockerAvailable)("release configuration check with the real Docker Compose CLI", () => {
  it("renders and policy-checks the fixture exactly as the host would", async () => {
    const summary = await checkReleaseConfiguration(env(), workspace(), { compose: new DockerCompose({ temporaryRoot: tmpdir() }) });
    expect(summary.deployment).toMatchObject({ longRunningServices: ["webapi"], secretServices: ["webapi", "database-migrator"], registryChecked: true });
  });

  it("reports a Compose interpolation failure from the CLI", async () => {
    await expect(checkReleaseConfiguration(env({ COMPOSE_ENV_FILE: "" }), workspace(), { compose: new DockerCompose({ temporaryRoot: tmpdir() }) }))
      .rejects.toThrow(/docker compose config rejected the configuration/u);
  });
});
