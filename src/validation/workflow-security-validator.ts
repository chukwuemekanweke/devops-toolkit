import { basename } from "node:path";
import { isObject, type JsonObject } from "./json-schema-validator.js";
import { ValidationError } from "./validation-error.js";

const fullSha = /^[0-9a-f]{40}$/u;
const inputInterpolation = /\$\{\{\s*inputs\./u;

export class WorkflowSecurityValidator {
  public validate(path: string, workflow: JsonObject): void {
    const fileName = basename(path);
    const triggers = isObject(workflow.on) ? workflow.on : undefined;
    if (triggers !== undefined && "pull_request_target" in triggers) {
      throw new ValidationError(`${fileName}: pull_request_target is prohibited`);
    }

    if (!("permissions" in workflow)) {
      throw new ValidationError(`${fileName}: declare top-level least-privilege permissions`);
    }

    rejectSecretsInherit(fileName, workflow);
    const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
    for (const [jobName, value] of Object.entries(jobs)) {
      if (!isObject(value)) continue;
      this.validateNode(fileName, jobName, value);
      if (Array.isArray(value.steps)) {
        value.steps.filter(isObject).forEach((step) => this.validateNode(fileName, jobName, step));
      }
    }
  }

  private validateNode(fileName: string, jobName: string, node: JsonObject): void {
    if (typeof node.uses === "string" && !node.uses.startsWith("./")) {
      const separator = node.uses.lastIndexOf("@");
      const reference = separator >= 0 ? node.uses.slice(separator + 1) : "";
      if (!fullSha.test(reference)) {
        throw new ValidationError(
          `${fileName}:${jobName}: third-party action '${node.uses}' is not pinned to a full SHA`,
        );
      }
    }

    if (typeof node.run === "string" && inputInterpolation.test(node.run)) {
      throw new ValidationError(
        `${fileName}:${jobName}: do not interpolate workflow inputs directly into run scripts`,
      );
    }
  }
}
function rejectSecretsInherit(fileName: string, value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((item) => rejectSecretsInherit(fileName, item));
    return;
  }

  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "secrets" && child === "inherit") {
      throw new ValidationError(`${fileName}: secrets: inherit is prohibited`);
    }

    rejectSecretsInherit(fileName, child);
  }
}
