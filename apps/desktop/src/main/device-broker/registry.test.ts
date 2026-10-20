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
    ledger.ack(owner, id, send.mock.calls.at(-1)![0].sequence);
    expect(ledger.diagnostics()).toEqual({ subscriptions: 0, queuedEvents: 0, queuedBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
