import { describe, expect, it, vi } from "vitest";
import type { BuildEvent, CompileResult, DeviceEvent, KobrixaApi } from "../../shared/api.js";
import { ExecutionController, filesToSave } from "./execution.js";
import { readTheme } from "../settings/theme.js";

const success: CompileResult = {
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
      path: "/tmp/build/demo.rbf",
      sha256: "abc",
      byteLength: 1,
    },
  ],
};
const failure: CompileResult = {
  buildId: "failed",
  target: "ev3-native",
  success: false,
  diagnostics: [
    {
      code: "BP001",
      source: "kobrixa.basic-plus",
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
  let catalogRevision = 0;
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
    plugins: {} as KobrixaApi["plugins"],
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
      watchMonitor: vi.fn(),
      onMonitor: () => () => {},
      files: vi.fn(),
      prepareFiles: vi.fn(),
      renewFiles: vi.fn(),
      executeFiles: vi.fn(),
      stopFiles: vi.fn(),
      onEvent: vi.fn((listener) => {
        deviceListener = listener;
        return () => {};
      }),
      disconnect: vi.fn(async () => {}),
      upload: vi.fn(),
      deploy: vi.fn(async () => {
        calls.push("deploy");
      }),
      run: vi.fn(async () => {
        calls.push("run");
      }),
      stop: vi.fn(async () => {
        calls.push("stop");
      }),
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
    async adoptSession(id = "s1") {
      deviceListener(publicCatalog(++catalogRevision, "connected", id));
      await vi.waitFor(() => expect(controller.locked).toBe(false));
    },
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
    expect(h.api.device).not.toHaveProperty("discover");
    expect(h.api.device).not.toHaveProperty("connect");
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
  it("locks device actions during a retained file operation and releases the lock after failure", async () => {
    const h = setup();
    await h.adoptSession();
    const before = h.controller.getSnapshot().logs.length;
    const change = deferred<void>();
    const pending = h.controller.withFiles(() => change.promise, "upload");
    expect(h.controller.locked).toBe(true);
    expect(h.controller.editingLocked).toBe(false);
    await h.controller.run(h.request);
    expect(h.api.build.start).not.toHaveBeenCalled();
    await expect(h.controller.withFiles(async () => {}, "list")).rejects.toThrow("in progress");
    expect(h.controller.getSnapshot().logs).toHaveLength(before);
    change.resolve();
    await pending;
    expect(h.controller.locked).toBe(false);
    expect(h.controller.getSnapshot().logs).toHaveLength(before + 1);
    expect(h.controller.getSnapshot().logs.at(-1)).toMatchObject({
      message: "files",
      detail: "upload",
    });
    await expect(
      h.controller.withFiles(async () => {
        throw new Error("file failed");
      }, "upload"),
    ).rejects.toThrow("file failed");
    expect(h.controller.locked).toBe(false);
    expect(h.controller.getSnapshot().logs.at(-1)).toMatchObject({
      message: "files",
      detail: "upload: file failed",
      failed: true,
    });
  });
  it("refuses device writes without collaboration device control but still stops", async () => {
    const h = setup();
    await h.adoptSession();
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
    expect(h.controller).not.toHaveProperty("withMonitor");
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
    await h.adoptSession();
    expect(h.calls).toEqual([]);
  });
  it("saves, builds, deploys assets, then runs the actual artifact path", async () => {
    const h = setup();
    await h.adoptSession();
    await h.controller.run(h.request);
    expect(h.calls).toEqual(["save", "build", "stop", "deploy", "run"]);
    expect(h.api.build.start).toHaveBeenCalledWith("w1", {});
    expect(h.api.device.deploy).toHaveBeenCalledWith("s1", "b1", "/robot");
    expect(h.api.device.run).toHaveBeenCalledWith("s1", "/robot/demo.rbf");
    expect(h.controller.getSnapshot().logs.at(-1)?.message).toBe("runStarted");
    expect(h.controller.locked).toBe(false);
  });
  it("waits for a confirmed stop before uploading and ignores another F5", async () => {
    const h = setup(),
      stopped = deferred<void>();
    await h.adoptSession();
    h.api.device.stop.mockImplementationOnce(() => stopped.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("stopping"));
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
    await h.controller.run(h.request);
    expect(h.api.build.start).toHaveBeenCalledOnce();
    stopped.resolve();
    await run;
    expect(h.api.device.stop).toHaveBeenCalledOnce();
    expect(h.api.device.deploy).toHaveBeenCalledOnce();
    expect(h.api.device.run).toHaveBeenCalledOnce();
  });
  it("keeps stop failures separate from upload failures", async () => {
    const h = setup();
    await h.adoptSession();
    h.api.device.stop.mockRejectedValueOnce(new Error("Stop was not confirmed"));
    await h.controller.run(h.request);
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().error).toEqual({
      phase: "stopping",
      detail: "Stop was not confirmed",
    });
    expect(h.controller.locked).toBe(false);
  });
  it("does not claim startup success when an uploaded program cannot start", async () => {
    const h = setup();
    await h.adoptSession();
    h.api.device.run.mockRejectedValueOnce(new Error("EV3 could not load the uploaded program."));
    await h.controller.run(h.request);
    const state = h.controller.getSnapshot();
    expect(state.error?.phase).toBe("running");
    expect(state.logs.some((entry) => entry.message === "uploaded")).toBe(true);
    expect(state.logs.some((entry) => entry.message === "runStarted")).toBe(false);
    expect(state.deployed?.buildId).toBe("b1");
    expect(h.api.device.run).toHaveBeenCalledOnce();
    await h.controller.runDeployed();
    expect(h.api.device.run).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot().logs.at(-1)?.message).toBe("runStarted");
  });
  it("upload-only does not stop or start a user program", async () => {
    const h = setup();
    await h.adoptSession();
    await h.controller.build(h.request);
    await h.controller.upload();
    expect(h.api.device.stop).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.api.device.deploy).toHaveBeenCalledOnce();
  });
  it("does not upload or restart after disconnecting during the stop", async () => {
    const h = setup(),
      stopped = deferred<void>();
    await h.adoptSession();
    h.api.device.stop.mockImplementationOnce(() => stopped.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("stopping"));
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "s1" });
    stopped.resolve();
    await run;
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.locked).toBe(false);
  });
  it("does not automatically stop after losing collaboration control during build", async () => {
    const h = setup();
    await h.adoptSession();
    h.api.build.start.mockImplementationOnce(async (workspaceId) => {
      h.controller.setDeviceControlBlocked(true);
      h.emitBuild({ type: "complete", workspaceId, buildId: "b1", result: success });
      return "b1";
    });
    await h.controller.run(h.request);
    expect(h.api.device.stop).not.toHaveBeenCalled();
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
  });
  it("waits for connection and resumes only that requested run", async () => {
    const h = setup();
    await h.controller.run(h.request);
    expect(h.controller.getSnapshot().phase).toBe("awaitingDevice");
    expect(h.calls).toEqual([]);
    await h.adoptSession();
    expect(h.calls).toEqual(["save", "build", "stop", "deploy", "run"]);
  });
  it("cancels connection intent without starting after a later connection", async () => {
    const h = setup();
    await h.controller.run(h.request);
    h.controller.cancelWaiting();
    await h.adoptSession();
    expect(h.calls).toEqual([]);
  });
  it("does not run automatically after a failed connection is retried", async () => {
    const h = setup();
    await h.controller.run(h.request);
    h.emitDevice(publicCatalog(1, "changed", null));
    h.emitDevice(publicCatalog(2));
    await Promise.resolve();
    expect(h.calls).toEqual([]);
    expect(h.controller.locked).toBe(false);
  });
  it("stops on save failure and never builds", async () => {
    const h = setup();
    await h.adoptSession();
    h.request.saveAll.mockRejectedValueOnce(new Error("Disk full"));
    await h.controller.run(h.request);
    expect(h.api.build.start).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().error?.phase).toBe("saving");
  });
  it("does not deploy a failed build or substitute the previous successful build", async () => {
    const h = setup();
    await h.adoptSession();
    await h.controller.build(h.request);
    h.api.build.start.mockImplementationOnce(async (workspaceId) => {
      h.emitBuild({ type: "complete", workspaceId, buildId: "bad", result: failure });
      return "bad";
    });
    await h.controller.run(h.request);
    expect(h.api.device.stop).not.toHaveBeenCalled();
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().successfulBuild?.buildId).toBe("b1");
    expect(h.controller.getSnapshot().diagnostics).toEqual(failure.diagnostics);
  });
  it("does not run after a partial upload failure, but leaves connection ownership to the service", async () => {
    const h = setup();
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
    await h.controller.run(h.request);
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "old" });
    expect(h.controller.getSnapshot().deployed).toBeDefined();
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "s1" });
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
  it("stops the chain when disconnect arrives during upload", async () => {
    const h = setup();
    await h.adoptSession();
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
    await h.controller.run(h.request);
    h.controller.cancelWaiting();
    await h.adoptSession();
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
    await h.adoptSession();
    const ran = deferred<void>();
    h.api.device.run.mockImplementationOnce(() => ran.promise);
    const run = h.controller.run(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("running"));
    h.emitDevice({ type: "state", state: "disconnected", sessionId: "s1" });
    ran.resolve();
    await run;
    expect(h.controller.getSnapshot().logs.some((entry) => entry.message === "runStarted")).toBe(
      false,
    );
    expect(h.controller.getSnapshot().phase).toBe("error");
  });
  it("clears uploaded version when disconnecting and reconnecting", async () => {
    const h = setup();
    await h.adoptSession();
    await h.controller.run(h.request);
    await h.controller.disconnect();
    await h.adoptSession("s2");
    await h.controller.runDeployed();
    expect(h.api.device.run).toHaveBeenCalledTimes(1);
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
  });
  it("deletes only the program actually uploaded to this session", async () => {
    const h = setup();
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
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
    await h.adoptSession();
    h.emitDevice(waiting);
    const cancelled = deferred<void>();
    h.api.device.disconnect.mockReturnValueOnce(cancelled.promise);
    const cancellation = h.controller.disconnect();
    h.emitDevice(recovered);
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().recovery).toBeUndefined();
    cancelled.resolve();
    await cancellation;
    await h.adoptSession("s2");
    h.emitDevice(waiting);
    h.emitDevice(recovered);
    expect(h.controller.getSnapshot().session?.id).toBe("s2");
  });

  it("retains recovery for retry when cancellation cleanup fails", async () => {
    const h = setup();
    await h.adoptSession();
    h.emitDevice(waiting);
    const recovery = h.controller.getSnapshot().recovery;
    h.api.device.disconnect.mockRejectedValueOnce(new Error("Stop is unconfirmed"));
    await h.controller.disconnect();
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().recovery).toEqual(recovery);
    expect(h.controller.getSnapshot().error?.detail).toContain("unconfirmed");
  });

  it("rejects public session adoption after failed recovery cancellation until explicit retry", async () => {
    const h = setup();
    await h.adoptSession();
    h.emitDevice(waiting);
    const recovery = h.controller.getSnapshot().recovery;
    h.api.device.disconnect.mockRejectedValueOnce(new Error("Stop is unconfirmed"));
    await h.controller.disconnect();
    h.emitDevice(publicCatalog(2, "connected", "s2"));
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.controller.getSnapshot().recovery).toEqual(recovery);
    expect(h.controller.getSnapshot().error?.detail).toContain("unconfirmed");
    await h.controller.disconnect();
    expect(h.api.device.disconnect).toHaveBeenCalledTimes(2);
    h.emitDevice(publicCatalog(3, "connected", "s2"));
    expect(h.controller.getSnapshot().recovery).toBeUndefined();
    expect(h.controller.getSnapshot().session?.id).toBe("s2");
    expect(h.controller.getSnapshot().error).toBeUndefined();
    expect(h.api.device.run).not.toHaveBeenCalled();
  });

  it("does not adopt another connection while trusted Disconnect cancels recovery", async () => {
    const h = setup();
    await h.adoptSession();
    h.emitDevice(waiting);
    const cancelled = deferred<void>();
    h.api.device.disconnect.mockReturnValueOnce(cancelled.promise);
    const pending = h.controller.disconnect();
    try {
      expect(h.controller.locked).toBe(true);
      h.emitDevice(publicCatalog(2, "connected", "s2"));
      h.emitDevice(publicCatalog(3, "connected", "s3"));
      h.emitDevice(recovered);
      expect(h.controller.getSnapshot().session).toBeUndefined();
      expect(h.controller.getSnapshot().recovery).toBeUndefined();
      expect(h.api.device.disconnect).toHaveBeenCalledOnce();
    } finally {
      cancelled.resolve();
      await pending;
    }
    expect(h.controller.locked).toBe(false);
    expect(h.controller.getSnapshot().session).toBeUndefined();
    expect(h.api.device.run).not.toHaveBeenCalled();
  });

  it("does not restore changed files or a closed project's uploaded version", async () => {
    const h = setup();
    await h.adoptSession();
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
    await h.adoptSession();
    await h.controller.run(h.request);
    h.calls.length = 0;
    h.api.device.stop.mockClear();
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
    await h.adoptSession();
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

it("keeps a successful non-deployable build without a build error", async () => {
  const h = setup();
  const local: CompileResult = {
    buildId: "local",
    target: "analysis",
    success: true,
    diagnostics: [],
    artifacts: [],
  };
  h.api.build.start.mockImplementation(async () => {
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "local", result: local });
    return "local";
  });
  await h.controller.build(h.request);
  expect(h.controller.getSnapshot()).toMatchObject({
    phase: "idle",
    successfulBuild: { buildId: "local", undeployableReason: "BUILD1005" },
  });
  expect(h.controller.getSnapshot().error).toBeUndefined();
  expect(h.controller.getSnapshot().logs.at(-1)).toMatchObject({ message: "built", failed: false });
  await h.adoptSession();
  await h.controller.upload();
  await h.controller.run(h.request);
  expect(h.api.device.stop).not.toHaveBeenCalled();
  expect(h.api.device.deploy).not.toHaveBeenCalled();
  expect(h.api.device.run).not.toHaveBeenCalled();
  expect(h.controller.getSnapshot().error).toBeUndefined();
  expect(h.controller.getSnapshot().logs.at(-1)).toMatchObject({
    detail: "BUILD1005: This target cannot deploy to EV3.",
    failed: false,
  });
});

