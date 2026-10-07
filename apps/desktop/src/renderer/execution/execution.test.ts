import { describe, expect, it, vi } from "vitest";
import type { BuildEvent, CompileResult, DeviceEvent, KobrixaApi } from "../../shared/api.js";
import type { MotorTestState } from "../../shared/motor-test.js";
import { DEVICE_CONTROL_DENIED, ExecutionController, filesToSave } from "./execution.js";
import { readTheme } from "../settings/theme.js";

const success: CompileResult = {
  success: true,
  diagnostics: [],
  runtimeDirectory: "/robot",
  artifacts: [{ kind: "rbf", path: "/tmp/build/demo.rbf", sha256: "abc" }],
};
const failure: CompileResult = {
  success: false,
  diagnostics: [
    {
      code: "BP001",
      severity: "error",
      file: "main.bp",
      message: "Invalid source",
      range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
    },
  ],
  artifacts: [],
};
const usb = { id: "usb", name: "EV3", transport: "usb" as const };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  let buildListener: (event: BuildEvent) => void = () => {};
  let deviceListener: (event: DeviceEvent) => void = () => {};
  let sequence = 0;
  const calls: string[] = [];
  const api = {
    simulator: {
      cancel: vi.fn(async () => undefined),
      prepare: vi.fn(async () => ({
        success: true as const,
        diagnostics: [],
        prepared: { programs: {} },
      })),
    },
    updates: {} as KobrixaApi["updates"],
    sensorLab: {} as KobrixaApi["sensorLab"],
    keyboard: { updateContext: vi.fn(async () => undefined) },
    build: {
      onEvent: vi.fn((listener) => {
        buildListener = listener;
        return () => {};
      }),
      start: vi.fn(async (workspaceId: string) => {
        calls.push("build");
        const buildId = `b${++sequence}`;
        // Deliberately deliver complete before the IPC promise resolves.
        buildListener({ type: "complete", workspaceId, buildId, result: success });
        return buildId;
      }),
      cancel: vi.fn(async () => {}),
      artifacts: vi.fn(),
      preview: vi.fn(),
    },
    device: {
      startMotorTest: vi.fn(),
      keepMotorTestAlive: vi.fn(),
      stopMotorTest: vi.fn(),
      motorTestState: vi.fn(),
      onMotorTest: () => () => {},
      watchMonitor: vi.fn(),
      onMonitor: () => () => {},
      monitor: vi.fn(),
      inputModes: vi.fn(),
      setInputMode: vi.fn(),
      getPreferences: vi.fn(),
      setPreferences: vi.fn(),
      files: vi.fn(),
      prepareFiles: vi.fn(),
      executeFiles: vi.fn(),
      stopFiles: vi.fn(),
      onEvent: vi.fn((listener) => {
        deviceListener = listener;
        return () => {};
      }),
      connect: vi.fn(async () => "s1"),
      connectWifi: vi.fn(async () => "s2"),
      disconnect: vi.fn(async () => {}),
      discover: vi.fn(),
      upload: vi.fn(),
      deploy: vi.fn(async () => {
        calls.push("deploy");
      }),
      run: vi.fn(async () => {
        calls.push("run");
      }),
      stop: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    },
    workspace: {} as KobrixaApi["workspace"],
    collab: {} as KobrixaApi["collab"],
    language: {} as KobrixaApi["language"],
    documentation: { open: vi.fn(async () => undefined) },
  } satisfies KobrixaApi;
  const controller = new ExecutionController(api);
  controller.attach();
  controller.setWorkspace("w1");
  const saveAll = vi.fn(async () => {
    calls.push("save");
  });
  const request = { workspaceId: "w1", saveAll };
  return {
    api,
    controller,
    request,
    calls,
    emitBuild: (event: BuildEvent) => buildListener(event),
    emitDevice: (event: DeviceEvent) => deviceListener(event),
  };
}

