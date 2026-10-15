import { expect, it, vi } from "vitest";
import {
  PluginManager,
  readSource,
  resolvePlugins,
  resolveCompilerProviders,
  type PluginSource,
  type ReadPlugin,
} from "./index.js";

const front = {
  language: "test",
  entryExtensions: ["test"],
  sourceExtensions: ["test", "inc"],
  ir: { min: 1, max: 3 },
};
const back = { target: "test-vm", ir: { min: 2, max: 4 }, capabilities: {}, artifacts: [] };
const source = (id: string, contributes: unknown): PluginSource => ({
  kind: "builtin",
  manifest: {
    id,
    version: "1.0.0",
    apiVersion: "^1.1.0",
    runtime: { kind: "builtin" },
    contributes,
  },
});
const sources = [
  source("test.front", { frontends: [front] }),
  source("test.back", { backends: [back] }),
];
async function reads(values = sources): Promise<ReadPlugin[]> {
  return Promise.all(values.map((value) => readSource(value, { safeMode: false })));
}
const options = { disabled: new Set<string>(), safeMode: false };
it("chooses the largest IR intersection and returns an immutable snapshot", async () => {
  const launcher = vi.fn();
  const manager = await PluginManager.create({
    sources,
    safeMode: true,
    launcher,
    locale: "en",
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {},
    },
  });
  const result = manager.resolveCompiler("test", "test-vm");
  expect(result).toMatchObject({
    ok: true,
    ir: 3,
    frontend: { pluginId: "test.front", sourceKey: "builtin:test.front" },
    backend: { pluginId: "test.back" },
  });
  if (!result.ok) throw new Error(result.message);
  result.frontend.contribution.sourceExtensions.push("mutated");
  const again = manager.resolveCompiler("test", "test-vm");
  if (!again.ok) throw new Error(again.message);
  expect(again.frontend.contribution.sourceExtensions).toEqual(["test", "inc"]);
  expect(launcher).not.toHaveBeenCalled();
  await manager.shutdown();
});
it.each(["frontend", "backend"] as const)(
  "invalidates every conflicting %s provider and restores the remaining enabled provider",
  async (kind) => {
    const extra = source(
      "test.extra",
      kind === "frontend" ? { frontends: [front] } : { backends: [back] },
    );
    const input = await reads([...sources, extra]);
    const result = resolvePlugins(input, options);
    const conflicted = result.filter((plugin) =>
      plugin.problems.some((problem) => problem.code === "PLUGIN_E_PROVIDER_CONFLICT"),
    );
    expect(conflicted.map((plugin) => plugin.id).sort()).toEqual(
      [kind === "frontend" ? "test.front" : "test.back", "test.extra"].sort(),
    );
    expect(conflicted.every((plugin) => plugin.status === "invalid")).toBe(true);
    expect(resolveCompilerProviders(result, "test", "test-vm")).toMatchObject({
      ok: false,
      code: "BUILD1001",
    });
    // 僅測試用的來源資料：停用集合經 registry 重算後，不能保留上輪衝突。
    // 正式 readSource 仍會拒絕 development 編譯器；本測試不新增生產註冊入口。
    const testInput = input.map((plugin) => ({ ...plugin, source: "development" as const }));
    const restored = resolvePlugins(testInput, {
      ...options,
      disabled: new Set([input[2]!.sourceKey]),
    });
    expect(restored[2]).toMatchObject({ status: "disabled", disabledBy: "user" });
    expect(resolveCompilerProviders(restored, "test", "test-vm")).toMatchObject({
      ok: true,
      ir: 3,
    });
  },
);
it("rejects missing providers and an empty IR intersection", async () => {
  const registered = resolvePlugins(await reads(), options);
  expect(resolveCompilerProviders(registered, "missing", "test-vm")).toMatchObject({
    ok: false,
    code: "BUILD1001",
  });
  const incompatible = await reads([
    sources[0]!,
    source("test.back", { backends: [{ ...back, ir: { min: 4, max: 5 } }] }),
  ]);
  expect(
    resolveCompilerProviders(resolvePlugins(incompatible, options), "test", "test-vm"),
  ).toMatchObject({ ok: false, code: "BUILD1002" });
});
it("keeps API 1.0 command plugins compatible", async () => {
  const item = await readSource(
    {
      kind: "builtin",
      manifest: {
        id: "test.old",
        version: "1.0.0",
        apiVersion: "^1.0.0",
        runtime: { kind: "builtin" },
        contributes: { commands: [{ id: "test.old.run", title: "Run" }] },
      },
    },
    { safeMode: false },
  );
  expect(item.problems).toEqual([]);
});

it("reports the exact resolver messages", async () => {
  const registered = resolvePlugins(await reads(), options);
  expect(resolveCompilerProviders(registered, "missing", "test-vm")).toEqual({
    ok: false,
    code: "BUILD1001",
    message: "No enabled language/target provider: missing/test-vm",
  });
  const incompatible = resolvePlugins(
    await reads([
      sources[0]!,
      source("test.back", { backends: [{ ...back, ir: { min: 4, max: 5 } }] }),
    ]),
    options,
  );
  expect(resolveCompilerProviders(incompatible, "test", "test-vm")).toEqual({
    ok: false,
    code: "BUILD1002",
    message: "The frontend's IR versions are incompatible with the target.",
  });
});

it("invalidates overlapping conflict groups without changing source problems", async () => {
  const input = await reads([
    ...sources,
    source("test.extra", { frontends: [front], backends: [back] }),
  ]);
  const registered = resolvePlugins(input, options);
  expect(registered.map((plugin) => plugin.status)).toEqual(["invalid", "invalid", "invalid"]);
  expect(registered.map((plugin) => plugin.problems.length)).toEqual([1, 1, 2]);
  expect(input.map((plugin) => plugin.problems)).toEqual([[], [], []]);
  expect(
    resolveCompilerProviders(resolvePlugins(input.slice(0, 2), options), "test", "test-vm"),
  ).toMatchObject({ ok: true, ir: 3 });
});

it("keeps temporary frontend lookup independent of a backend and rejects conflicts", async () => {
  const create = (values: PluginSource[]) =>
    PluginManager.create({
      sources: values,
      safeMode: false,
      launcher: vi.fn(),
      locale: "en",
      store: {
        load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
        save: async () => {},
      },
    });
  const manager = await create([sources[0]!]);
  expect(manager.frontendFor("test")).toBe("test.front");
  expect(manager.frontendFor("missing")).toBeUndefined();
  await manager.shutdown();
  const conflicted = await create([sources[0]!, source("test.extra", { frontends: [front] })]);
  expect(conflicted.frontendFor("test")).toBeUndefined();
  await conflicted.shutdown();
});
