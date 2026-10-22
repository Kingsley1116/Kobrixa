import { expect, expectTypeOf, it } from "vitest";
import { requestMethods, notificationMethods } from "./methods.js";
import type { SettingsSnapshot, SettingsRequestMap, Values } from "./settings.js";
import type { StorageRequestMap, DrainRequest } from "./storage.js";
import type { PersistenceActionRequestMap } from "./persistence-actions.js";
it("freezes isolated maps without advertising future methods", () => {
  expectTypeOf<SettingsSnapshot["values"]>().toEqualTypeOf<Values>();
  expectTypeOf<SettingsRequestMap["settings/read"]["params"]>().toEqualTypeOf<{schemaVersion: number}>();
  expectTypeOf<StorageRequestMap["storage/drain"]["params"]>().toEqualTypeOf<DrainRequest>();
  expectTypeOf<PersistenceActionRequestMap["ui/copyText"]["params"]>().toEqualTypeOf<{actionRef: string; text: string}>();
  expect(Object.keys(requestMethods)).not.toContain("settings/unwatch");
  expect(Object.keys(requestMethods).filter(m => m.startsWith("settings/") || m.startsWith("storage/") || m === "ui/copyText")).toEqual([]);
  expect(Object.keys(notificationMethods)).not.toContain("settings.gap");
});
