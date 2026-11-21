import { describe, expect, it } from "vitest";
import { YamlValidator } from "../../src/validation/yaml-validator.js";

const validator = new YamlValidator();

describe("YAML validation", () => {
  it("preserves GitHub Actions trigger keys and YAML 1.2 booleans", () => {
    const document = validator.parse("on: workflow_dispatch\nenabled: true\nlegacy: yes\n");
    expect(document.on).toBe("workflow_dispatch");
    expect(document.enabled).toBe(true);
    expect(document.legacy).toBe("yes");
  });

  it("rejects duplicate mapping keys", () => {
    expect(() => validator.parse("jobs: {}\njobs: {}\n", "duplicate.yml")).toThrow(/Map keys must be unique|duplicate/iu);
  });

  it("rejects malformed documents", () => {
    expect(() => validator.parse("jobs: [\n", "malformed.yml")).toThrow(/invalid YAML/u);
  });

  it("requires a mapping root", () => {
    expect(() => validator.parse("- item\n", "array.yml")).toThrow(/root must be a mapping/u);
  });
});
