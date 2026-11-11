import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildEvent, DeviceEvent, KobrixaApi, MonitorResult } from "../../shared/api.js";
import type { DeviceInputModes, DeviceMonitorSnapshot } from "@kobrixa/device";
import type { MonitorUpdate } from "../../shared/sensor-lab.js";
import { ExecutionController } from "../../renderer/execution/execution.js";
import { MonitorController } from "../../renderer/device/monitor-controller.js";
import { BatteryStatus } from "../../renderer/device/battery-status.js";
import { SettingsStore } from "../../renderer/settings/settings.js";
import {
  DevicePreferencesStore,
  devicePreferencesPatchSchema,
} from "../../main/device/preferences.js";
import {
  buildResult,
  executionOracle,
  inputModes,
  monitorOracle,
  monitorSample,
  parityRows,
  preferenceCases,
  usb,
} from "./parity-fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(0);

// Only transport boundaries are faked. Both controllers and all stores are real
// checkout code. Unused KobrixaApi members are absent, so accidental calls fail.
function executionHarness() {
  let buildListener!: (event: BuildEvent) => void;
  let deviceListener!: (event: DeviceEvent) => void;
  const calls: string[] = [];
  const device = {
    onEvent: (listener: typeof deviceListener) => {
      deviceListener = listener;
      return () => {};
    },
    connect: vi.fn(async () => "s1"),
    connectWifi: vi.fn(async (_address: string) => "wifi1"),
    disconnect: vi.fn(async (_id: string) => {}),
    deploy: vi.fn(async (id: string, build: string, folder: string) => {
      calls.push(`deploy:${id}:${build}:${folder}`);
    }),
    run: vi.fn(async (id: string, path: string) => {
      calls.push(`run:${id}:${path}`);
    }),
    stop: vi.fn(async (_id: string) => {}),
  };
  const build = {
    onEvent: (listener: typeof buildListener) => {
      buildListener = listener;
      return () => {};
    },
    start: vi.fn(async (workspaceId: string) => {
      calls.push("build");
      buildListener({
        type: "complete",
        workspaceId,
        buildId: "b1",
        result: structuredClone(buildResult),
      });
      return "b1";
    }),
    cancel: vi.fn(async () => {}),
  };
  const controller = new ExecutionController({ device, build } as unknown as KobrixaApi);
  cleanups.push(controller.attach());
  controller.setWorkspace("w1");
  const request = {
    workspaceId: "w1",
    saveAll: async () => {
      calls.push("save");
    },
  };
  const recovery = (state: "waiting" | "connecting" | "cancelled" | "exhausted" | "unavailable") =>
    deviceListener({ type: "usb-recovery", state, previousSessionId: "s1", descriptor: usb });
  const restored = (deployment: "verified" | "changed" = "verified", buildId = "b1") =>
    deviceListener({
      type: "usb-recovery",
      state: "restored",
      previousSessionId: "s1",
      sessionId: "s2",
      descriptor: usb,
      deployment,
      buildId,
    });
  return {
    controller,
    device,
    build,
    calls,
    request,
    recovery,
    restored,
    emit: (event: DeviceEvent) => deviceListener(event),
  };
}
function monitorHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  let listener!: (update: MonitorUpdate) => void;
  const api = {
    onMonitor: (next: typeof listener) => {
      listener = next;
      return () => {};
    },
    watchMonitor: vi.fn(async (sessionId: string, active: boolean): Promise<MonitorUpdate> => ({
      sessionId,
      sequence: 0,
      status: active ? "live" : "paused",
      snapshot: monitorSample(),
    })),
    inputModes: vi.fn(async (): Promise<MonitorResult<DeviceInputModes>> => ({
      status: "ok",
      value: structuredClone(inputModes),
    })),
    setInputMode: vi.fn(
      async (
        _id: string,
        _port: number,
        _type: number,
        mode: number,
      ): Promise<MonitorResult<DeviceMonitorSnapshot>> => {
        const value = monitorSample();
        value.inputs[0]!.mode = mode;
        value.inputs[0]!.modeName = "COL-AMBIENT";
        return { status: "ok", value };
      },
    ),
  };
  const controller = new MonitorController(api);
  cleanups.push(() => controller.dispose());
  controller.configure("s1", true);
  return { controller, api, emit: (update: MonitorUpdate) => listener(update) };
}

