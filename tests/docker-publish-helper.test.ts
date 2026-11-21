import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { JsonSchemaValidator } from "../src/validation/json-schema-validator.js";
import {
  aggregateRelease,
  buildArgsList,
  createComponentResult,
  normalizeDeploymentTag,
  parseJsonStrict,
  parsePackageAuthComponents,
  parsePlatforms,
  stableStringify,
  validateAndNormalizeConfig,
  validateCredentialPair,
} from "../scripts/docker-publish.mjs";

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

  it("rejects invalid digest creation", () => {
    expect(() => createComponentResult({ component: "api", image: "docker.io/example/api", digest: "bad", tag: "release-test", platforms: "linux/amd64", scanEnabled: true, sbomEnabled: true, provenanceEnabled: true })).toThrow();
  });

  it("parses strict JSON", () => {
    expect(parseJsonStrict('{"a":1}')).toEqual({ a: 1 });
  });
});
