import {
  CLOSE_CODE,
  COLLAB_ROUTES,
  createRoomRequestSchema,
  joinRequestSchema,
  kickRequestSchema,
  roleSchema,
  roomIdSchema,
  setRoleRequestSchema,
} from "@kobrixa/collab-protocol";
import type {
  CreateRoomResponse,
  JoinResponse,
  Role,
  TokenPayload,
} from "@kobrixa/collab-protocol";
import { z } from "zod";
import type { CollabEnv } from "./env.js";
import {
  HttpError,
  RateLimiter,
  allowedOrigins,
  checkOrigin,
  errorResponse,
  finalizeResponse,
  preflightResponse,
  readJson,
} from "./http.js";
import { generateInviteCode } from "./invite.js";
import { base64urlEncode, deriveRoomId, hmac, randomId, signToken, verifyToken } from "./tokens.js";

export { CollabRoom } from "./room.js";

export interface HandlerOptions {
  now?: () => number;
  createLimiter?: RateLimiter;
  joinLimiter?: RateLimiter;
}

// Per-isolate limits; see RateLimiter for why these are best-effort only.
const defaultCreateLimiter = new RateLimiter(10, 60_000);
const defaultJoinLimiter = new RateLimiter(30, 60_000);

const joinDoResponseSchema = z.object({ role: roleSchema, projectName: z.string() });
const INIT_ATTEMPTS = 3;

/** `/rooms/:roomId/<action>` for the room-scoped routes. */
const ROOM_ROUTE = /^\/rooms\/([^/]+)\/(kick|role|ws)$/;

type Room = DurableObjectStub;

function roomStub(env: CollabEnv, roomId: string): Room {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId)) as unknown as Room;
}

