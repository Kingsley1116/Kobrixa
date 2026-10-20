// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { PanelResourceV1 } from "@kobrixa/plugin-protocol";
import { labels, validationContext } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { fixture, panel, snapshot, entry, binding } from "./contract.test.js";
import { UiStateStore, diagnosticsFor as stateDiagnostics } from "./state-store.js";
import { UiIntentController } from "./intent-controller.js";
import { PanelTree, LiveText } from "./components.js";
import { assertRenderable } from "./bootstrap.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); document.body.replaceChildren(); });
export function allNodes(): PanelResourceV1 {
  const resource = structuredClone(panel);
  resource.fields.range = structuredClone(resource.fields.speed!);
  resource.fields.name = { schema: { type: "string", maxLength: 100, nullable: false }, initial: "", required: false };
  resource.fields.mode = { schema: { type: "enum", values: ["a", "b"], nullable: false }, initial: "a", required: true };
  resource.nodes.push(
    { id: "text", type: "text", value: { text: { en: "<img src=x onerror=alert(1)>" } }, emphasis: "strong" },
    { id: "help", type: "help", value: { text: { en: "Help" } } },
    { id: "name", type: "textInput", field: "name", label: { en: "Name" }, help: { en: "Plain text" } },
    { id: "range", type: "range", field: "range", step: 0.1, label: { en: "Range" } },
    { id: "choice", type: "choice", field: "mode", label: { en: "Mode" }, presentation: "segmented", options: [{ value: "a", label: { en: "A" } }, { value: "b", label: { en: "B" } }] },
    { id: "status", type: "status", text: { text: { en: "Stopped" } }, tone: "success" },
    { id: "alert", type: "alert", text: { text: { en: "Warning" } }, severity: "warning" },
    { id: "progress", type: "progress", value: { ref: { scope: "data", key: "count" } }, max: 100, label: { en: "Progress" } },
    { id: "kv", type: "keyValue", rows: [{ id: "count", label: { en: "Count" }, value: { ref: { scope: "data", key: "count" } } }] },
  );
  const root = resource.nodes[0]!; if (root.type === "group") root.children = resource.nodes.slice(1).map((node) => node.id);
  return resource;
}
it.each(["en", "zh-TW"] as const)("U01/U02 renders all 14 types as host controls/plain text in %s", (locale) => {
  const f = fixture(); const resource = allNodes(); assertRenderable(resource, validationContext, new TextEncoder().encode(JSON.stringify(resource)).length);
  const state = new UiStateStore(f.bridge, resource, { ...snapshot(), form: { ...snapshot().form, name: "", mode: "a", range: 0 } });
  const html = renderToStaticMarkup(createElement(PanelTree, { state, intent: new UiIntentController(f.bridge, state), locale, labels }));
  expect(new Set(resource.nodes.map((node) => node.type)).size).toBe(14);
  expect(html).toContain("&lt;img"); expect(html).not.toContain("<img");
  expect(html).toContain(locale === "zh-TW" ? "速度" : "Speed");
  expect(html).toContain('role="radiogroup"'); expect(html).toContain("aria-describedby");
});
it("U02 refuses a whole contribution with unknown/orphan/shared/deep nodes", () => {
  for (const mutate of [
    (r: PanelResourceV1) => { r.nodes[1] = { ...r.nodes[1]!, type: "html" } as never; },
    (r: PanelResourceV1) => { r.nodes.push({ id: "orphan", type: "help", value: { text: { en: "x" } } }); },
    (r: PanelResourceV1) => { const root = r.nodes[0]!; if (root.type === "group") root.children.push("speed"); },
  ]) { const resource = structuredClone(panel); mutate(resource); expect(() => assertRenderable(resource, validationContext, new TextEncoder().encode(JSON.stringify(resource)).length)).toThrow(); }
});
it("U05/U15 preserves focused DOM and raw draft across data patches; hides focus into a visible group", async () => {
  const f = fixture(); const resource = structuredClone(panel);
  resource.nodes[1]!.visibleWhen = { op: "eq", left: { scope: "form", key: "enabled" }, right: false };
  const state = new UiStateStore(f.bridge, resource, snapshot()); const intent = new UiIntentController(f.bridge, state);
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  await act(async () => root.render(createElement(PanelTree, { state, intent, locale: "en", labels })));
  state.setDiagnosticOwner({ sourceKey: entry.sourceKey, pluginId: entry.pluginId, generation: binding.generation, hostEpoch: binding.hostEpoch, processEpoch: binding.processEpoch });
  const committed = vi.spyOn(state, "renderCommitted");
  const events: string[] = [];
  const off = stateDiagnostics(state).onEvent((event) => events.push(event.kind));
  const input = div.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!; input.focus();
  await act(async () => { state.edit("speed", null, "-"); await state.invalidate(1); });
  expect(committed).toHaveBeenCalledWith(1);
  expect(events).toEqual(["apply"]); off();
  expect(document.activeElement).toBe(input); expect(input.value).toBe("-"); expect(input.getAttribute("aria-invalid")).toBe("true");
  await act(async () => state.edit("enabled", true));
  expect(document.activeElement?.getAttribute("data-ui-group")).toBe("root");
  await act(async () => root.unmount());
});
it("U15 rate-limits polite status announcements to 1Hz while alerts are immediate", async () => {
  vi.useFakeTimers(); const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  await act(async () => root.render(createElement(LiveText, { text: "one", alert: false })));
  await act(async () => root.render(createElement(LiveText, { text: "two", alert: false })));
  expect(div.textContent).toBe("one");
  await act(async () => vi.advanceTimersByTimeAsync(1000)); expect(div.textContent).toBe("two");
  await act(async () => root.render(createElement(LiveText, { text: "fault", alert: true })));
  expect(div.textContent).toBe("fault"); await act(async () => root.unmount()); expect(vi.getTimerCount()).toBe(0);
});
it.each(["pointercancel", "lostpointercapture", "contextmenu", "Escape", "blur", "element-blur", "visibilitychange", "form-change", "Space", "Enter"])(
  "U09 real host event handler %s cancels the original hold exactly once", async (reason) => {
    const f = fixture(); const state = new UiStateStore(f.bridge, panel, snapshot()); const intent = new UiIntentController(f.bridge, state);
    const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
    await act(async () => root.render(createElement(PanelTree, { state, intent, locale: "en", labels })));
    const button = div.querySelector<HTMLButtonElement>('[data-ui-node="hold"] button')!;
    await act(async () => {
      button.focus();
      const begin = intent.begin.bind(intent);
      // jsdom events cannot be trusted; override only this admission bit, retaining the real controller.
      const admission = vi.spyOn(intent, "begin").mockImplementation((id, input) => begin(id, { ...input, trusted: true }));
      const key = reason === "Space" ? " " : "Enter";
      button.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      button.dispatchEvent(new KeyboardEvent("keydown", { key, repeat: true, bubbles: true }));
      expect(admission).toHaveBeenLastCalledWith("hold", { trusted: false, kind: "key", id: key, primary: true, repeat: true });
      expect(f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual(["begin"]);
      if (reason === "form-change") {
        const input = div.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "1");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      else if (reason === "Escape") button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (reason === "visibilitychange") {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      }
      else if (reason === "element-blur") button.blur();
      else if (reason === "Space" || reason === "Enter") button.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      else if (reason === "blur") window.dispatchEvent(new Event("blur"));
      else button.dispatchEvent(new Event(reason, { bubbles: true }));
      button.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    });
    expect(f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual(["begin", reason === "Space" || reason === "Enter" ? "end" : "cancel"]);
    await act(async () => root.unmount()); intent.dispose(); div.remove();
  },
);


import { validateUiResource } from "@kobrixa/plugin-protocol";
import { URL as NodeURL } from "node:url";
import { readFileSync } from "node:fs";
it("AM-19 uses the main validator for all admitted resource fixtures", () => {
  for (const name of ["valid", "invalid", "maximum"]) {
    const file = JSON.parse(readFileSync(new NodeURL(`../../../../../packages/plugin-protocol/test-fixtures/declarative-ui-v1/${name}.json`, import.meta.url), "utf8"));
    for (const row of file.cases) {
      if (row.phase !== "resource") continue;
      const bytes = new TextEncoder().encode(JSON.stringify(row.input)).length;
      const main = validateUiResource(row.input, validationContext, bytes);
      const browser = () => assertRenderable(row.input, validationContext, bytes);
      if (main.ok) expect(browser).not.toThrow(); else expect(browser).toThrow();
    }
  }
  expect(() => assertRenderable(panel, validationContext, 262145)).toThrow();
  expect(validateUiResource(panel, validationContext, 262144).ok).toBe(true);
  for (const mutate of [
    (r: typeof panel) => { r.nodes.push({ id: "unknown", type: "html" } as never); },
    (r: typeof panel) => { const root = r.nodes[0]!; if (root.type === "group") root.children.push(root.id); },
    (r: typeof panel) => { r.nodes[1] = { ...r.nodes[1]!, field: "missing" } as never; },
  ]) {
    const value = structuredClone(panel); mutate(value);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    expect(validateUiResource(value, validationContext, bytes).ok).toBe(false);
    expect(() => assertRenderable(value, validationContext, bytes)).toThrow();
  }
});

it("bounds text and numeric DOM drafts to 4,000 code points", async () => {
  const f = fixture(); const resource = allNodes();
  const state = new UiStateStore(f.bridge, resource, { ...snapshot(), form: { ...snapshot().form, name: "", mode: "a", range: 0 } });
  const intent = new UiIntentController(f.bridge, state);
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  await act(async () => root.render(createElement(PanelTree, { state, intent, locale: "en", labels })));
  for (const field of ["name", "speed"]) {
    const input = div.querySelector<HTMLInputElement>(`[data-ui-node="${field}"] input`)!;
    expect(input.maxLength).toBe(8000); // DOM counts UTF-16; the handler enforces code points.
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { set.call(input, "😀".repeat(4000)); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(Array.from(state.getSnapshot().raw[field]!)).toHaveLength(4000);
    await act(async () => { set.call(input, "😀".repeat(4001)); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(Array.from(state.getSnapshot().raw[field]!)).toHaveLength(4000);
  }
  await act(async () => root.unmount()); intent.dispose(); state.retire();
});

it.each(["name", "speed"])("defers declarative %s preedit until compositionend", async (field) => {
  const f = fixture(); const resource = allNodes();
  const state = new UiStateStore(f.bridge, resource, { ...snapshot(), form: { ...snapshot().form, name: "", mode: "a", range: 0 } });
  const edit = vi.spyOn(state, "edit"); const intent = new UiIntentController(f.bridge, state);
  const div = document.createElement("div"); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(PanelTree, { state, intent, locale: "en", labels })));
    const input = div.querySelector<HTMLInputElement>(`[data-ui-node="${field}"] input`)!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => { set.call(input, "2"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
    expect(edit).not.toHaveBeenCalled(); expect(input.value).toBe("2");
    const final = field === "name" ? "中文" : "23";
    await act(async () => { set.call(input, final); input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: final })); });
    expect(edit).toHaveBeenCalledExactlyOnceWith(field, field === "name" ? final : 23, final);
  } finally { await act(async () => root.unmount()); intent.dispose(); state.retire(); }
});
it.each([{ isComposing: true }, { keyCode: 229 }])("ignores hold Enter during IME %j", async (init) => {
  const f = fixture(); const state = new UiStateStore(f.bridge, panel, snapshot()); const intent = new UiIntentController(f.bridge, state);
  const begin = vi.spyOn(intent, "begin"); const div = document.createElement("div"); const root = createRoot(div);
  await act(async () => root.render(createElement(PanelTree, { state, intent, locale: "en", labels })));
  div.querySelector('[data-ui-node="hold"] button')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init }));
  expect(begin).not.toHaveBeenCalled();
  await act(async () => root.unmount()); intent.dispose(); state.retire();
});
