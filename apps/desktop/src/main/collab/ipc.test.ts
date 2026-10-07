import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  COLLAB_ROUTES,
  createRoomRequestSchema,
  joinRequestSchema,
  kickRequestSchema,
  setRoleRequestSchema,
} from "@kobrixa/collab-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn),
  },
  shell: {},
  app: { getPath: () => tmpdir() },
  net: { fetch: (url: string, init: RequestInit) => globalThis.fetch(url, init) },
  get safeStorage() {
    throw new Error("Collaboration must not access the OS keychain");
  },
}));

import { registerIpc } from "../ipc.js";
import { UpdateOperationGate, type UpdateService } from "../updates/service.js";
import { registerCollabIpc } from "./ipc.js";
import { createCollabService } from "./runtime.js";
import { CollabService } from "./service.js";
import { loadCollabPreferences } from "./preferences.js";
import { CollabTokenStore } from "./tokens.js";

const ROOM = "room-0123456789abcdef";
const HOST = "host-participant";
const GUEST = "guest-participant";
const INVITE = "ABCD-EFGH-JKLM";
const EXPIRES = Date.now() + 60_000;

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

/** Minimal stand-in for `apps/collab` that speaks the protocol schemas. */
class FakeCollabServer {
  readonly seen: Seen[] = [];
  mode: "ok" | "invalid" | "html-502" | "error-json" | "hang" = "ok";
  private server: Server = createServer((request, response) => void this.serve(request, response));
  origin = "";

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const body: unknown = text ? JSON.parse(text) : undefined;
    this.seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      authorization: request.headers.authorization,
      body,
    });
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (this.mode === "hang") return;
    if (this.mode === "html-502") {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<html>Bad gateway</html>");
      return;
    }
    if (this.mode === "error-json") return json(429, { error: "rate-limited", message: "slow" });
    if (request.method !== "POST") return json(405, { error: "bad-request" });
    if (request.url === COLLAB_ROUTES.createRoom) {
      if (!createRoomRequestSchema.safeParse(body).success)
        return json(400, { error: "bad-request" });
      if (this.mode === "invalid") return json(200, { roomId: ROOM });
      return json(201, {
        roomId: ROOM,
        inviteCode: INVITE,
        participantId: HOST,
        hostToken: "host-token",
        expiresAt: EXPIRES,
      });
    }
    if (request.url === COLLAB_ROUTES.join) {
      const parsed = joinRequestSchema.safeParse(body);
      if (!parsed.success) return json(400, { error: "bad-request" });
      if (parsed.data.inviteCode !== INVITE) return json(404, { error: "not-found" });
      return json(200, {
        roomId: ROOM,
        participantId: GUEST,
        token: "guest-token",
        role: "editor",
        projectName: "Robot",
        expiresAt: EXPIRES,
      });
    }
    const admin = /^\/rooms\/([^/]+)\/(kick|role)$/.exec(request.url ?? "");
    if (admin) {
      if (request.headers.authorization !== "Bearer host-token")
        return json(403, { error: "forbidden" });
      const schema = admin[2] === "kick" ? kickRequestSchema : setRoleRequestSchema;
      if (admin[1] !== ROOM || !schema.safeParse(body).success)
        return json(400, { error: "bad-request" });
      response.writeHead(204);
      response.end();
      return;
    }
    json(404, { error: "not-found" });
  }
}

const renderer = { id: 1, mainFrame: {} };
const event = { sender: renderer, senderFrame: renderer.mainFrame };
const call = async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(event, ...args);
};

let server: FakeCollabServer;
let userData: string;
beforeEach(async () => {
  handlers.clear();
  server = new FakeCollabServer();
  await server.start();
  userData = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-ipc-"));
});
afterEach(async () => {
  await server.stop();
  await rm(userData, { recursive: true, force: true });
});

function register(service: CollabService): void {
  // While an update is being prepared, collab channels must stay reachable.
  const updates = { preparing: true } as UpdateService;
  registerIpc(
    () => renderer as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    updates,
    new UpdateOperationGate(() => updates),
    undefined,
    undefined,
    undefined,
    [(handle) => registerCollabIpc(handle, service)],
  );
}