describe("E0 legacy execution oracle (P02–P06/P10/P12)", () => {
  it("pending-run: only explicit Run creates save/build/deploy/run intent", async () => {
    const h = executionHarness();
    expect(h.calls).toEqual([]);
    await h.controller.run(h.request);
    expect(h.controller.getSnapshot().phase).toBe("awaitingDevice");
    expect(h.calls).toEqual([]);
    await h.controller.connect(usb);
    expect(h.calls).toEqual(executionOracle.runCalls);
    expect(h.controller.getSnapshot().deployed).toMatchObject(executionOracle.deployed);
  });
  it.each(["cancel", "authority"] as const)(
    "pending-%s: late connection cannot resume cancelled intent",
    async (reason) => {
      const h = executionHarness();
      const reply = deferred<string>();
      h.device.connect.mockReturnValueOnce(reply.promise);
      await h.controller.run(h.request);
      const connecting = h.controller.connect(usb);
      if (reason === "cancel") h.controller.cancelWaiting();
      else h.controller.setDeviceControlBlocked(true);
      reply.resolve("s1");
      await connecting;
      expect(h.controller.getSnapshot()).toMatchObject({ phase: "idle", session: { id: "s1" } });
      expect(h.calls).toEqual(executionOracle.cancelledCalls);
      expect(h.build.start).not.toHaveBeenCalled();
      expect(h.controller.getSnapshot().logs.map((log) => log.message)).toContain("cancelled");
    },
  );
  it("wifi-error-retry: a failed connect consumes pending Run, retry only connects", async () => {
    const h = executionHarness();
    await h.controller.run(h.request);
    h.device.connectWifi.mockRejectedValueOnce(new Error("Wi-Fi timed out"));
    await h.controller.connect("192.168.0.42");
    expect(h.controller.getSnapshot().error).toEqual(executionOracle.wifiError);
    await h.controller.connect("192.168.0.42");
    expect(h.device.connectWifi).toHaveBeenLastCalledWith("192.168.0.42");
    expect(h.controller.getSnapshot()).toMatchObject({
      phase: "idle",
      session: { id: "wifi1", transport: "wifi", name: "EV3 · 192.168.0.42" },
    });
    expect(h.calls).toEqual([]);
  });
  it("reuse-no-replay: connecting an already connected controller does no work", async () => {
    const h = executionHarness();
    await h.controller.connect(usb);
    await h.controller.connect(usb);
    expect(h.device.connect).toHaveBeenCalledTimes(1);
    expect(h.calls).toEqual([]);
  });
  it("recovery-cancel-late: restored events during/after cancellation cannot resurrect a session", async () => {
    const h = executionHarness();
    await h.controller.connect(usb);
    h.recovery("waiting");
    h.recovery("connecting");
    expect(h.controller.getSnapshot().recovery).toMatchObject({
      sessionId: "s1",
      state: "connecting",
    });
    const reply = deferred<void>();
    h.device.disconnect.mockReturnValueOnce(reply.promise);
    const cancel = h.controller.disconnect();
    h.restored();
    expect(h.controller.getSnapshot().session).toBeUndefined();
    reply.resolve();
    await cancel;
    h.restored();
    expect(h.device.disconnect).toHaveBeenCalledWith("s1");
    expect(h.controller.getSnapshot()).toMatchObject({
      session: undefined,
      recovery: undefined,
      phase: "idle",
    });
    h.device.connect.mockResolvedValueOnce("s3");
    await h.controller.connect(usb);
    h.restored();
    expect(h.controller.getSnapshot().session?.id).toBe("s3");
    expect(h.calls).toEqual([]);
  });
  it("recovery-cancel-failure: replacement connect stays blocked until cleanup retry succeeds", async () => {
    const h = executionHarness();
    await h.controller.connect(usb);
    h.recovery("waiting");
    h.device.disconnect.mockRejectedValueOnce(new Error("cleanup failed"));
    await h.controller.connect("192.168.0.42");
    expect(h.device.connectWifi).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot()).toMatchObject({
      recovery: { state: "waiting", sessionId: "s1" },
      error: { phase: "disconnecting", detail: "cleanup failed" },
    });
    await h.controller.disconnect();
    h.restored();
    expect(h.controller.getSnapshot().session).toBeUndefined();
  });
  it.each([
    ["exhausted", "retry-exhausted"],
    ["unavailable", "manual-required"],
  ] as const)("recovery-notices: %s", async (state, notice) => {
    const h = executionHarness();
    await h.controller.connect(usb);
    h.recovery("waiting");
    h.recovery(state);
    h.restored();
    expect(h.controller.getSnapshot()).toMatchObject({
      connectionNotice: notice,
      recovery: undefined,
      session: undefined,
    });
  });
  it.each([
    ["verified", "b1", true],
    ["verified", "other", false],
    ["changed", "b1", false],
  ] as const)(
    "recovery-deployment: %s/%s only preserves verified matching build",
    async (deployment, buildId, valid) => {
      const h = executionHarness();
      await h.controller.connect(usb);
      await h.controller.run(h.request);
      h.recovery("waiting");
      h.restored(deployment, buildId);
      expect(h.controller.getSnapshot().session?.id).toBe("s2");
      expect(h.controller.getSnapshot().deployed?.sessionId).toBe(valid ? "s2" : undefined);
      expect(h.controller.getSnapshot().connectionNotice).toBe(
        valid ? undefined : "upload-required",
      );
      expect(h.calls).toEqual(executionOracle.runCalls); // no replay on restoration
    },
  );
  it("disconnect-failure: retains session/error and permits explicit retry", async () => {
    const h = executionHarness();
    await h.controller.connect(usb);
    h.device.disconnect.mockRejectedValueOnce(new Error("stop unconfirmed"));
    await h.controller.disconnect();
    expect(h.controller.getSnapshot()).toMatchObject({
      session: { id: "s1" },
      error: { phase: "disconnecting", detail: "stop unconfirmed" },
    });
    await h.controller.disconnect();
    expect(h.controller.getSnapshot().session).toBeUndefined();
  });
  it("read-only-stop: authority refuses mode writes but stop remains available", async () => {
    const h = executionHarness();
    await h.controller.connect(usb);
    h.controller.setDeviceControlBlocked(true);
    const write = vi.fn(async () => {});
    await expect(h.controller.withMonitor(write)).rejects.toThrow(
      "Device control is held by another collaborator.",
    );
    await h.controller.run(h.request);
    await h.controller.stop();
    expect(write).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
    expect(h.device.stop).toHaveBeenCalledWith("s1");
  });
  it("file-reservation: blocks modes/run; only matching changed paths invalidate deployment", async () => {
    const h = executionHarness();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    const reply = deferred<void>();
    const work = h.controller.withFiles(() => reply.promise, "list");
    expect(h.controller.getSnapshot().fileBusy).toBe(true);
    await expect(h.controller.withMonitor(async () => {})).rejects.toThrow(
      "Another EV3 operation is in progress.",
    );
    await h.controller.run(h.request);
    expect(h.calls).toEqual(executionOracle.runCalls);
    reply.resolve();
    await work;
    h.emit({ type: "files-changed", sessionId: "old", requestId: "r", paths: ["/robot"] });
    expect(h.controller.getSnapshot().deployed).toBeDefined();
    h.emit({ type: "files-changed", sessionId: "s1", requestId: "r", paths: ["/robot/demo.rbf"] });
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().fileBusy).toBe(false);
  });
});

