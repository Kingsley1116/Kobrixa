import type { KeyboardSettings } from "./keyboard-state.js";
import { ShortcutsPanel } from "./shortcuts-panel.js";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "./copy.js";
import { AUTO_SAVE_DELAYS, CODE_SIZES, UI_SCALES, type Settings } from "./settings.js";
import { Icon } from "./workbench-ui.js";
import { Picker } from "./picker.js";
const languageOptions: { value: Locale; label: string }[] = [
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];
export const settingsCopy = {
  en: {
    title: "Settings",
    close: "Close settings",
    language: "Language",
    appearance: "General & appearance",
    editor: "Editor",
    layout: "Workspace layout",
    shortcuts: "Keyboard shortcuts",
    saving: "Saving",
    intro: "Changes take effect immediately and are saved on this computer.",
    theme: "Theme",
    dark: "Dark",
    light: "Light",
    scale: "Interface size",
    motion: "Motion",
    system: "Follow system",
    reduce: "Reduce motion",
    motionHint: "Applies to panels, menus, smooth scrolling and the editor cursor.",
    codeSize: "Code font size",
    wordWrap: "Word wrap",
    wrapHint: "Wrap long lines to fit the editor. The file contents stay the same.",
    indent: "Indentation",
    spaces: "spaces",
    indentHint:
      "Used for typing and formatting. Existing text is only reformatted when you request it.",
    files: "File tree",
    device: "EV3 tools",
    problems: "Diagnostics panel",
    layoutHint: "Panel visibility and widths are remembered. Drag their borders to resize them.",
    reset: "Restore default layout",
    resetHint:
      "Show the 220px file tree; collapse EV3 tools (360px) and diagnostics (180px). Your files and EV3 connection are kept.",
    error: "Settings apply for this session, but could not be saved on this computer.",
    retry: "Retry saving",
    on: "On",
    off: "Off",
  },
  "zh-TW": {
    title: "設定",
    close: "關閉設定",
    language: "語言",
    appearance: "一般與外觀",
    editor: "編輯器",
    layout: "工作區布局",
    shortcuts: "快捷鍵",
    saving: "儲存",
    intro: "調整立即生效，並自動保存在這台電腦。",
    theme: "主題",
    dark: "深色",
    light: "淺色",
    scale: "介面大小",
    motion: "動態效果",
    system: "依系統設定",
    reduce: "減少動態效果",
    motionHint: "套用到面板、選單、平滑捲動與編輯器游標。",
    codeSize: "程式碼字級",
    wordWrap: "自動換行",
    wrapHint: "長行依編輯區寬度換行顯示，不改變檔案內容。",
    indent: "縮排大小",
    spaces: "個空格",
    indentHint: "套用到輸入與格式化；只有執行格式化時才會重新排版既有內容。",
    files: "檔案樹",
    device: "EV3 工具面板",
    problems: "診斷面板",
    layoutHint: "記住面板的顯示狀態與寬度，可拖曳邊界調整大小。",
    reset: "恢復預設布局",
    resetHint: "展開 220px 檔案樹，收合 EV3 工具（360px）與診斷（180px）；保留檔案及 EV3 連線。",
    error: "設定在本次使用期間已生效，但無法保存在這台電腦。",
    retry: "重試保存",
    on: "開啟",
    off: "關閉",
  },
};
type Change = <K extends keyof Settings>(key: K, value: Settings[K]) => void;
export function SettingsQuickControls({
  settings,
  onChange,
  onOpen,
  shortcut,
}: {
  settings: Settings;
  onChange: Change;
  onOpen(): void;
  shortcut: string;
}): React.JSX.Element {
  const t = settingsCopy[settings.locale];
  return (
    <>
      <Picker
        label={t.language}
        locale={settings.locale}
        triggerContent={<Icon name="language" />}
        value={settings.locale}
        options={languageOptions}
        onChange={(value) => onChange("locale", value)}
      />
      <button
        aria-label={settings.theme === "dark" ? t.light : t.dark}
        title={settings.theme === "dark" ? t.light : t.dark}
        onClick={() => onChange("theme", settings.theme === "dark" ? "light" : "dark")}
      >
        <Icon name={settings.theme === "dark" ? "sun" : "moon"} />
      </button>
      <button
        className="settings-trigger"
        aria-label={t.title}
        title={[t.title, shortcut].filter(Boolean).join(" · ")}
        onClick={onOpen}
      >
        <Icon name="settings" />
      </button>
    </>
  );
}
export function SettingsTab({
  locale,
  active,
  onSelect,
  onClose,
  shortcut,
}: {
  locale: Locale;
  active: boolean;
  onSelect(): void;
  onClose(): void;
  shortcut: string;
}): React.JSX.Element {
  const t = settingsCopy[locale];
  return (
    <div className={`tab settings-tab ${active ? "active" : ""}`}>
      <button
        className="tab-select"
        role="tab"
        aria-selected={active}
        aria-controls="settings-page"
        onClick={onSelect}
      >
        <Icon name="settings" />
        <span>{t.title}</span>
      </button>
      <button
        className="tab-close"
        aria-label={t.close}
        title={[t.close, shortcut].filter(Boolean).join(" · ")}
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
export function SettingsError({
  locale,
  onRetry,
}: {
  locale: Locale;
  onRetry(): void;
}): React.JSX.Element {
  const t = settingsCopy[locale];
  return (
    <div className="settings-save-error" role="alert">
      <span>{t.error}</span>
      <button onClick={onRetry}>{t.retry}</button>
    </div>
  );
}
export function SettingsPanel({
  settings,
  onChange,
  onReset,
  active,
  saveError,
  onRetry,
  keyboard,
  requestedCategory,
}: {
  keyboard: KeyboardSettings;
  requestedCategory: { category: "appearance" | "shortcuts"; request: number };
  settings: Settings;
  onChange: Change;
  onReset(): void;
  active: boolean;
  saveError: boolean;
  onRetry(): void;
}): React.JSX.Element {
  const t = settingsCopy[settings.locale];
  const [category, setCategory] = useState<
    "appearance" | "editor" | "saving" | "layout" | "shortcuts"
  >("appearance");
  const local = (zh: string, en: string) => (settings.locale === "zh-TW" ? zh : en);
  useEffect(() => setCategory(requestedCategory.category), [requestedCategory]);
  const title = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) title.current?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [category]);
  const toggle = (
    key:
      | "wordWrap"
      | "filesOpen"
      | "deviceOpen"
      | "problemsOpen"
      | "minimap"
      | "formatOnPaste"
      | "formatOnSave",
    label: string,
    hint?: string,
  ) => (
    <div className="setting-row">
      <div>
        <label htmlFor={`setting-${key}`}>{label}</label>
        {hint && <p id={`hint-${key}`}>{hint}</p>}
      </div>
      <button
        id={`setting-${key}`}
        type="button"
        className="setting-switch"
        role="switch"
        aria-checked={settings[key]}
        aria-label={label}
        aria-describedby={hint ? `hint-${key}` : undefined}
        onClick={() => onChange(key, !settings[key])}
      >
        <span aria-hidden="true" />
        {settings[key] ? t.on : t.off}
      </button>
    </div>
  );
  return (
    <section
      className="settings-page"
      id="settings-page"
      hidden={!active}
      aria-labelledby="settings-title"
    >
      <header className="settings-heading">
        <h1 id="settings-title" ref={title} tabIndex={-1}>
          {t.title}
        </h1>
        <p>{t.intro}</p>
      </header>
      {saveError && <SettingsError locale={settings.locale} onRetry={onRetry} />}
      <div className="settings-body">
        <nav className="settings-categories" aria-label={t.title}>
          {(["appearance", "editor", "saving", "layout", "shortcuts"] as const).map((value) => (
            <button
              key={value}
              aria-current={category === value ? "page" : undefined}
              onClick={() => setCategory(value)}
            >
              {t[value]}
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={content}>
          <section hidden={category !== "appearance"} aria-labelledby="settings-appearance">
            <h2 id="settings-appearance">{t.appearance}</h2>
            <div className="setting-row">
              <label htmlFor="setting-locale">{t.language}</label>
              <Picker
                locale={settings.locale}
                label={t.language}
                id="setting-locale"
                value={settings.locale}
                onChange={(value) => onChange("locale", value)}
                options={languageOptions}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="setting-theme">{t.theme}</label>
              <Picker<Settings["theme"]>
                locale={settings.locale}
                label={t.theme}
                id="setting-theme"
                value={settings.theme}
                onChange={(value) => onChange("theme", value)}
                options={[
                  { value: "dark", label: t.dark },
                  { value: "light", label: t.light },
                ]}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="setting-scale">{t.scale}</label>
              <Picker
                locale={settings.locale}
                label={t.scale}
                id="setting-scale"
                value={settings.uiScale}
                onChange={(value) => onChange("uiScale", value)}
                options={UI_SCALES.map((value) => ({ value, label: `${value}%` }))}
              />
            </div>
            <div className="setting-row">
              <div>
                <label htmlFor="setting-motion">{t.motion}</label>
                <p id="motion-hint">{t.motionHint}</p>
              </div>
              <Picker<Settings["motion"]>
                locale={settings.locale}
                label={t.motion}
                id="setting-motion"
                describedBy="motion-hint"
                value={settings.motion}
                onChange={(value) => onChange("motion", value)}
                options={[
                  { value: "system", label: t.system },
                  { value: "reduce", label: t.reduce },
                ]}
              />
            </div>
          </section>
          <section hidden={category !== "editor"} aria-labelledby="settings-editor">
            <h2 id="settings-editor">{t.editor}</h2>
            <div className="setting-row">
              <label htmlFor="setting-codeSize">{t.codeSize}</label>
              <Picker
                locale={settings.locale}
                label={t.codeSize}
                id="setting-codeSize"
                value={settings.codeSize}
                onChange={(value) => onChange("codeSize", value)}
                options={CODE_SIZES.map((value) => ({ value, label: `${value}px` }))}
              />
            </div>
            <div className="setting-row">
              <label htmlFor="setting-lineNumbers">{local("行號", "Line numbers")}</label>
              <Picker
                locale={settings.locale}
                label={local("行號", "Line numbers")}
                id="setting-lineNumbers"
                value={settings.lineNumbers}
                onChange={(value) => onChange("lineNumbers", value)}
                options={[
                  { value: "on", label: local("顯示", "On") },
                  { value: "relative", label: local("相對行號", "Relative") },
                  { value: "off", label: local("隱藏", "Off") },
                ]}
              />
            </div>
            {toggle("minimap", local("程式碼縮圖", "Minimap"))}
            <div className="setting-row">
              <label htmlFor="setting-whitespace">{local("空白字元", "Whitespace")}</label>
              <Picker
                locale={settings.locale}
                label={local("空白字元", "Whitespace")}
                id="setting-whitespace"
                value={settings.renderWhitespace}
                onChange={(value) => onChange("renderWhitespace", value)}
                options={[
                  { value: "none", label: local("不顯示", "None") },
                  { value: "selection", label: local("選取範圍", "Selection") },
                  { value: "all", label: local("全部", "All") },
                ]}
              />
            </div>
            {toggle("formatOnPaste", local("貼上時格式化", "Format on paste"))}
            {toggle("wordWrap", t.wordWrap, t.wrapHint)}
            <div className="setting-row">
              <div>
                <label htmlFor="setting-indent">{t.indent}</label>
                <p id="indent-hint">{t.indentHint}</p>
              </div>
              <Picker<Settings["indentSize"]>
                locale={settings.locale}
                label={t.indent}
                id="setting-indent"
                describedBy="indent-hint"
                value={settings.indentSize}
                onChange={(value) => onChange("indentSize", value)}
                options={([2, 4] as const).map((value) => ({
                  value,
                  label: `${value} ${t.spaces}`,
                }))}
              />
            </div>
          </section>
          <section hidden={category !== "saving"} aria-labelledby="settings-saving">
            <h2 id="settings-saving">{t.saving}</h2>
            <div className="setting-row">
              <label htmlFor="setting-autoSave">{local("自動儲存", "Auto save")}</label>
              <Picker
                locale={settings.locale}
                label={local("自動儲存", "Auto save")}
                id="setting-autoSave"
                value={settings.autoSave}
                onChange={(value) => onChange("autoSave", value)}
                options={[
                  { value: "off", label: t.off },
                  { value: "afterDelay", label: local("停止輸入後", "After delay") },
                  { value: "onFocusChange", label: local("離開編輯器時", "On focus change") },
                ]}
              />
            </div>
            {settings.autoSave === "afterDelay" && (
              <div className="setting-row">
                <label htmlFor="setting-autoSaveDelay">
                  {local("自動儲存延遲", "Auto save delay")}
                </label>
                <Picker
                  locale={settings.locale}
                  label={local("自動儲存延遲", "Auto save delay")}
                  id="setting-autoSaveDelay"
                  value={settings.autoSaveDelay}
                  onChange={(value) => onChange("autoSaveDelay", value)}
                  options={AUTO_SAVE_DELAYS.map((value) => ({ value, label: `${value} ms` }))}
                />
              </div>
            )}
            {toggle(
              "formatOnSave",
              local("儲存時格式化", "Format on save"),
              local(
                "套用到手動儲存、全部儲存與編譯／執行前儲存。自動儲存只保存內容。",
                "Applies to manual saves, Save all and saves before building/running. Auto save only saves the contents.",
              ),
            )}
          </section>
          <section hidden={category !== "shortcuts"}>
            {category === "shortcuts" && active && (
              <ShortcutsPanel keyboard={keyboard} locale={settings.locale} />
            )}
          </section>
          <section hidden={category !== "layout"} aria-labelledby="settings-layout">
            <h2 id="settings-layout">{t.layout}</h2>
            <p className="settings-hint">{t.layoutHint}</p>
            {toggle("filesOpen", t.files)}
            {toggle("deviceOpen", t.device)}
            {toggle("problemsOpen", t.problems)}
            <div className="settings-reset">
              <button onClick={onReset}>{t.reset}</button>
              <p>{t.resetHint}</p>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
