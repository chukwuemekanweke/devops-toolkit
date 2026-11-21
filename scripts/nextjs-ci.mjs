#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const safeVersion = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u;
const safeFilter = /^[A-Za-z0-9@._+*/?!^{}\[\](),=-]+$/u;
const forbiddenArtifactPart = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pnpmfile\.cjs|.*(?:credential|secret|token|private[-_.]?key).*)(?:\/|$)/iu;

export function parseLines(value, label, validate) {
  const lines = String(value ?? "")
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const line of lines) validate(line, label);
  return [...new Set(lines)];
}

export function parseWorkspaceFilters(value) {
  return parseLines(value, "workspace-filters", (filter, label) => {
    if (filter.length > 256 || !safeFilter.test(filter) || filter.startsWith("-")) {
      throw new Error(`${label} contains an unsupported selector: ${filter}`);
    }
  });
}

export function buildScriptArguments(script, filters) {
  if (!["lint", "typecheck", "test", "build"].includes(script)) {
    throw new Error(`unsupported package script: ${script}`);
  }
  const argumentsList = [];
  for (const filter of filters) argumentsList.push("--filter", filter);
  argumentsList.push("run", script);
  return argumentsList;
}

export function validateInputs(environment, workspace) {
  const workspaceRoot = realpathSync(workspace);
  const workingInput = environment.WORKING_DIRECTORY ?? ".";
  validateRelativePath(workingInput, "working-directory", true);
  const workingDirectory = resolveExistingWithin(workspaceRoot, workingInput, "working-directory");
  if (!statSync(workingDirectory).isDirectory()) throw new Error("working-directory must identify a directory");

  const packagePath = resolveExistingWithin(workingDirectory, "package.json", "root package.json");
  const lockfilePath = resolveExistingWithin(workingDirectory, "pnpm-lock.yaml", "pnpm lockfile");
  const packageJson = parseJson(readFileSync(packagePath, "utf8"), "root package.json");
  if (!isRecord(packageJson)) throw new Error("root package.json must contain a JSON object");

  const pnpmVersion = environment.PNPM_VERSION ?? "11.20.0";
  if (!safeVersion.test(pnpmVersion)) throw new Error("pnpm-version has an invalid format");
  if (packageJson.packageManager !== `pnpm@${pnpmVersion}`) {
    throw new Error(`pnpm-version ${pnpmVersion} does not match packageManager '${String(packageJson.packageManager ?? "missing")}'`);
  }

  const nodeVersion = environment.NODE_VERSION ?? "22.13.0";
  if (!safeVersion.test(nodeVersion)) throw new Error("node-version has an invalid format");
  let nodeVersionFile = "";
  if (environment.NODE_VERSION_FILE) {
    validateRelativePath(environment.NODE_VERSION_FILE, "node-version-file", false);
    const versionFile = resolveExistingWithin(workingDirectory, environment.NODE_VERSION_FILE, "node-version-file");
    if (!statSync(versionFile).isFile()) throw new Error("node-version-file must identify a file");
    nodeVersionFile = toPosix(relative(workspaceRoot, versionFile));
  }

  const retentionDays = parseInteger(environment.ARTIFACT_RETENTION_DAYS ?? "14");
  if (retentionDays < 1 || retentionDays > 90) {
    throw new Error("artifact-retention-days must be between 1 and 90");
  }

  const filters = parseWorkspaceFilters(environment.WORKSPACE_FILTERS);
  const uploadArtifacts = boolean(environment.UPLOAD_BUILD_ARTIFACTS);
  const artifactInputs = parseLines(environment.BUILD_ARTIFACT_PATHS, "build-artifact-paths", validateArtifactInput);
  if (uploadArtifacts && artifactInputs.length === 0) {
    throw new Error("build-artifact-paths is required when upload-build-artifacts is enabled");
  }

  return {
    artifactInputs,
    filters,
    lockfileRelative: toPosix(relative(workspaceRoot, lockfilePath)),
    nodeVersion,
    nodeVersionFile,
    pnpmVersion,
    retentionDays,
    workingDirectory,
    workingDirectoryRelative: toPosix(relative(workspaceRoot, workingDirectory)) || ".",
  };
}

export function validatePackageScripts(workingDirectory, enabledScripts) {
  const packageJson = parseJson(readFileSync(resolve(workingDirectory, "package.json"), "utf8"), "root package.json");
  const scripts = isRecord(packageJson) && isRecord(packageJson.scripts) ? packageJson.scripts : {};
  for (const script of enabledScripts) {
    if (typeof scripts[script] !== "string" || scripts[script].trim() === "") {
      throw new Error(`enabled check requires a non-empty root '${script}' script`);
    }
  }
}

