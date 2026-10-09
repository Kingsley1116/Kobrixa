import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appCommands,
  bindingConflicts,
  bindingProblem,
  commandAvailableInInput,
  effectiveBindings,
  KEYBINDINGS_KEY,
  KeybindingsStore,
  readOverrides,
  WorkbenchKeyDispatcher,
  type KeyboardCommand,
} from "./keybindings.js";
import {
  formatSequence,
  keyboardStroke,
  ignoreMenuShortcut,
  KEYBOARD_DEFAULT,
} from "../../shared/keyboard.js";
afterEach(() => vi.useRealTimers());
describe("keyboard bindings", () => {
  it("uses platform modifiers and exact physical strokes", () => {
    expect(appCommands(true).find((c) => c.id === "kobrixa.save")?.defaults[0]?.keys).toEqual([
      "Meta+KeyS",
    ]);
    expect(appCommands(false).find((c) => c.id === "kobrixa.save")?.defaults[0]?.keys).toEqual([
      "Ctrl+KeyS",
    ]);
    expect(
      keyboardStroke({
        code: "KeyS",
        ctrlKey: true,
        metaKey: false,
        altKey: false,
        shiftKey: true,
      }),
    ).toBe("Ctrl+Shift+KeyS");
    expect(formatSequence(["Ctrl+KeyK", "Ctrl+KeyS"], false)).toBe("Ctrl+K → Ctrl+S");
    expect(formatSequence(["Meta+Comma"], true)).toBe("⌘,");
  });
  it("round trips overrides, unbinding and restoring without saving defaults", () => {
    const data: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => data[key] ?? null,
      setItem: (key: string, value: string) => {
        data[key] = value;
      },
    };
    const store = new KeybindingsStore(() => storage);
    store.set("kobrixa.save", [["Ctrl+Alt+KeyS"]]);
    store.set("undo", []);
    const restored = new KeybindingsStore(() => storage);
    expect(restored.getSnapshot().overrides).toEqual({
      "kobrixa.save": [["Ctrl+Alt+KeyS"]],
      undo: [],
    });
    expect(
      effectiveBindings(
        appCommands(false).find((c) => c.id === "kobrixa.save")!,
        restored.getSnapshot().overrides,
      )[0]?.keys,
    ).toEqual(["Ctrl+Alt+KeyS"]);
    restored.set("undo", undefined);
    expect(JSON.parse(data[KEYBINDINGS_KEY]!)).toEqual({
      version: 1,
      bindings: { "kobrixa.save": [["Ctrl+Alt+KeyS"]] },
    });
    restored.reset();
    expect(restored.getSnapshot().overrides).toEqual({});
  });
  it("offers remappable project navigation commands in workbench input fields", () => {
    for (const mac of [false, true]) {
      const commands = appCommands(mac);
      const quickOpen = commands.find((command) => command.id === "kobrixa.quickOpen")!;
      const search = commands.find((command) => command.id === "kobrixa.search")!;
      expect(quickOpen.defaults[0]?.keys).toEqual([`${mac ? "Meta" : "Ctrl"}+KeyP`]);
      expect(search.defaults[0]?.keys).toEqual([`${mac ? "Meta" : "Ctrl"}+Shift+KeyF`]);
      expect(effectiveBindings(quickOpen, { "kobrixa.quickOpen": [["Alt+KeyP"]] })).toEqual([
        { keys: ["Alt+KeyP"], when: "editorFocus" },
      ]);
      expect(effectiveBindings(search, { "kobrixa.search": [] })).toEqual([]);
    }
    expect(commandAvailableInInput("kobrixa.quickOpen")).toBe(true);
    expect(commandAvailableInInput("kobrixa.search")).toBe(true);
    expect(commandAvailableInInput("kobrixa.settings")).toBe(true);
    expect(commandAvailableInInput("kobrixa.shortcuts")).toBe(true);
    expect(commandAvailableInInput("kobrixa.run")).toBe(false);
    expect(commandAvailableInInput("kobrixa.closeTab")).toBe(false);
  });
  it("recovers valid entries from damaged storage and survives write failure", () => {
    expect(readOverrides("invalid")).toEqual({});
    expect(readOverrides(JSON.stringify({ version: 2, bindings: { undo: [] } }))).toEqual({});
    expect(
      readOverrides(
        JSON.stringify({
          version: 1,
          bindings: { undo: [], invalid: [[]], bad: [["Ctrl+Bogus"]], good: [["F6"]] },
        }),
      ),
    ).toEqual({ undo: [], good: [["F6"]] });
    const storage = {
      getItem: () => null,
      setItem: vi.fn((): void => {
        throw new Error("quota");
      }),
    };
    const store = new KeybindingsStore(() => storage);
    store.set("undo", []);
    expect(store.getSnapshot()).toEqual({ overrides: { undo: [] }, saveError: true });
    storage.setItem.mockImplementation(() => undefined);
    store.save();
    expect(store.getSnapshot().saveError).toBe(false);
  });
  it("rejects overlapping prefixes but allows distinct second strokes", () => {
    const commands = appCommands(false),
      save = commands.find((c) => c.id === "kobrixa.save")!;
    expect(
      bindingConflicts(save, ["Ctrl+KeyK"], commands, {}, () => true).map((c) => c.id),
    ).toContain("kobrixa.shortcuts");
    expect(bindingConflicts(save, ["Ctrl+KeyK", "Ctrl+KeyL"], commands, {}, () => true)).toEqual(
      [],
    );
    const editor: KeyboardCommand = {
      id: "find",
      label: "Find",
      source: "editor",
      defaults: [{ keys: ["Ctrl+KeyF"], when: "editorFocus" }],
      contexts: [{ when: "editorFocus" }],
    };
    expect(bindingConflicts(save, ["Ctrl+KeyF"], [...commands, editor], {}, () => true)).toEqual([
      editor,
    ]);
    expect(
      bindingConflicts(save, ["Ctrl+KeyF"], [...commands, editor], { find: [] }, () => true),
    ).toEqual([]);
  });
  it("preserves context-specific arguments and rejects typing/system shortcuts", () => {
    const command: KeyboardCommand = {
      id: "test",
      label: "test",
      source: "editor",
      defaults: [],
      contexts: [{ when: "suggestWidgetVisible", args: { value: 1 } }],
    };
    expect(effectiveBindings(command, { test: [["Ctrl+KeyT"]] })).toEqual([
      { keys: ["Ctrl+KeyT"], when: "suggestWidgetVisible", args: { value: 1 } },
    ]);
    expect(bindingProblem(["KeyA"], false)).toBe("typing");
    expect(bindingProblem(["Alt+F4"], false)).toBe("reserved");
    expect(bindingProblem(["Meta+KeyQ"], true)).toBe("reserved");
    expect(bindingProblem(["Ctrl+KeyK", "Ctrl+KeyC"], false)).toBeUndefined();
  });
  it("dispatches a chord exactly once, cancels mismatches and times out", () => {
    vi.useFakeTimers();
    const run = vi.fn(),
      pending = vi.fn();
    const dispatcher = new WorkbenchKeyDispatcher(run, pending);
    const bindings = [
      { command: "settings", keys: ["Ctrl+KeyK", "Ctrl+KeyS"] },
      { command: "save", keys: ["Ctrl+KeyS"] },
    ];
    expect(dispatcher.dispatch("Ctrl+KeyK", bindings)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    dispatcher.dispatch("Ctrl+KeyS", bindings);
    expect(run).toHaveBeenCalledExactlyOnceWith("settings");
    dispatcher.dispatch("Ctrl+KeyK", bindings);
    vi.advanceTimersByTime(2000);
    dispatcher.dispatch("Ctrl+KeyS", bindings);
    expect(run).toHaveBeenLastCalledWith("save");
    dispatcher.dispatch("Ctrl+KeyK", bindings);
    dispatcher.dispatch("KeyZ", bindings);
    expect(run).toHaveBeenCalledTimes(2);
    dispatcher.dispatch("Ctrl+KeyK", bindings);
    dispatcher.cancel();
    expect(pending).toHaveBeenLastCalledWith(false);
  });
  it("suppresses native menus only for managed keys, editors, recording or chords", () => {
    expect(ignoreMenuShortcut(KEYBOARD_DEFAULT, "Ctrl+KeyZ")).toBe(false);
    expect(
      ignoreMenuShortcut({ ...KEYBOARD_DEFAULT, editorFocused: true }, "Meta+KeyQ", true),
    ).toBe(false);
    expect(ignoreMenuShortcut({ ...KEYBOARD_DEFAULT, editorFocused: true }, "Alt+F4", false)).toBe(
      false,
    );
    expect(ignoreMenuShortcut({ ...KEYBOARD_DEFAULT, capturing: true }, "Meta+KeyQ", true)).toBe(
      true,
    );
    expect(
      ignoreMenuShortcut({ ...KEYBOARD_DEFAULT, managedKeys: ["Ctrl+KeyW"] }, "Ctrl+KeyW"),
    ).toBe(true);
    for (const field of ["editorFocused", "capturing", "chordPending"] as const)
      expect(ignoreMenuShortcut({ ...KEYBOARD_DEFAULT, [field]: true }, "Ctrl+KeyZ")).toBe(true);
  });
  it("keeps the macOS Edit menu clipboard shortcuts working in the editor", () => {
    const editor = { ...KEYBOARD_DEFAULT, editorFocused: true };
    for (const stroke of ["Meta+KeyC", "Meta+KeyV", "Meta+KeyX"])
      expect(ignoreMenuShortcut(editor, stroke, true)).toBe(false);
    expect(ignoreMenuShortcut(editor, "Ctrl+KeyC", false)).toBe(true);
    expect(ignoreMenuShortcut({ ...editor, chordPending: true }, "Meta+KeyC", true)).toBe(true);
    expect(ignoreMenuShortcut({ ...editor, managedKeys: ["Meta+KeyV"] }, "Meta+KeyV", true)).toBe(
      true,
    );
  });
});