describe("E0 monitor oracle (P07–P10)", () => {
  it("monitor-values-busy-age: preserves nulls/units/timestamp and marks busy/error/paused without claiming freshness", async () => {
    const h = monitorHarness();
    await flush();
    const sample = h.controller.getSnapshot().snapshot!;
    expect(sample.inputs.map((i) => [i.port, i.state, i.unit, i.values])).toEqual(
      monitorOracle.inputs,
    );
    expect(sample.outputs.map((o) => [o.port, o.state, o.angle])).toEqual(monitorOracle.outputs);
    await vi.advanceTimersByTimeAsync(2501);
    // Characterize actual legacy seam: age gating belongs to Lab UI, not this controller.
    expect(h.controller.getSnapshot().status).toBe("live");
    expect(h.controller.getSnapshot().snapshot?.sampledAt).toBe(10000);
    expect(h.controller.canSwitch(0)).toBe(true);
    h.emit({ sessionId: "s1", sequence: 1, status: "waiting" });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "waiting",
      snapshot: { sampledAt: 10000 },
    });
    expect(h.controller.canSwitch(0)).toBe(false);
    h.emit({ sessionId: "s1", sequence: 2, status: "error", error: "foreground failed" });
    expect(h.controller.getSnapshot()).toMatchObject({
      status: "error",
      error: "foreground failed",
      snapshot: sample,
    });
    await h.controller.drain();
    expect(h.controller.getSnapshot().status).toBe("paused");
    expect(h.controller.getSnapshot().snapshot).toEqual(sample);
  });
  it.each(["running", "unknown", "recording", "empty", "unsupported"])(
    "monitor-gates: %s denies mode traffic",
    async (gate) => {
      const h = monitorHarness();
      await flush();
      const snapshot = monitorSample();
      if (gate === "running" || gate === "unknown") snapshot.program.status = gate;
      if (gate === "empty") snapshot.inputs[0]!.state = "empty";
      if (gate === "unsupported") snapshot.inputs[0]!.switchable = false;
      h.emit({
        sessionId: "s1",
        sequence: 1,
        status: "live",
        snapshot,
        recording: gate === "recording",
      });
      expect(h.controller.canSwitch(0)).toBe(false);
      await h.controller.loadModes(0);
      await h.controller.setMode(0, 1);
      expect(h.api.inputModes).not.toHaveBeenCalled();
      expect(h.api.setInputMode).not.toHaveBeenCalled();
    },
  );
  it("mode-selection: listed mode only, cache invalidates after sensor replacement", async () => {
    const h = monitorHarness();
    await flush();
    await h.controller.setMode(0, 1);
    expect(h.api.setInputMode).not.toHaveBeenCalled();
    await h.controller.loadModes(0);
    await h.controller.loadModes(0);
    await h.controller.setMode(0, 99);
    expect(h.api.inputModes).toHaveBeenCalledTimes(1);
    expect(h.api.setInputMode).not.toHaveBeenCalled();
    await h.controller.setMode(0, 1);
    expect(h.api.setInputMode).toHaveBeenCalledWith("s1", 0, 29, 1);
    expect(h.controller.getSnapshot().snapshot?.inputs[0]).toMatchObject({
      mode: 1,
      modeName: "COL-AMBIENT",
    });
    const snapshot = monitorSample();
    snapshot.inputs[0]!.type = 33;
    h.emit({ sessionId: "s1", sequence: 1, status: "live", snapshot });
    expect(h.controller.getSnapshot().modes).toEqual({});
  });
  it("mode-late-session: old query result cannot populate replacement session cache", async () => {
    const h = monitorHarness();
    await flush();
    const reply = deferred<MonitorResult<DeviceInputModes>>();
    h.api.inputModes.mockReturnValueOnce(reply.promise);
    const loading = h.controller.loadModes(0);
    await flush();
    h.controller.configure("s2", true);
    reply.resolve({ status: "ok", value: inputModes });
    await loading;
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({
      sessionId: "s2",
      modes: {},
      loadingPort: undefined,
    });
    expect(h.api.watchMonitor.mock.calls).toEqual([
      ["s1", true],
      ["s1", false],
      ["s2", true],
    ]);
  });
  it.each(["busy", "error"] as const)(
    "mode-busy-error: %s preserves reading and allows retry after fresh update",
    async (status) => {
      const h = monitorHarness();
      await flush();
      h.api.inputModes.mockResolvedValueOnce(
        status === "busy" ? { status } : { status, category: "timeout", message: "Mode timed out" },
      );
      await h.controller.loadModes(0);
      expect(h.controller.getSnapshot()).toMatchObject({
        status: "waiting",
        loadingPort: undefined,
        snapshot: { sampledAt: 10000 },
      });
      expect(h.controller.getSnapshot().modeError).toBe(
        status === "error" ? "Mode timed out" : undefined,
      );
      h.emit({ sessionId: "s1", sequence: 1, status: "live", snapshot: monitorSample() });
      await h.controller.loadModes(0);
      expect(h.controller.getSnapshot().modeError).toBeUndefined();
      expect(h.api.inputModes).toHaveBeenCalledTimes(2);
    },
  );
  it("monitor-session-sequence: wrong session and duplicate/older frames cannot replace current data", async () => {
    const h = monitorHarness();
    await flush();
    h.emit({ sessionId: "s1", sequence: 3, status: "waiting" });
    for (const [sessionId, sequence] of [
      ["old", 99],
      ["s1", 3],
      ["s1", 2],
    ] as const)
      h.emit({ sessionId, sequence, status: "live", snapshot: monitorSample() });
    expect(h.controller.getSnapshot().status).toBe("waiting");
    h.controller.configure("s2", true);
    await flush();
    expect(h.controller.getSnapshot()).toMatchObject({ sessionId: "s2", status: "live" });
  });
  it("battery-unknown: null is unknown, zero is low, old session cannot overwrite", () => {
    const battery = new BatteryStatus({ onMonitor: () => () => {} });
    cleanups.push(() => battery.dispose());
    battery.setSession("s1");
    const snapshot = monitorSample();
    snapshot.battery = { percent: 0, voltage: 0 };
    battery.observe("s1", snapshot);
    expect(battery.getSnapshot()).toEqual({ sessionId: "s1", percent: 0, voltage: 0, low: true });
    snapshot.battery = { percent: null, voltage: null };
    battery.observe("s1", snapshot);
    expect(battery.getSnapshot()).toEqual({
      sessionId: "s1",
      percent: null,
      voltage: null,
      low: false,
    });
    battery.observe("old", monitorSample());
    expect(battery.getSnapshot().percent).toBeNull();
  });
});

