import { afterEach, expect, it, vi } from "vitest";
import { fixture, panel, snapshot, deferred, handle, entry, binding } from "./contract.test.js";
import { UiStateStore, diagnosticsFor } from "./state-store.js";
import { UiIntentController } from "./intent-controller.js";
afterEach(() => vi.useRealTimers());
it("U09/RF2 sends release before a pending begin resolves and cannot revive it", async () => {
  const f = fixture();
  const pending = deferred<Awaited<ReturnType<typeof f.bridge.hold>>>();
  f.bridge.hold.mockReturnValueOnce(pending.promise);
  const state = new UiStateStore(f.bridge, panel, snapshot());
  const intent = new UiIntentController(f.bridge, state);
  intent.begin("hold", { trusted: true, kind: "pointer", id: "1", primary: true, repeat: false });
  intent.release("pointer", "1", false);
  expect(f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual(["begin", "end"]);
  pending.resolve({ ok: true, value: { gesture: handle(4) } });
  await pending.promise;
  vi.useFakeTimers();
  intent.challenge(handle(9));
  await vi.runAllTimersAsync();
  expect(f.bridge.pulse.mock.calls[0]![0]).toMatchObject({ gesture: null, inputToken: null });
});
it.each(["pointercancel", "lostpointercapture", "contextmenu", "Escape", "blur", "form-change"])(
  "U09 cancellation %s is forced and cannot be downgraded by a late release",
  async () => {
    const f = fixture();
    const state = new UiStateStore(f.bridge, panel, snapshot());
    const intent = new UiIntentController(f.bridge, state);
    intent.begin("hold", { trusted: true, kind: "key", id: " ", primary: true, repeat: false });
    intent.cancel();
    intent.release("key", " ", false);
    expect(f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual(["begin", "cancel"]);
  },
);
it("U09 rejects repeat, synthetic events and extra pointers; keyup targets original key", () => {
  const f = fixture();
  const intent = new UiIntentController(f.bridge, new UiStateStore(f.bridge, panel, snapshot()));
  const input = { trusted: true, kind: "key" as const, id: "Enter", primary: true, repeat: true };
  expect(intent.begin("hold", input)).toBe(false);
  expect(intent.begin("hold", { ...input, trusted: false, repeat: false })).toBe(false);
  expect(intent.begin("hold", { ...input, repeat: false })).toBe(true);
  expect(intent.begin("hold", { ...input, kind: "pointer", id: "2", repeat: false })).toBe(false);
  intent.release("key", "x", false);
  expect(f.bridge.hold).toHaveBeenCalledTimes(1);
  intent.release("key", "Enter", false);
  expect(f.bridge.hold).toHaveBeenCalledTimes(2);
});
it("U09/U10 sends only issued challenges next turn; hide is synchronous; exact 350ms is host denied", async () => {
  vi.useFakeTimers();
  const f = fixture();
  let hostNow = 0;
  const issuedAt = 0;
  f.bridge.pulse.mockImplementation(async () =>
    hostNow - issuedAt < 350
      ? { ok: true, value: { accepted: true } }
      : { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Expired" } },
  );
  const state = new UiStateStore(f.bridge, panel, snapshot());
  const intent = new UiIntentController(f.bridge, state);
  intent.begin("hold", { trusted: true, kind: "pointer", id: "1", primary: true, repeat: false });
  await Promise.resolve();
  intent.challenge(handle(7));
  intent.challenge(handle(8));
  expect(f.bridge.pulse).not.toHaveBeenCalled();
  hostNow = 350;
  await vi.runAllTimersAsync();
  expect(f.bridge.pulse).toHaveBeenCalledTimes(1); // coalesced, no catch-up batch
  expect(f.bridge.hold.mock.calls.at(-1)![0].phase).toBe("cancel");
  intent.challenge(handle(8));
  await vi.runAllTimersAsync();
  expect(f.bridge.pulse).toHaveBeenCalledTimes(1);
  intent.hide("collapse");
  expect(f.bridge.visibility.mock.calls.at(-1)![0].visible).toBe(false);
  intent.challenge(handle(10));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.bridge.pulse).toHaveBeenCalledTimes(1);
});

it("AM-22 observes revoke before release IPC and clears queued input on disposal", () => {
  vi.useFakeTimers();
  const f = fixture();
  const state = new UiStateStore(f.bridge, panel, snapshot());
  state.setDiagnosticOwner({
    sourceKey: entry.sourceKey,
    pluginId: entry.pluginId,
    generation: binding.generation,
    hostEpoch: binding.hostEpoch,
    processEpoch: binding.processEpoch,
  });
  const diagnostics = diagnosticsFor(state);
  const order: string[] = [];
  diagnostics.onEvent((event) => order.push(event.kind));
  f.bridge.hold.mockImplementation(async (input) => {
    order.push(input.phase);
    return { ok: true, value: { gesture: input.phase === "begin" ? handle(4) : null } };
  });
  const intent = new UiIntentController(f.bridge, state);
  intent.begin("hold", { trusted: true, kind: "pointer", id: "1", primary: true, repeat: false });
  intent.release("pointer", "1", false);
  expect(order).toEqual(["begin", "revoke", "end"]);
  intent.challenge(handle(9));
  const counters = diagnostics.snapshot();
  expect(Object.isFrozen(counters)).toBe(true);
  expect(counters.timers).toBe(2); // pending begin deadline plus queued input
  expect(counters.queuedBytes).toBeGreaterThan(0);
  intent.dispose();
  state.retire();
  expect(Object.values(diagnostics.snapshot()).every((value) => value === 0)).toBe(true);
  expect(counters.timers).toBe(2); // captured counters stay immutable
  expect(vi.getTimerCount()).toBe(0);
});

import { UiIntent } from "../../main/plugins/ui-intent.js";
it.each(["ack", "release", "blur", "hide", "expired", "null-ack"] as const)(
  "pending pointer begin uses no incomplete gesture pulse: %s",
  async (outcome) => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = deferred<Awaited<ReturnType<typeof f.bridge.hold>>>();
    const state = new UiStateStore(f.bridge, panel, snapshot());
    const intent = new UiIntentController(f.bridge, state);
    const pulseGesture = vi.fn();
    const revokeScope = vi.fn();
    const host = new UiIntent(
      {
        bindMotionScope: () => "scope",
        beginGesture: () => handle(4),
        pulsePanel() {},
        pulseGesture,
        endGesture() {},
        revokeScope,
      },
      () => Date.now(),
      (event) => {
        if (event.type === "pulse") intent.challenge(event.challenge);
      },
    );
    f.bridge.pulse.mockImplementation(async (input) =>
      host.pulse(input.binding, input.challenge, input.gesture, input.inputToken)
        ? { ok: true, value: { accepted: true } }
        : { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Stale" } },
    );
    f.bridge.hold.mockImplementation((input) => {
      if (input.phase === "begin") {
        expect(host.begin(input.binding, input.inputToken)).toBe(handle(4));
        return pending.promise;
      }
      host.end(input.binding, input.inputToken, input.phase);
      return Promise.resolve({ ok: true, value: { gesture: null } });
    });
    try {
      host.bind(binding, {
        owner: { ...entry, ...binding },
        contextRef: "context",
        panelInstance: binding.panelInstance,
        uiResourceGeneration: binding.uiResourceGeneration,
        workbenchInstance: "window",
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.bridge.pulse).toHaveBeenCalledTimes(1);
      f.bridge.pulse.mockClear();
      // Unit admission only; native trusted-pointer evidence is in the captured reports.
      expect(
        intent.begin("hold", {
          trusted: true,
          kind: "pointer",
          id: "1",
          primary: true,
          repeat: false,
        }),
      ).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      expect(f.bridge.pulse).not.toHaveBeenCalled();
      expect(f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual(["begin"]);
      expect(pulseGesture).not.toHaveBeenCalled();
      if (outcome === "release") intent.release("pointer", "1", false);
      if (outcome === "blur") intent.focus(false);
      if (outcome === "hide") await intent.hide("sidebar");
      if (outcome === "expired") {
        await vi.advanceTimersByTimeAsync(249);
        expect(revokeScope).toHaveBeenCalledTimes(1); // Original 350 ms host deadline.
      }
      const token = f.bridge.hold.mock.calls[0]![0].inputToken;
      pending.resolve({
        ok: true,
        value: {
          gesture: outcome === "null-ack" || outcome === "expired" ? null : handle(4),
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(f.bridge.pulse).not.toHaveBeenCalled(); // No replay on acknowledgement.
      await vi.advanceTimersByTimeAsync(101);
      if (outcome === "ack") {
        expect(f.bridge.pulse).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            gesture: handle(4),
            inputToken: token,
          }),
        );
        expect(pulseGesture).toHaveBeenCalledTimes(1);
        expect(intent.isHolding("hold")).toBe(true);
      } else {
        expect(intent.isHolding("hold")).toBe(false);
        expect(pulseGesture).not.toHaveBeenCalled();
        expect(f.bridge.hold.mock.calls.map(([input]) => input.phase)).toEqual([
          "begin",
          outcome === "release" ? "end" : "cancel",
        ]);
      }
    } finally {
      intent.dispose();
      state.retire();
      host.dispose();
    }
  },
);
