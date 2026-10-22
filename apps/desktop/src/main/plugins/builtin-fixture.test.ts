import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import {
  pluginManifestSchema,
  validateUiResource,
  validateUiData,
  resourceFailure,
  uiFailure,
} from "@kobrixa/plugin-protocol";
import type {
  PluginContext,
  PluginDefinition,
} from "../../../../../packages/plugin-sdk-js/src/index.js";

const fixtures = new URL("../../../../../tests/desktop/fixtures/", import.meta.url);
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
async function consumer() {
  vi.useFakeTimers();
  let definition!: PluginDefinition;
  const source = await readFile(new URL("declarative-ui/consumer.ts", fixtures), "utf8");
  const log = vi.fn();
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports: {},
      setTimeout,
      clearTimeout,
      performance,
      console: { error: log },
      require(name: string) {
        expect(name).toBe("@kobrixa/plugin-sdk");
        return {
          definePlugin: (value: PluginDefinition) => value,
          runPlugin: (value: PluginDefinition) => {
            definition = value;
          },
        };
      },
    },
  );
  const raw = await readFile(new URL("builtin-process/panel.json", fixtures), "utf8");
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(new URL("builtin-process/kobrixa-plugin.json", fixtures), "utf8")),
  );
  const parsed = validateUiResource(
    JSON.parse(raw),
    {
      pluginId: manifest.id,
      commands: (manifest.contributes?.commands ?? []).filter(
        (command) => command.invocation === "context-v1",
      ),
      panels: manifest.contributes?.panels ?? [],
    },
    Buffer.byteLength(raw),
  );
  if (!parsed.ok) throw new Error(parsed.error.code);
  const resource = parsed.value;
  let data = Object.fromEntries(
    Object.entries(resource.data).map(([key, value]) => [key, value.initial]),
  );
  let revision = 0;
  const binding = { kind: "panel" };
  const ui = {
    instances: vi.fn(async () => ({ ok: true, value: { instances: [binding] } })),
    state: vi.fn(async () => ({ ok: true, value: { revision } })),
    patch: vi.fn(async (_binding: unknown, base: number, set: typeof data) => {
      expect(base).toBe(revision);
      const validated = validateUiData(resource, { ...data, ...set });
      if (!validated.ok) return validated;
      data = validated.value;
      return { ok: true as const, value: { revision: ++revision } };
    }),
  };
  return {
    definition,
    ui,
    context: { ui } as unknown as PluginContext,
    snapshot: () => ({ data, revision }),
    log,
  };
}
it("installed fixture ready telemetry satisfies its actual resource contract and stops on deactivate", async () => {
  const h = await consumer();
  await h.definition.ready!(h.context);
  expect(h.snapshot()).toEqual({ data: { ticks: "tick:1" }, revision: 1 });
  await h.definition.deactivate!();
  await vi.advanceTimersByTimeAsync(500);
  expect(h.ui.patch).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("fails ready on an unexpected patch rejection", async () => {
  const h = await consumer();
  h.ui.patch.mockResolvedValueOnce(uiFailure("reference"));
  await expect(h.definition.ready!(h.context)).rejects.toThrow("PLUGIN_E_UI_RESOURCE");
  expect(vi.getTimerCount()).toBe(0);
});
it("reports and stops an unexpected background patch failure", async () => {
  const h = await consumer();
  await h.definition.ready!(h.context);
  h.ui.patch.mockResolvedValueOnce(uiFailure("reference"));
  await vi.advanceTimersByTimeAsync(500);
  expect(h.log).toHaveBeenCalledExactlyOnceWith("PLUGIN_E_UI_RESOURCE");
  expect(h.ui.patch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it("stops quietly on stale binding retirement", async () => {
  const h = await consumer();
  h.ui.patch.mockResolvedValueOnce(resourceFailure("stale"));
  await h.definition.ready!(h.context);
  expect(vi.getTimerCount()).toBe(0);
  expect(h.log).not.toHaveBeenCalled();
});
it("does not issue a patch or reschedule after deactivation during state lookup", async () => {
  const h = await consumer();
  h.ui.state.mockImplementationOnce(async () => {
    await h.definition.deactivate!();
    return { ok: true, value: { revision: 0 } };
  });
  await h.definition.ready!(h.context);
  expect(h.ui.patch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("Python consumer checks actual installed data schema, unexpected failure, and stale retirement", () => {
  const output = execFileSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import asyncio, json, runpy, sys
from types import SimpleNamespace
import kobrixa
from kobrixa._ui import accepts
class Plugin:
    def command(self, *_): return lambda f: f
    def context_command(self, *_): return lambda f: f
    def ready(self, f): return f
    def deactivate(self, f): return f
    def run(self): pass
kobrixa.Plugin = Plugin
panel = json.load(open(sys.argv[2]))
async def scenario(error=None):
    ns = runpy.run_path(sys.argv[1])
    revision = 0
    data = {key: slot['initial'] for key, slot in panel['data'].items()}
    async def instances(): return {'ok': True, 'value': {'instances': [{}]}}
    async def state(_): return {'ok': True, 'value': {'revision': revision}}
    async def patch(binding, base, values):
        nonlocal revision
        assert base == revision
        if error: return {'ok': False, 'error': {'code': error}}
        assert all(key in panel['data'] and accepts(panel['data'][key]['schema'], value) for key, value in values.items())
        data.update(values)
        revision += 1
        return {'ok': True, 'value': {'revision': revision}}
    ctx = SimpleNamespace(ui=SimpleNamespace(instances=instances, state=state, patch=patch))
    if error == 'PLUGIN_E_UI_RESOURCE':
        try: await ns['ready'](ctx)
        except RuntimeError as exc: assert str(exc) == error
        else: raise AssertionError('unexpected patch error was ignored')
    else:
        await ns['ready'](ctx)
        if error is None: assert data['ticks'] == 'tick:1' and revision == 1
        else: assert ns['ready'].__globals__['stopped'] is True
    await ns['deactivate']()
    assert ns['ready'].__globals__['stopped'] is True
    return revision
async def main():
    assert await scenario() == 1
    assert await scenario('PLUGIN_E_UI_RESOURCE') == 0
    assert await scenario('PLUGIN_E_STALE_RESOURCE') == 0
    print('3 Python fixture scenarios passed')
asyncio.run(main())
`,
      fileURLToPath(new URL("declarative-ui/consumer.py", fixtures)),
      fileURLToPath(new URL("builtin-process/panel.json", fixtures)),
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PYTHONPATH: fileURLToPath(new URL("../../../../../sdks/python", import.meta.url)),
        PYTHONDONTWRITEBYTECODE: "1",
      },
    },
  );
  expect(output.trim()).toBe("3 Python fixture scenarios passed");
});
