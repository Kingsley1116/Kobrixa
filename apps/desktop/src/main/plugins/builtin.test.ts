import { readFile } from "node:fs/promises";
import { pluginManifestSchema } from "@kobrixa/plugin-protocol";
import { BASIC_PLUS_KEYWORDS, BASIC_PLUS_INDENTATION_RULES } from "@kobrixa/basic-plus/language";
import type {
  StaticLanguageTokenizerV1,
  StaticLanguageConfigurationV1,
} from "@kobrixa/plugin-protocol";

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
    ["kobrixa.device-ev3", "disabled"],
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

const repository = new URL("../../../../../", import.meta.url);
const readRepository = (file: string) => readFile(new URL(file, repository), "utf8");

it("declares bp without changing the builtin frontend or language service", () => {
  const source = BUILTIN_PLUGIN_SOURCES[0]!;
  expect(source.kind).toBe("builtin");
  if (source.kind !== "builtin") throw new Error("Expected bundled Basic Plus.");
  const manifest = pluginManifestSchema.parse(source.manifest);
  expect(manifest.id).toBe("kobrixa.basic-plus");
  expect(manifest.apiVersion).toBe("^1.4.0");
  expect(manifest.runtime).toEqual({ kind: "builtin" });
  expect(manifest.contributes?.languages).toEqual([
    {
      id: "bp",
      extensions: ["bp", "bpi", "bpm"],
      aliases: ["Basic Plus", "Basic+"],
      tokenizer: { version: 1, path: "language/tokenizer.json" },
      configuration: { version: 1, path: "language/configuration.json" },
    },
  ]);
  expect(manifest.contributes?.frontends).toEqual([
    {
      language: "bp",
      entryExtensions: ["bp"],
      sourceExtensions: ["bp", "bpi", "bpm"],
      ir: { min: 1, max: 1 },
    },
  ]);
  expect(manifest.contributes?.languageServices).toEqual([
    {
      language: "bp",
      extensions: ["bp", "bpi", "bpm"],
      capabilities: [
        "analysis",
        "completion",
        "quickFixes",
        "semanticTokens",
        "hover",
        "signatureHelp",
        "definition",
        "references",
        "rename",
        "documentSymbols",
        "documentFormatting",
        "rangeFormatting",
      ],
    },
  ]);
});

it("bundles exact UTF-8 resource text under the manifest's relative keys", async () => {
  const source = BUILTIN_PLUGIN_SOURCES[0]!;
  if (source.kind !== "builtin") throw new Error("Expected bundled Basic Plus.");
  expect(Object.keys(source.resources).sort()).toEqual([
    "language/configuration.json",
    "language/tokenizer.json",
  ]);
  for (const name of ["tokenizer", "configuration"] as const) {
    const resourcePath = `language/${name}.json`;
    const raw = await readRepository(`plugins/basic-plus/${resourcePath}`);
    const fixture = await readRepository(
      `packages/plugin-protocol/test-fixtures/static-languages/basic-plus/${name}.json`,
    );
    expect(source.resources[resourcePath]).toBe(raw);
    expect(Buffer.from(source.resources[resourcePath]!, "utf8")).toEqual(
      await readFile(new URL(`plugins/basic-plus/${resourcePath}`, repository)),
    );
    expect(JSON.parse(raw)).toEqual(JSON.parse(fixture));
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.charCodeAt(0)).not.toBe(0xfeff);
  }
  const ev3 = BUILTIN_PLUGIN_SOURCES[1]!;
  if (ev3.kind !== "builtin") throw new Error("Expected bundled EV3.");
  expect(ev3.resources).toEqual({});
});

