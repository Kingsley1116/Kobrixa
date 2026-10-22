import { expect, it } from "vitest";
import { PLUGIN_ERROR_CODES as protocolCodes } from "@kobrixa/plugin-protocol";
import { PLUGIN_ERROR_CODES, PluginError } from "./errors.js";
it("F18 runtime reexports the single published protocol code identity", () => {
  expect(PLUGIN_ERROR_CODES).toBe(protocolCodes);
  expect(PLUGIN_ERROR_CODES).toContain("PLUGIN_E_DEVICE_PROVIDER_REQUIRES_BUILTIN");
  expect(new PluginError("PLUGIN_E_DEVICE_UNAVAILABLE", "disabled").code).toBe(
    "PLUGIN_E_DEVICE_UNAVAILABLE",
  );
  expect(PLUGIN_ERROR_CODES).toContain("PLUGIN_E_STORAGE_IO");
  expect(new PluginError("PLUGIN_E_STORAGE_IO", "write failed").code).toBe(
    "PLUGIN_E_STORAGE_IO",
  );
});
