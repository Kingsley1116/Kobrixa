// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DatasetDialog } from "./dataset-dialog.js";
import { DatasetChart, DatasetCode, DatasetTable } from "./dataset-views.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});
function mount() {
  const div = document.createElement("div");
  document.body.append(div);
  root = createRoot(div);
  return root;
}
it.each(["en", "zh-TW"] as const)(
  "dialog wraps keyboard focus, keeps focus on patch and restores opener (%s)",
  async (locale) => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = vi.fn(),
      mounted = mount();
    const tree = (label: string) =>
      createElement(DatasetDialog, {
        label,
        closeLabel: locale === "zh-TW" ? "關閉" : "Close",
        onClose: close,
        children: createElement("button", { id: "confirm" }, "Confirm"),
      });
    await act(async () => mounted.render(tree("Inspect")));
    const dialog = document.querySelector("dialog")!;
    const first = dialog.querySelector("button")!,
      last = dialog.querySelector<HTMLElement>("#confirm")!;
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(last);
    await act(async () => mounted.render(tree("Inspect updated")));
    expect(document.activeElement).toBe(last);
    last.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(first);
    dialog.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(close).toHaveBeenCalledOnce();
    await act(async () => mounted.render(null));
    expect(document.activeElement).toBe(opener);
  },
);
it("chart keyboard uses 100ms steps, clamps visible time and explicitly follows latest", async () => {
  const change = vi.fn(),
    mounted = mount();
  await act(async () =>
    mounted.render(
      createElement(DatasetChart, {
        label: "Chart",
        declaration: { kind: "chart", series: [{ id: "raw", label: { en: "Raw" } }] },
        header: {
          kind: "chart",
          timeDomain: [0, 1000],
          view: "full",
          series: [
            {
              id: "raw",
              unit: "cm",
              range: [0, 2],
              extrema: [
                [0, 1],
                [0, 1],
              ],
              fullPointCount: 1,
              omittedPoints: 0,
              omittedRuns: 0,
            },
          ],
        },
        points: [[0, 0, 0, 1]],
        locale: "en",
        cursor: null,
        enabled: true,
        onCursor: change,
      }),
    ),
  );
  const slider = document.querySelector("input")!;
  slider.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
  );
  expect(change).toHaveBeenLastCalledWith(900);
  slider.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
  );
  expect(change).toHaveBeenLastCalledWith(1000);
  document.querySelector("button")!.click();
  expect(change).toHaveBeenLastCalledWith(null);
});
it("row and copy actions fire only on explicit activation with current row revision", async () => {
  const selected = vi.fn(),
    copied = vi.fn(),
    mounted = mount();
  await act(async () =>
    mounted.render(
      createElement(
        "div",
        {},
        createElement(DatasetTable, {
          label: "History",
          declaration: {
            kind: "list",
            columns: [{ id: "name", label: { en: "Name" }, value: "string" }],
          },
          rows: [
            {
              key: "opaque-record",
              version: "opaque-version",
              cells: ["<script>untrusted</script>"],
            },
          ],
          locale: "en",
          revision: 7,
          enabled: true,
          actions: [{ id: "delete", label: "Delete", select: selected }],
        }),
        createElement(DatasetCode, {
          label: "Code",
          entries: ["<img src=x>"],
          locale: "en",
          enabled: true,
          onCopy: copied,
        }),
      ),
    ),
  );
  expect(selected).not.toHaveBeenCalled();
  expect(copied).not.toHaveBeenCalled();
  expect(document.querySelector("script,img")).toBeNull();
  document.querySelector<HTMLButtonElement>('button[aria-label="Delete: opaque-record"]')!.click();
  expect(selected).toHaveBeenCalledExactlyOnceWith({ key: "opaque-record", revision: 7 });
  document.querySelector<HTMLButtonElement>(".plugin-dataset-code button")!.click();
  expect(copied).toHaveBeenCalledOnce();
});