it("keeps all keyword lists, nine ordered rules and the original configuration", async () => {
  const tokenizer = JSON.parse(
    await readRepository("plugins/basic-plus/language/tokenizer.json"),
  ) as StaticLanguageTokenizerV1;
  const configuration = JSON.parse(
    await readRepository("plugins/basic-plus/language/configuration.json"),
  ) as StaticLanguageConfigurationV1;
  expect(tokenizer.ignoreCase).toBe(true);
  expect(tokenizer.defaultToken).toBe("invalid");
  expect(tokenizer.tokenPostfix).toBe(".basic-plus");
  expect(tokenizer.states.map((state) => state.name)).toEqual(["root"]);
  expect(tokenizer.states[0]!.rules).toHaveLength(9);
  expect(tokenizer.lists).toEqual([
    { name: "keywords", words: [...BASIC_PLUS_KEYWORDS] },
    {
      name: "control",
      words: [
        "If",
        "Then",
        "Else",
        "ElseIf",
        "EndIf",
        "For",
        "To",
        "Step",
        "EndFor",
        "While",
        "EndWhile",
        "Break",
        "Continue",
        "Return",
        "Goto",
      ],
    },
    { name: "types", words: ["Number", "String"] },
    { name: "booleans", words: ["True", "False"] },
    { name: "word_operators", words: ["And", "Or", "Not"] },
  ]);
  for (const list of tokenizer.lists!)
    expect(new Set(list.words.map((word) => word.toLowerCase())).size).toBe(list.words.length);
  for (const rule of tokenizer.states[0]!.rules) {
    if (!("regex" in rule)) throw new Error("Basic Plus has no includes.");
    expect(rule.regex.flags).toBe("i");
  }
  const identifier = tokenizer.states[0]!.rules[4]!;
  if (!("regex" in identifier) || !("cases" in identifier.action))
    throw new Error("Expected ordered identifier cases.");
  expect(identifier.action.cases.map((branch) => branch.when)).toEqual([
    "@types",
    "@booleans",
    "@word_operators",
    "@control",
    "@keywords",
    "@default",
  ]);
  expect(configuration).toEqual({
    comments: { lineComment: "'" },
    brackets: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
    ],
    autoClosingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"', notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "(", close: ")" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
    indentationRules: Object.fromEntries(
      Object.entries(BASIC_PLUS_INDENTATION_RULES).map(([name, regex]) => [
        name,
        { pattern: regex.source, flags: regex.flags },
      ]),
    ),
  });
  expect(configuration).not.toHaveProperty("wordPattern");
  expect(configuration).not.toHaveProperty("onEnterRules");
  for (const name of ["increaseIndentPattern", "decreaseIndentPattern"] as const) {
    const data = configuration.indentationRules![name];
    const regex = new RegExp(data.pattern, data.flags);
    for (const line of [
      "If True Then",
      "\tELSEIF ready",
      "Else",
      "While ready",
      "For i = 1 To 2",
      "Sub Main()",
      "Function Double()",
      "Module Math",
      "EndIf",
      "EndWhile",
      "EndFor",
      "EndSub",
      "EndFunction",
      "EndModule",
      "If.member = 1",
      "ElseIf.member = 2",
      "WhileLoop = 1",
      "' If True Then",
      'caption = "If"',
    ])
      expect(regex.test(line), `${name}: ${line}`).toBe(
        BASIC_PLUS_INDENTATION_RULES[name].test(line),
      );
    expect(regex.test("If.member = 1")).toBe(false);
    expect(regex.test("Else.member = 1")).toBe(false);
  }
});

