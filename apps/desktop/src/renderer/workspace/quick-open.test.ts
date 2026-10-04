// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuickOpen, type QuickOpenProps } from "./quick-open.js";

let root: Root;
let container: HTMLDivElement;
let opener: HTMLButtonElement;
const props = (): QuickOpenProps => ({
  locale: "en",
  files: ["src/main.bp", "lib/motor.bpi", "kobrixa.json"],
  activeFile: "src/main.bp",
  recentFiles: ["lib/motor.bpi"],
  onOpen: vi.fn(),
  onClose: vi.fn(),
});
const input = () => document.querySelector<HTMLInputElement>("[data-quick-open-query]")!;
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];
const active = () => document.getElementById(input().getAttribute("aria-activedescendant")!);
const key = (value: string, init: KeyboardEventInit = {}) =>
  act(() =>
    input().dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init }),
    ),
  );
const change = (value: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
  container = document.createElement("div");
  opener = document.createElement("button");
  document.body.append(container, opener);
  opener.focus();
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  opener.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("focuses the combobox and navigates without opening a file until Enter", async () => {
  const values = props();
  await act(() => root.render(createElement(QuickOpen, values)));
  expect(document.activeElement).toBe(input());
  expect(active()?.dataset.quickOpenPath).toBe("src/main.bp");
  await key("ArrowDown");
  expect(active()?.dataset.quickOpenPath).toBe("lib/motor.bpi");
  await key("End");
  expect(active()?.dataset.quickOpenPath).toBe("kobrixa.json");
  await key("ArrowDown");
  expect(active()?.dataset.quickOpenPath).toBe("kobrixa.json");
  await key("Home");
  await key("ArrowUp");
  expect(active()?.dataset.quickOpenPath).toBe("src/main.bp");
  expect(values.onOpen).not.toHaveBeenCalled();
  await key("ArrowDown");
  await key("Enter");
  expect(values.onOpen).toHaveBeenCalledExactlyOnceWith("lib/motor.bpi", undefined);
  expect(values.onClose).toHaveBeenCalledOnce();
});

it("filters by path and opens a clicked match at its requested position", async () => {
  const values = props();
  await act(() => root.render(createElement(QuickOpen, values)));
  await key("End");
  await change("LM:12:4");
  expect(options()).toHaveLength(1);
  expect(active()?.dataset.quickOpenPath).toBe("lib/motor.bpi");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("line 12, column 4");
  expect(values.onOpen).not.toHaveBeenCalled();
  await act(() => options()[0]!.click());
  expect(values.onOpen).toHaveBeenCalledExactlyOnceWith("lib/motor.bpi", { line: 12, column: 4 });
});

it("keeps IME Enter, Escape and arrow keys from opening or dismissing the dialog", async () => {
  const values = props();
  await act(() => root.render(createElement(QuickOpen, values)));
  await act(() =>
    input().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
  );
  await key("ArrowDown");
  await key("Enter");
  await key("Escape");
  expect(active()?.dataset.quickOpenPath).toBe("src/main.bp");
  expect(values.onOpen).not.toHaveBeenCalled();
  expect(values.onClose).not.toHaveBeenCalled();
  await act(() => input().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await key("Escape", { isComposing: true });
  expect(values.onClose).not.toHaveBeenCalled();
  await key("Escape");
  expect(values.onClose).toHaveBeenCalledOnce();
});

it("restores focus on dismissal and leaves chosen-file focus to the workbench", async () => {
  const values = props();
  values.onClose = () => root.render(null);
  await act(() => root.render(createElement(QuickOpen, values)));
  await key("Escape");
  expect(document.activeElement).toBe(opener);
  await act(() => root.render(createElement(QuickOpen, values)));
  await key("Enter");
  expect(document.activeElement).not.toBe(opener);
  expect(values.onOpen).toHaveBeenCalledOnce();
});

it("announces empty results in the selected language and never opens an absent selection", async () => {
  const values = { ...props(), locale: "zh-TW" as const };
  await act(() => root.render(createElement(QuickOpen, values)));
  await change("not-found");
  expect(options()).toHaveLength(0);
  expect(input().hasAttribute("aria-activedescendant")).toBe(false);
  expect(document.querySelector(".quick-open-empty")?.textContent).toContain("沒有符合的檔案");
  expect(document.querySelector('[role="status"]')?.textContent).toBe("0 個檔案");
  await key("Enter");
  expect(values.onOpen).not.toHaveBeenCalled();
  expect(values.onClose).not.toHaveBeenCalled();
});

it("caps rendered options and tells users when the result list is incomplete", async () => {
  await act(() =>
    root.render(
      createElement(QuickOpen, {
        ...props(),
        files: Array.from({ length: 120 }, (_, index) => `file-${index}.bp`),
      }),
    ),
  );
  expect(options()).toHaveLength(100);
  expect(document.querySelector('[role="status"]')?.textContent).toContain("100 of 120 files");
});
