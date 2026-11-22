import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { JsonSchemaValidator } from "../src/validation/json-schema-validator.js";
import {
  aggregateRelease,
  buildArgsList,
  checkPackageCredentials,
  createComponentResult,
  normalizeDeploymentTag,
  parseJsonStrict,
  parsePackageAuthComponents,
  parsePlatforms,
  stableStringify,
  validateAndNormalizeConfig,
  validateCredentialPair,
  validatePrepareInputs,
} from "../scripts/docker-publish.mjs";

const helper = join(import.meta.dirname, "..", "scripts", "docker-publish.mjs");

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "docker-publish-"));
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  writeFileSync(join(root, "apps", "api", "Dockerfile"), "FROM scratch\n");
  return root;
}

function config(images: unknown[] = [{ component: "api", image: "docker.io/example/api", dockerfile: "apps/api/Dockerfile" }]): string {
  return JSON.stringify({ schemaVersion: 1, images });
}

function normalize(text: string, root = workspace(), extra: Record<string, unknown> = {}) {
  return validateAndNormalizeConfig(text, {
    workspace: root, registry: "docker.io", platforms: "linux/amd64",
    packageAuthComponents: "", ...extra,
  });
}

const digest = `sha256:${"a".repeat(64)}`;

describe("docker publish configuration", () => {
  it("normalizes a single image and default context", () => {
    const value = normalize(config());
    expect(value.images[0]).toMatchObject({ component: "api", context: ".", packageAuth: false });
  });

  it("normalizes multiple images deterministically", () => {
    const root = workspace();
    mkdirSync(join(root, "apps", "worker"), { recursive: true });
    writeFileSync(join(root, "apps", "worker", "Dockerfile"), "FROM scratch\n");
    const value = normalize(config([
      { component: "api", image: "docker.io/example/api", dockerfile: "apps/api/Dockerfile", buildArgs: { ZED: "z", MODE: "release" } },
      { component: "worker", image: "docker.io/example/worker", dockerfile: "apps/worker/Dockerfile" },
    ]), root);
    expect(value.images).toHaveLength(2);
    expect(value.images[0]?.buildArgsText).toBe("MODE=release\nZED=z");
    expect(stableStringify(value)).toBe(stableStringify(value));
  });

  it.each([
    ["malformed JSON", "{"],
    ["duplicate property", '{"schemaVersion":1,"schemaVersion":1,"images":[]}'],
    ["unsupported schema", '{"schemaVersion":2,"images":[]}'],
    ["empty images", '{"schemaVersion":1,"images":[]}'],
    ["unknown property", '{"schemaVersion":1,"images":[],"extra":true}'],
  ])("rejects %s", (_label, text) => expect(() => normalize(text)).toThrow());

  it.each([
    ["duplicate components", [
      { component: "api", image: "docker.io/example/api", dockerfile: "apps/api/Dockerfile" },
      { component: "api", image: "docker.io/example/api2", dockerfile: "apps/api/Dockerfile" },
    ]],
    ["tagged repositories", [{ component: "api", image: "docker.io/example/api:latest", dockerfile: "apps/api/Dockerfile" }]],
    ["digest repositories", [{ component: "api", image: `docker.io/example/api@${digest}`, dockerfile: "apps/api/Dockerfile" }]],
    ["unknown image fields", [{ component: "api", image: "docker.io/example/api", dockerfile: "apps/api/Dockerfile", target: "build" }]],
    ["secret build argument keys", [{ component: "api", image: "docker.io/example/api", dockerfile: "apps/api/Dockerfile", buildArgs: { API_TOKEN: "x" } }]],
    ["credential URLs", [{ component: "api", image: "docker.io/example/api", dockerfile: "apps/api/Dockerfile", buildArgs: { URL: "https://user:pass@example.com" } }]],
  ])("rejects %s", (_label, images) => expect(() => normalize(config(images))).toThrow());

  it.each(["../Dockerfile", "/tmp/Dockerfile", "missing/Dockerfile"])("rejects unsafe or missing Dockerfile %s", (dockerfile) => {
    expect(() => normalize(config([{ component: "api", image: "docker.io/example/api", dockerfile }]))).toThrow();
  });

  it("rejects a symlink escape", () => {
    const root = workspace();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "Dockerfile"), "FROM scratch\n");
    try { symlinkSync(outside, join(root, "escape"), "junction"); } catch { return; }
    expect(() => normalize(config([{ component: "api", image: "docker.io/example/api", dockerfile: "escape/Dockerfile" }]), root)).toThrow(/escapes/u);
  });

  it("rejects unsupported registry and platform values", () => {
    expect(() => normalize(config(), workspace(), { registry: "ghcr.io" })).toThrow(/registry/u);
    expect(() => parsePlatforms("linux/386")).toThrow();
  });
});

