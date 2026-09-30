import { describe, expect, it, vi } from "vitest";
import type { BuildEvent, CompileResult, DeviceEvent, KobrixaApi } from "../shared/api.js";
import { ExecutionController, filesToSave } from "./execution.js";
import { readTheme } from "./theme.js";

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
    },
    device: {
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
    language: {} as KobrixaApi["language"],
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
  it("does not send run after a partial upload failure and clears deployment", async () => {
    const h = setup();
    await h.controller.connect(usb);
    h.api.device.deploy.mockRejectedValueOnce(new Error("Cable removed"));
    await h.controller.run(h.request);
    expect(h.api.device.run).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().deployed).toBeUndefined();
    expect(h.controller.getSnapshot().session).toBeUndefined();
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
  it("clears project versions and ignores late completion after switching workspace", async () => {
    const h = setup();
    h.api.build.start.mockResolvedValueOnce("old");
    const build = h.controller.build(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().activeBuildId).toBe("old"));
    h.controller.setWorkspace("w2");
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "old", result: success });
    await build;
    expect(h.controller.getSnapshot().successfulBuild).toBeUndefined();
    expect(h.controller.getSnapshot().diagnostics).toEqual([]);
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
  it("does not restore a stale build when the start response arrives after project replacement", async () => {
    const h = setup();
    const started = deferred<string>();
    h.api.build.start.mockImplementationOnce(() => started.promise);
    const build = h.controller.build(h.request);
    await vi.waitFor(() => expect(h.controller.getSnapshot().phase).toBe("building"));
    h.controller.setWorkspace("w2");
    h.emitBuild({ type: "complete", workspaceId: "w1", buildId: "late", result: failure });
    started.resolve("late");
    await build;
    expect(h.api.build.cancel).toHaveBeenCalledWith("late");
    expect(h.controller.getSnapshot().diagnostics).toEqual([]);
    expect(h.controller.getSnapshot().successfulBuild).toBeUndefined();
    expect(h.controller.getSnapshot().activeBuildId).toBeUndefined();
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
