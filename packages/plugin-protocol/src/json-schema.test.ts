import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  notificationMethods,
  requestMethods,
  SCHEMA_DEFINITIONS,
  serializeJsonSchema,
} from "./index.js";

const read = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

function keywords(node: unknown, found = new Set<string>(), inProperties = false): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keywords(item, found));
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      if (!inProperties) found.add(key);
      keywords(value, found, !inProperties && (key === "properties" || key === "$defs"));
    }
  return found;
}

describe("published JSON Schema", () => {
  it("matches the committed schema (run pnpm --filter @kobrixa/plugin-protocol schema)", async () => {
    expect(await read("../schema/plugin-protocol.schema.json")).toBe(serializeJsonSchema());
  });
  it("ships the same schema inside the Python SDK", async () => {
    expect(await read("../../../sdks/python/kobrixa/plugin-protocol.schema.json")).toBe(
      serializeJsonSchema(),
    );
  });
  it("uses only keywords that both validators implement and no $ref", async () => {
    const allowed = new Set(JSON.parse(await read("../schema/keywords.json")) as string[]);
    const used = keywords(JSON.parse(serializeJsonSchema()));
    expect([...used].filter((key) => !allowed.has(key))).toEqual([]);
  });
  it("keeps patterns portable between ECMAScript and Python", () => {
    expect(serializeJsonSchema()).not.toMatch(/\\\\[dwsbDWSB]/);
  });
  it("defines every method", () => {
    for (const method of Object.keys(requestMethods)) {
      expect(SCHEMA_DEFINITIONS).toHaveProperty([`${method}.params`]);
      expect(SCHEMA_DEFINITIONS).toHaveProperty([`${method}.result`]);
    }
    for (const method of Object.keys(notificationMethods))
      expect(SCHEMA_DEFINITIONS).toHaveProperty([`${method}.params`]);
  });
});
