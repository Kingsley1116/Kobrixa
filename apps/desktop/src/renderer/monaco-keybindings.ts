/** Monaco 0.52.2 compatibility boundary. No other module imports its private registries. */
import * as monaco from "monaco-editor";
// @ts-expect-error Monaco ships these registries as JS without declarations.
import { EditorExtensionsRegistry } from "monaco-editor/esm/vs/editor/browser/editorExtensions.js";
// @ts-expect-error Monaco internal registry; covered by real-editor integration tests.
import { KeybindingsRegistry } from "monaco-editor/esm/vs/platform/keybinding/common/keybindingsRegistry.js";
// @ts-expect-error Monaco internal registry; covered by real-editor integration tests.
import { CommandsRegistry } from "monaco-editor/esm/vs/platform/commands/common/commands.js";
// @ts-expect-error Monaco context expressions are not part of the public type bundle.
import { ContextKeyExpr } from "monaco-editor/esm/vs/platform/contextkey/common/contextkey.js";
// @ts-expect-error Standalone service access stays inside this adapter.
import { StandaloneServices } from "monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js";
// @ts-expect-error Service token is shipped without declarations.
import { IKeybindingService } from "monaco-editor/esm/vs/platform/keybinding/common/keybinding.js";
import {
  appCommands,
  effectiveBindings,
  type KeyboardCommand,
  type KeybindingOverrides,
  type KeySequence,
} from "./keybindings.js";
import { keyboardStroke } from "../shared/keyboard.js";
interface Expression {
  serialize(): string;
}
interface DefaultRule {
  command: string;
  commandArgs?: unknown;
  when?: Expression;
  keybinding?: {
    chords: {
      keyCode: number;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    }[];
  };
}
interface Action {
  id: string;
  label: string;
  precondition?: Expression;
}
const aliases: Record<string, string> = {
  "editor.action.formatDocument": "kobrixa.format",
  "editor.action.marker.nextInFiles": "kobrixa.nextProblem",
  "editor.action.marker.prevInFiles": "kobrixa.previousProblem",
};
const special: Record<string, string> = {
  LeftArrow: "ArrowLeft",
  RightArrow: "ArrowRight",
  UpArrow: "ArrowUp",
  DownArrow: "ArrowDown",
  Backquote: "Backquote",
  Numpad0: "Numpad0",
};
function codeName(value: number): string {
  const name = monaco.KeyCode[value] ?? "Unknown";
  return special[name] ?? name.replace(/^Numpad([0-9])$/, "Numpad$1");
}
function keyCode(code: string): number {
  const name = Object.keys(special).find((key) => special[key] === code) ?? code;
  return (monaco.KeyCode as unknown as Record<string, number>)[name] ?? 0;
}
export function encodeSequence(keys: KeySequence, mac: boolean): number {
  const parts = keys.map((stroke) => {
    const names = stroke.split("+");
    const ctrl = names.includes("Ctrl"),
      meta = names.includes("Meta");
    return (
      keyCode(names.at(-1)!) |
      (names.includes("Shift") ? monaco.KeyMod.Shift : 0) |
      (names.includes("Alt") ? monaco.KeyMod.Alt : 0) |
      ((mac ? meta : ctrl) ? monaco.KeyMod.CtrlCmd : 0) |
      ((mac ? ctrl : meta) ? monaco.KeyMod.WinCtrl : 0)
    );
  });
  return parts.length === 2 ? monaco.KeyMod.chord(parts[0]!, parts[1]!) : parts[0]!;
}
export function contextsOverlap(a: string, b: string): boolean {
  const result = ContextKeyExpr.and(ContextKeyExpr.deserialize(a), ContextKeyExpr.deserialize(b));
  return result?.serialize() !== "false";
}
export function editorCommandCatalog(mac: boolean): KeyboardCommand[] {
  const actions = EditorExtensionsRegistry.getEditorActions() as Action[];
  const defaults = KeybindingsRegistry.getDefaultKeybindings() as DefaultRule[];
  const known = CommandsRegistry.getCommands() as Map<string, unknown>;
  const result = new Map<string, KeyboardCommand>();
  for (const action of actions) {
    if (aliases[action.id]) continue;
    result.set(action.id, {
      id: action.id,
      label: action.label,
      source: "editor",
      defaults: [],
      contexts: [
        {
          when: `editorFocus${action.precondition ? ` && (${action.precondition.serialize()})` : ""}`,
        },
      ],
    });
  }
  for (const rule of defaults) {
    if (!rule.command || aliases[rule.command] || !known.has(rule.command)) continue;
    const when = `editorFocus${rule.when ? ` && (${rule.when.serialize()})` : ""}`;
    const command = result.get(rule.command) ?? {
      id: rule.command,
      label: rule.command,
      source: "editor" as const,
      defaults: [],
      contexts: [],
    };
    const keys = rule.keybinding?.chords.map((chord) =>
      keyboardStroke({ ...chord, code: codeName(chord.keyCode) }),
    );
    if (keys?.length) command.defaults.push({ keys, when, args: rule.commandArgs });
    result.set(rule.command, command);
  }
  // Include editor commands without defaults (e.g. cursor/selection operations).
  for (const id of known.keys()) {
    if (result.has(id) || aliases[id]) continue;
    const command = EditorExtensionsRegistry.getEditorCommand(id) as Action | undefined;
    if (command)
      result.set(id, {
        id,
        label: id,
        source: "editor",
        defaults: [],
        contexts: [
          {
            when: `editorTextFocus${command.precondition ? ` && (${command.precondition.serialize()})` : ""}`,
          },
        ],
      });
  }
  for (const command of result.values()) {
    if (command.defaults.length)
      command.contexts = command.defaults
        .map((rule) => ({ when: rule.when!, args: rule.args }))
        .filter(
          (item, index, items) =>
            items.findIndex(
              (other) =>
                other.when === item.when &&
                JSON.stringify(other.args) === JSON.stringify(item.args),
            ) === index,
        );
  }
  return [
    ...appCommands(mac),
    ...[...result.values()].sort((a, b) => a.label.localeCompare(b.label)),
  ];
}
export function installKeybindings(
  commands: KeyboardCommand[],
  overrides: KeybindingOverrides,
  mac: boolean,
): monaco.IDisposable {
  const rules: monaco.editor.IKeybindingRule[] = Object.keys(aliases).map((command) => ({
    keybinding: 0,
    command: `-${command}`,
  }));
  for (const command of commands) {
    if (command.source === "editor" && overrides[command.id] === undefined) continue;
    if (command.source === "editor") rules.push({ command: `-${command.id}`, keybinding: 0 });
    for (const binding of effectiveBindings(command, overrides))
      rules.push({
        command: command.id,
        keybinding: encodeSequence(binding.keys, mac),
        when:
          command.source === "workbench"
            ? "editorFocus && !kobrixa.modal"
            : `!kobrixa.modal && (${binding.when ?? "editorFocus"})`,
        commandArgs: binding.args,
      });
  }
  return monaco.editor.addKeybindingRules(rules);
}
interface ChordService {
  inChordMode: boolean;
  _leaveChordMode(): void;
}
export function editorChordPending(): boolean {
  return (StandaloneServices.get(IKeybindingService) as ChordService).inChordMode;
}
export function cancelEditorChord(): void {
  const service = StandaloneServices.get(IKeybindingService) as ChordService;
  if (service.inChordMode) service._leaveChordMode();
}
