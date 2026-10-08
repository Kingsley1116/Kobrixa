import { useSyncExternalStore } from "react";
import { useChatController } from "./chat-panel.js";
import type { Locale } from "../i18n/copy.js";
import type { CollabStore } from "./store.js";
import { collabCopy } from "./collab-copy.js";
import { onlineCount } from "./roster.js";
import { useCollabSession, useRoster, useSessionSnapshot } from "./use-collab.js";

/** Toolbar badge shown while in a room: connection status color and online count. */
export function CollabStatusChip({
  store,
  locale,
  onOpen,
  active = false,
  pending = 0,
}: {
  store: CollabStore;
  locale: Locale;
  onOpen(): void;
  active?: boolean;
  pending?: number;
}): React.JSX.Element | null {
  const session = useCollabSession(store);
  const snapshot = useSessionSnapshot(session);
  const entries = useRoster(session, snapshot);
  const chat = useChatController(session);
  const unread = useSyncExternalStore(
    chat?.subscribe ?? (() => () => {}),
    () => chat?.getSnapshot().unread ?? 0,
  );
  const copy = collabCopy[locale];
  const online = onlineCount(entries);
  const label = snapshot
    ? copy.chipLabel(copy.status[snapshot.status], online)
    : locale === "zh-TW"
      ? "協作"
      : "Collaborate";
  return (
    <button
      type="button"
      className="collab-chip"
      data-status={snapshot?.status}
      aria-expanded={active}
      data-testid="collab-chip"
      aria-label={`${label}${unread || pending ? (locale === "zh-TW" ? `，${unread} 則未讀訊息，${pending} 個控制權請求` : `, ${unread} unread messages, ${pending} control requests`) : ""}`}
      title={label}
      onClick={onOpen}
    >
      <span className="collab-status-dot" aria-hidden="true" />
      <svg viewBox="0 0 24 24" aria-hidden="true" className="collab-chip-icon">
        <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a7 7 0 0 1 4 7" />
      </svg>
      <span>{locale === "zh-TW" ? "協作" : "Collaborate"}</span>
      {snapshot && (
        <span className="collab-chip-count">
          {copy.status[snapshot.status]} · {online}
        </span>
      )}
      {unread + pending > 0 && <strong className="collab-count">{unread + pending}</strong>}
    </button>
  );
}
