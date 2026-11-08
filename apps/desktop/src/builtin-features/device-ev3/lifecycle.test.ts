import { expect, it, vi } from "vitest";
import type { Principal } from "@kobrixa/plugin-runtime";
import { createDeviceBroker } from "../../main/device-broker/broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "../../main/device-broker/fake-provider.js";
import {
  LegacyDevice,
  createSessionPowerLifecycle,
} from "../../main/device-broker/legacy-device.js";
import { LegacyFiles } from "../../main/device-broker/legacy-files.js";
import { DeviceService } from "../../main/device/device.js";
import { ExecutionController } from "../../renderer/execution/execution.js";
import type { BuildEvent, KobrixaApi } from "../../shared/api.js";
import type { BuildService } from "../../main/workspace/build.js";

function fixture(autoReconnect = false) {
  let authorized = true;
  const h = operationHarness();
  const principal: Principal = {
    kind: "core",
    adapter: "deployment",
    hostEpoch: ID,
    workbenchInstance: ID,
    authorityContext: { ref: ID, epoch: ID },
  };
  const broker = createDeviceBroker({
    profile: h.dependencies.profile,
    journal: h.dependencies.journal,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: authorized ? "local" : "invalid",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: { claim: () => true, isClaimed: () => true, complete() {} },
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: autoReconnect,
      usbRetryInterval: 1000,
      usbRetryLimit: 3,
    }),
  });
  h.provider.describe = () => ({
    key: h.provider.session,
    descriptor: { ...h.provider.descriptor, transport: autoReconnect ? "usb" : "wifi" },
    physical: h.provider.physical,
    capabilities: [...h.provider.capabilities],
  });
  if (autoReconnect)
    h.provider.discover = async () => ({
      value: [
        {
          key: h.provider.candidate,
          descriptor: { ...h.provider.descriptor, transport: "usb" },
          physical: h.provider.physical,
        },
      ],
      dispatch: "not-sent",
      error: null,
      stopConfirmation: "not-required",
    });
  const registration = broker.registerProvider(h.provider);
  const legacy = new LegacyDevice({
    broker,
    principal: () => principal,
    disconnect: async () => {},
    stop: async (sessionId) => {
      const result = await broker.stopCurrentDevice({
        sessionId,
        action: { actionToken: ID, scope: { hostEpoch: ID, workbenchInstance: ID } },
      });
      if (!result.ok) throw new Error(result.error.message);
    },
    feed: { subscribe: async () => async () => {} },
  });
  const service = new DeviceService(
    { deployableArtifacts: async () => [] } as unknown as BuildService,
    () => undefined,
    undefined,
    { device: legacy, files: new LegacyFiles(broker, () => principal, h.dependencies.now) },
  );
  let listener: (e: BuildEvent) => void = () => {};
  const save = vi.fn(async () => {});
  const stop = vi.fn(service.stop.bind(service)),
    deploy = vi.fn(service.deploy.bind(service)),
    run = vi.fn(service.run.bind(service));
  const execution = new ExecutionController({
    build: {
      onEvent: (l: typeof listener) => {
        listener = l;
        return () => {};
      },
      start: async (workspaceId: string) => {
        listener({
          type: "complete",
          workspaceId,
          buildId: "b1",
          result: {
            buildId: "b1",
            target: "ev3-native",
            deploy: "ev3",
            success: true,
            diagnostics: [],
            runtimeDirectory: "/robot",
            artifacts: [
              {
                slot: "program",
                kind: "rbf",
                role: "deploy-main",
                mediaType: "application/octet-stream",
                path: "/tmp/demo.rbf",
                sha256: "abc",
                byteLength: 1,
              },
            ],
          },
        });
        return "b1";
      },
    },
    device: { onEvent: service.subscribe.bind(service), stop, deploy, run },
  } as unknown as KobrixaApi);
  const detach = execution.attach();
  execution.setWorkspace("workspace");
  const connect = async () => {
    const result = await broker.request(
      pluginPrincipal(),
      "devices/connect",
      { target: { kind: "wifi-address", providerId: h.provider.id, address: "192.168.1.2" } },
      new AbortController().signal,
    );
    if (!result.ok) throw Error(result.error.message);
    return result.value.session.sessionId;
  };
  return {
    ...h,
    broker,
    invalidateAuthority: () => {
      authorized = false;
    },
    legacy,
    service,
    execution,
    save,
    stop,
    deploy,
    run,
    connect,
    request: { workspaceId: "workspace", saveAll: save },
    async close() {
      detach();
      await registration.retirement!.retire();
    },
  };
}
it("E5 real public broker connection adopts through LegacyDevice and DeviceService and executes one pending Run", async () => {
  const f = fixture();
  let confirmStop!: () => void;
  const stopReply = new Promise<void>((resolve) => {
    confirmStop = resolve;
  });
  const stopAndReadback = f.provider.stopAndReadback.bind(f.provider);
  vi.spyOn(f.provider, "stopAndReadback").mockImplementation(async (...args) => {
    const result = await stopAndReadback(...args);
    await stopReply;
    return result;
  });
  try {
    await f.execution.run(f.request);
    const observed = vi.fn();
    f.service.subscribe((event) => {
      if (event.type === "session-catalog" && event.cause === "connected" && event.session) {
        expect(f.legacy.sessionIds()).toContain(event.session.sessionId);
        observed();
      }
    });
    const id = await f.connect();
    expect(observed).toHaveBeenCalledOnce();
    expect(f.legacy.sessionIds()).toEqual([id]);
    expect(f.legacy.descriptor(id).id).toBe(id);
    await vi.waitFor(() => expect(f.provider.stopAndReadback).toHaveBeenCalledOnce());
    expect(f.execution.getSnapshot().phase).toBe("stopping");
    expect(f.deploy).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    confirmStop();
    await vi.waitFor(() => {
      expect(f.execution.getSnapshot().error).toBeUndefined();
      expect(f.run).toHaveBeenCalledOnce();
    });
    expect(f.deploy).toHaveBeenCalledWith(id, "b1", "/robot");
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.stop).toHaveBeenCalledBefore(f.deploy);
    expect(f.deploy).toHaveBeenCalledBefore(f.run);
    expect(f.provider.calls.filter((call) => call === "stop" || call === "run")).toEqual([
      "stop",
      "run",
    ]);
    expect(f.provider.calls).toContain("run");
    f.service.publishSessionCatalog();
    await Promise.resolve();
    expect(f.run).toHaveBeenCalledOnce();
  } finally {
    confirmStop();
    await f.close();
  }
});
it.each(["cancel", "authority", "workspace"])(
  "E5 real catalog cannot revive %s-invalidated pending intent",
  async (reason) => {
    const f = fixture();
    try {
      await f.execution.run(f.request);
      if (reason === "cancel") f.execution.cancelWaiting();
      if (reason === "authority") {
        f.execution.setDeviceControlBlocked(true);
        f.execution.setDeviceControlBlocked(false);
      }
      if (reason === "workspace") {
        f.execution.setWorkspace("other");
        f.execution.setWorkspace("workspace");
      }
      await f.connect();
      await Promise.resolve();
      expect(f.save).not.toHaveBeenCalled();
      expect(f.stop).not.toHaveBeenCalled();
      expect(f.deploy).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  },
);
it("E5 power callback sees public descriptors synchronously and resumes the original receipt after catalog removal", async () => {
  const f = fixture();
  try {
    const id = await f.connect();
    let receipt: ReturnType<typeof f.broker.sessions.quiesce> | undefined;
    const resume = vi.fn(async (original: string) => {
      expect(original).toBe(id);
    });
    const power = createSessionPowerLifecycle({
      sessionIds: () => f.legacy.sessionIds(),
      suspend: async (original) => {
        expect(f.legacy.descriptor(original).id).toBe(id);
        receipt = f.broker.sessions.quiesce(original, { reason: "suspended" });
        await receipt.settled;
      },
      resume,
    });
    await power.suspend();
    expect(receipt?.sessionId).toBe(id);
    f.provider.lose();
    expect(f.legacy.sessionIds()).toEqual([]);
    await power.resume();
    await power.resume();
    expect(resume).toHaveBeenCalledOnce();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.provider.calls.filter((x) => x === "connect")).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("E5 failed power wake keeps its exact original identity retryable", async () => {
  let ids = ["original"];
  const resume = vi.fn().mockRejectedValueOnce(Error("blocked")).mockResolvedValue(undefined);
  const power = createSessionPowerLifecycle({
    sessionIds: () => ids,
    suspend: async () => {
      ids = ["replacement"];
    },
    resume,
  });
  await power.suspend();
  await expect(power.resume()).rejects.toThrow("blocked");
  await power.resume();
  expect(resume.mock.calls).toEqual([["original"], ["original"]]);
});

it("E5 discovery while awaiting a device preserves explicit pending intent", async () => {
  const f = fixture();
  try {
    await f.execution.run(f.request);
    await f.broker.request(
      pluginPrincipal(),
      "devices/discover",
      { providerId: f.provider.id },
      new AbortController().signal,
    );
    const id = await f.connect();
    await vi.waitFor(() => expect(f.run).toHaveBeenCalledOnce());
    expect(f.execution.getSnapshot().error).toBeUndefined();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(id);
    expect(f.stop).toHaveBeenCalledBefore(f.deploy);
    expect(f.deploy).toHaveBeenCalledBefore(f.run);
  } finally {
    await f.close();
  }
});
it("E5 a stale real core authority cannot operate an observed public session", async () => {
  const f = fixture();
  try {
    const id = await f.connect();
    f.invalidateAuthority();
    await expect(f.service.run(id, "/robot/demo.rbf")).rejects.toThrow();
    expect(f.provider.calls).not.toContain("run");
  } finally {
    await f.close();
  }
});
it("E5 public USB recovery adopts replacement without replay and preserves once-only loss handling", async () => {
  vi.useFakeTimers();
  const f = fixture(true);
  try {
    await f.execution.run(f.request);
    const old = await f.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.execution.getSnapshot().error).toBeUndefined();
    expect(f.stop).toHaveBeenCalledExactlyOnceWith(old);
    expect(f.stop).toHaveBeenCalledBefore(f.deploy);
    expect(f.deploy).toHaveBeenCalledBefore(f.run);
    const teardown = vi.fn(async () => {});
    f.service.setBeforeDisconnect(teardown);
    f.provider.lose();
    expect(f.execution.getSnapshot().recovery?.sessionId).toBe(old);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.execution.getSnapshot().session?.id).toBeDefined();
    expect(f.execution.getSnapshot().session?.id).not.toBe(old);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.deploy).toHaveBeenCalledOnce();
    expect(teardown).not.toHaveBeenCalled();
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});
