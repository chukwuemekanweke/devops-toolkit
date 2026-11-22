import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isObject } from "../../src/validation/json-schema-validator.js";
import { WorkflowContractValidator } from "../../src/validation/workflow-contract-validator.js";
import { WorkflowSecurityValidator } from "../../src/validation/workflow-security-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const root = join(import.meta.dirname, "..", "..");
const path = join(root, ".github", "workflows", "release-config-check.yml");
const source = readFileSync(path, "utf8");
const workflow = new YamlValidator().load(path);
const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
const check = isObject(jobs.check) ? jobs.check : {};
const steps = Array.isArray(check.steps) ? check.steps.filter(isObject) : [];
const on = isObject(workflow.on) ? workflow.on : {};
const call = isObject(on.workflow_call) ? on.workflow_call : {};

describe("release-config-check reusable workflow", () => {
  it("matches the documented public contract and security policy", () => {
    const contract = readFileSync(join(root, "docs", "workflow-contracts.md"), "utf8");
    expect(() => new WorkflowContractValidator().validate(path, workflow, contract)).not.toThrow();
    expect(() => new WorkflowSecurityValidator().validate(path, workflow)).not.toThrow();
  });

  it("needs no secrets, environment, or write permission so it can run on every pull request", () => {
    expect(call.secrets).toBeUndefined();
    expect(call.outputs).toBeUndefined();
    expect(source).not.toMatch(/\bsecrets\s*[.[]/u);
    expect(Object.keys(jobs)).toEqual(["check"]);
    expect(check.environment).toBeUndefined();
    expect(check.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("checks out without persisted credentials and loads helper code from the exact called revision", () => {
    steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout@")).forEach((step) => {
      expect(isObject(step.with) ? step.with["persist-credentials"] : undefined).toBe(false);
    });
    expect(source).toContain(".workflow_repository");
    expect(source).toContain(".workflow_sha");
    expect(source).toContain("ref: ${{ steps.toolkit.outputs.sha }}");
    expect(source).toContain("scripts/release-config-check.mjs");
  });

  it("passes inputs only through the environment, never into shell programs", () => {
    steps.map((step) => step.run).filter((run): run is string => typeof run === "string").forEach((run) => {
      expect(run).not.toMatch(/\$\{\{\s*inputs\./u);
    });
    const validate = steps.find((step) => step.name === "Validate release configuration") ?? {};
    const env = isObject(validate.env) ? validate.env : {};
    for (const name of ["IMAGE_CONFIG_PATH", "PACKAGE_AUTH_COMPONENTS", "DEPLOY_CONFIG_PATH", "ENVIRONMENT", "STACK_NAME", "STACK_REGISTRY_PATH", "COMPOSE_ENV_FILE"]) {
      expect(String(env[name])).toMatch(/^\$\{\{ inputs\.[a-z-]+ \}\}$/u);
    }
  });

  it("is used by both example callers on every event, ahead of publishing", () => {
    for (const example of ["dotnet", "nextjs"]) {
      const caller = new YamlValidator().load(join(root, "examples", example, "ci.yml"));
      const callerJobs = isObject(caller.jobs) ? caller.jobs : {};
      const job = isObject(callerJobs["check-release-config"]) ? callerJobs["check-release-config"] : {};
      expect(String(job.uses)).toContain("/.github/workflows/release-config-check.yml@");
      expect(job.if).toBeUndefined();
      const publish = isObject(callerJobs["publish-images"]) ? callerJobs["publish-images"] : {};
      expect(publish.needs).toContain("check-release-config");
      const deploy = isObject(callerJobs["deploy-production"]) ? callerJobs["deploy-production"] : {};
      const checkWith = isObject(job.with) ? job.with : {};
      const deployWith = isObject(deploy.with) ? deploy.with : {};
      for (const name of ["deploy-config-path", "environment", "stack-name"]) expect(checkWith[name]).toBe(deployWith[name]);
      expect(deployWith["compose-files"]).toBeUndefined();
    }
  });
});
