import { expect, it } from "vitest";
import { UI_LIMITS_V1 as L, UI_RESOURCE_VERSION } from "./ui-limits.js";
it("pins U03/U05/U08/U09 byte, queue and clock constants", () => {
  expect(UI_RESOURCE_VERSION).toBe(1);
  expect(Object.isFrozen(L)).toBe(true);
  expect([L.resourceBytes, L.sourceBytes, L.hostBytes]).toEqual([262144, 1048576, 8388608]);
  expect([L.nodes, L.depth, L.dataSlots, L.fields]).toEqual([256, 8, 64, 32]);
  expect([L.patchBytes, L.patchEntries, L.patchesPerSecond, L.pendingPatches]).toEqual([
    65536, 64, 10, 4,
  ]);
  expect([L.sourceSubscriptions, L.sourcePending, L.hostPending]).toEqual([32, 16, 256]);
  expect([L.queueBytes, L.controlSlots, L.controlBytes]).toEqual([262144, 8, 16384]);
  expect([L.challengeMs, L.expiryMs, L.pendingChallenges]).toEqual([100, 350, 4]);
});
