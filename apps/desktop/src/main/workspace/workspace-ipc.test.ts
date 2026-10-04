import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
}));

import { registerIpc } from "../ipc.js";

const workspaceId = "01a105ef-2540-78c2-a13e-e255f0b4b1a6";
const entryId = "a1b2c3d4-1234-4567-89ab-123456789abc";
const revision = "a".repeat(64);
const sourceFile = "src/main.bp";
const requests = [
  { channel: "workspace:read-file", method: "readFile", args: [sourceFile] },
  { channel: "workspace:refresh", method: "refresh", args: [{ [sourceFile]: revision }] },
  { channel: "workspace:history", method: "history", args: [sourceFile] },
  { channel: "workspace:history-content", method: "historyContent", args: [sourceFile, entryId] },
  { channel: "workspace:write", method: "write", args: [sourceFile, "edited", revision] },
  { channel: "workspace:save-draft", method: "saveDraft", args: [sourceFile, "draft", revision] },
] as const;

describe("workspace file IPC", () => {
  const renderer = { id: 1, mainFrame: {} };
  const event = { sender: renderer, senderFrame: renderer.mainFrame };
  let rendererAvailable: boolean;
  const service = {
    getPreferences: vi.fn(),
    setPreferences: vi.fn(),
    readFile: vi.fn(),
    refresh: vi.fn(),
    history: vi.fn(),
    historyContent: vi.fn(),
    write: vi.fn(),
    saveDraft: vi.fn(),
  };
  const run = vi.fn((_channel: string, work: () => unknown) => work());

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    rendererAvailable = true;
    registerIpc(
      () => (rendererAvailable ? (renderer as never) : undefined),
      service as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { run } as never,
    );
  });

  it("rejects untrusted senders and frames before running any workspace operation", () => {
    for (const request of requests) {
      const handler = handlers.get(request.channel)!;
      for (const untrusted of [
        { ...event, sender: { id: 2 } },
        { ...event, senderFrame: {} },
      ]) {
        expect(() => handler(untrusted, workspaceId, ...request.args)).toThrow("untrusted");
      }
      rendererAvailable = false;
      expect(() => handler(event, workspaceId, ...request.args)).toThrow("untrusted");
      rendererAvailable = true;
      expect(service[request.method]).not.toHaveBeenCalled();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it("validates workspace, file and history identifiers before forwarding requests", () => {
    for (const request of requests) {
      const handler = handlers.get(request.channel)!;
      expect(() => handler(event, "unknown", ...request.args)).toThrow();
      if (request.method !== "refresh") {
        for (const invalidFile of [undefined, null, "", "bad\0.bp", "x".repeat(1025)]) {
          expect(() =>
            handler(event, workspaceId, invalidFile, ...request.args.slice(1)),
          ).toThrow();
        }
      }
    }
    const historyContent = handlers.get("workspace:history-content")!;
    for (const invalidId of [undefined, null, "../../history", "not-a-uuid"]) {
      expect(() => historyContent(event, workspaceId, sourceFile, invalidId)).toThrow();
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled();
  });

  it("requires a valid expected revision for writes and preserves explicit missing-file null", () => {
    const write = handlers.get("workspace:write")!;
    for (const invalidRevision of [undefined, "", "a".repeat(63), "A".repeat(64), 12, {}]) {
      expect(() => write(event, workspaceId, sourceFile, "edited", invalidRevision)).toThrow();
    }
    expect(() => write(event, workspaceId, sourceFile, null, revision)).toThrow();
    expect(service.write).not.toHaveBeenCalled();
    write(event, workspaceId, sourceFile, "new file", null);
    expect(service.write).toHaveBeenLastCalledWith(workspaceId, sourceFile, "new file", null);
    write(event, workspaceId, sourceFile, "edited", revision);
    expect(service.write).toHaveBeenLastCalledWith(workspaceId, sourceFile, "edited", revision);
  });

  it("validates refresh maps and forwards null revisions for deleted files", () => {
    const refresh = handlers.get("workspace:refresh")!;
    for (const invalidKnown of [
      undefined,
      null,
      [],
      { [sourceFile]: undefined },
      { [sourceFile]: "invalid" },
      { "bad\0.bp": revision },
    ]) {
      expect(() => refresh(event, workspaceId, invalidKnown)).toThrow();
    }
    const excessive = Object.fromEntries(
      Array.from({ length: 10001 }, (_, index) => [`${index}.bp`, null]),
    );
    expect(() => refresh(event, workspaceId, excessive)).toThrow();
    expect(service.refresh).not.toHaveBeenCalled();
    const known = { [sourceFile]: revision, "src/deleted.bp": null };
    refresh(event, workspaceId, known);
    expect(service.refresh).toHaveBeenCalledWith(workspaceId, known);
  });

  it("forwards draft base revisions and supports legacy drafts and draft removal", () => {
    const saveDraft = handlers.get("workspace:save-draft")!;
    expect(() => saveDraft(event, workspaceId, sourceFile, "draft", "invalid")).toThrow();
    expect(() => saveDraft(event, workspaceId, sourceFile, null, revision)).toThrow();
    expect(service.saveDraft).not.toHaveBeenCalled();
    saveDraft(event, workspaceId, sourceFile, "draft", revision);
    expect(service.saveDraft).toHaveBeenLastCalledWith(workspaceId, sourceFile, "draft", revision);
    saveDraft(event, workspaceId, sourceFile, "new draft", null);
    expect(service.saveDraft).toHaveBeenLastCalledWith(workspaceId, sourceFile, "new draft", null);
    saveDraft(event, workspaceId, sourceFile, "legacy draft");
    expect(service.saveDraft).toHaveBeenLastCalledWith(
      workspaceId,
      sourceFile,
      "legacy draft",
      undefined,
    );
    saveDraft(event, workspaceId, sourceFile, undefined, revision);
    expect(service.saveDraft).toHaveBeenLastCalledWith(
      workspaceId,
      sourceFile,
      undefined,
      revision,
    );
  });

  it("forwards arguments and returns the service result through the update operation gate", async () => {
    const result = { status: "conflict", snapshot: { content: "external", revision } };
    for (const request of requests) {
      const promise = Promise.resolve(result);
      service[request.method].mockReturnValueOnce(promise);
      const returned = handlers.get(request.channel)!(event, workspaceId, ...request.args);
      expect(returned).toBe(promise);
      expect(await returned).toBe(result);
      expect(service[request.method]).toHaveBeenLastCalledWith(workspaceId, ...request.args);
      expect(run).toHaveBeenLastCalledWith(request.channel, expect.any(Function));
    }
  });

  it("validates and protects file preference IPC before forwarding persisted patches", () => {
    const get = handlers.get("workspace:preferences")!;
    const set = handlers.get("workspace:set-preferences")!;
    expect(() => get({ ...event, senderFrame: {} })).toThrow("untrusted");
    expect(() => set({ ...event, sender: { id: 2 } }, { localHistoryEnabled: false })).toThrow(
      "untrusted",
    );
    for (const patch of [
      null,
      [],
      { unknown: true },
      { localHistoryDays: 1 },
      { localHistoryEnabled: "false" },
      { externalChangeInterval: 2001 },
    ]) {
      expect(() => set(event, patch)).toThrow();
    }
    expect(service.getPreferences).not.toHaveBeenCalled();
    expect(service.setPreferences).not.toHaveBeenCalled();
    const preferences = Promise.resolve({ localHistoryEnabled: false });
    service.getPreferences.mockReturnValueOnce(preferences);
    expect(get(event)).toBe(preferences);
    expect(service.getPreferences).toHaveBeenCalledWith();
    const patch = {
      localHistoryEnabled: false,
      externalChangeInterval: 5000,
      localHistoryVersions: 100,
    };
    service.setPreferences.mockReturnValueOnce(preferences);
    expect(set(event, patch)).toBe(preferences);
    expect(service.setPreferences).toHaveBeenCalledWith(patch);
    expect(run).toHaveBeenLastCalledWith("workspace:set-preferences", expect.any(Function));
  });
});
