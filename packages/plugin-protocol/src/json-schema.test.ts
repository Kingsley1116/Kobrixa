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
  it("publishes the 1.7.0 schema and a strict language service declaration", () => {
    const schema = JSON.parse(serializeJsonSchema());
    expect(schema.$id).toBe("https://kobrixa.com/schemas/plugin-protocol/1.7.0.json");
    const services = schema.$defs.manifest.properties.contributes.properties.languageServices;
    expect(services.maxItems).toBe(8);
    expect(services.items.additionalProperties).toBe(false);
  });
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
  it("publishes strict v1 tokenizer/configuration definitions and code-point limits", () => {
    const schema = JSON.parse(serializeJsonSchema());
    for (const name of ["static-language-tokenizer-v1", "static-language-configuration-v1"])
      expect(schema.$defs[name].additionalProperties).toBe(false);
    const languages = schema.$defs.manifest.properties.contributes.properties.languages;
    expect(languages.maxItems).toBe(8);
    expect(languages.items.additionalProperties).toBe(false);
    expect(languages.items.properties.aliases.items.maxLength).toBe(80);
    expect(languages.items.properties.aliases).toMatchObject({ minItems: 1, maxItems: 8 });
    expect(languages.items.properties.extensions).toMatchObject({ minItems: 1, maxItems: 16 });
    expect(languages.items.properties.tokenizer.properties.path.maxLength).toBe(600);
    expect(languages.items.properties.tokenizer.additionalProperties).toBe(false);
    expect(languages.items.properties.configuration.properties.version.const).toBe(1);
    expect(
      schema.$defs["static-language-configuration-v1"].properties.wordPattern.properties.pattern
        .maxLength,
    ).toBe(2048);
    expect(serializeJsonSchema()).not.toContain("\\p{");
  });
});

it("publishes the cumulative 1.7.0 UI and persistence batches", () => {
  const schema = JSON.parse(serializeJsonSchema());
  expect(schema.$id).toBe("https://kobrixa.com/schemas/plugin-protocol/1.7.0.json");
  for (const name of [
    "ui/negotiate",
    "ui/ready",
    "ui/instances",
    "ui/state",
    "ui/patch",
    "ui/subscribe",
    "ui/snapshot",
    "command/invoke",
  ])
    expect(schema.$defs).toHaveProperty([`${name}.params`]);
  for (const name of ["ui/copyText", "settings/read", "storage/drain", "storage/exportBegin"])
    expect(schema.$defs).toHaveProperty([`${name}.params`]);
  expect(Object.keys(requestMethods)).not.toContain("ui/ack");
  expect(Object.keys(notificationMethods)).not.toContain("ui/event");
});

it("publishes settings.changed with a closed payload and no settings.gap", () => {
  const notification = notificationMethods["events/deliver"];
  const event = {
    version: 1,
    subscriptionId: "11111111-1111-4111-8111-111111111111",
    owner: {
      sourceKey: "builtin:test.persistence",
      pluginId: "test.persistence",
      generation: 1,
      hostEpoch: "22222222-2222-4222-8222-222222222222",
      processEpoch: "33333333-3333-4333-8333-333333333333",
    },
    sequence: 1,
    delivery: "telemetry",
    kind: "settings.changed",
    data: {
      revision: "r_" + "1".repeat(32),
      schemaVersion: 1,
      changedKeys: ["fixture.enabled"],
      cause: "update",
    },
  };
  expect(notification.safeParse(event).success).toBe(true);
  expect(notification.safeParse({ ...event, data: { ...event.data, values: [] } }).success).toBe(
    false,
  );
  expect(notification.safeParse({ ...event, kind: "settings.gap" }).success).toBe(false);
  expect(notification.safeParse({ ...event, delivery: "control" }).success).toBe(false);
  expect(
    notification.safeParse({
      ...event,
      data: { ...event.data, changedKeys: Array.from({ length: 129 }, (_, i) => `key${i}`) },
    }).success,
  ).toBe(false);
});
