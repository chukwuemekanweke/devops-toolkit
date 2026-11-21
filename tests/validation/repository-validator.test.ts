import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findSecretSignatures, RepositoryValidator } from "../../src/validation/repository-validator.js";

const root = join(import.meta.dirname, "..", "..");

describe("repository validation", () => {
  it("validates the repository", () => {
    expect(new RepositoryValidator().validate(root)).toEqual([]);
  });

  it("finds representative committed-secret signatures", () => {
    const githubToken = ["ghp", "a".repeat(24)].join("_");
    expect(findSecretSignatures(githubToken)).toContain("GitHub token");
    expect(findSecretSignatures("AKIA" + "A".repeat(16))).toContain("AWS access key");
    expect(findSecretSignatures(["-----BEGIN", "PRIVATE KEY-----"].join(" "))).toContain("private key");
  });
});
