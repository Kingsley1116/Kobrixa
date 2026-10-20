
import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
import type { Stage3ChannelContext } from "./ui-lifecycle.js";
function initializedChannel(): Stage3ChannelContext {
  const [channel] = createMemoryChannelPair();
  return { peer: new RpcPeer(channel), owner, requirements: [],
    principal: () => ({ kind: "plugin", owner, authorityContext: null }) };
}
import { expect, it, vi } from "vitest";
import { UiSubscriptions, type UiEventLedgerPort } from "./ui-subscriptions.js";
import { UiStateRegistry } from "./ui-state.js";
import { resourceFailure, type ResourceOwner, type UiEvent, type Result, type UiSubscriptionSnapshot } from "@kobrixa/plugin-protocol";
const h = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner: ResourceOwner = { sourceKey: "source", pluginId: "test.ui", generation: 1, hostEpoch: h(1), processEpoch: h(2) };
function sharedLedgerFixture() {
  type Record = { owner: ResourceOwner; sequence: number; acknowledged: number; control: number; bytes: number; terminal: boolean };
  const live = new Map<string, Record>(); const tombstones = new Map<string, ResourceOwner>();
  const sent: { id: string; event: UiEvent; delivery: string }[] = [];
  const removed = new Set<(id: string) => void>(); let next = 100; let deviceSubscriptions = 0;
  const matches = (a: ResourceOwner, b: ResourceOwner) => JSON.stringify(a) === JSON.stringify(b);
  const find = (caller: ResourceOwner, id: string) => { const value = live.get(id); return value && matches(caller, value.owner) ? value : undefined; };
  const port: UiEventLedgerPort = {
    create(caller) {
      if (live.size + deviceSubscriptions >= 32) return resourceFailure("quota", 32);
      const subscriptionId = h(next++); live.set(subscriptionId, { owner: caller, sequence: 0, acknowledged: 0, control: 0, bytes: 0, terminal: false });
      return { ok: true, value: { subscriptionId, sequence: 0 } };
    },
    owns: (caller, id) => find(caller, id) !== undefined,
    publish(caller, id, event, delivery) {
      const record = find(caller, id); if (!record) return resourceFailure("stale");
      if (record.terminal) return resourceFailure("stale");
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (delivery === "control" && (record.control >= 7 || bytes > 16384)) return resourceFailure("queue", 8);
      if (delivery === "telemetry" && record.bytes + bytes > 262144) return resourceFailure("queue", 262144);
      record.sequence++; if (delivery === "control") record.control++; else record.bytes += bytes;
      sent.push({ id, event, delivery }); return { ok: true, value: { accepted: true } };
    },
    resync(caller, id) {
      const record = find(caller, id); if (!record) return resourceFailure("stale");
      if (record.control >= 8) return resourceFailure("queue", 8);
      record.control++; record.sequence++; return { ok: true, value: { accepted: true } };
    },
    snapshot(caller, id, read) {
      const record = find(caller, id); if (!record) return resourceFailure("stale");
      const snapshot = read(); if (!snapshot.ok) return snapshot;
      // State and sequence are read in one synchronous turn. ACK owns retained-byte release.
      return { ok: true, value: { sequence: record.sequence, snapshot: snapshot.value } };
    },
    unsubscribe(caller, id) {
      const record = find(caller, id);
      if (!record) return tombstones.has(id) && matches(tombstones.get(id)!, caller)
        ? { ok: true, value: { removed: false } } : resourceFailure("stale");
      live.delete(id); tombstones.set(id, record.owner); for (const listener of removed) listener(id);
      return { ok: true, value: { removed: true } };
    },
    closeAfterControl(caller, id) {
      const record = find(caller, id); if (!record) return;
      record.terminal = true;
      if (record.acknowledged === record.sequence) port.unsubscribe(caller, id);
    },
    onRemoved(listener) { removed.add(listener); return () => { removed.delete(listener); }; },
  };
  return { port, sent, live, setDevices: (count: number) => { deviceSubscriptions = count; },
    ack(caller: ResourceOwner, id: string, sequence: number) {
      const record = find(caller, id); if (!record) throw new Error("stale");
      if (sequence > record.sequence) throw new Error("invalidParams");
      record.acknowledged = Math.max(record.acknowledged, sequence);
      if (record.terminal && record.acknowledged === record.sequence) port.unsubscribe(caller, id);
      return record.acknowledged;
    } };
}
const setup = () => {
  const ledger = sharedLedgerFixture(); const state = new UiStateRegistry({ current: () => true });
  const revocations: string[] = [];
  const subscriptions = new UiSubscriptions(state, ledger.port, (caller) => revocations.push(caller.sourceKey));
  return { ledger, state, subscriptions, revocations };
};
it("U08 shares the 32-subscription quota with devices and validates topic/binding pairing", () => {
  const { ledger, subscriptions } = setup(); ledger.setDevices(31);
  expect(subscriptions.subscribe(owner, { topics: ["instances", "environment"] }).ok).toBe(true);
  expect(subscriptions.subscribe(owner, { topics: ["instances"] })).toMatchObject({ ok: false, error: { detail: { reason: "quota" } } });
  expect(() => subscriptions.subscribe(owner, { topics: ["state"] })).toThrow("Invalid UI subscription");
  expect(() => subscriptions.subscribe(owner, { topics: ["instances", "instances"] })).toThrow();
  subscriptions.dispose();
});
it("U08 snapshot is a source-private sequence barrier and foreign unsubscribe cannot remove it", () => {
  const { ledger, subscriptions } = setup();
  const result = subscriptions.subscribe(owner, { topics: ["environment"] }); if (!result.ok) throw new Error("subscribe failed");
  const id = result.value.subscriptionId;
  subscriptions.environment(owner, "zh-TW", "dark");
  const snapshot = subscriptions.snapshot(owner, id);
  expect(snapshot).toMatchObject({ ok: true, value: { sequence: 1, snapshot: { states: [], instances: [], locale: "zh-TW", theme: "dark" } } });
  expect(subscriptions.snapshot({ ...owner, sourceKey: "foreign" }, id).ok).toBe(false);
  expect(() => ledger.ack(owner, id, 2)).toThrow("invalidParams");
  expect(ledger.ack(owner, id, 1)).toBe(1); expect(ledger.ack(owner, id, 0)).toBe(1);
  expect(subscriptions.unsubscribe({ ...owner, generation: 2 }, id).ok).toBe(false);
  expect(subscriptions.unsubscribe(owner, id)).toEqual({ ok: true, value: { removed: true } });
  expect(subscriptions.unsubscribe(owner, id)).toEqual({ ok: true, value: { removed: false } });
  expect(subscriptions.unsubscribe({ ...owner, generation: 2 }, id).ok).toBe(false);
  subscriptions.dispose();
});
it("U08 control overflow revokes intent before cancelling and does not consume data capacity", () => {
  const { ledger, subscriptions, revocations } = setup();
  const result = subscriptions.subscribe(owner, { topics: ["environment"] }); if (!result.ok) throw new Error("subscribe failed");
  for (let n = 0; n < 8; n++) subscriptions.environment(owner, n % 2 ? "en" : "zh-TW", "dark");
  expect(ledger.sent).toHaveLength(7);
  expect(ledger.sent.every((event) => event.delivery === "control")).toBe(true);
  expect(revocations).toEqual(["source"]);
  expect(ledger.live.size).toBe(0);
  subscriptions.dispose();
});
it("U08 retire removes domain callbacks and cannot leak delivery into a new owner", () => {
  const { ledger, subscriptions } = setup();
  subscriptions.subscribe(owner, { topics: ["instances"] }); subscriptions.retire(owner);
  expect(ledger.live.size).toBe(0);
  subscriptions.environment({ ...owner, generation: 2 }, "en", "light");
  expect(ledger.sent).toHaveLength(0);
  subscriptions.dispose();
});

