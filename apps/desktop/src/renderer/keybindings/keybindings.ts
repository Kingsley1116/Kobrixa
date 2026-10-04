import { COMMAND_LABELS } from "./command-labels.js";
import { COMMAND_DESCRIPTIONS } from "./command-descriptions.js";
import type { Locale } from "../i18n/copy.js";
import {
  formatSequence,
  sequencesOverlap,
  validStroke,
  reservedStroke,
  type KeySequence,
} from "../../shared/keyboard.js";
export type { KeySequence } from "../../shared/keyboard.js";
export interface CommandBinding {
  keys: KeySequence;
  when?: string;
  args?: unknown;
}
export interface KeyboardCommand {
  id: string;
  label: string;
  source: "workbench" | "editor";
  defaults: CommandBinding[];
  /** Contexts and args are trusted catalog data, never read from saved preferences. */
  contexts: { when: string; args?: unknown }[];
}
export type KeybindingOverrides = Record<string, KeySequence[]>;
export const KEYBINDINGS_KEY = "kobrixa.keybindings.v1";
export const appCommandInfo = {
  newProject: "Mod+Shift+KeyN",
  openProject: "Mod+KeyO",
  quickOpen: "Mod+KeyP",
  search: "Mod+Shift+KeyF",
  save: "Mod+KeyS",
  saveAll: "Mod+Shift+KeyS",
  closeTab: "Mod+KeyW",
  nextTab: "Ctrl+Tab",
  previousTab: "Ctrl+Shift+Tab",
  settings: "Mod+Comma",
  shortcuts: "Mod+KeyK Mod+KeyS",
  files: "Mod+KeyB",
  problems: "Mod+KeyJ",
  device: "Mod+Shift+KeyE",
  format: "Alt+Shift+KeyF",
  nextProblem: "F8",
  previousProblem: "Shift+F8",
  build: "Mod+Shift+KeyB",
  run: "F5",
  stop: "Shift+F5",
} as const;
export type AppCommand = keyof typeof appCommandInfo;
export const appCommandId = (id: AppCommand): string => `kobrixa.${id}`;
export const commandAvailableInInput = (id: string): boolean =>
  ["kobrixa.settings", "kobrixa.shortcuts", "kobrixa.quickOpen", "kobrixa.search"].includes(id);
export function appCommands(mac: boolean): KeyboardCommand[] {
  return Object.entries(appCommandInfo).map(([id, binding]) => ({
    id: `kobrixa.${id}`,
    label: COMMAND_LABELS[`kobrixa.${id}`]![0],
    source: "workbench",
    contexts: [{ when: "editorFocus" }],
    defaults: [{ keys: binding.replaceAll("Mod", mac ? "Meta" : "Ctrl").split(" ") }],
  }));
}
export const commandLabel = (command: KeyboardCommand, locale: Locale): string =>
  COMMAND_LABELS[command.id]?.[locale === "zh-TW" ? 1 : 0] ?? command.label;
export const commandDescription = (command: KeyboardCommand, locale: Locale): string =>
  COMMAND_DESCRIPTIONS[command.id]?.[locale === "zh-TW" ? 1 : 0] ?? "";
