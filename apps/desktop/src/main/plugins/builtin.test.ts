import { expect, it } from "vitest";
import { loadPlugins, resolveCompilerProviders } from "@kobrixa/plugin-runtime";
import { BuildError, failedBuild } from "@kobrixa/compiler";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";
import { EV3Backend } from "@kobrixa/backend-ev3";
import { BUILTIN_PLUGIN_SOURCES } from "./builtin.js";
import { createBuiltinCompilers } from "../workspace/builtin-compilers.js";

it("registers separate Basic Plus and EV3 providers in safe mode", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: true,
  });
  expect(plugins.map((plugin) => [plugin.id, plugin.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
    ["kobrixa.ev3", "enabled"],
  ]);
  const snapshot = resolveCompilerProviders(plugins, "bp", "ev3-native");
  if (!snapshot.ok) throw new Error(snapshot.message);
  const { frontend, backend } = createBuiltinCompilers(snapshot);
  expect(frontend).toBeInstanceOf(BasicPlusFrontend);
  const project = {
    root: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      name: "demo",
      language: "bp",
      target: "ev3-native",
      entry: "main.bp",
      outputDir: "build",
      assets: [],
    },
    sources: [{ path: "main.bp", content: "LCD.Clear()\n" }],
    assets: [],
  };
  const signal = new AbortController().signal;
  const compiled = await frontend.compile(project, signal);
  const raw = await new EV3Backend().compile(compiled.ir!, signal);
  const adapted = await backend.compile(compiled.ir!, signal);
  expect(adapted).toEqual({
    artifacts: [
      { slot: "program", data: raw.rbf },
      { slot: "listing", data: new TextEncoder().encode(raw.listing) },
    ],
    diagnostics: raw.diagnostics,
  });
  expect(backend.declaration.capabilities.deploy).toBe("ev3");
  expect(backend.irVersion).toBe(1);
  expect(() =>
    createBuiltinCompilers({
      ...snapshot,
      backend: { ...snapshot.backend, pluginId: "test.missing" },
    }),
  ).toThrow("BUILD1001");
});

it("uses the package BuildError identity for missing built-in factories", async () => {
  const plugins = await loadPlugins(BUILTIN_PLUGIN_SOURCES, {
    disabled: new Set(),
    safeMode: false,
  });
  const snapshot = resolveCompilerProviders(plugins, "bp", "ev3-native");
  if (!snapshot.ok) throw new Error(snapshot.message);
  const error = (() => {
    try {
      createBuiltinCompilers({
        ...snapshot,
        backend: { ...snapshot.backend, pluginId: "test.missing" },
      });
    } catch (caught) {
      return caught;
    }
    throw new Error("Expected a missing factory error.");
  })();
  expect(error).toBeInstanceOf(BuildError);
  expect(failedBuild("missing-factory", "ev3-native", error, "main.bp")).toMatchObject({
    success: false,
    artifacts: [],
    diagnostics: [expect.objectContaining({ code: "BUILD1001" })],
  });
});
