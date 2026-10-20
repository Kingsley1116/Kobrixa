import { expectTypeOf, it } from "vitest";
import type { SettingsControlsPort, PluginUiRendererHost } from "./host-ports.js";
import type { SettingsScalar, UiScalar } from "@kobrixa/plugin-protocol";
it("separates settings controls from feature command forms (U01)", () => {
  expectTypeOf<SettingsScalar>().toEqualTypeOf<boolean | number | string>();
  expectTypeOf<UiScalar>().toEqualTypeOf<boolean | number | string | null>();
  expectTypeOf<Parameters<SettingsControlsPort["onChange"]>[0]>().toBeFunction();
  expectTypeOf<PluginUiRendererHost["dispose"]>().toEqualTypeOf<() => void>();
});
