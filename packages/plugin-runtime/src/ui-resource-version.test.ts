import { expect, it, vi } from "vitest";
import { uiResourceV1Schema, validateUiResource, uiBytes } from "@kobrixa/plugin-protocol";
import { validateVersionedUiResource } from "./ui-resource-version.js";

const context = { pluginId: "test.version", commands: [], panels: [] };
const status = { kind: "status", text: { text: { en: "Ready" } }, tone: "neutral", data: {} };
it("dispatches only declared versions and never sends v2 through the v1 override", () => {
  const v1 = vi.fn(validateUiResource);
  expect(validateVersionedUiResource(1, status, context, uiBytes(status), v1)).toMatchObject({
    ok: true,
    value: { version: 1, resource: status },
  });
  const v2 = { ...status, actions: [] };
  expect(validateVersionedUiResource(2, v2, context, uiBytes(v2), v1)).toMatchObject({
    ok: true,
    value: { version: 2, resource: v2 },
  });
  expect(v1).toHaveBeenCalledTimes(1);
  for (const version of [0, 3, 65535, NaN, Infinity, 1.5])
    expect(validateVersionedUiResource(version, v2, context, uiBytes(v2), v1)).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_E_UI_VERSION" },
    });
  expect(v1).toHaveBeenCalledTimes(1);
});
it("keeps the v1 parser strict and uses v2's mandatory fields and byte limit", () => {
  const v2 = { ...status, actions: [] };
  expect(uiResourceV1Schema.safeParse(v2).success).toBe(false);
  expect(validateVersionedUiResource(1, v2, context, uiBytes(v2)).ok).toBe(false);
  expect(validateVersionedUiResource(2, status, context, uiBytes(status)).ok).toBe(false);
  expect(validateVersionedUiResource(2, v2, context, 262145)).toMatchObject({
    ok: false,
    error: { code: "PLUGIN_E_UI_RESOURCE" },
  });
});
