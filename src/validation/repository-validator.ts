import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { JsonSchemaValidator, isObject, type JsonObject } from "./json-schema-validator.js";
import { ValidationError } from "./validation-error.js";
import { WorkflowContractValidator } from "./workflow-contract-validator.js";
import { WorkflowSecurityValidator } from "./workflow-security-validator.js";
import { YamlValidator } from "./yaml-validator.js";

const plannedWorkflows = new Set([
  "dotnet-ci.yml",
  "nextjs-ci.yml",
  "docker-publish.yml",
  "vps-deploy.yml",
  "vps-rollback.yml",
]);
const scanExtensions = new Set([".md", ".ts", ".json", ".yml", ".yaml", ".txt"]);
const excludedDirectories = new Set([".git", "node_modules", "coverage", "dist"]);
const secretPatterns: readonly [string, RegExp][] = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
];

export class RepositoryValidator {
  private readonly yamlValidator = new YamlValidator();
  private readonly jsonValidator = new JsonSchemaValidator();
  private readonly contractValidator = new WorkflowContractValidator();
  private readonly securityValidator = new WorkflowSecurityValidator();

  public validate(repositoryRoot: string): readonly string[] {
    const errors: string[] = [];
    const files = enumerateFiles(repositoryRoot);
    const yamlPaths = files
      .filter((path) => [".yml", ".yaml"].includes(extname(path).toLowerCase()))
      .sort();
    yamlPaths.forEach((path) => capture(errors, () => this.yamlValidator.load(path)));

    const workflows = new Map<string, JsonObject>();
    const workflowsPath = join(repositoryRoot, ".github", "workflows");
    if (existsSync(workflowsPath)) {
      readdirSync(workflowsPath)
        .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
        .sort()
        .forEach((name) => {
          const path = join(workflowsPath, name);
          capture(errors, () => {
            const workflow = this.yamlValidator.load(path);
            workflows.set(path, workflow);
            this.securityValidator.validate(path, workflow);
          });
        });
    }

    const contracts = readFileSync(join(repositoryRoot, "docs", "workflow-contracts.md"), "utf8");
    workflows.forEach((workflow, path) => {
      capture(errors, () => this.contractValidator.validate(path, workflow, contracts));
    });

    plannedWorkflows.forEach((name) => {
      const path = join(workflowsPath, name);
      const workflow = workflows.get(path);
      if (workflow === undefined) return;
      const triggers = isObject(workflow.on) ? workflow.on : undefined;
      if (!isObject(triggers?.workflow_call)) {
        errors.push(`${name}: planned capability exists without a workflow_call contract`);
      }
    });

    const schema = join(repositoryRoot, "docs", "schemas", "docker-images.schema.json");
    [
      join(repositoryRoot, "examples", "dotnet", "docker-images.json"),
      join(repositoryRoot, "examples", "nextjs", "docker-images.json"),
    ].forEach((path) => {
      capture(errors, () => this.jsonValidator.validateDocument(path, schema));
    });

    files
      .filter((path) => scanExtensions.has(extname(path).toLowerCase()))
      .sort()
      .forEach((path) => {
        findSecretSignatures(readFileSync(path, "utf8")).forEach((label) => {
          errors.push(`${relative(repositoryRoot, path)}: possible committed ${label}`);
        });
      });

    if (errors.length === 0) {
      console.log(
        `Validated ${workflows.size} workflow(s), ${yamlPaths.length} YAML file(s), ` +
          "documented contracts, schemas, and security policy.",
      );
    }

    return errors;
  }

  public static findRepositoryRoot(startPath: string): string {
    let current = resolve(startPath);
    if (statSync(current).isFile()) current = dirname(current);
    while (true) {
      if (
        existsSync(join(current, "AGENTS.md")) &&
        existsSync(join(current, "docs", "workflow-contracts.md"))
      ) {
        return current;
      }

      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }

    throw new ValidationError(`Could not locate repository root from ${startPath}`);
  }
}
export function findSecretSignatures(text: string): readonly string[] {
  return secretPatterns.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

function enumerateFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    readdirSync(directory, { withFileTypes: true }).forEach((entry) => {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    });
  };
  visit(root);
  return files.filter((path) => !path.split(sep).some((part) => excludedDirectories.has(part)));
}

function capture(errors: string[], action: () => unknown): void {
  try {
    action();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
}
