/** Highlights bundled with the app, newest first. Each entry is shown once after updating to it. */
export interface WhatsNewEntry {
  version: string;
  items: Array<{ zh: string; en: string }>;
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
  {
    version: "1.0.1-beta.2",
    items: [
      {
        zh: "F5 會在建置成功後停止並確認舊程式，再上傳及確認新版啟動；活動紀錄分別顯示上傳完成與已確認啟動。",
        en: "After a successful build, F5 confirms the previous program has stopped, uploads the new version and confirms startup. The activity log distinguishes upload completion from confirmed startup.",
      },
      {
        zh: "修正 USB 回覆長度為 256 倍數時可能解碼失敗的問題，並在載入失敗、啟動遭拒或逾時時明確回報。",
        en: "Fixed USB reply decoding at lengths that are multiples of 256, with explicit errors for load failures, rejected starts and timeouts.",
      },
      {
        zh: "更新桌面執行環境與編輯器元件。本次 EV3 修正已通過自動化回歸測試；20 次實機連續部署驗收仍待完成。",
        en: "Updated the desktop runtime and editor components. Automated regression tests cover the EV3 fixes; the 20-deployment physical EV3 acceptance check is still pending.",
      },
    ],
  },
  {
    version: "1.0.1-beta.1",
    items: [
      {
        zh: "Windows 視窗更簡潔：移除系統選單列與額外標題列，最小化、最大化與關閉按鈕整合進工具列。",
        en: "A cleaner Windows window: the system menu bar and extra title bar are removed, with minimize, maximize and close controls integrated into the toolbar.",
      },
      {
        zh: "視窗按鈕配色與工具列高度會隨主題、介面縮放及工具列換行同步調整。",
        en: "Window controls follow the app theme and toolbar height as the interface scale and toolbar wrapping change.",
      },
    ],
  },
  {
    version: "1.0.0",
    items: [
      {
        zh: "Kobrixa 1.0 正式版：Basic Plus 編輯與編譯、USB／Wi-Fi 部署、EV3 檔案管理、Sensor Lab、馬達測試與雲端協作均已完成實體 EV3 驗收。",
        en: "Kobrixa 1.0: Basic Plus editing and compilation, USB/Wi-Fi deployment, EV3 file management, Sensor Lab, motor testing and cloud collaboration have passed physical EV3 acceptance.",
      },
    ],
  },
  {
    version: "0.1.0-v1-candidate.16",
    items: [
      {
        zh: "拖曳專案或檔案分頁即可重新排序；焦點在分頁上時也可按 Alt+Shift+←／→。",
        en: "Drag project or file tabs to reorder them, or press Alt+Shift+←/→ while a tab has focus.",
      },
      {
        zh: "在檔案分頁按右鍵：固定分頁、關閉其他／右側分頁、複製路徑、在檔案樹中顯示。",
        en: "Right-click a file tab to pin it, close others or tabs to the right, copy its path or reveal it in the file tree.",
      },
      {
        zh: "編輯器工具列會顯示游標所在的 Sub；按「符號」可跳到檔案中的任何 Sub、變數或標籤，也可按 Cmd／Ctrl+Shift+O。",
        en: "The editor toolbar shows the Sub around the cursor; use Symbols (or Cmd/Ctrl+Shift+O) to jump to any Sub, variable or label in the file.",
      },
      {
        zh: "分割編輯器：並排查看兩個檔案，或同一檔案的兩個位置（工具列的 ◫ 按鈕，或分頁右鍵選單的「在右側分割開啟」）。",
        en: "Split the editor to view two files, or two places in one file, side by side (◫ in the toolbar, or Open to the side in the tab menu).",
      },
      {
        zh: "連接 EV3 後，狀態列會顯示連線方式與電量，電量偏低時會提醒。",
        en: "With an EV3 connected, the status bar shows the connection and battery level, and warns when it runs low.",
      },
    ],
  },
];

export const WHATS_NEW_SEEN_KEY = "kobrixa-whats-new-seen";

/**
 * Entries newer than the last acknowledged version, up to the running one. Without a
 * record (fresh install or an update from a build that predates this), only the running
 * version's own highlights are shown.
 */
export function pendingWhatsNew(
  entries: readonly WhatsNewEntry[],
  current: string,
  lastSeen: string | null,
): WhatsNewEntry[] {
  if (lastSeen === current) return [];
  const start = entries.findIndex((entry) => entry.version === current);
  if (start < 0) return [];
  if (lastSeen === null) return [entries[start]!];
  const end = entries.findIndex((entry) => entry.version === lastSeen);
  return entries.slice(start, end < start ? undefined : end);
}