it("U04/U08 closes only the revoked binding after preserving its terminal control", async () => {
  const { ledger, state, subscriptions } = setup();
  const opened = await state.open({ owner: { sourceKey: owner.sourceKey, pluginId: owner.pluginId, uiResourceGeneration: 1 },
    id: "test.ui.panel", scope: { hostEpoch: owner.hostEpoch, workbenchInstance: h(3) },
    resource: { kind: "panel", data: {}, fields: {}, root: "root", nodes: [
      { id: "root", type: "group", layout: "stack", children: ["text"] },
      { id: "text", type: "help", value: { text: { en: "Ready" } } },
    ] }, activateInitialized: async () => initializedChannel() });
  if (!opened.ok) throw new Error("open failed");
  const binding = opened.value.binding;
  const bound = subscriptions.subscribe(owner, { topics: ["state"], binding });
  const unbound = subscriptions.subscribe(owner, { topics: ["instances"] });
  expect(bound.ok && unbound.ok).toBe(true);
  state.close(owner, binding);
  expect(ledger.sent.map((entry) => entry.event.kind)).toEqual(["ui.revoked", "ui.instances"]);
  expect(ledger.live.size).toBe(2);
  if (!bound.ok) throw new Error("subscription failed");
  ledger.ack(owner, bound.value.subscriptionId, 1);
  expect(ledger.live.size).toBe(1);
  subscriptions.dispose();
});

