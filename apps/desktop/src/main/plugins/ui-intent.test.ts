import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiBinding, ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DeviceIntentPort } from "@kobrixa/plugin-runtime";
import { UiIntent } from "./ui-intent.js";
const binding: UiBinding = {
  contributionId: "acme.ui.panel",
  panelInstance: "panel",
  kind: "panel",
  uiResourceGeneration: 2,
  generation: 1,
  hostEpoch: "host",
  processEpoch: "process",
};
const owner: ResourceOwner = {
  sourceKey: "dev:0123456789abcdef",
  pluginId: "acme.ui",
  generation: 1,
  hostEpoch: "host",
  processEpoch: "process",
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function harness() {
  const challenges: string[] = [];
  const device: DeviceIntentPort = {
    bindMotionScope: vi.fn(() => "scope"),
    pulsePanel: vi.fn(),
    beginGesture: vi.fn(() => "gesture"),
    pulseGesture: vi.fn(),
    endGesture: vi.fn(),
    revokeScope: vi.fn(),
  };
  const intent = new UiIntent(
    device,
    () => performance.now(),
    (event) => {
      if (event.type === "pulse") challenges.push(event.challenge);
    },
  );
  intent.bind(binding, {
    owner,
    contextRef: "context",
    panelInstance: binding.panelInstance,
    uiResourceGeneration: binding.uiResourceGeneration,
    workbenchInstance: "window",
  });
  return { device, intent, challenges };
}
it("requires a fresh pulse before motion and emits at 100 ms cadence", async () => {
  const h = harness();
  expect(h.intent.begin(binding, "input")).toBeNull();
  expect(h.intent.pulse(binding, h.challenges[0]!, null, null)).toBe(true);
  expect(h.intent.begin(binding, "input")).toBe("gesture");
  await vi.advanceTimersByTimeAsync(100);
  expect(h.challenges).toHaveLength(2);
  expect(h.intent.pulse(binding, h.challenges[1]!, "gesture", "input")).toBe(true);
  expect(h.device.pulseGesture).toHaveBeenCalledTimes(1);
  h.intent.dispose();
});
it("expires at issue+350, not receipt+350, and never accepts a challenge twice", async () => {
  const h = harness();
  const first = h.challenges[0]!;
  await vi.advanceTimersByTimeAsync(300);
  expect(h.intent.pulse(binding, first, null, null)).toBe(true);
  expect(h.intent.pulse(binding, first, null, null)).toBe(false);
  await vi.advanceTimersByTimeAsync(49);
  expect(h.device.revokeScope).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(h.device.revokeScope).toHaveBeenCalled();
  expect(h.intent.begin(binding, "late")).toBeNull();
  h.intent.dispose();
});
it("release before a delayed command response tombstones the input token synchronously", () => {
  const h = harness();
  h.intent.pulse(binding, h.challenges[0]!, null, null);
  expect(h.intent.begin(binding, "pressed")).toBe("gesture");
  h.intent.end(binding, "pressed", "end");
  expect(h.device.endGesture).toHaveBeenCalledWith("gesture", "released");
  expect(h.intent.begin(binding, "pressed")).toBeNull();
  expect(h.intent.liveGesture(binding, "pressed", "gesture")).toBe(false);
  h.intent.dispose();
});
it("authority changes synchronously retire only the matching context and reject old pulses", () => {
  const h = harness();
  h.intent.pulse(binding, h.challenges[0]!, null, null);
  h.intent.begin(binding, "pressed");
  h.intent.authorityChanged("other-context");
  expect(h.intent.liveGesture(binding, "pressed", "gesture")).toBe(true);
  h.intent.authorityChanged("context");
  expect(h.device.endGesture).toHaveBeenCalledWith("gesture", "cancelled");
  expect(h.device.revokeScope).toHaveBeenCalledWith("scope", "resource-retired");
  expect(h.intent.scope(binding)).toBeUndefined();
  expect(h.intent.pulse(binding, h.challenges[0]!, "gesture", "pressed")).toBe(false);
  expect(h.intent.timerCount()).toBe(0);
  h.intent.dispose();
});
it("a cancel received before begin prevents the late begin", () => {
  const h = harness();
  h.intent.pulse(binding, h.challenges[0]!, null, null);
  h.intent.end(binding, "out-of-order", "cancel");
  expect(h.intent.begin(binding, "out-of-order")).toBeNull();
  expect(h.device.beginGesture).not.toHaveBeenCalled();
  h.intent.dispose();
});
it.each(["hidden", "closed", "window-lost", "resource-retired"] as const)(
  "%s revokes before asynchronous work and rejects old scope/gesture/challenges",
  (reason) => {
    const h = harness();
    h.intent.pulse(binding, h.challenges[0]!, null, null);
    h.intent.begin(binding, "pressed");
    h.intent.revoke(binding, reason);
    expect(h.device.endGesture).toHaveBeenCalledWith("gesture", "cancelled");
    expect(h.device.revokeScope).toHaveBeenCalledWith("scope", reason);
    expect(h.intent.pulse(binding, h.challenges[0]!, "gesture", "pressed")).toBe(false);
    expect(h.intent.begin(binding, "new")).toBeNull();
    h.intent.dispose();
  },
);
it("denies foreign epochs, wrong gestures, second pointers and repeated begin", () => {
  const h = harness();
  expect(h.intent.pulse({ ...binding, processEpoch: "other" }, h.challenges[0]!, null, null)).toBe(
    false,
  );
  h.intent.pulse(binding, h.challenges[0]!, null, null);
  h.intent.begin(binding, "one");
  expect(h.intent.begin(binding, "one")).toBeNull();
  expect(h.intent.begin(binding, "two")).toBeNull();
  expect(h.intent.liveGesture(binding, "one", "foreign")).toBe(false);
  h.intent.dispose();
});
it("keeps token tombstones across hide/show and releases them when the binding closes", () => {
  const h = harness();
  const input = {
    owner,
    contextRef: "context",
    panelInstance: binding.panelInstance,
    uiResourceGeneration: binding.uiResourceGeneration,
    workbenchInstance: "window",
  };
  h.intent.pulse(binding, h.challenges.at(-1)!, null, null);
  h.intent.begin(binding, "old-input");
  h.intent.revoke(binding, "hidden");
  h.intent.bind(binding, input);
  h.intent.pulse(binding, h.challenges.at(-1)!, null, null);
  expect(h.intent.begin(binding, "old-input")).toBeNull();
  h.intent.revoke(binding, "hidden");
  h.intent.revoke(binding, "closed");
  // The registry never reuses a closed binding; direct reuse here probes retained token storage.
  h.intent.bind(binding, input);
  h.intent.pulse(binding, h.challenges.at(-1)!, null, null);
  expect(h.intent.begin(binding, "old-input")).toBe("gesture");
  h.intent.dispose();
});
it("broker rejection between pulse and begin removes local intent immediately", () => {
  const h = harness();
  h.intent.pulse(binding, h.challenges[0]!, null, null);
  vi.mocked(h.device.beginGesture).mockImplementation(() => {
    throw new Error("context retired");
  });
  expect(h.intent.begin(binding, "stale-input")).toBeNull();
  expect(h.intent.scope(binding)).toBeUndefined();
  expect(h.device.revokeScope).toHaveBeenCalledWith("scope", "resource-retired");
  h.intent.dispose();
});
it("common channel revocation matches the entire owner identity", () => {
  const h = harness();
  h.intent.pulse(binding, h.challenges[0]!, null, null);
  h.intent.begin(binding, "pressed");
  for (const foreign of [
    { ...owner, sourceKey: "builtin:other" },
    { ...owner, pluginId: "test.other" },
    { ...owner, generation: owner.generation + 1 },
    { ...owner, hostEpoch: "other-host" },
    { ...owner, processEpoch: "other-process" },
  ])
    h.intent.revokeOwner(foreign);
  expect(h.intent.scope(binding)).toBeDefined();
  h.intent.revokeOwner({ ...owner });
  expect(h.intent.scope(binding)).toBeUndefined();
  expect(h.intent.timerCount()).toBe(0);
  expect(h.device.endGesture).toHaveBeenCalledWith("gesture", "cancelled");
  h.intent.dispose();
});
it("hide then re-show requires a new scope and first fresh heartbeat", () => {
  const h = harness();
  const stale = h.challenges[0]!;
  h.intent.revoke(binding, "hidden");
  h.intent.bind(binding, {
    owner,
    contextRef: "new-context",
    panelInstance: binding.panelInstance,
    uiResourceGeneration: binding.uiResourceGeneration,
    workbenchInstance: "window",
  });
  expect(h.intent.pulse(binding, stale, null, null)).toBe(false);
  expect(h.intent.begin(binding, "new")).toBeNull();
  h.intent.dispose();
});
