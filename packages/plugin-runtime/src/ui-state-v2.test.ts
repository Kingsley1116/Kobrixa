import { expect, it } from "vitest";
import {
  RpcPeer,
  createMemoryChannelPair,
  type PanelResourceV2,
  type ResourceOwner,
} from "@kobrixa/plugin-protocol";
import { UiStateRegistry } from "./ui-state.js";
const h = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: ResourceOwner = {
  sourceKey: "test",
  pluginId: "test.lab",
  generation: 1,
  hostEpoch: h(1),
  processEpoch: h(2),
};
const uiOwner = { sourceKey: owner.sourceKey, pluginId: owner.pluginId, uiResourceGeneration: 1 };
const scope = { hostEpoch: owner.hostEpoch, workbenchInstance: h(3) };
function resource(): PanelResourceV2 {
  return {
    kind: "panel",
    root: "root",
    fields: {},
    nodes: [{ id: "root", type: "group", layout: "stack", children: [] }],
    data: {
      presentation: {
        schema: {
          type: "number",
          nullable: false,
          integer: true,
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        },
        initial: 0,
      },
    },
    datasets: { code: { kind: "code" } },
    presentationKey: "presentation",
  };
}
function input() {
  const [channel] = createMemoryChannelPair();
  const peer = new RpcPeer(channel);
  return {
    owner: uiOwner,
    id: "test.lab.panel",
    scope,
    resource: resource(),
    version: 2 as const,
    activateInitialized: async () => ({
      peer,
      owner,
      requirements: [],
      principal: () => ({ kind: "plugin" as const, owner, authorityContext: null }),
    }),
  };
}
it("keeps v2 opt-in and copies the supported-version policy", async () => {
  const versions: (1 | 2)[] = [1];
  const state = new UiStateRegistry({ current: () => true, supportedResourceVersions: versions });
  versions.push(2);
  expect(await state.open(input())).toMatchObject({
    ok: false,
    error: { detail: { reason: "version" } },
  });
  expect(await new UiStateRegistry({ current: () => true }).open(input())).toMatchObject({
    ok: false,
  });
});
it("binds immutable resources to one original registration and revokes it on close or generation loss", async () => {
  let current = true;
  const state = new UiStateRegistry({ current: () => current, supportedResourceVersions: [1, 2] });
  const request = input();
  const opened = await state.open(request);
  if (!opened.ok) throw new Error("open failed");
  const binding = opened.value.binding;
  const original = state.dataAuthority(owner, binding)!;
  expect(original).toMatchObject({ version: 2, visible: false, presentation: 0 });
  expect(Object.isFrozen(original.resource.data)).toBe(true);
  request.resource.datasets.code = { kind: "list", columns: [] };
  expect(original.resource.datasets.code).toEqual({ kind: "code" });
  state.visibility(owner, binding, true);
  const visible = state.dataAuthority(owner, binding)!;
  expect(visible.registration).toBe(original.registration);
  expect(visible.visible).toBe(true);
  expect(state.dataAuthority({ ...owner, processEpoch: h(99) }, binding)).toBeNull();
  expect(state.dataAuthority(owner, { ...binding, uiResourceGeneration: 2 })).toBeNull();
  current = false;
  expect(state.dataAuthority(owner, binding)).toBeNull();
  current = true;
  state.close(owner, binding);
  expect(state.dataAuthority(owner, binding)).toBeNull();
  const reopened = await state.open(input());
  if (!reopened.ok) throw new Error("reopen failed");
  expect(state.dataAuthority(owner, reopened.value.binding)!.registration).not.toBe(
    original.registration,
  );
});
it("publishes monotonic presentation through scalar CAS without changing drafts or the data payload", async () => {
  const state = new UiStateRegistry({ current: () => true, supportedResourceVersions: [2] });
  const opened = await state.open(input());
  if (!opened.ok) throw new Error("open failed");
  const binding = opened.value.binding;
  expect(state.patch(owner, { binding, baseRevision: 0, set: { presentation: 2 } })).toEqual({
    ok: true,
    value: { revision: 1 },
  });
  expect(state.dataAuthority(owner, binding)!.presentation).toBe(2);
  expect(state.patch(owner, { binding, baseRevision: 1, set: { presentation: 1 } }).ok).toBe(false);
  expect(state.patch(owner, { binding, baseRevision: 1, set: { presentation: 2.5 } }).ok).toBe(
    false,
  );
  expect(state.state(owner, binding)).toMatchObject({
    ok: true,
    value: { revision: 1, formRevision: 0, form: {}, data: { presentation: 2 } },
  });
  state.retireExecution(owner, "process-gone");
  expect(state.dataAuthority(owner, binding)).toBeNull();
});
it("retains admitted progress constraints across patches and rebuilds them for a replacement resource", async () => {
  const state = new UiStateRegistry({ current: () => true, supportedResourceVersions: [2] });
  const request = input();
  const progress = {
    id: "progress",
    type: "progress" as const,
    value: { ref: { scope: "data" as const, key: "presentation" } },
    max: 10,
    label: { en: "Progress" },
  };
  request.resource.nodes.push(progress);
  const root = request.resource.nodes[0]!;
  if (root.type !== "group") throw new Error("root");
  root.children.push(progress.id);
  const opened = await state.open(request);
  if (!opened.ok) throw new Error("open failed");
  const binding = opened.value.binding;
  progress.max = 100; // The caller cannot relax a live registration's projection.
  expect(state.patch(owner, { binding, baseRevision: 0, set: { presentation: 5 } }).ok).toBe(true);
  expect(state.patch(owner, { binding, baseRevision: 1, set: { presentation: 11 } }).ok).toBe(
    false,
  );
  expect(state.state(owner, binding)).toMatchObject({
    ok: true,
    value: { revision: 1, data: { presentation: 5 } },
  });
  state.retireResource(uiOwner, "resource-replaced");
  const replacement = await state.open({
    ...request,
    owner: { ...uiOwner, uiResourceGeneration: 2 },
  });
  if (!replacement.ok) throw new Error("replacement failed");
  expect(
    state.patch(owner, {
      binding: replacement.value.binding,
      baseRevision: 0,
      set: { presentation: 11 },
    }).ok,
  ).toBe(true);
  expect(state.patch(owner, { binding, baseRevision: 1, set: { presentation: 6 } }).ok).toBe(false);
  state.retireExecution(owner, "process-gone");
});
