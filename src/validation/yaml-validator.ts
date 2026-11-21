import { readFileSync } from "node:fs";
import { isMap, parseDocument } from "yaml";
import { isObject, type JsonObject } from "./json-schema-validator.js";
import { ValidationError } from "./validation-error.js";

export class YamlValidator {
  public load(path: string): JsonObject {
    return this.parse(readFileSync(path, "utf8"), path);
  }

  public parse(source: string, sourceName = "<yaml>"): JsonObject {
    const document = parseDocument(source, {
      prettyErrors: true,
      strict: true,
      uniqueKeys: true,
      version: "1.2",
    });
    if (document.errors.length > 0) {
      throw new ValidationError(
        `${sourceName}: invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
      );
    }

    if (!isMap(document.contents)) {
      throw new ValidationError(`${sourceName}: YAML root must be a mapping`);
    }

    const value: unknown = document.toJS({ mapAsMap: false, maxAliasCount: 100 });
    if (!isObject(value)) {
      throw new ValidationError(`${sourceName}: YAML root must be a mapping`);
    }

    return value;
  }
}
