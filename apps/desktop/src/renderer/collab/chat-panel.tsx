import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { chatDrafts } from "./chat-drafts.js";
import { COLLAB_LIMITS, type PresenceState } from "@kobrixa/collab-protocol";
import type { Locale } from "../i18n/copy.js";
import {
  chatControllerFor,
  chatTextLength,
  type ChatController,
  type ChatSendResult,
} from "./chat.js";
import { collabCopy, collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import type { CollabSession } from "./types.js";

/** Shows the character counter once a message is this close to the limit. */
const COUNTER_THRESHOLD = 200;

/** The session's chat controller (shared with other components; see `chatControllerFor`). */
export function useChatController(session: CollabSession | null): ChatController | null {
  return useMemo(() => (session ? chatControllerFor(session) : null), [session]);
}

/** Participant colors from awareness, keyed by participant id. */
function usePresenceColors(session: CollabSession): ReadonlyMap<string, string> {
  const [colors, setColors] = useState<ReadonlyMap<string, string>>(new Map());
  useEffect(() => {
    const read = (): void => {
      const next = new Map<string, string>();
      for (const state of session.awareness.getStates().values()) {
        const presence = state as Partial<PresenceState>;
        if (
          typeof presence.participantId === "string" &&
          typeof presence.color === "string" &&
          /^#[0-9a-f]{6}$/i.test(presence.color)
        )
          next.set(presence.participantId, presence.color);
      }
      setColors((previous) =>
        previous.size === next.size && [...next].every(([id, color]) => previous.get(id) === color)
          ? previous
          : next,
      );
    };
    read();
    session.awareness.on("change", read);
    return () => session.awareness.off("change", read);
  }, [session]);
  return colors;
}

/** Re-renders periodically so relative times stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Local calendar day as `YYYY-MM-DD`, used to group messages under day separators. */
function dayKey(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Today", "Yesterday", or the date (with the year only when it differs). */
export function dayLabel(at: number, now: number, locale: Locale): string {
  const copy = collabCopy[locale].chat;
  const today = new Date(now);
  if (dayKey(at) === dayKey(now)) return copy.today;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday.getTime())) return copy.yesterday;
  const date = new Date(at);
  return date.toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Time within the message's day; recent messages use relative times. */
export function messageTime(at: number, now: number, locale: Locale): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return collabCopy[locale].chat.justNow;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(
      -minutes,
      "minute",
    );
  return new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
}

function sendErrorMessage(copy: CollabCopy, result: Exclude<ChatSendResult, { ok: true }>): string {
  switch (result.reason) {
    case "rate-limited":
      return copy.chat.sendRateLimited;
    case "rejected":
      return copy.chat.sendRejected(collabErrorMessage(copy, result.error));
    case "too-long":
      return copy.chat.tooLong;
    case "network":
      return copy.chat.sendNetwork;
    default:
      // Not a connection problem: the message was refused locally or the room closed.
      return copy.chat.sendFailed;
  }
}

/** Room chat. Messages are rendered as plain text only. */
export function ChatPanel({
  session,
  locale,
}: {
  session: CollabSession;
  locale: Locale;
}): React.JSX.Element {
  return (
    <ChatView
      key={`${session.connection.roomId}:${session.connection.participantId}`}
      session={session}
      locale={locale}
      controller={chatControllerFor(session)}
    />
  );
}

/**
 * Reports the chat as visible to the controller only while it is actually on
 * screen: not inside a hidden tab panel or tools tab, and the window is shown.
 */
function useVisibility(
  element: React.RefObject<HTMLElement | null>,
  controller: ChatController,
): void {
  useEffect(() => {
    const target = element.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    let intersecting = false;
    const update = (): void =>
      controller.setVisible(intersecting && document.visibilityState === "visible");
    const observer = new IntersectionObserver((entries) => {
      intersecting = entries.some((entry) => entry.isIntersecting);
      update();
    });
    observer.observe(target);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      controller.setVisible(false);
    };
  }, [element, controller]);
}