describe("collab IPC against a fake collaboration service", () => {
  it("creates, joins, administers and leaves a room", async () => {
    register(await createCollabService(userData, server.origin));
    expect(await call("collab:server-url")).toBe(server.origin);

    const created = await call("collab:create-room", { name: "Host", projectName: "Robot" });
    expect(created).toEqual({
      ok: true,
      value: {
        serverUrl: server.origin,
        roomId: ROOM,
        participantId: HOST,
        token: "host-token",
        role: "host",
        name: "Host",
        projectName: "Robot",
        inviteCode: INVITE,
        expiresAt: EXPIRES,
      },
    });
    const joined = await call("collab:join-room", { inviteCode: INVITE, name: "Guest" });
    expect(joined).toMatchObject({
      ok: true,
      value: { roomId: ROOM, participantId: GUEST, token: "guest-token", role: "editor" },
    });
    // The fake server hands out one room, so the join above replaced the host token
    // with the guest's. Re-create to act as the host again.
    await call("collab:create-room", { name: "Host", projectName: "Robot" });

    expect(await call("collab:kick", ROOM, GUEST)).toEqual({ ok: true, value: null });
    expect(await call("collab:set-role", ROOM, { participantId: GUEST, role: "viewer" })).toEqual({
      ok: true,
      value: null,
    });

    const posts = server.seen.filter((item) => item.method === "POST");
    expect(posts.map((item) => item.url)).toEqual([
      COLLAB_ROUTES.createRoom,
      COLLAB_ROUTES.join,
      COLLAB_ROUTES.createRoom,
      COLLAB_ROUTES.kick(ROOM),
      COLLAB_ROUTES.setRole(ROOM),
    ]);
    expect(createRoomRequestSchema.safeParse(posts[0]!.body).success).toBe(true);
    expect(joinRequestSchema.safeParse(posts[1]!.body).success).toBe(true);
    expect(kickRequestSchema.parse(posts[3]!.body)).toEqual({ participantId: GUEST });
    expect(posts[3]!.authorization).toBe("Bearer host-token");
    expect(posts[4]!.authorization).toBe("Bearer host-token");
    expect(posts[0]!.authorization).toBeUndefined();

    const preferences = (await call("collab:preferences")) as {
      recentRooms: { roomId: string; role: string; inviteCode?: string }[];
    };
    expect(preferences.recentRooms).toEqual([
      expect.objectContaining({ roomId: ROOM, role: "host", inviteCode: INVITE }),
    ]);
    const persisted = await readFile(path.join(userData, "collab-preferences.json"), "utf8");
    expect(persisted).not.toContain("token");
    await expect(readFile(path.join(userData, "collab-tokens.json"))).rejects.toThrow();

    await call("collab:leave", ROOM);
    expect(await call("collab:kick", ROOM, GUEST)).toMatchObject({ ok: false, error: "forbidden" });
    expect(server.seen).toHaveLength(5);
    expect(
      ((await call("collab:preferences")) as { recentRooms: unknown[] }).recentRooms,
    ).toHaveLength(1);
  });

  it("refuses host actions for guests and unknown rooms without contacting the server", async () => {
    register(await createCollabService(userData, server.origin));
    await call("collab:join-room", { inviteCode: INVITE, name: "Guest" });
    expect(await call("collab:kick", ROOM, HOST)).toMatchObject({ ok: false, error: "forbidden" });
    expect(
      await call("collab:set-role", "room-ffffffffffffffff", {
        participantId: HOST,
        role: "editor",
      }),
    ).toMatchObject({ ok: false, error: "forbidden" });
    expect(server.seen).toHaveLength(1);
  });

  it("forgets host credentials on a new app process without touching the keychain", async () => {
    register(await createCollabService(userData, server.origin));
    await call("collab:create-room", { name: "Host", projectName: "Robot" });
    expect(await call("collab:kick", ROOM, GUEST)).toEqual({ ok: true, value: null });
    await expect(readFile(path.join(userData, "collab-tokens.json"))).rejects.toThrow();
    register(await createCollabService(userData, server.origin));
    expect(await call("collab:kick", ROOM, GUEST)).toMatchObject({ ok: false, error: "forbidden" });
  });

  it("rejects invalid arguments before any request", async () => {
    register(await createCollabService(userData, server.origin));
    for (const [channel, args] of [
      ["collab:create-room", [{ name: "", projectName: "Robot" }]],
      ["collab:create-room", [{ name: "Host", projectName: "Robot", extra: 1 }]],
      ["collab:join-room", [{ inviteCode: "abcd", name: "Guest" }]],
      ["collab:kick", ["../etc", GUEST]],
      ["collab:kick", [ROOM, "x"]],
      ["collab:set-role", [ROOM, { participantId: GUEST, role: "host" }]],
      ["collab:leave", [42]],
      ["collab:set-preferences", [{ displayName: "\u0007" }]],
    ] as const)
      await expect(call(channel, ...args)).rejects.toThrow();
    expect(server.seen).toHaveLength(0);
    expect(() =>
      handlers.get("collab:server-url")!({ sender: { id: 2 }, senderFrame: {} }),
    ).toThrow("untrusted");
  });

  it("maps service failures to CollabResult errors", async () => {
    register(await createCollabService(userData, server.origin));
    const create = () => call("collab:create-room", { name: "Host", projectName: "Robot" });
    expect(await call("collab:join-room", { inviteCode: "ZZZZ-ZZZZ-ZZZZ", name: "G" })).toEqual({
      ok: false,
      error: "not-found",
      message: "The collaboration service returned 404.",
    });
    server.mode = "error-json";
    expect(await create()).toEqual({ ok: false, error: "rate-limited", message: "slow" });
    server.mode = "html-502";
    expect(await create()).toMatchObject({ ok: false, error: "unavailable" });
    server.mode = "invalid";
    expect(await create()).toMatchObject({ ok: false, error: "unavailable" });
    expect(((await call("collab:preferences")) as { recentRooms: unknown[] }).recentRooms).toEqual(
      [],
    );
  });

  it("reports network failures and timeouts", async () => {
    const preferences = await loadCollabPreferences(userData, () => "me");
    const tokens = new CollabTokenStore();
    server.mode = "hang";
    const slow = new CollabService({
      serverUrl: server.origin,
      preferences,
      tokens,
      fetch: (url, init) => globalThis.fetch(url, init),
      timeoutMs: 50,
    });
    expect(await slow.createRoom({ name: "Host", projectName: "Robot" })).toEqual({
      ok: false,
      error: "network",
      message: "The collaboration service did not respond.",
    });
    await server.stop();
    server = new FakeCollabServer();
    await server.start();
    const offline = new CollabService({
      serverUrl: "http://127.0.0.1:1",
      preferences,
      tokens,
      fetch: (url, init) => globalThis.fetch(url, init),
    });
    expect(await offline.joinRoom({ inviteCode: INVITE, name: "Guest" })).toMatchObject({
      ok: false,
      error: "network",
    });
  });
});

it("passes passwords over IPC/HTTP without persisting them in recent rooms", async () => {
  register(await createCollabService(userData, server.origin));
  const password = " Private room password ";
  await call("collab:create-room", { name: "Host", projectName: "Robot", password });
  await call("collab:join-room", { name: "Guest", inviteCode: INVITE, password });
  expect(server.seen.map((request) => request.body)).toEqual([
    { name: "Host", projectName: "Robot", password },
    { name: "Guest", inviteCode: INVITE, password },
  ]);
  const persisted = await readFile(path.join(userData, "collab-preferences.json"), "utf8");
  expect(persisted).not.toContain(password);
  expect(persisted).not.toContain("password");
  await expect(readFile(path.join(userData, "collab-tokens.json"))).rejects.toThrow();
});
