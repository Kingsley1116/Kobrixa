import {
  LAYOUT_DEFAULTS,
  LAYOUT_LIMITS,
  LAYOUT_STORAGE_KEYS,
  clamp,
} from "../workbench/workbench-state.js";
import type { Locale } from "../i18n/copy.js";
import { THEME_KEY, resolveTheme, type ThemePreference } from "./theme.js";

export const UI_SCALES = [100, 110, 125] as const;
export const CODE_SIZES = [14, 16, 18, 20, 24] as const;
export const AUTO_SAVE_DELAYS = [500, 1000, 2000, 5000] as const;
export interface EditorPreferences {
  lineHeight: "compact" | "standard" | "relaxed";
  cursorStyle: "line" | "block" | "underline";
  cursorBlinking: boolean;
  renderLineHighlight: "none" | "line" | "all";
  bracketPairColorization: boolean;
  bracketGuides: boolean;
  indentationGuides: boolean;
  folding: boolean;
  stickyScroll: boolean;
  autoClosingBrackets: boolean;
  autoClosingQuotes: boolean;
  autoSuggestions: boolean;
  hover: boolean;
  parameterHints: boolean;
  smoothScrolling: boolean;
  scrollBeyondLastLine: boolean;
}
export const EDITOR_DEFAULTS: EditorPreferences = {
  lineHeight: "standard",
  cursorStyle: "line",
  cursorBlinking: true,
  renderLineHighlight: "line",
  bracketPairColorization: true,
  bracketGuides: true,
  indentationGuides: true,
  folding: true,
  stickyScroll: true,
  autoClosingBrackets: true,
  autoClosingQuotes: true,
  autoSuggestions: true,
  hover: true,
  parameterHints: true,
  smoothScrolling: false,
  scrollBeyondLastLine: false,
};
export interface Settings extends EditorPreferences {
  lineNumbers: "on" | "relative" | "off";
  minimap: boolean;
  renderWhitespace: "none" | "selection" | "all";
  formatOnPaste: boolean;
  autoSave: "off" | "afterDelay" | "onFocusChange";
  autoSaveDelay: (typeof AUTO_SAVE_DELAYS)[number];
  formatOnSave: boolean;
  locale: Locale;
  theme: ThemePreference;
  connectionMode: "usb" | "wifi";
  rememberWifiAddress: boolean;
  revealDiagnostics: "never" | "errors" | "warnings";
  revealDeviceErrors: boolean;
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
  rightPanel: "ev3" | "collab" | null;
  ev3Tab: "connection" | "monitor" | "files";
  bottomTab: "problems" | "activity";
  toolTab: "connection" | "monitor" | "files" | "activity" | "collab";
}
export const SETTINGS_CHOICES = {
  lineNumbers: ["on", "relative", "off"],
  renderWhitespace: ["none", "selection", "all"],
  autoSave: ["off", "afterDelay", "onFocusChange"],
  autoSaveDelay: AUTO_SAVE_DELAYS,
  locale: ["en", "zh-TW"],
  theme: ["dark", "light", "system"],
  uiScale: UI_SCALES,
  codeSize: CODE_SIZES,
  motion: ["system", "reduce"],
  indentSize: [2, 4],
  rightPanel: ["ev3", "collab", null],
  ev3Tab: ["connection", "monitor", "files"],
  bottomTab: ["problems", "activity"],
  toolTab: ["connection", "monitor", "files", "activity", "collab"],
  lineHeight: ["compact", "standard", "relaxed"],
  cursorStyle: ["line", "block", "underline"],
  renderLineHighlight: ["none", "line", "all"],
  connectionMode: ["usb", "wifi"],
  revealDiagnostics: ["never", "errors", "warnings"],
} as const satisfies Partial<Record<keyof Settings, readonly (string | number | null)[]>>;
export const WIFI_ADDRESS_KEY = "kobrixa.lastWifiAddress";
export interface SettingsSnapshot {
  values: Settings;
  saveError: boolean;
}
type StorageAccess = () => Pick<Storage, "getItem" | "setItem">;
export const SETTINGS_KEYS: Record<keyof Settings, string> = {
  ...(Object.fromEntries(
    Object.keys(EDITOR_DEFAULTS).map((key) => [key, `kobrixa.${key}`]),
  ) as Record<keyof EditorPreferences, string>),
  connectionMode: "kobrixa.connectionMode",
  rememberWifiAddress: "kobrixa.rememberWifiAddress",
  revealDiagnostics: "kobrixa.revealDiagnostics",
  revealDeviceErrors: "kobrixa.revealDeviceErrors",
  lineNumbers: "kobrixa.lineNumbers",
  minimap: "kobrixa.minimap",
  renderWhitespace: "kobrixa.renderWhitespace",
  formatOnPaste: "kobrixa.formatOnPaste",
  autoSave: "kobrixa.autoSave",
  autoSaveDelay: "kobrixa.autoSaveDelay",
  formatOnSave: "kobrixa.formatOnSave",
  locale: "kobrixa.locale",
  theme: THEME_KEY,
  uiScale: "kobrixa.uiScale",
  codeSize: "kobrixa.codeSize",
  motion: "kobrixa.motion",
  wordWrap: "kobrixa.wordWrap",
  indentSize: "kobrixa.indentSize",
  ...LAYOUT_STORAGE_KEYS,
  toolTab: "kobrixa.tools.tab",
  rightPanel: "kobrixa.layout.rightPanel",
  ev3Tab: "kobrixa.layout.ev3Tab",
  bottomTab: "kobrixa.layout.bottomTab",
};
export function defaultSettings(language: string): Settings {
  return {
    ...EDITOR_DEFAULTS,
    connectionMode: "usb",
    rememberWifiAddress: false,
    revealDiagnostics: "errors",
    revealDeviceErrors: true,
    lineNumbers: "on",
    minimap: false,
    renderWhitespace: "selection",
    formatOnPaste: true,
    autoSave: "off",
    autoSaveDelay: 1000,
    formatOnSave: false,
    locale: language.toLowerCase().startsWith("zh") ? "zh-TW" : "en",
    theme: "dark",
    uiScale: 100,
    codeSize: 16,
    motion: "system",
    wordWrap: false,
    indentSize: 2,
    ...LAYOUT_DEFAULTS,
    toolTab: "connection",
    rightPanel: null,
    ev3Tab: "connection",
    bottomTab: "problems",
  };
}
export function readSettings(storage: Pick<Storage, "getItem">, language: string): Settings {
  const result = defaultSettings(language);
  for (const [key, options] of Object.entries(SETTINGS_CHOICES)) {
    const raw = storage.getItem(SETTINGS_KEYS[key as keyof Settings]);
    const selected = options.find((value) => String(value) === raw);
    if (selected !== undefined) Object.assign(result, { [key]: selected });
  }
  for (const key of Object.keys(result) as (keyof Settings)[]) {
    if (typeof result[key] !== "boolean") continue;
    const raw = storage.getItem(SETTINGS_KEYS[key]);
    if (raw === "true" || raw === "false") Object.assign(result, { [key]: raw === "true" });
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
  if (storage.getItem(SETTINGS_KEYS.rightPanel) === null) {
    result.rightPanel = result.deviceOpen
      ? result.toolTab === "collab"
        ? "collab"
        : result.toolTab === "activity"
          ? null
          : "ev3"
      : null;
    if (["connection", "monitor", "files"].includes(result.toolTab))
      result.ev3Tab = result.toolTab as Settings["ev3Tab"];
    if (result.deviceOpen && result.toolTab === "activity") {
      result.bottomTab = "activity";
      result.problemsOpen = true;
    }
  }
  return result;
}
/** One source for both quick controls and the settings page; writes never block editing. */
export class SettingsStore {
  private state: SettingsSnapshot;
  private wifiAddress = "";
  readonly defaults: Settings;
  private listeners = new Set<() => void>();
  constructor(
    private storage: StorageAccess,
    language: string,
  ) {
    this.defaults = defaultSettings(language);
    try {
      this.state = { values: readSettings(storage(), language), saveError: false };
      if (this.state.values.rememberWifiAddress)
        this.wifiAddress = storage().getItem(WIFI_ADDRESS_KEY)?.trim().slice(0, 45) ?? "";
    } catch {
      this.state = { values: defaultSettings(language), saveError: true };
    }
  }
  getWifiAddress = (): string => this.wifiAddress;
  rememberAddress(address: string): void {
    if (!this.state.values.rememberWifiAddress) return;
    this.wifiAddress = address.trim();
    this.save();
  }
  reset<K extends keyof Settings>(key: K): void {
    this.set(key, this.defaults[key]);
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
    if (key === "rememberWifiAddress" && !next) this.wifiAddress = "";
    this.save();
  }
  resetLayout = (): void => {
    this.state = {
      ...this.state,
      values: {
        ...this.state.values,
        ...LAYOUT_DEFAULTS,
        toolTab: "connection",
        rightPanel: null,
        ev3Tab: "connection",
        bottomTab: "problems",
      },
    };
    this.save();
  };
  save = (): void => {
    let saveError = false;
    try {
      const storage = this.storage();
      storage.setItem(
        WIFI_ADDRESS_KEY,
        this.state.values.rememberWifiAddress ? this.wifiAddress : "",
      );
      for (const key of Object.keys(SETTINGS_KEYS) as (keyof Settings)[])
        storage.setItem(SETTINGS_KEYS[key], String(this.state.values[key]));
    } catch {
      saveError = true;
    }
    this.state = { ...this.state, saveError };
    this.listeners.forEach((listener) => listener());
  };
}
export function applyAppearance(
  values: Settings,
  root: HTMLElement,
  systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
): void {
  root.dataset.theme = resolveTheme(values.theme, systemDark);
  root.dataset.motion = values.motion;
  root.lang = values.locale;
  root.style.setProperty("--ui-scale", String(values.uiScale / 100));
}
