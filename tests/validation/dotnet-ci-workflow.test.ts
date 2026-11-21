import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isObject } from "../../src/validation/json-schema-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const root = join(import.meta.dirname, "..", "..");
const workflow = new YamlValidator().load(join(root, ".github", "workflows", "dotnet-ci.yml"));

describe("reusable .NET CI workflow", () => {
  it("keeps the four independently visible jobs", () => {
    const jobs = isObject(workflow.jobs) ? workflow.jobs : {};
    expect(Object.keys(jobs)).toEqual(["build", "unit_tests", "integration_tests", "coverage_report"]);
    expect(isObject(jobs.unit_tests) ? jobs.unit_tests.needs : undefined).toBe("build");
    expect(isObject(jobs.integration_tests) ? jobs.integration_tests.needs : undefined).toBe("build");
  });

  it("uses Testcontainers-capable Docker verification without Compose inputs", () => {
    const source = JSON.stringify(workflow);
    expect(source).toContain("docker info");
    expect(source).not.toContain("integration-compose-file");
    expect(source).not.toContain("integration-compose-services");
    expect(source).not.toContain("integration-env");
  });

  it("publishes the documented verification and artifact outputs", () => {
    const call = isObject(workflow.on) && isObject(workflow.on.workflow_call)
      ? workflow.on.workflow_call
      : {};
    const outputs = isObject(call.outputs) ? call.outputs : {};
    expect(Object.keys(outputs).sort()).toEqual([
      "build-result",
      "coverage-artifact",
      "integration-test-result",
      "test-results-artifact",
      "unit-test-result",
      "verification-passed",
    ]);
  });
});