it("F17 core Disconnect keeps the session until stop/save/disconnect acknowledges", async () => {
  const { controller, api, adoptSession } = setup();
  await adoptSession();
  let reject!: (error: Error) => void;
  api.device.disconnect.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const disconnect = controller.disconnect();
  expect(controller.getSnapshot().session?.id).toBe("s1");
  expect(controller.locked).toBe(true);
  expect(controller.getSnapshot().phase).toBe("disconnecting");
  reject(new Error("Stop is unconfirmed; journal blocker retained"));
  await disconnect;
  expect(controller.getSnapshot().session?.id).toBe("s1");
  expect(controller.getSnapshot().error?.detail).toContain("unconfirmed");
  expect(controller.locked).toBe(false);
});

function publicCatalog(
  revision: number,
  cause: Extract<DeviceEvent, { type: "session-catalog" }>["cause"] = "connected",
  id: string | null = "public-session",
): Extract<DeviceEvent, { type: "session-catalog" }> {
  return {
    type: "session-catalog",
    hostEpoch: "host",
    revision,
    cause,
    origin: "plugin",
    session: id
      ? {
          sessionId: id,
          providerId: "kobrixa.device-ev3",
          providerGeneration: 1,
          revision: 1,
          name: "Public EV3",
          transport: "wifi",
          capabilities: ["connection.v1"],
          state: "connected",
          foreground: "none",
          recording: false,
          sourceRevision: 1,
        }
      : null,
  };
}
it("E5 resumes exactly one current explicit pending Run from a public connection", async () => {
  const h = setup();
  await h.controller.run(h.request);
  h.emitDevice(publicCatalog(1));
  await vi.waitFor(() => expect(h.calls).toEqual(["save", "build", "stop", "deploy", "run"]));
  h.emitDevice(publicCatalog(2));
  await Promise.resolve();
  expect(h.calls).toEqual(["save", "build", "stop", "deploy", "run"]);
  expect(h.controller.getSnapshot().session?.id).toBe("public-session");
});
it.each(["cancel", "authority", "workspace", "detach"])(
  "E5 %s before the queued adoption continuation prevents automatic Run",
  async (reason) => {
    const h = setup();
    await h.controller.run(h.request);
    h.emitDevice(publicCatalog(1));
    if (reason === "cancel") h.controller.cancelWaiting();
    if (reason === "authority") {
      h.controller.setDeviceControlBlocked(true);
      h.controller.setDeviceControlBlocked(false);
    }
    if (reason === "workspace") {
      h.controller.setWorkspace("other");
      h.controller.setWorkspace("w1");
    }
    if (reason === "detach") {
      const detach = h.controller.attach();
      detach();
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls).toEqual([]);
  },
);
it.each(["authority", "workspace", "cancel"])(
  "E5 %s during resumed save cannot later deploy or run after returning",
  async (reason) => {
    const h = setup();
    const saved = deferred<void>();
    h.request.saveAll.mockImplementation(() => saved.promise);
    await h.controller.run(h.request);
    h.emitDevice(publicCatalog(1));
    await Promise.resolve();
    if (reason === "authority") {
      h.controller.setDeviceControlBlocked(true);
      h.controller.setDeviceControlBlocked(false);
    }
    if (reason === "workspace") {
      h.controller.setWorkspace("other");
      h.controller.setWorkspace("w1");
    }
    if (reason === "cancel") h.controller.cancelWaiting();
    saved.resolve();
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("idle"));
    expect(h.calls).toEqual([]);
  },
);
it("E5 bootstrap snapshots and recovered sessions adopt for display without replaying pending work", async () => {
  for (const cause of ["snapshot", "recovered"] as const) {
    const h = setup();
    await h.controller.run(h.request);
    h.emitDevice(publicCatalog(1, cause));
    await Promise.resolve();
    expect(h.calls).toEqual([]);
    expect(h.controller.getSnapshot().session?.id).toBe("public-session");
    expect(h.controller.locked).toBe(false);
  }
});
it.each(["authority", "workspace", "cancel", "detach"])(
  "E5 %s during confirmed stop prevents the resumed Run from deploying",
  async (reason) => {
    const h = setup(),
      stopped = deferred<void>();
    h.api.device.stop.mockImplementationOnce(() => stopped.promise);
    await h.controller.run(h.request);
    h.emitDevice(publicCatalog(1));
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("stopping"));
    expect(h.api.device.stop).toHaveBeenCalledWith("public-session");
    if (reason === "authority") {
      h.controller.setDeviceControlBlocked(true);
      h.controller.setDeviceControlBlocked(false);
    }
    if (reason === "workspace") {
      h.controller.setWorkspace("other");
      h.controller.setWorkspace("w1");
    }
    if (reason === "cancel") h.controller.cancelWaiting();
    if (reason === "detach") {
      const detach = h.controller.attach();
      detach();
    }
    stopped.resolve();
    await vi.waitFor(() => expect(h.controller.locked).toBe(false));
    expect(h.api.device.deploy).not.toHaveBeenCalled();
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().logs.at(-1)?.message).toBe("cancelled");
  },
);
it("E5 disconnected/newer catalog and foreign epoch fence late adoption", async () => {
  const h = setup();
  await h.controller.run(h.request);
  h.emitDevice(publicCatalog(2, "changed", null));
  h.emitDevice(publicCatalog(1));
  h.emitDevice({ ...publicCatalog(99), hostEpoch: "old-host" });
  await Promise.resolve();
  expect(h.controller.getSnapshot().session).toBeUndefined();
  expect(h.calls).toEqual([]);
});
it("E7 has no private connection entry and duplicate public catalog cannot double-run", async () => {
  const h = setup();
  expect(h.controller).not.toHaveProperty("connect");
  await h.controller.run(h.request);
  h.emitDevice(publicCatalog(1, "connected", "s1"));
  h.emitDevice(publicCatalog(2, "connected", "s1"));
  await vi.waitFor(() => expect(h.calls).toEqual(["save", "build", "stop", "deploy", "run"]));
  expect(h.controller.getSnapshot().session?.id).toBe("s1");
});

it("C retirement sends adopted public-session Stop through the retained core API without a project", async () => {
  const h = setup();
  h.controller.setWorkspace(undefined);
  h.emitDevice(publicCatalog(1));
  await h.controller.stop();
  expect(h.api.device.stop).toHaveBeenCalledTimes(1);
  expect(h.api.device.stop).toHaveBeenCalledWith("public-session");
});
