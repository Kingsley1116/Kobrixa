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
import { PluginManager, type PluginManagerOptions } from "@kobrixa/plugin-runtime";
import { memoryPlugin } from "../../../../../packages/plugin-runtime/src/test-process.js";
import { attachBuiltinDeviceProvider } from "./builtin.js";
import { createDeviceBroker } from "../device-broker/broker-port.js";
import {
  createFakeDeviceProvider,
  operationHarness,
  pluginPrincipal,
  ID,
} from "../device-broker/fake-provider.js";
import type { ProviderCatalogPort } from "../device-broker/provider.js";

async function providerHarness(
  safeMode = false,
  disabled = false,
  options: Partial<PluginManagerOptions> = {},
) {
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
    ...options,
  });
  const catalogs: ProviderCatalogPort[] = [];
  const providers: ReturnType<typeof createFakeDeviceProvider>[] = [];
  const factory = vi.fn((catalog: ProviderCatalogPort) => {
    catalogs.push(catalog);
    const fake = createFakeDeviceProvider({ catalog, now: h.dependencies.now });
    providers.push(fake);
    return fake.provider;
  });
  const allocate = vi.spyOn(broker, "providerCatalog");
  const removals: ReturnType<typeof vi.fn>[] = [];
  const registerProvider = broker.registerProvider.bind(broker);
  const register = vi.spyOn(broker, "registerProvider").mockImplementation((provider) => {
    const registration = registerProvider(provider);
    const remove = vi.fn(registration.retirement!.retire);
    removals.push(remove);
    return Object.assign(registration, {
      retirement: { ...registration.retirement!, retire: remove },
    });
  });
  const initial = broker.providerCatalog("kobrixa.device-ev3");
  const detach = attachBuiltinDeviceProvider(manager, broker, initial, factory);
  return {
    broker,
    manager,
    providers,
    catalogs,
    factory,
    allocate,
    register,
    removals,
    detach,
    initial,
    async close() {
      await broker.resources.beginShutdown();
      await detach();
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
    await h.detach.settled();
    expect(h.factory).toHaveBeenCalledTimes(2);
    const second = await connect();
    expect(second).not.toBe(first);
    expect(h.catalogs[1]).not.toBe(old);
    expect(() => old.identify(tuple(second))).toThrow();
    expect(() => h.catalogs[1]!.identify(tuple(first))).toThrow();
    expect(h.catalogs[1]!.identify(tuple(second))).not.toBe(oldId);
    expect(await h.manager.reloadSource("builtin:kobrixa.device-ev3")).toMatchObject({ ok: true });
    await h.detach.settled();
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
    builtinSourceEligibility: () =>
      h.manager.builtinSourceEligibility().map((source) => ({ ...source, eligible: true })),
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

it("K160 preserves required compiler sources and never fabricates future feature processes", () => {
  for (const id of ["kobrixa.basic-plus", "kobrixa.ev3"]) {
    const source = BUILTIN_PLUGIN_SOURCES.find(
      (item) => item.kind === "builtin" && pluginManifestSchema.parse(item.manifest).id === id,
    );
    expect(source).toMatchObject({ kind: "builtin", policy: "required" });
  }
  expect(
    BUILTIN_PLUGIN_SOURCES.filter((source) => source.kind === "builtin" && source.launch),
  ).toEqual([]);
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("host eligibility keeps one provider across the real supervisor's idle, starting, running and failed UI", async () => {
  const source = executableProviderSource();
  const initialized = gate();
  let crash!: () => void;
  const launch = vi.fn(
    async () =>
      memoryPlugin((peer, control) => {
        crash = () => control.exit(1);
        peer.handle("initialize", async () => {
          await initialized.promise;
          return { apiVersion: "1.0.0", sdk: { name: "fixture", version: "1" } };
        });
        peer.handle("command/execute", () => null);
        peer.handle("shutdown", () => null);
        peer.onNotification("exit", () => control.exit());
      }).process,
  );
  const h = await providerHarness(false, false, {
    sources: [source],
    launcher: launch,
    supervisor: { restartLimit: 1 },
  });
  const key = source.launch!.sourceKey;
  try {
    const admitted = h.manager.builtinSourceEligibility();
    expect(admitted[0]).toMatchObject({ eligible: true, cleanupPending: false });
    expect(launch).not.toHaveBeenCalled();
    const command = h.manager.executeCommand("kobrixa.device-ev3.run");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(h.manager.builtinSourceEligibility()).toEqual(admitted);
    expect(h.factory).toHaveBeenCalledOnce();
    initialized.resolve();
    expect(await command).toEqual({ ok: true });
    expect(h.manager.state().plugins[0]?.running).toBe(true);
    crash();
    await vi.waitFor(() => expect(h.manager.state().plugins[0]?.status).toBe("failed"));
    expect(h.manager.builtinSourceEligibility()).toEqual(admitted);
    expect(h.factory).toHaveBeenCalledOnce();
    expect(h.allocate).toHaveBeenCalledOnce();
    expect(h.removals[0]).not.toHaveBeenCalled();
    await h.manager.reloadSource(key);
    await h.detach.settled();
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(h.catalogs[1]).not.toBe(h.catalogs[0]);
    // Metadata replacement discovered by a normal reconciliation must also renew once.
    source.manifest = {
      ...pluginManifestSchema.parse(source.manifest),
      permissions: ["ui.notifications"],
    };
    await h.manager.setEnabled(key, true);
    await h.detach.settled();
    expect(h.factory).toHaveBeenCalledTimes(3);
    expect(h.register).toHaveBeenCalledTimes(3);
    await h.manager.setEnabled(key, false);
    await h.manager.setEnabled(key, true);
    await h.detach.settled();
    expect(h.factory).toHaveBeenCalledTimes(4);
    expect(new Set(h.catalogs).size).toBe(4);
    expect(h.removals.slice(0, 3).every((remove) => remove.mock.calls.length === 1)).toBe(true);
    await h.manager.shutdown();
    expect(h.manager.builtinSourceEligibility()[0]?.eligible).toBe(false);
    expect(h.removals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
  } finally {
    initialized.resolve();
    await h.close();
  }
});

function executableProviderSource() {
  const source = structuredClone(BUILTIN_PLUGIN_SOURCES[2]!);
  if (source.kind !== "builtin") throw new Error("Expected builtin");
  const manifest = pluginManifestSchema.parse(source.manifest);
  source.manifest = {
    ...manifest,
    runtime: { kind: "node", entry: "main.cjs" },
    contributes: {
      ...manifest.contributes,
      commands: [{ id: "kobrixa.device-ev3.run", title: { en: "Run" } }],
    },
  };
  source.launch = {
    sourceKey: "builtin:kobrixa.device-ev3",
    pluginId: "kobrixa.device-ev3",
    policy: "optional",
    runtime: "node",
    packageRoot: "/synthetic",
    entry: "main.cjs",
    manifest: "kobrixa-plugin.json",
    resourceIndex: "resource-index.json",
  };
  return source;
}

it("host bridge retains the provider until process retirement and failed disable save both settle", async () => {
  const source = executableProviderSource();
  const save = gate();
  const stop = gate();
  const stopping = vi.fn();
  const h = await providerHarness(false, false, {
    sources: [source],
    store: {
      load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
      save: async () => {
        await save.promise;
        throw new Error("disk full");
      },
    },
    launcher: async () =>
      memoryPlugin((peer, { exit }) => {
        peer.handle("initialize", () => ({
          apiVersion: "1.0.0",
          sdk: { name: "fixture", version: "1" },
        }));
        peer.handle("command/execute", () => null);
        peer.handle("shutdown", async () => {
          stopping();
          await stop.promise;
          return null;
        });
        peer.onNotification("exit", () => exit());
      }).process,
  });
  try {
    await h.manager.executeCommand("kobrixa.device-ev3.run");
    const disabling = h.manager.setEnabled(source.launch!.sourceKey, false);
    await vi.waitFor(() => expect(stopping).toHaveBeenCalledOnce());
    expect(h.removals[0]).not.toHaveBeenCalled();
    stop.resolve();
    await vi.waitFor(() => expect(h.manager.active).toBe(false));
    expect(h.removals[0]).not.toHaveBeenCalled();
    save.resolve();
    expect(await disabling).toMatchObject({ ok: true, persisted: false });
    expect(h.removals[0]).toHaveBeenCalledOnce();
    expect(await h.manager.setEnabled(source.launch!.sourceKey, true)).toMatchObject({ ok: false });
    expect(h.factory).toHaveBeenCalledOnce();
  } finally {
    stop.resolve();
    save.resolve();
    await h.close();
  }
});

it.each(["missing", "foreign", "invalid"] as const)(
  "host bridge refuses %s provider declarations",
  async (kind) => {
    const source = structuredClone(BUILTIN_PLUGIN_SOURCES[2]!);
    if (source.kind !== "builtin") throw new Error("Expected builtin");
    const manifest = pluginManifestSchema.parse(source.manifest);
    source.manifest = {
      ...manifest,
      ...(kind === "invalid" ? { apiVersion: "^999.0.0" } : {}),
      contributes: {
        deviceProviders:
          kind === "missing"
            ? []
            : [
                {
                  id: kind === "foreign" ? "foreign.provider" : "kobrixa.device-ev3",
                  capabilities: ["connection.v1"],
                },
              ],
      },
    };
    const h = await providerHarness(false, false, { sources: [source] });
    try {
      expect(h.factory).not.toHaveBeenCalled();
      expect(h.register).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  },
);

it("host bridge fails closed when the legacy facade lacks source admission", async () => {
  const h = await providerHarness(false, true);
  try {
    expect(() =>
      attachBuiltinDeviceProvider(
        // @ts-expect-error The host facade must provide admission, even before attachment.
        { onEvent: h.manager.onEvent.bind(h.manager) },
        h.broker,
        h.initial,
        h.factory,
      ),
    ).toThrow("host source eligibility");
    expect(h.factory).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it.each(["disable", "shutdown"] as const)(
  "provider bridge recovers after %s timeout and late process exit",
  async (action) => {
    let exit!: () => void;
    const child = memoryPlugin((peer, control) => {
      exit = control.exit;
      peer.handle("initialize", () => ({
        apiVersion: "1.0.0",
        sdk: { name: "fixture", version: "1" },
      }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => new Promise(() => {}));
    });
    const h = await providerHarness(false, false, {
      sources: [executableProviderSource()],
      launcher: async () => ({ ...child.process, kill() {}, forceKill() {} }),
      supervisor: { stopTimeoutMs: 5, exitTimeoutMs: 10 },
    });
    const key = "builtin:kobrixa.device-ev3";
    try {
      expect(await h.manager.executeCommand("kobrixa.device-ev3.run")).toEqual({ ok: true });
      await expect(
        action === "disable" ? h.manager.setEnabled(key, false) : h.manager.shutdown(),
      ).rejects.toThrow("exit is not confirmed");
      expect(h.removals[0]).not.toHaveBeenCalled();
      expect(h.factory).toHaveBeenCalledOnce();
      exit();
      await Promise.resolve();
      expect(h.manager.builtinSourceEligibility()[0]?.cleanupPending).toBe(true);
      if (action === "shutdown") await h.manager.resume();
      // A successful disable after recovery must withdraw the retained instance exactly once.
      expect(await h.manager.setEnabled(key, false)).toMatchObject({ ok: true });
      expect(h.removals[0]).toHaveBeenCalledOnce();
      expect(await h.manager.setEnabled(key, true)).toMatchObject({ ok: true });
      await h.detach.settled();
      expect(h.factory).toHaveBeenCalledTimes(2);
      expect(h.register).toHaveBeenCalledTimes(2);
      expect(h.catalogs[1]).not.toBe(h.catalogs[0]);
      await h.manager.shutdown();
      expect(h.removals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    } finally {
      exit();
      await h.close();
    }
  },
);

it.each(["disable", "reload", "reload-interleaved"] as const)(
  "multi-builtin metadata replacement recovers through %s without publishing a stale provider generation",
  async (retry) => {
    const source = executableProviderSource();
    const other = structuredClone(BUILTIN_PLUGIN_SOURCES[0]!);
    if (other.kind !== "builtin") throw new Error("Expected builtin");
    if (retry === "reload-interleaved") other.policy = "optional";
    let exit!: () => void;
    const child = memoryPlugin((peer, control) => {
      exit = control.exit;
      peer.handle("initialize", () => ({ apiVersion: "1.0.0", sdk: { name: "t", version: "1" } }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => new Promise(() => {}));
    });
    const h = await providerHarness(false, false, {
      sources: [source, other],
      launcher: async () => ({ ...child.process, kill() {}, forceKill() {} }),
      supervisor: { stopTimeoutMs: 5, exitTimeoutMs: 10 },
    });
    const key = source.launch!.sourceKey;
    const row = () => h.manager.builtinSourceEligibility().find((item) => item.sourceKey === key)!;
    const originalGeneration = row().generation;
    const admitted: number[] = [];
    const unsubscribe = h.manager.onEvent(() => {
      if (row().eligible) admitted.push(row().generation);
    });
    try {
      expect(await h.manager.executeCommand("kobrixa.device-ev3.run")).toEqual({ ok: true });
      const manifest = pluginManifestSchema.parse(source.manifest);
      manifest.contributes!.commands![0]!.title = { en: "Changed executable metadata" };
      source.manifest = manifest;
      await expect(h.manager.setEnabled(key, true)).rejects.toThrow("exit is not confirmed");
      expect(row().generation).toBe(originalGeneration + 1);
      expect(h.manager.builtinSourceEligibility()).toHaveLength(2);
      expect(h.manager.builtinSourceEligibility().every((item) => item.cleanupPending)).toBe(true);
      expect(h.removals[0]).not.toHaveBeenCalled();
      expect(h.factory).toHaveBeenCalledOnce();
      admitted.length = 0;
      if (retry !== "reload-interleaved") {
        await expect(
          retry === "disable" ? h.manager.setEnabled(key, false) : h.manager.reloadSource(key),
        ).rejects.toThrow("exit is not confirmed");
      }
      expect(admitted).toEqual([]);
      exit();
      await Promise.resolve();
      expect(h.manager.builtinSourceEligibility().every((item) => item.cleanupPending)).toBe(true);
      expect(h.factory).toHaveBeenCalledOnce();
      let independent: Promise<unknown> | undefined;
      const stopInterleaving = h.manager.onEvent((event) => {
        if (
          retry === "reload-interleaved" &&
          !independent &&
          event.type === "state" &&
          event.state.plugins.find((plugin) => plugin.sourceKey === key)?.status === "disabled"
        ) {
          // Unsubscribe before the synchronous disable publishes its nested state event.
          stopInterleaving();
          independent = h.manager.setEnabled("builtin:kobrixa.basic-plus", false);
        }
      });
      expect(
        await (retry === "disable"
          ? h.manager.setEnabled(key, false)
          : h.manager.reloadSource(key)),
      ).toMatchObject({ ok: true });
      stopInterleaving();
      if (retry === "reload-interleaved") expect(independent).toBeDefined();
      if (independent) expect(await independent).toMatchObject({ ok: true });
      expect(h.manager.builtinSourceEligibility().every((item) => !item.cleanupPending)).toBe(true);
      expect(h.removals[0]).toHaveBeenCalledOnce();
      if (retry === "disable") {
        expect(admitted).toEqual([]);
        expect(h.factory).toHaveBeenCalledOnce();
        expect(await h.manager.setEnabled(key, true)).toMatchObject({ ok: true });
      }
      expect(row()).toMatchObject({ eligible: true, cleanupPending: false });
      expect(admitted.length).toBeGreaterThan(0);
      expect(new Set(admitted)).toEqual(new Set([row().generation]));
      expect(row().generation).toBe(originalGeneration + (retry === "disable" ? 1 : 2));
      await h.detach.settled();
      expect(h.factory).toHaveBeenCalledTimes(2);
      expect(await h.manager.reloadSource(key)).toMatchObject({ ok: true });
      await h.detach.settled();
      expect(h.factory).toHaveBeenCalledTimes(3);
      expect(new Set(h.catalogs).size).toBe(3);
      await h.manager.shutdown();
      expect(
        h.manager
          .builtinSourceEligibility()
          .every((item) => !item.cleanupPending && !item.eligible),
      ).toBe(true);
      expect(h.removals.every((remove) => remove.mock.calls.length === 1)).toBe(true);
    } finally {
      unsubscribe();
      exit();
      await h.close();
    }
  },
);

async function connectBridge(h: Awaited<ReturnType<typeof providerHarness>>) {
  const connected = await h.broker.request(
    pluginPrincipal(),
    "devices/connect",
    {
      target: { kind: "wifi-address", providerId: "kobrixa.device-ev3", address: "127.0.0.1" },
    },
    new AbortController().signal,
  );
  if (!connected.ok) throw new Error(connected.error.message);
  return connected.value.session.sessionId;
}

it.each([false, true])(
  "awaited bridge coalesces toggles/reloads; detach=%s prevents replacement",
  async (detach) => {
    const h = await providerHarness();
    const release = gate();
    const entered = gate();
    const old = h.providers[0]!.provider;
    const disconnect = old.disconnect.bind(old);
    old.disconnect = async (key, ctx) => {
      entered.resolve();
      await release.promise;
      return disconnect(key, ctx);
    };
    try {
      const sessionId = await connectBridge(h);
      const key = "builtin:kobrixa.device-ev3";
      const disable = h.manager.setEnabled(key, false);
      // The manager hold fences the healthy consumer immediately without retiring it.
      expect(
        await h.broker.request(
          pluginPrincipal(),
          "devices/read",
          { sessionId, channelIds: [ID], freshness: "cached" },
          new AbortController().signal,
        ),
      ).toMatchObject({ ok: false });
      await disable;
      await entered.promise;
      for (let i = 0; i < 3; i++) {
        await h.manager.setEnabled(key, true);
        await h.manager.reloadSource(key);
        await h.manager.setEnabled(key, false);
      }
      await h.manager.setEnabled(key, true);
      expect(h.factory).toHaveBeenCalledOnce();
      expect(() => h.broker.registerProvider(old)).toThrow("retirement is pending");
      let done = false;
      const settled = (detach ? h.detach() : h.detach.settled()).then(() => {
        done = true;
      });
      await Promise.resolve();
      expect(done).toBe(false);
      expect(
        await h.broker.request(
          pluginPrincipal(),
          "devices/discover",
          { providerId: old.id },
          new AbortController().signal,
        ),
      ).toMatchObject({ ok: false });
      release.resolve();
      await settled;
      expect(h.factory).toHaveBeenCalledTimes(detach ? 1 : 2);
      expect(h.register.mock.results.filter((result) => result.type === "return")).toHaveLength(
        detach ? 1 : 2,
      );
      expect(h.removals[0]).toHaveBeenCalledOnce();
      if (!detach) expect(await connectBridge(h)).not.toBe(sessionId);
    } finally {
      release.resolve();
      await h.close();
    }
  },
);

it("bridge retains disposal rejection and retries the old registration before admitting the desired generation", async () => {
  const h = await providerHarness();
  const original = h.providers[0]!.provider.dispose.bind(h.providers[0]!.provider);
  const failure = new Error("native dispose failed");
  let fail = true;
  h.providers[0]!.provider.dispose = async (ctx) => {
    if (fail) throw failure;
    await original(ctx);
  };
  try {
    await connectBridge(h);
    await h.manager.reloadSource("builtin:kobrixa.device-ev3");
    await expect(h.detach.settled()).rejects.toBe(failure);
    expect(h.factory).toHaveBeenCalledOnce();
    await expect(h.detach.retry()).rejects.toBe(failure);
    expect(h.factory).toHaveBeenCalledOnce();
    fail = false;
    // Desired-state publications cannot implicitly erase a failed retirement.
    await h.manager.setEnabled("builtin:kobrixa.device-ev3", false);
    await h.manager.setEnabled("builtin:kobrixa.device-ev3", true);
    await expect(h.detach.settled()).rejects.toBe(failure);
    expect(h.factory).toHaveBeenCalledOnce();
    await h.detach.retry();
    expect(h.factory).toHaveBeenCalledTimes(2);
    expect(await connectBridge(h)).toBeTypeOf("string");
  } finally {
    fail = false;
    await h.close();
  }
});

it("initial factory exceptions remain synchronous and remove the manager listener", async () => {
  const h = await providerHarness(false, true);
  await h.detach();
  const listeners = new Set<Parameters<PluginManager["onEvent"]>[0]>();
  const error = new Error("factory initialization failed");
  const manager = {
    builtinSourceEligibility: () =>
      h.manager.builtinSourceEligibility().map((row) => ({ ...row, eligible: true })),
    onEvent(listener: Parameters<PluginManager["onEvent"]>[0]) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  try {
    expect(() =>
      attachBuiltinDeviceProvider(manager, h.broker, h.initial, () => {
        throw error;
      }),
    ).toThrow(error);
    expect(listeners.size).toBe(0);
    expect(h.register).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

it("a replacement factory failure retains its allocator for explicit retry", async () => {
  const h = await providerHarness();
  const failure = new Error("replacement factory failed");
  try {
    h.factory.mockImplementationOnce(() => {
      throw failure;
    });
    await h.manager.reloadSource("builtin:kobrixa.device-ev3");
    await expect(h.detach.settled()).rejects.toBe(failure);
    expect(h.register).toHaveBeenCalledOnce();
    expect(h.allocate).toHaveBeenCalledTimes(2);
    await h.detach.retry();
    expect(h.register).toHaveBeenCalledTimes(2);
    expect(h.allocate).toHaveBeenCalledTimes(2);
    expect(await connectBridge(h)).toBeTypeOf("string");
  } finally {
    await h.close();
  }
});
