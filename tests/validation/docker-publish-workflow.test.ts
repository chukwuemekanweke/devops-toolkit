import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowContractValidator } from "../../src/validation/workflow-contract-validator.js";
import { WorkflowSecurityValidator } from "../../src/validation/workflow-security-validator.js";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const root = join(import.meta.dirname, "..", "..");
const path = join(root, ".github", "workflows", "docker-publish.yml");
const source = readFileSync(path, "utf8");
const workflow = new YamlValidator().load(path);

describe("docker publish reusable workflow", () => {
  it("matches the documented public contract and security policy", () => {
    const contract = readFileSync(join(root, "docs", "workflow-contracts.md"), "utf8");
    expect(() => new WorkflowContractValidator().validate(path, workflow, contract)).not.toThrow();
    expect(() => new WorkflowSecurityValidator().validate(path, workflow)).not.toThrow();
  });

  it("validates before login and aggregates artifacts outside the matrix", () => {
    expect(source.indexOf("Validate configuration and inputs")).toBeLessThan(source.indexOf("Log in to Docker Hub"));
    expect(source).toContain("matrix: ${{ fromJSON(needs.prepare.outputs.matrix) }}");
    expect(source).toContain("pattern: image-result-*");
    expect(source).not.toContain("secrets: inherit");
  });

  it("uses digest scans, BuildKit secret mounts, and immutable action pins", () => {
    expect(source).toContain("GITHUB_USERNAME=PACKAGE_USERNAME");
    expect(source).toContain("GITHUB_PAT=PACKAGE_TOKEN");
    expect(source).toContain("@${{ steps.build_public.outputs.digest || steps.build_private.outputs.digest }}");
    expect(source).toContain("severity: CRITICAL");
    expect(source).toContain("provenance: ${{ inputs.generate-provenance }}");
    expect(source).not.toContain("packages: write");
    expect(source).not.toContain(":latest");
  });
});
