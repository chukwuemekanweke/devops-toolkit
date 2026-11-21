#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const dockerUnavailable = /DockerUnavailableException|Docker is unavailable/iu;
const safeConfiguration = /^[A-Za-z0-9_.-]+$/u;
const safeDiagnostic = /^[A-Za-z]{1,12}[0-9]{4}$/u;
const safeDotnetVersion = /^[0-9A-Za-z][0-9A-Za-z.*+_-]*$/u;

export function validateInputs(environment, workspace) {
  const workspaceRoot = realpathSync(workspace);
  const workingDirectoryInput = environment.WORKING_DIRECTORY ?? ".";
  validateRelativePath(workingDirectoryInput, "working-directory", true);
  const workingDirectory = resolveExistingWithin(
    workspaceRoot,
    workingDirectoryInput,
    "working-directory",
  );
  if (!statSync(workingDirectory).isDirectory()) {
    throw new Error("working-directory must identify a directory");
  }

  const solutionInput = required(environment.SOLUTION_PATH, "solution-path");
  validateRelativePath(solutionInput, "solution-path", false);
  const solutionPath = resolveExistingWithin(workingDirectory, solutionInput, "solution-path");
  if (!statSync(solutionPath).isFile()) {
    throw new Error("solution-path must identify a file");
  }

  const configuration = environment.BUILD_CONFIGURATION ?? "Release";
  if (!safeConfiguration.test(configuration)) {
    throw new Error("build-configuration may contain only letters, numbers, '.', '_' and '-'");
  }

  const dotnetVersion = environment.DOTNET_VERSION ?? "10.0.x";
  if (!safeDotnetVersion.test(dotnetVersion)) {
    throw new Error("dotnet-version has an invalid format");
  }

  const diagnostics = environment.FORMAT_DIAGNOSTICS ?? "IDE0005";
  if (diagnostics !== "") {
    const values = diagnostics.split(",").map((value) => value.trim());
    if (values.some((value) => !safeDiagnostic.test(value))) {
      throw new Error("format-diagnostics must be a comma-separated list of diagnostic IDs");
    }
  }

  const retentionDays = parseInteger(environment.ARTIFACT_RETENTION_DAYS ?? "14");
  if (retentionDays < 1 || retentionDays > 90) {
    throw new Error("artifact-retention-days must be between 1 and 90");
  }

  const hasUsername = environment.NUGET_USERNAME_PRESENT === undefined
    ? Boolean(environment.NUGET_USERNAME)
    : boolean(environment.NUGET_USERNAME_PRESENT);
  const hasToken = environment.NUGET_TOKEN_PRESENT === undefined
    ? Boolean(environment.NUGET_TOKEN)
    : boolean(environment.NUGET_TOKEN_PRESENT);
  if (hasUsername !== hasToken) {
    throw new Error("nuget-username and nuget-token must be supplied together");
  }

  return {
    configuration,
    diagnostics,
    dotnetVersion,
    retentionDays,
    solutionPath,
    solutionRelative: toPosix(relative(workingDirectory, solutionPath)),
    workingDirectory,
    workingDirectoryRelative: relative(workspaceRoot, workingDirectory) || ".",
  };
}

export function discoverProjects(root, patternsText) {
  const patterns = patternsText
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) throw new Error("at least one test project pattern is required");
  patterns.forEach(validateGlobPattern);
  const matchers = patterns.map(globToRegExp);
  const rootReal = realpathSync(root);
  const projects = [];

  walkFiles(rootReal, rootReal, (absolutePath) => {
    const candidate = toPosix(relative(rootReal, absolutePath));
    if (matchers.some((matcher) => matcher.test(candidate))) projects.push(candidate);
  });

  return [...new Set(projects)].sort((left, right) => left.localeCompare(right, "en"));
}

export function executeTestProjects(options) {
  const {
    category,
    collectCoverage,
    configuration,
    failOnEmpty,
    patterns,
    resultsRoot,
    runCommand = defaultRunCommand,
    workingDirectory,
  } = options;
  const projects = discoverProjects(workingDirectory, patterns);
  resetOwnedDirectory(resultsRoot);
  writeFileSync(join(resultsRoot, ".artifact-marker"), `${category} test diagnostics\n`, "utf8");
  if (collectCoverage) {
    writeFileSync(join(resultsRoot, ".coverage-marker"), `${category} raw coverage transport\n`, "utf8");
  }

  if (projects.length === 0) {
    if (failOnEmpty) throw new Error(`no ${category} test projects matched the configured patterns`);
    return { failedProjects: [], infrastructureFailure: false, projects, resultsRoot };
  }

  const failedProjects = [];
  for (const [index, project] of projects.entries()) {
    const projectName = basename(project, ".csproj").replaceAll(/[^A-Za-z0-9_.-]/gu, "-");
    const projectResults = join(resultsRoot, `${String(index + 1).padStart(2, "0")}-${projectName}`);
    mkdirSync(projectResults, { recursive: true });
    const argumentsList = [
      "test",
      project,
      "--configuration",
      configuration,
      "--no-build",
      "--no-restore",
      "--results-directory",
      projectResults,
      "--logger",
      `trx;LogFileName=${projectName}-results.trx`,
    ];
    if (collectCoverage) argumentsList.push("--collect", "XPlat Code Coverage");
    const result = runCommand("dotnet", argumentsList, workingDirectory);
    if (result !== 0) failedProjects.push(project);
    if (collectCoverage && result === 0 && findFiles(projectResults, "coverage.cobertura.xml").length === 0) {
      failedProjects.push(`${project} (coverage missing)`);
    }
  }

  const infrastructureFailure =
    category === "integration" &&
    findFiles(resultsRoot, ".trx").some((path) => dockerUnavailable.test(readFileSync(path, "utf8")));
  return {
    failedProjects: [...new Set(failedProjects)],
    infrastructureFailure,
    projects,
    resultsRoot,
  };
}

