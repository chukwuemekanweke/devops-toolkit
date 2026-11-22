import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonSchemaValidator } from "../../src/validation/json-schema-validator.js";

const root = join(import.meta.dirname, "..", "..");
const validator = new JsonSchemaValidator();

describe("JSON schema validation", () => {
  it.each([
    ["docker-images", "docker-images.schema.json"],
    ["deployment-manifest", "deployment-manifest.schema.json"],
  ])("accepts valid and rejects invalid %s fixtures", (contract, schemaName) => {
    const fixtureRoot = join(root, "tests", "fixtures", contract);
    const schema = join(root, "docs", "schemas", schemaName);
    const valid = readdirSync(join(fixtureRoot, "valid")).filter((name) => name.endsWith(".json"));
    const invalid = readdirSync(join(fixtureRoot, "invalid")).filter((name) => name.endsWith(".json"));
    expect(valid.length).toBeGreaterThan(0);
    expect(invalid.length).toBeGreaterThan(0);
    valid.forEach((name) => expect(() => validator.validateDocument(join(fixtureRoot, "valid", name), schema)).not.toThrow());
    invalid.forEach((name) => expect(() => validator.validateDocument(join(fixtureRoot, "invalid", name), schema)).toThrow());
  });

  it.each([
    ["example-backend-prd-webapi.instance.json", "runtime-secrets-instance.schema.json"],
    ["example-backend-webapi.keys.json", "runtime-secrets-key-manifest.schema.json"],
  ])("validates runtime secret contract %s", (document, schema) => {
    expect(() => validator.validateDocument(
      join(root, "examples", "runtime-secrets", document),
      join(root, "docs", "schemas", schema),
    )).not.toThrow();
  });

  it.each(["dotnet", "nextjs"])("validates the %s vps-deploy host stack registry example", (example) => {
    expect(() => validator.validateDocument(
      join(root, "examples", example, "vps-deploy-stack.json"),
      join(root, "docs", "schemas", "vps-deploy-stack.schema.json"),
    )).not.toThrow();
  });

  it("rejects host stack registries with unknown fields", () => {
    const directory = mkdtempSync(join(tmpdir(), "devops-json-"));
    const path = join(directory, "stack.json");
    const document = JSON.parse(readFileSync(join(root, "examples", "nextjs", "vps-deploy-stack.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...document, command: "id" }), "utf8");
    expect(() => validator.validateDocument(path, join(root, "docs", "schemas", "vps-deploy-stack.schema.json"))).toThrow(/additional/iu);
  });

  it.each([
    ["dotnet", 4],
    ["nextjs", 3],
  ])("preserves the %s reference topology", (example, expectedCount) => {
    const path = join(root, "examples", example, "docker-images.json");
    validator.validateDocument(path, join(root, "docs", "schemas", "docker-images.schema.json"));
    const document = JSON.parse(readFileSync(path, "utf8")) as { images: unknown[] };
    expect(document.images).toHaveLength(expectedCount);
  });

  it("rejects duplicate properties at any nesting depth", () => {
    const directory = mkdtempSync(join(tmpdir(), "devops-json-"));
    const path = join(directory, "duplicate.json");
    writeFileSync(path, '{"outer":{"value":1,"value":2}}', "utf8");
    expect(() => validator.parseDocument(path)).toThrow(/duplicate JSON property 'value'/u);
  });

  it("rejects malformed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "devops-json-"));
    const path = join(directory, "malformed.json");
    writeFileSync(path, '{"value":', "utf8");
    expect(() => validator.parseDocument(path)).toThrow(/invalid JSON/u);
  });
});
