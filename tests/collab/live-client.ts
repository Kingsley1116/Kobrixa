import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CollabService } from "../../apps/desktop/src/main/collab/service.js";
import { CollabPreferencesStore } from "../../apps/desktop/src/main/collab/preferences.js";
import { CollabTokenStore } from "../../apps/desktop/src/main/collab/tokens.js";
import { CollabMirrors } from "../../apps/desktop/src/main/collab/mirror.js";
import { WorkspaceService } from "../../apps/desktop/src/main/workspace/workspace.js";
import { createCollabSession } from "../../apps/desktop/src/renderer/collab/collab-session.js";
import { CollabFileSync } from "../../apps/desktop/src/renderer/collab/file-sync.js";
import { ChatController } from "../../apps/desktop/src/renderer/collab/chat.js";
import { DeviceControl } from "../../apps/desktop/src/renderer/collab/device-control.js";
import { CollabStore } from "../../apps/desktop/src/renderer/collab/store.js";
import { sharedTypes, type CollabSession } from "../../apps/desktop/src/renderer/collab/types.js";

const serverUrl = process.argv[2]!;
const temporary = process.argv[3]!;
const remote = process.argv[4] === "remote";
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + (remote ? 30000 : 10000);
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}
const service = () =>
  new CollabService({
    serverUrl,
    fetch,
    preferences: new CollabPreferencesStore(),
    tokens: new CollabTokenStore(),
  });