export function stageBuildOutputs(workingDirectory, configuration, destination) {
  resetOwnedDirectory(destination);
  let copied = 0;
  walkDirectories(realpathSync(workingDirectory), (directory) => {
    const parts = toPosix(relative(workingDirectory, directory)).split("/");
    if (parts.length >= 2 && parts.at(-2) === "bin" && parts.at(-1) === configuration) {
      const target = join(destination, relative(workingDirectory, directory));
      mkdirSync(dirname(target), { recursive: true });
      cpSync(directory, target, { recursive: true });
      copied += 1;
      return false;
    }
    return true;
  });
  if (copied === 0) throw new Error(`build produced no bin/${configuration} directories`);
  return copied;
}

export function inspectCoverage(root, expected) {
  const files = existsSync(root) ? findFiles(root, "coverage.cobertura.xml") : [];
  if (expected && files.length === 0) throw new Error("enabled successful tests produced no coverage files");
  return files;
}

export function calculateSummary(values) {
  const unitOkay = !values.runUnitTests || values.unitResult === "success";
  const integrationOkay = !values.runIntegrationTests || values.integrationResult === "success";
  const coverageExpected = values.collectCoverage && values.coverageExpected;
  const coverageOkay = !coverageExpected || values.coverageResult === "success";
  return {
    buildResult: values.buildResult,
    coverageArtifact: values.coverageUploaded ? values.coverageArtifactName : "",
    integrationTestResult: values.integrationResult,
    testResultsArtifact: values.testResultsUploaded ? values.testResultsArtifactName : "",
    unitTestResult: values.unitResult,
    verificationPassed:
      values.buildResult === "success" && unitOkay && integrationOkay && coverageOkay,
  };
}

function validateRelativePath(value, label, allowDot) {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} contains prohibited control characters`);
  }
  if (value.includes("\\")) throw new Error(`${label} must use '/' separators`);
  if (isAbsolute(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`${label} must be repository-relative`);
  }
  if (!allowDot && (value === "" || value === ".")) throw new Error(`${label} must identify a file`);
  if (value.split("/").some((part) => part === "..")) {
    throw new Error(`${label} must not contain '..' traversal`);
  }
}

function validateGlobPattern(pattern) {
  validateRelativePath(pattern, "test project pattern", false);
  if (!pattern.endsWith(".csproj")) throw new Error("test project patterns must end with .csproj");
  if (pattern.includes("[") || pattern.includes("]") || pattern.includes("{") || pattern.includes("}")) {
    throw new Error("test project patterns support only '*', '**' and '?' wildcards");
  }
}

function resolveExistingWithin(root, candidate, label) {
  const absolute = resolve(root, candidate);
  assertWithin(root, absolute, label);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${candidate}`);
  const real = realpathSync(absolute);
  assertWithin(root, real, label);
  return real;
}

