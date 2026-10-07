import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { COLLAB_LIMITS, type PresenceState } from "@kobrixa/collab-protocol";
import type { Locale } from "../i18n/copy.js";
import { chatControllerFor, chatTextLength, type ChatController } from "./chat.js";
import type { CollabSession } from "./types.js";

const copy = {
  en: {
    log: "Chat messages",
    empty: "No messages yet. Say hello to your team.",
    you: "You",
    input: "Message",
    placeholder: "Message the room (Enter to send, Shift+Enter for a new line)",
    send: "Send",
    viewer: "You joined as a viewer. You can read the chat but can't send messages.",
    closed: "You have left this room. Chat history is read-only.",
    tooLong: "Message is too long.",
    justNow: "just now",
  },
  "zh-TW": {
    log: "聊天訊息",
    empty: "還沒有訊息，向大家打個招呼吧。",
    you: "你",
    input: "訊息",
    placeholder: "傳送訊息給房間成員（Enter 傳送，Shift+Enter 換行）",
    send: "傳送",
    viewer: "你以檢視者身分加入，可以閱讀聊天內容，但無法傳送訊息。",
    closed: "你已離開房間，聊天紀錄僅供閱讀。",
    tooLong: "訊息太長。",
    justNow: "剛剛",
  },
} satisfies Record<Locale, Record<string, string>>;

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

function relativeTime(at: number, now: number, locale: Locale): string {
  const seconds = Math.round((now - at) / 1000);
  if (seconds < 45) return copy[locale].justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return format.format(-minutes, "minute");
  const date = new Date(at);
  if (new Date(now).toDateString() === date.toDateString())
    return date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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
  const t = copy[locale];
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const colors = usePresenceColors(session);
  const now = useNow(30_000);
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const counterId = useId();
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

  const submit = (): void => {
    const result = controller.send(draft);
    if (!result.ok) return;
    setDraft("");
    pinned.current = true;
  };

  return (
    <div className="collab-chat">
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
        }}
      >
        {snapshot.messages.length === 0 ? (
          <p className="collab-chat-empty">{t.empty}</p>
        ) : (
          snapshot.messages.map((message) => {
            const mine = message.participantId === self;
            const color = colors.get(message.participantId);
            return (
              <article
                key={message.id}
                className={`collab-chat-message${mine ? " own" : ""}`}
                style={color ? ({ "--participant": color } as CSSProperties) : undefined}
              >
                <header>
                  <span className="collab-chat-name">{mine ? t.you : message.name}</span>
                  <time
                    dateTime={new Date(message.at).toISOString()}
                    title={new Date(message.at).toLocaleString(locale)}
                  >
                    {relativeTime(message.at, now, locale)}
                  </time>
                </header>
                <p className="collab-chat-text">{message.text}</p>
              </article>
            );
          })
        )}
      </div>
      {snapshot.canSend ? (
        <form
          className="collab-chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            aria-label={t.input}
            aria-describedby={showCounter ? counterId : undefined}
            aria-invalid={tooLong || undefined}
            placeholder={t.placeholder}
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
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
            <button type="submit" className="primary" disabled={length === 0 || tooLong}>
              {t.send}
            </button>
          </div>
        </form>
      ) : (
        <p className="collab-chat-hint">
          {session.getSnapshot().status === "closed" ? t.closed : t.viewer}
        </p>
      )}
    </div>
  );
}
