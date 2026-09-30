// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
// The catalog imports the real bundled editor, not a list of mocked commands.
vi.stubGlobal("matchMedia", () => ({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));
Object.defineProperty(document, "queryCommandSupported", {
  value: () => false,
  configurable: true,
});
import type * as Adapter from "./monaco-keybindings.js";
import { COMMAND_LABELS } from "./command-labels.js";
import { commandLabel } from "./keybindings.js";
let adapter: typeof Adapter;
beforeAll(async () => {
  adapter = await import("./monaco-keybindings.js");
});
describe("Monaco 0.52.2 compatibility", () => {
  it("has reviewed Traditional Chinese and readable English for every registered command", () => {
    for (const mac of [true, false]) {
      for (const command of adapter.editorCommandCatalog(mac)) {
        expect(COMMAND_LABELS[command.id], command.id).toBeDefined();
        expect(commandLabel(command, "zh-TW"), command.id).toMatch(/[\u3400-\u9fff]/);
        expect(commandLabel(command, "en"), command.id).not.toBe(command.id);
      }
    }
  });
  it("enumerates real find, undo, redo, multicursor and unbound editor actions", () => {
    const catalog = adapter.editorCommandCatalog(false);
    for (const id of [
      "actions.find",
      "undo",
      "redo",
      "editor.action.insertCursorAbove",
      "editor.action.commentLine",
    ])
      expect(
        catalog.some((item) => item.id === id),
        id,
      ).toBe(true);
    expect(catalog.filter((item) => item.source === "editor").length).toBeGreaterThan(150);
    expect(catalog.some((item) => item.source === "editor" && !item.defaults.length)).toBe(true);
    expect(catalog.some((item) => item.id === "editor.action.formatDocument")).toBe(false);
    expect(catalog.some((item) => item.id === "kobrixa.format")).toBe(true);
    expect(catalog.find((item) => item.id === "undo")?.defaults.length).toBeGreaterThan(0);
  });
  it("distinguishes mutually exclusive editor contexts", () => {
    expect(
      adapter.contextsOverlap(
        "editorFocus && suggestWidgetVisible",
        "editorFocus && !suggestWidgetVisible",
      ),
    ).toBe(false);
    expect(adapter.contextsOverlap("editorFocus", "editorFocus && !editorReadonly")).toBe(true);
  });
  it("encodes platform modifiers and native two-stroke bindings", () => {
    expect(adapter.encodeSequence(["Meta+KeyS"], true)).toBe(
      adapter.encodeSequence(["Ctrl+KeyS"], false),
    );
    expect(adapter.encodeSequence(["Ctrl+KeyK", "Ctrl+KeyC"], false)).toBeGreaterThan(65535);
  });
});
