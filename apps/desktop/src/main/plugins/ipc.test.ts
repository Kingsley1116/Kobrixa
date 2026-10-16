import { expect, it, vi } from "vitest";
import type { IpcHandle } from "../ipc.js";
import { registerPluginIpc, type PluginIpcTarget } from "./ipc.js";

const key = "dev:0123456789abcdef";
function setup() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const handle = ((channel, action) => handlers.set(channel, action as never)) as IpcHandle;
  const ok = async () => ({ ok: true }) as never;
  const plugins = {
    state: vi.fn(),
    diagnosticHelp: vi.fn(() => ({ revision: 0, plugins: {} })),
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
