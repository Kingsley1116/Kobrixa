/** Highlights bundled with the app, newest first. Each entry is shown once after updating to it. */
export interface WhatsNewEntry {
  version: string;
  items: Array<{ zh: string; en: string }>;
}

export const WHATS_NEW: readonly WhatsNewEntry[] = [
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
