import { expect, it } from "vitest";
import {
  RpcPeer,
  createMemoryChannelPair,
  type PanelResourceV2,
  type ResourceOwner,
} from "@kobrixa/plugin-protocol";
import { UiStateRegistry } from "./ui-state.js";
const h = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture(sync = true) {
  const owner: ResourceOwner = {
    sourceKey: "test.lab",
    pluginId: "test.lab",
    generation: 1,
    hostEpoch: h(1),
    processEpoch: h(2),
  };
  const resource: PanelResourceV2 & { formSync?: true } = {
    kind: "panel",
    root: "root",
    ...(sync ? { formSync: true as const } : {}),
    data: {
      presentation: {
        schema: {
          type: "number",
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
          integer: true,
          nullable: false,
        },
        initial: 0,
      },
    },
    fields: {
      value: {
        schema: { type: "string", maxLength: 100, nullable: false },
        initial: "0",
        required: false,
      },
      hidden: {
        schema: { type: "string", maxLength: 100, nullable: false },
        initial: "original",
        required: false,
      },
    },
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["value", "hidden"] },
      { id: "value", type: "textInput", field: "value", label: { en: "Value" } },
      {
        id: "hidden",
        type: "textInput",
        field: "hidden",
        label: { en: "Hidden" },
        visibleWhen: { op: "eq", left: { scope: "data", key: "presentation" }, right: -1 },
      },
    ],
    presentationKey: "presentation",
    datasets: { code: { kind: "code" } },
  };
  let now = 0;
  const state = new UiStateRegistry({
    current: () => true,
    supportedResourceVersions: [2],
    now: () => now,
  });
  const [channel] = createMemoryChannelPair(),
    peer = new RpcPeer(channel);
  const opened = await state.open({
    owner: { sourceKey: owner.sourceKey, pluginId: owner.pluginId, uiResourceGeneration: 1 },
    id: "test.lab.panel",
    scope: { hostEpoch: owner.hostEpoch, workbenchInstance: h(3) },
    version: 2,
    resource,
    activateInitialized: async () => ({
      peer,
      owner,
      requirements: [],
      principal: () => ({ kind: "plugin" as const, owner, authorityContext: null }),
    }),
  });
  if (!opened.ok) throw Error("open");
  const binding = opened.value.binding;
  state.visibility(owner, binding, true);
  return {
    owner,
    binding,
    state,
    advance: () => {
      now += 1000;
      state.flush();
    },
  };
}
it("patches only opt-in current visible forms with atomic form CAS, preserving data revision", async () => {
  const f = await fixture(),
    events: unknown[] = [];
  f.state.onEvent((_owner, event) => events.push(event));
  expect(
    f.state.formPatch(f.owner, { binding: f.binding, baseFormRevision: 0, set: { value: "-" } }),
  ).toMatchObject({
    ok: true,
    value: { formRevision: 1, form: { value: "-", hidden: "original" } },
  });
  expect(f.state.state(f.owner, f.binding)).toMatchObject({
    ok: true,
    value: { revision: 0, formRevision: 1 },
  });
  expect(events).toMatchObject([{ kind: "ui.form", data: { revision: 1 } }]);
  expect(
    f.state.formPatch(f.owner, { binding: f.binding, baseFormRevision: 0, set: { value: "late" } })
      .ok,
  ).toBe(false);
  expect(
    f.state.formPatch(
      { ...f.owner, processEpoch: h(99) },
      { binding: f.binding, baseFormRevision: 1, set: { value: "foreign" } },
    ).ok,
  ).toBe(false);
  f.state.visibility(f.owner, f.binding, false);
  expect(
    f.state.formPatch(f.owner, {
      binding: f.binding,
      baseFormRevision: 1,
      set: { value: "hidden" },
    }).ok,
  ).toBe(false);
  const old = await fixture(false);
  expect(
    old.state.formPatch(old.owner, {
      binding: old.binding,
      baseFormRevision: 0,
      set: { value: "bad" },
    }).ok,
  ).toBe(false);
});
it("preserves hidden draft values but rejects forged renderer edits to hidden fields", async () => {
  const f = await fixture();
  expect(
    f.state.syncForm(f.owner, {
      binding: f.binding,
      baseFormRevision: 0,
      editSequence: 2,
      form: { value: "draft", hidden: "original" },
    }),
  ).toMatchObject({ ok: true, value: { formRevision: 1, editSequence: 2 } });
  expect(
    f.state.syncForm(f.owner, {
      binding: f.binding,
      baseFormRevision: 1,
      editSequence: 3,
      form: { value: "draft", hidden: "forged" },
    }).ok,
  ).toBe(false);
  expect(
    f.state.formPatch(f.owner, {
      binding: f.binding,
      baseFormRevision: 1,
      set: { hidden: "profile" },
    }).ok,
  ).toBe(true);
  expect(
    f.state.syncForm(f.owner, {
      binding: f.binding,
      baseFormRevision: 1,
      editSequence: 4,
      form: { value: "newer", hidden: "original" },
    }).ok,
  ).toBe(false);
});
it("shares plugin publication budget and keeps bounded user-edit admission separate", async () => {
  const f = await fixture();
  for (let n = 0; n < 10; n++) {
    expect(
      f.state.formPatch(f.owner, {
        binding: f.binding,
        baseFormRevision: n,
        set: { value: String(n) },
      }).ok,
    ).toBe(true);
    f.state.flush();
  }
  expect(
    f.state.patch(f.owner, { binding: f.binding, baseRevision: 0, set: { presentation: 1 } }).ok,
  ).toBe(false);
  expect(
    f.state.syncForm(f.owner, {
      binding: f.binding,
      baseFormRevision: 10,
      editSequence: 1,
      form: { value: "user", hidden: "original" },
    }).ok,
  ).toBe(true);
  f.advance();
  expect(
    f.state.formPatch(f.owner, { binding: f.binding, baseFormRevision: 11, set: { value: "next" } })
      .ok,
  ).toBe(true);
});
it("rejects unknown/prototype fields and malformed values without consuming form revision", async () => {
  const f = await fixture();
  for (const set of [
    { foreign: "bad" },
    { value: NaN },
    { value: "x".repeat(101) },
    JSON.parse('{"__proto__":"bad"}'),
  ])
    expect(f.state.formPatch(f.owner, { binding: f.binding, baseFormRevision: 0, set }).ok).toBe(
      false,
    );
  expect(f.state.state(f.owner, f.binding)).toMatchObject({
    ok: true,
    value: { formRevision: 0, form: { value: "0" } },
  });
});