export function effectiveBindings(
  command: KeyboardCommand,
  overrides: KeybindingOverrides,
): CommandBinding[] {
  const keys = overrides[command.id];
  return keys === undefined
    ? command.defaults
    : keys.flatMap((keys) => command.contexts.map((context) => ({ keys, ...context })));
}
export function readOverrides(raw: string | null): KeybindingOverrides {
  try {
    const data: unknown = JSON.parse(raw ?? "null");
    if (
      !data ||
      typeof data !== "object" ||
      !("version" in data) ||
      data.version !== 1 ||
      !("bindings" in data) ||
      !data.bindings ||
      typeof data.bindings !== "object" ||
      Array.isArray(data.bindings)
    )
      return {};
    const result: KeybindingOverrides = {};
    for (const [id, value] of Object.entries(data.bindings)) {
      if (
        id.length > 200 ||
        id === "__proto__" ||
        id === "constructor" ||
        !Array.isArray(value) ||
        value.length > 20
      )
        continue;
      if (
        value.every(
          (keys: unknown) =>
            Array.isArray(keys) && keys.length >= 1 && keys.length <= 2 && keys.every(validStroke),
        )
      )
        result[id] = value;
    }
    return result;
  } catch {
    return {};
  }
}
export class KeybindingsStore {
  private state: { overrides: KeybindingOverrides; saveError: boolean };
  private listeners = new Set<() => void>();
  constructor(private storage: () => Pick<Storage, "getItem" | "setItem">) {
    try {
      this.state = {
        overrides: readOverrides(storage().getItem(KEYBINDINGS_KEY)),
        saveError: false,
      };
    } catch {
      this.state = { overrides: {}, saveError: true };
    }
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(id: string, keys: KeySequence[] | undefined): void {
    const overrides = { ...this.state.overrides };
    if (keys === undefined) delete overrides[id];
    else overrides[id] = keys;
    this.state = { ...this.state, overrides };
    this.save();
  }
  reset = (): void => {
    this.state = { ...this.state, overrides: {} };
    this.save();
  };
  save = (): void => {
    let saveError = false;
    try {
      this.storage().setItem(
        KEYBINDINGS_KEY,
        JSON.stringify({ version: 1, bindings: this.state.overrides }),
      );
    } catch {
      saveError = true;
    }
    this.state = { ...this.state, saveError };
    this.listeners.forEach((listener) => listener());
  };
}
/** Cannot prove exclusivity? Report the possible conflict rather than shadow a command. */
export function bindingConflicts(
  command: KeyboardCommand,
  keys: KeySequence,
  commands: KeyboardCommand[],
  overrides: KeybindingOverrides,
  overlaps: (a: string, b: string) => boolean,
): KeyboardCommand[] {
  return commands.filter(
    (other) =>
      other.id !== command.id &&
      effectiveBindings(other, overrides).some(
        (binding) =>
          sequencesOverlap(keys, binding.keys) &&
          (command.source === "workbench" ||
            other.source === "workbench" ||
            command.contexts.some((context) =>
              overlaps(context.when, binding.when ?? "editorFocus"),
            )),
      ),
  );
}
export function bindingProblem(keys: KeySequence, mac: boolean): "typing" | "reserved" | undefined {
  if (keys.some((key) => !validStroke(key))) return "reserved";
  const first = keys[0] ?? "";
  if (
    /^(Shift\+)?(Key[A-Z]|Digit\d|Space|Comma|Period|Slash|Backslash|BracketLeft|BracketRight|Semicolon|Quote|Backquote|Minus|Equal)$/.test(
      first,
    )
  )
    return "typing";
  if (keys.some((key) => reservedStroke(key, mac))) return "reserved";
  return undefined;
}
export function bindingHint(
  command: KeyboardCommand | undefined,
  overrides: KeybindingOverrides,
  mac: boolean,
): string {
  const keys = command && effectiveBindings(command, overrides)[0]?.keys;
  return keys ? formatSequence(keys, mac) : "";
}
/** Outside Monaco only; Monaco owns dispatch/chords while an editor widget has focus. */
export class WorkbenchKeyDispatcher {
  private pending: { command: string; keys: KeySequence }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private run: (id: string) => void,
    private pendingChanged: (pending: boolean) => void,
  ) {}
  cancel = (): void => {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = [];
    this.pendingChanged(false);
  };
  dispatch(stroke: string, bindings: { command: string; keys: KeySequence }[]): boolean {
    if (this.pending.length) {
      const match = this.pending.find((binding) => binding.keys[1] === stroke);
      this.cancel();
      if (match) this.run(match.command);
      return true;
    }
    const candidates = bindings.filter((binding) => binding.keys[0] === stroke);
    if (!candidates.length) return false;
    const complete = candidates.find((binding) => binding.keys.length === 1);
    if (complete) this.run(complete.command);
    else {
      this.pending = candidates;
      this.pendingChanged(true);
      this.timer = setTimeout(this.cancel, 2000);
    }
    return true;
  }
}
