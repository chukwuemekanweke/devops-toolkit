import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildScriptArguments,
  calculateSummary,
  copyBuildConfig,
  parseWorkspaceFilters,
  validateArtifactPaths,
  validateInputs,
  validatePackageScripts,
  validateSelection,
} from "../scripts/nextjs-ci.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "devops-toolkit-nextjs-ci-"));
  temporaryDirectories.push(path);
  return path;
}

function createFile(root: string, relativePath: string, contents = ""): string {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

function createMonorepo(root = temporaryDirectory()): string {
  createFile(root, "package.json", JSON.stringify({
    packageManager: "pnpm@11.20.0",
    scripts: { build: "turbo build", lint: "turbo lint", test: "turbo test", typecheck: "turbo typecheck" },
  }));
  createFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  createFile(root, ".node-version", "22.13.0\n");
  return root;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe("Next.js CI input and package validation", () => {
  it("accepts defaults, a version file, filters, and artifact configuration", () => {
    const root = createMonorepo();
    const result = validateInputs({
      NODE_VERSION_FILE: ".node-version",
      PNPM_VERSION: "11.20.0",
      WORKSPACE_FILTERS: "@template/user-portal...\n@template/config",
      UPLOAD_BUILD_ARTIFACTS: "true",
      BUILD_ARTIFACT_PATHS: "apps/user-portal/.next",
      ARTIFACT_RETENTION_DAYS: "30",
    }, root);
    expect(result.filters).toEqual(["@template/user-portal...", "@template/config"]);
    expect(result.nodeVersionFile).toBe(".node-version");
    expect(result.retentionDays).toBe(30);
  });

  it("rejects pnpm mismatches, invalid retention, unsafe paths, and missing artifact paths", () => {
    const root = createMonorepo();
    expect(() => validateInputs({ PNPM_VERSION: "10.0.0" }, root)).toThrow(/does not match/u);
    expect(() => validateInputs({ ARTIFACT_RETENTION_DAYS: "91" }, root)).toThrow(/between 1 and 90/u);
    expect(() => validateInputs({ NODE_VERSION_FILE: "../version" }, root)).toThrow(/traversal/u);
    expect(() => validateInputs({ UPLOAD_BUILD_ARTIFACTS: "true" }, root)).toThrow(/required/u);
  });

  it("requires every enabled root script to be non-empty", () => {
    const root = createMonorepo();
    validatePackageScripts(root, ["lint", "build"]);
    expect(() => validatePackageScripts(root, ["missing"])).toThrow(/requires a non-empty/u);
  });
});

describe("workspace filtering", () => {
  it("supports empty, single, and multiple discrete selectors", () => {
    expect(parseWorkspaceFilters("")).toEqual([]);
    expect(parseWorkspaceFilters("@scope/app...\n./packages/*")).toEqual(["@scope/app...", "./packages/*"]);
    expect(buildScriptArguments("test", ["@scope/app...", "./packages/*"])).toEqual([
      "--filter", "@scope/app...", "--filter", "./packages/*", "run", "test",
    ]);
  });

  it("rejects shell fragments and option injection", () => {
    expect(() => parseWorkspaceFilters("@scope/app; touch owned")).toThrow(/unsupported/u);
    expect(() => parseWorkspaceFilters("--config=/tmp/evil")).toThrow(/unsupported/u);
  });

  it("fails an empty selection and keeps filters as separate process arguments", () => {
    const root = createMonorepo();
    let captured: string[] = [];
    expect(() => validateSelection(root, ["@scope/missing"], (_command, args) => {
      captured = args;
      return { status: 0, stdout: "[]" };
    })).toThrow(/did not resolve/u);
    expect(captured).toEqual(["--filter", "@scope/missing", "list", "--depth", "-1", "--json"]);
    expect(validateSelection(root, ["@scope/app..."], () => ({ status: 0, stdout: '[{"name":"@scope/app"}]' }))).toHaveLength(1);
  });
});

describe("safe build configuration", () => {
  it("copies an existing repository-contained source to a new destination", () => {
    const root = createMonorepo();
    createFile(root, "apps/app/.env.example", "NEXT_PUBLIC_API_URL=https://example.invalid\n");
    expect(copyBuildConfig(root, JSON.stringify({ "apps/app/.env.local": "apps/app/.env.example" })))
      .toEqual(["apps/app/.env.local"]);
  });

  it("rejects invalid JSON, missing sources, traversal, and overwrites", () => {
    const root = createMonorepo();
    createFile(root, "apps/app/.env.example", "safe=true\n");
    createFile(root, "apps/app/.env.local", "existing=true\n");
    expect(() => copyBuildConfig(root, "{")).toThrow(/not valid JSON/u);
    expect(() => copyBuildConfig(root, '{"apps/app/.env.local":"missing"}')).toThrow(/does not exist/u);
    expect(() => copyBuildConfig(root, '{"../outside":"apps/app/.env.example"}')).toThrow(/traversal/u);
    expect(() => copyBuildConfig(root, '{"apps/app/.env.local":"apps/app/.env.example"}')).toThrow(/already exists/u);
  });

  it("rejects a source symlink that escapes the repository", () => {
    const root = createMonorepo();
    const outside = temporaryDirectory();
    createFile(outside, "secret", "not safe");
    mkdirSync(join(root, "apps", "app"), { recursive: true });
    try {
      symlinkSync(join(outside, "secret"), join(root, "apps", "app", ".env.example"), "file");
    } catch {
      return;
    }
    expect(() => copyBuildConfig(root, '{"apps/app/.env.local":"apps/app/.env.example"}')).toThrow(/escapes/u);
  });
});

describe("artifacts and result calculation", () => {
  it("accepts existing output and rejects traversal, missing, globs, and sensitive paths", () => {
    const root = createMonorepo();
    createFile(root, "apps/app/.next/build.txt", "ok");
    expect(validateArtifactPaths(root, "apps/app/.next")).toEqual(["apps/app/.next"]);
    expect(() => validateArtifactPaths(root, "../outside")).toThrow(/traversal/u);
    expect(() => validateArtifactPaths(root, "missing")).toThrow(/does not exist/u);
    expect(() => validateArtifactPaths(root, "apps/*/.next")).toThrow(/glob/u);
    expect(() => validateArtifactPaths(root, "apps/app/.env.local")).toThrow(/sensitive/u);
    createFile(root, "diagnostics/npm-token.txt", "do not upload");
    expect(() => validateArtifactPaths(root, "diagnostics")).toThrow(/sensitive/u);
  });

  it("marks disabled checks skipped and requires every enabled check plus artifact upload", () => {
    expect(calculateSummary({
      artifactName: "nextjs-build-1-1", artifactOutcome: "skipped", buildOutcome: "success", lintOutcome: "skipped",
      runBuild: true, runLint: false, runTests: true, runTypecheck: true, testOutcome: "success",
      typecheckOutcome: "success", uploadArtifacts: false,
    })).toMatchObject({ lintResult: "skipped", verificationPassed: true, buildArtifact: "" });

    expect(calculateSummary({
      artifactName: "nextjs-build-1-1", artifactOutcome: "failure", buildOutcome: "skipped", lintOutcome: "failure",
      runBuild: true, runLint: true, runTests: false, runTypecheck: false, testOutcome: "skipped",
      typecheckOutcome: "skipped", uploadArtifacts: true,
    })).toMatchObject({ lintResult: "failure", buildResult: "skipped", verificationPassed: false, buildArtifact: "" });

    expect(calculateSummary({
      artifactName: "nextjs-build-1-1", artifactOutcome: "failure", buildOutcome: "success", lintOutcome: "success",
      runBuild: true, runLint: true, runTests: false, runTypecheck: false, testOutcome: "skipped",
      typecheckOutcome: "skipped", uploadArtifacts: true,
    }).verificationPassed).toBe(false);
  });
});
