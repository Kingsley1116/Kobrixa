// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@kobrixa/collab-protocol";
import type { CollabApi, CollabResult } from "../../shared/collab.js";
import { ChatPanel, dayLabel, messageTime } from "./chat-panel.js";
import { chatControllerFor } from "./chat.js";
import { collabCopy, collabErrorMessage } from "./collab-copy.js";
import { createLinkedSessions, type LinkedRoom, type LinkedSession } from "./testing.js";
import { sharedTypes } from "./types.js";

let root: Root;
let container: HTMLDivElement;
let room: LinkedRoom;
let sendChat: ReturnType<typeof vi.fn<CollabApi["sendChat"]>>;
let roomIndex = 0;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  sendChat = vi.fn<CollabApi["sendChat"]>();
  vi.stubGlobal("kobrixa", { collab: { sendChat } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // A fresh room id per test keeps the in-memory draft cache isolated.
  room = createLinkedSessions(
    ["host", "editor"],
    `chat-room-${String(roomIndex++).padStart(7, "0")}`,
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const session of room.sessions) session.destroy();
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const host = (): LinkedSession => room.sessions[0]!;
const peer = (): LinkedSession => room.sessions[1]!;
const query = <T extends Element = HTMLElement>(selector: string): T | null =>
  document.querySelector<T>(selector);

function message(id: string, at: number, participantId = "participant-1"): ChatMessage {
  return { id, participantId, name: "Grace", text: `text ${id}`, at };
}
async function render(locale: "en" | "zh-TW"): Promise<void> {
  await act(async () => root.render(createElement(ChatPanel, { session: host(), locale })));
}
async function type(value: string): Promise<void> {
  await act(async () => {
    const element = query<HTMLTextAreaElement>(".collab-chat-compose textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const sendButton = (): HTMLButtonElement =>
  query<HTMLButtonElement>(".collab-chat-compose button[type=submit]")!;
function update(session: LinkedSession, patch: object): void {
  (session as unknown as { update(patch: object): void }).update(patch);
}

describe("chat panel", () => {
  it.each(["en", "zh-TW"] as const)(
    "groups messages under day separators in %s",
    async (locale) => {
      const copy = collabCopy[locale].chat;
      const now = new Date(2026, 9, 8, 15, 0).getTime();
      vi.useFakeTimers({ now, toFake: ["Date"] });
      sharedTypes(peer().doc).chat.push([
        message("a", new Date(2026, 8, 20, 9, 5).getTime()),
        message("b", new Date(2026, 8, 20, 9, 30).getTime()),
        message("c", new Date(2026, 9, 7, 18, 0).getTime()),
        message("d", new Date(2026, 9, 8, 11, 15).getTime()),
        message("e", now - 10_000),
      ]);
      await render(locale);
      const days = [...document.querySelectorAll("[data-testid=collab-chat-day]")].map(
        (element) => element.textContent,
      );
      expect(days).toEqual([
        dayLabel(new Date(2026, 8, 20).getTime(), now, locale),
        copy.yesterday,
        copy.today,
      ]);
      expect(days[0]).not.toBe(copy.today);
      const times = [...document.querySelectorAll(".collab-chat-message header time")].map(
        (element) => element.textContent,
      );
      // Within a day only the time is shown, never the date again.
      expect(times[0]).toBe(
        new Date(2026, 8, 20, 9, 5).toLocaleTimeString(locale, {
          hour: "numeric",
          minute: "2-digit",
        }),
      );
      expect(times[4]).toBe(copy.justNow);
      expect(messageTime(now - 5 * 60_000, now, locale)).not.toBe(copy.justNow);
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "shows a floating new-messages pill and keeps hints linked in %s",
    async (locale) => {
      const copy = collabCopy[locale].chat;
      await render(locale);
      // Not visible yet (no IntersectionObserver in jsdom), so peer messages are unread.
      await act(async () => {
        sharedTypes(peer().doc).chat.push([message("x", Date.now())]);
      });
      const pill = query<HTMLButtonElement>("[data-testid=collab-chat-new]")!;
      expect(pill.className).toBe("collab-chat-new");
      expect(pill.parentElement?.className).toBe("collab-chat-log-wrap");
      expect(pill.getAttribute("aria-label")).toBe(copy.newMessagesLabel(1));
      expect(pill.textContent).toContain(copy.newMessages);

      expect(query("[data-testid=collab-chat-hint]")).toBeNull();
      await act(async () => update(host(), { status: "reconnecting" }));
      const hint = query("[data-testid=collab-chat-hint]")!;
      expect(hint.textContent).toBe(copy.blocked.offline);
      // The hint sits above the composer and describes both the input and Send.
      expect(hint.nextElementSibling?.className).toBe("collab-chat-compose");
      expect(
        query(".collab-chat-compose textarea")!.getAttribute("aria-describedby")?.split(" "),
      ).toContain(hint.id);
      expect(sendButton().getAttribute("aria-describedby")).toBe(hint.id);
      expect(sendButton().disabled).toBe(true);

      await act(async () => update(host(), { status: "syncing", synced: false }));
      expect(query("[data-testid=collab-chat-hint]")!.textContent).toBe(copy.blocked.syncing);
      await act(async () => update(host(), { status: "connected", synced: true }));
      expect(query("[data-testid=collab-chat-hint]")).toBeNull();
      await act(async () => host().close("left"));
      expect(query("[data-testid=collab-chat-hint]")!.textContent).toBe(copy.blocked.closed);
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "shows Sending… while pending and distinct send errors in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      let resolve!: (result: CollabResult<ChatMessage>) => void;
      sendChat.mockImplementationOnce(
        () => new Promise<CollabResult<ChatMessage>>((done) => (resolve = done)),
      );
      await render(locale);
      await type("hello");
      expect(sendButton().textContent).toBe(copy.chat.send);
      await act(async () => sendButton().click());
      expect(sendButton().textContent).toBe(copy.chat.sending);
      expect(sendButton().disabled).toBe(true);
      expect(sendButton().getAttribute("aria-busy")).toBe("true");
      await act(async () => resolve({ ok: false, error: "rate-limited" }));
      expect(sendButton().textContent).toBe(copy.chat.send);
      expect(query(".collab-error[role=alert]")!.textContent).toBe(copy.chat.sendRateLimited);
      expect(query<HTMLTextAreaElement>(".collab-chat-compose textarea")!.value).toBe("hello");

      sendChat.mockResolvedValueOnce({ ok: false, error: "network" });
      await act(async () => sendButton().click());
      expect(query(".collab-error[role=alert]")!.textContent).toBe(copy.chat.sendNetwork);

      sendChat.mockResolvedValueOnce({ ok: false, error: "removed" });
      await act(async () => sendButton().click());
      expect(query(".collab-error[role=alert]")!.textContent).toBe(
        copy.chat.sendRejected(collabErrorMessage(copy, "removed")),
      );
    },
  );

  it("lets viewers send through the server without a read-only hint", async () => {
    host().setRole("viewer");
    sendChat.mockImplementation(async (_roomId, request) => ({
      ok: true,
      value: { ...request, participantId: "participant-0", name: "Ada", at: Date.now() },
    }));
    await render("en");
    expect(chatControllerFor(host()).getSnapshot().canSend).toBe(true);
    expect(query("[data-testid=collab-chat-hint]")).toBeNull();
    await type("viewer says hi");
    await act(async () => sendButton().click());
    expect(sendChat).toHaveBeenCalledOnce();
    expect(query<HTMLTextAreaElement>(".collab-chat-compose textarea")!.value).toBe("");
  });
});
