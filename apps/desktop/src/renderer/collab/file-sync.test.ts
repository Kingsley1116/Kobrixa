import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { trashItem: vi.fn() },
}));

import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
import { WorkspaceService } from "../../main/workspace/workspace.js";
import { CollabMirrors } from "../../main/collab/mirror.js";
import type { WorkspaceSummary } from "../../shared/api.js";
import {
  CollabFileSync,
  CollabFileSyncManager,
  applyMinimalDiff,
  openGuestWorkspace,
  type FileSyncWorkspaceApi,
} from "./file-sync.js";
import { createLinkedSessions, type LinkedSession } from "./testing.js";
import { CollabStore } from "./store.js";
import { sharedTypes } from "./types.js";

const roomId = "room_0123456789abcdef";

async function listTree(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push(`${entryPath}/`);
      result.push(...(await listTree(root, entryPath)));
    } else result.push(entryPath);
  }
  return result.sort();
}

async function settle(...syncs: CollabFileSync[]): Promise<void> {
  for (let round = 0; round < 6; round++) for (const sync of syncs) await sync.flush();
}

describe.sequential("collaborative file sync", () => {
  let base: string;
  let project: string;
  let userData: string;
  let hostService: WorkspaceService;
  let guestService: WorkspaceService;
  let hostSummary: WorkspaceSummary;
  let mirrorSummary: WorkspaceSummary;
  let mirrorRoot: string;
  const syncs: CollabFileSync[] = [];

  const trashItem = (target: string) => rm(target, { recursive: true, force: true });

  beforeEach(async () => {
    base = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-collab-sync-")));
    project = path.join(base, "project");
    userData = path.join(base, "guest-data");
    await mkdir(path.join(project, "src", "lib"), { recursive: true });
    await mkdir(path.join(project, "docs"));
    await mkdir(path.join(project, "assets"));
    await mkdir(userData);
    await writeFile(
      path.join(project, "kobrixa.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        name: "robot",
        language: "bp",
        entry: "src/main.bp",
        target: "ev3-native",
        assets: ["assets/**/*"],
        outputDir: "build",
      })}\n`,
    );
    await writeFile(path.join(project, "src", "main.bp"), "LCD.Clear()\n");
    await writeFile(path.join(project, "src", "lib", "util.bpi"), "Sub Beep\nEndSub\n");
    await writeFile(path.join(project, "assets", "brick.png"), "image");
    hostService = new WorkspaceService({
      userDataPath: () => path.join(base, "host-data"),
      trashItem,
    });
    guestService = new WorkspaceService({ userDataPath: () => userData, trashItem });
    hostSummary = await (
      hostService as unknown as { openDirectory(p: string): Promise<WorkspaceSummary> }
    ).openDirectory(project);
    mirrorSummary = await new CollabMirrors(guestService, () => userData).open(roomId, "robot");
    mirrorRoot = path.join(userData, "collab", roomId);
  });

  afterEach(async () => {
    for (const sync of syncs.splice(0)) sync.dispose();
    await rm(base, { recursive: true, force: true });
  });

  function start(
    session: LinkedSession,
    service: WorkspaceService,
    workspaceId: string,
  ): CollabFileSync {
    const sync = new CollabFileSync(session, workspaceId, service as FileSyncWorkspaceApi, {
      debounceMs: 0,
    });
    sync.start();
    syncs.push(sync);
    return sync;
  }

  async function shared() {
    const room = createLinkedSessions(["host", "editor"], roomId);
    const [hostSession, guestSession] = room.sessions as [LinkedSession, LinkedSession];
    const host = start(hostSession, hostService, hostSummary.id);
    const guest = start(guestSession, guestService, mirrorSummary.id);
    await settle(host, guest);
    return { room, host, guest, hostSession, guestSession };
  }

  const read = (root: string, file: string) => readFile(path.join(root, file), "utf8");

  it("seeds the document from the host and mirrors it to the guest", async () => {
    const { host, guest, hostSession } = await shared();
    expect(host.getSnapshot()).toMatchObject({ phase: "syncing", pendingWrites: 0, skipped: [] });
    expect(guest.getSnapshot()).toMatchObject({ phase: "syncing", pendingWrites: 0 });
    expect(guest.getSnapshot().error).toBeUndefined();
    expect(host.getSnapshot().error).toBeUndefined();
    const types = sharedTypes(hostSession.doc);
    expect([...types.tree.keys()].sort()).toEqual([
      "docs",
      "kobrixa.json",
      "src",
      "src/lib",
      "src/lib/util.bpi",
      "src/main.bp",
    ]);
    expect(types.meta.get("entry")).toBe("src/main.bp");
    expect(await listTree(mirrorRoot)).toEqual([
      "docs/",
      "kobrixa.json",
      "src/",
      "src/lib/",
      "src/lib/util.bpi",
      "src/main.bp",
    ]);
    for (const file of ["kobrixa.json", "src/main.bp", "src/lib/util.bpi"])
      expect(await read(mirrorRoot, file)).toBe(await read(project, file));
  });

  it("lets a late guest reconcile a stale mirror", async () => {
    const room = createLinkedSessions(["host"], roomId);
    const host = start(room.sessions[0] as LinkedSession, hostService, hostSummary.id);
    await settle(host);
    await writeFile(path.join(mirrorRoot, "stale.bp"), "old");
    const guest = start(room.join("viewer"), guestService, mirrorSummary.id);
    await settle(host, guest);
    expect(await listTree(mirrorRoot)).not.toContain("stale.bp");
    expect(await read(mirrorRoot, "src/main.bp")).toBe("LCD.Clear()\n");
  });

  it("writes remote text edits to disk on the other side", async () => {
    const { host, guest, guestSession, hostSession } = await shared();
    const text = sharedTypes(guestSession.doc).files.get("src/main.bp")!;
    text.insert(text.length, "LCD.Update()\n");
    await settle(host, guest);
    expect(await read(project, "src/main.bp")).toBe("LCD.Clear()\nLCD.Update()\n");
    // And back: host edits reach the guest mirror.
    sharedTypes(hostSession.doc).files.get("src/lib/util.bpi")!.insert(0, "' lib\n");
    await settle(host, guest);
    expect(await read(mirrorRoot, "src/lib/util.bpi")).toBe("' lib\nSub Beep\nEndSub\n");
  });

  it("mirrors guest create, rename, move and trash onto the host project", async () => {
    const { host, guest } = await shared();
    const created = await guestService.createEntry(mirrorSummary.id, "src", "file", "motor.bp");
    expect(created.workspace.files).toContain("src/motor.bp");
    expect(guest.recordCreate("src/motor.bp", "file")).toBe(true);
    await guestService.createEntry(mirrorSummary.id, "", "directory", "parts");
    expect(guest.recordCreate("parts", "directory")).toBe(true);
    await settle(host, guest);
    expect(await read(project, "src/motor.bp")).toBe("");
    expect((await stat(path.join(project, "parts"))).isDirectory()).toBe(true);

    await guestService.write(
      mirrorSummary.id,
      "src/motor.bp",
      'Motor.Start("B", 50)\n',
      (await guestService.readFile(mirrorSummary.id, "src/motor.bp")).revision,
    );
    const text = sharedTypes(guest.session.doc).files.get("src/motor.bp")!;
    text.insert(0, 'Motor.Start("B", 50)\n');
    await settle(host, guest);

    const moveSpy = vi.spyOn(hostService, "moveEntry");
    const renamed = await guestService.moveEntry(mirrorSummary.id, "src/motor.bp", "src/drive.bp");
    expect(guest.recordMove(renamed)).toBe(true);
    await settle(host, guest);
    expect(moveSpy).toHaveBeenCalledWith(hostSummary.id, "src/motor.bp", "src/drive.bp");
    expect(await read(project, "src/drive.bp")).toBe('Motor.Start("B", 50)\n');
    await expect(stat(path.join(project, "src/motor.bp"))).rejects.toThrow();

    const movedFolder = await guestService.moveEntry(mirrorSummary.id, "src/lib", "parts/lib");
    expect(guest.recordMove(movedFolder)).toBe(true);
    await settle(host, guest);
    expect(moveSpy).toHaveBeenCalledWith(hostSummary.id, "src/lib", "parts/lib");
    expect(await read(project, "parts/lib/util.bpi")).toBe("Sub Beep\nEndSub\n");

    const trashed = await guestService.trashEntry(mirrorSummary.id, "parts");
    expect(guest.recordTrash(trashed.removed)).toBe(true);
    await settle(host, guest);
    await expect(stat(path.join(project, "parts"))).rejects.toThrow();
    expect(await listTree(project)).toEqual(
      await listTree(mirrorRoot).then((tree) => ["assets/", "assets/brick.png", ...tree].sort()),
    );
    expect(host.getSnapshot().error).toBeUndefined();
    expect(guest.getSnapshot().error).toBeUndefined();
  });

  it("recovers from external host writes by keeping the document content", async () => {
    const { host, guest, guestSession } = await shared();
    await writeFile(path.join(project, "src", "main.bp"), "external\n");
    const text = sharedTypes(guestSession.doc).files.get("src/main.bp")!;
    text.insert(text.length, "LCD.Update()\n");
    await settle(host, guest);
    expect(await read(project, "src/main.bp")).toBe("LCD.Clear()\nLCD.Update()\n");
    expect(host.getSnapshot().error).toBeUndefined();
  });

  it("pulls external host disk changes into the document as minimal diffs", async () => {
    const { host, guest, hostSession } = await shared();
    const text = sharedTypes(hostSession.doc).files.get("src/main.bp")!;
    const deltas: unknown[] = [];
    text.observe((event) => deltas.push(event.delta));
    await writeFile(path.join(project, "src", "main.bp"), "LCD.Clear()\nLCD.Update()\n");
    await host.checkDisk((file) => file === "kobrixa.json");
    await settle(host, guest);
    expect(deltas).toEqual([[{ retain: 12 }, { insert: "LCD.Update()\n" }]]);
    expect(await read(mirrorRoot, "src/main.bp")).toBe("LCD.Clear()\nLCD.Update()\n");
    // Guests never push disk changes.
    await writeFile(path.join(mirrorRoot, "src", "main.bp"), "guest local\n");
    await guest.checkDisk();
    expect(text.toString()).toBe("LCD.Clear()\nLCD.Update()\n");
  });

  it("seeds unsaved editor content without replacing the host disk baseline", async () => {
    const room = createLinkedSessions(["host", "editor"], roomId);
    const session = room.sessions[0]!;
    const host = new CollabFileSync(session, hostSummary.id, hostService, {
      seedContent: (file) => (file === "src/main.bp" ? "unsaved\n" : undefined),
    });
    syncs.push(host);
    host.start();
    const guest = start(room.sessions[1] as LinkedSession, guestService, mirrorSummary.id);
    await settle(host, guest);
    expect(await read(project, "src/main.bp")).toBe("LCD.Clear()\n");
    expect(await read(mirrorRoot, "src/main.bp")).toBe("unsaved\n");
    sharedTypes(guest.session.doc).files.get("src/main.bp")!.insert(0, "remote ");
    await settle(host, guest);
    expect(await read(project, "src/main.bp")).toBe("remote unsaved\n");
  });

  it("bounds revision retries even when another process repeatedly deletes the file", async () => {
    const { host, guest, guestSession } = await shared();
    const write = vi.spyOn(hostService, "write").mockImplementation(async (id, file) => ({
      status: "conflict",
      snapshot: { ...(await hostService.readFile(id, file)), content: null, revision: null },
    }));
    sharedTypes(guestSession.doc).files.get("src/main.bp")!.insert(0, "remote ");
    await settle(host, guest);
    expect(write).toHaveBeenCalledTimes(3);
    expect(host.getSnapshot().error).toContain("keeps changing on disk");
  });

  it("stops observing immediately while draining already received edits", async () => {
    const { host, guest, guestSession } = await shared();
    const text = sharedTypes(guestSession.doc).files.get("src/main.bp")!;
    text.insert(0, "received ");
    await host.stop();
    text.insert(0, "after leave ");
    await settle(host, guest);
    expect(await read(project, "src/main.bp")).toBe("received LCD.Clear()\n");
    expect(host.canMutate).toBe(false);
  });

  it("does not let viewers mutate the tree", async () => {
    const room = createLinkedSessions(["host", "viewer"], roomId);
    const host = start(room.sessions[0] as LinkedSession, hostService, hostSummary.id);
    const viewer = start(room.sessions[1] as LinkedSession, guestService, mirrorSummary.id);
    await settle(host, viewer);
    expect(viewer.canMutate).toBe(false);
    expect(viewer.recordCreate("evil.bp", "file", "x")).toBe(false);
    expect(viewer.recordTrash(["src/main.bp"])).toBe(false);
    expect(sharedTypes(room.sessions[0]!.doc).tree.has("evil.bp")).toBe(false);
    expect(await read(mirrorRoot, "src/main.bp")).toBe("LCD.Clear()\n");
  });

  it("skips files over the size limit when seeding", async () => {
    await writeFile(path.join(project, "big.json"), "x".repeat(COLLAB_LIMITS.fileBytes + 1));
    const { host, hostSession } = await shared();
    expect(host.getSnapshot().skipped).toEqual(["big.json"]);
    expect(sharedTypes(hostSession.doc).tree.has("big.json")).toBe(false);
  });

  it("ignores unsafe remote paths", async () => {
    const { host, guest, guestSession } = await shared();
    const types = sharedTypes(guestSession.doc);
    guestSession.doc.transact(() => {
      types.tree.set("../escape.bp", { kind: "file" });
      types.files.set("../escape.bp", new Y.Text("x"));
      types.tree.set("notes.txt", { kind: "file" });
      types.files.set("notes.txt", new Y.Text("x"));
    });
    await settle(host, guest);
    await expect(stat(path.join(base, "escape.bp"))).rejects.toThrow();
    await expect(stat(path.join(project, "notes.txt"))).rejects.toThrow();
  });
});

describe("applyMinimalDiff", () => {
  it("only touches the changed middle", () => {
    const doc = new Y.Doc();
    const text = doc.getText("t");
    text.insert(0, "hello world");
    const deltas: unknown[] = [];
    text.observe((event) => deltas.push(event.delta));
    expect(applyMinimalDiff(text, "hello brave world")).toBe(true);
    expect(text.toString()).toBe("hello brave world");
    expect(deltas).toEqual([[{ retain: 6 }, { insert: "brave " }]]);
    expect(applyMinimalDiff(text, "hello brave world")).toBe(false);
    applyMinimalDiff(text, "");
    expect(text.toString()).toBe("");
    applyMinimalDiff(text, "a😀b");
    applyMinimalDiff(text, "a😃b");
    expect(text.toString()).toBe("a😃b");
  });
});

describe("guest workspace flow", () => {
  it("opens the mirror and adopts it", async () => {
    const summary = { id: "w" } as WorkspaceSummary;
    const openMirror = vi.fn(async () => summary);
    const adopt = vi.fn(async () => {});
    await expect(
      openGuestWorkspace({ openMirror }, { roomId, projectName: "robot" }, adopt),
    ).resolves.toBe(summary);
    expect(openMirror).toHaveBeenCalledWith(roomId, "robot");
    expect(adopt).toHaveBeenCalledWith(summary);
  });

  it("does not adopt a mirror that finished opening after the room was left", async () => {
    const room = createLinkedSessions(["editor"], roomId);
    const session = room.sessions[0]!;
    const store = new CollabStore(() => session);
    let resolve!: (summary: WorkspaceSummary) => void;
    const opening = new Promise<WorkspaceSummary>((done) => {
      resolve = done;
    });
    const adopt = vi.fn(async () => {});
    const manager = new CollabFileSyncManager(store, {
      workspace: {} as FileSyncWorkspaceApi,
      collab: { openMirror: () => opening },
      activeWorkspaceId: () => undefined,
      adopt,
    });
    const detach = manager.attach();
    store.start(session.connection);
    store.stop();
    resolve({ id: "stale" } as WorkspaceSummary);
    await Promise.resolve();
    await Promise.resolve();
    expect(adopt).not.toHaveBeenCalled();
    expect(manager.getSnapshot()).toBeNull();
    detach();
  });

  it("starts a sync for each store session and tracks read-only role", async () => {
    const room = createLinkedSessions(["host", "editor"], roomId);
    const guestSession = room.sessions[1] as LinkedSession;
    const store = new CollabStore(() => guestSession);
    const summary = {
      id: "mirror",
      entries: [],
      files: [],
      drafts: {},
    } as unknown as WorkspaceSummary;
    const adopt = vi.fn(async () => {});
    const workspace = {
      refresh: vi.fn(async () => ({ workspace: summary, files: {}, changed: false })),
    } as unknown as FileSyncWorkspaceApi;
    const manager = new CollabFileSyncManager(store, {
      workspace,
      collab: { openMirror: async () => summary },
      activeWorkspaceId: () => undefined,
      adopt,
    });
    const detach = manager.attach();
    store.start(guestSession.connection);
    await vi.waitFor(() => expect(manager.getSnapshot()?.workspaceId).toBe("mirror"));
    expect(adopt).toHaveBeenCalledWith(summary);
    expect(manager.for("mirror")).toBe(manager.getSnapshot()?.sync);
    expect(manager.getSnapshot()?.readOnly).toBe(false);
    guestSession.setRole("viewer");
    expect(manager.getSnapshot()?.readOnly).toBe(true);
    store.stop();
    expect(manager.getSnapshot()).toBeNull();
    detach();
  });
});