describe("execution flow", () => {
  it("saves and compiles an offline preview without discovering or touching a device", async () => {
    const h = setup();
    const ir = { version: 1, program: { name: "preview" } };
    h.api.build.preview.mockResolvedValue(ir);
    expect(await h.controller.preview(h.request)).toEqual(ir);
    expect(h.calls).toEqual(["save", "build"]);
    expect(h.api.build.start).toHaveBeenCalledWith("w1", {}, true);
    expect(h.api.build.preview).toHaveBeenCalledWith("b1");
    expect(h.api.device.discover).not.toHaveBeenCalled();
    expect(h.api.device.connect).not.toHaveBeenCalled();
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
  });
  it("never substitutes a previous preview after a compile failure", async () => {
    const h = setup();
    await h.controller.build(h.request);
    h.api.build.start.mockImplementationOnce(async (workspaceId) => {
      h.emitBuild({ type: "complete", workspaceId, buildId: "bad", result: failure });
      return "bad";
    });
    expect(await h.controller.preview(h.request)).toBeUndefined();
    expect(h.api.build.preview).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().diagnostics).toEqual(failure.diagnostics);
  });
  it("reports a missing preview snapshot and releases the operation lock", async () => {
    const h = setup();
    h.api.build.preview.mockRejectedValueOnce(new Error("Preview snapshot missing"));
    expect(await h.controller.preview(h.request)).toBeUndefined();
    expect(h.controller.getSnapshot().error?.detail).toBe("Preview snapshot missing");
    expect(h.controller.locked).toBe(false);
  });
  it("records motor transitions once and keeps their starting project association", () => {
    const { controller } = setup();
    const state: MotorTestState = {
      request: {
        sessionId: "ev3",
        testId: "motor-1",
        port: 2,
        power: 20,
        direction: -1,
        mode: "angle",
        degrees: 90,
        brake: true,
      },
      phase: "preparing",
      angle: null,
      displacement: null,
      elapsedMs: 0,
    };
    controller.recordMotorTest(state);
    controller.recordMotorTest({ ...state, phase: "running" });
    controller.recordMotorTest({ ...state, phase: "running", angle: 10 });
    controller.setWorkspace("w2");
    controller.recordMotorTest({ ...state, phase: "completed" });
    expect(controller.getSnapshot().logs).toHaveLength(0);
    controller.setWorkspace("w1");
    expect(controller.getSnapshot().logs.map((entry) => entry.message)).toEqual([
      "motorPreparing",
      "motorStarted",
      "motorCompleted",
    ]);
    expect(controller.getSnapshot().logs[0]?.detail).toBe("C · -20% · 90°");
    expect(controller.editingLocked).toBe(false);
  });
  it("keeps a motor test without an open project in device activity", () => {
    const { controller } = setup();
    controller.setWorkspace(undefined);
    controller.recordMotorTest({
      request: {
        sessionId: "ev3",
        testId: "motor-global",
        port: 0,
        power: 20,
        direction: 1,
        mode: "jog",
        brake: true,
      },
      phase: "unconfirmed",
      angle: null,
      displacement: null,
      elapsedMs: 0,
      message: "Disconnected",
    });
    expect(controller.getSnapshot().logs[0]).toMatchObject({
      message: "motorUnconfirmed",
      failed: true,
    });
    controller.setWorkspace("w2");
    expect(controller.getSnapshot().logs).toHaveLength(1);
  });
  it("locks device actions during a mode change without logging each monitor sample", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const before = h.controller.getSnapshot().logs.length;
    const change = deferred<void>();
    const pending = h.controller.withMonitor(() => change.promise);
    expect(h.controller.locked).toBe(true);
    expect(h.controller.editingLocked).toBe(false);
    await h.controller.run(h.request);
    expect(h.api.build.start).not.toHaveBeenCalled();
    await expect(h.controller.withFiles(async () => {}, "upload")).rejects.toThrow("in progress");
    change.resolve();
    await pending;
    expect(h.controller.locked).toBe(false);
    expect(h.controller.getSnapshot().logs).toHaveLength(before);
    await expect(
      h.controller.withMonitor(async () => {
        throw new Error("mode failed");
      }),
    ).rejects.toThrow("mode failed");
    expect(h.controller.locked).toBe(false);
  });
  it("refuses device writes without collaboration device control but still stops", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.build(h.request);
    await h.controller.upload();
    h.controller.setDeviceControlBlocked(true);
    expect(h.controller.deviceControlBlocked).toBe(true);
    h.api.device.deploy.mockClear();
    h.api.device.run.mockClear();
    await h.controller.run(h.request);
    await h.controller.upload();
    await h.controller.runDeployed();
    await h.controller.deleteDeployed();
    await expect(h.controller.withMonitor(async () => {})).rejects.toThrow(DEVICE_CONTROL_DENIED);
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.api.device.delete).not.toHaveBeenCalled();
    await h.controller.stop();
    expect(h.api.device.stop).toHaveBeenCalledWith("s1");
    h.controller.setDeviceControlBlocked(false);
    await h.controller.runDeployed();
    expect(h.api.device.run).toHaveBeenCalled();
  });
  it("drops a waiting run when device control is lost", async () => {
    const h = setup();
    await h.controller.run(h.request);
    expect(h.controller.getSnapshot().phase).toBe("awaitingDevice");
    h.controller.setDeviceControlBlocked(true);
    await h.controller.connect(usb);
    expect(h.calls).toEqual([]);
  });
  it("saves, builds, deploys assets, then runs the actual artifact path", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    expect(h.calls).toEqual(["save", "build", "deploy", "run"]);
    expect(h.api.build.start).toHaveBeenCalledWith("w1", {});
    expect(h.api.device.deploy).toHaveBeenCalledWith("s1", "b1", "/robot");
    expect(h.api.device.run).toHaveBeenCalledWith("s1", "/robot/demo.rbf");
    expect(h.controller.getSnapshot().logs.at(-1)?.message).toBe("runSent");
    expect(h.controller.locked).toBe(false);
  });
  it("waits for connection and resumes only that requested run", async () => {
    const h = setup();
    await h.controller.run(h.request);
    expect(h.controller.getSnapshot().phase).toBe("awaitingDevice");
    expect(h.calls).toEqual([]);
    await h.controller.connect(usb);
    expect(h.calls).toEqual(["save", "build", "deploy", "run"]);
  });
  it("cancels connection intent without starting after a later connection", async () => {
    const h = setup();
    await h.controller.run(h.request);
    h.controller.cancelWaiting();
    await h.controller.connect(usb);
    expect(h.calls).toEqual([]);
  });
  it("does not run automatically after a failed connection is retried", async () => {
    const h = setup();
    await h.controller.run(h.request);
    h.api.device.connect.mockRejectedValueOnce(new Error("Connection refused"));
    await h.controller.connect(usb);
    await h.controller.connect(usb);
    expect(h.calls).toEqual([]);
    expect(h.controller.locked).toBe(false);
  });
  it("stops on save failure and never builds", async () => {
    const h = setup();
    await h.controller.connect(usb);
    h.request.saveAll.mockRejectedValueOnce(new Error("Disk full"));
    await h.controller.run(h.request);
    expect(h.api.build.start).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().error?.phase).toBe("saving");
  });
  it("does not deploy a failed build or substitute the previous successful build", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.build(h.request);
    h.api.build.start.mockImplementationOnce(async (workspaceId) => {
      h.emitBuild({ type: "complete", workspaceId, buildId: "bad", result: failure });
      return "bad";
    });
    await h.controller.run(h.request);
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().successfulBuild?.buildId).toBe("b1");
    expect(h.controller.getSnapshot().diagnostics).toEqual(failure.diagnostics);
  });
  it("does not run after a partial upload failure, but leaves connection ownership to the service", async () => {
    const h = setup();
    await h.controller.connect(usb);
    h.api.device.deploy.mockRejectedValueOnce(new Error("EV3 rejected the upload"));
    await h.controller.run(h.request);
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().session?.id).toBe("s1");
    expect(h.api.device.disconnect).not.toHaveBeenCalled();
  });
  it("serializes double clicks, including the saving stage", async () => {
    const h = setup();
    const saved = deferred<void>();
    await h.controller.connect(usb);
    h.request.saveAll.mockImplementationOnce(() => saved.promise);
    const first = h.controller.run(h.request);
    await h.controller.run(h.request);
    await h.controller.build(h.request);
    expect(h.request.saveAll).toHaveBeenCalledTimes(1);
    saved.resolve();
    await first;
    expect(h.api.build.start).toHaveBeenCalledTimes(1);
  });
  it("cancels a build even when its id is still in flight", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const started = deferred<string>();
    h.api.build.start.mockImplementationOnce(() => started.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("building"));
    await h.controller.cancelBuild();
    started.resolve("cancel-me");
    await vi.waitFor(() => expect(h.api.build.cancel).toHaveBeenCalledWith("cancel-me"));
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "cancel-me", result: success });
    await run;
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().logs.at(-1)?.message).toBe("cancelled");
  });
  it("ignores another workspace or build and accepts only the active build", async () => {
    const h = setup();
    h.api.build.start.mockResolvedValueOnce("current");
    const build = h.controller.build(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().activeBuildId).toBe("current"));
    h.emitBuild({ type: "complete", workspaceId: "other", buildId: "current", result: success });
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "old", result: success });
    expect(h.controller.getSnapshot().successfulBuild).toBeUndefined();
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "current", result: success });
    await build;
    expect(h.controller.getSnapshot().successfulBuild?.buildId).toBe("current");
  });
  it("keeps a background build running and restores its result when returning", async () => {
    const h = setup();
    h.api.build.start.mockResolvedValueOnce("old");
    const build = h.controller.build(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().activeBuildId).toBe("old"));
    h.controller.setWorkspace("w2");
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "old", result: success });
    await build;
    expect(h.controller.getSnapshot().successfulBuild).toBeUndefined();
    expect(h.controller.getSnapshot().diagnostics).toEqual([]);
    h.controller.setWorkspace("w1");
    expect(h.controller.getSnapshot().successfulBuild?.buildId).toBe("old");
    expect(h.api.build.cancel).not.toHaveBeenCalled();
  });
  it("finishes upload and run for A while B is selected, and never exposes A's deployed command to B", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const upload = deferred<void>();
    h.api.device.deploy.mockImplementationOnce(() => upload.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("uploading"));
    h.controller.setWorkspace("w2");
    expect(h.controller.editingLockedFor("w1")).toBe(true);
    expect(h.controller.editingLockedFor("w2")).toBe(false);
    expect(() => h.controller.forgetWorkspace("w1")).toThrow("in progress");
    upload.resolve();
    await run;
    expect(h.api.device.run).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    await h.controller.runDeployed();
    await h.controller.deleteDeployed();
    await h.controller.upload();
    expect(h.api.device.run).toHaveBeenCalledOnce();
    expect(h.api.device.delete).not.toHaveBeenCalled();
    h.controller.setWorkspace("w1");
    expect(h.controller.getSnapshot().deployed?.workspaceId).toBe("w1");
  });
  it("cancels a background build and retains diagnostics on its owning project", async () => {
    const h = setup();
    h.api.build.start.mockResolvedValueOnce("background");
    const build = h.controller.build(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().activeBuildId).toBe("background"));
    h.controller.setWorkspace("w2");
    await h.controller.cancelBuild();
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "background", result: failure });
    await build;
    expect(h.api.build.cancel).toHaveBeenCalledWith("background");
    expect(h.controller.getSnapshot().diagnostics).toEqual([]);
    h.controller.setWorkspace("w1");
    expect(h.controller.getSnapshot().diagnostics).toEqual(failure.diagnostics);
    expect(h.controller.getSnapshot().successfulBuild).toBeUndefined();
  });
  it("ignores an old session disconnect but clears a current disconnected session", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "old" });
    expect(h.controller.getSnapshot().deployed).toBeDefined();
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "s1" });
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
  it("stops the chain when disconnect arrives during upload", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const uploaded = deferred<void>();
    h.api.device.deploy.mockImplementationOnce(() => uploaded.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("uploading"));
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "s1" });
    uploaded.resolve();
    await run;
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
  it("cancels the queued run while a connection is already in flight", async () => {
    const h = setup();
    const connected = deferred<string>();
    await h.controller.run(h.request);
    h.api.device.connect.mockImplementationOnce(() => connected.promise);
    const connection = h.controller.connect(usb);
    h.controller.cancelWaiting();
    connected.resolve("s1");
    await connection;
    expect(h.calls).toEqual([]);
    expect(h.controller.getSnapshot().session?.id).toBe("s1");
    expect(h.controller.locked).toBe(false);
  });
  it("routes an early completion to the background owner even before start resolves", async () => {
    const h = setup();
    const started = deferred<string>();
    h.api.build.start.mockImplementationOnce(() => started.promise);
    const build = h.controller.build(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("building"));
    h.controller.setWorkspace("w2");
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "late", result: failure });
    started.resolve("late");
    await build;
    expect(h.api.build.cancel).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().diagnostics).toEqual([]);
    expect(h.controller.getSnapshot().successfulBuild).toBeUndefined();
    expect(h.controller.getSnapshot().activeBuildId).toBeUndefined();
    h.controller.setWorkspace("w1");
    expect(h.controller.getSnapshot().diagnostics).toEqual(failure.diagnostics);
  });
  it("never reports run success from a command completed after disconnection", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const ran = deferred<void>();
    h.api.device.run.mockImplementationOnce(() => ran.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("running"));
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "s1" });
    ran.resolve();
    await run;
    expect(h.controller.getSnapshot().logs.some((entry) => entry.message === "runSent")).toBe(
      false,
    );
    expect(h.controller.getSnapshot().phase).toBe("error");
  });
  it("clears uploaded version when disconnecting and reconnecting", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    await h.controller.disconnect();
    await h.controller.connect("192.168.0.2");
    await h.controller.runDeployed();
    expect(h.api.device.run).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
  it("deletes only the program actually uploaded to this session", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    await h.controller.deleteDeployed();
    expect(h.api.device.delete).toHaveBeenCalledWith("s1", "/robot/demo.rbf");
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
});

