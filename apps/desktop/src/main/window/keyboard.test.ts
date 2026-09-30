import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { attachKeyboard } from "./keyboard.js";
import { KEYBOARD_DEFAULT } from "../../shared/keyboard.js";
const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
  },
}));
import { registerIpc } from "../ipc.js";
describe("native keyboard bridge", () => {
  it("validates keyboard contexts and rejects foreign renderers and subframes", () => {
    const events = new Map<string, (...args: unknown[]) => void>();
    const contents = {
      id: 7,
      mainFrame: {},
      setIgnoreMenuShortcuts: vi.fn(),
      on: (event: string, listener: (...args: unknown[]) => void) => events.set(event, listener),
    };
    const trusted = contents as unknown as WebContents;
    registerIpc(
      () => trusted,
      {} as Parameters<typeof registerIpc>[1],
      {} as Parameters<typeof registerIpc>[2],
      {} as Parameters<typeof registerIpc>[3],
      {} as Parameters<typeof registerIpc>[4],
    );
    attachKeyboard(trusted);
    const update = handlers.get("keyboard:context")!;
    const event = { sender: trusted, senderFrame: contents.mainFrame };
    expect(() => update({ ...event, senderFrame: {} }, KEYBOARD_DEFAULT)).toThrow("untrusted");
    expect(() => update({ ...event, sender: { id: 8 } }, KEYBOARD_DEFAULT)).toThrow("untrusted");
    for (const invalid of [
      { ...KEYBOARD_DEFAULT, editorFocused: "yes" },
      { ...KEYBOARD_DEFAULT, managedKeys: ["Ctrl+bogus"] },
      { ...KEYBOARD_DEFAULT, command: "execute" },
    ])
      expect(() => update(event, invalid)).toThrow();
    update(event, { ...KEYBOARD_DEFAULT, managedKeys: ["Ctrl+KeyW"] });
    events.get("before-input-event")!(
      {},
      { code: "KeyW", control: true, meta: false, alt: false, shift: false },
    );
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    events.get("before-input-event")!(
      {},
      { code: "KeyZ", control: true, meta: false, alt: false, shift: false },
    );
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    events.get("did-start-loading")!();
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    events.get("before-input-event")!(
      {},
      { code: "KeyW", control: true, meta: false, alt: false, shift: false },
    );
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenLastCalledWith(false);
  });
});
