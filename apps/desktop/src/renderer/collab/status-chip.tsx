import { useSyncExternalStore } from "react";
import { useChatController } from "./chat-panel.js";
import type { Locale } from "../i18n/copy.js";
import type { CollabStore } from "./store.js";
import { collabCopy } from "./collab-copy.js";
import { onlineCount } from "./roster.js";
import { useCollabSession, useRoster, useSessionSnapshot } from "./use-collab.js";

/**
 * Toolbar badge shown while in a room: connection status color, a short status
 * label, the online count, and separate badges for unread chat messages and
 * device-control requests.
 */
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
  const status = snapshot?.status;
  const label = status ? copy.chipLabel(copy.status[status], online) : copy.chipIdleLabel;
  const unreadText = unread > 0 ? copy.chipUnread(unread) : "";
  const requestsText = pending > 0 ? copy.chipRequests(pending) : "";
  // Only non-zero counts are announced.
  const description = copy.chipJoin([label, unreadText, requestsText].filter(Boolean));
  return (
    <button
      type="button"
      className="collab-chip"
      data-status={status}
      aria-expanded={active}
      data-testid="collab-chip"
      aria-label={description}
      title={description}
      onClick={onOpen}
    >
      <span className="collab-status-dot" aria-hidden="true" />
      <svg viewBox="0 0 24 24" aria-hidden="true" className="collab-chip-icon">
        <path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M18 14a7 7 0 0 1 4 7" />
      </svg>
      <span className="collab-chip-label" data-testid="collab-chip-label">
        {status ? copy.chipStatus[status] : copy.chipName}
      </span>
      {status === "connected" && (
        <span className="collab-chip-count" aria-hidden="true">
          {online}
        </span>
      )}
      {unread > 0 && (
        <span
          className="collab-chip-badge unread"
          data-testid="collab-chip-unread"
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16">
            <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
          </svg>
          {unread}
        </span>
      )}
      {pending > 0 && (
        <span
          className="collab-chip-badge requests"
          data-testid="collab-chip-requests"
          aria-hidden="true"
        >
          <svg viewBox="0 0 16 16">
            <path d="M8 2v4M8 2 6 4M8 2l2 2M3 9h10v4.5H3z" />
          </svg>
          {pending}
        </span>
      )}
    </button>
  );
}
