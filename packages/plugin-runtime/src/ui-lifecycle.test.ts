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

import { createUiLifetimePort } from "./ui-lifecycle.js";
import type { UiBinding } from "@kobrixa/plugin-protocol";
it("U12 retires UI state, intent and subscriptions exactly once through the host participant", () => {
  const owner: ResourceOwner = {
    sourceKey: "dev:test",
    pluginId: "test.ui",
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const binding: UiBinding = {
    contributionId: "test.ui.panel",
    panelInstance: "panel",
    kind: "panel",
    uiResourceGeneration: 1,
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const order: string[] = [];
  const input: Parameters<typeof createUiLifetimePort>[0] = {
    catalog: {
      catalog: vi.fn(),
      resource: vi.fn(),
      onEvent: () => () => {},
      retire: () => {
        order.push("catalog");
      },
    },
    states: {
      instances: () => [binding],
      retireExecution: vi.fn(() => {
        order.push("state");
      }),
    },
    subscriptions: {
      retire: vi.fn(() => {
        order.push("subscriptions");
      }),
    },
    revoke: (o, b) => {
      expect(o).toBe(owner);
      expect(b).toBe(binding);
      order.push("intent");
    },
  };
  createUiLifetimePort(input).retire(owner);
  expect(order).toEqual(["intent", "state", "subscriptions", "catalog"]);
  expect(input.states.retireExecution).toHaveBeenCalledExactlyOnceWith(owner, "generation-retired");
  expect(input.subscriptions.retire).toHaveBeenCalledExactlyOnceWith(owner);
});

import { RpcPeer, createMemoryChannelPair } from "@kobrixa/plugin-protocol";
import { ChannelActivation } from "./ui-lifecycle.js";
import type { Stage3ChannelContext, Stage3ChannelBinding } from "./ui-lifecycle.js";
function phaseFixture() {
  const owner: ResourceOwner = {
    sourceKey: "builtin:acceptance.ui",
    pluginId: "acceptance.ui",
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const [a, b] = createMemoryChannelPair();
  const host = new RpcPeer(a),
    plugin = new RpcPeer(b);
  let current = true;
  let release!: () => void;
  const initialBinding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const context: Stage3ChannelContext = {
    peer: host,
    owner,
    principal: () => ({ kind: "plugin", owner, authorityContext: null }),
    requirements: [],
  };
  const trace: string[] = [];
  const binding: Stage3ChannelBinding = {
    initialized: async () => {
      trace.push("initialized");
      await initialBinding;
    },
    ready: async () => {
      trace.push("ready");
    },
    dispose: vi.fn(),
  };
  const control = new AbortController();
  const activation = new ChannelActivation(context, binding, control.signal, () => current);
  return {
    activation,
    context,
    binding,
    trace,
    release,
    control,
    stale: () => {
      current = false;
    },
    close: () => {
      activation.dispose();
      host.close();
      plugin.close();
    },
  };
}
it("publishes owner/peer after initialize and lets the first open release readiness", async () => {
  const h = phaseFixture();
  let opened = false;
  const open = h.activation.initialized.then((context) => {
    expect(context).toBe(h.context);
    opened = true;
    h.trace.push("binding");
    h.release();
  });
  expect(opened).toBe(false);
  const completed = h.activation.afterInitialize();
  await open;
  await completed;
  expect(h.trace).toEqual(["initialized", "binding", "ready"]);
  await h.activation.ready;
  h.close();
});
it("coalesces duplicate initialization without duplicate bindings or ready", async () => {
  const h = phaseFixture();
  const a = h.activation.afterInitialize();
  const b = h.activation.afterInitialize();
  expect(a).toBe(b);
  h.release();
  await a;
  expect(h.trace).toEqual(["initialized", "ready"]);
  h.close();
});
it.each(["initialize", "initial-binding", "ready"] as const)(
  "rejects stale owner at %s",
  async (phase) => {
    const h = phaseFixture();
    const failedReady = expect(h.activation.ready).rejects.toBeDefined();
    if (phase === "initialize") h.stale();
    if (phase === "ready")
      h.binding.ready = async () => {
        h.stale();
      };
    const run = h.activation.afterInitialize();
    const failed = expect(run).rejects.toBeDefined();
    if (phase === "initial-binding") h.stale();
    h.release();
    await failed;
    await failedReady;
    h.close();
  },
);
it.each(["initialize", "ready"] as const)(
  "crash during %s rejects both pending phases",
  async (phase) => {
    const h = phaseFixture();
    const ready = expect(h.activation.ready).rejects.toBeDefined();
    if (phase === "initialize") {
      const initialized = expect(h.activation.initialized).rejects.toBeDefined();
      h.control.abort(new Error("process crashed"));
      await initialized;
    } else {
      const run = h.activation.afterInitialize();
      const failed = expect(run).rejects.toBeDefined();
      await h.activation.initialized;
      h.control.abort(new Error("process crashed"));
      await failed;
    }
    await ready;
    h.close();
  },
);
it("retains the original deadline across initialize and initial binding", async () => {
  vi.useFakeTimers();
  const h = phaseFixture();
  const timer = setTimeout(() => h.control.abort(new Error("handshake deadline")), 10_000);
  const ready = expect(h.activation.ready).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(9_500);
  const run = h.activation.afterInitialize();
  const failed = expect(run).rejects.toBeDefined();
  await vi.advanceTimersByTimeAsync(500);
  await failed;
  await ready;
  expect(h.trace).toEqual(["initialized"]);
  clearTimeout(timer);
  h.close();
});

it("R160 disposal rejects an in-flight initial binding without waiting for the host", async () => {
  const h = phaseFixture();
  const failed = expect(h.activation.afterInitialize()).rejects.toThrow("disposed");
  await h.activation.initialized;
  h.activation.dispose();
  await failed;
  h.close();
  expect(h.binding.dispose).toHaveBeenCalledTimes(1);
});

it("R160 coalesces a reentrant host initialization callback", async () => {
  const h = phaseFixture();
  let reentered: Promise<void> | undefined;
  const original = h.binding.initialized;
  h.binding.initialized = async (signal) => {
    if (!reentered) reentered = h.activation.afterInitialize();
    await original(signal);
  };
  const run = h.activation.afterInitialize();
  h.release();
  await run;
  expect(reentered).toBe(run);
  expect(h.trace).toEqual(["initialized", "ready"]);
  h.close();
});
