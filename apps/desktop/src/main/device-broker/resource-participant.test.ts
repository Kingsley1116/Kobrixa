import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DeviceDisposition, DeviceDrainGrant } from "@kobrixa/plugin-runtime";
import { createDeviceResourceParticipant, type ResourceDriver } from "./resource-participant.js";
it("F17/F19 revokes in the calling turn, returns the same grant and retains failed journal disposition", async () => {
  const owner: ResourceOwner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
  };
  const drain: DeviceDrainGrant = {
    owner,
    reservationId: randomUUID(),
    lastSequence: 9,
    expiresMonotonicMs: 10000,
  };
  let revoked = false,
    settle!: (value: DeviceDisposition) => void;
  const settled = new Promise<DeviceDisposition>((resolve) => {
    settle = resolve;
  });
  const lease = { drain, settled };
  const driver: ResourceDriver = {
    revokeOwner: vi.fn(() => {
      revoked = true;
      return lease;
    }),
    revokeProvider: vi.fn(() => [settled]),
    revokeAll: vi.fn(() => [settled]),
  };
  const resources = createDeviceResourceParticipant(driver);
  const result = resources.retire(owner, "disabled");
  expect(revoked).toBe(true);
  expect(result.drain).toBe(drain);
  expect(result.settled).toBe(settled);
  expect(resources.retire(owner, "shutdown").drain).toBe(drain);
  settle({ stopConfirmed: true, journalCommitted: false, faultIds: ["fault"] });
  expect(await result.settled).toMatchObject({ stopConfirmed: true, journalCommitted: false });
  expect(await resources.retireProvider("kobrixa.device-ev3", 1)).toMatchObject({
    journalCommitted: false,
    faultIds: ["fault"],
  });
  expect(await resources.beginShutdown()).toMatchObject({ journalCommitted: false });
});
it("F17 no resources is an explicit empty disposition; rejected cleanup never becomes success", async () => {
  const driver: ResourceDriver = {
    revokeOwner: () => {
      throw new Error("unused");
    },
    revokeProvider: () => [],
    revokeAll: () => [Promise.reject(new Error("provider-stalled"))],
  };
  const resources = createDeviceResourceParticipant(driver);
  expect(await resources.retireProvider("kobrixa.device-ev3", 1)).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
  expect(await resources.beginShutdown()).toEqual({
    stopConfirmed: false,
    journalCommitted: false,
    faultIds: [],
  });
});

it("provider retirement preserves rejected driver evidence and joins every deferred obligation before retry", async () => {
  const error = new Error("driver retirement failed");
  let finish!: (value: DeviceDisposition) => void;
  const deferred = new Promise<DeviceDisposition>((resolve) => {
    finish = resolve;
  });
  const revoke = vi
    .fn<ResourceDriver["revokeProvider"]>()
    .mockReturnValueOnce([Promise.reject(error), deferred])
    .mockReturnValue(
      [{ stopConfirmed: true, journalCommitted: true, faultIds: [] }].map((value) =>
        Promise.resolve(value),
      ),
    );
  const resources = createDeviceResourceParticipant({
    revokeOwner: () => {
      throw new Error("unused");
    },
    revokeProvider: revoke,
    revokeAll: () => [],
  });
  const pending = resources.retireProvider("kobrixa.device-ev3", 1);
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  finish({ stopConfirmed: true, journalCommitted: false, faultIds: ["retained-fault"] });
  await expect(pending).rejects.toMatchObject({
    errors: [error],
    disposition: {
      stopConfirmed: false,
      journalCommitted: false,
      faultIds: ["retained-fault"],
    },
  });
  expect(await resources.retireProvider("kobrixa.device-ev3", 1)).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [],
  });
});