export function validateSelection(workingDirectory, filters, runCommand = defaultRunCommand) {
  if (filters.length === 0) return [];
  const args = [];
  for (const filter of filters) args.push("--filter", filter);
  args.push("list", "--depth", "-1", "--json");
  const result = runCommand("pnpm", args, workingDirectory, true);
  if (result.status !== 0) throw new Error(`pnpm could not resolve workspace-filters (exit ${result.status})`);
  const parsed = parseJson(result.stdout, "pnpm workspace selection");
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("workspace-filters did not resolve to any usable workspace");
  }
  return parsed;
}

export function copyBuildConfig(workingDirectory, mappingText) {
  const mapping = parseJson(mappingText || "{}", "build-config-files");
  if (!isRecord(mapping) || Array.isArray(mapping)) throw new Error("build-config-files must be a JSON object");
  const root = realpathSync(workingDirectory);
  const copied = [];
  for (const [destinationInput, sourceInput] of Object.entries(mapping)) {
    if (typeof sourceInput !== "string") throw new Error(`build config source for '${destinationInput}' must be a string`);
    validateRelativePath(sourceInput, "build config source", false);
    validateRelativePath(destinationInput, "build config destination", false);
    const source = resolveExistingWithin(root, sourceInput, "build config source");
    if (!statSync(source).isFile()) throw new Error(`build config source must be a file: ${sourceInput}`);
    const destination = resolve(root, destinationInput);
    assertWithin(root, destination, "build config destination");
    const parent = resolveExistingWithin(root, toPosix(relative(root, dirname(destination))) || ".", "build config destination parent");
    assertWithin(root, realpathSync(parent), "build config destination parent");
    if (existsSync(destination)) throw new Error(`build config destination already exists: ${destinationInput}`);
    copyFileSync(source, destination);
    copied.push(toPosix(relative(root, destination)));
  }
  return copied;
}

export function validateArtifactPaths(workingDirectory, pathsText) {
  const root = realpathSync(workingDirectory);
  const inputs = parseLines(pathsText, "build-artifact-paths", validateArtifactInput);
  if (inputs.length === 0) throw new Error("build-artifact-paths must not be empty");
  return inputs.map((input) => {
    const candidate = resolve(root, input);
    const absolute = resolveExistingWithin(root, input, "build artifact path");
    const info = lstatSync(candidate);
    if (info.isSymbolicLink()) throw new Error(`build artifact path must not be a symbolic link: ${input}`);
    assertArtifactTreeSafe(root, absolute);
    return toPosix(relative(root, absolute));
  });
}

function assertArtifactTreeSafe(root, path) {
  const relativePath = toPosix(relative(root, path));
  if (relativePath && forbiddenArtifactPart.test(relativePath)) {
    throw new Error(`build artifact selection contains a prohibited sensitive path: ${relativePath}`);
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw new Error(`build artifact selection contains a symbolic link: ${relativePath}`);
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path)) assertArtifactTreeSafe(root, resolve(path, entry));
}

export function calculateSummary(values) {
  const resultFor = (enabled, outcome) => enabled ? normalizeOutcome(outcome) : "skipped";
  const lintResult = resultFor(values.runLint, values.lintOutcome);
  const typecheckResult = resultFor(values.runTypecheck, values.typecheckOutcome);
  const testResult = resultFor(values.runTests, values.testOutcome);
  const buildResult = resultFor(values.runBuild, values.buildOutcome);
  const enabledResults = [lintResult, typecheckResult, testResult, buildResult].filter((_, index) =>
    [values.runLint, values.runTypecheck, values.runTests, values.runBuild][index]);
  return {
    buildArtifact: values.uploadArtifacts && values.artifactOutcome === "success" ? values.artifactName : "",
    buildResult,
    lintResult,
    testResult,
    typecheckResult,
    verificationPassed:
      enabledResults.every((result) => result === "success") &&
      (!values.uploadArtifacts || values.artifactOutcome === "success"),
  };
}

function normalizeOutcome(value) {
  return ["success", "failure", "cancelled", "skipped"].includes(value) ? value : "failure";
}

function validateArtifactInput(value, label) {
  validateRelativePath(value, label, false);
  if (value.includes("*") || value.includes("?") || value.includes("[") || value.includes("]")) {
    throw new Error(`${label} does not support glob patterns`);
  }
  if (forbiddenArtifactPart.test(value)) throw new Error(`${label} includes a prohibited sensitive path`);
}