it("F01 F20 ships two required compilers and one optional provider-only source", async () => {
  const { BUILTIN_DEVICE_PROVIDER_FACTORIES } = await import("./builtin.js");
  expect(Object.keys(BUILTIN_DEVICE_PROVIDER_FACTORIES)).toEqual(["builtin:kobrixa.device-ev3"]);
  expect(
    BUILTIN_PLUGIN_SOURCES.map((source) =>
      source.kind === "builtin" ? source.policy : "development",
    ),
  ).toEqual(["required", "required", "optional"]);
  const optional = BUILTIN_PLUGIN_SOURCES[2]!;
  if (optional.kind !== "builtin") throw new Error("Expected provider-only builtin");
  expect(optional.launch).toBeUndefined();
  const parsed = pluginManifestSchema.parse(optional.manifest);
  expect(parsed.id).toBe("kobrixa.device-ev3");
  expect(parsed.runtime).toEqual({ kind: "builtin" });
  expect(parsed.contributes?.commands ?? []).toEqual([]);
  expect(parsed.contributes?.deviceProviders).toEqual([
    {
      id: "kobrixa.device-ev3",
      capabilities: [
        "connection.v1",
        "telemetry.v1",
        "inputModes.v1",
        "finiteMotion.v1",
        "recordingReservation.v1",
      ],
    },
  ]);
  const loaded = await loadPlugins(BUILTIN_PLUGIN_SOURCES, { disabled: new Set(), safeMode: true });
  expect(loaded.map((source) => [source.id, source.status])).toEqual([
    ["kobrixa.basic-plus", "enabled"],
    ["kobrixa.ev3", "enabled"],
    ["kobrixa.device-ev3", "disabled"],
  ]);
});

import { vi } from "vitest";
import { PluginManager } from "@kobrixa/plugin-runtime";
import { attachBuiltinDeviceProvider } from "./builtin.js";
import { createDeviceBroker } from "../device-broker/broker-port.js";
import {
  createFakeDeviceProvider,
  operationHarness,
  pluginPrincipal,
  ID,
} from "../device-broker/fake-provider.js";
import type { ProviderCatalogPort } from "../device-broker/provider.js";

