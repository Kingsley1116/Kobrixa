import { UpdatesPanel } from "../updates/updates.js";
import type { UpdateState } from "../../shared/updates.js";
import { SettingSelect, SettingToggle } from "./setting-field.js";
import { ClosableTab } from "../components/closable-tab.js";
import type { KeyboardSettings } from "../keybindings/keyboard-state.js";
import { ShortcutsPanel } from "../keybindings/shortcuts-panel.js";
import { useEffect, useRef, useState } from "react";
import type { Locale } from "../i18n/copy.js";
import { defaultSettings, type Settings } from "./settings.js";
import {
  CATEGORY_LABELS,
  filterSettings,
  localText,
  type CatalogContext,
  type SettingDefinition,
  type SettingsCategory,
} from "./settings-catalog.js";
import { useDevicePreferences } from "./device-settings.js";
import type { FilePreferencesState } from "./file-settings.js";
import type { Theme } from "./theme.js";
import type { UpdatePreferences } from "../../shared/updates.js";
import { Icon } from "../components/icon.js";
import { Picker } from "../components/picker.js";
const languageOptions: { value: Locale; label: string }[] = [
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
];
export const settingsCopy = {
  en: {
    title: "Settings",
    updates: "Updates",
    close: "Close settings",
    language: "Language",
    appearance: "General & appearance",
    editor: "Editor",
    layout: "Workspace layout",
    shortcuts: "Keyboard shortcuts",
    saving: "Saving",
    intro: "Preferences are saved automatically and shared by all projects on this computer.",
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
    updates: "更新",
    close: "關閉設定",
    language: "語言",
    appearance: "一般與外觀",
    editor: "編輯器",
    layout: "工作區布局",
    shortcuts: "快捷鍵",
    saving: "儲存",
    intro: "設定適用於本機所有專案，變更會自動保存。",
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
  resolvedTheme,
  onChange,
  onOpen,
  shortcut,
}: {
  settings: Settings;
  resolvedTheme: Theme;
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
        aria-label={resolvedTheme === "dark" ? t.light : t.dark}
        title={resolvedTheme === "dark" ? t.light : t.dark}
        onClick={() => onChange("theme", resolvedTheme === "dark" ? "light" : "dark")}
      >
        <Icon name={resolvedTheme === "dark" ? "sun" : "moon"} />
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
    <ClosableTab
      className="settings-tab"
      active={active}
      controls="settings-page"
      onSelect={onSelect}
      onClose={onClose}
      closeLabel={t.close}
      closeTitle={[t.close, shortcut].filter(Boolean).join(" · ")}
    >
      <Icon name="settings" />
      <span>{t.title}</span>
    </ClosableTab>
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
  updates,
  updateBusy,
  onInstallUpdate,
  reducedMotion,
  filePreferences,
}: {
  filePreferences: FilePreferencesState;
  updates: UpdateState | undefined;
  updateBusy: boolean;
  onInstallUpdate(): void;
  keyboard: KeyboardSettings;
  requestedCategory: { category: "appearance" | "shortcuts" | "updates"; request: number };
  settings: Settings;
  onChange: Change;
  onReset(): void;
  active: boolean;
  saveError: boolean;
  onRetry(): void;
  reducedMotion: boolean;
}): React.JSX.Element {
  const t = settingsCopy[settings.locale];
  const local = (zh: string, en: string) => (settings.locale === "zh-TW" ? zh : en);
  const [category, setCategory] = useState<SettingsCategory | "all" | "shortcuts">("appearance");
  const [query, setQuery] = useState("");
  const [modified, setModified] = useState(false);
  const [defaults] = useState(() => defaultSettings(navigator.language));
  const device = useDevicePreferences();
  const [updateSaving, setUpdateSaving] = useState(false);
  const [updateError, setUpdateError] = useState(false);
  const updateFlight = useRef(false);
  const failedUpdate = useRef<Partial<UpdatePreferences>>(undefined);
  const updateValues = useRef(updates?.preferences);
  updateValues.current = updates?.preferences;
  const changeUpdates = async (patch: Partial<UpdatePreferences>) => {
    if (updateFlight.current || !updateValues.current) return;
    updateFlight.current = true;
    setUpdateSaving(true);
    setUpdateError(false);
    failedUpdate.current = patch;
    try {
      await window.kobrixa.updates.setPreferences({ ...updateValues.current, ...patch });
      failedUpdate.current = undefined;
    } catch {
      setUpdateError(true);
    } finally {
      updateFlight.current = false;
      setUpdateSaving(false);
    }
  };
  const context: CatalogContext = {
    settings,
    defaults,
    device: device.value,
    files: filePreferences.value,
    updates: updates?.preferences,
    reducedMotion,
    onChange,
    onDeviceChange: device.change,
    onFileChange: filePreferences.change,
    onUpdateChange: (patch) => {
      void changeUpdates(patch);
    },
  };
  useEffect(() => {
    setCategory(requestedCategory.category);
    setQuery("");
    setModified(false);
  }, [requestedCategory]);
  const title = useRef<HTMLHeadingElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (active) title.current?.focus({ preventScroll: true });
  }, [active]);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [category, query, modified]);
  const entries = filterSettings(context, query, modified).filter(
    (entry) => category === "all" || entry.category === category,
  );
  const searching = Boolean(query.trim() || modified);
  const labelValue = (entry: SettingDefinition, value: string | number | boolean) =>
    typeof value === "boolean"
      ? value
        ? t.on
        : t.off
      : localText(
          entry.options?.find((option) => option.value === value)?.label ?? [
            String(value),
            String(value),
          ],
          settings.locale,
        );
  const reset = (entry: SettingDefinition) => {
    // Focus a stable control before modified-only filtering can remove this row.
    if (modified) search.current?.focus();
    else document.getElementById(entry.controlId)?.focus();
    entry.change(context, entry.defaultValue(context));
  };
  const row = (entry: SettingDefinition) => {
    const value = entry.read(context);
    const defaultValue = entry.defaultValue(context);
    const changed = value !== undefined && value !== defaultValue;
    const reason = entry.disabled?.(context);
    const loading = value === undefined;
    const resetDisabled =
      loading ||
      (entry.source === "device" && device.busy) ||
      (entry.source === "files" && filePreferences.busy) ||
      (entry.source === "updates" &&
        (updateSaving || updates?.phase === "preparing" || updates?.phase === "installing"));
    const disabled = Boolean(reason) || resetDisabled;
    const motionOverride =
      reducedMotion && ["kobrixa.cursorBlinking", "kobrixa.smoothScrolling"].includes(entry.id);
    const hint = [
      localText(entry.hint, settings.locale),
      ...(reason ? [localText(reason, settings.locale)] : []),
      ...(motionOverride
        ? [local("目前減少動態效果已生效。", "Reduced motion is currently active.")]
        : []),
      ...(loading ? [local("正在載入設定…", "Loading preferences…")] : []),
    ].join(" ");
    const hintId = entry.id === "kobrixa.motion" ? "motion-hint" : `${entry.controlId}-hint`;
    return (
      <div
        className={`setting-entry${changed ? " is-modified" : ""}`}
        key={entry.id}
        data-setting-id={entry.id}
      >
        {entry.options ? (
          <SettingSelect
            id={entry.controlId}
            locale={settings.locale}
            label={localText(entry.label, settings.locale)}
            hint={hint}
            hintId={hintId}
            value={(value ?? defaultValue) as string | number}
            disabled={disabled}
            options={entry.options.map((option) => ({
              value: option.value,
              label: localText(option.label, settings.locale),
            }))}
            onChange={(next) => entry.change(context, next)}
          />
        ) : (
          <SettingToggle
            id={entry.controlId}
            label={localText(entry.label, settings.locale)}
            hint={hint}
            hintId={hintId}
            checked={value === true}
            disabled={disabled}
            onChange={(next) => entry.change(context, next)}
            onLabel={t.on}
            offLabel={t.off}
          />
        )}
        <div className="setting-footer">
          <span>
            {local("預設：", "Default: ")}
            {labelValue(entry, defaultValue)}
            {changed ? local(" · 已修改", " · Modified") : ""}
          </span>
          {changed && (
            <button
              type="button"
              disabled={resetDisabled}
              aria-label={`${local("還原", "Reset")} ${localText(entry.label, settings.locale)}`}
              onClick={() => reset(entry)}
            >
              {local("還原預設", "Reset to default")}
            </button>
          )}
        </div>
      </div>
    );
  };
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
        <div className="settings-search">
          <input
            ref={search}
            type="search"
            value={query}
            aria-label={local("搜尋設定", "Search settings")}
            placeholder={local("搜尋設定（支援中英文）", "Search settings in English or Chinese")}
            onChange={(event) => {
              setQuery(event.target.value);
              setCategory("all");
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={modified}
              onChange={(event) => {
                setModified(event.target.checked);
                setCategory("all");
              }}
            />
            {local("只看已修改", "Modified only")}
          </label>
          {searching && (
            <button
              onClick={() => {
                setQuery("");
                setModified(false);
                search.current?.focus();
              }}
            >
              {local("清除條件", "Clear filters")}
            </button>
          )}
        </div>
        {category !== "shortcuts" && (
          <p role="status">
            {local(`顯示 ${entries.length} 項設定`, `${entries.length} settings`)}
          </p>
        )}
      </header>
      {saveError && <SettingsError locale={settings.locale} onRetry={onRetry} />}
      {device.error && (
        <div role="alert" className="settings-save-error">
          <span>
            {local(
              "設備設定載入或保存失敗，既有值仍有效。",
              "Could not load or save device preferences. Existing values remain active.",
            )}
          </span>
          <button disabled={device.busy} onClick={device.retry}>
            {t.retry}
          </button>
        </div>
      )}
      {updateError && (
        <div role="alert" className="settings-save-error">
          <span>
            {local(
              "更新偏好保存失敗，既有值仍有效。",
              "Could not save update preferences. Existing values remain active.",
            )}
          </span>
          <button
            disabled={updateSaving}
            onClick={() => {
              if (failedUpdate.current) void changeUpdates(failedUpdate.current);
            }}
          >
            {t.retry}
          </button>
        </div>
      )}
      {filePreferences.error && (
        <div role="alert" className="settings-save-error" data-preferences-error="files">
          <span>
            {local(
              "檔案與歷史設定載入或保存失敗，既有值仍有效。",
              "Could not load or save file and history preferences. Existing values remain active.",
            )}
          </span>
          <button disabled={filePreferences.busy} onClick={filePreferences.retry}>
            {t.retry}
          </button>
        </div>
      )}
      <div className="settings-body">
        <nav className="settings-categories" aria-label={t.title}>
          {(
            [
              "all",
              "appearance",
              "editor",
              "saving",
              "fileHistory",
              "layout",
              "device",
              "shortcuts",
              "updates",
            ] as const
          ).map((value) => (
            <button
              key={value}
              aria-current={category === value ? "page" : undefined}
              onClick={() => setCategory(value)}
            >
              {value === "all"
                ? local("全部設定", "All settings")
                : value === "shortcuts"
                  ? t.shortcuts
                  : localText(CATEGORY_LABELS[value], settings.locale)}
            </button>
          ))}
        </nav>
        <div className="settings-content" ref={content}>
          {category === "shortcuts" ? (
            active && <ShortcutsPanel keyboard={keyboard} locale={settings.locale} />
          ) : (
            <>
              {entries.length === 0 && (
                <p className="settings-empty">
                  {local(
                    "沒有符合的設定。試試其他關鍵字，或清除條件。",
                    "No matching settings. Try another keyword or clear the filters.",
                  )}
                </p>
              )}
              {(Object.keys(CATEGORY_LABELS) as SettingsCategory[]).map((group) => {
                const groupEntries = entries.filter((entry) => entry.category === group);
                if (!groupEntries.length && category !== group) return null;
                return (
                  <section key={group} aria-labelledby={`settings-${group}`}>
                    <h2 id={`settings-${group}`}>
                      {localText(CATEGORY_LABELS[group], settings.locale)}
                    </h2>
                    {group === "device" && (
                      <p className="settings-hint">
                        {local(
                          "設備參數成功保存後生效；連線偏好立即套用。",
                          "Device parameters take effect after saving successfully; connection preferences apply immediately.",
                        )}
                      </p>
                    )}
                    {group === "fileHistory" && (
                      <p className="settings-hint">
                        {local(
                          "設定成功保存後生效，適用於這部電腦的所有專案。降低保留上限會在下次歷史操作清理較早版本。",
                          "Changes take effect after saving successfully and apply to every project on this computer. Lower retention limits are enforced at the next history operation.",
                        )}
                      </p>
                    )}
                    {groupEntries.map(row)}
                    {group === "layout" && !searching && (
                      <div className="settings-reset">
                        <button onClick={onReset}>{t.reset}</button>
                        <p>{t.resetHint}</p>
                      </div>
                    )}
                    {group === "updates" && category === "updates" && !searching && (
                      <UpdatesPanel
                        state={updates}
                        locale={settings.locale}
                        busy={updateBusy}
                        onInstall={onInstallUpdate}
                        showPreferences={false}
                      />
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