function assertWithin(root, candidate, label) {
  const relation = relative(root, candidate);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes its allowed root`);
  }
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else expression += ".*";
      } else expression += "[^/]*";
    } else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

function walkFiles(root, directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const real = realpathSync(path);
      assertWithin(root, real, "discovered test path");
      if (statSync(real).isFile()) visit(real);
    } else if (entry.isDirectory()) walkFiles(root, path, visit);
    else if (entry.isFile()) visit(path);
  }
}

function walkDirectories(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (visit(path)) walkDirectories(path, visit);
  }
}

function findFiles(root, suffix) {
  const files = [];
  if (!existsSync(root)) return files;
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
    }
  };
  visit(root);
  return files.sort();
}

function resetOwnedDirectory(path) {
  if (!isAbsolute(path)) throw new Error("workflow-owned output directory must be absolute");
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("workflow-owned output path must be a non-symlink directory");
    }
    rmSync(path, { recursive: true });
  }
  mkdirSync(path, { recursive: true });
}

function defaultRunCommand(command, argumentsList, cwd) {
  const result = spawnSync(command, argumentsList, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function parseInteger(value) {
  if (!/^[0-9]+$/u.test(String(value))) throw new Error("expected an integer");
  return Number(value);
}

function required(value, label) {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

function toPosix(value) {
  return value.split(sep).join("/");
}

function writeOutput(name, value) {
  const output = required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  writeFileSync(output, `${name}=${String(value)}\n`, { encoding: "utf8", flag: "a" });
}

function boolean(value) {
  return String(value).toLowerCase() === "true";
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") {
    const result = validateInputs(process.env, required(process.env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE"));
    writeOutput("working-directory", result.workingDirectoryRelative);
    writeOutput("solution-path", result.solutionRelative);
    writeOutput("configuration", result.configuration);
    writeOutput("diagnostics", result.diagnostics);
    writeOutput("retention-days", result.retentionDays);
    return;
  }
  if (command === "test") {
    const category = required(process.env.TEST_CATEGORY, "TEST_CATEGORY");
    const runnerTemp = required(process.env.RUNNER_TEMP, "RUNNER_TEMP");
    const result = executeTestProjects({
      category,
      collectCoverage: boolean(process.env.COLLECT_COVERAGE),
      configuration: required(process.env.BUILD_CONFIGURATION, "BUILD_CONFIGURATION"),
      failOnEmpty: boolean(process.env.FAIL_ON_EMPTY),
      patterns: required(process.env.TEST_PROJECTS, "TEST_PROJECTS"),
      resultsRoot: join(runnerTemp, "dotnet-ci", category),
      workingDirectory: required(process.env.WORKING_DIRECTORY_ABSOLUTE, "WORKING_DIRECTORY_ABSOLUTE"),
    });
    writeOutput("results-root", result.resultsRoot);
    writeOutput("project-count", result.projects.length);
    if (result.infrastructureFailure) throw new Error("integration tests skipped because Docker became unavailable");
    if (result.failedProjects.length > 0) {
      throw new Error(`failed test projects: ${result.failedProjects.join(", ")}`);
    }
    return;
  }
  if (command === "stage-build") {
    const destination = join(required(process.env.RUNNER_TEMP, "RUNNER_TEMP"), "dotnet-ci", "build");
    stageBuildOutputs(
      required(process.env.WORKING_DIRECTORY_ABSOLUTE, "WORKING_DIRECTORY_ABSOLUTE"),
      required(process.env.BUILD_CONFIGURATION, "BUILD_CONFIGURATION"),
      destination,
    );
    writeOutput("build-root", destination);
    return;
  }
  if (command === "coverage") {
    const root = required(process.env.COVERAGE_ROOT, "COVERAGE_ROOT");
    const files = inspectCoverage(root, boolean(process.env.EXPECT_COVERAGE));
    writeOutput("coverage-count", files.length);
    if (files.length === 0) return;
    const executable = required(process.env.REPORTGENERATOR, "REPORTGENERATOR");
    const target = required(process.env.COVERAGE_REPORT_ROOT, "COVERAGE_REPORT_ROOT");
    resetOwnedDirectory(target);
    const status = defaultRunCommand(
      executable,
      [`-reports:${files.join(";")}`, `-targetdir:${target}`, "-reporttypes:HtmlSummary;Cobertura"],
      process.cwd(),
    );
    if (status !== 0) throw new Error(`ReportGenerator exited with status ${status}`);
    writeOutput("coverage-report-root", target);
    return;
  }
  if (command === "summary") {
    const summary = calculateSummary({
      buildResult: required(process.env.BUILD_RESULT, "BUILD_RESULT"),
      collectCoverage: boolean(process.env.COLLECT_COVERAGE),
      coverageExpected: boolean(process.env.EXPECT_COVERAGE),
      coverageArtifactName: required(process.env.COVERAGE_ARTIFACT_NAME, "COVERAGE_ARTIFACT_NAME"),
      coverageResult: process.env.COVERAGE_RESULT ?? "skipped",
      coverageUploaded: process.env.COVERAGE_UPLOAD_RESULT === "success",
      integrationResult: required(process.env.INTEGRATION_RESULT, "INTEGRATION_RESULT"),
      runIntegrationTests: boolean(process.env.RUN_INTEGRATION_TESTS),
      runUnitTests: boolean(process.env.RUN_UNIT_TESTS),
      testResultsArtifactName: required(process.env.TEST_RESULTS_ARTIFACT_NAME, "TEST_RESULTS_ARTIFACT_NAME"),
      testResultsUploaded: process.env.TEST_RESULTS_UPLOAD_RESULT === "success",
      unitResult: required(process.env.UNIT_RESULT, "UNIT_RESULT"),
    });
    writeOutput("build-result", summary.buildResult);
    writeOutput("unit-test-result", summary.unitTestResult);
    writeOutput("integration-test-result", summary.integrationTestResult);
    writeOutput("verification-passed", summary.verificationPassed);
    writeOutput("test-results-artifact", summary.testResultsArtifact);
    writeOutput("coverage-artifact", summary.coverageArtifact);
    return;
  }
  throw new Error(`unknown command: ${command ?? "(missing)"}`);
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  main().catch((error) => {
    console.error(`dotnet-ci: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