async function main(): Promise<void> {
  const hostApi = service();
  const guestApi = service();
  const openRoom = await hostApi.createRoom({ name: "Host", projectName: "Passwordless robot" });
  assert.ok(openRoom.ok);
  const openGuest = await guestApi.joinRoom({
    name: "Guest",
    inviteCode: openRoom.value.inviteCode!,
  });
  assert.ok(openGuest.ok);
  await hostApi.leave(openRoom.value.roomId);
  await guestApi.leave(openRoom.value.roomId);
  const password = " Local-or-remote smoke 密碼 ";
  const hostResult = await hostApi.createRoom({
    name: "Host",
    projectName: "Live robot",
    password,
  });
  assert.ok(hostResult.ok);
  const inviteCode = hostResult.value.inviteCode!;
  assert.partialDeepStrictEqual(await guestApi.joinRoom({ name: "Guest", inviteCode }), {
    ok: false,
    error: "password-required",
  });
  assert.partialDeepStrictEqual(
    await guestApi.joinRoom({ name: "Guest", inviteCode, password: "wrong" }),
    {
      ok: false,
      error: "invalid-password",
    },
  );
  const guestResult = await guestApi.joinRoom({
    name: "Guest",
    inviteCode,
    password,
  });
  assert.ok(guestResult.ok);
  const host = createCollabSession(hostResult.value, { network: null });
  const guestStore = new CollabStore((connection) =>
    createCollabSession(connection, { network: null }),
  );
  let guest = guestStore.start(guestResult.value);
  const sessions: CollabSession[] = [host, guest];
  const syncs: CollabFileSync[] = [];
  const chats: ChatController[] = [];
  const controls: DeviceControl[] = [];
  try {
    host.connect();
    guest.connect();
    await until(
      () => sessions.every((session) => session.getSnapshot().status === "connected"),
      "both sessions connected",
    );
    const hostDirectory = path.join(temporary, "host-project");
    await mkdir(hostDirectory);
    await writeFile(path.join(hostDirectory, "main.bp"), "value = 1\n");
    const workspaces = new WorkspaceService({
      userDataPath: () => path.join(temporary, "user-data"),
    });
    const hostWorkspace = await workspaces.openDirectory(hostDirectory);
    const mirror = new CollabMirrors(workspaces, () => path.join(temporary, "guest-data"));
    const guestWorkspace = await mirror.open(hostResult.value.roomId, "Live robot");
    const workspaceApi = {
      readFile: workspaces.readFile.bind(workspaces),
      write: workspaces.write.bind(workspaces),
      refresh: workspaces.refresh.bind(workspaces),
      createEntry: workspaces.createEntry.bind(workspaces),
      moveEntry: workspaces.moveEntry.bind(workspaces),
      trashEntry: workspaces.trashEntry.bind(workspaces),
    };
    const hostSync = new CollabFileSync(host, hostWorkspace.id, workspaceApi, { debounceMs: 5 });
    let guestSync = new CollabFileSync(guest, guestWorkspace.id, workspaceApi, { debounceMs: 5 });
    syncs.push(hostSync, guestSync);
    hostSync.start();
    guestSync.start();
    const hostTypes = sharedTypes(host.doc);
    let guestTypes = sharedTypes(guest.doc);
    await until(
      () => guestTypes.files.get("main.bp")?.toString() === "value = 1\n",
      "host seed reaches guest",
    );
    await guestSync.flush();
    assert.equal((await workspaces.readFile(guestWorkspace.id, "main.bp")).content, "value = 1\n");
    guestTypes.files.get("main.bp")!.insert(0, "// guest edit\n");
    await until(
      () => hostTypes.files.get("main.bp")?.toString().startsWith("// guest edit") === true,
      "guest edit reaches host",
    );
    await hostSync.flush();
    assert.equal(
      await readFile(path.join(hostDirectory, "main.bp"), "utf8"),
      "// guest edit\nvalue = 1\n",
    );
    host.awareness.setLocalStateField("file", "main.bp");
    await until(
      () =>
        [...guest.awareness.getStates().values()].some(
          (state) => state.name === "Host" && state.file === "main.bp",
        ),
      "awareness reaches guest",
    );
    await workspaces.createEntry(hostWorkspace.id, "", "file", "shared.bpi");
    assert.ok(hostSync.recordCreate("shared.bpi", "file", ""));
    await until(() => guestTypes.tree.has("shared.bpi"), "created file reaches guest");
    await guestSync.flush();
    const moved = await workspaces.moveEntry(guestWorkspace.id, "shared.bpi", "renamed.bpi");
    assert.ok(guestSync.recordMove(moved));
    await until(() => hostTypes.tree.has("renamed.bpi"), "rename reaches host");
    await hostSync.flush();
    assert.equal((await workspaces.readFile(hostWorkspace.id, "renamed.bpi")).content, "");
    const removed = await workspaces.trashEntry(hostWorkspace.id, "renamed.bpi");
    assert.ok(hostSync.recordTrash(removed.removed));
    await until(() => !guestTypes.tree.has("renamed.bpi"), "deletion reaches guest");
    await guestSync.flush();
    const hostChat = new ChatController(host);
    let guestChat = new ChatController(guest);
    chats.push(hostChat, guestChat);
    assert.ok(guestChat.send("hello over a real socket").ok);
    await until(() => hostChat.getSnapshot().unread === 1, "chat reaches host unread badge");
    const hostControl = new DeviceControl(host);
    let guestControl = new DeviceControl(guest);
    controls.push(hostControl, guestControl);
    await until(() => hostControl.getSnapshot().isHolder, "host starts with control");
    guestControl.request();
    await until(() => hostControl.getSnapshot().requests.length === 1, "request reaches host");
    hostControl.grant(guest.connection.participantId);
    await until(
      () => guestControl.getSnapshot().isHolder && !hostControl.getSnapshot().isHolder,
      "guest receives control",
    );
    async function acceptGuestRole(role: "editor" | "viewer"): Promise<void> {
      await until(() => {
        const next = guestStore.getSnapshot();
        return (
          next !== guest &&
          next?.getSnapshot().role === role &&
          next.getSnapshot().status === "connected"
        );
      }, `fresh ${role} session connects`);
      await guestSync.stop();
      guestChat.dispose();
      guestControl.dispose();
      guest = guestStore.getSnapshot()!;
      sessions.push(guest);
      guestTypes = sharedTypes(guest.doc);
      guestSync = new CollabFileSync(guest, guestWorkspace.id, workspaceApi, { debounceMs: 5 });
      syncs.push(guestSync);
      guestSync.start();
      guestChat = new ChatController(guest);
      guestControl = new DeviceControl(guest);
      chats.push(guestChat);
      controls.push(guestControl);
    }
    assert.ok(
      (
        await hostApi.setRole(host.connection.roomId, {
          participantId: guest.connection.participantId,
          role: "viewer",
        })
      ).ok,
    );
    await acceptGuestRole("viewer");
    assert.equal(guestControl.getSnapshot().isHolder, false);
    assert.equal(guestChat.send("forbidden").ok, false);
    let before = hostTypes.files.get("main.bp")!.toString();
    guestTypes.files.get("main.bp")!.insert(0, "forbidden");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(hostTypes.files.get("main.bp")!.toString(), before);
    assert.ok(
      (
        await hostApi.setRole(host.connection.roomId, {
          participantId: guest.connection.participantId,
          role: "editor",
        })
      ).ok,
    );
    await acceptGuestRole("editor");
    assert.equal(guestTypes.files.get("main.bp")!.toString(), before);
    guestTypes.files.get("main.bp")!.insert(0, "// promoted edit\n");
    await until(
      () => hostTypes.files.get("main.bp")!.toString() === "// promoted edit\n" + before,
      "promoted editor writes without clock gaps or resurrecting viewer changes",
    );
    before = hostTypes.files.get("main.bp")!.toString();
    guestControl.request();
    await until(
      () => hostControl.getSnapshot().requests.length === 1,
      "promoted editor requests control",
    );
    assert.ok((await hostApi.kick(host.connection.roomId, guest.connection.participantId)).ok);
    await until(() => guest.getSnapshot().closeReason === "kicked", "kick reaches guest");
    assert.equal(syncs.map((sync) => sync.getSnapshot().error).filter(Boolean).length, 0);
    // Close every client and reconnect with an empty document so the server state
    // cannot be supplied by a peer. Only the local harness restarts its Worker.
    for (const control of controls.splice(0)) control.dispose();
    for (const chat of chats.splice(0)) chat.dispose();
    for (const sync of syncs.splice(0)) await sync.stop();
    guestStore.stop();
    for (const session of sessions.splice(0)) session.destroy();
    if (!remote) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker restart timed out")), 40000);
        process.once("message", (message) => {
          clearTimeout(timer);
          if (message === "worker-restarted") resolve();
          else reject(new Error("Unexpected Worker restart response"));
        });
        process.send!("restart-worker");
      });
    }
    const freshApi = service();
    assert.partialDeepStrictEqual(await freshApi.joinRoom({ name: "Fresh", inviteCode }), {
      ok: false,
      error: "password-required",
    });
    assert.partialDeepStrictEqual(
      await freshApi.setRole(hostResult.value.roomId, {
        participantId: guestResult.value.participantId,
        role: "editor",
      }),
      { ok: false, error: "forbidden" },
    );
    const freshGuest = await freshApi.joinRoom({ name: "Fresh", inviteCode, password });
    assert.ok(freshGuest.ok);
    assert.ok((await hostApi.kick(hostResult.value.roomId, freshGuest.value.participantId)).ok);
    await freshApi.leave(hostResult.value.roomId);
    const restored = createCollabSession(hostResult.value, { network: null });
    sessions.push(restored);
    restored.connect();
    await until(() => restored.getSnapshot().status === "connected", "fresh room client connects");
    const restoredTypes = sharedTypes(restored.doc);
    assert.equal(restoredTypes.files.get("main.bp")?.toString(), before);
    assert.equal(restoredTypes.tree.has("renamed.bpi"), false);
    assert.equal(restoredTypes.chat.length, 1);
    assert.equal(restoredTypes.chat.get(0).text, "hello over a real socket");
    const rejected = createCollabSession(guestResult.value, { network: null });
    sessions.push(rejected);
    rejected.connect();
    await until(() => rejected.getSnapshot().status === "closed", "kicked client stays revoked");
    console.log(
      "Live collaboration passes: optional room passwords, memory-only credentials, desktop HTTP service, two real WebSockets, host seed, guest mirror, bidirectional text/tree, awareness, chat, control grant, viewer enforcement, safe role promotion, kick, and server state/revocation across " +
        (remote ? "fresh client connections." : "a Worker restart."),
    );
  } finally {
    for (const control of controls) control.dispose();
    for (const chat of chats) chat.dispose();
    for (const sync of syncs) await sync.stop();
    guestStore.stop();
    for (const session of sessions) session.destroy();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
