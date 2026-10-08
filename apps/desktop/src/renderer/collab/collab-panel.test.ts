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
import { CollabPendingUpdatesError } from "./types.js";

let root: Root;
let container: HTMLDivElement;
let room: LinkedRoom;
let store: CollabStore;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
  vi.restoreAllMocks();
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
    closeRoom: vi.fn(async () => ({ ok: true, value: null })),
    resumeRoom: vi.fn(async () => ({ ok: true, value: room.sessions[0]!.connection })),
    saveCopy: vi.fn(async () => "/projects/Robot copy"),
  } as unknown as CollabApi;
}
const text = (selector: string): string | null | undefined =>
  document.querySelector(selector)?.textContent;
async function renderRoom(
  locale: "en" | "zh-TW",
  requests: CollabApi,
  extra: Record<string, unknown> = {},
  index = 0,
): Promise<void> {
  store = new CollabStore(() => room.sessions[index]!);
  store.start(room.sessions[index]!.connection);
  await act(async () =>
    root.render(
      createElement(CollabPanel, { store, api: requests, locale, projectName: "Robot", ...extra }),
    ),
  );
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
      expect(text("#collab-leave-title")).toBe(collabCopy[locale].leaveTitle);
      expect(text("#collab-leave-intro")).toBe(collabCopy[locale].leaveHostHint);
      expect(requests.leave).not.toHaveBeenCalled();
      await click("[data-testid=collab-leave-confirmed]");
      expect(document.querySelector("[data-testid=collab-room]")).toBeNull();
      expect(document.querySelector("[data-testid=collab-lobby]")).not.toBeNull();
      expect(requests.leave).toHaveBeenCalled();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "localizes a failed share preview and lets the host retry or start anyway in %s",
    async (locale) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const requests = api();
      const previewProject = vi
        .fn()
        .mockRejectedValueOnce(new Error("Error invoking remote method 'collab:preview'"))
        .mockResolvedValueOnce({ shared: ["main.bp"], skipped: [] });
      Object.assign(requests, { previewProject });
      await act(async () =>
        root.render(
          createElement(CollabPanel, {
            store,
            api: requests,
            locale,
            projectName: "Robot",
            projectId: "workspace-1",
          }),
        ),
      );
      await click("[data-testid=collab-start]");
      const dialog = document.querySelector(".collab-create-dialog")!;
      expect(dialog.textContent).toContain(collabCopy[locale].previewFailed);
      expect(dialog.textContent).not.toContain("Error invoking");
      expect(button(".collab-create-dialog button[type=submit]").disabled).toBe(false);
      await click("[data-testid=collab-share-preview-retry]");
      expect(previewProject).toHaveBeenCalledTimes(2);
      expect(dialog.textContent).not.toContain(collabCopy[locale].previewFailed);
      expect(dialog.textContent).toContain("main.bp");
      vi.mocked(console.warn).mockRestore();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "shows a recent-room load failure with a retry in %s",
    async (locale) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const requests = api();
      vi.mocked(requests.getPreferences).mockRejectedValue(new Error("ipc"));
      await act(async () =>
        root.render(createElement(CollabPanel, { store, api: requests, locale })),
      );
      expect(document.querySelector("[data-testid=collab-recent-error]")?.textContent).toContain(
        collabCopy[locale].recentRoomsLoadFailed,
      );
      expect(document.querySelector("[data-testid=collab-lobby]")?.textContent).not.toContain(
        collabCopy[locale].noRecentRooms,
      );
      expect(document.querySelector("[data-testid=collab-open-project]")?.textContent).toBe(
        collabCopy[locale].openProject,
      );
      vi.mocked(requests.getPreferences).mockResolvedValue({
        displayName: "Ada",
        recentRooms: [{ roomId: "room-a", projectName: "Robot", role: "editor", joinedAt: 1 }],
      });
      await click("[data-testid=collab-recent-retry]");
      expect(document.querySelector("[data-testid=collab-recent-error]")).toBeNull();
      expect(document.querySelectorAll("[data-testid=collab-recent-room]")).toHaveLength(1);
      vi.mocked(console.warn).mockRestore();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "explains, rejoins and forgets recent rooms in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const recentRooms = [
        {
          roomId: "room-a",
          projectName: "Owned",
          role: "host" as const,
          joinedAt: 1,
          canResume: true,
        },
        { roomId: "room-b", projectName: "Legacy", role: "host" as const, joinedAt: 2 },
        {
          roomId: "room-c",
          projectName: "Invited",
          role: "editor" as const,
          joinedAt: 3,
          inviteCode: "ABCD-EFGH-JK23",
        },
        { roomId: "room-d", projectName: "Lost", role: "viewer" as const, joinedAt: 4 },
      ];
      const requests = api();
      vi.mocked(requests.getPreferences).mockResolvedValue({ displayName: "Ada", recentRooms });
      let finish!: (value: unknown) => void;
      Object.assign(requests, {
        resumeRoom: vi.fn(() => new Promise((resolve) => (finish = resolve))),
      });
      await act(async () =>
        root.render(createElement(CollabPanel, { store, api: requests, locale })),
      );
      const items = () => [...document.querySelectorAll("[data-testid=collab-recent-room]")];
      const rejoin = (index: number) =>
        items()[index]!.querySelector<HTMLButtonElement>("[data-testid=collab-rejoin]")!;
      expect(items()).toHaveLength(4);
      expect(items()[0]!.textContent).toContain(
        copy.joinedAt(
          new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(1),
        ),
      );
      expect(items()[0]!.querySelector(".collab-recent-note")).toBeNull();
      expect(items()[1]!.textContent).toContain(copy.legacyHostRoom);
      expect(items()[2]!.textContent).toContain(copy.guestRejoinWithCode);
      expect(items()[3]!.textContent).toContain(copy.guestNoInviteCode);
      expect(rejoin(3).disabled).toBe(true);
      expect(
        document.getElementById(rejoin(3).getAttribute("aria-describedby")!)?.textContent,
      ).toBe(copy.guestNoInviteCode);

      await act(async () => rejoin(2).click());
      expect(
        document.querySelector<HTMLInputElement>("[data-testid=collab-invite-code]")?.value,
      ).toBe("ABCD-EFGH-JK23");
      await click(".collab-join-dialog button[type=button]");

      await act(async () => rejoin(0).click());
      expect(rejoin(0).textContent).toBe(copy.rejoining);
      expect(rejoin(0).getAttribute("aria-busy")).toBe("true");
      expect(rejoin(1).getAttribute("aria-busy")).toBe("false");
      expect(rejoin(1).disabled).toBe(true);
      await act(async () => finish({ ok: false, error: "room-closed" }));
      expect(rejoin(0).textContent).toBe(copy.rejoin);
      expect(document.querySelector(".collab-lobby > .collab-error")?.textContent).toBe(
        copy.errors["room-closed"],
      );

      const forget = items()[3]!.querySelector<HTMLButtonElement>("[data-testid=collab-forget]")!;
      expect(forget.getAttribute("aria-label")).toBe(copy.forgetRoomLabel("Lost"));
      await act(async () => forget.click());
      expect(items()).toHaveLength(3);
      expect(requests.setPreferences).toHaveBeenLastCalledWith({
        recentRooms: recentRooms.slice(0, 3),
      });
    },
  );

  it("shows a start error only once while the create dialog is open", async () => {
    const requests = api();
    vi.mocked(requests.createRoom).mockResolvedValue({ ok: false, error: "rate-limited" });
    await act(async () =>
      root.render(
        createElement(CollabPanel, { store, api: requests, locale: "en", projectName: "Robot" }),
      ),
    );
    await click("[data-testid=collab-start]");
    await click(".collab-create-dialog button[type=submit]");
    const message = collabCopy.en.errors["rate-limited"];
    const alerts = () =>
      [...document.querySelectorAll("[role=alert]")].filter(
        (element) => element.textContent === message,
      );
    expect(alerts()).toHaveLength(1);
    await click(".collab-create-dialog button[type=button]");
    expect(alerts()).toHaveLength(1);
  });

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

  it.each(["en", "zh-TW"] as const)(
    "labels the invite and resets the copied state in %s",
    async (locale) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const copy = collabCopy[locale];
      const writeText = vi.fn(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      await renderRoom(locale, api());
      expect(text(".collab-invite-label")).toBe(copy.inviteCodeLabel);
      expect(text(".collab-invite-block")).toContain(copy.inviteShare);
      expect(text("[data-testid=collab-online-count]")).toBe(copy.onlineCount(2, 16));
      await click("[data-testid=collab-copy-invite]");
      expect(text("[data-testid=collab-copy-invite]")).toBe(`${copy.copied} ✓`);
      await act(async () => vi.advanceTimersByTime(2000));
      expect(text("[data-testid=collab-copy-invite]")).toBe(copy.copy);
      writeText.mockRejectedValueOnce(new Error("denied"));
      await click("[data-testid=collab-copy-invite]");
      expect(text(".collab-invite-status")).toBe(copy.copyFailed);
      vi.useRealTimers();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "confirms saved copies after the room ends in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const requests = api();
      await renderRoom(locale, requests);
      await act(async () => room.sessions[0]!.close("room-closed"));
      expect(document.querySelector(".collab-invite-block")).toBeNull();
      await click(".collab-room-footer .more-button");
      await click("[data-testid=collab-save-copy]");
      expect(text("[data-testid=collab-room-message]")).toBe(
        copy.copySaved("/projects/Robot copy"),
      );
      vi.mocked(requests.saveCopy).mockRejectedValueOnce(new Error("EACCES: raw"));
      await click(".collab-room-footer .more-button");
      await click("[data-testid=collab-save-copy]");
      expect(text("[data-testid=collab-room-message]")).toBe("");
      expect(text("[data-testid=collab-room-error]")).toBe(copy.saveCopyFailed);
      await click("[data-testid=collab-room-retry]");
      expect(requests.saveCopy).toHaveBeenCalledTimes(3);
      expect(document.querySelector("[data-testid=collab-room-error]")).toBeNull();
      expect(text("[data-testid=collab-room-message]")).toBe(
        copy.copySaved("/projects/Robot copy"),
      );
    },
  );

  it.each(["en", "zh-TW"] as const)("offers to reconnect right away in %s", async (locale) => {
    const copy = collabCopy[locale];
    await renderRoom(locale, api());
    await act(async () => room.sessions[0]!.drop());
    expect(text("[data-testid=collab-status]")).toBe(copy.status.reconnecting);
    expect(text("[data-testid=collab-reconnecting]")).toContain(copy.reconnectingHint);
    await click("[data-testid=collab-reconnect-now]");
    expect(text("[data-testid=collab-status]")).toBe(copy.status.connected);
    expect(document.querySelector("[data-testid=collab-reconnecting]")).toBeNull();
  });

  it.each(["en", "zh-TW"] as const)("rejoins a dropped room in %s", async (locale) => {
    const copy = collabCopy[locale];
    const requests = api();
    const onStart = vi.fn(async () => true);
    const onLeave = vi.fn(async () => {});
    await renderRoom(locale, requests, { onStart, onLeave });
    await act(async () => room.sessions[0]!.close("error"));
    expect(text("[data-testid=collab-rejoin]")).toBe(copy.rejoin);
    vi.mocked(requests.resumeRoom).mockResolvedValueOnce({ ok: false, error: "network" });
    await click("[data-testid=collab-rejoin]");
    expect(text("[data-testid=collab-room-error]")).toBe(copy.errors.network);
    expect(onStart).not.toHaveBeenCalled();
    await click("[data-testid=collab-room-retry]");
    // Unsent edits of the closed session are preserved once, not on every retry.
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(requests.resumeRoom).toHaveBeenLastCalledWith(room.sessions[0]!.connection.roomId);
    expect(onStart).toHaveBeenCalledWith(room.sessions[0]!.connection);
    expect(document.querySelector("[data-testid=collab-room-error]")).toBeNull();
  });

  it.each(["en", "zh-TW"] as const)(
    "reconnects a replaced session and explains newer closes in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      await renderRoom(locale, api());
      await act(async () => room.sessions[0]!.close("session-replaced"));
      expect(text("[data-testid=collab-rejoin]")).toBe(copy.reconnectHere);
      room = createLinkedSessions(["host", "editor"]);
      await renderRoom(locale, api());
      await act(async () => room.sessions[0]!.close("protocol-mismatch"));
      expect(text("[data-testid=collab-status]")).toBe(copy.closeReasons["protocol-mismatch"]);
      expect(document.querySelector("[data-testid=collab-rejoin]")).toBeNull();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "confirms leaving with unsent edits and localizes failures in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const requests = api();
      const onLeave = vi.fn(async () => {});
      onLeave.mockRejectedValueOnce(new CollabPendingUpdatesError());
      await renderRoom(locale, requests, { onLeave }, 1);
      let pending = true;
      Object.assign(room.sessions[1]!, { hasPendingUpdates: () => pending });
      await click("[data-testid=collab-leave]");
      expect(document.querySelector(".collab-leave-confirm")?.getAttribute("role")).toBe(
        "alertdialog",
      );
      expect(text("#collab-leave-title")).toBe(copy.leavePendingTitle);
      expect(text("#collab-leave-intro")).toBe(copy.leavePendingIntro);
      expect(document.querySelector("[data-testid=collab-leave-end]")).toBeNull();
      expect(onLeave).not.toHaveBeenCalled();
      expect(text("[data-testid=collab-leave-confirmed]")).toBe(copy.leaveAnyway);
      await click("[data-testid=collab-leave-confirmed]");
      expect(text("[data-testid=collab-room-error]")).toBe(copy.pendingUpdates);
      expect(requests.leave).not.toHaveBeenCalled();
      pending = false;
      await click("[data-testid=collab-room-retry]");
      expect(requests.leave).toHaveBeenCalled();
      expect(document.querySelector("[data-testid=collab-lobby]")).not.toBeNull();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "shows end-room progress and errors inside the dialog in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const requests = api();
      let finish: (value: unknown) => void = () => {};
      vi.mocked(requests.closeRoom).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)) as never,
      );
      await renderRoom(locale, requests);
      await click(".collab-room-footer .more-button");
      await click(".collab-room-footer [role=menuitem].danger");
      const dialog = document.querySelector(".collab-end-confirm")!;
      expect(dialog.getAttribute("role")).toBe("alertdialog");
      expect(dialog.textContent).toContain(copy.endRoomIntro);
      await click("[data-testid=collab-end-confirm]");
      expect(text("[data-testid=collab-end-confirm]")).toBe(copy.ending);
      await act(async () => finish({ ok: false, error: "forbidden" }));
      expect(text("[data-testid=collab-end-confirm]")).toBe(copy.endRoom);
      expect(document.querySelectorAll("[role=alert]")).toHaveLength(1);
      expect(text(".collab-end-confirm [role=alert]")).toBe(copy.errors.forbidden);
      expect(document.querySelector("[data-testid=collab-room-retry]")).toBeNull();
      vi.mocked(requests.closeRoom).mockResolvedValueOnce({ ok: false, error: "forbidden" });
      await click("[data-testid=collab-end-confirm]");
      // Cancelling drops the error instead of leaving an unconfirmed retry behind.
      await click(".collab-end-confirm [data-modal-initial]");
      expect(document.querySelector(".collab-end-confirm")).toBeNull();
      expect(document.querySelector("[data-testid=collab-room-error]")).toBeNull();
      await click(".collab-room-footer .more-button");
      await click(".collab-room-footer [role=menuitem].danger");
      await click("[data-testid=collab-end-confirm]");
      expect(requests.closeRoom).toHaveBeenCalledTimes(3);
      expect(document.querySelector("[data-testid=collab-lobby]")).not.toBeNull();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "tells guests what still works while the host is offline in %s",
    async (locale) => {
      await renderRoom(locale, api(), {}, 1);
      await act(async () => room.sessions[0]!.close("left"));
      expect(text("[data-testid=collab-host-offline]")).toBe(collabCopy[locale].hostOffline);
      await click("[data-testid=collab-leave]");
      expect(document.querySelector(".collab-leave-confirm")).toBeNull();
      expect(document.querySelector("[data-testid=collab-lobby]")).not.toBeNull();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "lets hosts end the room instead of leaving in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      await renderRoom(locale, api());
      await click("[data-testid=collab-leave]");
      expect(text("[data-testid=collab-leave-end]")).toBe(copy.endForEveryone);
      await click("[data-testid=collab-leave-end]");
      expect(document.querySelector(".collab-leave-confirm")).toBeNull();
      expect(text("#collab-end-title")).toBe(copy.endRoomTitle);
    },
  );
});
