import { LAYOUT_DEFAULTS, LAYOUT_LIMITS, LAYOUT_STORAGE_KEYS, clamp } from "./editor-state.js";
import type { Locale } from "./copy.js";
import { THEME_KEY, type Theme } from "./theme.js";

export const UI_SCALES = [100, 110, 125] as const;
export const CODE_SIZES = [14, 16, 18, 20, 24] as const;
export interface Settings {
  locale: Locale;
  theme: Theme;
  uiScale: (typeof UI_SCALES)[number];
  codeSize: (typeof CODE_SIZES)[number];
  motion: "system" | "reduce";
  wordWrap: boolean;
  indentSize: 2 | 4;
  filesOpen: boolean;
  deviceOpen: boolean;
  problemsOpen: boolean;
  filesWidth: number;
  deviceWidth: number;
  problemsHeight: number;
  toolTab: "connection" | "files" | "activity";
}
export interface SettingsSnapshot {
  values: Settings;
  saveError: boolean;
}
type StorageAccess = () => Pick<Storage, "getItem" | "setItem">;
export const SETTINGS_KEYS: Record<keyof Settings, string> = {
  locale: "kobrixa.locale",
  theme: THEME_KEY,
  uiScale: "kobrixa.uiScale",
  codeSize: "kobrixa.codeSize",
  motion: "kobrixa.motion",
  wordWrap: "kobrixa.wordWrap",
  indentSize: "kobrixa.indentSize",
  ...LAYOUT_STORAGE_KEYS,
  toolTab: "kobrixa.tools.tab",
};
export function defaultSettings(language: string): Settings {
  return {
    locale: language.toLowerCase().startsWith("zh") ? "zh-TW" : "en",
    theme: "dark",
    uiScale: 100,
    codeSize: 16,
    motion: "system",
    wordWrap: false,
    indentSize: 2,
    ...LAYOUT_DEFAULTS,
    toolTab: "connection",
  };
}
export function readSettings(storage: Pick<Storage, "getItem">, language: string): Settings {
  const result = defaultSettings(language);
  const choice = <T extends string | number>(
    key: keyof Settings,
    options: readonly T[],
    fallback: T,
  ): T => {
    const raw = storage.getItem(SETTINGS_KEYS[key]);
    return options.find((option) => String(option) === raw) ?? fallback;
  };
  result.locale = choice("locale", ["en", "zh-TW"], result.locale);
  result.theme = choice("theme", ["light", "dark"], result.theme);
  result.uiScale = choice("uiScale", UI_SCALES, result.uiScale);
  result.codeSize = choice("codeSize", CODE_SIZES, result.codeSize);
  result.motion = choice("motion", ["system", "reduce"], result.motion);
  result.indentSize = choice("indentSize", [2, 4], result.indentSize);
  result.toolTab = choice("toolTab", ["connection", "files", "activity"], result.toolTab);
  for (const key of ["wordWrap", "filesOpen", "deviceOpen", "problemsOpen"] as const) {
    const raw = storage.getItem(SETTINGS_KEYS[key]);
    if (raw === "true" || raw === "false") result[key] = raw === "true";
  }
  for (const key of ["filesWidth", "deviceWidth", "problemsHeight"] as const) {
    const raw = storage.getItem(SETTINGS_KEYS[key]);
    const value = Number(raw);
    const { min, max } =
      key === "problemsHeight"
        ? { min: LAYOUT_LIMITS.problemsHeight.min, max: 500 }
        : LAYOUT_LIMITS[key];
    if (raw?.trim() && Number.isFinite(value)) {
      // Keep legacy EV3 pane widths, clamped to the expanded range.
      if (key === "deviceWidth") result[key] = clamp(value, min, max);
      else if (value >= min && value <= max) result[key] = value;
    }
  }
  return result;
}
/** One source for both quick controls and the settings page; writes never block editing. */
export class SettingsStore {
  private state: SettingsSnapshot;
  private listeners = new Set<() => void>();
  constructor(
    private storage: StorageAccess,
    language: string,
  ) {
    try {
      this.state = { values: readSettings(storage(), language), saveError: false };
    } catch {
      this.state = { values: defaultSettings(language), saveError: true };
    }
  }
  getSnapshot = (): SettingsSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  set<K extends keyof Settings>(
    key: K,
    value: Settings[K] | ((previous: Settings[K]) => Settings[K]),
  ): void {
    const next = typeof value === "function" ? value(this.state.values[key]) : value;
    if (next === this.state.values[key]) return;
    this.state = { ...this.state, values: { ...this.state.values, [key]: next } };
    this.save();
  }
  resetLayout = (): void => {
    this.state = {
      ...this.state,
      values: { ...this.state.values, ...LAYOUT_DEFAULTS, toolTab: "connection" },
    };
    this.save();
  };
  save = (): void => {
    let saveError = false;
    try {
      const storage = this.storage();
      for (const key of Object.keys(SETTINGS_KEYS) as (keyof Settings)[])
        storage.setItem(SETTINGS_KEYS[key], String(this.state.values[key]));
    } catch {
      saveError = true;
    }
    this.state = { ...this.state, saveError };
    this.listeners.forEach((listener) => listener());
  };
}
export function applyAppearance(values: Settings, root: HTMLElement): void {
  root.dataset.theme = values.theme;
  root.dataset.motion = values.motion;
  root.lang = values.locale;
  root.style.setProperty("--ui-scale", String(values.uiScale / 100));
}