function callRoom(
  room: Room,
  path: string,
  body: unknown,
  participantId?: string,
): Promise<Response> {
  return room.fetch(`https://room${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(participantId ? { "X-Collab-Participant": participantId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function requireSecret(env: CollabEnv): string {
  const secret = env.COLLAB_SECRET;
  if (!secret) throw new HttpError(503, "internal", "Server is not configured");
  return secret;
}

function rateLimit(limiter: RateLimiter, request: Request, now: number): void {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!limiter.take(key, now))
    throw new HttpError(429, "rate-limited", "Too many requests", {
      "Retry-After": String(limiter.retryAfter(key, now)),
    });
}

async function authorize(
  secret: string,
  token: string | null,
  roomId: string,
  now: number,
): Promise<TokenPayload> {
  if (!token) throw new HttpError(401, "unauthorized", "Missing token");
  const result = await verifyToken(secret, token, now);
  if (!result.ok)
    throw result.reason === "expired"
      ? new HttpError(401, "expired", "Token expired")
      : new HttpError(401, "unauthorized", "Invalid token");
  if (result.payload.roomId !== roomId) throw new HttpError(403, "forbidden", "Wrong room");
  return result.payload;
}

function bearer(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  return match?.[1] ?? null;
}

async function unexpectedRoomResponse(response: Response, path: string): Promise<never> {
  console.error(JSON.stringify({ event: "collab_room_error", path, status: response.status }));
  await response.body?.cancel();
  throw new HttpError(500, "internal");
}

async function createRoom(
  request: Request,
  env: CollabEnv,
  secret: string,
  now: number,
): Promise<Response> {
  const { name, projectName, password } = await readJson(request, createRoomRequestSchema);
  const participantId = randomId(16);
  // A 409 means the derived room already exists (an invite-code collision); retry.
  for (let attempt = 0; attempt < INIT_ATTEMPTS; attempt++) {
    const inviteCode = generateInviteCode();
    const roomId = await deriveRoomId(secret, inviteCode);
    const response = await callRoom(roomStub(env, roomId), "/init", {
      roomId,
      projectName,
      inviteCode,
      host: { participantId, name },
      password,
    });
    if (response.status === 409) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) return unexpectedRoomResponse(response, "/init");
    await response.body?.cancel();
    const { token, payload } = await signToken(
      secret,
      { roomId, participantId, role: "host", name },
      now,
    );
    const body: CreateRoomResponse = {
      roomId,
      inviteCode,
      participantId,
      hostToken: token,
      expiresAt: payload.exp,
    };
    return Response.json(body, { status: 201 });
  }
  throw new HttpError(500, "internal", "Could not allocate a room");
}

async function joinRoom(
  request: Request,
  env: CollabEnv,
  secret: string,
  now: number,
): Promise<Response> {
  const { inviteCode, name, password } = await readJson(request, joinRequestSchema);
  const roomId = await deriveRoomId(secret, inviteCode);
  const participantId = randomId(16);
  const clientKey = base64urlEncode(
    await hmac(secret, `join-client:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`),
  );
  const response = await callRoom(roomStub(env, roomId), "/join", {
    participantId,
    name,
    password,
    clientKey,
  });
  if (response.status === 401) {
    const body = (await response.json()) as { error?: string };
    if (body.error === "password-required" || body.error === "invalid-password")
      throw new HttpError(401, body.error);
    throw new HttpError(401, "unauthorized");
  }
  if (response.status === 429) {
    await response.body?.cancel();
    throw new HttpError(429, "rate-limited", "Too many attempts", { "Retry-After": "60" });
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new HttpError(404, "not-found", "Room not found");
  }
  if (response.status === 409) {
    await response.body?.cancel();
    throw new HttpError(409, "room-full", "Room is full");
  }
  if (!response.ok) return unexpectedRoomResponse(response, "/join");
  const parsed = joinDoResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new HttpError(500, "internal");
  const { role, projectName } = parsed.data;
  const { token, payload } = await signToken(secret, { roomId, participantId, role, name }, now);
  const body: JoinResponse = {
    roomId,
    participantId,
    token,
    role,
    projectName,
    expiresAt: payload.exp,
  };
  return Response.json(body);
}

async function hostAction(
  request: Request,
  env: CollabEnv,
  secret: string,
  roomId: string,
  action: "kick" | "role",
  now: number,
): Promise<Response> {
  const auth = await authorize(secret, bearer(request), roomId, now);
  if (auth.role !== "host") throw new HttpError(403, "forbidden", "Host only");
  const body: { participantId: string; role?: Role } =
    action === "kick"
      ? await readJson(request, kickRequestSchema)
      : await readJson(request, setRoleRequestSchema);
  if (body.participantId === auth.participantId)
    throw new HttpError(400, "bad-request", "The host cannot target itself");
  const response = await callRoom(roomStub(env, roomId), `/${action}`, body, auth.participantId);
  if (response.status === 403) {
    await response.body?.cancel();
    throw new HttpError(403, "forbidden", "Host only");
  }
  if (response.status === 404) {
    await response.body?.cancel();
    throw new HttpError(404, "not-found", "Participant not found");
  }
  if (!response.ok) return unexpectedRoomResponse(response, `/${action}`);
  await response.body?.cancel();
  return Response.json({});
}

/**
 * Browsers only report close code 1006 when an upgrade is answered with an HTTP
 * error, so clients could not tell "bad token" from a network failure and would
 * retry forever. Accept the upgrade instead and close it with a distinct code.
 */
function rejectSocket(): Response {
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
  server.accept();
  server.close(CLOSE_CODE.unauthorized, "unauthorized");
  return new Response(null, { status: 101, webSocket: client });
}

async function connect(
  request: Request,
  env: CollabEnv,
  secret: string,
  roomId: string,
  now: number,
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(426, "bad-request", "Expected a WebSocket upgrade", {
      Upgrade: "websocket",
    });
  let auth: TokenPayload;
  try {
    auth = await authorize(secret, new URL(request.url).searchParams.get("token"), roomId, now);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403))
      return rejectSocket();
    throw error;
  }
  const headers = new Headers(request.headers);
  // The role is the one signed into the token at join time. Tokens outlive role
  // changes and kicks, so the room must treat its own participant record as the
  // authority (current role, revoked participants → 403) and use this header only
  // for participants it has no record of.
  headers.set("X-Collab-Participant", auth.participantId);
  headers.set("X-Collab-Role", auth.role);
  // Header values must be ByteStrings; display names may contain any Unicode.
  headers.set("X-Collab-Name", encodeURIComponent(auth.name));
  // Never pass the token (or anything else from the client URL) on to the room.
  return roomStub(env, roomId).fetch("https://room/ws", { method: "GET", headers });
}

async function route(
  request: Request,
  env: CollabEnv,
  options: HandlerOptions,
  now: number,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (pathname === "/health") {
    if (method !== "GET" && method !== "HEAD") throw methodNotAllowed("GET");
    return Response.json({ ok: true });
  }
  if (pathname === COLLAB_ROUTES.createRoom) {
    if (method !== "POST") throw methodNotAllowed("POST");
    const secret = requireSecret(env);
    rateLimit(options.createLimiter ?? defaultCreateLimiter, request, now);
    return createRoom(request, env, secret, now);
  }
  if (pathname === COLLAB_ROUTES.join) {
    if (method !== "POST") throw methodNotAllowed("POST");
    const secret = requireSecret(env);
    rateLimit(options.joinLimiter ?? defaultJoinLimiter, request, now);
    return joinRoom(request, env, secret, now);
  }
  const match = ROOM_ROUTE.exec(pathname);
  const roomId = match?.[1];
  const action = match?.[2];
  if (roomId === undefined || action === undefined || !roomIdSchema.safeParse(roomId).success)
    throw new HttpError(404, "not-found");
  if (action === "ws") {
    if (method !== "GET") throw methodNotAllowed("GET");
    return connect(request, env, requireSecret(env), roomId, now);
  }
  if (method !== "POST") throw methodNotAllowed("POST");
  return hostAction(request, env, requireSecret(env), roomId, action as "kick" | "role", now);
}

function isSocketUpgrade(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
    /^\/rooms\/[^/]+\/ws$/.test(new URL(request.url).pathname)
  );
}

function methodNotAllowed(allow: string): HttpError {
  return new HttpError(405, "bad-request", "Method not allowed", { Allow: allow });
}

/** Worker entry point, exported separately so tests can inject a fake `ROOMS` namespace. */
export async function handle(
  request: Request,
  env: CollabEnv,
  options: HandlerOptions = {},
): Promise<Response> {
  const now = options.now?.() ?? Date.now();
  let origin: string | null = null;
  let response: Response;
  try {
    // WebSocket upgrades are exempt: the renderer opens them from `file://` or the
    // Vite dev origin, and they authenticate with an explicit `?token=` rather than
    // ambient credentials, so a foreign page cannot hijack a socket without the token.
    if (!isSocketUpgrade(request))
      origin = checkOrigin(request, allowedOrigins(env.ALLOWED_ORIGINS));
    response =
      request.method === "OPTIONS"
        ? preflightResponse(origin)
        : await route(request, env, options, now);
  } catch (error) {
    if (error instanceof HttpError) response = errorResponse(error);
    else {
      console.error(
        JSON.stringify({
          event: "collab_request_failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      response = errorResponse(new HttpError(500, "internal"));
    }
  }
  return finalizeResponse(response, origin);
}

export default {
  fetch(request: Request, env: CollabEnv): Promise<Response> {
    return handle(request, env);
  },
} satisfies ExportedHandler<CollabEnv>;