describe("USB recovery state", () => {
  const waiting = {
    type: "usb-recovery",
    state: "waiting",
    previousSessionId: "s1",
    descriptor: usb,
  } as const;
  const recovered = {
    type: "usb-recovery",
    state: "restored",
    previousSessionId: "s1",
    sessionId: "s3",
    descriptor: usb,
    deployment: "verified",
    buildId: "b1",
  } as const;

  it("clears exhausted recovery and requires manual reconnect without starting the robot", async () => {
    const h = setup();
    await h.controller.connect(usb);
    h.emitDevice(waiting);
    h.emitDevice({ ...waiting, state: "exhausted" });
    expect(h.controller.getSnapshot()).toMatchObject({
      recovery: undefined,
      session: undefined,
      connectionNotice: "retry-exhausted",
    });
    expect(h.controller.locked).toBe(false);
    expect(h.api.device.run).not.toHaveBeenCalled();
    h.emitDevice(recovered);
    expect(h.controller.getSnapshot().session).toBeUndefined();
  });

  it("restores a verified uploaded version without automatically running or blocking local builds", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    h.emitDevice(waiting);
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().recovery?.state).toBe("waiting");
    expect(h.controller.getSnapshot().phase).toBe("idle");
    expect(h.controller.locked).toBe(false);
    await h.controller.run(h.request);
    await h.controller.runDeployed();
    await h.controller.stop();
    await h.controller.upload();
    expect(h.api.device.run).toHaveBeenCalledTimes(1);
    await h.controller.build(h.request);
    expect(h.controller.getSnapshot().successfulBuild?.buildId).toBe("b2");
    h.emitDevice({ ...waiting, state: "connecting" });
    h.emitDevice(recovered);
    expect(h.controller.getSnapshot().deployed).toMatchObject({ buildId: "b1", sessionId: "s3" });
    expect(h.api.device.run).toHaveBeenCalledTimes(1);
    await h.controller.runDeployed();
    expect(h.api.device.run).toHaveBeenLastCalledWith("s3", "/robot/demo.rbf");
  });

  it("keeps a pure local build running across unplug and reconnect", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const saved = deferred<void>();
    h.request.saveAll.mockReturnValueOnce(saved.promise);
    const build = h.controller.build(h.request);
    h.emitDevice(waiting);
    h.emitDevice({ ...recovered, deployment: "none" });
    saved.resolve();
    await build;
    expect(h.controller.getSnapshot().successfulBuild?.buildId).toBe("b1");
    expect(h.api.build.cancel).not.toHaveBeenCalled();
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().session?.id).toBe("s3");
  });

  it("does not resume a Run chain interrupted while building or deploying", async () => {
    const h = setup();
    await h.controller.connect(usb);
    const upload = deferred<void>();
    h.api.device.deploy.mockReturnValueOnce(upload.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("uploading"));
    h.emitDevice(waiting);
    h.emitDevice(recovered);
    upload.resolve();
    await run;
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.api.device.disconnect).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().session?.id).toBe("s3");
    expect(h.controller.locked).toBe(false);
  });

  it("cancels a Run build without cancelling a replacement session", async () => {
    const h = setup();
    await h.controller.connect(usb);
    h.api.build.start.mockResolvedValueOnce("pending");
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().activeBuildId).toBe("pending"));
    h.emitDevice(waiting);
    h.emitDevice(recovered);
    await run;
    expect(h.api.build.cancel).toHaveBeenCalledWith("pending");
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().session?.id).toBe("s3");
  });

  it("ignores a restored event arriving after cancellation and stale old-session events", async () => {
    const h = setup();
    await h.controller.connect(usb);
    h.emitDevice(waiting);
    const cancelled = deferred<void>();
    h.api.device.disconnect.mockReturnValueOnce(cancelled.promise);
    const cancellation = h.controller.disconnect();
    h.emitDevice(recovered);
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().recovery).toBeUndefined();
    cancelled.resolve();
    await cancellation;
    await h.controller.connect("192.168.0.2");
    h.emitDevice(waiting);
    h.emitDevice(recovered);
    expect(h.controller.getSnapshot().session?.id).toBe("s2");
  });

  it("does not restore changed files or a closed project's uploaded version", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    h.emitDevice(waiting);
    h.emitDevice({ ...recovered, deployment: "changed" });
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().connectionNotice).toBe("upload-required");
    await h.controller.runDeployed();
    expect(h.api.device.run).toHaveBeenCalledOnce();
    h.emitDevice({ ...waiting, previousSessionId: "s3" });
    h.controller.forgetWorkspace("w1");
    h.emitDevice({ ...recovered, previousSessionId: "s3", sessionId: "s4" });
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
});

