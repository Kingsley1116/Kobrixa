import { expect, expectTypeOf, it } from "vitest";
import type { DrainReport } from "./plugin-persistence.js";
import type { DrainReport as RuntimeReport } from "@kobrixa/plugin-runtime";
it("keeps the sole persistence participant report type without publishing runtime API", async () => {
  expectTypeOf<DrainReport>().toEqualTypeOf<RuntimeReport>();
  expect(Object.keys(await import("./plugin-persistence.js"))).toEqual([
    "isLegacyPreferencesSnapshot",
  ]);
});

import { isLegacyPreferencesSnapshot } from "./plugin-persistence.js";
import type { PluginsApi } from "./plugins.js";
import type { PersistenceRecoveryBridge } from "./plugin-persistence.js";

const snapshot170 = {
  nonce: "10000000-0000-4000-8000-000000000002",
  scope: {
    hostEpoch: "10000000-0000-4000-8000-000000000001",
    workbenchInstance: "10000000-0000-4000-8000-000000000003",
  },
  entries: [{ key: "fixture.layout", raw: null }],
};

it("accepts exactly the frozen LegacyPreferencesSnapshot shape", () => {
  expect(isLegacyPreferencesSnapshot(snapshot170)).toBe(true);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, targetSourceKey: "foreign" })).toBe(false);
  expect(isLegacyPreferencesSnapshot({ ...snapshot170, entries: [{ key: "x", raw: 1 }] })).toBe(
    false,
  );
  expect(
    isLegacyPreferencesSnapshot({ ...snapshot170, nonce: snapshot170.nonce.toUpperCase() }),
  ).toBe(true);
  expect(
    isLegacyPreferencesSnapshot({ ...snapshot170, nonce: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA" }),
  ).toBe(false);
  expect(
    isLegacyPreferencesSnapshot({ ...snapshot170, scope: { ...snapshot170.scope, windowId: 1 } }),
  ).toBe(false);
  expect(
    isLegacyPreferencesSnapshot({
      ...snapshot170,
      entries: [
        { key: "x", raw: null },
        { key: "x", raw: "1" },
      ],
    }),
  ).toBe(false);
  expect(
    isLegacyPreferencesSnapshot({
      ...snapshot170,
      entries: [{ key: "x", raw: "界".repeat(22_000) }],
    }),
  ).toBe(false);
});

it("preserves the exact nested recovery DTO and core action vocabulary", () => {
  expectTypeOf<PluginsApi["persistenceRecovery"]>().toEqualTypeOf<PersistenceRecoveryBridge>();
  expectTypeOf<CoreRecoveryItem["actions"][number]["kind"]>().toEqualTypeOf<
    "stop" | "reconcile" | "clear-resolved" | "retry-save" | "manage"
  >();
  expectTypeOf<PluginsApi["recovery"]["act"]>().toEqualTypeOf<CoreRecoveryPort["act"]>();
});

import type { CoreRecoveryItem, CoreRecoveryPort } from "@kobrixa/plugin-runtime";
