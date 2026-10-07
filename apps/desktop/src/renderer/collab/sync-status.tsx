import { useCallback, useSyncExternalStore } from "react";
import type { Locale } from "../i18n/copy.js";
import type { CollabFileSync } from "./file-sync.js";

/** Keep partial shares and disk failures visible alongside the room controls. */
export function CollabSyncStatus({
  sync,
  locale,
}: {
  sync: CollabFileSync | undefined;
  locale: Locale;
}): React.JSX.Element | null {
  const subscribe = useCallback(
    (listener: () => void) => sync?.subscribe(listener) ?? (() => {}),
    [sync],
  );
  const snapshot = useSyncExternalStore(subscribe, () => sync?.getSnapshot());
  if (!snapshot) return null;
  const zh = locale === "zh-TW";
  if (snapshot.error)
    return (
      <p role="alert">
        {zh ? "協作檔案同步失敗：" : "Could not sync shared files: "}
        {snapshot.error}
      </p>
    );
  if (snapshot.skipped.length)
    return (
      <p role="status">
        {zh
          ? "以下檔案超過分享限制，未同步："
          : "These files exceed the sharing limits and were not synced: "}
        {snapshot.skipped.join(", ")}
      </p>
    );
  if (snapshot.phase !== "syncing")
    return <p role="status">{zh ? "正在同步專案檔案…" : "Syncing project files…"}</p>;
  return null;
}
