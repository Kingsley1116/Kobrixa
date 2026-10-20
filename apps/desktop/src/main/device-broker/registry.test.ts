import { expect, it } from "vitest";
import { OwnerLedger, ownerKey, ProviderRegistry } from "./registry.js";
import { FakeProvider, pluginPrincipal } from "./fake-provider.js";
it("F01 conflicts are order independent and F02 handles are owner scoped", () => {
  for (const reversed of [false, true]) {
    const registry = new ProviderRegistry();
    const a = new FakeProvider(),
      b = new FakeProvider();
    for (const provider of reversed ? [b, a] : [a, b]) registry.add(provider);
    expect(() => registry.get(a.id)).toThrow();
    expect(registry.list()[0]?.state).toBe("conflict");
  }
  const ledger = new OwnerLedger<number>(4, 16, "operation");
  const p = pluginPrincipal();
  const id = ledger.add(ownerKey(p), 1);
  expect(ledger.get(ownerKey(p), id)).toBe(1);
  expect(() => ledger.get(ownerKey(pluginPrincipal(2)), id)).toThrow();
  expect(() =>
    ledger.get(ownerKey({ ...p, owner: { ...p.owner, sourceKey: "dev:0000000000000000" } }), id),
  ).toThrow();
});

import { EventLedger } from "./registry.js";
import { vi } from "vitest";
it("control ACK expiry revokes intent without polling and releases terminal accounting", async () => {
  vi.useFakeTimers();
  try {
    let now = 0;
    const revoke = vi.fn(),
      send = vi.fn(),
      ledger = new EventLedger(() => now, send, revoke),
      owner = pluginPrincipal().owner;
    const created = ledger.create(owner);
    if (!created.ok) throw new Error("create");
    const id = created.value.subscriptionId;
    ledger.publish(
      owner,
      id,
      { kind: "devices.catalog", data: { revision: 1, providers: [], sessions: [] } },
      "control",
    );
    ledger.activate(owner, id);
    expect(ledger.diagnostics().queuedBytes).toBeGreaterThan(0);
    now = 10000;
    await vi.advanceTimersByTimeAsync(10000);
    expect(revoke).toHaveBeenCalledTimes(1);
    now = 10500;
    await vi.advanceTimersByTimeAsync(500);
    expect(ledger.owns(owner, id)).toBe(true);
    expect(ledger.diagnostics().queuedEvents).toBe(1);
    ledger.ack(owner, id, send.mock.calls.at(-1)![0].sequence);
    expect(ledger.diagnostics()).toEqual({ subscriptions: 0, queuedEvents: 0, queuedBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

import { uiEventLedgerPort } from "./broker-port.js";
import { eventEnvelopeSchema } from "@kobrixa/plugin-protocol";
import type { Stage3EventEnvelope } from "@kobrixa/plugin-runtime";
import { frame, ID } from "./fake-provider.js";
it("mixed-domain slots share quotas; terminal control stays charged until ACK", () => {
  let now = 0;
  const sent: unknown[] = [];
  const ledger = new EventLedger(
      () => now,
      (event) => sent.push(event),
      () => {},
    ),
    owner = pluginPrincipal().owner;
  const ids = Array.from({ length: 32 }, (_, i) => {
    const result = (i < 16 ? ledger : uiEventLedgerPort(ledger)).create(owner);
    if (!result.ok) throw new Error("create failed");
    return result.value.subscriptionId;
  });
  expect(ledger.create(owner).ok).toBe(false);
  const id = ids[0]!;
  ledger.publish(
    owner,
    id,
    { kind: "devices.catalog", data: { revision: 0, providers: [], sessions: [] } },
    "control",
  );
  expect(sent).toEqual([]);
  ledger.activate(owner, id);
  expect(sent).toHaveLength(1);
  ledger.closeAfterControl(owner, id);
  expect(ledger.diagnostics().queuedEvents).toBe(1);
  expect(ledger.diagnostics().subscriptions).toBe(32);
  expect(ledger.diagnostics().queuedBytes).toBeGreaterThan(0);
  expect(() => ledger.ack(owner, id, 2)).toThrow();
  ledger.ack(owner, id, 1);
  expect(ledger.diagnostics().subscriptions).toBe(31);
  expect(ledger.diagnostics().queuedBytes).toBe(0);
  const second = ids[1]!;
  ledger.publish(
    owner,
    second,
    { kind: "devices.catalog", data: { revision: 1, providers: [], sessions: [] } },
    "control",
  );
  ledger.activate(owner, second);
  ledger.closeAfterControl(owner, second);
  now = 10000;
  ledger.sweep();
  expect(ledger.owns(owner, second)).toBe(false);
  expect(ledger.diagnostics().queuedBytes).toBe(0);
  ledger.disposeOwner(owner);
  expect(ledger.diagnostics()).toEqual({ subscriptions: 0, queuedEvents: 0, queuedBytes: 0 });
});
it("snapshot preserves exact failure details and captures state with its sequence", () => {
  const ledger = new EventLedger(
      () => 0,
      () => {},
      () => {},
    ),
    owner = pluginPrincipal().owner;
  const created = ledger.create(owner);
  if (!created.ok) throw new Error("create failed");
  const id = created.value.subscriptionId;
  ledger.publish(
    owner,
    id,
    { kind: "devices.catalog", data: { revision: 1, providers: [], sessions: [] } },
    "control",
  );
  expect(ledger.snapshot(owner, id, () => ({ ok: true as const, value: { revision: 1 } }))).toEqual(
    { ok: true, value: { sequence: 1, snapshot: { revision: 1 } } },
  );
  const failure = {
    ok: false as const,
    error: {
      code: "PLUGIN_E_PERMISSION_DENIED" as const,
      message: "denied",
      detail: { kind: "permission" as const, reason: "permission" as const },
    },
  };
  expect(ledger.snapshot(owner, id, () => failure)).toBe(failure);
});
const owner = pluginPrincipal().owner;
it.each(["ack", "unsubscribe", "timeout"] as const)("retains terminal control until %s", (mode) => {
  let now = 0;
  const delivered: Stage3EventEnvelope[] = [];
  const ledger = new EventLedger(
    () => now,
    (event) => delivered.push(event),
    () => {},
  );
  const removed: string[] = [];
  ledger.onRemoved((id) => removed.push(id));
  const admitted = ledger.create(owner);
  if (!admitted.ok) throw new Error("admission failed");
  const id = admitted.value.subscriptionId;
  ledger.publish(
    owner,
    id,
    { kind: "ui.environment", data: { locale: "en", theme: "dark" } },
    "control",
  );
  expect(delivered).toEqual([]);
  expect(() => ledger.ack(owner, id, 1)).toThrow();
  ledger.activate(owner, id);
  expect(() => ledger.ack(owner, id, 2)).toThrow();
  ledger.closeAfterControl(owner, id);
  expect(ledger.diagnostics().subscriptions).toBe(1);
  expect(ledger.diagnostics().queuedBytes).toBeGreaterThan(0);
  now = 9999;
  ledger.sweep();
  expect(removed).toEqual([]);
  if (mode === "ack") ledger.ack(owner, id, 1);
  if (mode === "unsubscribe") ledger.unsubscribe(owner, id);
  if (mode === "timeout") {
    now = 10000;
    ledger.sweep();
  }
  expect(removed).toEqual([id]);
  expect(ledger.diagnostics()).toEqual({ subscriptions: 0, queuedEvents: 0, queuedBytes: 0 });
  ledger.unsubscribe(owner, id);
  expect(removed).toEqual([id]);
});
it("accepts synchronous ACK during send", () => {
  const ledger = new EventLedger(
    () => 0,
    (event) => {
      ledger.ack(owner, event.subscriptionId, event.sequence);
    },
    () => {},
  );
  const created = ledger.create(owner);
  if (!created.ok) throw new Error("create");
  const id = created.value.subscriptionId;
  ledger.activate(owner, id);
  expect(() =>
    ledger.publish(
      owner,
      id,
      { kind: "devices.catalog", data: { revision: 0, providers: [], sessions: [] } },
      "control",
    ),
  ).not.toThrow();
  expect(ledger.diagnostics().queuedEvents).toBe(0);
  ledger.dispose();
});
it("throwing send removes its row and demand once", () => {
  const ledger = new EventLedger(
    () => 0,
    () => {
      throw new Error("transport");
    },
    () => {},
  );
  const removed = vi.fn();
  ledger.onRemoved(removed);
  const created = ledger.create(owner);
  if (!created.ok) throw new Error("create");
  const id = created.value.subscriptionId;
  ledger.activate(owner, id);
  expect(() =>
    ledger.publish(
      owner,
      id,
      { kind: "devices.catalog", data: { revision: 0, providers: [], sessions: [] } },
      "control",
    ),
  ).toThrow("transport");
  expect(ledger.owns(owner, id)).toBe(false);
  expect(removed).toHaveBeenCalledExactlyOnceWith(id);
  ledger.unsubscribe(owner, id);
  expect(removed).toHaveBeenCalledTimes(1);
  ledger.dispose();
});
it("telemetry overflow preserves control and reports the dropped frame range", () => {
  const sent: Stage3EventEnvelope[] = [],
    revoke = vi.fn();
  const ledger = new EventLedger(
    () => 0,
    (event) => sent.push(event),
    revoke,
  );
  const create = () => {
    const r = ledger.create(owner);
    if (!r.ok) throw new Error("create");
    return r.value.subscriptionId;
  };
  const id = create(),
    control = create();
  ledger.activate(owner, id);
  ledger.activate(owner, control);
  const publish = (sequence: number) =>
    ledger.publish(
      owner,
      id,
      {
        kind: "devices.telemetry",
        data: {
          sessionId: ID,
          frames: [
            {
              ...frame(),
              sequence,
              values: Array.from({ length: 38 }, () => ({ channelId: ID, value: 1 })),
            },
          ],
          snapshot: { sessionId: ID, revision: 1, status: "unavailable", ageMs: null, frame: null },
        },
      },
      "telemetry",
    );
  for (let sequence = 1; sequence <= 200; sequence++) publish(sequence);
  expect(revoke).not.toHaveBeenCalled();
  expect(() =>
    ledger.publish(
      owner,
      control,
      { kind: "devices.catalog", data: { revision: 0, providers: [], sessions: [] } },
      "control",
    ),
  ).not.toThrow();
  const frames = sent.filter((e) => e.kind === "devices.telemetry"),
    last = frames.at(-1)!;
  expect(frames.length).toBeLessThan(200);
  ledger.ack(owner, id, last.sequence);
  publish(201);
  const next = sent.at(-1)!;
  if (next.kind !== "devices.telemetry") throw new Error("telemetry");
  expect(eventEnvelopeSchema.safeParse(next).success).toBe(true);
  expect(next.data.frames[0]!.gap).toEqual({
    fromSequence: frames.length + 1,
    toSequence: 200,
    reason: "overflow",
  });
  ledger.dispose();
});
it("reports host and source subscription quota limits", () => {
  const ledger = new EventLedger(
    () => 0,
    () => {},
    () => {},
  );
  for (let source = 0; source < 8; source++)
    for (let i = 0; i < 32; i++)
      expect(ledger.create({ ...owner, sourceKey: `builtin:acme.test-${source}` }).ok).toBe(true);
  expect(ledger.create(owner)).toMatchObject({ ok: false, error: { detail: { limit: 256 } } });
  ledger.dispose();
  for (let i = 0; i < 32; i++) ledger.create(owner);
  expect(ledger.create(owner)).toMatchObject({ ok: false, error: { detail: { limit: 32 } } });
  ledger.dispose();
});

it.each(["busy", "read-error"] as const)(
  "overflow preserves an existing %s gap and the widest range",
  (reason) => {
    const sent: Stage3EventEnvelope[] = [];
    const ledger = new EventLedger(
      () => 0,
      (event) => sent.push(event),
      () => {},
    );
    const created = ledger.create(owner);
    if (!created.ok) throw new Error("create");
    const id = created.value.subscriptionId;
    ledger.activate(owner, id);
    const publish = (sequence: number, existing = false) =>
      ledger.publish(
        owner,
        id,
        {
          kind: "devices.telemetry",
          data: {
            sessionId: ID,
            frames: [
              {
                ...frame(),
                sequence,
                values: Array.from({ length: 38 }, () => ({ channelId: ID, value: 1 })),
                ...(existing ? { gap: { fromSequence: 1, toSequence: 201, reason } } : {}),
              },
            ],
            snapshot: {
              sessionId: ID,
              revision: 1,
              status: "unavailable",
              ageMs: null,
              frame: null,
            },
          },
        },
        "telemetry",
      );
    try {
      for (let sequence = 1; sequence <= 200; sequence++) publish(sequence);
      expect(sent.length).toBeLessThan(200);
      ledger.ack(owner, id, sent.at(-1)!.sequence);
      publish(201, true);
      const next = sent.at(-1)!;
      if (next.kind !== "devices.telemetry") throw new Error("telemetry");
      expect(next.data.frames[0]!.gap).toEqual({ fromSequence: 1, toSequence: 201, reason });
    } finally {
      ledger.dispose();
    }
  },
);
