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
const report = isObject(jobs.report) ? jobs.report : {};
const reportSteps = Array.isArray(report.steps) ? report.steps.filter(isObject) : [];
const outputNames = [
  "deployment-status", "deployed-id", "previous-deployment-id", "deployment-record-artifact", "deployment-outcome",
  "failed-phase", "failure-category", "migration-status", "restoration-outcome",
];

/** Every string in a parsed YAML node (keys and values, any depth). */
function strings(node: unknown): string[] {
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(strings);
  if (node !== null && typeof node === "object") return Object.entries(node).flatMap(([key, value]) => [key, ...strings(value)]);
  return [];
}
const secretReferences = (node: unknown) => strings(node).filter((value) => /\bsecrets\s*(?:\.|\[)/u.test(value));

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
    [...steps, ...reportSteps].map((step) => step.run).filter((run): run is string => typeof run === "string").forEach((run) => {
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

  it("exposes every workflow output from the always-run, secret-free report job", () => {
    const on = isObject(workflow.on) ? workflow.on : {};
    const call = isObject(on.workflow_call) ? on.workflow_call : {};
    const outputs = isObject(call.outputs) ? call.outputs : {};
    expect(Object.keys(outputs)).toEqual(outputNames);
    const jobOutputs = isObject(report.outputs) ? report.outputs : {};
    expect(Object.keys(jobOutputs)).toEqual(outputNames);
    for (const name of outputNames) {
      expect(isObject(outputs[name]) ? outputs[name].value : undefined).toBe(`\${{ jobs.report.outputs.${name} }}`);
      expect(jobOutputs[name]).toBe(`\${{ steps.report.outputs.${name} }}`);
    }
    expect(report.needs).toBe("deploy");
    expect(report.if).toBe("${{ always() }}");
    expect(report.permissions).toEqual({ contents: "read" });
    expect(report.environment).toBeUndefined();
  });

  it("detects secret references in every field shape the boundary check relies on", () => {
    // Guards the traversal so a refactor cannot silently make the boundary checks vacuous.
    const probes: unknown[] = [
      { env: { A: "${{ secrets.x }}" } }, { steps: [{ with: { a: "${{ secrets.x }}" } }] }, { if: "secrets.x != ''" },
      { steps: [{ env: { A: "${{ secrets['x'] }}" } }] }, { steps: [{ run: "echo ${{ secrets.x }}" }] }, { outputs: { a: "${{ secrets.x }}" } },
    ];
    for (const probe of probes) expect(secretReferences(probe)).not.toEqual([]);
    expect(secretReferences({ env: { A: "${{ inputs.secretsless }}" } })).toEqual([]);
  });

  it("keeps the report job free of secret references and the deploy job free of job outputs", () => {
    expect(Object.keys(jobs)).toEqual(["deploy", "report"]);
    expect(secretReferences(report)).toEqual([]);
    expect(deploy.outputs).toBeUndefined();
  });

  it("locates the record without any output of the secret-bearing job and tolerates a missing record", () => {
    expect(JSON.stringify(report)).not.toMatch(/needs\.deploy\.outputs/u);
    const names = reportSteps.map((step) => step.name);
    expect(names).toEqual([
      "Resolve called workflow source", "Check out matching toolkit implementation", "Name the deployment record artifact",
      "Download deployment record", "Export deployment outputs",
    ]);
    const download = reportSteps[3] ?? {};
    const options = isObject(download.with) ? download.with : {};
    expect(options.pattern).toBe("${{ steps.artifact.outputs.record-artifact }}");
    expect(options).not.toHaveProperty("name");
    expect(options["merge-multiple"]).toBe(true);
    expect(String(reportSteps[2]?.run)).toContain("vps-deploy.mjs record-artifact");
    expect(String(reportSteps[4]?.run)).toContain("vps-deploy.mjs report");
    expect(report.env).toEqual({ STACK_NAME: "${{ inputs.stack-name }}", RUN_ID: "${{ github.run_id }}", RUN_ATTEMPT: "${{ github.run_attempt }}" });
    expect(isObject(deploy.env) ? deploy.env.STACK_NAME : undefined).toBe("${{ inputs.stack-name }}");
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
