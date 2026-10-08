// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "../i18n/copy.js";
import { collabCopy } from "./collab-copy.js";
import type { CollabFileSync, CollabFileSyncSnapshot } from "./file-sync.js";
import { RemovedFilesDialog, type RemovedFilesPrompt } from "./removed-files-dialog.js";
import { CollabSyncStatus } from "./sync-status.js";
import { createLinkedSessions, type LinkedRoom, type LinkedSession } from "./testing.js";

let root: Root;
let container: HTMLDivElement;
let room: LinkedRoom;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  room = createLinkedSessions(["host"]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  for (const session of room.sessions) session.destroy();
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/** Stands in for `CollabFileSync`: only the members the status view reads. */
class FakeSync {
  readonly listeners = new Set<() => void>();
  snapshot: CollabFileSyncSnapshot = {
    phase: "syncing",
    pendingWrites: 0,
    skipped: [],
    skipReasons: {},
    notices: [],
  };
  retry = vi.fn(async () => {});
  constructor(readonly session: LinkedSession) {}
  get canRetry(): boolean {
    return this.session.getSnapshot().status === "connected";
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  dismissNotice = vi.fn((id: number) =>
    this.set({ notices: this.snapshot.notices.filter((notice) => notice.id !== id) }),
  );
  set(patch: Partial<CollabFileSyncSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}

async function render(sync: FakeSync, locale: Locale): Promise<void> {
  await act(async () =>
    root.render(
      createElement(CollabSyncStatus, { sync: sync as unknown as CollabFileSync, locale }),
    ),
  );
}
const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe.each(["en", "zh-TW"] as const)("collab sync status (%s)", (locale) => {
  const copy = collabCopy[locale];

  it("renders nothing while everything is in sync", async () => {
    await render(new FakeSync(room.sessions[0]!), locale);
    expect(container.innerHTML).toBe("");
  });

  it("styles the syncing line as a status", async () => {
    const sync = new FakeSync(room.sessions[0]!);
    sync.snapshot = { ...sync.snapshot, phase: "seeding" };
    await render(sync, locale);
    const status = container.querySelector(".collab-sync-progress")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe(copy.sync.syncing);
  });

  it("localizes errors and only enables Retry while connected", async () => {
    const session = room.sessions[0]!;
    const sync = new FakeSync(session);
    sync.snapshot = {
      ...sync.snapshot,
      phase: "error",
      error: "Could not save shared file 'src/main.bp': it keeps changing on disk.",
      errorCode: "busy",
      errorFile: "src/main.bp",
    };
    await render(sync, locale);
    expect(query("collab-sync-error")!.textContent).toBe(copy.sync.errors.busy("src/main.bp"));
    expect(query("collab-sync-error")!.getAttribute("role")).toBe("alert");
    const retry = query("collab-sync-retry") as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    await act(async () => retry.click());
    expect(sync.retry).toHaveBeenCalledTimes(1);
    await act(async () => session.close("error"));
    expect(retry.disabled).toBe(true);
    const hint = document.getElementById(retry.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(copy.sync.retryOffline);
  });

  it("lists replaced and trashed files with recovery hints until dismissed", async () => {
    const sync = new FakeSync(room.sessions[0]!);
    sync.snapshot = {
      ...sync.snapshot,
      notices: [
        { id: 1, kind: "replaced", files: ["src/main.bp", "src/lib/util.bpi"] },
        { id: 2, kind: "trashed", files: ["stale.bp"] },
      ],
    };
    await render(sync, locale);
    const replaced = query("collab-sync-notice-replaced")!;
    expect(replaced.textContent).toContain(copy.sync.replacedTitle(2));
    expect(replaced.textContent).toContain(copy.sync.replacedBody);
    expect([...replaced.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "src/main.bp",
      "src/lib/util.bpi",
    ]);
    expect(query("collab-sync-notice-trashed")!.textContent).toContain(copy.sync.trashedBody);
    await act(async () => query("collab-sync-dismiss-replaced")!.click());
    expect(sync.dismissNotice).toHaveBeenCalledWith(1);
    expect(query("collab-sync-notice-replaced")).toBeNull();
    expect(query("collab-sync-notice-trashed")).not.toBeNull();
  });

  it("explains why files are not shared", async () => {
    const sync = new FakeSync(room.sessions[0]!);
    sync.snapshot = {
      ...sync.snapshot,
      skipped: ["big.json", "notes.txt"],
      skipReasons: { "big.json": "size", "notes.txt": "format" },
    };
    await render(sync, locale);
    const skipped = query("collab-sync-skipped")!;
    expect(skipped.querySelector("summary")!.textContent).toBe(copy.sync.skipped(2));
    const items = [...skipped.querySelectorAll("li")].map((item) => item.textContent);
    expect(items[0]).toContain(copy.sync.skipReasons.size);
    expect(items[1]).toContain(copy.sync.skipReasons.format);
  });
});

describe.each(["en", "zh-TW"] as const)("removed files dialog (%s)", (locale) => {
  const copy = collabCopy[locale].removedFiles;
  const prompt: RemovedFilesPrompt = {
    id: 1,
    workspaceId: "w",
    roomId: "room_0123456789abcdef",
    files: [{ file: "src/main.bp", content: "unsaved" }],
  };

  async function open(onKeep: (prompt: RemovedFilesPrompt) => Promise<void>) {
    const onDiscard = vi.fn();
    await act(async () =>
      root.render(createElement(RemovedFilesDialog, { prompt, locale, onKeep, onDiscard })),
    );
    return onDiscard;
  }

  it("offers keeping a local copy as the default and discarding", async () => {
    const onKeep = vi.fn(async () => {});
    const onDiscard = await open(onKeep);
    const dialog = document.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(copy.title(1));
    expect(query("collab-removed-files")!.textContent).toBe("src/main.bp");
    expect(query("collab-removed-keep")!.hasAttribute("data-modal-initial")).toBe(true);
    await act(async () => query("collab-removed-keep")!.click());
    expect(onKeep).toHaveBeenCalledWith(prompt);
    await act(async () => query("collab-removed-discard")!.click());
    expect(onDiscard).toHaveBeenCalledWith(prompt);
  });

  it("stays open with an error when the copy cannot be saved", async () => {
    await open(async () => {
      throw new Error("disk full");
    });
    await act(async () => query("collab-removed-keep")!.click());
    const alert = document.querySelector('.collab-removed-dialog [role="alert"]')!;
    expect(alert.textContent).toBe(copy.failed);
    expect((query("collab-removed-keep") as HTMLButtonElement).disabled).toBe(false);
  });
});
