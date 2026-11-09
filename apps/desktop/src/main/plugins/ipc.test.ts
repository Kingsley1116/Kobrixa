import { expect, it, vi } from "vitest";
import type { IpcHandle } from "../ipc.js";
import { registerPluginIpc, type PluginIpcTarget } from "./ipc.js";

import { emptyStaticLanguagesCatalog } from "@kobrixa/plugin-runtime";
import type { ReportLanguageRegistrationFailureInput } from "../../shared/static-languages.js";
import { registerIpc } from "../ipc.js";

const electronHandlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, action: (event: unknown, ...args: unknown[]) => unknown) =>
      electronHandlers.set(channel, action),
  },
}));

const key = "dev:0123456789abcdef";
function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const handle = ((channel, action) => handlers.set(channel, action as never)) as IpcHandle;
  const ok = async () => ({ ok: true }) as never;
  const plugins = {
    state: vi.fn(() => ({
      revision: 0,
      diagnosticHelpRevision: 0,
      staticLanguagesRevision: 7,
      staticLanguageOwners: [],
      safeMode: false,
      developmentMode: false,
      plugins: [],
      developer: { enabled: false, commandLine: false, linkedCount: 0 },
      origins: {},
      python: { pendingReload: [] },
      inflight: [],
    })),
    diagnosticHelp: vi.fn(() => ({ revision: 0, plugins: {} })),
    staticLanguages: vi.fn(() => emptyStaticLanguagesCatalog(7)),
    reportLanguageRegistrationFailure: vi.fn<PluginIpcTarget["reportLanguageRegistrationFailure"]>(
      () => ({ accepted: false, revision: 7 }),
    ),
    notices: vi.fn(() => []),
    execute: vi.fn(async () => ({ ok: true as const })),
    cancel: vi.fn(),
    setEnabled: vi.fn(ok),
    setDeveloperMode: vi.fn(ok),
    linkFolder: vi.fn(ok),
    relinkFolder: vi.fn(ok),
    unlink: vi.fn(ok),
    reload: vi.fn(ok),
    pythonCandidates: vi.fn(async () => []),
    setPython: vi.fn(ok),
    readLog: vi.fn(() => ({ lines: [], next: 0, truncated: false })),
    clearSafeModeLock: vi.fn(ok),
    onEvent: vi.fn(() => () => {}),
  } satisfies PluginIpcTarget;
  const publish = vi.fn();
  registerPluginIpc(handle, plugins, publish);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  return { handlers, plugins, publish, call };
}

it("registers every plugin channel and forwards events", () => {
  const { handlers, plugins, publish } = setup();
  expect([...handlers.keys()].sort()).toEqual(
    [
      "plugins:state",
      "plugins:diagnosticHelp",
      "plugins:static-languages",
      "plugins:report-language-registration-failure",
      "plugins:notices",
      "plugins:execute",
      "plugins:cancel",
      "plugins:set-enabled",
      "plugins:setDeveloperMode",
      "plugins:linkFolder",
      "plugins:relinkFolder",
      "plugins:unlink",
      "plugins:reload",
      "plugins:pythonCandidates",
      "plugins:setPython",
      "plugins:readLog",
      "plugins:clearSafeModeLock",
    ].sort(),
  );
  expect(plugins.onEvent).toHaveBeenCalledWith(publish);
});

it.each(["acme.hello", "dev:../../etc"])(
  "rejects bad source key %s for enabling and reading logs before calling the controller",
  (sourceKey) => {
    const { plugins, call } = setup();
    expect.soft(() => call("plugins:set-enabled", sourceKey, true)).toThrow();
    expect.soft(() => call("plugins:readLog", sourceKey, 0)).toThrow();
    expect.soft(plugins.setEnabled).not.toHaveBeenCalled();
    expect(plugins.readLog).not.toHaveBeenCalled();
  },
);

it("validates every renderer argument before it reaches the controller", async () => {
  const { plugins, call } = setup();
  expect(await call("plugins:execute", "acme.hello.greet")).toEqual({ ok: true });
  expect(() => call("plugins:execute", "../../etc")).toThrow();
  for (const channel of [
    "plugins:cancel",
    "plugins:relinkFolder",
    "plugins:unlink",
    "plugins:reload",
  ]) {
    expect(() => call(channel, "/Users/me/plugin")).toThrow();
    expect(() => call(channel, "dev:../../etc")).toThrow();
    await call(channel, key);
  }
  expect(plugins.reload).toHaveBeenCalledWith(key);
  expect(() => call("plugins:set-enabled", key, "yes")).toThrow();
  expect(() => call("plugins:setDeveloperMode", "true")).toThrow();
  await call("plugins:setDeveloperMode", true);
  expect(plugins.setDeveloperMode).toHaveBeenCalledWith(true);
  expect(() => call("plugins:setPython", "/usr/bin/python3")).toThrow();
  await call("plugins:setPython", "other");
  expect(plugins.setPython).toHaveBeenCalledWith("other");
  expect(() => call("plugins:readLog", key, -1)).toThrow();
  expect(() => call("plugins:readLog", key, 1.5)).toThrow();
  await call("plugins:readLog", key, 3);
  expect(plugins.readLog).toHaveBeenCalledWith(key, 3);
  // Channels without arguments ignore anything the renderer adds.
  await call("plugins:linkFolder", "/etc");
  expect(plugins.linkFolder).toHaveBeenCalledWith();
});

