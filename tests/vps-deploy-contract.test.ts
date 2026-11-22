import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonSchemaValidator } from "../src/validation/json-schema-validator.js";
import {
  classifyDeploymentOutcome, classifyMigrationStatus, parseComponentServiceMap, parseComposeFileList, parseHealthChecks, resolveComponentServices, selectManifestSource,
  validateDeploymentRequest, validateReleaseManifest, validateRemoteDeploymentPath, validateStackName,
} from "../scripts/vps-deploy/contract.mjs";
import {
  buildRecord, notificationOutputs, parseRemoteResult, prepareBundle, readDeploymentRecord, readWorkspaceFile, recordArtifactName, relayStderrLine, reportOutputs,
  sshArguments, validateInputs, validateSshTarget,
} from "../scripts/vps-deploy.mjs";

const root = join(import.meta.dirname, "..");
import { commit, digest, manifestObject, repository, requestObject, workflow } from "./helpers/vps-deploy-fixtures.js";

describe("vps-deploy release manifest validation", () => {
  it("accepts a docker-publish manifest and computes a stable canonical hash", () => {
    const first = validateReleaseManifest(JSON.stringify(manifestObject()), { deploymentId: commit, sourceRepository: repository });
    const reordered = { ...manifestObject() };
    const second = validateReleaseManifest(JSON.stringify(Object.fromEntries(Object.entries(reordered).reverse())), { deploymentId: commit });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.sha256).toBe(first.sha256);
    expect(first.components[0]?.reference).toBe(`docker.io/example/backend-webapi@${digest("a")}`);
  });

  it("agrees with the published schema for the existing fixtures", () => {
    const validator = new JsonSchemaValidator();
    const schema = join(root, "docs", "schemas", "deployment-manifest.schema.json");
    const fixture = join(root, "tests", "fixtures", "deployment-manifest", "valid", "multi-image.json");
    expect(() => validator.validateDocument(fixture, schema)).not.toThrow();
  });

  it.each([
    ["malformed JSON", "{", /malformed/u],
    ["duplicate property", `{"schema_version":"1.0","schema_version":"1.0"}`, /duplicate/u],
    ["unsupported major", JSON.stringify(manifestObject({ schema_version: "2.0" })), /unsupported/u],
    ["unknown 1.0 property", JSON.stringify(manifestObject({ extra: true })), /unknown/u],
    ["mismatched deployment id", JSON.stringify(manifestObject({ deployment_id: "other" })), /does not match/u],
    ["foreign source repository", JSON.stringify(manifestObject({ source_repository: "attacker/repo" })), /calling repository/u],
    ["short commit", JSON.stringify(manifestObject({ source_commit: "abc" })), /source_commit/u],
    ["bad timestamp", JSON.stringify(manifestObject({ created_at: "yesterday" })), /created_at/u],
    ["missing digest", JSON.stringify(manifestObject({ components: [{ name: "webapi", image: "docker.io/example/webapi" }] })), /missing 'digest'/u],
    ["uppercase digest", JSON.stringify(manifestObject({ components: [{ name: "webapi", image: "docker.io/example/webapi", digest: `sha256:${"A".repeat(64)}` }] })), /digest/u],
    ["tagged image", JSON.stringify(manifestObject({ components: [{ name: "webapi", image: "docker.io/example/webapi:latest", digest: digest("a") }] })), /untagged docker\.io/u],
    ["foreign registry", JSON.stringify(manifestObject({ components: [{ name: "webapi", image: "ghcr.io/example/webapi", digest: digest("a") }] })), /docker\.io/u],
    ["shell metacharacters in image", JSON.stringify(manifestObject({ components: [{ name: "webapi", image: "docker.io/example/$(id)", digest: digest("a") }] })), /docker\.io/u],
    ["duplicate component", JSON.stringify(manifestObject({ components: [{ name: "a", image: "docker.io/x/a", digest: digest("a") }, { name: "a", image: "docker.io/x/b", digest: digest("b") }] })), /duplicate component/u],
    ["empty components", JSON.stringify(manifestObject({ components: [] })), /1-100/u],
  ])("rejects %s", (_label, text, message) => {
    expect(() => validateReleaseManifest(text, { deploymentId: commit, sourceRepository: repository })).toThrow(message);
  });

  it("ignores unknown optional fields from a later 1.x minor after validating the core", () => {
    const value = validateReleaseManifest(JSON.stringify(manifestObject({ schema_version: "1.1", attestations: "registry" })), { deploymentId: commit });
    expect(value.components).toHaveLength(2);
  });
});

