import { expect, it, vi } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { Stage3RuntimePorts } from "./ui-lifecycle.js";
import { retireStage3Owner, resourceFreePersistence150 } from "./ui-lifecycle.js";

const owner: ResourceOwner = {
  sourceKey: "dev:0123456789abcdef",
  pluginId: "acme.probe",
  generation: 2,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};

it("F17 retire/freeze is synchronous; teardown waits for device disposition", async () => {
  const order: string[] = [];
  let finish!: (value: {
    stopConfirmed: boolean;
    faultIds: string[];
    journalCommitted: boolean;
  }) => void;
  const persistence = resourceFreePersistence150();
  const original = persistence.freeze;
  const freeze = vi.spyOn(persistence, "freeze").mockImplementation((...args) => {
    order.push("freeze");
    return original(...args);
  });
  const ports: Stage3RuntimePorts = {
    device: {
      retire() {
        order.push("retire");
        return {
          drain: null,
          settled: new Promise((resolve) => {
            finish = resolve;
          }),
        };
      },
      retireProvider: vi.fn(),
      beginShutdown: vi.fn(),
    },
    persistence,
    ui: {
      retire() {
        order.push("ui");
      },
      catalog: vi.fn(),
      resource: vi.fn(),
      onEvent: () => () => {},
    },
  };
  const result = retireStage3Owner(
    ports,
    owner,
    "disable",
    () => 100,
    async () => {
      throw new Error("No drain RPC at P150");
    },
  );
  expect(order).toEqual(["retire", "ui", "freeze"]);
  expect(freeze).toHaveBeenCalledWith(owner, "disable", 10_100);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(
    retireStage3Owner(
      ports,
      { ...owner },
      "shutdown",
      () => 900,
      async () => {
        throw new Error("No drain RPC at P150");
      },
    ),
  ).toBe(result);
  finish({ stopConfirmed: true, faultIds: [], journalCommitted: true });
  await result;
  expect(freeze).toHaveBeenCalledTimes(1);
});

it("F19 preserves the original grant and never extends its deadline", async () => {
  const grant = {
    owner,
    reservationId: "00000000-0000-4000-8000-000000000003",
    lastSequence: 91,
    expiresMonotonicMs: 8_000,
  };
  const persistence = resourceFreePersistence150();
  const freeze = vi.spyOn(persistence, "freeze");
  const ports: Stage3RuntimePorts = {
    device: {
      retire: () => ({
        drain: grant,
        settled: Promise.resolve({ stopConfirmed: true, faultIds: [], journalCommitted: true }),
      }),
      retireProvider: vi.fn(),
      beginShutdown: vi.fn(),
    },
    persistence,
    ui: { retire: vi.fn(), catalog: vi.fn(), resource: vi.fn(), onEvent: () => () => {} },
  };
  await retireStage3Owner(
    ports,
    { ...owner },
    "reload",
    () => 100,
    async () => {
      throw new Error("No drain RPC at P150");
    },
  );
  expect(freeze).toHaveBeenCalledWith(owner, "reload", 8_000, grant);
});

it("F17 crash uses ownerLost and the 1.5 empty participant never dispatches a storage RPC", async () => {
  const persistence = resourceFreePersistence150();
  const lost = vi.spyOn(persistence, "ownerLost");
  const freeze = vi.spyOn(persistence, "freeze");
  const ports: Stage3RuntimePorts = {
    device: {
      retire: () => ({
        drain: null,
        settled: Promise.resolve({
          stopConfirmed: false,
          faultIds: [owner.hostEpoch],
          journalCommitted: true,
        }),
      }),
      retireProvider: vi.fn(),
      beginShutdown: vi.fn(),
    },
    persistence,
    ui: { retire: vi.fn(), catalog: vi.fn(), resource: vi.fn(), onEvent: () => () => {} },
  };
  const result = await retireStage3Owner(
    ports,
    { ...owner },
    "crashed",
    () => 0,
    async () => {
      throw new Error("No drain RPC at P150");
    },
  );
  expect(result.device.stopConfirmed).toBe(false);
  expect(lost).toHaveBeenCalledWith(owner);
  expect(freeze).not.toHaveBeenCalled();
  const dispatch = vi.fn();
  await persistence.drain(persistence.freeze(owner, "disable", 10_000), dispatch);
  expect(dispatch).not.toHaveBeenCalled();
});

it("F17 caches before synchronous reentry and respects a fractional outer deadline", async () => {
  const persistence = resourceFreePersistence150();
  const freeze = vi.spyOn(persistence, "freeze");
  let joined: Promise<unknown> | undefined;
  const dispatch = vi.fn();
  const ports: Stage3RuntimePorts = {
    device: {
      retire: vi.fn(() => {
        joined = retireStage3Owner(ports, { ...owner }, "shutdown", () => 900, dispatch);
        return {
          drain: null,
          settled: Promise.resolve({ stopConfirmed: true, faultIds: [], journalCommitted: true }),
        };
      }),
      retireProvider: vi.fn(),
      beginShutdown: vi.fn(),
    },
    persistence,
    ui: { retire: vi.fn(), catalog: vi.fn(), resource: vi.fn(), onEvent: () => () => {} },
  };
  const result = retireStage3Owner(ports, owner, "disable", () => 100.25, dispatch, 900.5);
  expect(joined).toBe(result);
  expect(freeze).toHaveBeenCalledExactlyOnceWith(owner, "disable", 900.5);
  await result;
  expect(ports.device.retire).toHaveBeenCalledOnce();
  expect(ports.ui.retire).toHaveBeenCalledOnce();
  expect(dispatch).not.toHaveBeenCalled();
});