function validateRelativePath(value, label, allowDot) {
  if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.includes("\\")) {
    throw new Error(`${label} contains prohibited characters`);
  }
  if (isAbsolute(value) || /^[A-Za-z]:/u.test(value)) throw new Error(`${label} must be repository-relative`);
  if (!allowDot && (value === "" || value === ".")) throw new Error(`${label} must identify a path`);
  if (value.split("/").some((part) => part === "..")) throw new Error(`${label} must not contain '..' traversal`);
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
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) throw new Error(`${label} escapes its allowed root`);
}

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label} is not valid JSON`); }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseInteger(value) {
  if (!/^[0-9]+$/u.test(String(value))) throw new Error("expected an integer");
  return Number(value);
}

function boolean(value) { return String(value).toLowerCase() === "true"; }
function required(value, label) { if (!value) throw new Error(`${label} is required`); return value; }
function toPosix(value) { return value.split(sep).join("/"); }

function writeOutput(name, value) {
  const output = required(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT");
  if (String(value).includes("\n")) {
    const delimiter = `nextjs_ci_${name}`;
    writeFileSync(output, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, { encoding: "utf8", flag: "a" });
  } else writeFileSync(output, `${name}=${String(value)}\n`, { encoding: "utf8", flag: "a" });
}

function defaultRunCommand(command, argumentsList, cwd, capture = false) {
  const result = spawnSync(command, argumentsList, { cwd, encoding: "utf8", stdio: capture ? "pipe" : "inherit", shell: false });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

async function main() {
  const command = process.argv[2];
  if (command === "validate") {
    const result = validateInputs(process.env, required(process.env.GITHUB_WORKSPACE, "GITHUB_WORKSPACE"));
    writeOutput("working-directory", result.workingDirectoryRelative);
    writeOutput("lockfile", result.lockfileRelative);
    writeOutput("node-version-file", result.nodeVersionFile);
    writeOutput("retention-days", result.retentionDays);
    writeOutput("filters", result.filters.join("\n"));
    return;
  }
  const workingDirectory = required(process.env.WORKING_DIRECTORY_ABSOLUTE, "WORKING_DIRECTORY_ABSOLUTE");
  if (command === "preflight") {
    const enabled = [
      ["lint", boolean(process.env.RUN_LINT)], ["typecheck", boolean(process.env.RUN_TYPECHECK)],
      ["test", boolean(process.env.RUN_TESTS)], ["build", boolean(process.env.RUN_BUILD)],
    ].filter((entry) => entry[1]).map((entry) => entry[0]);
    validatePackageScripts(workingDirectory, enabled);
    validateSelection(workingDirectory, parseWorkspaceFilters(process.env.WORKSPACE_FILTERS));
    return;
  }
  if (command === "run") {
    const script = required(process.argv[3], "script");
    const result = defaultRunCommand("pnpm", buildScriptArguments(script, parseWorkspaceFilters(process.env.WORKSPACE_FILTERS)), workingDirectory);
    if (result.status !== 0) throw new Error(`${script} failed with exit ${result.status}`);
    return;
  }
  if (command === "copy-config") {
    copyBuildConfig(workingDirectory, process.env.BUILD_CONFIG_FILES ?? "{}");
    return;
  }
  if (command === "artifacts") {
    const paths = validateArtifactPaths(workingDirectory, required(process.env.BUILD_ARTIFACT_PATHS, "BUILD_ARTIFACT_PATHS"));
    writeOutput("artifact-paths", paths.map((path) => resolve(workingDirectory, path)).join("\n"));
    return;
  }
  if (command === "summary") {
    const summary = calculateSummary({
      artifactName: required(process.env.ARTIFACT_NAME, "ARTIFACT_NAME"), artifactOutcome: process.env.ARTIFACT_OUTCOME ?? "skipped",
      buildOutcome: process.env.BUILD_OUTCOME ?? "skipped", lintOutcome: process.env.LINT_OUTCOME ?? "skipped",
      runBuild: boolean(process.env.RUN_BUILD), runLint: boolean(process.env.RUN_LINT), runTests: boolean(process.env.RUN_TESTS),
      runTypecheck: boolean(process.env.RUN_TYPECHECK), testOutcome: process.env.TEST_OUTCOME ?? "skipped",
      typecheckOutcome: process.env.TYPECHECK_OUTCOME ?? "skipped", uploadArtifacts: boolean(process.env.UPLOAD_BUILD_ARTIFACTS),
    });
    for (const [name, value] of Object.entries({
      "lint-result": summary.lintResult, "typecheck-result": summary.typecheckResult, "test-result": summary.testResult,
      "build-result": summary.buildResult, "verification-passed": summary.verificationPassed, "build-artifact": summary.buildArtifact,
    })) writeOutput(name, value);
    return;
  }
  throw new Error(`unknown command: ${command ?? "(missing)"}`);
}

const isEntryPoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) main().catch((error) => {
  console.error(`nextjs-ci: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
