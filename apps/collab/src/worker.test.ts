/**
 * Integration test: bundles the Worker with a stub `CollabRoom` (the real Durable
 * Object is developed separately) and drives it through Miniflare/workerd.
 */
import {
  CLOSE_CODE,
  COLLAB_LIMITS,
  createRoomResponseSchema,
  joinResponseSchema,
} from "@kobrixa/collab-protocol";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveRoomId, signToken, verifyToken } from "./tokens.js";

const SECRET = "integration-test-secret";
const ORIGIN = "https://app.kobrixa.test";
const BASE = "https://collab.test";

/** In-memory stand-in for unit 1's Durable Object, implementing the internal interface. */
const STUB_ROOM = `
import { DurableObject } from "cloudflare:workers";
export class CollabRoom extends DurableObject {
  room = null;
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ws") {
      if (!this.room) return new Response(null, { status: 404 });
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({
        participant: request.headers.get("X-Collab-Participant"),
        role: request.headers.get("X-Collab-Role"),
        name: request.headers.get("X-Collab-Name"),
        url: request.url,
      }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const body = await request.json();
    if (path === "/init") {
      if (this.room) return Response.json({ error: "exists" }, { status: 409 });
      this.room = { ...body, participants: new Map([[body.host.participantId, "host"]]) };
      return Response.json({});
    }
    if (!this.room) return Response.json({ error: "not-found" }, { status: 404 });
    if (path === "/join") {
      if (this.room.password && !body.password) return Response.json({ error: "password-required" }, { status: 401 });
      if (this.room.password && body.password !== this.room.password) return Response.json({ error: "invalid-password" }, { status: 401 });
      if (body.name === "PasswordLimited") return Response.json({ error: "rate-limited" }, { status: 429, headers: { "Retry-After": "60" } });
      if (body.name === "Full") return Response.json({ error: "room-full" }, { status: 409 });
      const role = body.name === "Viewer" ? "viewer" : "editor";
      this.room.participants.set(body.participantId, role);
      return Response.json({ role, projectName: this.room.projectName });
    }
    if (this.room.participants.get(request.headers.get("X-Collab-Participant")) !== "host")
      return Response.json({ error: "forbidden" }, { status: 403 });
    if (!this.room.participants.has(body.participantId))
      return Response.json({ error: "not-found" }, { status: 404 });
    if (path === "/kick") this.room.participants.delete(body.participantId);
    if (path === "/role") this.room.participants.set(body.participantId, body.role);
    return Response.json({});
  }
}
`;

async function bundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("index.ts", import.meta.url))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    alias: {
      "@kobrixa/collab-protocol": fileURLToPath(
        new URL("../../../packages/collab-protocol/src/index.ts", import.meta.url),
      ),
    },
    plugins: [
      {
        name: "stub-room",
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /^\.\/room\.js$/ }, () => ({
            path: "room",
            namespace: "stub",
          }));
          pluginBuild.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
            contents: STUB_ROOM,
            loader: "js",
          }));
        },
      },
    ],
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("no bundle output");
  return output.text;
}

function workerOptions(script: string, bindings: Record<string, string>) {
  return convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-09-06",
    durableObjects: { ROOMS: "CollabRoom" },
    bindings,
  });
}

let mf: Miniflare;
let unconfigured: Miniflare;
let ipCounter = 0;
const nextIp = () => `198.51.100.${++ipCounter}`;

beforeAll(async () => {
  const script = await bundle();
  mf = new Miniflare(
    workerOptions(script, {
      COLLAB_SECRET: SECRET,
      ALLOWED_ORIGINS: `${ORIGIN}, https://other.test`,
    }),
  );
  unconfigured = new Miniflare(workerOptions(script, { ALLOWED_ORIGINS: "" }));
  await Promise.all([mf.ready, unconfigured.ready]);
}, 60_000);

afterAll(async () => {
  await Promise.all([mf?.dispose(), unconfigured?.dispose()]);
});

interface Options {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  ip?: string;
}

