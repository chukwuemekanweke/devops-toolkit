import { describe, expect, it } from "vitest";
import { WorkflowSecurityValidator } from "../../src/validation/workflow-security-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const yaml = new YamlValidator();
const validator = new WorkflowSecurityValidator();

function validate(source: string): void {
  validator.validate("sample.yml", yaml.parse(source, "sample.yml"));
}

describe("workflow security validation", () => {
  it.each([
    ["unpinned action", "on: workflow_dispatch\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n"],
    ["inherited secrets", "on: workflow_dispatch\npermissions: {}\njobs:\n  test:\n    uses: owner/repo/.github/workflows/test.yml@0123456789012345678901234567890123456789\n    secrets: inherit\n"],
    ["privileged PR trigger", "on:\n  pull_request_target:\npermissions: {}\njobs: {}\n"],
    ["missing permissions", "on: workflow_dispatch\njobs: {}\n"],
    ["input interpolation", "on: workflow_dispatch\npermissions: {}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo '${{ inputs.value }}'\n"],
  ])("rejects %s", (_label, source) => {
    expect(() => validate(source)).toThrow();
  });

  it("accepts SHA-pinned and local actions", () => {
    expect(() => validate("on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@0123456789012345678901234567890123456789\n      - uses: ./actions/local\n")).not.toThrow();
  });
});
