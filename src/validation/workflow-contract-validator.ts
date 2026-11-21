import { basename } from "node:path";
import { isObject, type JsonObject } from "./json-schema-validator.js";
import { ValidationError } from "./validation-error.js";

export interface ContractInput {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly defaultValue: string;
}
export interface Permission {
  readonly scope: string;
  readonly level: string;
}

export interface WorkflowContract {
  readonly inputs: ReadonlyMap<string, ContractInput>;
  readonly secrets: ReadonlyMap<string, boolean>;
  readonly outputs: ReadonlySet<string>;
  readonly documentedPermissions: ReadonlySet<string>;
  readonly minimumPermissions: ReadonlySet<string>;
}

export class WorkflowContractValidator {
  public validate(workflowPath: string, workflow: JsonObject, contractDocument: string): void {
    const triggers = asObject(workflow.on);
    const call = asObject(triggers?.workflow_call);
    if (call === undefined) {
      return;
    }

    const fileName = basename(workflowPath);
    const contract = this.parseContract(contractDocument, fileName);
    this.validateInputs(fileName, call, contract);
    this.validateNames(fileName, call, "secrets", contract.secrets.keys());
    this.validateSecretRequirements(fileName, call, contract);
    this.validateNames(fileName, call, "outputs", contract.outputs);
    this.validatePermissions(fileName, workflow, contract);
  }

  public parseContract(document: string, fileName: string): WorkflowContract {
    const lines = document.replaceAll("\r\n", "\n").split("\n");
    const start = lines.findIndex((line) => line.trim() === `## \`${fileName}\``);
    if (start < 0) {
      throw new ValidationError(
        `${fileName}: no authoritative section in docs/workflow-contracts.md`,
      );
    }

    const nextHeading = lines.findIndex(
      (line, index) => index > start && line.startsWith("## `"),
    );
    const section = lines.slice(start + 1, nextHeading < 0 ? undefined : nextHeading);
    const inputs = new Map(
      this.parseTable(section, "Inputs").map((row) => [
        requiredCell(row, 0, "input name"),
        {
          name: requiredCell(row, 0, "input name"),
          type: requiredCell(row, 1, "input type"),
          required: isRequired(requiredCell(row, 2, "input required flag")),
          defaultValue: row[3] ?? "",
        },
      ]),
    );
    const secrets = new Map(
      this.parseTable(section, "Secrets").map((row) => [
        requiredCell(row, 0, "secret name"),
        isRequired(requiredCell(row, 1, "secret required flag")),
      ]),
    );
    const outputs = new Set(
      this.parseTable(section, "Outputs").map((row) => requiredCell(row, 0, "output name")),
    );
    const permissionsText = this.getSection(section, "Permissions").join("\n");
    const documentedPermissions = new Set(
      [...permissionsText.matchAll(/`([a-z-]+): (read|write)`/gu)].map(
        (match) => `${requiredMatch(match, 1)}:${requiredMatch(match, 2)}`,
      ),
    );
    const minimumPermissions = new Set(
      [...permissionsText.matchAll(/minimum:\s*`([a-z-]+): (read|write)`/giu)].map(
        (match) => `${requiredMatch(match, 1)}:${requiredMatch(match, 2)}`,
      ),
    );
    return { inputs, secrets, outputs, documentedPermissions, minimumPermissions };
  }

  private validateInputs(fileName: string, call: JsonObject, contract: WorkflowContract): void {
    const actual = asObject(call.inputs) ?? {};
    ensureSameNames(fileName, "workflow_call inputs", contract.inputs.keys(), Object.keys(actual));
    for (const [name, expected] of contract.inputs) {
      const definition = asObject(actual[name]);
      if (definition === undefined) {
        throw new ValidationError(`${fileName}: input '${name}' must be a mapping`);
      }

      if (definition.type !== expected.type || Boolean(definition.required ?? false) !== expected.required) {
        throw new ValidationError(
          `${fileName}: input '${name}' type/required metadata differs from docs`,
        );
      }

      if (!expected.required && shouldCompareDefault(expected.defaultValue)) {
        if (normalizeDefault(definition.default) !== normalizeDocumentedDefault(expected.defaultValue)) {
          throw new ValidationError(`${fileName}: input '${name}' default differs from docs`);
        }
      }
    }
  }