describe("saved preferences and source snapshot", () => {
  it("defaults to dark and preserves an explicit light preference", () => {
    expect(readTheme({ getItem: () => null })).toBe("dark");
    expect(readTheme({ getItem: () => "invalid" })).toBe("dark");
    expect(readTheme({ getItem: () => "light" })).toBe("light");
  });
  it("includes closed recovered drafts and JSON, with current open buffers winning", () => {
    expect(
      filesToSave({ "closed.bpi": "recovered", "main.bp": "old", "kobrixa.json": "manifest" }, [
        { file: "main.bp", content: "new", saved: "old" },
        { file: "clean.bp", content: "same", saved: "same" },
      ]),
    ).toEqual([
      ["closed.bpi", "recovered"],
      ["main.bp", "new"],
      ["kobrixa.json", "manifest"],
    ]);
  });
});

describe("file operation isolation", () => {
  it("blocks deployment and robot commands during file operations while preserving editing", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    h.calls.length = 0;
    const gate = deferred<void>();
    const work = h.controller.withFiles(() => gate.promise, "upload");
    expect(h.controller.locked).toBe(true);
    expect(h.controller.editingLocked).toBe(false);
    await h.controller.run(h.request);
    await h.controller.upload();
    await h.controller.runDeployed();
    await h.controller.stop();
    expect(h.calls).toEqual([]);
    expect(h.api.device.stop).not.toHaveBeenCalled();
    gate.resolve();
    await work;
    expect(h.controller.locked).toBe(false);
  });
  it("invalidates deployed versions only for matching sessions and related paths", async () => {
    const h = setup();
    await h.controller.connect(usb);
    await h.controller.run(h.request);
    const deployed = h.controller.getSnapshot().deployed!;
    h.emitDevice({
      type: "files-changed",
      sessionId: "old",
      requestId: "r",
      paths: [deployed.path],
    });
    expect(h.controller.getSnapshot().deployed).toBeDefined();
    h.emitDevice({ type: "files-changed", sessionId: "s1", requestId: "r", paths: ["/unrelated"] });
    expect(h.controller.getSnapshot().deployed).toBeDefined();
    h.emitDevice({
      type: "files-changed",
      sessionId: "s1",
      requestId: "r",
      paths: [deployed.path],
    });
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().successfulBuild).toBeDefined();
  });
});