describe("E0 preference oracle (P02/P11)", () => {
  it.each(preferenceCases)(
    "preferences-options: $key defaults, valid patches, invalid values and field reset",
    async ({ key, default: initial, options, invalid }) => {
      const store = new DevicePreferencesStore();
      const applied = vi.fn();
      expect(store.get()[key]).toBe(initial);
      for (const value of options) {
        const patch = devicePreferencesPatchSchema.parse({ [key]: value });
        await store.set(patch, applied);
        expect(store.get()[key]).toBe(value);
      }
      for (const value of invalid)
        expect(devicePreferencesPatchSchema.safeParse({ [key]: value }).success).toBe(false);
      const before = store.get();
      await store.set(devicePreferencesPatchSchema.parse({ [key]: initial }), applied);
      expect(store.get()).toEqual({ ...before, [key]: initial });
      expect(devicePreferencesPatchSchema.parse({ [key]: undefined })).toEqual({});
      expect(devicePreferencesPatchSchema.safeParse({ unknownKey: true }).success).toBe(false);
    },
  );
  it("preferences-commit-retry: failed persistence publishes nothing; retry merges queued fields", async () => {
    const reply = deferred<void>();
    const persist = vi.fn(async () => {});
    persist.mockReturnValueOnce(reply.promise);
    const applied = vi.fn();
    const store = new DevicePreferencesStore(undefined, persist);
    const saving = store.set({ usbAutoReconnect: false }, applied);
    const failure = expect(saving).rejects.toThrow("disk full");
    expect(store.get().usbAutoReconnect).toBe(true);
    expect(applied).not.toHaveBeenCalled();
    reply.reject(new Error("disk full"));
    await failure;
    expect(store.get().usbAutoReconnect).toBe(true);
    expect(applied).not.toHaveBeenCalled();
    await Promise.all([
      store.set({ usbAutoReconnect: false }, applied),
      store.set({ usbRetryLimit: 3 }, applied),
    ]);
    expect(store.get()).toEqual({
      skipUnchangedAssets: true,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
      wifiConnectTimeout: 5000,
      wifiHandshakeTimeout: 3000,
    });
    expect(applied).toHaveBeenCalledTimes(2);
  });
  it("wifi-normalization: remembered address trims; reset forgets it and restart cannot revive it", () => {
    const data = new Map<string, string>([
      ["kobrixa.connectionMode", "wifi"],
      ["kobrixa.rememberWifiAddress", "true"],
      ["kobrixa.lastWifiAddress", "  192.168.0.42  "],
    ]);
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    const store = new SettingsStore(() => storage, "en");
    expect(store.getSnapshot().values.connectionMode).toBe("wifi");
    expect(store.getWifiAddress()).toBe("192.168.0.42");
    store.rememberAddress("  192.168.0.43 ");
    expect(store.getWifiAddress()).toBe("192.168.0.43");
    store.reset("rememberWifiAddress");
    expect(store.getWifiAddress()).toBe("");
    expect(data.get("kobrixa.lastWifiAddress")).toBe("");
    store.rememberAddress("192.168.0.44");
    expect(store.getWifiAddress()).toBe("");
    const restarted = new SettingsStore(() => storage, "en");
    expect(restarted.getWifiAddress()).toBe("");
    expect(restarted.getSnapshot().values).toMatchObject({
      connectionMode: "wifi",
      rememberWifiAddress: false,
    });
  });
});

// This checks inventory integrity only. Behavioral proof comes from executing
// the referenced assertions, never from this metadata check.
it("W06 inventories all twelve historical gaps without claiming native acceptance", () => {
  expect(parityRows.map((row) => row.id)).toEqual(
    Array.from({ length: 12 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`),
  );
  for (const row of parityRows) {
    expect(row.unrun).toHaveLength(1);
    expect(row.replacement.expected.length).toBeGreaterThan(0);
    expect(row.remaining.length).toBeGreaterThan(0);
    expect(row.acceptance).toBe("pending-native-and-integration");
    expect(readFileSync(new URL(row.replacement.file, import.meta.url), "utf8")).toContain(
      row.replacement.assertion,
    );
  }
});
