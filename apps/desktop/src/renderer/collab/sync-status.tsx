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
      <p className="collab-sync-notice" role="alert">
        {zh ? "協作檔案同步失敗：" : "Could not sync shared files: "}
        {snapshot.error}
        <button onClick={() => void sync?.retry()}>{zh ? "重試同步" : "Retry sync"}</button>
      </p>
    );
  if (snapshot.skipped.length)
    return (
      <details className="collab-sync-notice">
        <summary>
          {zh
            ? `${snapshot.skipped.length} 個檔案未同步`
            : `${snapshot.skipped.length} files not shared`}
        </summary>
        <ul>
          {snapshot.skipped.map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      </details>
    );
  if (snapshot.phase !== "syncing")
    return <p role="status">{zh ? "正在同步專案檔案…" : "Syncing project files…"}</p>;
  return null;
}
