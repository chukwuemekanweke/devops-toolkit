import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isObject } from "../../src/validation/json-schema-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const root = join(import.meta.dirname, "..", "..");
const path = join(root, ".github", "workflows", "nextjs-ci.yml");
const source = readFileSync(path, "utf8");
const workflow = new YamlValidator().load(path);

describe("reusable Next.js CI workflow", () => {
  it("installs once and exposes the documented outputs", () => {
    const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
    expect(Object.keys(jobs)).toEqual(["verify"]);
    expect(source.match(/pnpm install/gu)).toHaveLength(2);
    const call = isObject(workflow.on) && isObject(workflow.on.workflow_call) ? workflow.on.workflow_call : {};
    const outputs = isObject(call.outputs) ? call.outputs : {};
    expect(Object.keys(outputs).sort()).toEqual([
      "build-artifact", "build-result", "lint-result", "test-result", "typecheck-result", "verification-passed",
    ]);
  });

  it("loads helper code from the exact called workflow revision", () => {
    expect(source).toContain(".workflow_repository");
    expect(source).toContain(".workflow_sha");
    expect(source).toContain("ref: ${{ steps.toolkit.outputs.sha }}");
    expect(source).toContain("scripts/nextjs-ci.mjs");
  });

  it("keeps selectors out of shell interpolation and deployment credentials out of CI", () => {
    const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
    const verify = isObject(jobs.verify) ? jobs.verify : {};
    const steps = Array.isArray(verify.steps) ? verify.steps.filter(isObject) : [];
    expect(steps.map((step) => step.run).filter((run): run is string => typeof run === "string"))
      .not.toContain(expect.stringContaining("inputs.workspace-filters"));
    expect(source).not.toContain("secrets: inherit");
    expect(source).not.toMatch(/dockerhub|ssh-|registry-token|infisical|doppler/iu);
    expect(source).toContain("contents: read");
  });

  it("blocks build after a failed enabled quality check", () => {
    expect(source).toContain("steps.lint.outcome == 'success'");
    expect(source).toContain("steps.typecheck.outcome == 'success'");
    expect(source).toContain("steps.tests.outcome == 'success'");
  });
});