async function providerHarness(safeMode = false, disabled = false) {
  const h = operationHarness();
  const broker = createDeviceBroker({
    journal: h.dependencies.journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: "local",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: { claim: () => false, isClaimed: () => false, complete() {} },
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  let disabledSources = new Set(disabled ? ["builtin:kobrixa.device-ev3"] : []);
  const manager = await PluginManager.create({
    sources: [BUILTIN_PLUGIN_SOURCES[2]!],
    locale: "en",
    safeMode,
    launcher: vi.fn(),
    store: {
      load: async () => ({ disabled: disabledSources, legacyDisabledIds: new Set() }),
      save: async (state) => {
        disabledSources = new Set(state.disabled);
      },
    },
  });
  const catalogs: ProviderCatalogPort[] = [];
  const factory = vi.fn((catalog: ProviderCatalogPort) => {
    catalogs.push(catalog);
    return createFakeDeviceProvider({ catalog, now: h.dependencies.now }).provider;
  });
  const allocate = vi.spyOn(broker, "providerCatalog");
  const register = vi.spyOn(broker, "registerProvider");
  const initial = broker.providerCatalog("kobrixa.device-ev3");
  const detach = attachBuiltinDeviceProvider(manager, broker, initial, factory);
  return {
    broker,
    manager,
    catalogs,
    factory,
    allocate,
    register,
    detach,
    initial,
    async close() {
      await broker.resources.beginShutdown();
      detach();
      await manager.shutdown();
    },
  };
}

it.each(["safe-mode", "disabled"])("F20 %s boot constructs no optional provider", async (mode) => {
  const h = await providerHarness(mode === "safe-mode", mode === "disabled");
  try {
    expect(h.factory).not.toHaveBeenCalled();
    expect(h.register).not.toHaveBeenCalled();
    if (mode === "safe-mode") expect(await h.manager.leaveSafeMode()).toMatchObject({ ok: true });
    else
      expect(await h.manager.setEnabled("builtin:kobrixa.device-ev3", true)).toMatchObject({
        ok: true,
      });
    expect(h.factory).toHaveBeenCalledExactlyOnceWith(h.initial);
    await h.manager.setEnabled("builtin:kobrixa.device-ev3", true);
    expect(h.register).toHaveBeenCalledOnce();
  } finally {
    await h.close();
  }
});

it("F01 F20 disable-enable and reload use fresh real-broker catalog generations", async () => {
  const h = await providerHarness();
  const principal = pluginPrincipal();
  const signal = new AbortController().signal;
  const connect = async () => {
    const result = await h.broker.request(
      principal,
      "devices/connect",
      {
        target: { kind: "wifi-address", providerId: "kobrixa.device-ev3", address: "127.0.0.1" },
      },
      signal,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value.session.sessionId;
  };
  const tuple = (sessionId: string) => ({
    sessionId,
    portId: "1",
    typeId: "7",
    modeId: "0",
    component: 0,
    unit: "deg",
  });
  try {
    expect(h.factory).toHaveBeenCalledOnce();
    const list = await h.broker.request(principal, "devices/list", {}, signal);
    expect(list).toMatchObject({ ok: true, value: { sessions: [] } });
    expect(() => h.initial.identify(tuple(ID))).toThrow();
    const first = await connect();
    const old = h.catalogs[0]!;
    const oldId = old.identify(tuple(first));
    expect(old.identify(tuple(first))).toBe(oldId);
    expect(() => old.identify(tuple(ID))).toThrow();
    for (const invalid of [
      { component: -1 },
      { unit: "x".repeat(129) },
      { portId: "!" },
      { typeId: "" },
      { modeId: "!" },
    ])
      expect(() => old.identify({ ...tuple(first), ...invalid })).toThrow();
    const session = await h.broker.request(
      principal,
      "devices/session",
      { sessionId: first },
      signal,
    );
    if (!session.ok) throw new Error(session.error.message);
    expect(
      await h.broker.request(
        principal,
        "devices/inputModes/set",
        {
          sessionId: first,
          portId: "1",
          expectedSourceRevision: session.value.sources.sourceRevision,
          modeId: "1",
          contextRef: ID,
        },
        signal,
      ),
    ).toMatchObject({ ok: true });
    expect(old.identify(tuple(first))).not.toBe(oldId);
    expect(await h.manager.setEnabled("builtin:kobrixa.device-ev3", false)).toMatchObject({
      ok: true,
    });
    expect(() => old.identify(tuple(first))).toThrow();
    expect(await h.manager.setEnabled("builtin:kobrixa.device-ev3", true)).toMatchObject({
      ok: true,
    });
    expect(h.factory).toHaveBeenCalledTimes(2);
    const second = await connect();
    expect(second).not.toBe(first);
    expect(h.catalogs[1]).not.toBe(old);
    expect(() => old.identify(tuple(second))).toThrow();
    expect(() => h.catalogs[1]!.identify(tuple(first))).toThrow();
    expect(h.catalogs[1]!.identify(tuple(second))).not.toBe(oldId);
    expect(await h.manager.reloadSource("builtin:kobrixa.device-ev3")).toMatchObject({ ok: true });
    expect(h.factory).toHaveBeenCalledTimes(3);
    expect(h.allocate).toHaveBeenCalledTimes(3);
    expect(new Set(h.catalogs).size).toBe(3);
    const third = await connect();
    expect(() => h.catalogs[1]!.identify(tuple(third))).toThrow();
    expect(h.catalogs[2]!.identify(tuple(third))).not.toBe(oldId);
  } finally {
    await h.close();
  }
});

it("F01 refuses a wrong allowlist factory identity and detaches the state listener", async () => {
  const h = await providerHarness(false, true);
  h.detach();
  const listeners = new Set<Parameters<PluginManager["onEvent"]>[0]>();
  const manager = {
    state: () => ({
      ...h.manager.state(),
      plugins: h.manager
        .state()
        .plugins.map((source) => ({ ...source, status: "enabled" as const })),
    }),
    onEvent: (listener: Parameters<PluginManager["onEvent"]>[0]) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  try {
    const wrong = createFakeDeviceProvider({ catalog: h.initial, now: () => 0 }).provider;
    Object.defineProperty(wrong, "id", { value: "foreign.provider" });
    expect(() => attachBuiltinDeviceProvider(manager, h.broker, h.initial, () => wrong)).toThrow(
      "wrong provider",
    );
    expect(listeners.size).toBe(0);
    expect(h.register).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});
