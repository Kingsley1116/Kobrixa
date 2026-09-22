import { describe, expect, it, vi } from "vitest";
import type { KobrixaApi, RemoteFileRequest, RemoteFileResult } from "../shared/api.js";
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
  return { controller, execution, files };
}
describe("remote files state", () => {
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
