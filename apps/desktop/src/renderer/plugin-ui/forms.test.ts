
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { SettingsFormBinding } from "@kobrixa/plugin-runtime";
import type { SettingsScalar, SettingsResourceV1 } from "@kobrixa/plugin-protocol";
import { labels } from "./contract.test.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
import { entry, handle } from "./contract.test.js";
import { SettingsControls, SettingsControlsView } from "./forms.js";
const binding: SettingsFormBinding = { owner: entry, scope: { hostEpoch: handle(1), workbenchInstance: handle(20) }, resourceDigest: "b".repeat(64) };
const resource: SettingsResourceV1 = { schemaVersion: 1, title: { en: "Settings" }, fields: [
  { key: "editor.mode", type: "enum", label: { en: "Mode" }, default: 1, options: [{ value: 1, label: { en: "Numeric one" } }, { value: "1", label: { en: "String one" } }] },
  { key: "editor.size", type: "number", label: { en: "Size" }, default: 12, minimum: 1, maximum: 50 },
] };
it("U01/U15 retains dotted keys and enum types, commits on blur/enter/reset and has no Apply", async () => {
  const controls = new SettingsControls(); const change = vi.fn(); controls.onChange(change);
  const baseline = { schemaVersion: 1, revision: null, values: [{ key: "editor.mode", value: 1 }, { key: "editor.size", value: 12 }] };
  controls.render(binding, resource, { baseline, draft: baseline.values, busyKeys: [], errors: [] });
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  await act(async () => root.render(createElement(SettingsControlsView, { controls, locale: "en", labels })));
  const select = div.querySelector("select")!;
  await act(async () => { select.value = "option1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change).toHaveBeenLastCalledWith(binding, "editor.mode", "1", "change");
  const input = div.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => controls.raw("editor.size", "-"));
  await act(async () => { controls.commit("editor.size", "blur"); });
  expect(change).toHaveBeenCalledTimes(1); expect(input.value).toBe("-");
  await act(async () => controls.render(binding, resource, { baseline: { ...baseline, revision: "r_" + "1".repeat(32) }, draft: baseline.values, busyKeys: [], errors: [] }));
  expect(input.value).toBe("-");
  await act(async () => { controls.raw("editor.size", "13"); controls.commit("editor.size", "enter"); });
  expect(change).toHaveBeenLastCalledWith(binding, "editor.size", 13, "enter");
  await act(async () => controls.commit("editor.size", "reset"));
  expect(change).toHaveBeenLastCalledWith(binding, "editor.size", 12, "reset");
  expect(div.textContent).not.toContain("Apply"); await act(async () => root.unmount()); div.remove();
});
it("U01 bounds forms to 16 fields per page and 8 pages, and disposes only the matching binding", () => {
  const controls = new SettingsControls(); const fields = Array.from({ length: 128 }, (_, index) => ({ type: "boolean" as const, key: `flag${index}`, label: { en: `Flag ${index}` }, default: false }));
  const baseline = { schemaVersion: 1, revision: null, values: fields.map((field) => ({ key: field.key, value: false })) };
  controls.render(binding, { ...resource, fields }, { baseline, draft: baseline.values, busyKeys: [], errors: [] });
  expect(controls.fields(0)).toHaveLength(16); expect(controls.fields(7)).toHaveLength(16);
  expect(() => controls.render(binding, { ...resource, fields: [...fields, fields[0]!] }, { baseline, draft: baseline.values, busyKeys: [], errors: [] })).toThrow();
  controls.dispose({ ...binding, resourceDigest: "c".repeat(64) }); expect(controls.getSnapshot()).not.toBeNull();
  controls.dispose(binding); expect(controls.getSnapshot()).toBeNull();
});

it("bounds local settings raw drafts to 4,000 code points", () => {
  const controls = new SettingsControls(); const baseline = { schemaVersion: 1, revision: null, values: [{ key: "editor.size", value: 12 }] };
  controls.render(binding, resource, { baseline, draft: baseline.values, busyKeys: [], errors: [] });
  controls.raw("editor.size", "😀".repeat(4000));
  expect(Array.from(controls.getSnapshot()!.raw["editor.size"]!)).toHaveLength(4000);
  const before = controls.getSnapshot(); controls.raw("editor.size", "😀".repeat(4001));
  expect(controls.getSnapshot() === before).toBe(true); controls.destroy();
});

// B2-T3 attach: test-only frozen mapping and retained-form methods; replace with
// createSettingsFieldMap/createContributedSettingsForm when their owner lands.
import type { SettingsFieldMap, ContributedSettingsForm } from "@kobrixa/plugin-runtime";
import { attachSettingsControls } from "./host-ports.js";
it("AM-28 attaches frozen mappings and routes retry/reload to the retained form", async () => {
  const controls = new SettingsControls(); const change = vi.fn(); controls.onChange(change);
  const retry = vi.fn<ContributedSettingsForm["retry"]>(async () => {});
  const reload = vi.fn<ContributedSettingsForm["reload"]>(async () => {});
  const map: SettingsFieldMap = {
    field: (key) => { const index = resource.fields.findIndex((f) => f.key === key); if (index < 0) throw new Error("Unknown key"); return `field${index}`; },
    key: (id) => { const field = resource.fields.find((_, index) => id === `field${index}`); if (!field) throw new Error("Unknown field"); return field.key; },
    option: (key, value) => { const field = resource.fields.find((f) => f.key === key); const index = field?.type === "enum" ? field.options.findIndex((o) => o.value === value) : -1; if (index < 0) throw new Error("Unknown value"); return `option${index}`; },
    value: (key, id) => { const field = resource.fields.find((f) => f.key === key); const option = field?.type === "enum" ? field.options.find((_, index) => id === `option${index}`) : undefined; if (!option) throw new Error("Unknown option"); return option.value; },
  };
  const fieldMap = vi.fn(() => map); const detach = attachSettingsControls(controls, { retry, reload, fieldMap });
  expect(() => attachSettingsControls(controls, { retry, reload, fieldMap })).toThrow();
  const baseline = { schemaVersion: 1, revision: null, values: [{ key: "editor.mode", value: 1 }, { key: "editor.size", value: 12 }] };
  controls.render(binding, resource, { baseline, draft: baseline.values, busyKeys: [], errors: [{ key: "editor.size", message: { en: "Conflict" } }] });
  const div = document.createElement("div"); const root = createRoot(div);
  await act(async () => root.render(createElement(SettingsControlsView, { controls, locale: "en", labels })));
  const select = div.querySelector("select")!;
  expect(select.id).toBe(`setting-${binding.scope.workbenchInstance}-field0`);
  await act(async () => { select.value = "option1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(change).toHaveBeenLastCalledWith(binding, "editor.mode", "1", "change");
  await act(async () => [...div.querySelectorAll("button")].find((b) => b.textContent === labels.retry)!.click());
  expect(retry).toHaveBeenCalledWith(binding, "editor.size");
  await act(async () => [...div.querySelectorAll("button")].find((b) => b.textContent === labels.refresh)!.click());
  expect(reload).toHaveBeenCalledWith(binding); expect(change).toHaveBeenCalledTimes(1);
  expect(() => map.value("editor.mode", "foreign")).toThrow(); expect(() => map.key("foreign")).toThrow();
  await act(async () => controls.render(binding, resource, { baseline, draft: [{ key: "editor.mode", value: "foreign" }], busyKeys: [], errors: [] }));
  expect(select.value).toBe(""); expect(select.getAttribute("aria-invalid")).toBe("true");
  expect(select.selectedOptions[0]?.textContent).toBe(labels.invalid);
  await act(async () => root.unmount()); detach(); detach(); controls.destroy();
});

it.each(["string", "number"] as const)("defers %s IME drafts and Enter/blur saves until composition ends", async (type) => {
  const controls = new SettingsControls(); const change = vi.fn(); controls.onChange(change);
  const field = type === "string"
    ? { key: "value", type, label: { en: "Value" }, default: "", minLength: 0, maxLength: 100, maxBytes: 400 }
    : { key: "value", type, label: { en: "Value" }, default: 1, minimum: 0, maximum: 100 };
  const baseline = { schemaVersion: 1, revision: null, values: [{ key: "value", value: field.default }] };
  controls.render(binding, { ...resource, fields: [field] }, { baseline, draft: baseline.values, busyKeys: [], errors: [] });
  const div = document.createElement("div"); document.body.append(div); const root = createRoot(div);
  try {
    await act(async () => root.render(createElement(SettingsControlsView, { controls, locale: "en", labels })));
    const input = div.querySelector("input")!;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
    await act(async () => { set.call(input, "2"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(controls.getSnapshot()!.raw.value).toBeUndefined();
    for (const init of [{ isComposing: true }, { keyCode: 229 }, {}]) {
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init })));
    }
    await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(change).not.toHaveBeenCalled();
    const final = type === "string" ? "中文" : "23";
    await act(async () => { set.call(input, final); input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: final })); });
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, ...init })));
    }
    expect(change).not.toHaveBeenCalled();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(change).toHaveBeenCalledExactlyOnceWith(binding, "value", type === "string" ? final : 23, "enter");
  } finally { await act(async () => root.unmount()); div.remove(); controls.destroy(); }
});

