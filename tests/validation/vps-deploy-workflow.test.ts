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

  it("exposes notification outputs from the always-run record step", () => {
    const on = isObject(workflow.on) ? workflow.on : {};
    const call = isObject(on.workflow_call) ? on.workflow_call : {};
    const outputs = isObject(call.outputs) ? call.outputs : {};
    const jobOutputs = isObject(deploy.outputs) ? deploy.outputs : {};
    for (const name of ["deployment-outcome", "failed-phase", "failure-category", "migration-status", "restoration-outcome"]) {
      expect(isObject(outputs[name]) ? outputs[name].value : undefined).toBe(`\${{ jobs.deploy.outputs.${name} }}`);
      expect(jobOutputs[name]).toBe(`\${{ steps.record.outputs.${name} }}`);
    }
  });

  it("keeps alert delivery out of the deployment job so it cannot change the deployment result", () => {
    expect(source).not.toMatch(/curl|webhook|notify|continue-on-error/iu);
    const names = steps.map((step) => step.name);
    expect(names.at(-1)).toBe("Require a successful deployment");
  });

  it.each(["dotnet", "nextjs"])("%s example alerts from a separate caller-owned job on deployment failure", (example) => {
    const caller = new YamlValidator().load(join(root, "examples", example, "ci.yml"));
    const callerJobs = isObject(caller.jobs) ? caller.jobs : {};
    const notify = isObject(callerJobs["notify-deployment-failure"]) ? callerJobs["notify-deployment-failure"] : {};
    expect(notify.needs).toBe("deploy-production");
    expect(String(notify.if)).toContain("needs.deploy-production.result == 'failure'");
    expect(notify.permissions).toEqual({});
    const text = JSON.stringify(notify);
    expect(text).toContain("secrets.DEPLOY_ALERT_WEBHOOK_URL");
    expect(text).toContain("needs.deploy-production.outputs.deployment-outcome");
    const run = (Array.isArray(notify.steps) ? notify.steps : []).filter(isObject).map((step) => String(step.run ?? "")).join("\n");
    expect(run).not.toMatch(/\$\{\{/u);
  });
});
