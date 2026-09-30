import { describe, expect, it } from "vitest";
import { appCommands, type KeyboardCommand, type KeybindingOverrides } from "./keybindings.js";
import {
  detailedConflicts,
  EMPTY_SHORTCUT_FILTER,
  filterShortcuts,
  shortcutStatus,
  type ShortcutFilter,
} from "./shortcut-search.js";
const editor: KeyboardCommand = {
  id: "actions.find",
  label: "Find",
  source: "editor",
  defaults: [{ keys: ["Meta+KeyF"], when: "editorFocus" }],
  contexts: [{ when: "editorFocus" }],
};
const commands = [...appCommands(true), editor];
const filter = (patch: Partial<ShortcutFilter>, overrides: KeybindingOverrides = {}) =>
  filterShortcuts(commands, overrides, { ...EMPTY_SHORTCUT_FILTER, ...patch }, "zh-TW", true).map(
    (item) => item.id,
  );
describe("shortcut discovery", () => {
  it("searches Chinese, English and IDs together with multiple terms", () => {
    expect(filter({ query: "搜尋 find" })).toEqual(["actions.find"]);
    expect(filter({ query: "  SAVE   儲存  " })).toEqual(
      expect.arrayContaining(["kobrixa.save", "kobrixa.saveAll"]),
    );
    expect(filter({ query: "actions.find" })).toEqual(["actions.find"]);
  });
  it("searches descriptions in either language and combines them with other filters", () => {
    expect(filter({ query: "磁碟" })).toEqual(["kobrixa.save", "kobrixa.saveAll"]);
    expect(filter({ query: "  DISK   磁碟 " })).toEqual(["kobrixa.save", "kobrixa.saveAll"]);
    expect(filter({ query: "磁碟", status: "modified" }, { "kobrixa.save": [] })).toEqual([
      "kobrixa.save",
    ]);
    expect(filter({ query: "磁碟", source: "editor" })).toEqual([]);
    expect(
      filterShortcuts(commands, {}, { ...EMPTY_SHORTCUT_FILTER, query: "磁碟" }, "en", true).map(
        (command) => command.id,
      ),
    ).toEqual(["kobrixa.save", "kobrixa.saveAll"]);
  });
  it("normalizes platform modifiers without matching unrelated characters in command names", () => {
    for (const query of ["Cmd+S", "Command + S", "⌘S", "Mod+S", "meta s"])
      expect(filter({ query })).toEqual(["kobrixa.save", "kobrixa.shortcuts"]);
    expect(filter({ query: "Shift + Command + S" })).toEqual(["kobrixa.saveAll"]);
    expect(filter({ query: "Control + Tab" })).toEqual(["kobrixa.nextTab"]);
    expect(filter({ query: "Command + ," })).toEqual(["kobrixa.settings"]);
    expect(filter({ query: "Option+Shift+F" })).toEqual(["kobrixa.format"]);
    expect(filter({ query: "⌥⇧F" })).toEqual(["kobrixa.format"]);
    expect(
      filterShortcuts(
        appCommands(false),
        {},
        { ...EMPTY_SHORTCUT_FILTER, query: "Mod+S" },
        "en",
        false,
      ).map((item) => item.id),
    ).toEqual(["kobrixa.save", "kobrixa.shortcuts"]);
  });
  it("matches recorded single strokes anywhere and complete chords in order", () => {
    expect(filter({ keys: ["Meta+KeyS"] })).toEqual(["kobrixa.save", "kobrixa.shortcuts"]);
    expect(filter({ keys: ["Meta+KeyK", "Meta+KeyS"] })).toEqual(["kobrixa.shortcuts"]);
    expect(filter({ keys: ["Meta+KeyS", "Meta+KeyK"] })).toEqual([]);
  });
  it("combines source and status filters including intentionally unbound commands", () => {
    const overrides = { "actions.find": [], "kobrixa.save": [["Alt+KeyS"]] };
    expect(filter({ source: "editor", status: "modified" }, overrides)).toEqual(["actions.find"]);
    expect(filter({ status: "unassigned" }, overrides)).toEqual(["actions.find"]);
    expect(shortcutStatus(editor, overrides)).toBe("unbound");
    expect(shortcutStatus({ ...editor, defaults: [] }, {})).toBe("unassigned");
    expect(shortcutStatus(editor, {})).toBe("default");
    expect(shortcutStatus(editor, { "actions.find": [["Alt+KeyF"]] })).toBe("custom");
  });
  it("reports exact and prefix conflicts with effective keys and contexts", () => {
    const save = commands.find((item) => item.id === "kobrixa.save")!;
    expect(
      detailedConflicts(save, [["Meta+KeyK"]], commands, {}, () => true).map((item) => [
        item.command.id,
        item.reason,
      ]),
    ).toEqual([["kobrixa.shortcuts", "prefix"]]);
    expect(detailedConflicts(save, [["Meta+KeyF"]], commands, {}, () => true)[0]?.reason).toBe(
      "same",
    );
    expect(
      detailedConflicts(save, [["Meta+KeyF"]], commands, { "actions.find": [] }, () => true),
    ).toEqual([]);
    expect(
      detailedConflicts({ ...editor, id: "other" }, [["Meta+KeyF"]], [editor], {}, () => false),
    ).toEqual([]);
  });
});