it("U01 port fixture sends one key immediately for boolean/text/enum/number and retains committed CAS snapshot, draft and error", async () => {
  // T7 port fixture only: no BoundSettingsService implementation or disk persistence.
  const controls = new SettingsControls();
  const fields: SettingsResourceV1["fields"] = [
    { key: "editor.enabled", type: "boolean", label: { en: "Enabled" }, default: false },
    {
      key: "editor.name",
      type: "string",
      label: { en: "Name" },
      default: "old",
      minLength: 0,
      maxLength: 100,
      maxBytes: 400,
    },
    ...resource.fields,
  ];
  const settings = { ...resource, fields };
  let baseline = {
    schemaVersion: 1,
    revision: null as string | null,
    values: fields.map((field) => ({ key: field.key, value: field.default })),
  };
  let draft = structuredClone(baseline.values);
  let errors: Array<{ key: string; message: { en: string } }> = [];
  const writes: Array<{
    baseRevision: string | null;
    set: Array<{ key: string; value: SettingsScalar }>;
  }> = [];
  let failure: string | null = null;
  const render = () =>
    controls.render(binding, settings, { baseline, draft, busyKeys: [], errors });
  controls.onChange((_binding, key, value) => {
    writes.push({ baseRevision: baseline.revision, set: [{ key, value }] });
    draft = draft.map((item) => (item.key === key ? { key, value } : item));
    if (failure) errors = [{ key, message: { en: failure } }];
    else {
      baseline = {
        ...baseline,
        revision: "r_" + String(writes.length).repeat(32),
        values: structuredClone(draft),
      };
      errors = [];
    }
    render();
  });
  render();
  const div = document.createElement("div");
  document.body.append(div);
  const root = createRoot(div);
  try {
    await act(async () =>
      root.render(createElement(SettingsControlsView, { controls, locale: "en", labels })),
    );
    await act(async () => div.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(writes).toHaveLength(1);
    expect(writes[0]).toEqual({
      baseRevision: null,
      set: [{ key: "editor.enabled", value: true }],
    });
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const text = div.querySelector<HTMLInputElement>('input[inputmode="text"]')!;
    await act(async () => {
      set.call(text, "new");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(writes).toHaveLength(1);
    await act(async () => text.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(writes[1]!.set).toEqual([{ key: "editor.name", value: "new" }]);
    const select = div.querySelector("select")!;
    await act(async () => {
      select.value = "option1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(writes[2]!.set).toEqual([{ key: "editor.mode", value: "1" }]);
    const number = div.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await act(async () => {
      set.call(number, "23");
      number.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      number.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(writes[3]!.set).toEqual([{ key: "editor.size", value: 23 }]);
    expect(writes).toHaveLength(4);
    await act(async () =>
      [...div.querySelectorAll("button")].filter((b) => b.textContent === labels.reset)[3]!.click(),
    );
    expect(writes[4]!.set).toEqual([{ key: "editor.size", value: 12 }]);
    const committed = structuredClone(baseline);
    for (const message of ["Stale CAS", "Write failed"]) {
      failure = message;
      await act(async () => {
        set.call(number, "31");
        number.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        number.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(writes.at(-1)).toEqual({
        baseRevision: committed.revision,
        set: [{ key: "editor.size", value: 31 }],
      });
      expect(controls.getSnapshot()!.state.baseline).toEqual(committed);
      expect(
        controls.getSnapshot()!.state.draft.find((item) => item.key === "editor.size")!.value,
      ).toBe(31);
      expect(number.value).toBe("31");
      expect(div.querySelector('[role="alert"]')!.textContent).toBe(message);
    }
    expect(writes).toHaveLength(7);
    expect(writes.every((write) => write.set.length === 1)).toBe(true);
    expect(
      [...div.querySelectorAll("button")].some((button) => button.textContent === "Apply"),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    div.remove();
    controls.destroy();
  }
});

it("U01 Enter followed by committed-snapshot delivery and blur must not emit a duplicate mutation", () => {
  const controls = new SettingsControls();
  const change = vi.fn();
  controls.onChange(change);
  const baseline = {
    schemaVersion: 1,
    revision: null,
    values: [
      { key: "editor.mode", value: 1 },
      { key: "editor.size", value: 12 },
    ],
  };
  try {
    controls.render(binding, resource, {
      baseline,
      draft: baseline.values,
      busyKeys: [],
      errors: [],
    });
    controls.raw("editor.size", "23");
    controls.commit("editor.size", "enter");
    const committed = {
      ...baseline,
      revision: "r_" + "1".repeat(32),
      values: [
        { key: "editor.mode", value: 1 },
        { key: "editor.size", value: 23 },
      ],
    };
    controls.render(binding, resource, {
      baseline: committed,
      draft: committed.values,
      busyKeys: [],
      errors: [],
    });
    controls.commit("editor.size", "blur");
    expect(change).toHaveBeenCalledExactlyOnceWith(binding, "editor.size", 23, "enter");
  } finally {
    controls.destroy();
  }
});

it("U01 clean blur stays idle while edits after success and failed-save blur remain writable", () => {
  const controls = new SettingsControls();
  const change = vi.fn();
  controls.onChange(change);
  const render = (value: number, error = false) => {
    const values = [{ key: "editor.size", value }];
    controls.render(binding, resource, {
      baseline: { schemaVersion: 1, revision: null, values },
      draft: values,
      busyKeys: [],
      errors: error ? [{ key: "editor.size", message: { en: "Stale CAS" } }] : [],
    });
  };
  try {
    render(12);
    controls.commit("editor.size", "blur");
    expect(change).not.toHaveBeenCalled();
    controls.raw("editor.size", "23.0");
    controls.commit("editor.size", "enter");
    render(23);
    controls.commit("editor.size", "blur");
    expect(change).toHaveBeenCalledTimes(1);
    controls.raw("editor.size", "24");
    controls.commit("editor.size", "blur");
    expect(change).toHaveBeenLastCalledWith(binding, "editor.size", 24, "blur");
    render(24);
    controls.raw("editor.size", "23");
    controls.commit("editor.size", "enter");
    render(24, true);
    controls.commit("editor.size", "blur");
    expect(change).toHaveBeenCalledTimes(4);
    expect(change).toHaveBeenLastCalledWith(binding, "editor.size", 23, "blur");
    expect(controls.getSnapshot()!.raw["editor.size"]).toBe("23");
    expect(controls.getSnapshot()!.state.baseline.values[0]!.value).toBe(24);
  } finally { controls.destroy(); }
});