function ChatView({
  session,
  locale,
  controller,
}: {
  session: CollabSession;
  locale: Locale;
  controller: ChatController;
}): React.JSX.Element {
  const copy = collabCopy[locale];
  const t = copy.chat;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const colors = usePresenceColors(session);
  const now = useNow(30_000);
  const draftKey = `kobrixa.chatDraft.${session.connection.serverUrl}.${session.connection.roomId}.${session.connection.participantId}`;
  const [draft, setDraft] = useState(() => {
    try {
      return chatDrafts.get(draftKey).text;
    } catch {
      return "";
    }
  });
  const [pending, setPending] = useState(false);
  const [sendError, setSendError] = useState("");
  const changeDraft = (text: string): void => {
    setDraft(text);
    try {
      chatDrafts.set(draftKey, text);
      setSendError("");
    } catch {
      setSendError(t.draftSaveFailed);
    }
  };
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const counterId = useId();
  const hintId = useId();
  useVisibility(log, controller);
  const self = session.connection.participantId;

  const scrollToBottom = (): void => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  useLayoutEffect(() => {
    if (pinned.current) scrollToBottom();
  }, [snapshot.messages]);

  // The log is hidden (zero size) while another sub-tab is shown; restore the
  // bottom position when it becomes visible again.
  useEffect(() => {
    const element = log.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) scrollToBottom();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const length = chatTextLength(draft);
  const tooLong = length > COLLAB_LIMITS.chatMessageLength;
  const showCounter = length > COLLAB_LIMITS.chatMessageLength - COUNTER_THRESHOLD;

  const submit = async (): Promise<void> => {
    if (pending || !snapshot.canSend) return;
    const sending = draft;
    let messageId: string;
    try {
      messageId = chatDrafts.prepare(draftKey, sending);
    } catch {
      setSendError(t.draftPrepareFailed);
      return;
    }
    setPending(true);
    setSendError("");
    const result = await controller.send(sending, messageId);
    setPending(false);
    if (!result.ok) {
      setSendError(sendErrorMessage(copy, result));
      return;
    }
    try {
      if (chatDrafts.sent(draftKey, sending, messageId))
        setDraft((current) => (current === sending ? "" : current));
    } catch {
      setSendError(t.draftUpdateFailed);
    }
    pinned.current = true;
    controller.setAtBottom(true);
    scrollToBottom();
  };

  const hint = snapshot.blocked ? t.blocked[snapshot.blocked] : "";
  const describedBy = [hint && hintId, showCounter && counterId].filter(Boolean).join(" ");

  return (
    <div className="collab-chat">
      <div className="collab-chat-log-wrap">
        <div
          ref={log}
          className="collab-chat-log"
          role="log"
          aria-label={t.log}
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            if (element.clientHeight === 0) return;
            pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            controller.setAtBottom(pinned.current);
          }}
        >
          {snapshot.messages.length === 0 ? (
            <p className="collab-chat-empty">{t.empty}</p>
          ) : (
            snapshot.messages.map((message, index) => {
              const mine = message.participantId === self;
              const color = colors.get(message.participantId);
              const previous = snapshot.messages[index - 1];
              const newDay = !previous || dayKey(previous.at) !== dayKey(message.at);
              return (
                <Fragment key={message.id}>
                  {newDay && (
                    <p className="collab-chat-day" data-testid="collab-chat-day">
                      <time dateTime={dayKey(message.at)}>{dayLabel(message.at, now, locale)}</time>
                    </p>
                  )}
                  <article
                    className={`collab-chat-message${mine ? " own" : ""}`}
                    style={color ? ({ "--participant": color } as CSSProperties) : undefined}
                  >
                    <header>
                      <span className="collab-chat-name">{mine ? t.you : message.name}</span>
                      <time
                        dateTime={new Date(message.at).toISOString()}
                        title={new Date(message.at).toLocaleString(locale)}
                      >
                        {messageTime(message.at, now, locale)}
                      </time>
                    </header>
                    <p className="collab-chat-text">{message.text}</p>
                  </article>
                </Fragment>
              );
            })
          )}
        </div>
        {snapshot.unread > 0 && (
          <button
            type="button"
            className="collab-chat-new"
            data-testid="collab-chat-new"
            aria-label={t.newMessagesLabel(snapshot.unread)}
            onClick={() => {
              pinned.current = true;
              scrollToBottom();
              controller.setAtBottom(true);
            }}
          >
            <span>{t.newMessages}</span>
            <span className="collab-chat-new-count" aria-hidden="true">
              {snapshot.unread}
            </span>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
            </svg>
          </button>
        )}
      </div>
      {sendError && (
        <p className="collab-error" role="alert">
          {sendError}
        </p>
      )}
      {hint && (
        <p id={hintId} className="collab-chat-hint" data-testid="collab-chat-hint">
          {hint}
        </p>
      )}
      <form
        className="collab-chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          aria-label={t.input}
          aria-describedby={describedBy || undefined}
          aria-invalid={tooLong || undefined}
          placeholder={t.placeholder}
          rows={2}
          value={draft}
          onChange={(event) => changeDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div className="collab-chat-actions">
          {showCounter && (
            <span
              id={counterId}
              className={`collab-chat-counter${tooLong ? " over" : ""}`}
              aria-live="polite"
            >
              {tooLong && <span className="collab-chat-sr">{t.tooLong} </span>}
              {length}/{COLLAB_LIMITS.chatMessageLength}
            </span>
          )}
          <button
            type="submit"
            className="primary"
            aria-describedby={hint ? hintId : undefined}
            aria-busy={pending || undefined}
            disabled={pending || !snapshot.canSend || length === 0 || tooLong}
          >
            {pending ? t.sending : t.send}
          </button>
        </div>
      </form>
    </div>
  );
}
