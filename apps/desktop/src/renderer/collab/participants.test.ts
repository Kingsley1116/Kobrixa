// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabApi, CollabResult } from "../../shared/collab.js";
import { collabCopy } from "./collab-copy.js";
import { Participants } from "./participants.js";
import type { RosterEntry } from "./roster.js";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const host: RosterEntry = {
  participantId: "host-0001",
  name: "Hal",
  role: "host",
  online: true,
  controlHolder: true,
  self: true,
};
const ada: RosterEntry = {
  participantId: "editor-01",
  name: "Ada",
  role: "editor",
  online: true,
  file: "src/main.bp",
  self: false,
};

type Api = Pick<CollabApi, "kick" | "setRole">;
const ok = async (): Promise<CollabResult<null>> => ({ ok: true, value: null });

async function render(
  locale: "en" | "zh-TW",
  entries: readonly RosterEntry[],
  api: Api = { kick: vi.fn(ok), setRole: vi.fn(ok) },
  closed = false,
): Promise<Api> {
  await act(async () =>
    root.render(
      createElement(Participants, {
        copy: collabCopy[locale],
        api,
        roomId: "room",
        entries,
        isHost: true,
        closed,
      }),
    ),
  );
  return api;
}
const query = (selector: string): HTMLElement | null => document.querySelector(selector);
const text = (selector: string): string => query(selector)?.textContent ?? "";
async function click(selector: string): Promise<void> {
  await act(async () => query(selector)!.click());
}

describe("Participants", () => {
  it.each(["en", "zh-TW"] as const)(
    "shows what each participant is doing in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      await render(locale, [host, ada]);
      const row = query("[data-participant=editor-01]")!;
      expect(row.querySelector("[data-testid=collab-participant-file]")?.textContent).toBe(
        copy.editingFile("src/main.bp"),
      );
      expect(
        query("[data-participant=host-0001] [data-testid=collab-control-badge]")?.textContent,
      ).toBe(copy.controlBadge);
      expect(row.querySelector("[data-testid=collab-control-badge]")).toBeNull();
      expect(row.querySelector(".more-button")?.getAttribute("aria-label")).toBe(
        copy.participantActions("Ada"),
      );
      expect(query("[data-testid=collab-participants-loading]")).toBeNull();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "shows loading before the first roster in %s",
    async (locale) => {
      await render(locale, [{ ...ada, provisional: true }]);
      expect(text("[data-testid=collab-participants-loading]")).toBe(
        collabCopy[locale].peopleLoading,
      );
      expect(query(".collab-count")).toBeNull();
      expect(document.body.textContent).not.toContain(collabCopy[locale].noParticipants);
      await render(locale, [host]);
      expect(query("[data-testid=collab-participants-loading]")).toBeNull();
      expect(document.body.textContent).toContain(collabCopy[locale].noParticipants);
      // A session that closed before any roster arrived stops loading.
      await render(locale, [], undefined, true);
      expect(query("[data-testid=collab-participants-loading]")).toBeNull();
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "confirms demotion and reports progress and success in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      let resolve: (result: CollabResult<null>) => void = () => {};
      const api = await render(locale, [host, ada], {
        kick: vi.fn(ok),
        setRole: vi.fn(() => new Promise<CollabResult<null>>((done) => (resolve = done))),
      });
      await click("[data-participant=editor-01] .more-button");
      await click("[data-participant=editor-01] [role=menuitem]:not(.danger)");
      expect(api.setRole).not.toHaveBeenCalled();
      expect(query(".collab-demote-confirm")?.getAttribute("role")).toBe("alertdialog");
      expect(text(".collab-demote-confirm")).toContain(copy.demoteIntro("Ada"));
      await click(".collab-demote-confirm [data-modal-initial]");
      expect(query(".collab-demote-confirm")).toBeNull();
      expect(api.setRole).not.toHaveBeenCalled();

      await click("[data-participant=editor-01] .more-button");
      await click("[data-participant=editor-01] [role=menuitem]:not(.danger)");
      await click("[data-testid=collab-demote-confirm]");
      expect(api.setRole).toHaveBeenCalledWith("room", {
        participantId: "editor-01",
        role: "viewer",
      });
      expect(
        query("[data-participant=editor-01] [data-testid=collab-participant-pending]"),
      ).not.toBeNull();
      expect(query("[data-participant=editor-01]")?.getAttribute("aria-busy")).toBe("true");
      expect(text("[data-testid=collab-participants-status]")).toBe(copy.changingRole("Ada"));
      await act(async () => resolve({ ok: true, value: null }));
      expect(query("[data-testid=collab-participant-pending]")).toBeNull();
      expect(text("[data-testid=collab-participants-status]")).toBe(
        copy.roleChanged("Ada", "viewer"),
      );
    },
  );

  it.each(["en", "zh-TW"] as const)(
    "promotes viewers without confirmation in %s",
    async (locale) => {
      const api = await render(locale, [host, { ...ada, role: "viewer" }]);
      await click("[data-participant=editor-01] .more-button");
      await click("[data-participant=editor-01] [role=menuitem]:not(.danger)");
      expect(api.setRole).toHaveBeenCalledWith("room", {
        participantId: "editor-01",
        role: "editor",
      });
      expect(text("[data-testid=collab-participants-status]")).toBe(
        collabCopy[locale].roleChanged("Ada", "editor"),
      );
    },
  );

  it.each(["en", "zh-TW"] as const)("maps action errors per action in %s", async (locale) => {
    const copy = collabCopy[locale];
    const api = await render(locale, [host, ada], {
      kick: vi.fn(async () => ({ ok: false, error: "not-found" }) as CollabResult<null>),
      setRole: vi.fn(async () => ({ ok: false, error: "bad-request" }) as CollabResult<null>),
    });
    await click("[data-participant=editor-01] .more-button");
    await click("[data-participant=editor-01] [role=menuitem].danger");
    await click(".collab-kick-confirm .danger");
    expect(api.kick).toHaveBeenCalledWith("room", "editor-01");
    expect(text(".collab-error[role=alert]")).toBe(copy.participantErrors.notFound("Ada"));
    expect(text(".collab-error")).not.toBe(copy.errors["not-found"]);
    expect(text("[data-testid=collab-participants-status]")).toBe("");

    await render(locale, [host, { ...ada, role: "viewer" }], api);
    await click("[data-participant=editor-01] .more-button");
    await click("[data-participant=editor-01] [role=menuitem]:not(.danger)");
    expect(text(".collab-error[role=alert]")).toBe(copy.participantErrors.roleRejected("Ada"));
  });

  it("hides the disclosure glyph from assistive technology", async () => {
    await render("en", [host, { ...ada, online: false }]);
    const toggle = query("button[aria-expanded]")!;
    expect(toggle.querySelector("[aria-hidden=true]")?.textContent).toBe("▸");
    await click("button[aria-expanded]");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.querySelector("[aria-hidden=true]")?.textContent).toBe("▾");
  });
});
