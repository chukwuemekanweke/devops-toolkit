import { describe, expect, it } from "vitest";
import {
  generationsOverride, imagesOverride, isLoopback, isRootUser, prescanComposeFiles, selectHealthServices,
  selectLongRunningServices, validateMergedConfig,
} from "../scripts/vps-deploy/compose-policy.mjs";
import { assertProvenance, resolveSecretServices, validateRegistry } from "../scripts/vps-deploy/registry.mjs";
import { validateReleaseManifest } from "../scripts/vps-deploy/contract.mjs";
import { commit, digest, manifestObject } from "./helpers/vps-deploy-fixtures.js";

const webapiRef = `docker.io/example/backend-webapi@${digest("a")}`;
const migratorRef = `docker.io/example/backend-migrator@${digest("b")}`;
const postgresRef = `postgres:17.2@${digest("c")}`;
const secretSource = "/run/runtime-secrets/example-backend/prd/webapi/current";

function registry(overrides: Record<string, unknown> = {}) {
  return validateRegistry({
    version: 1,
    stackName: "example-backend-production",
    environment: "production",
    deploymentPath: "/srv/example-backend/production",
    allowedSourceRepositories: ["example/backend"],
    allowedImageRepositories: ["docker.io/example/"],
    runtimeSecrets: { services: { webapi: { instance: "exb-prd-api" }, "database-migrator": { instance: "exb-prd-mig", startAtBoot: false } } },
    publicPorts: [443],
    allowedBindSources: ["/etc/example-backend/"],
    allowedExternalNetworks: ["edge-proxy"],
    ...overrides,
  });
}

function secretMount(source = secretSource) {
  return { type: "bind", source, target: "/run/secrets/app", read_only: true, bind: { create_host_path: false } };
}

function config(serviceOverrides: Record<string, Record<string, unknown>> = {}, extra: Record<string, unknown> = {}) {
  const services: Record<string, Record<string, unknown>> = {
    webapi: {
      image: webapiRef, user: "10001", restart: "no", security_opt: ["no-new-privileges:true"],
      volumes: [secretMount(), { type: "volume", source: "data", target: "/data" }],
      ports: [{ target: 8080, published: "18080", host_ip: "127.0.0.1" }],
      depends_on: { postgres: { condition: "service_healthy" } },
    },
    "database-migrator": {
      image: migratorRef, user: "10001", restart: "no", security_opt: ["no-new-privileges:true"],
      volumes: [secretMount("/run/runtime-secrets/example-backend/prd/database-migrator/current")],
    },
    postgres: { image: postgresRef, volumes: [{ type: "volume", source: "pg", target: "/var/lib/postgresql/data" }] },
  };
  for (const [name, value] of Object.entries(serviceOverrides)) services[name] = { ...(services[name] ?? {}), ...value };
  return { services, volumes: { data: { name: "x_data" }, pg: { name: "x_pg" } }, ...extra };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    componentServices: new Map([["webapi", { reference: webapiRef }], ["database-migrator", { reference: migratorRef }]]),
    secretServices: new Map([
      ["webapi", { bindSource: secretSource }],
      ["database-migrator", { bindSource: "/run/runtime-secrets/example-backend/prd/database-migrator/current" }],
    ]),
    migrationService: "database-migrator",
    registry: registry(),
    ...overrides,
  };
}

