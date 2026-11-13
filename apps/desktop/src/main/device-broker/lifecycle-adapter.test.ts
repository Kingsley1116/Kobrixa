import { expect, it, vi } from "vitest";
import type { Principal, DeviceDrainGrant } from "@kobrixa/plugin-runtime";
import { classifyCleanup, retireDeviceOwner } from "./lifecycle-adapter.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const p: Extract<Principal, { kind: "plugin" }> = {
  kind: "plugin",
  owner: {
    sourceKey: "dev:one",
    pluginId: "test.consumer",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  },
  authorityContext: null,
};
const grant: DeviceDrainGrant = {
  owner: p.owner,
  reservationId: id(4),
  lastSequence: 64,
  expiresMonotonicMs: 10_000,
};
const lookup = {
  operationOwner: (operation: string) => (operation === id(3) ? p : null),
  drain: (reservation: string) => (reservation === id(4) ? grant : null),
};
it("F03/F17 permits only original query/stop, never prepare/start or ordinary subscription", () => {
  for (const method of ["devices/motion/query", "devices/motion/stop"] as const)
    expect(classifyCleanup(p, method, { operationId: id(3) }, true, 0, lookup)).toBe(
      "original-motion",
    );
  for (const method of [
    "devices/motion/prepare",
    "devices/motion/start",
    "devices/read",
    "devices/subscribe",
    "events/unsubscribe",
  ])
    expect(classifyCleanup(p, method, { operationId: id(3) }, true, 0, lookup)).toBe("ordinary");
  expect(classifyCleanup(p, "devices/motion/stop", { operationId: id(5) }, true, 0, lookup)).toBe(
    "ordinary",
  );
});
it("F02 rejects changed process/source/host and a completely closed channel", () => {
  for (const patch of [
    { sourceKey: "dev:two" },
    { generation: 2 },
    { hostEpoch: id(8) },
    { processEpoch: id(9) },
  ]) {
    const foreign = { ...p, owner: { ...p.owner, ...patch } };
    expect(
      classifyCleanup(foreign, "devices/motion/stop", { operationId: id(3) }, true, 0, lookup),
    ).toBe("ordinary");
    expect(
      classifyCleanup(
        foreign,
        "devices/recording/read",
        { reservationId: id(4), afterSequence: 0 },
        true,
        0,
        lookup,
      ),
    ).toBe("ordinary");
  }
  expect(classifyCleanup(p, "devices/motion/stop", { operationId: id(3) }, false, 0, lookup)).toBe(
    "closed",
  );
});
it("F19 grants only bounded original final reads and does not renew on query", () => {
  for (const now of [0, 9_999])
    expect(
      classifyCleanup(
        p,
        "devices/recording/read",
        { reservationId: id(4), afterSequence: 63 },
        true,
        now,
        lookup,
      ),
    ).toBe("final-read");
  expect(
    classifyCleanup(p, "devices/recording/query", { reservationId: id(4) }, true, 9_999, lookup),
  ).toBe("final-read");
  for (const now of [10_000, 10_001])
    expect(
      classifyCleanup(
        p,
        "devices/recording/read",
        { reservationId: id(4), afterSequence: 0 },
        true,
        now,
        lookup,
      ),
    ).toBe("ordinary");
  expect(
    classifyCleanup(
      p,
      "devices/recording/read",
      { reservationId: id(4), afterSequence: 65 },
      true,
      0,
      lookup,
    ),
  ).toBe("ordinary");
  expect(
    classifyCleanup(p, "devices/recording/reserve", { reservationId: id(4) }, true, 0, lookup),
  ).toBe("ordinary");
  expect(grant.expiresMonotonicMs).toBe(10_000);
});
it("F17 retirement is synchronous and its stop runner does not consume public RPC slots", async () => {
  const trace: string[] = [];
  const retire = vi.fn(() => {
    trace.push("retire");
    return {
      drain: grant,
      settled: Promise.resolve({ stopConfirmed: true, faultIds: [], journalCommitted: true }),
    };
  });
  const result = retireDeviceOwner({ retire } as never, p.owner, "disabled");
  expect(trace).toEqual(["retire"]);
  expect(result.drain).toBe(grant);
  await expect(result.settled).resolves.toMatchObject({ stopConfirmed: true });
});