async function call(path: string, { method = "POST", body, headers = {}, ip }: Options = {}) {
  const init: Record<string, unknown> = {
    method,
    headers: {
      "CF-Connecting-IP": ip ?? nextIp(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
  };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const res = await mf.dispatchFetch(`${BASE}${path}`, init);
  const text = await res.text();
  return { res, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function createRoom(name = "Host") {
  const { res, json } = await call("/rooms", { body: { name, projectName: "Robot" } });
  expect(res.status).toBe(201);
  return createRoomResponseSchema.parse(json);
}

async function joinRoom(inviteCode: string, name = "Guest") {
  const { res, json } = await call("/rooms/join", { body: { inviteCode, name } });
  expect(res.status).toBe(200);
  return joinResponseSchema.parse(json);
}

/** Opens a socket that the Worker is expected to accept and immediately close. */
async function rejectedSocket(roomId: string, token: string) {
  const res = await mf.dispatchFetch(
    `${BASE}/rooms/${roomId}/ws?token=${encodeURIComponent(token)}`,
    { headers: { Upgrade: "websocket" } },
  );
  expect(res.status).toBe(101);
  const socket = res.webSocket;
  if (!socket) throw new Error("no websocket");
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) =>
      resolve({ code: event.code, reason: event.reason }),
    ),
  );
  socket.accept();
  return closed;
}

describe("collab worker", () => {
  it("reports health with security headers", async () => {
    const { res, json } = await call("/health", { method: "GET" });
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("creates a room, joins it by invite code and issues valid tokens", async () => {
    const room = await createRoom();
    expect(room.roomId).toBe(await deriveRoomId(SECRET, room.inviteCode));
    const host = await verifyToken(SECRET, room.hostToken);
    expect(host.ok && host.payload).toMatchObject({
      v: 1,
      roomId: room.roomId,
      participantId: room.participantId,
      role: "host",
      name: "Host",
      exp: room.expiresAt,
    });
    expect(room.expiresAt - Date.now()).toBeGreaterThan(COLLAB_LIMITS.tokenTtlMs - 60_000);

    const guest = await joinRoom(room.inviteCode);
    expect(guest).toMatchObject({ roomId: room.roomId, role: "editor", projectName: "Robot" });
    expect(guest.participantId).not.toBe(room.participantId);
    const verified = await verifyToken(SECRET, guest.token);
    expect(verified.ok && verified.payload).toMatchObject({
      roomId: room.roomId,
      participantId: guest.participantId,
      role: "editor",
      name: "Guest",
    });
    expect((await joinRoom(room.inviteCode, "Viewer")).role).toBe("viewer");
  });

  it("maps join failures", async () => {
    const missing = await call("/rooms/join", {
      body: { inviteCode: "AAAA-BBBB-CCCC", name: "X" },
    });
    expect(missing.res.status).toBe(404);
    expect(missing.json).toMatchObject({ error: "not-found" });
    const room = await createRoom();
    const full = await call("/rooms/join", { body: { inviteCode: room.inviteCode, name: "Full" } });
    expect(full.res.status).toBe(409);
    expect(full.json).toMatchObject({ error: "room-full" });
  });

  it("validates request bodies", async () => {
    for (const body of [
      { name: "Host" },
      { name: "", projectName: "P" },
      { name: "Host", projectName: "P", extra: 1 },
      "not json",
    ]) {
      const { res, json } = await call("/rooms", { body });
      expect(res.status).toBe(400);
      expect(json).toMatchObject({ error: "bad-request" });
    }
    const big = await call("/rooms", {
      body: { name: "Host", projectName: "x".repeat(20_000) },
    });
    expect(big.res.status).toBe(413);
    const badCode = await call("/rooms/join", {
      body: { inviteCode: "ABCD-EFGH-IJK0", name: "G" },
    });
    expect(badCode.res.status).toBe(400);
    expect((await call("/rooms", { method: "GET" })).res.status).toBe(405);
    expect((await call("/nope", { method: "GET" })).res.status).toBe(404);
  });

  it("lets only the host kick or change roles", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.inviteCode);
    const other = await joinRoom(room.inviteCode, "Other");
    const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

    const asGuest = await call(`/rooms/${room.roomId}/kick`, {
      headers: auth(guest.token),
      body: { participantId: other.participantId },
    });
    expect(asGuest.res.status).toBe(403);
    expect(asGuest.json).toMatchObject({ error: "forbidden" });

    const noAuth = await call(`/rooms/${room.roomId}/kick`, {
      body: { participantId: other.participantId },
    });
    expect(noAuth.res.status).toBe(401);

    const otherRoom = await createRoom();
    const wrongRoom = await call(`/rooms/${otherRoom.roomId}/kick`, {
      headers: auth(room.hostToken),
      body: { participantId: other.participantId },
    });
    expect(wrongRoom.res.status).toBe(403);

    const role = await call(`/rooms/${room.roomId}/role`, {
      headers: auth(room.hostToken),
      body: { participantId: guest.participantId, role: "viewer" },
    });
    expect(role.res.status).toBe(200);
    const badRole = await call(`/rooms/${room.roomId}/role`, {
      headers: auth(room.hostToken),
      body: { participantId: guest.participantId, role: "host" },
    });
    expect(badRole.res.status).toBe(400);

    const kick = await call(`/rooms/${room.roomId}/kick`, {
      headers: auth(room.hostToken),
      body: { participantId: other.participantId },
    });
    expect(kick.res.status).toBe(200);
    const again = await call(`/rooms/${room.roomId}/kick`, {
      headers: auth(room.hostToken),
      body: { participantId: other.participantId },
    });
    expect(again.res.status).toBe(404);
    expect(again.json).toMatchObject({ error: "not-found" });
  });

  it("rejects tampered and expired tokens", async () => {
    const room = await createRoom();
    const [payload, signature] = room.hostToken.split(".") as [string, string];
    const flipped = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    const claims = {
      roomId: room.roomId,
      participantId: room.participantId,
      role: "host" as const,
      name: "Host",
    };
    const expired = await signToken(SECRET, claims, Date.now() - COLLAB_LIMITS.tokenTtlMs - 1);
    const foreign = await signToken("another-secret", claims);
    for (const [token, error] of [
      [`${payload}.${flipped}`, "unauthorized"],
      [foreign.token, "unauthorized"],
      [expired.token, "expired"],
    ] as const) {
      const kick = await call(`/rooms/${room.roomId}/kick`, {
        headers: { Authorization: `Bearer ${token}` },
        body: { participantId: "someone-else" },
      });
      expect(kick.res.status).toBe(401);
      expect(kick.json).toMatchObject({ error });
      expect(await rejectedSocket(room.roomId, token)).toEqual({
        code: CLOSE_CODE.unauthorized,
        reason: "unauthorized",
      });
    }
    expect(await rejectedSocket(room.roomId, "")).toMatchObject({ code: CLOSE_CODE.unauthorized });
    // Non-upgrade requests still get plain HTTP errors.
    const plain = await call(`/rooms/${room.roomId}/kick`, {
      headers: { Authorization: `Bearer ${expired.token}` },
      body: { participantId: "someone-else" },
    });
    expect(plain.res.status).toBe(401);
  });

  it("forwards authorized WebSocket upgrades with the verified identity", async () => {
    const room = await createRoom();
    const guest = await joinRoom(room.inviteCode, "Zoë Ödegaard");
    const res = await mf.dispatchFetch(
      `${BASE}/rooms/${room.roomId}/ws?token=${encodeURIComponent(guest.token)}`,
      { headers: { Upgrade: "websocket", "X-Collab-Role": "host" } },
    );
    expect(res.status).toBe(101);
    const socket = res.webSocket;
    if (!socket) throw new Error("no websocket");
    const message = new Promise<string>((resolve) =>
      socket.addEventListener("message", (event) => resolve(String(event.data))),
    );
    socket.accept();
    const seen = JSON.parse(await message) as Record<string, string>;
    socket.close();
    expect(seen).toEqual({
      participant: guest.participantId,
      role: "editor",
      name: encodeURIComponent("Zoë Ödegaard"),
      url: "https://room/ws",
    });

    const noUpgrade = await call(`/rooms/${room.roomId}/ws?token=${guest.token}`, {
      method: "GET",
    });
    expect(noUpgrade.res.status).toBe(426);
    const otherRoom = await createRoom();
    expect(await rejectedSocket(otherRoom.roomId, guest.token)).toEqual({
      code: CLOSE_CODE.unauthorized,
      reason: "unauthorized",
    });
  });

  it("applies the CORS policy", async () => {
    const noOrigin = await call("/health", { method: "GET" });
    expect(noOrigin.res.headers.get("Access-Control-Allow-Origin")).toBeNull();

    const allowed = await call("/rooms", {
      headers: { Origin: ORIGIN },
      body: { name: "Web", projectName: "P" },
    });
    expect(allowed.res.status).toBe(201);
    expect(allowed.res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(allowed.res.headers.get("Vary")).toContain("Origin");

    const denied = await call("/rooms", {
      headers: { Origin: "https://evil.test" },
      body: { name: "Web", projectName: "P" },
    });
    expect(denied.res.status).toBe(403);
    expect(denied.json).toMatchObject({ error: "forbidden" });

    const preflight = await call("/rooms", {
      method: "OPTIONS",
      headers: {
        Origin: "https://other.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.res.status).toBe(204);
    expect(preflight.res.headers.get("Access-Control-Allow-Origin")).toBe("https://other.test");
    expect(preflight.res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");

    // Renderer sockets carry a file:// or dev-server Origin; the token authenticates them.
    const room = await createRoom();
    const socket = await mf.dispatchFetch(
      `${BASE}/rooms/${room.roomId}/ws?token=${encodeURIComponent(room.hostToken)}`,
      { headers: { Upgrade: "websocket", Origin: "file://" } },
    );
    expect(socket.status).toBe(101);
    socket.webSocket?.accept();
    socket.webSocket?.close();

    const badPreflight = await call("/rooms", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "POST" },
    });
    expect(badPreflight.res.status).toBe(403);
  });

  it("rate limits room creation and joins per client IP", async () => {
    const ip = nextIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const { res } = await call("/rooms", { ip, body: { name: "Host", projectName: "P" } });
      statuses.push(res.status);
      if (res.status === 429) expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Another client is unaffected.
    expect((await call("/rooms", { body: { name: "Host", projectName: "P" } })).res.status).toBe(
      201,
    );

    const joinIp = nextIp();
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (
        await call("/rooms/join", { ip: joinIp, body: { inviteCode: "AAAA-BBBB-CCCC", name: "G" } })
      ).res.status;
    expect(last).toBe(429);
  });

  it("returns 503 when COLLAB_SECRET is unset", async () => {
    const res = await unconfigured.dispatchFetch(`${BASE}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Host", projectName: "P" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "internal" });
    const health = await unconfigured.dispatchFetch(`${BASE}/health`);
    expect(health.status).toBe(200);
    await health.arrayBuffer();
  });
});

it("forwards optional passwords and reports required, invalid and throttled joins", async () => {
  const password = " Password 密碼 ";
  const created = await call("/rooms", {
    body: { name: "Host", projectName: "Protected", password },
  });
  expect(created.res.status).toBe(201);
  const room = createRoomResponseSchema.parse(created.json);
  expect(JSON.stringify(created.json)).not.toContain(password);
  const join = (value?: string, name = "Guest") =>
    call("/rooms/join", {
      body: {
        name,
        inviteCode: room.inviteCode,
        ...(value === undefined ? {} : { password: value }),
      },
    });
  expect((await join()).json).toEqual({ error: "password-required" });
  expect((await join("wrong")).json).toEqual({ error: "invalid-password" });
  const accepted = await join(password);
  expect(accepted.res.status).toBe(200);
  expect(joinResponseSchema.parse(accepted.json).role).toBe("editor");
  expect(JSON.stringify(accepted.json)).not.toContain(password);
  const limited = await join(password, "PasswordLimited");
  expect(limited.res.status).toBe(429);
  expect(limited.res.headers.get("Retry-After")).toBe("60");
});