it("forwards the diagnostic help catalog", () => {
  const { plugins, call } = setup();
  expect(call("plugins:diagnosticHelp")).toEqual({ revision: 0, plugins: {} });
  expect(plugins.diagnosticHelp).toHaveBeenCalledOnce();
});

const registrationFailure = (): ReportLanguageRegistrationFailureInput => ({
  sourceKey: key,
  generation: 2,
  languageId: "toy",
  revision: 7,
  reason: "adapter",
  detail: "The validated language could not be adapted.",
});

it("forwards the current static catalog and all five allowed report reasons", () => {
  const { plugins, call } = setup();
  expect(call("plugins:static-languages")).toEqual(emptyStaticLanguagesCatalog(7));
  expect(plugins.staticLanguages).toHaveBeenCalledOnce();
  for (const reason of [
    "dto-version",
    "validation",
    "adapter",
    "monaco",
    "session-language-ids",
  ] as const) {
    const input = { ...registrationFailure(), reason };
    expect(call("plugins:report-language-registration-failure", input)).toEqual({
      accepted: false,
      revision: 7,
    });
    expect(plugins.reportLanguageRegistrationFailure).toHaveBeenLastCalledWith(input);
  }
});

it("rejects malformed reports, physical paths and extra fields before the controller", () => {
  const { plugins, call } = setup();
  for (const input of [
    null,
    [],
    { ...registrationFailure(), sourceKey: "dev:../../etc" },
    { ...registrationFailure(), sourceKey: "/tmp/plugin" },
    { ...registrationFailure(), languageId: "TOY" },
    { ...registrationFailure(), generation: -1 },
    { ...registrationFailure(), generation: 1.5 },
    { ...registrationFailure(), generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...registrationFailure(), revision: -1 },
    { ...registrationFailure(), revision: Infinity },
    { ...registrationFailure(), reason: "reload" },
    { ...registrationFailure(), detail: { message: "bad" } },
    { ...registrationFailure(), detail: "a".repeat(2049) },
    { ...registrationFailure(), detail: "😀".repeat(2049) },
    { ...registrationFailure(), detail: "/Users/me/plugin/language.json" },
    { ...registrationFailure(), detail: "Failed at C:\\plugins\\language.json" },
    { ...registrationFailure(), detail: "Failed at \\\\server\\plugin\\language.json" },
    { ...registrationFailure(), detail: "Failed at file:///tmp/language.json" },
    { ...registrationFailure(), resourcePath: "/tmp/language.json" },
    { ...registrationFailure(), pluginId: "acme.forged" },
  ])
    expect(() => call("plugins:report-language-registration-failure", input)).toThrow();
  expect(plugins.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
});

it("counts report detail in decoded code points and accepts the exact boundary", () => {
  const { plugins, call } = setup();
  for (const detail of ["", "a".repeat(2048), "😀".repeat(2048)]) {
    const input = { ...registrationFailure(), detail };
    call("plugins:report-language-registration-failure", input);
    expect(plugins.reportLanguageRegistrationFailure).toHaveBeenLastCalledWith(input);
  }
});

it("uses the real trusted-sender wrapper for catalog and registration-report channels", () => {
  const { plugins } = setup();
  electronHandlers.clear();
  const renderer = { id: 4, mainFrame: {} };
  let available = true;
  registerIpc(
    () => (available ? (renderer as never) : undefined),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { run: (_channel: string, work: () => unknown) => work() } as never,
    () => {},
    () => {},
    undefined,
    [(handle) => registerPluginIpc(handle, plugins, () => {})],
  );
  const trusted = { sender: renderer, senderFrame: renderer.mainFrame };
  for (const channel of [
    "plugins:static-languages",
    "plugins:report-language-registration-failure",
  ]) {
    const handler = electronHandlers.get(channel)!;
    for (const event of [
      { ...trusted, sender: { id: 99 } },
      { ...trusted, senderFrame: {} },
    ])
      expect(() => handler(event, registrationFailure())).toThrow("untrusted");
    available = false;
    expect(() => handler(trusted, registrationFailure())).toThrow("untrusted");
    available = true;
  }
  expect(plugins.staticLanguages).not.toHaveBeenCalled();
  expect(plugins.reportLanguageRegistrationFailure).not.toHaveBeenCalled();
  expect(electronHandlers.get("plugins:static-languages")!(trusted)).toEqual(
    emptyStaticLanguagesCatalog(7),
  );
  electronHandlers.get("plugins:report-language-registration-failure")!(
    trusted,
    registrationFailure(),
  );
  expect(plugins.reportLanguageRegistrationFailure).toHaveBeenCalledExactlyOnceWith(
    registrationFailure(),
  );
});