import { editableFormChange } from "./ui-form.js";
function editableResource(): PanelResourceV2 {
  const field = {
    schema: { type: "boolean" as const, nullable: false },
    initial: false,
    required: false,
  };
  return {
    kind: "panel",
    formSync: true,
    root: "root",
    data: {},
    fields: { a: field, b: field, c: field },
    datasets: {},
    presentationKey: "presentation",
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["a", "b", "c"] },
      { id: "a", type: "boolean", field: "a", label: { en: "A" } },
      {
        id: "b",
        type: "boolean",
        field: "b",
        label: { en: "B" },
        visibleWhen: { op: "eq", left: { scope: "form", key: "a" }, right: true },
      },
      {
        id: "c",
        type: "boolean",
        field: "c",
        label: { en: "C" },
        enabledWhen: { op: "eq", left: { scope: "form", key: "b" }, right: true },
      },
    ],
  };
}
it("admits coalesced edits progressively from current editability without mutating drafts", () => {
  const resource = editableResource(),
    before = { a: false, b: false, c: false },
    after = { a: true, b: true, c: true };
  expect(editableFormChange(resource, {}, before, after)).toBe(true);
  expect(before).toEqual({ a: false, b: false, c: false });
  expect(after).toEqual({ a: true, b: true, c: true });
  expect(editableFormChange(resource, {}, before, { ...before, c: true })).toBe(false);
  // An admitted edit may hide a control that was editable in the current form.
  expect(editableFormChange(resource, {}, after, { a: false, b: false, c: false })).toBe(true);
});
it.each(["visibleWhen", "enabledWhen"] as const)(
  "rejects self-enabling edits through %s",
  (condition) => {
    const resource = editableResource();
    resource.nodes[1]![condition] = { op: "eq", left: { scope: "form", key: "a" }, right: true };
    expect(
      editableFormChange(
        resource,
        {},
        { a: false, b: false, c: false },
        { a: true, b: false, c: false },
      ),
    ).toBe(false);
  },
);
it("rejects mutually revealing changes without a currently editable starting control", () => {
  const resource = editableResource();
  resource.nodes[1]!.enabledWhen = { op: "eq", left: { scope: "form", key: "b" }, right: true };
  expect(
    editableFormChange(
      resource,
      {},
      { a: false, b: false, c: false },
      { a: true, b: true, c: true },
    ),
  ).toBe(false);
});