// Explicit W1-only projection fixtures. Default runs require the real T1 exports.
// These fixtures do not establish protocol validation or P160 acceptance.
vi.mock("@kobrixa/plugin-protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@kobrixa/plugin-protocol")>();
  if (process.env.KOBRIXA_UI_W1 !== "1") return actual;
  const { UI_LIMITS_V1 } = await import("../../plugin-protocol/dist/ui-limits.js");
  const uiBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
  const uiFailure = (reason: string) => ({ ok: false as const, error: {
    code: "PLUGIN_E_UI_RESOURCE", message: "W1 fixture validation failed.", detail: { kind: "ui", reason },
  } });
  const resourceFailure = (reason: string, limit?: number) => ({ ok: false as const, error: {
    code: reason === "stale" ? "PLUGIN_E_STALE_RESOURCE" : "PLUGIN_E_RESOURCE_LIMIT",
    message: "W1 resource failure.", detail: { kind: "resource", reason, resource: "ui-binding",
      ...(limit === undefined ? {} : { limit }) },
  } });
  const { z } = await import("zod");
  const scalar = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
  const binding = z.strictObject({ contributionId: z.string(), panelInstance: z.string(),
    kind: z.enum(["panel", "status"]), uiResourceGeneration: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(), hostEpoch: z.string(), processEpoch: z.string() });
  const uiRequestSchemas = {
    "ui/patch": { params: z.strictObject({ binding, baseRevision: z.number().int().nonnegative(),
      set: z.record(z.string(), scalar) }) },
    "ui/subscribe": { params: z.strictObject({ binding: binding.optional(),
      topics: z.array(z.enum(["instances", "environment", "state", "form", "visibility"])).min(1) }) },
  };
  // Only the number/string/empty-data fixtures used by this projection are admitted.
  const validateUiData = (resource: import("@kobrixa/plugin-protocol").PanelResourceV1 |
    import("@kobrixa/plugin-protocol").StatusResourceV1, data: Record<string, unknown>) => {
    if (Object.keys(data).length !== Object.keys(resource.data).length) return uiFailure("schema");
    for (const [key, value] of Object.entries(data)) {
      const slot = resource.data[key]; if (!slot) return uiFailure("schema");
      const spec = slot.schema;
      if (value === null && spec.nullable) continue;
      if (spec.type === "number" && typeof value === "number" && Number.isFinite(value) &&
        value >= spec.min && value <= spec.max && (!spec.integer || Number.isSafeInteger(value))) continue;
      if (spec.type === "string" && typeof value === "string" && [...value].length <= spec.maxLength) continue;
      return uiFailure("schema");
    }
    if (uiBytes(data) > (resource.kind === "status" ? UI_LIMITS_V1.statusDataBytes : UI_LIMITS_V1.dataBytes))
      return uiFailure("limit");
    return { ok: true as const, value: structuredClone(data) };
  };
  return { ...actual, UI_LIMITS_V1, uiBytes, uiFailure, resourceFailure, uiRequestSchemas, validateUiData };
});
