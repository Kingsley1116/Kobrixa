// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabStatusChip } from "./status-chip.js";
import { CollabStore } from "./store.js";
import { collabCopy } from "./collab-copy.js";
import { createLinkedSessions, type LinkedRoom, type LinkedSession } from "./testing.js";
import { sharedTypes } from "./types.js";

let root: Root;
let container: HTMLDivElement;
let room: LinkedRoom;
let store: CollabStore;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("kobrixa", { collab: { sendChat: vi.fn() } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  room = createLinkedSessions(["host", "editor"]);
  store = new CollabStore(() => room.sessions[0]!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  store.stop();
  for (const session of room.sessions) session.destroy();
  container.remove();
  vi.unstubAllGlobals();
});

const chip = (): HTMLButtonElement => document.querySelector("[data-testid=collab-chip]")!;
const host = (): LinkedSession => room.sessions[0]!;
async function render(locale: "en" | "zh-TW", pending = 0): Promise<void> {
  await act(async () =>
    root.render(createElement(CollabStatusChip, { store, locale, pending, onOpen: vi.fn() })),
  );
}

describe("collaboration status chip", () => {
  it.each(["en", "zh-TW"] as const)(
    "is short and announces only non-zero counts in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      await render(locale);
      expect(chip().getAttribute("aria-label")).toBe(copy.chipIdleLabel);
      expect(chip().textContent).toBe(copy.chipName);

      await act(async () => store.start(host().connection));
      await render(locale);
      const connected = copy.chipLabel(copy.status.connected, 2);
      expect(chip().getAttribute("aria-label")).toBe(connected);
      expect(chip().title).toBe(connected);
      expect(document.querySelector("[data-testid=collab-chip-label]")!.textContent).toBe(
        copy.chipStatus.connected,
      );
      expect(document.querySelector(".collab-chip-count")!.textContent).toBe("2");
      expect(document.querySelector("[data-testid=collab-chip-unread]")).toBeNull();
      expect(document.querySelector("[data-testid=collab-chip-requests]")).toBeNull();

      await render(locale, 2);
      expect(chip().getAttribute("aria-label")).toBe(
        copy.chipJoin([connected, copy.chipRequests(2)]),
      );
      expect(chip().getAttribute("aria-label")).not.toContain(copy.chipUnread(0));
      expect(document.querySelector("[data-testid=collab-chip-requests]")!.textContent).toBe("2");

      await render(locale, 0);
      await act(async () =>
        sharedTypes(room.sessions[1]!.doc).chat.push([
          { id: "m1", participantId: "participant-1", name: "Grace", text: "hi", at: Date.now() },
        ]),
      );
      expect(chip().getAttribute("aria-label")).toBe(
        copy.chipJoin([connected, copy.chipUnread(1)]),
      );
      expect(document.querySelector("[data-testid=collab-chip-unread]")!.textContent).toBe("1");
      expect(document.querySelector("[data-testid=collab-chip-requests]")).toBeNull();

      await act(async () =>
        (host() as unknown as { update(patch: object): void }).update({ status: "reconnecting" }),
      );
      expect(document.querySelector("[data-testid=collab-chip-label]")!.textContent).toBe(
        copy.chipStatus.reconnecting,
      );
      expect(chip().textContent).not.toContain(copy.status.reconnecting);
      expect(document.querySelector(".collab-chip-count")).toBeNull();
    },
  );
});
