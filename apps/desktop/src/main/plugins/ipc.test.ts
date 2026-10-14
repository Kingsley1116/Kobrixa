import { expect, it, vi } from "vitest";
import type { IpcHandle } from "../ipc.js";
import { registerPluginIpc } from "./ipc.js";

it("validates renderer input before reaching the plugin manager", async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const handle = ((channel, action) => handlers.set(channel, action as never)) as IpcHandle;
  const manager = {
    state: vi.fn(() => ({ safeMode: false, developmentMode: false, plugins: [] })),
    executeCommand: vi.fn(async () => ({ ok: true as const })),
    setEnabled: vi.fn(async () => ({
      ok: true as const,
      state: { safeMode: false, developmentMode: false, plugins: [] },
    })),
    onEvent: vi.fn(() => () => {}),
  };
  const publish = vi.fn();
  registerPluginIpc(handle, manager, publish);
  expect(await handlers.get("plugins:execute")!({}, "acme.hello.greet")).toEqual({ ok: true });
  expect(() => handlers.get("plugins:execute")!({}, "../../etc")).toThrow();
  expect(() => handlers.get("plugins:set-enabled")!({}, "acme.hello", "yes")).toThrow();
  await handlers.get("plugins:set-enabled")!({}, "acme.hello", false);
  expect(manager.setEnabled).toHaveBeenCalledWith("acme.hello", false);
  expect(manager.onEvent).toHaveBeenCalledWith(publish);
});