describe("compose policy", () => {
  it("accepts an isolated, digest-pinned, secret-mounting stack", () => {
    expect(() => validateMergedConfig(config(), context())).not.toThrow();
  });

  it.each([
    ["mutable component image", { webapi: { image: "docker.io/example/backend-webapi:latest" } }, /release digest/u],
    ["mutable infrastructure image", { postgres: { image: "postgres:17" } }, /pinned by sha256/u],
    ["privileged container", { postgres: { privileged: true } }, /privileged/u],
    ["host network", { postgres: { network_mode: "host" } }, /network_mode/u],
    ["host pid", { postgres: { pid: "host" } }, /namespace/u],
    ["other container network", { postgres: { network_mode: "container:other-stack-db-1" } }, /network_mode/u],
    ["container_name", { postgres: { container_name: "db" } }, /container_name/u],
    ["docker socket", { postgres: { volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock", read_only: true }] } }, /Docker socket|does not allow/u],
    ["host root bind", { postgres: { volumes: [{ type: "bind", source: "/", target: "/host", read_only: true }] } }, /does not allow/u],
    ["writable allowed bind", { postgres: { volumes: [{ type: "bind", source: "/etc/example-backend/pg.conf", target: "/c", read_only: false }] } }, /read-only/u],
    ["another service's secrets", { postgres: { volumes: [secretMount()] } }, /other than its own|do not belong/u],
    ["another stack's secrets", { webapi: { volumes: [secretMount("/run/runtime-secrets/other/prd/webapi/current")] } }, /other than its own/u],
    ["writable secret mount", { webapi: { volumes: [{ ...secretMount(), read_only: false }] } }, /read-only/u],
    ["host path creation", { webapi: { volumes: [{ ...secretMount(), bind: {} }] } }, /create_host_path/u],
    ["missing secret mount", { webapi: { volumes: [] } }, /exactly its own/u],
    ["secret service restart policy", { webapi: { restart: "unless-stopped" } }, /restart: "no"/u],
    ["secret service without no-new-privileges", { webapi: { security_opt: [] } }, /no-new-privileges/u],
    ["public port", { webapi: { ports: [{ target: 8080, published: "8080" }] } }, /non-loopback/u],
    ["capability", { postgres: { cap_add: ["SYS_ADMIN"] } }, /capability/u],
    ["seccomp disabled", { postgres: { security_opt: ["seccomp=unconfined"] } }, /security profile/u],
    ["devices", { postgres: { devices: ["/dev/sda:/dev/sda"] } }, /devices/u],
    ["volumes_from", { postgres: { volumes_from: ["other"] } }, /volumes_from/u],
    ["dependency on migration", { webapi: { depends_on: { "database-migrator": { condition: "service_completed_successfully" } } } }, /depends on migration-service/u],
    ["looping migrator", { "database-migrator": { restart: "always" } }, /restart-forever|restart: "no"/u],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => validateMergedConfig(config(overrides as Record<string, Record<string, unknown>>), context())).toThrow(message);
  });

  it("rejects a restart-forever migrator that holds no runtime secrets", () => {
    const secretServices = new Map([["webapi", { bindSource: secretSource }]]);
    const overrides = { "database-migrator": { restart: "unless-stopped", volumes: [] } };
    expect(() => validateMergedConfig(config(overrides), context({ secretServices }))).toThrow(/restart-forever/u);
  });

  it("allows registry-approved public ports, binds, and external networks only", () => {
    expect(() => validateMergedConfig(config({ webapi: { ports: [{ target: 8443, published: "443" }] } }), context())).not.toThrow();
    expect(() => validateMergedConfig(config({ postgres: { volumes: [{ type: "bind", source: "/etc/example-backend/init", target: "/init", read_only: true }] } }), context())).not.toThrow();
    expect(() => validateMergedConfig(config({}, { networks: { edge: { name: "edge-proxy", external: true } } }), context())).not.toThrow();
    expect(() => validateMergedConfig(config({}, { networks: { edge: { name: "other-stack_default", external: true } } }), context())).toThrow(/external network/u);
    expect(() => validateMergedConfig(config({}, { volumes: { stolen: { name: "other_pg", external: true } } }), context())).toThrow(/external volume/u);
    expect(() => validateMergedConfig(config({}, { volumes: { hostdir: { driver_opts: { type: "none", o: "bind", device: "/" } } } }), context())).toThrow(/driver_opts/u);
  });

  it("requires every component, secret, and migration service to exist", () => {
    const { webapi: _webapi, ...rest } = config().services;
    expect(() => validateMergedConfig({ services: rest }, context())).toThrow(/webapi/u);
  });

  it("pre-scans raw Compose files for host file references and duplicate keys", async () => {
    await expect(prescanComposeFiles([{ path: "a.yml", content: "services:\n  x:\n    image: a\n" }])).resolves.toBeUndefined();
    await expect(prescanComposeFiles([{ path: "a.yml", content: "include:\n  - /etc/other.yml\n" }])).rejects.toThrow(/include/u);
    await expect(prescanComposeFiles([{ path: "a.yml", content: "services:\n  x:\n    env_file: /root/.ssh/id_rsa\n" }])).rejects.toThrow(/env_file/u);
    await expect(prescanComposeFiles([{ path: "a.yml", content: "services:\n  x:\n    extends:\n      file: ../../other.yml\n      service: y\n" }])).rejects.toThrow(/extends/u);
    await expect(prescanComposeFiles([{ path: "a.yml", content: "configs:\n  c:\n    file: /etc/shadow\n" }])).rejects.toThrow(/host file/u);
    await expect(prescanComposeFiles([{ path: "a.yml", content: "services:\n  x: {}\n  x: {}\n" }])).rejects.toThrow(/invalid YAML/u);
    await expect(prescanComposeFiles([{ path: "a.yml", content: "- list\n" }])).rejects.toThrow(/mapping/u);
  });

  it("selects long-running and health services and generates overrides", () => {
    const longRunning = selectLongRunningServices({ services: { webapi: {}, postgres: {}, "database-migrator": {} } }, "database-migrator");
    expect(longRunning).toEqual(["postgres", "webapi"]);
    expect(selectHealthServices([], longRunning)).toEqual(longRunning);
    expect(() => selectHealthServices(["database-migrator"], longRunning)).toThrow(/long-running/u);
    expect(imagesOverride(new Map([["webapi", { reference: webapiRef }]]))).toEqual({ services: { webapi: { image: webapiRef } } });
    expect(generationsOverride({ webapi: "gen-20261122T000000Z-aaaaaaaa" }).services.webapi?.labels).toBeDefined();
    expect(isRootUser("")).toBe(true);
    expect(isRootUser("0:0")).toBe(true);
    expect(isRootUser("root")).toBe(true);
    expect(isRootUser("10001:10001")).toBe(false);
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
  });
});

describe("host stack registry", () => {
  it("normalizes a valid registry", () => {
    const value = registry();
    expect(value.secretServices.get("database-migrator")).toEqual({ instance: "exb-prd-mig", startAtBoot: false });
    expect(value.healthCheckHosts).toContain("127.0.0.1");
  });

  it.each([
    ["system deployment path", { deploymentPath: "/etc/app/prod" }, /reserved/u],
    ["runtime secret deployment path", { deploymentPath: "/run/runtime-secrets/app" }, /reserved/u],
    ["shallow bind source", { allowedBindSources: ["/srv/"] }, /protected/u],
    ["ssh bind source", { allowedBindSources: ["/etc/ssh/"] }, /protected/u],
    ["docker bind source", { allowedBindSources: ["/var/lib/docker/volumes/"] }, /protected/u],
    ["state bind source", { allowedBindSources: ["/srv/example-backend/production/"] }, /overlaps/u],
    ["dangerous capability", { allowedCapabilities: ["SYS_ADMIN"] }, /not permitted/u],
    ["foreign image registry", { allowedImageRepositories: ["ghcr.io/example/"] }, /docker\.io/u],
    ["duplicate instances", { runtimeSecrets: { services: { a: { instance: "x" }, b: { instance: "x" } } } }, /unique/u],
    ["unknown field", { command: "id" }, /unknown field/u],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => registry(overrides)).toThrow(message);
  });

  it("enforces source repository and image namespace provenance", () => {
    const release = validateReleaseManifest(JSON.stringify(manifestObject()), { deploymentId: commit });
    expect(() => assertProvenance(registry(), release)).not.toThrow();
    expect(() => assertProvenance(registry({ allowedSourceRepositories: ["example/frontend"] }), release)).toThrow(/source_repository/u);
    expect(() => assertProvenance(registry({ allowedImageRepositories: ["docker.io/other/"] }), release)).toThrow(/image repository/u);
  });

  it("binds each secret service to its own DEVOPS-007 instance", async () => {
    const instances: Record<string, { service: string; application: string; environment: string; outputDirectory: string }> = {
      "exb-prd-api": { service: "webapi", application: "example-backend", environment: "prd", outputDirectory: "/run/runtime-secrets/example-backend/prd/webapi" },
      "exb-prd-mig": { service: "database-migrator", application: "example-backend", environment: "prd", outputDirectory: "/run/runtime-secrets/example-backend/prd/database-migrator" },
    };
    const resolved = await resolveSecretServices(registry(), { loadInstance: async (id: string) => instances[id] });
    expect(resolved.get("webapi")?.bindSource).toBe(secretSource);
    instances["exb-prd-mig"] = { ...instances["exb-prd-mig"]!, service: "webapi" };
    await expect(resolveSecretServices(registry(), { loadInstance: async (id: string) => instances[id] })).rejects.toThrow(/belongs to service/u);
  });
});