  private validateNames(
    fileName: string,
    call: JsonObject,
    key: "secrets" | "outputs",
    documented: Iterable<string>,
  ): void {
    const actual = asObject(call[key]) ?? {};
    ensureSameNames(fileName, `workflow_call ${key}`, documented, Object.keys(actual));
  }

  private validateSecretRequirements(
    fileName: string,
    call: JsonObject,
    contract: WorkflowContract,
  ): void {
    const secrets = asObject(call.secrets) ?? {};
    for (const [name, expectedRequired] of contract.secrets) {
      const definition = asObject(secrets[name]);
      if (definition === undefined) {
        throw new ValidationError(`${fileName}: secret '${name}' must be a mapping`);
      }

      if (Boolean(definition.required ?? false) !== expectedRequired) {
        throw new ValidationError(`${fileName}: secret '${name}' required flag differs from docs`);
      }
    }
  }

  private validatePermissions(
    fileName: string,
    workflow: JsonObject,
    contract: WorkflowContract,
  ): void {
    const actual = new Set<string>();
    addPermissions(asObject(workflow.permissions), actual);
    const jobs = asObject(workflow.jobs);
    if (jobs !== undefined) {
      Object.values(jobs).filter(isObject).forEach((job) => {
        addPermissions(asObject(job.permissions), actual);
      });
    }

    if (![...actual].every((permission) => contract.documentedPermissions.has(permission))) {
      throw new ValidationError(
        `${fileName}: declared permissions differ from the documented contract`,
      );
    }

    if (![...contract.minimumPermissions].every((permission) => actual.has(permission))) {
      throw new ValidationError(`${fileName}: documented minimum permissions are not declared`);
    }
  }

  private parseTable(section: readonly string[], heading: string): readonly string[][] {
    return this.getSection(section, heading)
      .filter((line) => line.startsWith("|"))
      .map((line) => line.slice(1, -1).split("|").map(cleanCell))
      .filter((cells) => cells[0] !== "Name" && cells[0] !== "---");
  }

  private getSection(section: readonly string[], heading: string): readonly string[] {
    const start = section.findIndex((line) => line.trim() === `### ${heading}`);
    if (start < 0) {
      throw new ValidationError(`missing ${heading} section in documented workflow contract`);
    }

    const nextHeading = section.findIndex(
      (line, index) => index > start && line.startsWith("### "),
    );
    return section.slice(start + 1, nextHeading < 0 ? undefined : nextHeading);
  }
}

function asObject(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function addPermissions(mapping: JsonObject | undefined, permissions: Set<string>): void {
  if (mapping === undefined) return;
  for (const [scope, level] of Object.entries(mapping)) {
    if (typeof level === "string") permissions.add(`${scope}:${level}`);
  }
}

function cleanCell(value: string): string {
  const cleaned = value.trim();
  return cleaned.startsWith("`") && cleaned.endsWith("`") ? cleaned.slice(1, -1) : cleaned;
}

function isRequired(value: string): boolean {
  return value.toLowerCase() === "yes";
}

function shouldCompareDefault(value: string): boolean {
  return value !== "—" && value !== "â€”" && !value.toLowerCase().startsWith("current ");
}

function normalizeDocumentedDefault(value: string): string {
  return value.replace(/^"|"$/gu, "");
}

function normalizeDefault(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
}

function ensureSameNames(
  fileName: string,
  label: string,
  documented: Iterable<string>,
  actual: Iterable<string>,
): void {
  const expected = [...documented].sort();
  const received = [...actual].sort();
  if (expected.length !== received.length || expected.some((name, index) => name !== received[index])) {
    throw new ValidationError(`${fileName}: ${label} differ from the documented contract`);
  }
}

function requiredCell(row: readonly string[], index: number, label: string): string {
  const value = row[index];
  if (value === undefined) throw new ValidationError(`documented contract row is missing ${label}`);
  return value;
}

function requiredMatch(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new ValidationError("documented permission is malformed");
  return value;
}
