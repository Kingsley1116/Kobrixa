// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabJoinChange } from "../../shared/collab.js";
import type { Locale } from "../i18n/copy.js";
import { collabCopy } from "./collab-copy.js";
import { JoinConflictDialog } from "./join-conflict-dialog.js";

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

const changes: CollabJoinChange[] = [
  { path: "main.bp", change: "changed" },
  { path: "lib/new.bpm", change: "added" },
  { path: "old.bp", change: "removed" },
];
const button = (id: string) =>
  document.querySelector<HTMLButtonElement>(`[data-testid=collab-conflict-${id}]`)!;

async function render(locale: Locale, list = changes) {
  const onChoose = vi.fn();
  await act(async () =>
    root.render(
      createElement(JoinConflictDialog, {
        locale,
        projectName: "Robot",
        changes: list,
        onChoose,
      }),
    ),
  );
  return onChoose;
}

describe("JoinConflictDialog", () => {
  it.each(["en", "zh-TW"] as const)(
    "offers keep-copy, replace and cancel in %s",
    async (locale) => {
      const copy = collabCopy[locale];
      const onChoose = await render(locale);
      const dialog = document.querySelector("[role=alertdialog]")!;
      expect(dialog.textContent).toContain(copy.joinConflictTitle);
      expect(dialog.textContent).toContain(copy.joinConflictIntro("Robot"));
      expect(dialog.textContent).toContain(copy.joinConflictFiles(3));
      expect(dialog.textContent).toContain(copy.joinReplaceHint);
      const items = [...document.querySelectorAll("[data-testid=collab-conflict-files] li")];
      expect(items.map((item) => item.textContent)).toEqual([
        `main.bp — ${copy.joinConflictChanges.changed}`,
        `lib/new.bpm — ${copy.joinConflictChanges.added}`,
        `old.bp — ${copy.joinConflictChanges.removed}`,
      ]);
      expect(document.querySelector("details")!.open).toBe(true);
      // The non-destructive choice is the default.
      expect(button("keep").hasAttribute("data-modal-initial")).toBe(true);
      expect(button("keep").textContent).toBe(copy.joinKeepCopy);
      expect(button("replace").className).toContain("danger");
      expect(button("replace").textContent).toBe(copy.joinReplace);
      expect(button("cancel").textContent).toBe(copy.cancel);

      await act(async () => button("keep").click());
      await act(async () => button("replace").click());
      await act(async () => button("cancel").click());
      expect(onChoose.mock.calls).toEqual([["keep-copy"], ["replace"], [null]]);
    },
  );

  it("collapses long file lists and cancels on Escape", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      path: `file-${index}.bp`,
      change: "changed" as const,
    }));
    const onChoose = await render("en", many);
    expect(document.querySelector("details")!.open).toBe(false);
    expect(document.querySelectorAll("[data-testid=collab-conflict-files] li")).toHaveLength(12);
    await act(async () =>
      button("cancel").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(onChoose).toHaveBeenCalledWith(null);
  });
});
