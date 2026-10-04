import type { Locale } from "../i18n/copy.js";
import { SETTINGS_CHOICES, type Settings } from "./settings.js";
import {
  DEFAULT_DEVICE_PREFERENCES,
  USB_RETRY_INTERVALS,
  USB_RETRY_LIMITS,
  WIFI_CONNECT_TIMEOUTS,
  WIFI_HANDSHAKE_TIMEOUTS,
  type DevicePreferences,
} from "../../shared/device-preferences.js";
import type { UpdatePreferences } from "../../shared/updates.js";

export type Text = readonly [zh: string, en: string];
export const localText = (text: Text, locale: Locale): string => text[locale === "zh-TW" ? 0 : 1];
export const CATEGORY_LABELS = {
  appearance: ["一般與外觀", "General & appearance"],
  editor: ["編輯器", "Editor"],
  saving: ["儲存", "Saving"],
  layout: ["工作區布局", "Workspace layout"],
  device: ["EV3 與執行", "EV3 & execution"],
  updates: ["更新", "Updates"],
} as const satisfies Record<string, Text>;
export type SettingsCategory = keyof typeof CATEGORY_LABELS;
export type SettingValue = string | number | boolean;
export interface CatalogContext {
  settings: Settings;
  defaults: Settings;
  device: DevicePreferences | undefined;
  updates: UpdatePreferences | undefined;
  reducedMotion: boolean;
  onChange<K extends keyof Settings>(key: K, value: Settings[K]): void;
  onDeviceChange(patch: Partial<DevicePreferences>): void;
  onUpdateChange(patch: Partial<UpdatePreferences>): void;
}
export interface SettingDefinition {
  id: string;
  controlId: string;
  category: SettingsCategory;
  label: Text;
  hint: Text;
  keywords?: string;
  source: "app" | "device" | "updates";
  options?: readonly { value: string | number; label: Text }[];
  read(context: CatalogContext): SettingValue | undefined;
  defaultValue(context: CatalogContext): SettingValue;
  change(context: CatalogContext, value: SettingValue): void;
  disabled?(context: CatalogContext): Text | undefined;
}
const options = (values: readonly (string | number)[], labels?: readonly Text[]) =>
  values.map((value, index) => ({
    value,
    label: labels?.[index] ?? ([String(value), String(value)] as Text),
  }));
const seconds = (values: readonly number[]) =>
  options(
    values,
    values.map((value) => [`${value / 1000} 秒`, `${value / 1000} seconds`]),
  );
