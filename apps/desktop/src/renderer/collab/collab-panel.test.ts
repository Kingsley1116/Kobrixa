// @vitest-environment jsdom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabApi } from "../../shared/collab.js";
import { CollabPanel } from "./collab-panel.js";
import { CollabStatusChip } from "./status-chip.js";
import { CollabStore } from "./store.js";
import { createLinkedSessions, type LinkedRoom } from "./testing.js";
import { collabCopy } from "./collab-copy.js";

let root: Root;
let container: HTMLDivElement;
let room: LinkedRoom;
let store: CollabStore;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  room = createLinkedSessions(["host", "editor"]);
  room.sessions[0]!.connection.inviteCode = "ABCD-EFGH-JK23";
  store = new CollabStore(() => room.sessions[0]!);
});
afterEach(async () => {
  await act(async () => root.unmount());
  store.stop();
  for (const session of room.sessions) session.destroy();
  container.remove();
  vi.unstubAllGlobals();
});

const button = (selector: string): HTMLButtonElement => document.querySelector(selector)!;
async function click(selector: string): Promise<void> {
  await act(async () => button(selector).click());
}
async function input(selector: string, value: string): Promise<void> {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function api(): CollabApi {
  return {
    getPreferences: vi.fn(async () => ({ displayName: "Ada", recentRooms: [] })),
    setPreferences: vi.fn(async () => ({ displayName: "Ada", recentRooms: [] })),
    createRoom: vi.fn(async () => ({ ok: true, value: room.sessions[0]!.connection })),
    joinRoom: vi.fn(async () => ({ ok: true, value: room.sessions[0]!.connection })),
    leave: vi.fn(async () => {}),
    setRole: vi.fn(async (_roomId, request) => {
      room.sessions[1]!.setRole(request.role);
      return { ok: true, value: null };
    }),
    kick: vi.fn(async () => {
      room.sessions[1]!.close("kicked");
      return { ok: true, value: null };
    }),
  } as unknown as CollabApi;
}

describe("collaboration panel", () => {
  it.each(["en", "zh-TW"] as const)("creates a password-protected room in %s", async (locale) => {
    const requests = api();
    await act(async () =>
      root.render(
        createElement(CollabPanel, {
          store,
          api: requests,
          locale,
          projectName: "Robot",
        }),
      ),
    );
    await click("[data-testid=collab-start]");
    await input("[data-testid=collab-create-password]", " Room 密碼 ");
    await click(".collab-create-dialog button[type=submit]");
    expect(requests.createRoom).toHaveBeenCalledWith({
      name: "Ada",
      projectName: "Robot",
      password: " Room 密碼 ",
    });
    expect(document.querySelector("[data-testid=collab-create-password]")).toBeNull();
    expect(JSON.stringify(vi.mocked(requests.setPreferences).mock.calls)).not.toContain(
      "Room 密碼",
    );
  });

  it.each(["en", "zh-TW"] as const)(
    "corrects missing and wrong room passwords in %s",
    async (locale) => {
      const requests = api();
      vi.mocked(requests.joinRoom)
        .mockResolvedValueOnce({ ok: false, error: "password-required" })
        .mockResolvedValueOnce({ ok: false, error: "invalid-password" });
      await act(async () =>
        root.render(
          createElement(CollabPanel, {
            store,
            api: requests,
            locale,
            projectName: "Robot",
          }),
        ),
      );
      await click("[data-testid=collab-join]");
      await input("[data-testid=collab-invite-code]", "ABCD-EFGH-JK23");
      await click(".collab-join-dialog button[type=submit]");
      expect(document.querySelector("[data-testid=collab-join-error]")?.textContent).toBe(
        collabCopy[locale].errors["password-required"],
      );
      expect(
        document.querySelector("[data-testid=collab-invite-code]")?.getAttribute("aria-invalid"),
      ).toBe("false");
      expect(
        document.querySelector("[data-testid=collab-join-password]")?.getAttribute("aria-invalid"),
      ).toBe("true");
      await input("[data-testid=collab-join-password]", "wrong");
      expect(document.querySelector("[data-testid=collab-join-error]")?.textContent).toBe("");
      await click(".collab-join-dialog button[type=submit]");
      expect(document.querySelector("[data-testid=collab-join-error]")?.textContent).toBe(
        collabCopy[locale].errors["invalid-password"],
      );
      await input("[data-testid=collab-join-password]", " Correct 密碼 ");
      await click(".collab-join-dialog button[type=submit]");
      expect(requests.joinRoom).toHaveBeenLastCalledWith({
        name: "Ada",
        inviteCode: "ABCD-EFGH-JK23",
        password: " Correct 密碼 ",
      });
      expect(document.querySelector("[data-testid=collab-join-password]")).toBeNull();
      expect(JSON.stringify(vi.mocked(requests.setPreferences).mock.calls)).not.toContain(
        "Correct 密碼",
      );
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "creates a room and manages participants in %s",
    async (locale) => {
      const requests = api();
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await act(async () =>
        root.render(
          createElement(
            Fragment,
            null,
            createElement(CollabPanel, { store, api: requests, locale, projectName: "Robot" }),
            createElement(CollabStatusChip, { store, locale, onOpen: vi.fn() }),
          ),
        ),
      );
      expect(button("[data-testid=collab-start]").disabled).toBe(false);
      await click("[data-testid=collab-start]");
      expect(document.querySelector(".collab-create-dialog")?.textContent).toContain("Robot");
      expect(requests.createRoom).not.toHaveBeenCalled();
      await click(".collab-create-dialog button[type=submit]");
      expect(requests.createRoom).toHaveBeenCalledWith({ name: "Ada", projectName: "Robot" });
      expect(document.querySelector(".collab-create-dialog")).toBeNull();
      expect(document.querySelector("[data-testid=collab-status]")?.textContent).toBe(
        collabCopy[locale].status.connected,
      );
      expect(document.querySelector(".collab-chip-count")?.textContent).toContain("2");
      expect(document.querySelectorAll(".collab-participant")).toHaveLength(2);
      await click("[data-testid=collab-copy-invite]");
      expect(writeText).toHaveBeenCalledWith("ABCD-EFGH-JK23");
      await click(".collab-participant .more-button");
      await click(".collab-participant [role=menuitem]:not(.danger)");
      expect(requests.setRole).toHaveBeenCalledWith(room.sessions[0]!.connection.roomId, {
        participantId: room.sessions[1]!.connection.participantId,
        role: "viewer",
      });
      expect(document.querySelectorAll(".collab-role-viewer")).toHaveLength(1);
      await click(".collab-participant .more-button");
      await click(".collab-participant [role=menuitem].danger");
      expect(requests.kick).not.toHaveBeenCalled();
      await click(".collab-kick-confirm .danger");
      expect(requests.kick).toHaveBeenCalledWith(
        room.sessions[0]!.connection.roomId,
        room.sessions[1]!.connection.participantId,
      );
      expect(document.querySelector(".collab-chip-count")?.textContent).toContain("1");
      await click("[data-testid=collab-leave]");
      expect(document.querySelector("[data-testid=collab-room]")).toBeNull();
      expect(document.querySelector("[data-testid=collab-lobby]")).not.toBeNull();
      expect(requests.leave).toHaveBeenCalled();
    },
  );

  it("hides administration from guests and explains terminal disconnects", async () => {
    const requests = api();
    store = new CollabStore(() => room.sessions[1]!);
    store.start(room.sessions[1]!.connection);
    await act(async () =>
      root.render(
        createElement(CollabPanel, { store, api: requests, locale: "en", projectName: "Robot" }),
      ),
    );
    expect(document.querySelectorAll(".collab-participant-actions")).toHaveLength(0);
    await act(async () => room.sessions[1]!.close("kicked"));
    expect(document.querySelector("[data-testid=collab-status]")?.textContent).toBe(
      collabCopy.en.closeReasons.kicked,
    );
    expect(button("[data-testid=collab-leave]").textContent).toBe(collabCopy.en.backToLobby);
  });
});
