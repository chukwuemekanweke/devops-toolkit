import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import {
  getNodeValue,
  type Node as JsonNode,
  type ParseError,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { ValidationError } from "./validation-error.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

export type JsonObject = Record<string, unknown>;

export class JsonSchemaValidator {
  public parseDocument(path: string): unknown {
    const text = readFileSync(path, "utf8");
    const errors: ParseError[] = [];
    const root = parseTree(text, errors, {
      allowTrailingComma: false,
      disallowComments: true,
      allowEmptyContent: false,
    });
    if (errors.length > 0 || root === undefined) {
      const details = errors
        .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
        .join("; ");
      throw new ValidationError(`${path}: invalid JSON: ${details || "empty document"}`);
    }

    this.rejectDuplicateProperties(root, path, "$", 0);
    return getNodeValue(root) as unknown;
  }

  public validateDocument(documentPath: string, schemaPath: string): void {
    const document = this.parseDocument(documentPath);
    const schema = this.parseDocument(schemaPath);
    if (!isObject(schema)) {
      throw new ValidationError(`${schemaPath}: JSON Schema root must be an object`);
    }

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    let validate: ReturnType<Ajv2020["compile"]>;
    try {
      validate = ajv.compile(schema);
    } catch (error) {
      throw new ValidationError(`${schemaPath}: invalid JSON Schema: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    if (!validate(document)) {
      const details = (validate.errors ?? []).map(formatSchemaError).join("; ");
      throw new ValidationError(
        `${documentPath}: schema validation failed: ${details || "document does not satisfy the schema"}`,
      );
    }

    this.validateUniqueComponents(documentPath, document);
  }

  private rejectDuplicateProperties(
    node: JsonNode,
    path: string,
    location: string,
    depth: number,
  ): void {
    if (depth > 128) {
      throw new ValidationError(`${path}: JSON nesting exceeds the supported depth at ${location}`);
    }

    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const keyNode = property.children?.[0];
        const valueNode = property.children?.[1];
        if (keyNode?.type !== "string" || typeof keyNode.value !== "string" || valueNode === undefined) {
          throw new ValidationError(`${path}: invalid object property at ${location}`);
        }

        if (names.has(keyNode.value)) {
          throw new ValidationError(
            `${path}: duplicate JSON property '${keyNode.value}' at ${location}`,
          );
        }

        names.add(keyNode.value);
        this.rejectDuplicateProperties(valueNode, path, `${location}.${keyNode.value}`, depth + 1);
      }
    } else if (node.type === "array") {
      (node.children ?? []).forEach((child, index) => {
        this.rejectDuplicateProperties(child, path, `${location}[${index}]`, depth + 1);
      });
    }
  }

  private validateUniqueComponents(path: string, document: unknown): void {
    if (!isObject(document)) {
      return;
    }

    const collection = Array.isArray(document.images)
      ? document.images
      : Array.isArray(document.components)
        ? document.components
        : undefined;
    if (collection === undefined) {
      return;
    }

    const identityKey = Array.isArray(document.images) ? "component" : "name";
    const identities = collection
      .filter(isObject)
      .map((item) => item[identityKey])
      .filter((value): value is string => typeof value === "string");
    const duplicates = [...new Set(identities.filter((value, index) => identities.indexOf(value) !== index))]
      .sort();
    if (duplicates.length > 0) {
      throw new ValidationError(
        `${path}: duplicate ${identityKey} values: ${duplicates.join(", ")}`,
      );
    }
  }
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSchemaError(error: ErrorObject): string {
  return `${error.instancePath || "<root>"}: ${error.message ?? error.keyword}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
