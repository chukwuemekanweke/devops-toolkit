import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  calculateSummary,
  discoverProjects,
  executeTestProjects,
  inspectCoverage,
  stageBuildOutputs,
  validateInputs,
} from "../scripts/dotnet-ci.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "devops-toolkit-dotnet-ci-"));
  temporaryDirectories.push(path);
  return path;
}

function createFile(root: string, relativePath: string, contents = ""): string {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  return path;
}

afterEach(() => {
  temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
});

describe(".NET CI input validation", () => {
  it("accepts template defaults and a custom solution under a working directory", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "backend/Custom Solution.slnx");
    expect(
      validateInputs(
        {
          SOLUTION_PATH: "Custom Solution.slnx",
          WORKING_DIRECTORY: "backend",
          BUILD_CONFIGURATION: "Release",
          DOTNET_VERSION: "10.0.x",
          FORMAT_DIAGNOSTICS: "IDE0005",
          ARTIFACT_RETENTION_DAYS: "14",
        },
        workspace,
      ),
    ).toMatchObject({
      configuration: "Release",
      solutionRelative: "Custom Solution.slnx",
      workingDirectoryRelative: "backend",
    });
  });

  it.each([
    ["missing solution", { SOLUTION_PATH: "missing.slnx" }, /does not exist/u],
    ["path traversal", { SOLUTION_PATH: "../outside.slnx" }, /traversal/u],
    ["invalid retention", { SOLUTION_PATH: "app.slnx", ARTIFACT_RETENTION_DAYS: "91" }, /between 1 and 90/u],
    ["unpaired credentials", { SOLUTION_PATH: "app.slnx", NUGET_USERNAME: "user" }, /supplied together/u],
  ])("rejects %s", (_label, environment, message) => {
    const workspace = temporaryDirectory();
    createFile(workspace, "app.slnx");
    expect(() => validateInputs(environment, workspace)).toThrow(message);
  });

  it("allows public restores with no package credentials", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "app.slnx");
    expect(() => validateInputs({ SOLUTION_PATH: "app.slnx" }, workspace)).not.toThrow();
  });
});

describe(".NET test project discovery and execution", () => {
  it("discovers multiple projects deterministically, including paths with spaces", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "tests/unit/Zeta.UnitTests/Zeta.UnitTests.csproj");
    createFile(workspace, "tests/unit/Alpha Tests/Alpha.UnitTests.csproj");
    expect(discoverProjects(workspace, "tests/unit/**/*.UnitTests.csproj")).toEqual([
      "tests/unit/Alpha Tests/Alpha.UnitTests.csproj",
      "tests/unit/Zeta.UnitTests/Zeta.UnitTests.csproj",
    ]);
  });

  it("rejects invalid patterns and optionally permits an empty test set", () => {
    const workspace = temporaryDirectory();
    expect(() => discoverProjects(workspace, "../**/*.csproj")).toThrow(/traversal/u);
    const result = executeTestProjects({
      category: "unit",
      collectCoverage: false,
      configuration: "Release",
      failOnEmpty: false,
      patterns: "tests/unit/**/*.UnitTests.csproj",
      resultsRoot: join(temporaryDirectory(), "results"),
      workingDirectory: workspace,
    });
    expect(result.projects).toEqual([]);
  });

  it("does not allow a later successful project to hide an earlier failure", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "tests/unit/First.UnitTests.csproj");
    createFile(workspace, "tests/unit/Second.UnitTests.csproj");
    let invocation = 0;
    const result = executeTestProjects({
      category: "unit",
      collectCoverage: false,
      configuration: "Release",
      failOnEmpty: true,
      patterns: "tests/unit/*.UnitTests.csproj",
      resultsRoot: join(temporaryDirectory(), "results"),
      runCommand: () => (invocation++ === 0 ? 1 : 0),
      workingDirectory: workspace,
    });
    expect(result.failedProjects).toEqual(["tests/unit/First.UnitTests.csproj"]);
    expect(invocation).toBe(2);
  });

  it("accepts successful tests with coverage and flags missing expected coverage", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "tests/unit/App.UnitTests.csproj");
    const successful = executeTestProjects({
      category: "unit",
      collectCoverage: true,
      configuration: "Release",
      failOnEmpty: true,
      patterns: "tests/unit/**/*.UnitTests.csproj",
      resultsRoot: join(temporaryDirectory(), "success"),
      runCommand: (_command, argumentsList) => {
        const output = argumentsList[argumentsList.indexOf("--results-directory") + 1];
        if (output === undefined) throw new Error("missing results directory");
        createFile(output, "run/coverage.cobertura.xml", "<coverage />");
        return 0;
      },
      workingDirectory: workspace,
    });
    expect(successful.failedProjects).toEqual([]);

    const missing = executeTestProjects({
      category: "unit",
      collectCoverage: true,
      configuration: "Release",
      failOnEmpty: true,
      patterns: "tests/unit/**/*.UnitTests.csproj",
      resultsRoot: join(temporaryDirectory(), "missing"),
      runCommand: () => 0,
      workingDirectory: workspace,
    });
    expect(missing.failedProjects[0]).toMatch(/coverage missing/u);
  });

  it("turns a Docker-unavailable integration skip recorded in TRX into a failure signal", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "tests/integration/App.IntegrationTests.csproj");
    const result = executeTestProjects({
      category: "integration",
      collectCoverage: false,
      configuration: "Release",
      failOnEmpty: true,
      patterns: "tests/integration/**/*.IntegrationTests.csproj",
      resultsRoot: join(temporaryDirectory(), "results"),
      runCommand: (_command, argumentsList) => {
        const output = argumentsList[argumentsList.indexOf("--results-directory") + 1];
        if (output === undefined) throw new Error("missing results directory");
        createFile(output, "results.trx", "<StdOut>Docker is unavailable. Testcontainers required.</StdOut>");
        return 0;
      },
      workingDirectory: workspace,
    });
    expect(result.infrastructureFailure).toBe(true);
  });
});

