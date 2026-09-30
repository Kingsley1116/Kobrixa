import { formatSequence, sequencesOverlap, type KeySequence } from "../../shared/keyboard.js";
import {
  commandLabel,
  commandDescription,
  effectiveBindings,
  type KeyboardCommand,
  type KeybindingOverrides,
} from "./keybindings.js";
import type { Locale } from "../i18n/copy.js";

export type ShortcutStatus = "default" | "custom" | "unassigned" | "unbound";
export function shortcutStatus(
  command: KeyboardCommand,
  overrides: KeybindingOverrides,
): ShortcutStatus {
  const override = overrides[command.id];
  return override === undefined
    ? command.defaults.length
      ? "default"
      : "unassigned"
    : override.length
      ? "custom"
      : "unbound";
}
export function uniqueSequences(
  command: KeyboardCommand,
  overrides: KeybindingOverrides,
): KeySequence[] {
  return [
    ...new Map(
      effectiveBindings(command, overrides).map(({ keys }) => [keys.join(" "), keys]),
    ).values(),
  ];
}
export function normalizeShortcutSearch(value: string, mac: boolean): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /[⌘⌃⌥⇧]/g,
      (key) => ({ "⌘": " meta ", "⌃": " ctrl ", "⌥": " alt ", "⇧": " shift " })[key]!,
    )
    .replace(/\b(cmd|command|win|windows)\b/g, "meta")
    .replace(/\bcontrol\b/g, "ctrl")
    .replace(/\boption\b/g, "alt")
    .replace(/\bmod\b/g, mac ? "meta" : "ctrl")
    .replace(/\bkey([a-z])\b/g, "$1")
    .replace(/\bdigit([0-9])\b/g, "$1")
    .replace(/[+→]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export interface ShortcutFilter {
  query: string;
  source: "all" | "workbench" | "editor";
  status: "all" | "modified" | "unassigned";
  keys: KeySequence;
}
export const EMPTY_SHORTCUT_FILTER: ShortcutFilter = {
  query: "",
  source: "all",
  status: "all",
  keys: [],
};
export function filterShortcuts(
  commands: KeyboardCommand[],
  overrides: KeybindingOverrides,
  filter: ShortcutFilter,
  locale: Locale,
  mac: boolean,
): KeyboardCommand[] {
  const requestedKeys: string[] = [];
  const signature = (value: string) => value.split(" ").sort().join(" ");
  const tokens = normalizeShortcutSearch(filter.query, mac)
    .replace(
      /\b(?:(?:ctrl|meta|alt|shift)\s+)+(?:[a-z0-9]\b|f\d{1,2}\b|enter\b|tab\b|space\b|escape\b|backspace\b|delete\b|arrow(?:up|down|left|right)\b|[,.;/\\[\]`'=-])/g,
      (value) => {
        requestedKeys.push(signature(value));
        return " ";
      },
    )
    .split(" ")
    .filter(Boolean);
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  return commands
    .filter((command) => {
      if (filter.source !== "all" && filter.source !== command.source) return false;
      if (filter.status === "modified" && overrides[command.id] === undefined) return false;
      const bindings = uniqueSequences(command, overrides);
      if (
        !requestedKeys.every((requested) =>
          bindings.some((keys) =>
            keys.some((stroke) =>
              [stroke, formatSequence([stroke], mac)].some(
                (value) => signature(normalizeShortcutSearch(value, mac)) === requested,
              ),
            ),
          ),
        )
      )
        return false;
      if (filter.status === "unassigned" && bindings.length) return false;
      if (
        filter.keys.length &&
        !bindings.some((keys) =>
          filter.keys.length === 1
            ? keys.includes(filter.keys[0]!)
            : keys.join(" ") === filter.keys.join(" "),
        )
      )
        return false;
      const text = normalizeShortcutSearch(
        [
          commandLabel(command, "zh-TW"),
          commandLabel(command, "en"),
          commandDescription(command, "zh-TW"),
          commandDescription(command, "en"),
          command.label,
          command.id,
          ...bindings.flatMap((keys) => [keys.join(" "), formatSequence(keys, mac)]),
        ].join(" "),
        mac,
      );
      return tokens.every((token) => text.includes(token));
    })
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === "workbench" ? -1 : 1;
      return a.source === "workbench"
        ? 0
        : collator.compare(commandLabel(a, locale), commandLabel(b, locale));
    });
}
export interface ShortcutConflict {
  command: KeyboardCommand;
  keys: KeySequence;
  reason: "same" | "prefix";
}
export function detailedConflicts(
  command: KeyboardCommand,
  candidates: KeySequence[],
  commands: KeyboardCommand[],
  overrides: KeybindingOverrides,
  overlap: (a: string, b: string) => boolean,
): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  for (const other of commands) {
    if (other.id === command.id) continue;
    for (const binding of effectiveBindings(other, overrides)) {
      const candidate = candidates.find((keys) => sequencesOverlap(keys, binding.keys));
      if (
        !candidate ||
        !(
          command.source === "workbench" ||
          other.source === "workbench" ||
          command.contexts.some((context) => overlap(context.when, binding.when ?? "editorFocus"))
        )
      )
        continue;
      if (
        !conflicts.some(
          (item) => item.command.id === other.id && item.keys.join(" ") === binding.keys.join(" "),
        )
      )
        conflicts.push({
          command: other,
          keys: binding.keys,
          reason: candidate.length === binding.keys.length ? "same" : "prefix",
        });
    }
  }
  return conflicts;
}
