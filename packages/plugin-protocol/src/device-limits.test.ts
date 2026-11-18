import { expect, it } from "vitest";
import { DEVICE_LIMITS_V1 as L } from "./device-limits.js";
it("F06/F21 retains independent clocks and finite queue bounds", () => {
  expect([L.prepareMs, L.intentMs, L.jogPulseMs, L.motionMs, L.stopMs, L.finalJournalMs]).toEqual([
    5000, 350, 400, 30000, 15000, 5000,
  ]);
  expect([L.motorExchangeMs, L.exchangeMs, L.fileExchangeMs]).toEqual([2000, 5000, 10000]);
  expect([L.sourcePending, L.safetyPending, L.controlSlots, L.ordinaryControlSlots]).toEqual([
    16, 4, 8, 7,
  ]);
  expect([L.recordingMs, L.recordingFrames, L.retainedMs]).toEqual([1800000, 3600, 10000]);
});
