import { expect, expectTypeOf, it } from "vitest";
import { requestMethods, notificationMethods } from "./methods.js";
import { settingsRequestSchemas, type SettingsRequestMap } from "./settings.js";
import { storageRequestSchemas, type StorageRequestMap, type DrainRequest } from "./storage.js";
import { persistenceActionRequestSchemas, type PersistenceActionRequestMap } from "./persistence-actions.js";
it("preserves F types and isolates the unpublished method maps", () => {
  expectTypeOf<SettingsRequestMap["settings/read"]["params"]>().toEqualTypeOf<{ schemaVersion: number }>();
  expectTypeOf<StorageRequestMap["storage/drain"]["params"]>().toEqualTypeOf<DrainRequest>();
  expectTypeOf<PersistenceActionRequestMap["ui/copyText"]["params"]>().toEqualTypeOf<{ actionRef: string; text: string }>();
  expect(Object.keys(settingsRequestSchemas)).toHaveLength(6);
  expect(Object.keys(storageRequestSchemas)).toHaveLength(17);
  expect(Object.keys(persistenceActionRequestSchemas)).toHaveLength(6);
  expect(Object.keys(requestMethods)).not.toContain("settings/unwatch");
  expect(Object.keys(notificationMethods)).not.toContain("settings.gap");
  // P170 may subsequently install these exact maps. Until that one batch, none is installed.
  const installed = Object.keys(requestMethods).filter(m => m.startsWith("settings/") || m.startsWith("storage/") || m === "ui/copyText");
  expect(installed.length === 0 || installed.length === 29).toBe(true);
});

import { readFileSync } from "node:fs";
import { z } from "zod";
import { settingsResourceV1Schema } from "./settings.js";
import { chunkSchema, validateSettingsResource, jsonBytes } from "./persistence-validation.js";
const fixtureCase = z.strictObject({id:z.string(),schema:z.string(),phase:z.enum(["params","result","resource","event"]),
  input:z.unknown(),valid:z.boolean(),expected:z.strictObject({numericCode:z.number().nullable(),businessCode:z.string().nullable(),
    reason:z.string().nullable(),permission:z.string().nullable(),lifetime:z.string().nullable(),persistedSha256:z.string().regex(/^[0-9a-f]{64}$/).nullable()})});
const fixtureFile = z.strictObject({formatVersion:z.literal(1),family:z.literal("settings-storage-v1"),cases:z.array(fixtureCase)});
const schemas = {...settingsRequestSchemas,...storageRequestSchemas,...persistenceActionRequestSchemas};
for (const name of ["valid","invalid","maximum"]) it(`strict shared ${name} cases`, () => {
  const file = fixtureFile.parse(JSON.parse(readFileSync(new URL(`../test-fixtures/settings-storage-v1/${name}.json`,import.meta.url),"utf8")));
  for (const c of file.cases) {
    let success: boolean;
    if (c.schema === "settingsResourceV1" && c.phase === "resource") {
      try { validateSettingsResource(c.input,jsonBytes(c.input)); success=true; } catch { success=false; }
    } else if (c.schema === "chunk" && c.phase === "params") success=chunkSchema().safeParse(c.input).success;
    else {
      if (!Object.hasOwn(schemas,c.schema) || (c.phase !== "params" && c.phase !== "result")) throw new Error("unknown-fixture-schema");
      const schema=schemas[c.schema as keyof typeof schemas]; success=schema[c.phase].safeParse(c.input).success;
    }
    expect(success,c.id).toBe(c.valid);
    if (c.valid) expect([c.expected.numericCode,c.expected.businessCode,c.expected.reason]).toEqual([null,null,null]);
  }
  expect(fixtureFile.safeParse({...file,resources:[]}).success).toBe(false);
  for (const c of file.cases) {
    expect(fixtureCase.safeParse({ ...c, extra: true }).success).toBe(false);
    expect(fixtureCase.safeParse({ ...c, expected: { ...c.expected, extra: true } }).success).toBe(false);
  }
});