const app = <K extends keyof Settings>(
  key: K,
  category: SettingsCategory,
  label: Text,
  hint: Text,
  extra: Partial<Pick<SettingDefinition, "options" | "disabled" | "keywords">> = {},
): SettingDefinition => ({
  id: `kobrixa.${key}`,
  controlId: `setting-${({ uiScale: "scale", indentSize: "indent", renderWhitespace: "whitespace" } as Record<string, string>)[key] ?? key}`,
  source: "app",
  category,
  label,
  hint,
  ...extra,
  read: (context) => context.settings[key],
  defaultValue: (context) => context.defaults[key],
  change: (context, value) => context.onChange(key, value as Settings[K]),
});
const device = <K extends keyof DevicePreferences>(
  key: K,
  label: Text,
  hint: Text,
  choices?: SettingDefinition["options"],
): SettingDefinition => ({
  id: `device.${key}`,
  controlId: `setting-${key}`,
  source: "device",
  category: "device",
  label,
  hint,
  ...(choices ? { options: choices } : {}),
  read: (context) => context.device?.[key],
  defaultValue: () => DEFAULT_DEVICE_PREFERENCES[key],
  change: (context, value) => context.onDeviceChange({ [key]: value }),
  ...(key === "usbRetryInterval" || key === "usbRetryLimit"
    ? {
        disabled: (context: CatalogContext): Text | undefined =>
          context.device?.usbAutoReconnect === false
            ? ["啟用 USB 自動重連後可調整。", "Enable USB automatic reconnect to adjust this."]
            : undefined,
      }
    : {}),
});
const enabledHint: Text = ["調整立即套用到編輯器。", "Changes apply to the editor immediately."];
export const SETTINGS_CATALOG: readonly SettingDefinition[] = [
  app(
    "locale",
    "appearance",
    ["語言", "Language"],
    ["設定介面顯示語言。", "Choose the interface language."],
    {
      options: options(SETTINGS_CHOICES.locale, [
        ["English", "English"],
        ["繁體中文", "繁體中文"],
      ]),
    },
  ),
  app(
    "theme",
    "appearance",
    ["主題", "Theme"],
    [
      "依系統設定會自動跟隨系統深淺外觀。",
      "Follow system tracks your system's light or dark appearance.",
    ],
    {
      options: options(SETTINGS_CHOICES.theme, [
        ["深色", "Dark"],
        ["淺色", "Light"],
        ["依系統設定", "Follow system"],
      ]),
    },
  ),
  app(
    "uiScale",
    "appearance",
    ["介面大小", "Interface size"],
    ["調整介面文字與控制項大小。", "Scale interface text and controls."],
    {
      options: options(
        SETTINGS_CHOICES.uiScale,
        SETTINGS_CHOICES.uiScale.map((v) => [`${v}%`, `${v}%`]),
      ),
    },
  ),
  app(
    "motion",
    "appearance",
    ["動態效果", "Motion"],
    [
      "套用到面板、選單、平滑捲動與編輯器游標。",
      "Applies to panels, menus, smooth scrolling and the editor cursor.",
    ],
    {
      options: options(SETTINGS_CHOICES.motion, [
        ["依系統設定", "Follow system"],
        ["減少動態效果", "Reduce motion"],
      ]),
    },
  ),
  app("codeSize", "editor", ["程式碼字級", "Code font size"], enabledHint, {
    options: options(
      SETTINGS_CHOICES.codeSize,
      SETTINGS_CHOICES.codeSize.map((v) => [`${v}px`, `${v}px`]),
    ),
  }),
  app(
    "lineHeight",
    "editor",
    ["行距", "Line height"],
    [
      "依程式碼字級計算，標準沿用原本行距。",
      "Relative to font size; standard preserves the original line height.",
    ],
    {
      options: options(SETTINGS_CHOICES.lineHeight, [
        ["緊湊（1.4 倍）", "Compact (1.4×)"],
        ["標準", "Standard"],
        ["寬鬆（1.8 倍）", "Relaxed (1.8×)"],
      ]),
    },
  ),
  app("lineNumbers", "editor", ["行號", "Line numbers"], enabledHint, {
    options: options(SETTINGS_CHOICES.lineNumbers, [
      ["顯示", "On"],
      ["相對行號", "Relative"],
      ["隱藏", "Off"],
    ]),
  }),
  app("minimap", "editor", ["程式碼縮圖", "Minimap"], enabledHint),
  app("renderWhitespace", "editor", ["空白字元", "Whitespace"], enabledHint, {
    options: options(SETTINGS_CHOICES.renderWhitespace, [
      ["不顯示", "None"],
      ["選取範圍", "Selection"],
      ["全部", "All"],
    ]),
  }),
  app(
    "wordWrap",
    "editor",
    ["自動換行", "Word wrap"],
    [
      "長行依編輯區寬度換行顯示，不改變檔案內容。",
      "Wrap long lines to fit the editor without changing file contents.",
    ],
  ),
  app(
    "indentSize",
    "editor",
    ["縮排大小", "Indentation"],
    [
      "套用到輸入與格式化；只有執行格式化時才會重新排版既有內容。",
      "Used for typing and formatting. Existing text changes only when formatted.",
    ],
    {
      options: options(SETTINGS_CHOICES.indentSize, [
        ["2 個空格", "2 spaces"],
        ["4 個空格", "4 spaces"],
      ]),
    },
  ),
  app("cursorStyle", "editor", ["游標樣式", "Cursor style"], enabledHint, {
    options: options(SETTINGS_CHOICES.cursorStyle, [
      ["直線", "Line"],
      ["方塊", "Block"],
      ["底線", "Underline"],
    ]),
  }),
  app(
    "cursorBlinking",
    "editor",
    ["游標閃爍", "Cursor blinking"],
    [
      "減少動態效果生效時暫停閃爍，保留此偏好。",
      "Reduced motion pauses blinking while preserving this preference.",
    ],
  ),
  app("renderLineHighlight", "editor", ["目前行醒目提示", "Current line highlight"], enabledHint, {
    options: options(SETTINGS_CHOICES.renderLineHighlight, [
      ["關閉", "Off"],
      ["程式碼行", "Code line"],
      ["含行號區", "Line and gutter"],
    ]),
  }),
  app(
    "bracketPairColorization",
    "editor",
    ["括號配色", "Bracket pair colors"],
    ["用不同顏色辨識巢狀括號。", "Color nested bracket pairs."],
    { keywords: "colorization 顏色" },
  ),
  app("bracketGuides", "editor", ["括號輔助線", "Bracket guides"], enabledHint),
  app("indentationGuides", "editor", ["縮排輔助線", "Indentation guides"], enabledHint),
  app(
    "folding",
    "editor",
    ["程式碼摺疊", "Code folding"],
    ["顯示收合與展開程式區塊的控制項。", "Show controls to collapse and expand code blocks."],
  ),
  app(
    "stickyScroll",
    "editor",
    ["頂端固定程式區塊", "Sticky scroll"],
    [
      "捲動時在頂端保留最多三行所在區塊。",
      "Keep up to three enclosing scope lines visible while scrolling.",
    ],
  ),
  app(
    "autoClosingBrackets",
    "editor",
    ["自動補齊括號", "Auto-close brackets"],
    ["依語言規則補上成對括號。", "Complete bracket pairs according to language rules."],
  ),
  app(
    "autoClosingQuotes",
    "editor",
    ["自動補齊引號", "Auto-close quotes"],
    ["依語言規則補上成對引號。", "Complete quote pairs according to language rules."],
  ),
  app(
    "autoSuggestions",
    "editor",
    ["自動補全提示", "Automatic suggestions"],
    [
      "輸入文字或觸發字元時顯示補全；關閉後仍可用快捷鍵叫出。",
      "Suggest while typing words or trigger characters. Manual completion remains available when off.",
    ],
    { keywords: "autocomplete intellisense completion 自動完成" },
  ),
  app("hover", "editor", ["滑鼠懸停說明", "Hover information"], enabledHint),
  app("parameterHints", "editor", ["函式參數提示", "Parameter hints"], enabledHint),
  app(
    "smoothScrolling",
    "editor",
    ["平滑捲動", "Smooth scrolling"],
    [
      "減少動態效果生效時暫停平滑捲動，保留此偏好。",
      "Reduced motion disables smooth scrolling while preserving this preference.",
    ],
  ),
  app(
    "scrollBeyondLastLine",
    "editor",
    ["捲動超過最後一行", "Scroll beyond last line"],
    enabledHint,
  ),
  app("formatOnPaste", "editor", ["貼上時格式化", "Format on paste"], enabledHint),
  app(
    "autoSave",
    "saving",
    ["自動儲存", "Auto save"],
    ["自動儲存只保存內容，不會格式化。", "Automatic saves preserve contents without formatting."],
    {
      options: options(SETTINGS_CHOICES.autoSave, [
        ["關閉", "Off"],
        ["停止輸入後", "After delay"],
        ["離開編輯器時", "On focus change"],
      ]),
    },
  ),
  app(
    "autoSaveDelay",
    "saving",
    ["自動儲存延遲", "Auto save delay"],
    ["停止輸入後等待多久才儲存。", "How long to wait after typing before saving."],
    {
      options: options(
        SETTINGS_CHOICES.autoSaveDelay,
        SETTINGS_CHOICES.autoSaveDelay.map((v) => [`${v} ms`, `${v} ms`]),
      ),
      disabled: (context) =>
        context.settings.autoSave !== "afterDelay"
          ? ["先將自動儲存設為「停止輸入後」。", "Select After delay in Auto save first."]
          : undefined,
    },
  ),
  app(
    "formatOnSave",
    "saving",
    ["儲存時格式化", "Format on save"],
    [
      "套用到手動儲存、全部儲存與編譯／執行前儲存。自動儲存只保存內容。",
      "Applies to manual saves, Save all and saves before building/running. Auto save only saves the contents.",
    ],
  ),
  app(
    "filesOpen",
    "layout",
    ["檔案樹", "File tree"],
    ["顯示工作區檔案。", "Show workspace files."],
  ),
  app(
    "deviceOpen",
    "layout",
    ["EV3 工具面板", "EV3 tools"],
    [
      "顯示設備連線、即時監測、檔案與活動。",
      "Show device connection, live monitoring, files and activity.",
    ],
  ),
  app(
    "problemsOpen",
    "layout",
    ["診斷面板", "Diagnostics panel"],
    ["顯示錯誤與警告清單。", "Show the errors and warnings list."],
  ),
  app(
    "connectionMode",
    "device",
    ["連線方式", "Connection method"],
    [
      "記住 USB／Wi-Fi 選擇，供下一次連線使用。",
      "Remember USB/Wi-Fi selection for the next connection.",
    ],
    {
      options: options(SETTINGS_CHOICES.connectionMode, [
        ["USB", "USB"],
        ["Wi-Fi", "Wi-Fi"],
      ]),
    },
  ),
  app(
    "rememberWifiAddress",
    "device",
    ["記住 Wi-Fi 位址", "Remember Wi-Fi address"],
    [
      "保存最後成功手動連線的位址。關閉會清除保存值，保留當次輸入。",
      "Save the last successful manually entered address. Turning off clears the saved address, keeping current input.",
    ],
  ),
  app(
    "revealDiagnostics",
    "device",
    ["自動展開編譯診斷", "Reveal build diagnostics"],
    ["編譯完成後依診斷結果展開面板。", "Open the diagnostics panel based on build results."],
    {
      options: options(SETTINGS_CHOICES.revealDiagnostics, [
        ["關閉", "Off"],
        ["發生錯誤", "Errors"],
        ["發生錯誤或警告", "Errors or warnings"],
      ]),
    },
  ),
  app(
    "revealDeviceErrors",
    "device",
    ["設備失敗時展開活動面板", "Reveal device failures"],
    [
      "設備操作失敗時顯示活動記錄；需要連線的提示始終保留。",
      "Open activity on device operation failure. Required connection prompts remain visible.",
    ],
  ),
  device(
    "usbAutoReconnect",
    ["USB 自動重連", "USB automatic reconnect"],
    [
      "依序號尋找斷線的設備。關閉會立即取消恢復；重連不會自動執行程式。",
      "Find the disconnected device by serial number. Turning off cancels recovery immediately. Reconnecting never runs programs.",
    ],
  ),
  device(
    "usbRetryInterval",
    ["USB 重試間隔", "USB retry interval"],
    [
      "漸進式依序等待 1、2、5 秒，之後每 5 秒重試。變更適用於下一輪恢復。",
      "Backoff waits 1, 2, then 5 seconds repeatedly. Changes apply to the next recovery.",
    ],
    options(USB_RETRY_INTERVALS, [
      ["漸進式", "Backoff"],
      ...[1, 2, 5, 10].map((v) => [`${v} 秒`, `${v} seconds`] as Text),
    ]),
  ),
  device(
    "usbRetryLimit",
    ["USB 自動重連嘗試上限", "USB reconnect attempt limit"],
    [
      "包含斷線後立即進行的第一次嘗試，達上限後改為手動連線。變更適用於下一輪恢復。",
      "Includes the immediate first attempt. Reconnect manually after the limit. Changes apply to the next recovery.",
    ],
    options(USB_RETRY_LIMITS, [
      ["不限", "Unlimited"],
      ...[3, 5, 10].map((v) => [`${v} 次`, `${v} attempts`] as Text),
    ]),
  ),
  device(
    "wifiConnectTimeout",
    ["Wi-Fi 建立連線逾時", "Wi-Fi connection timeout"],
    ["下一次建立 TCP 連線的等待上限。", "TCP connection timeout for the next connection."],
    seconds(WIFI_CONNECT_TIMEOUTS),
  ),
  device(
    "wifiHandshakeTimeout",
    ["Wi-Fi 握手逾時", "Wi-Fi handshake timeout"],
    ["下一次等待 EV3 接受連線的上限。", "How long to wait for EV3 to accept the next connection."],
    seconds(WIFI_HANDSHAKE_TIMEOUTS),
  ),
  {
    id: "updates.enabled",
    controlId: "updates-enabled",
    source: "updates",
    category: "updates",
    label: ["自動檢查並下載", "Automatically check and download"],
    hint: [
      "自動檢查並下載更新，安裝仍需手動確認。",
      "Check and download updates automatically. Installation still requires your confirmation.",
    ],
    read: (context) => context.updates?.enabled,
    defaultValue: () => true,
    change: (context, value) => context.onUpdateChange({ enabled: value === true }),
  },
  {
    id: "updates.channel",
    controlId: "updates-preview",
    source: "updates",
    category: "updates",
    label: ["接收預覽版更新", "Receive preview updates"],
    hint: [
      "預覽版可能仍在測試中；切回正式版不會自動降版。",
      "Preview releases may still be in testing. Switching back to stable never downgrades your app.",
    ],
    read: (context) => (context.updates ? context.updates.channel === "preview" : undefined),
    defaultValue: () => false,
    change: (context, value) => context.onUpdateChange({ channel: value ? "preview" : "stable" }),
  },
];
export function filterSettings(
  context: CatalogContext,
  query: string,
  modified: boolean,
): SettingDefinition[] {
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase();
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  return SETTINGS_CATALOG.filter((entry) => {
    const value = entry.read(context);
    if (modified && (value === undefined || value === entry.defaultValue(context))) return false;
    const text = normalize(
      [
        entry.id,
        ...entry.label,
        ...entry.hint,
        ...CATEGORY_LABELS[entry.category],
        entry.keywords ?? "",
        ...(entry.options?.flatMap((option) => [...option.label, String(option.value)]) ?? []),
      ].join(" "),
    );
    return tokens.every((token) => text.includes(token));
  });
}