describe(".NET CI artifacts and outputs", () => {
  it("stages release build outputs while preserving repository-relative paths", () => {
    const workspace = temporaryDirectory();
    createFile(workspace, "src/App/bin/Release/net10.0/App.dll", "binary");
    const destination = join(temporaryDirectory(), "build");
    expect(stageBuildOutputs(workspace, "Release", destination)).toBe(1);
    expect(() => inspectCoverage(destination, true)).toThrow(/no coverage files/u);
  });

  it("reports disabled categories as skipped without failing verification", () => {
    expect(
      calculateSummary({
        buildResult: "success",
        collectCoverage: false,
        coverageExpected: false,
        coverageArtifactName: "coverage",
        coverageResult: "skipped",
        coverageUploaded: false,
        integrationResult: "skipped",
        runIntegrationTests: false,
        runUnitTests: false,
        testResultsArtifactName: "tests",
        testResultsUploaded: false,
        unitResult: "skipped",
      }),
    ).toMatchObject({ verificationPassed: true, coverageArtifact: "", testResultsArtifact: "" });
  });

  it("keeps failed tests and missing expected coverage visible in outputs", () => {
    expect(
      calculateSummary({
        buildResult: "success",
        collectCoverage: true,
        coverageExpected: true,
        coverageArtifactName: "coverage",
        coverageResult: "failure",
        coverageUploaded: false,
        integrationResult: "success",
        runIntegrationTests: true,
        runUnitTests: true,
        testResultsArtifactName: "tests",
        testResultsUploaded: true,
        unitResult: "failure",
      }),
    ).toEqual({
      buildResult: "success",
      coverageArtifact: "",
      integrationTestResult: "success",
      testResultsArtifact: "tests",
      unitTestResult: "failure",
      verificationPassed: false,
    });
  });

  it("does not require coverage when an allowed empty test set discovers no projects", () => {
    expect(
      calculateSummary({
        buildResult: "success",
        collectCoverage: true,
        coverageExpected: false,
        coverageArtifactName: "coverage",
        coverageResult: "success",
        coverageUploaded: false,
        integrationResult: "skipped",
        runIntegrationTests: false,
        runUnitTests: true,
        testResultsArtifactName: "tests",
        testResultsUploaded: true,
        unitResult: "success",
      }).verificationPassed,
    ).toBe(true);
  });
});
