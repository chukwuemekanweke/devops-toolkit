import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowContractValidator } from "../../src/validation/workflow-contract-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const contract = `## \`sample.yml\`

### Inputs

| Name | Type | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| \`name\` | string | yes | — | Example name |
| \`enabled\` | boolean | no | \`true\` | Example switch |

### Secrets

| Name | Required | Purpose |
| --- | --- | --- |
| \`token\` | yes | Example token |

### Permissions

Minimum: \`contents: read\`.

### Outputs

| Name | Value |
| --- | --- |
| \`result\` | Example result |
`;

const matchingWorkflow = `on:
  workflow_call:
    inputs:
      name:
        type: string
        required: true
      enabled:
        type: boolean
        default: true
    secrets:
      token:
        required: true
    outputs:
      result:
        value: value
permissions:
  contents: read
jobs: {}
`;

describe("workflow contract validation", () => {
  const yaml = new YamlValidator();
  const validator = new WorkflowContractValidator();

  it("accepts an interface matching the authoritative Markdown", () => {
    expect(() => validator.validate("sample.yml", yaml.parse(matchingWorkflow), contract)).not.toThrow();
  });

  it("rejects contract drift", () => {
    const workflow = yaml.parse(matchingWorkflow.replace("default: true", "default: false"));
    expect(() => validator.validate("sample.yml", workflow, contract)).toThrow(/default differs/u);
  });

  it("ignores maintenance workflows without workflow_call", () => {
    const workflow = yaml.parse("on: workflow_dispatch\npermissions: {}\njobs: {}\n");
    expect(() => validator.validate("validate.yml", workflow, contract)).not.toThrow();
  });

  it("parses the authoritative repository contract", () => {
    const repositoryContract = readFileSync(
      join(import.meta.dirname, "..", "..", "docs", "workflow-contracts.md"),
      "utf8",
    );
    const parsed = validator.parseContract(repositoryContract, "docker-publish.yml");
    expect(parsed.inputs.get("deployment-id")).toMatchObject({
      type: "string",
      required: true,
    });
    expect(parsed.secrets.get("registry-token")).toBe(true);
    expect(parsed.outputs).toContain("manifest-json");
    expect(parsed.minimumPermissions).toContain("contents:read");
  });
});
