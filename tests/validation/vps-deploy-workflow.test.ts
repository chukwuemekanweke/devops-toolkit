import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isObject } from "../../src/validation/json-schema-validator.js";
import { WorkflowContractValidator } from "../../src/validation/workflow-contract-validator.js";
import { WorkflowSecurityValidator } from "../../src/validation/workflow-security-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const root = join(import.meta.dirname, "..", "..");
const path = join(root, ".github", "workflows", "vps-deploy.yml");
const source = readFileSync(path, "utf8");
const workflow = new YamlValidator().load(path);
const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
const deploy = isObject(jobs.deploy) ? jobs.deploy : {};
const steps = Array.isArray(deploy.steps) ? deploy.steps.filter(isObject) : [];
const stepNamed = (name: string) => steps.find((step) => step.name === name) ?? {};

describe("vps-deploy reusable workflow", () => {
  it("matches the documented public contract and security policy", () => {
    const contract = readFileSync(join(root, "docs", "workflow-contracts.md"), "utf8");
    expect(() => new WorkflowContractValidator().validate(path, workflow, contract)).not.toThrow();
    expect(() => new WorkflowSecurityValidator().validate(path, workflow)).not.toThrow();
  });

  it("selects the caller environment and serializes without cancelling in-progress deployments", () => {
    expect(deploy.environment).toBe("${{ inputs.environment }}");
    expect(deploy.concurrency).toEqual({
      group: "deploy-${{ github.repository }}-${{ inputs.environment }}-${{ inputs.stack-name }}",
      "cancel-in-progress": false,
    });
    expect(deploy.permissions).toEqual({ contents: "read" });
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("validates every input before any step receives SSH or registry secrets", () => {
    const names = steps.map((step) => step.name);
    const remote = names.indexOf("Deploy through the constrained host interface");
    expect(names.indexOf("Validate deployment inputs")).toBeLessThan(remote);
    expect(names.indexOf("Validate release and Compose files")).toBeLessThan(remote);
    steps.forEach((step, index) => {
      const env = isObject(step.env) ? JSON.stringify(step.env) : "";
      if (index !== remote) expect(env).not.toMatch(/secrets\./u);
    });
    expect(JSON.stringify(stepNamed("Deploy through the constrained host interface").env)).toContain("secrets.registry-token");
  });

  it("loads helper code from the exact called workflow revision", () => {
    expect(source).toContain(".workflow_repository");
    expect(source).toContain(".workflow_sha");
    expect(source).toContain("ref: ${{ steps.toolkit.outputs.sha }}");
    expect(source).toContain("scripts/vps-deploy.mjs");
  });

  it("keeps inputs out of shell programs and never weakens host-key verification", () => {
    steps.map((step) => step.run).filter((run): run is string => typeof run === "string").forEach((run) => {
      expect(run).not.toMatch(/\$\{\{\s*(?:inputs|secrets)\./u);
    });
    expect(source).not.toMatch(/StrictHostKeyChecking=(?:no|accept-new)|ssh-keyscan|secrets: inherit|doppler/iu);
  });

  it("always records a sanitized audit artifact and fails unless the deployment succeeded", () => {
    expect(stepNamed("Write sanitized deployment record").if).toBe("${{ always() }}");
    expect(String(stepNamed("Upload deployment record").if)).toContain("always()");
    const final = stepNamed("Require a successful deployment");
    expect(final.if).toBe("${{ always() }}");
    expect(String(final.run)).toContain('"$STATUS" != "succeeded"');
  });
});