describe("package authentication and identity", () => {
  it("accepts unique known selections and a complete pair", () => {
    expect(parsePackageAuthComponents("api\nworker", ["api", "worker"])).toEqual(["api", "worker"]);
    expect(() => validateCredentialPair(true, "user", "token")).not.toThrow();
  });
  it("rejects unknown, duplicate, and incomplete selections", () => {
    expect(() => parsePackageAuthComponents("unknown", ["api"])).toThrow(/unknown/u);
    expect(() => parsePackageAuthComponents("api\napi", ["api"])).toThrow(/duplicate/u);
    expect(() => validateCredentialPair(true, "user", "")).toThrow();
    expect(() => validateCredentialPair(false, "", "token")).toThrow();
  });
  it("creates deterministic release tags and build arguments", () => {
    expect(normalizeDeploymentTag("ABC_123")).toBe("release-abc_123");
    expect(buildArgsList({ Z: "2", A: "1" })).toBe("A=1\nZ=2");
    expect(() => normalizeDeploymentTag("bad value")).toThrow();
    expect(normalizeDeploymentTag("a".repeat(128))).toHaveLength(128);
  });
});

describe("secret-free preparation", () => {
  // Mirrors the backend template whose run 45027735800 lost its matrix: the package username
  // also appears in the source repository, the Docker Hub namespace, and every image name.
  const overlapping = "chukwuemekanweke";
  const components = ["webapi", "consumer", "jobs", "migrator"];

  function backendWorkspace(): string {
    const root = mkdtempSync(join(tmpdir(), "docker-publish-backend-"));
    for (const component of components) {
      mkdirSync(join(root, "src", component), { recursive: true });
      writeFileSync(join(root, "src", component, "Dockerfile"), "FROM scratch\n");
    }
    mkdirSync(join(root, ".github"), { recursive: true });
    writeFileSync(join(root, ".github", "docker-images.json"), JSON.stringify({
      schemaVersion: 1,
      images: components.map((component) => ({
        component, image: `docker.io/${overlapping}/backendprojecttemplate-${component}`, dockerfile: `src/${component}/Dockerfile`,
      })),
    }));
    return root;
  }

  const environment = {
    DEPLOYMENT_ID: "1".repeat(40),
    IMAGE_CONFIG_PATH: ".github/docker-images.json",
    PACKAGE_AUTH_COMPONENTS: "webapi\nconsumer\njobs\nmigrator\n",
    SOURCE_REPOSITORY: "",
    SOURCE_COMMIT: "",
    BUILD_REFERENCE: "",
    REGISTRY: "docker.io",
    PLATFORMS: "linux/amd64",
    ARTIFACT_RETENTION_DAYS: "30",
    CALLER_REPOSITORY: `${overlapping}/dotnet-core-project-template`,
    CALLER_SHA: "a".repeat(40),
    DEFAULT_BUILD_REFERENCE: `https://github.com/${overlapping}/dotnet-core-project-template/actions/runs/45027735800`,
  };

  it("prepares package-auth components without any package credentials", () => {
    const value = normalize(config(), workspace(), { packageAuthComponents: "api" });
    expect(value.images[0]).toMatchObject({ component: "api", packageAuth: true });
  });

  it("builds the full matrix from metadata that overlaps the package username, with no secret available", () => {
    const prepared = validatePrepareInputs({ ...environment }, backendWorkspace());
    expect(prepared.sourceRepository).toBe(`${overlapping}/dotnet-core-project-template`);
    expect(prepared.buildReference).toBe(environment.DEFAULT_BUILD_REFERENCE);
    expect(prepared.tag).toBe(`release-${"1".repeat(40)}`);
    expect(prepared.matrix.include).toEqual(components.map((component) => ({
      component,
      image: `docker.io/${overlapping}/backendprojecttemplate-${component}`,
      dockerfile: `src/${component}/Dockerfile`,
      context: ".",
      buildArgsText: "",
      packageAuth: true,
    })));
  });

  it("ignores package credentials during preparation and produces an identical matrix", () => {
    const root = backendWorkspace();
    const without = validatePrepareInputs({ ...environment }, root);
    const halfPair = validatePrepareInputs({ ...environment, PACKAGE_USERNAME: overlapping }, root);
    expect(stableStringify(halfPair.matrix)).toBe(stableStringify(without.matrix));
  });

  it("marks only selected components for package authentication", () => {
    const prepared = validatePrepareInputs({ ...environment, PACKAGE_AUTH_COMPONENTS: "webapi\nmigrator" }, backendWorkspace());
    expect(prepared.matrix.include.map((item) => [item.component, item.packageAuth])).toEqual([
      ["webapi", true], ["consumer", false], ["jobs", false], ["migrator", true],
    ]);
  });

  it("keeps the prepare CLI free of credentials and writes the expected outputs", () => {
    const root = backendWorkspace();
    const outputFile = join(root, "github-output");
    writeFileSync(outputFile, "");
    const result = spawnSync(process.execPath, [helper, "prepare"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...environment, GITHUB_WORKSPACE: root, GITHUB_OUTPUT: outputFile, PREPARED_DIRECTORY: join(root, "prepared") },
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const outputs = Object.fromEntries(readFileSync(outputFile, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    expect(Object.keys(outputs)).toEqual(["matrix", "deployment-id", "tag", "source-repository", "source-commit", "build-reference", "retention-days"]);
    expect((JSON.parse(outputs.matrix ?? "{}") as { include: unknown[] }).include).toHaveLength(4);
    expect(outputs["source-repository"]).toBe(`${overlapping}/dotnet-core-project-template`);
  });

  it.each([
    ["an invalid image repository", { image: "docker.io/Invalid/Name" }, /image/u],
    ["an invalid Dockerfile path", { dockerfile: "../Dockerfile" }, /dockerfile/u],
    ["an invalid build context", { context: "missing" }, /context/u],
  ])("still rejects %s without credentials", (_label, override, message) => {
    const root = backendWorkspace();
    writeFileSync(join(root, ".github", "docker-images.json"), JSON.stringify({
      schemaVersion: 1, images: [{ component: "webapi", image: "docker.io/example/api", dockerfile: "src/webapi/Dockerfile", ...override }],
    }));
    expect(() => validatePrepareInputs({ ...environment, PACKAGE_AUTH_COMPONENTS: "" }, root)).toThrow(message);
  });

  it.each([
    ["an unknown package-auth component", { PACKAGE_AUTH_COMPONENTS: "web" }, /unknown component/u],
    ["an invalid deployment ID", { DEPLOYMENT_ID: "bad id" }, /deployment-id/u],
    ["an unsupported registry", { REGISTRY: "ghcr.io" }, /registry/u],
  ])("still rejects %s without credentials", (_label, override, message) => {
    expect(() => validatePrepareInputs({ ...environment, ...override }, backendWorkspace())).toThrow(message);
  });
});

describe("per-component package credential check", () => {
  const pair = { PACKAGE_USERNAME: "package-user", PACKAGE_TOKEN: "package-token-value" };

  it.each([
    ["required, complete pair", "true", pair, null],
    ["required, token missing", "true", { PACKAGE_USERNAME: pair.PACKAGE_USERNAME }, /complete pair/u],
    ["required, username missing", "true", { PACKAGE_TOKEN: pair.PACKAGE_TOKEN }, /complete pair/u],
    ["required, both missing", "true", {}, /package-auth-components requires GitHub Packages credentials/u],
    ["required, both empty strings (unset GitHub secrets)", "true", { PACKAGE_USERNAME: "", PACKAGE_TOKEN: "" }, /requires GitHub Packages credentials/u],
    ["not required, complete pair", "false", pair, null],
    ["not required, token missing", "false", { PACKAGE_USERNAME: pair.PACKAGE_USERNAME }, /complete pair/u],
    ["not required, username missing", "false", { PACKAGE_TOKEN: pair.PACKAGE_TOKEN }, /complete pair/u],
    ["not required, both missing", "false", {}, null],
  ])("%s", (_label, required, credentials, error) => {
    const check = () => checkPackageCredentials({ PACKAGE_AUTH_REQUIRED: required, ...credentials });
    if (error) expect(check).toThrow(error);
    else expect(check).not.toThrow();
  });

  it("preserves the existing presence semantics for whitespace-only values", () => {
    // validateCredentialPair has always treated any non-empty string as present; this fix does not change that.
    expect(() => checkPackageCredentials({ PACKAGE_AUTH_REQUIRED: "true", PACKAGE_USERNAME: " ", PACKAGE_TOKEN: " " })).not.toThrow();
    expect(() => checkPackageCredentials({ PACKAGE_AUTH_REQUIRED: "false", PACKAGE_USERNAME: " " })).toThrow(/complete pair/u);
  });

  it.each([undefined, "", "TRUE", "False", "1", "0", "yes", " true", "null"])("rejects the non-boolean requirement flag %j", (flag) => {
    expect(() => checkPackageCredentials({ PACKAGE_AUTH_REQUIRED: flag, ...pair })).toThrow(/PACKAGE_AUTH_REQUIRED must be 'true' or 'false'/u);
  });

  it("never treats the string 'false' as requiring credentials", () => {
    expect(() => checkPackageCredentials({ PACKAGE_AUTH_REQUIRED: "false" })).not.toThrow();
  });

  it.each([
    ["true", { PACKAGE_USERNAME: "overlapping-user-value" }],
    ["false", { PACKAGE_TOKEN: "ghp_secretTokenValue123" }],
  ])("fails through the CLI without printing credential values (required=%s)", (required, credentials) => {
    const result = spawnSync(process.execPath, [helper, "check-credentials"], {
      encoding: "utf8", env: { PATH: process.env.PATH, PACKAGE_AUTH_REQUIRED: required, ...credentials },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docker-publish: GitHub Packages credentials must be supplied as a complete pair");
    for (const value of Object.values(credentials)) {
      expect(result.stderr).not.toContain(value);
      expect(result.stdout).not.toContain(value);
    }
  });

  it("succeeds silently through the CLI with a complete pair", () => {
    const result = spawnSync(process.execPath, [helper, "check-credentials"], {
      encoding: "utf8", env: { PATH: process.env.PATH, PACKAGE_AUTH_REQUIRED: "true", ...pair },
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toBe("");
  });
});

describe("release aggregation", () => {
  const normalized = {
    schemaVersion: 1, registry: "docker.io", platforms: ["linux/amd64"],
    images: [{ component: "api", image: "docker.io/example/api" }],
  };
  const result = createComponentResult({ component: "api", image: "docker.io/example/api", digest, tag: "release-test", platforms: "linux/amd64", scanEnabled: true, sbomEnabled: true, provenanceEnabled: true });
  const values = { normalized, results: [result], deploymentId: "release-1", sourceRepository: "example/app", sourceCommit: "1".repeat(40), buildReference: "https://github.com/example/app/actions/runs/1", createdAt: "2026-11-21T12:00:00Z", scanImages: true };

  it("creates a deterministic manifest and published image mapping", () => {
    const release = aggregateRelease(values);
    expect(release.manifest).toMatchObject({ schema_version: "1.0", deployment_id: "release-1" });
    expect(JSON.parse(release.publishedImages)).toEqual({ api: `docker.io/example/api@${digest}` });
    expect(release.manifestJson).toBe(aggregateRelease(values).manifestJson);
    const manifestPath = join(workspace(), "deployment-manifest.json");
    writeFileSync(manifestPath, release.manifestJson);
    expect(() => new JsonSchemaValidator().validateDocument(manifestPath, join(import.meta.dirname, "..", "docs", "schemas", "deployment-manifest.schema.json"))).not.toThrow();
  });

  it.each([
    ["missing result", []],
    ["duplicate result", [result, result]],
    ["unexpected result", [{ ...result, component: "other", image: "docker.io/example/other", immutableReference: `docker.io/example/other@${digest}` }]],
    ["wrong image", [{ ...result, image: "docker.io/example/wrong", immutableReference: `docker.io/example/wrong@${digest}` }]],
    ["invalid digest", [{ ...result, digest: "sha256:bad", immutableReference: "docker.io/example/api@sha256:bad" }]],
    ["failed scan", [{ ...result, scan: "failed" }]],
  ])("rejects %s", (_label, results) => expect(() => aggregateRelease({ ...values, results })).toThrow());

  it("permits explicit scan disablement", () => {
    const disabled = { ...result, scan: "disabled" };
    expect(() => aggregateRelease({ ...values, results: [disabled], scanImages: false })).not.toThrow();
  });

  it("requires enabled SBOM and provenance evidence", () => {
    expect(() => aggregateRelease({ ...values, results: [{ ...result, sbom: "disabled" }], generateSbom: true })).toThrow(/SBOM/u);
    expect(() => aggregateRelease({ ...values, results: [{ ...result, provenance: "disabled" }], generateProvenance: true })).toThrow(/provenance/u);
  });

  it.each([4, 3])("aggregates a complete %i-component topology", (count) => {
    const images = Array.from({ length: count }, (_, index) => ({ component: `app-${index}`, image: `docker.io/example/app-${index}` }));
    const results = images.map((image, index) => createComponentResult({ ...image, digest: `sha256:${index.toString(16).padStart(64, "0")}`, tag: "release-test", platforms: "linux/amd64", scanEnabled: true, sbomEnabled: true, provenanceEnabled: true }));
    const release = aggregateRelease({ ...values, normalized: { ...normalized, images }, results, generateSbom: true, generateProvenance: true });
    expect((release.manifest.components as unknown[])).toHaveLength(count);
  });

  it("refuses a release manifest when one component of four failed (for example its credential check)", () => {
    const images = ["webapi", "consumer", "jobs", "migrator"].map((component) => ({ component, image: `docker.io/example/backend-${component}` }));
    const results = images.slice(0, 3).map((image, index) => createComponentResult({ ...image, digest: `sha256:${index.toString(16).padStart(64, "0")}`, tag: "release-test", platforms: "linux/amd64", scanEnabled: true, sbomEnabled: true, provenanceEnabled: true }));
    expect(() => aggregateRelease({ ...values, normalized: { ...normalized, images }, results })).toThrow(/missing component result 'migrator'/u);
  });

  it("rejects invalid digest creation", () => {
    expect(() => createComponentResult({ component: "api", image: "docker.io/example/api", digest: "bad", tag: "release-test", platforms: "linux/amd64", scanEnabled: true, sbomEnabled: true, provenanceEnabled: true })).toThrow();
  });

  it("parses strict JSON", () => {
    expect(parseJsonStrict('{"a":1}')).toEqual({ a: 1 });
  });
});