describe("vps-deploy request validation", () => {
  it("accepts a complete request", () => {
    const value = validateDeploymentRequest(requestObject());
    expect(value.healthChecks[0]?.expectedStatus).toEqual([200]);
    expect(value.componentServiceMap).toEqual({ migrator: "database-migrator" });
  });

  it.each([
    ["shell in stack name", { stackName: "app;rm -rf /" }, /stack-name/u],
    ["uppercase stack name", { stackName: "Example" }, /stack-name/u],
    ["newline in environment", { environment: "prod\nuction" }, /environment/u],
    ["relative remote path", { remoteDeploymentPath: "srv/app" }, /remote-deployment-path/u],
    ["traversal remote path", { remoteDeploymentPath: "/srv/../etc" }, /remote-deployment-path/u],
    ["root remote path", { remoteDeploymentPath: "/" }, /remote-deployment-path/u],
    ["compose traversal", { composeFiles: [{ path: "../secrets.yml", content: "x" }] }, /unsafe path segment/u],
    ["absolute compose file", { composeFiles: [{ path: "/etc/passwd.yml", content: "x" }] }, /repository-relative/u],
    ["compose backslash", { composeFiles: [{ path: "deploy\\compose.yml", content: "x" }] }, /repository-relative/u],
    ["non-yaml compose file", { composeFiles: [{ path: "deploy/compose.sh", content: "x" }] }, /\.yml/u],
    ["migration in health services", { healthServices: ["database-migrator"] }, /must not include/u],
    ["service injection", { migrationService: "migrator && curl" }, /migration-service/u],
    ["health URL with credentials", { healthChecks: [{ name: "x", url: "http://user:pass@127.0.0.1/health" }] }, /credentials/u],
    ["health URL scheme", { healthChecks: [{ name: "x", url: "file:///etc/shadow" }] }, /http/u],
    ["health unknown property", { healthChecks: [{ name: "x", url: "http://127.0.0.1/", command: "id" }] }, /unknown property/u],
    ["timeout out of range", { migrationTimeoutSeconds: 0 }, /migration-timeout-seconds/u],
    ["non-boolean rollback", { rollbackOnHealthFailure: "yes" }, /rollback-on-health-failure/u],
    ["unknown request field", { command: "id" }, /unknown property/u],
    ["workflow identity injection", { workflow: { ...workflow(), actor: "octo cat; id" } }, /workflow\.actor/u],
  ])("rejects %s", (_label, overrides, message) => {
    expect(() => validateDeploymentRequest(requestObject(overrides as Record<string, unknown>))).toThrow(message);
  });

  it("parses lists, maps and checks strictly", () => {
    expect(parseComposeFileList("deploy/compose.yml\r\n\ndeploy/compose.prod.yaml\n")).toEqual(["deploy/compose.yml", "deploy/compose.prod.yaml"]);
    expect(() => parseComposeFileList("a.yml\na.yml")).toThrow(/duplicate/u);
    expect(() => parseComposeFileList("")).toThrow(/at least one/u);
    expect(() => parseComponentServiceMap('{"a":"x","a":"y"}')).toThrow(/duplicate/u);
    expect(() => parseComponentServiceMap('{"a":"bad service"}')).toThrow(/not a valid Compose service/u);
    expect(parseHealthChecks('[{"name":"api","url":"https://127.0.0.1/h","expectedStatus":[204,200]}]')[0]?.expectedStatus).toEqual([200, 204]);
    expect(() => parseHealthChecks('[{"name":"api","url":"http://127.0.0.1/","expectedStatus":99}]')).toThrow(/100 to 599/u);
    expect(() => selectManifestSource("{}", "release-manifest-x")).toThrow(/exactly one/u);
    expect(() => selectManifestSource("", "")).toThrow(/exactly one/u);
    expect(selectManifestSource("", "release-manifest-abc")).toEqual({ kind: "artifact", name: "release-manifest-abc" });
    expect(() => selectManifestSource("", "../escape")).toThrow(/manifest-artifact/u);
    expect(validateRemoteDeploymentPath("/srv/example/production")).toBe("/srv/example/production");
    expect(validateStackName("frontend_prod-1")).toBe("frontend_prod-1");
  });

  it("resolves component services and rejects collisions and unknown components", () => {
    const release = validateReleaseManifest(JSON.stringify(manifestObject()), { deploymentId: commit });
    expect([...resolveComponentServices(release.components, { migrator: "database-migrator" }).keys()]).toEqual(["webapi", "database-migrator"]);
    expect(() => resolveComponentServices(release.components, { unknown: "x" })).toThrow(/unknown component/u);
    expect(() => resolveComponentServices(release.components, { migrator: "webapi" })).toThrow(/both map/u);
  });
});

