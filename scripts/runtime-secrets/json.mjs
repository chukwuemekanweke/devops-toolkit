import { readFile } from "node:fs/promises";
import { getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";
import { ExitCode, fail } from "./errors.mjs";

export function parseStrictJson(text, label, maxBytes = 1024 * 1024) {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    fail("validation", `${label} exceeds the ${maxBytes}-byte limit`, ExitCode.VALIDATION);
  }
  const errors = [];
  const root = parseTree(text, errors, {
    allowTrailingComma: false,
    disallowComments: true,
    allowEmptyContent: false,
  });
  if (!root || errors.length > 0) {
    const details = errors.map((item) => printParseErrorCode(item.error)).join(", ");
    fail("validation", `${label} is not valid JSON${details ? ` (${details})` : ""}`, ExitCode.VALIDATION);
  }
  rejectDuplicates(root, label, "$", 0);
  return getNodeValue(root);
}

export async function readStrictJson(path, label = path, maxBytes) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    fail("configuration", `Cannot read ${label}`, ExitCode.CONFIG, { cause: error });
  }
  return parseStrictJson(text, label, maxBytes);
}

function rejectDuplicates(node, label, location, depth) {
  if (depth > 64) fail("validation", `${label} is nested too deeply`, ExitCode.VALIDATION);
  if (node.type === "object") {
    const names = new Set();
    for (const property of node.children ?? []) {
      const [key, value] = property.children ?? [];
      if (!key || key.type !== "string" || typeof key.value !== "string" || !value) {
        fail("validation", `${label} has an invalid property at ${location}`, ExitCode.VALIDATION);
      }
      if (names.has(key.value)) {
        fail("validation", `${label} has duplicate key '${key.value}'`, ExitCode.VALIDATION);
      }
      names.add(key.value);
      rejectDuplicates(value, label, `${location}.${key.value}`, depth + 1);
    }
  } else if (node.type === "array") {
    (node.children ?? []).forEach((child, index) => rejectDuplicates(child, label, `${location}[${index}]`, depth + 1));
  }
}
