import { describe, expect, it, vi } from "vitest";
import type {
  FileBatchRequest,
  FileBatchSnapshot,
  KobrixaApi,
  RemoteFileRequest,
  RemoteFileResult,
} from "../shared/api.js";
import { ExecutionController } from "./execution.js";
import { PROJECT_ROOT as ROOT, RemoteFilesController } from "./remote-files.js";
function setup() {
  const files = vi.fn(async (request: RemoteFileRequest): Promise<RemoteFileResult> => ({
    ok: true,
    sessionId: request.sessionId,
    requestId: request.requestId,
    entries: [],
  }));
  const api = {
    device: { files },
    build: {},
    workspace: {},
    language: {},
  } as unknown as KobrixaApi;
  const execution = new ExecutionController(api),
    controller = new RemoteFilesController(api, execution);
  controller.setSession("s1");
  return { controller, execution, files, api };
}
describe("remote files state", () => {
  it("holds the device lock until confirmation cancellation is acknowledged", async () => {
    const h = setup();
    h.api.device.prepareFiles = vi.fn(async (request) => ({
      ...request,
      planId: "plan",
      phase: "ready",
      items: [],
      issues: [],
      stopRequested: false,
    }));
    let release!: () => void;
    h.api.device.stopFiles = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.api.device.executeFiles = vi.fn();
    const pending = h.controller.prepareBatch("delete", [`${ROOT}/one`], "files", "en");
    await vi.waitFor(() => expect(h.controller.getSnapshot().batch?.phase).toBe("ready"));
    await h.controller.stopBatch();
    expect(h.controller.getSnapshot().busy).toBe(true);
    expect(h.execution.locked).toBe(true);
    expect(h.api.device.executeFiles).not.toHaveBeenCalled();
    release();
    await pending;
    expect(h.controller.getSnapshot().busy).toBe(false);
    expect(h.execution.locked).toBe(false);
  });
  it("removes only successfully deleted entries even if the final refresh fails", async () => {
    const h = setup();
    const entries = ["one", "two", "three"].map((name) => ({
      name,
      path: `${ROOT}/${name}`,
      kind: "file" as const,
    }));
    h.files.mockImplementationOnce(async (request) => ({ ...request, ok: true, entries }));
    await h.controller.perform("list", ROOT, "en");
    h.api.device.prepareFiles = vi.fn(async (request) => ({
      ...request,
      planId: "plan",
      phase: "ready",
      issues: [],
      stopRequested: false,
      items: entries.map((entry) => ({
        id: entry.name,
        label: entry.name,
        kind: entry.kind,
        conflict: false,
        status: "pending" as const,
      })),
    }));
    h.api.device.executeFiles = vi.fn(async (ref) => ({
      ...h.controller.getSnapshot().batch!,
      ...ref,
      phase: "failed",
      items: h.controller.getSnapshot().batch!.items.map((item, i) => ({
        ...item,
        status: i === 0 ? "succeeded" : i === 1 ? "failed" : "pending",
      })),
    }));
    h.files.mockImplementationOnce(async (request) => ({
      ...request,
      ok: false,
      category: "permission",
      message: "Refresh denied",
    }));
    const pending = h.controller.prepareBatch(
      "delete",
      entries.map((entry) => entry.path),
      "files",
      "en",
    );
    await vi.waitFor(() => expect(h.controller.getSnapshot().batch?.phase).toBe("ready"));
    h.controller.executeBatch("skip");
    await pending;
    expect(h.controller.getSnapshot().entries.map((entry) => entry.name)).toEqual(["two", "three"]);
    expect(h.controller.getSnapshot().batch?.items.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
      "pending",
    ]);
    expect(h.controller.getSnapshot().refreshError?.message).toBe("Refresh denied");
    expect(h.api.device.executeFiles).toHaveBeenCalledOnce();
  });
  it("releases an interrupted IPC batch without leaving a running confirmation", async () => {
    const h = setup();
    h.api.device.prepareFiles = vi.fn(async (request) => ({
      ...request,
      planId: "plan",
      phase: "ready",
      items: [],
      issues: [],
      stopRequested: false,
    }));
    h.api.device.executeFiles = vi.fn(async () => {
      throw new Error("IPC interrupted");
    });
    h.api.device.stopFiles = vi.fn(async () => {});
    const pending = h.controller.prepareBatch("upload", [], "files", "en");
    await vi.waitFor(() => expect(h.controller.getSnapshot().batch?.phase).toBe("ready"));
    h.controller.executeBatch("skip");
    await pending;
    expect(h.api.device.stopFiles).toHaveBeenCalledOnce();
    expect(h.controller.getSnapshot()).toMatchObject({
      busy: false,
      batch: { phase: "failed" },
      error: { message: "IPC interrupted" },
    });
    expect(h.execution.locked).toBe(false);
  });
  it("keeps the old folder and entries while refreshing and after failed navigation", async () => {
    const h = setup();
    const entries = [{ path: `${ROOT}/kept`, name: "kept", kind: "file" as const }];
    h.files.mockImplementationOnce(async (request) => ({ ...request, ok: true, entries }));
    await h.controller.perform("list", ROOT, "en");
    let finish!: (result: RemoteFileResult) => void;
    h.files.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loading = h.controller.perform("list", `${ROOT}/missing`, "en");
    expect(h.controller.getSnapshot()).toMatchObject({ path: ROOT, entries, busy: true });
    finish({
      ...h.files.mock.calls.at(-1)![0],
      ok: false,
      category: "not-found",
      message: "Missing",
    });
    expect(await loading).toBe(false);
    expect(h.controller.getSnapshot()).toMatchObject({ path: ROOT, entries, busy: false });
  });
  it("reports a successful rename separately from its failed refresh", async () => {
    const h = setup();
    h.files.mockImplementation(async (request) =>
      request.action === "rename"
        ? { ...request, ok: true }
        : { ...request, ok: false, category: "permission", message: "Read denied" },
    );
    expect(await h.controller.perform("rename", `${ROOT}/a`, "en", "b")).toBe(true);
    expect(h.controller.getSnapshot().error).toBeUndefined();
    expect(h.controller.getSnapshot().refreshError?.message).toBe("Read denied");
  });
  it("holds the frontend lock through confirmation, handles early events, and refreshes once", async () => {
    const h = setup();
    const prepare = vi.fn(async (request: FileBatchRequest): Promise<FileBatchSnapshot> => {
      const batch: FileBatchSnapshot = {
        ...request,
        planId: "plan",
        phase: "ready",
        items: [{ id: "one", label: "one", kind: "file", conflict: false, status: "pending" }],
        issues: [],
        stopRequested: false,
      };
      h.controller.onEvent({ type: "file-batch", snapshot: batch });
      return batch;
    });
    const execute = vi.fn(async (ref): Promise<FileBatchSnapshot> => {
      const batch: FileBatchSnapshot = {
        ...ref,
        phase: "failed",
        items: [{ ...ref.items[0], status: "failed", message: "Disk full" }],
      };
      h.controller.onEvent({ type: "file-batch", snapshot: batch });
      return batch;
    });
    h.api.device.prepareFiles = prepare;
    h.api.device.executeFiles = execute;
    const pending = h.controller.prepareBatch("upload", [], "files", "en");
    await vi.waitFor(() => expect(h.controller.getSnapshot().batch?.phase).toBe("ready"));
    expect(h.execution.locked).toBe(true);
    expect(h.execution.editingLocked).toBe(false);
    await h.controller.prepareBatch("delete", [`${ROOT}/one`], "files", "en");
    expect(prepare).toHaveBeenCalledOnce();
    h.controller.executeBatch("skip");
    h.controller.executeBatch("skip");
    await pending;
    expect(execute).toHaveBeenCalledOnce();
    expect(h.files).toHaveBeenCalledOnce();
    expect(h.execution.locked).toBe(false);
    expect(h.controller.getSnapshot().batch?.items[0]?.status).toBe("failed");
    h.controller.onEvent({
      type: "file-batch",
      snapshot: { ...h.controller.getSnapshot().batch!, requestId: "old", phase: "running" },
    });
    expect(h.controller.getSnapshot().batch?.phase).toBe("failed");
  });
  it("locks device operations but allows local editing, and ignores duplicate clicks", async () => {
    const h = setup();
    let resolve!: (response: RemoteFileResult) => void;
    h.files.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const pending = h.controller.perform("list", ROOT, "en");
    expect(h.execution.locked).toBe(true);
    expect(h.execution.editingLocked).toBe(false);
    await h.controller.perform("upload", ROOT, "en");
    expect(h.files).toHaveBeenCalledOnce();
    const request = h.files.mock.calls[0]![0];
    resolve({ ...request, ok: true, entries: [] });
    await pending;
    expect(h.execution.locked).toBe(false);
    expect(h.controller.getSnapshot().loaded).toBe(true);
  });
  it("ignores responses and progress from an old session", async () => {
    const h = setup();
    let resolve!: (response: RemoteFileResult) => void;
    h.files.mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const pending = h.controller.perform("list", `${ROOT}/old`, "en");
    const request = h.files.mock.calls[0]![0];
    h.controller.setSession("s2");
    h.controller.onEvent({
      type: "file-progress",
      sessionId: "s1",
      requestId: request.requestId,
      transferred: 4,
      total: 10,
    });
    resolve({
      ...request,
      ok: true,
      entries: [{ path: `${ROOT}/old/file`, name: "file", kind: "file" }],
    });
    await pending;
    expect(h.controller.getSnapshot()).toMatchObject({
      sessionId: "s2",
      path: ROOT,
      entries: [],
      loaded: false,
    });
    expect(h.controller.getSnapshot().progress).toBeUndefined();
  });
  it("falls back from a missing initial deployment folder, preserves paths across tabs, and reloads a new session", async () => {
    const h = setup();
    h.controller.setSession("s2", `${ROOT}/robot/robot.rbf`);
    h.files.mockImplementation(async (request) =>
      request.path.endsWith("robot")
        ? { ...request, ok: false, category: "not-found", message: "Missing" }
        : { ...request, ok: true, entries: [] },
    );
    await h.controller.perform("list", `${ROOT}/robot`, "en");
    expect(h.controller.getSnapshot().path).toBe(ROOT);
    expect(h.files).toHaveBeenCalledTimes(2);
    await h.controller.perform("list", `${ROOT}/other`, "en");
    h.controller.setSession("s2");
    expect(h.controller.getSnapshot().path).toBe(`${ROOT}/other`);
    h.controller.setSession(undefined);
    h.controller.setSession("s3");
    expect(h.controller.getSnapshot().loaded).toBe(false);
  });
  it("retains the path after a failed write and never retries the write", async () => {
    const h = setup();
    await h.controller.perform("list", `${ROOT}/robot`, "en");
    h.files.mockImplementation(async (request) => ({
      ...request,
      ok: false,
      category: "permission",
      message: "Denied",
    }));
    await h.controller.perform("upload", `${ROOT}/robot`, "en");
    expect(h.controller.getSnapshot()).toMatchObject({
      path: `${ROOT}/robot`,
      busy: false,
      error: { category: "permission", message: "Denied" },
    });
    expect(h.files.mock.calls.filter(([r]) => r.action === "upload")).toHaveLength(1);
  });
  it("matches progress and results by request id", async () => {
    const h = setup();
    h.files.mockImplementation(async (request) => {
      h.controller.onEvent({
        type: "file-progress",
        sessionId: request.sessionId,
        requestId: "old",
        transferred: 9,
        total: 10,
      });
      expect(h.controller.getSnapshot().progress).toBeUndefined();
      h.controller.onEvent({
        type: "file-progress",
        sessionId: request.sessionId,
        requestId: request.requestId,
        transferred: 4,
        total: 10,
      });
      expect(h.controller.getSnapshot().progress?.transferred).toBe(4);
      return {
        ...request,
        requestId: "old",
        ok: true,
        entries: [{ name: "wrong", path: `${ROOT}/wrong`, kind: "file" }],
      };
    });
    await h.controller.perform("list", ROOT, "en");
    expect(h.controller.getSnapshot().entries).toEqual([]);
  });
});