describe("vps-deploy runner helper", () => {
  function workspace() {
    const directory = mkdtempSync(join(tmpdir(), "vps-deploy-runner-"));
    mkdirSync(join(directory, "deploy"));
    writeFileSync(join(directory, "deploy", "compose.yml"), "services:\n  webapi:\n    image: placeholder\n");
    return directory;
  }

  function env(directory: string, overrides: Record<string, string> = {}) {
    return {
      ENVIRONMENT: "production", DEPLOYMENT_ID: commit, STACK_NAME: "example-backend-production",
      MANIFEST_JSON: JSON.stringify(manifestObject()), MANIFEST_ARTIFACT: "", COMPOSE_FILES: "deploy/compose.yml",
      COMPONENT_SERVICE_MAP: '{"migrator":"database-migrator"}', REMOTE_DEPLOYMENT_PATH: "/srv/example-backend/production",
      SSH_PORT: "22", MIGRATION_SERVICE: "database-migrator", MIGRATION_TIMEOUT_SECONDS: "600", HEALTH_SERVICES: "",
      HEALTH_CHECKS: "[]", HEALTH_TIMEOUT_SECONDS: "300", ROLLBACK_ON_HEALTH_FAILURE: "true",
      CALLER_WORKSPACE: directory, CALLER_REPOSITORY: repository, CALLER_SHA: commit, CALLER_WORKFLOW_REF: "example/backend/.github/workflows/ci.yml@refs/heads/main",
      RUN_ID: "42", RUN_ATTEMPT: "1", ACTOR: "octocat", EVENT_NAME: "push", SERVER_URL: "https://github.com",
      TOOLKIT_REPOSITORY: "example/devops-toolkit", TOOLKIT_SHA: commit,
      ...overrides,
    };
  }

  it("builds a bundle without credentials", () => {
    const bundle = prepareBundle(env(workspace()));
    expect(bundle.request.composeFiles[0]?.path).toBe("deploy/compose.yml");
    expect(JSON.stringify(bundle)).not.toMatch(/token|private key/iu);
    expect(bundle.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects malformed input before any connection", () => {
    const directory = workspace();
    expect(() => validateInputs(env(directory, { MANIFEST_ARTIFACT: "release-manifest-x" }))).toThrow(/exactly one/u);
    expect(() => prepareBundle(env(directory, { DEPLOYMENT_ID: "different" }))).toThrow(/does not match/u);
    expect(() => prepareBundle(env(directory, { COMPOSE_FILES: "deploy/missing.yml" }))).toThrow(/does not exist/u);
    expect(() => prepareBundle(env(directory, { MIGRATION_SERVICE: "worker" }))).toThrow(/release component/u);
    expect(() => prepareBundle(env(directory, { CALLER_REPOSITORY: "attacker/fork" }))).toThrow(/calling repository/u);
    expect(() => validateInputs(env(directory, { SSH_PORT: "70000" }))).toThrow(/ssh-port/u);
  });

  it.runIf(process.platform !== "win32")("rejects Compose files that escape through symbolic links", () => {
    const directory = workspace();
    const outside = mkdtempSync(join(tmpdir(), "vps-deploy-outside-"));
    writeFileSync(join(outside, "compose.yml"), "services: {}\n");
    symlinkSync(join(outside, "compose.yml"), join(directory, "deploy", "linked.yml"));
    expect(() => readWorkspaceFile(directory, "deploy/linked.yml", 1024)).toThrow(/symbolic link/u);
  });

  // Assembled from parts so the repository secret scanner does not flag a synthetic marker.
  const marker = (edge: string) => [`-----${edge}`, "OPENSSH", "PRIVATE", "KEY-----"].join(" ");
  const key = [marker("BEGIN"), "c3ludGhldGljLW5vdC1hLWtleQ==", marker("END")].join("\n");

  it("requires a pinned explicit host key for the configured host and port", () => {
    expect(validateSshTarget({ host: "vps.example.com", user: "vps-deploy", privateKey: key, knownHosts: "vps.example.com ssh-ed25519 AAAAC3Nza", port: 22 }).knownHosts).toContain("vps.example.com");
    expect(() => validateSshTarget({ host: "vps.example.com", user: "vps-deploy", privateKey: key, knownHosts: "* ssh-ed25519 AAAAC3Nza", port: 22 })).toThrow(/wildcard/u);
    expect(() => validateSshTarget({ host: "vps.example.com", user: "vps-deploy", privateKey: key, knownHosts: "other.example.com ssh-ed25519 AAAA", port: 22 })).toThrow(/no entry/u);
    expect(() => validateSshTarget({ host: "vps.example.com", user: "vps-deploy", privateKey: key, knownHosts: "vps.example.com ssh-ed25519 AAAA", port: 2222 })).toThrow(/no entry/u);
    expect(validateSshTarget({ host: "vps.example.com", user: "vps-deploy", privateKey: key, knownHosts: "[vps.example.com]:2222 ssh-ed25519 AAAA", port: 2222 }).key.endsWith("\n")).toBe(true);
    expect(() => validateSshTarget({ host: "-oProxyCommand=id", user: "vps-deploy", privateKey: key, knownHosts: "x ssh-ed25519 A", port: 22 })).toThrow(/ssh-host/u);
    expect(() => validateSshTarget({ host: "vps.example.com", user: "root;id", privateKey: key, knownHosts: "vps.example.com ssh-ed25519 A", port: 22 })).toThrow(/ssh-user/u);
    expect(() => validateSshTarget({ host: "vps.example.com", user: "vps-deploy", privateKey: "not a key", knownHosts: "vps.example.com ssh-ed25519 A", port: 22 })).toThrow(/private key/u);
  });

  it("uses strict host-key checking and a fixed remote operation", () => {
    const args = sshArguments({ host: "vps.example.com", user: "vps-deploy", port: 22, keyPath: "/tmp/k", knownHostsPath: "/tmp/kh" });
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain("BatchMode=yes");
    expect(args.join(" ")).not.toMatch(/StrictHostKeyChecking=(?:no|accept-new)/u);
    expect(args.slice(-3)).toEqual(["--", "vps.example.com", "deploy"]);
  });

  it("relays only sanitized progress and builds a sanitized record", () => {
    const lines: string[] = [];
    relayStderrLine('{"event":"phase","phase":"health"}', (line) => lines.push(line));
    relayStderrLine("\u001b[31mPermission denied (publickey)", (line) => lines.push(line));
    expect(lines).toEqual(["vps-deploy: health", "remote: ?[31mPermission denied (publickey)"]);
    expect(parseRemoteResult("noise\n{\"status\":\"failed\"}\n")).toEqual({ status: "failed" });
    const record = buildRecord({ RUN_ID: "1" }, { bundle: null, result: { status: "restored-after-failure", secrets: { webapi: { pending: "gen-20261122T000000Z-aaaaaaaa", value: "secret" } }, restoration: { attempted: true, outcome: "restored" } }, failure: null });
    expect(record.status).toBe("restored-after-failure");
    expect(JSON.stringify(record)).not.toContain("secret\"");
    expect(buildRecord({}, { bundle: null, result: { status: "pwned" }, failure: null }).status).toBe("failed");
  });

  const bundle = (migrationService = "database-migrator") => ({ request: { stackName: "example-backend-production", environment: "production", deploymentId: commit, migrationService }, manifestSha256: "f".repeat(64) });

  it("exposes a machine-readable failure signal for a failed migration", () => {
    const result = {
      ok: false, status: "failed", phase: "migration", failedPhase: "migration", previousDeploymentId: "prev",
      failure: { category: "migration", message: "migration exited with status 1; application rollout was blocked" },
      migration: { configured: true, status: "failed", started: true, databaseMayHaveChanged: true, exitCode: 1, timedOut: false, durationSeconds: 4, container: "x" },
      restoration: { attempted: false, outcome: "not-required", reason: "failure occurred before application rollout" },
    };
    const record = buildRecord({ RUN_ID: "7" }, { bundle: bundle(), result, failure: null });
    expect(record).toMatchObject({
      status: "failed", outcome: "failed-before-rollout", phase: "migration", deployedId: "",
      migration: { configured: true, status: "failed", started: true, databaseMayHaveChanged: true, exitCode: 1 },
      restoration: { attempted: false, outcome: "not-required" },
    });
    expect(notificationOutputs(record)).toEqual({
      "deployment-outcome": "failed-before-rollout", "failed-phase": "migration", "failure-category": "migration",
      "migration-status": "failed", "restoration-outcome": "not-required",
    });
  });

  it.each([
    [{ status: "succeeded", restoration: { attempted: false, outcome: "not-required" }, migration: { configured: true, status: "succeeded", started: true, exitCode: 0 } }, null, "succeeded", "succeeded", "not-required", ""],
    [{ status: "restored-after-failure", failedPhase: "health", failure: { category: "health", message: "x" }, restoration: { attempted: true, outcome: "restored" }, migration: { configured: true, status: "succeeded", started: true, exitCode: 0 } }, null, "restored-after-failure", "succeeded", "restored", "health"],
    [{ status: "failed", failedPhase: "health", failure: { category: "restore", message: "x" }, restoration: { attempted: true, outcome: "failed" }, migration: { configured: false, status: "not-configured" } }, null, "restoration-failed", "not-configured", "failed", "health"],
    [{ status: "failed", failedPhase: "rollout", failure: { category: "rollout", message: "x" }, restoration: { attempted: false, outcome: "disabled" }, migration: { configured: false } }, null, "failed-restoration-disabled", "not-configured", "disabled", "rollout"],
    [{ status: "failed", failedPhase: "health", failure: { category: "health", message: "x" }, restoration: { attempted: false, outcome: "no-previous-release" }, migration: { configured: false } }, null, "failed-no-previous-release", "not-configured", "no-previous-release", "health"],
    [null, { phase: "validate", category: "validation", message: "bad input" }, "failed-before-rollout", "not-run", "not-required", "validate"],
    [null, { phase: "transport", category: "transport", message: "SSH connection failed" }, "unknown", "unknown", "unknown", "transport"],
  ])("classifies deployment outcomes for notifications (%#)", (result, failure, outcome, migration, restoration, phase) => {
    const record = buildRecord({}, { bundle: bundle(), result, failure });
    const outputs = notificationOutputs(record);
    expect(outputs["deployment-outcome"]).toBe(outcome);
    expect(outputs["migration-status"]).toBe(migration);
    expect(outputs["restoration-outcome"]).toBe(restoration);
    expect(outputs["failed-phase"]).toBe(phase);
    for (const value of Object.values(outputs)) expect(value).toMatch(/^[a-z0-9-]*$/u);
  });

  it("flags a transport failure as possibly having changed the database", () => {
    const record = buildRecord({}, { bundle: bundle(), result: null, failure: { phase: "transport", category: "transport", message: "x" } });
    expect(record.migration).toMatchObject({ status: "unknown", databaseMayHaveChanged: true });
    expect(buildRecord({}, { bundle: bundle(""), result: null, failure: { phase: "transport", category: "transport", message: "x" } }).migration.status).toBe("not-configured");
  });

  it("classifies results from host helpers that predate DEVOPS-010 fields", () => {
    expect(classifyMigrationStatus({ configured: true, exitCode: 3, timedOut: false }, "migration")).toBe("failed");
    expect(classifyMigrationStatus({ configured: true, exitCode: null, timedOut: true }, "migration")).toBe("timed-out");
    expect(classifyMigrationStatus({ configured: true, exitCode: 0, timedOut: false }, "health")).toBe("succeeded");
    expect(classifyMigrationStatus({ configured: true, exitCode: null, timedOut: false }, "pull")).toBe("not-run");
    expect(classifyMigrationStatus({ configured: false }, "pull")).toBe("not-configured");
    expect(classifyDeploymentOutcome({ status: "failed", restoration: { outcome: "surprise" } })).toBe("unknown");
    const legacy = buildRecord({}, { bundle: bundle(), result: { status: "failed", failedPhase: "migration", failure: { category: "migration", message: "x" }, migration: { configured: true, exitCode: 2, timedOut: false }, restoration: { attempted: false, outcome: "not-required" } }, failure: null });
    expect(legacy.migration).toMatchObject({ status: "failed", started: true, databaseMayHaveChanged: true });
  });

  it("keeps a failed deployment failed and never copies unexpected or secret fields into the record", () => {
    const result = {
      status: "failed", outcome: "succeeded", failedPhase: "health", failure: { category: "health", message: "api is unhealthy", token: "dckr_pat_leak" },
      restoration: { attempted: true, outcome: "restored", reason: "ok", password: "hunter2-leak" }, registry: { token: "dckr_pat_leak" },
      migration: { configured: true, status: "succeeded", started: true, exitCode: 0, env: { DB_PASSWORD: "hunter2-leak" } },
    };
    const record = buildRecord({}, { bundle: bundle(), result, failure: null });
    expect(record.status).toBe("failed");
    expect(record.outcome).toBe("restored-after-failure");
    expect(notificationOutputs(record)["deployment-outcome"]).not.toBe("succeeded");
    expect(JSON.stringify(record)).not.toMatch(/dckr_pat_leak|hunter2-leak/u);
    expect(notificationOutputs({ ...record, outcome: "evil\nname=value", phase: "x;y" })).toMatchObject({ "deployment-outcome": "unknown", "failed-phase": "unknown" });
  });
});

describe("secret-free deployment report", () => {
  const bundle = { request: { stackName: "example-backend-production", environment: "production", deploymentId: commit, migrationService: "database-migrator" }, manifestSha256: "f".repeat(64) };
  const identity = { stackName: "example-backend-production", runId: "45027735800", runAttempt: "2" };
  const writeRecord = (record: unknown) => {
    const folder = mkdtempSync(join(tmpdir(), "vps-report-"));
    writeFileSync(join(folder, "deployment-record.json"), typeof record === "string" ? record : JSON.stringify(record));
    return folder;
  };

  it("derives one artifact name for upload and download from public identity only", () => {
    expect(recordArtifactName(identity)).toBe("vps-deployment-record-example-backend-production-45027735800-2");
    expect(recordArtifactName({ stackName: "Bad Stack*", runId: "1", runAttempt: "1" })).toBe("vps-deployment-record-invalid-stack-1-1");
    expect(recordArtifactName({ stackName: "x", runId: "1*", runAttempt: undefined })).toBe("vps-deployment-record-x-0-1");
    // The name is used as a download pattern, so it must never contain glob syntax.
    for (const stackName of ["a*", "a?", "[a]", "{a,b}", "!a", "a/b"]) expect(recordArtifactName({ ...identity, stackName })).not.toMatch(/[*?[\]{}!/]/u);
  });

  it("round-trips every output through the uploaded record for the four-component backend", () => {
    const result = {
      status: "succeeded", deployedId: commit, previousDeploymentId: "c".repeat(40),
      restoration: { attempted: false, outcome: "not-required" }, migration: { configured: true, status: "succeeded", started: true, exitCode: 0 },
    };
    const record = buildRecord({ STACK_NAME: identity.stackName }, { bundle, result, failure: null });
    const loaded = readDeploymentRecord(writeRecord(record));
    expect(loaded.present).toBe(true);
    expect(reportOutputs(loaded, recordArtifactName(identity))).toEqual({
      "deployment-status": "succeeded", "deployed-id": commit, "previous-deployment-id": "c".repeat(40),
      "deployment-record-artifact": "vps-deployment-record-example-backend-production-45027735800-2",
      "deployment-outcome": "succeeded", "failed-phase": "", "failure-category": "", "migration-status": "succeeded", "restoration-outcome": "not-required",
    });
  });

  it("reports a restored rollout from the record without claiming success", () => {
    const result = {
      status: "restored-after-failure", failedPhase: "health", deployedId: commit, previousDeploymentId: "prev",
      failure: { category: "health", message: "api is unhealthy" }, restoration: { attempted: true, outcome: "restored" },
      migration: { configured: true, status: "succeeded", started: true, exitCode: 0 },
    };
    const outputs = reportOutputs(readDeploymentRecord(writeRecord(buildRecord({}, { bundle, result, failure: null }))), "rec");
    expect(outputs).toMatchObject({
      "deployment-status": "restored-after-failure", "deployed-id": "", "previous-deployment-id": "prev", "deployment-record-artifact": "rec",
      "deployment-outcome": "restored-after-failure", "failed-phase": "health", "restoration-outcome": "restored",
    });
  });

  it("reports unknown, never succeeded, when the deploy job ended before uploading its record", () => {
    const loaded = readDeploymentRecord(mkdtempSync(join(tmpdir(), "vps-report-empty-")));
    expect(loaded).toEqual({ present: false, record: null });
    expect(reportOutputs(loaded, "rec")).toEqual({
      "deployment-status": "failed", "deployed-id": "", "previous-deployment-id": "", "deployment-record-artifact": "",
      "deployment-outcome": "unknown", "failed-phase": "unknown", "failure-category": "unknown", "migration-status": "unknown", "restoration-outcome": "unknown",
    });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["a future schema", { schemaVersion: 2, status: "succeeded" }],
    ["an unknown status", { schemaVersion: 1, status: "pwned" }],
  ])("treats a record that is %s as unknown but still names the uploaded artifact", (_label, content) => {
    const loaded = readDeploymentRecord(writeRecord(content));
    expect(loaded).toEqual({ present: true, record: null });
    expect(reportOutputs(loaded, "rec")).toMatchObject({ "deployment-status": "failed", "deployment-outcome": "unknown", "deployment-record-artifact": "rec" });
  });

  it("rejects a record that is not a regular file", () => {
    const folder = mkdtempSync(join(tmpdir(), "vps-report-dir-"));
    mkdirSync(join(folder, "deployment-record.json"));
    expect(readDeploymentRecord(folder)).toEqual({ present: true, record: null });
  });

  it("never emits multi-line values from a tampered record", () => {
    const tampered = { schemaVersion: 1, status: "succeeded", outcome: "succeeded", deployedId: "a\nname=value", previousDeploymentId: "b\rc", phase: "", failure: null, migration: null, restoration: null };
    const outputs = reportOutputs({ present: true, record: tampered }, "rec");
    expect(outputs["deployed-id"]).toBe("");
    expect(outputs["previous-deployment-id"]).toBe("");
    for (const value of Object.values(outputs)) expect(value).not.toMatch(/[\r\n]/u);
  });

  it("keeps outputs intact when credentials overlap them, because the report job references no secrets", () => {
    // Regression for the masking defect: an ssh-user `deploy` is a substring of the artifact name,
    // and a registry username equal to the repository owner is a substring of owner-derived IDs.
    const sshUser = "deploy";
    const registryUser = "example";
    const result = { status: "succeeded", deployedId: `${registryUser}-backend-001`, previousDeploymentId: `${registryUser}-backend-000`, restoration: { attempted: false, outcome: "not-required" }, migration: { configured: true, status: "succeeded", started: true, exitCode: 0 } };
    const outputs = reportOutputs(readDeploymentRecord(writeRecord(buildRecord({}, { bundle, result, failure: null }))), recordArtifactName(identity));
    expect(outputs["deployment-record-artifact"]).toContain(sshUser);
    expect(outputs["deployed-id"]).toContain(registryUser);
    expect(outputs["deployed-id"]).toBe("example-backend-001");
  });
});
