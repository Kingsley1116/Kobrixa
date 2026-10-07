import {
  COLLAB_ROUTES,
  createRoomResponseSchema,
  errorResponseSchema,
  joinResponseSchema,
  kickRequestSchema,
  type CreateRoomRequest,
  type ErrorResponse,
  type JoinRequest,
  type SetRoleRequest,
} from "@kobrixa/collab-protocol";
import type { z } from "zod";
import type {
  CollabConnection,
  CollabErrorCode,
  CollabPreferences,
  CollabResult,
} from "../../shared/collab.js";
import { addRecentRoom, type CollabPreferencesStore } from "./preferences.js";
import type { CollabTokenStore } from "./tokens.js";

export const COLLAB_REQUEST_TIMEOUT_MS = 10_000;

/** `fetch`-compatible function; Electron's `net.fetch` in production. */
export type CollabFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CollabServiceOptions {
  serverUrl: string;
  preferences: CollabPreferencesStore;
  tokens: CollabTokenStore;
  fetch: CollabFetch;
  timeoutMs?: number;
  now?: () => number;
}

const STATUS_ERRORS: Partial<Record<number, ErrorResponse["error"]>> = {
  400: "bad-request",
  401: "unauthorized",
  403: "forbidden",
  404: "not-found",
  409: "room-full",
  410: "expired",
  429: "rate-limited",
};

const failure = (error: CollabErrorCode, message?: string): CollabResult<never> =>
  message === undefined ? { ok: false, error } : { ok: false, error, message };

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Talks to the collaboration service's HTTP API on behalf of the renderer and
 * owns the room tokens. Arguments are expected to be validated by the IPC layer.
 */
export class CollabService {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CollabServiceOptions) {
    this.timeoutMs = options.timeoutMs ?? COLLAB_REQUEST_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  serverUrl(): string {
    return this.options.serverUrl;
  }

  getPreferences(): CollabPreferences {
    return this.options.preferences.get();
  }

  setPreferences(patch: unknown): Promise<CollabPreferences> {
    return this.options.preferences.set(patch);
  }

  async createRoom(request: CreateRoomRequest): Promise<CollabResult<CollabConnection>> {
    const response = await this.post(COLLAB_ROUTES.createRoom, request, createRoomResponseSchema);
    if (!response.ok) return response;
    const room = response.value;
    const connection: CollabConnection = {
      serverUrl: this.options.serverUrl,
      roomId: room.roomId,
      participantId: room.participantId,
      token: room.hostToken,
      role: "host",
      name: request.name,
      projectName: request.projectName,
      inviteCode: room.inviteCode,
      expiresAt: room.expiresAt,
    };
    await this.remember(connection);
    return { ok: true, value: connection };
  }

  async joinRoom(request: JoinRequest): Promise<CollabResult<CollabConnection>> {
    const response = await this.post(COLLAB_ROUTES.join, request, joinResponseSchema);
    if (!response.ok) return response;
    const room = response.value;
    const connection: CollabConnection = {
      serverUrl: this.options.serverUrl,
      roomId: room.roomId,
      participantId: room.participantId,
      token: room.token,
      role: room.role,
      name: request.name,
      projectName: room.projectName,
      inviteCode: request.inviteCode,
      expiresAt: room.expiresAt,
    };
    await this.remember(connection);
    return { ok: true, value: connection };
  }

  kick(roomId: string, participantId: string): Promise<CollabResult<null>> {
    const body = kickRequestSchema.parse({ participantId });
    return this.hostAction(roomId, COLLAB_ROUTES.kick(roomId), body);
  }

  setRole(roomId: string, request: SetRoleRequest): Promise<CollabResult<null>> {
    return this.hostAction(roomId, COLLAB_ROUTES.setRole(roomId), request);
  }

  async leave(roomId: string): Promise<void> {
    await this.options.tokens.delete(roomId);
  }

  private async hostAction(
    roomId: string,
    route: string,
    body: unknown,
  ): Promise<CollabResult<null>> {
    const stored = await this.options.tokens.get(roomId);
    if (!stored || stored.role !== "host")
      return failure("forbidden", "Only the host of this room can do that.");
    const response = await this.post(route, body, undefined, stored.token);
    return response.ok ? { ok: true, value: null } : response;
  }

  private async remember(connection: CollabConnection): Promise<void> {
    await this.options.tokens.set(connection.roomId, {
      token: connection.token,
      participantId: connection.participantId,
      role: connection.role,
      expiresAt: connection.expiresAt,
    });
    const joinedAt = this.now();
    await this.options.preferences
      .update((current) => ({
        ...current,
        recentRooms: addRecentRoom(current.recentRooms, {
          roomId: connection.roomId,
          projectName: connection.projectName.slice(0, 120),
          ...(connection.inviteCode === undefined ? {} : { inviteCode: connection.inviteCode }),
          role: connection.role,
          joinedAt,
        }),
      }))
      // The room is usable even if the recent-room list cannot be saved.
      .catch(() => undefined);
  }

  /** POSTs JSON; with `schema`, the 2xx body must match it, otherwise the body is ignored. */
  private async post<S extends z.ZodType>(
    route: string,
    body: unknown,
    schema: S | undefined,
    token?: string,
  ): Promise<CollabResult<z.output<S>>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.options.fetch(new URL(route, this.options.serverUrl).href, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // Never follow a redirect with the bearer token to another origin.
        redirect: "error",
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      return failure(
        "network",
        controller.signal.aborted ? "The collaboration service did not respond." : describe(error),
      );
    } finally {
      clearTimeout(timer);
    }
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (status < 200 || status > 299) {
      const parsed = errorResponseSchema.safeParse(json);
      const message = parsed.data?.message ?? `The collaboration service returned ${status}.`;
      // Server faults (including proxies' HTML error pages) are reported as one transient state.
      if (status >= 500) return failure("unavailable", message);
      return failure(parsed.data?.error ?? STATUS_ERRORS[status] ?? "unavailable", message);
    }
    if (!schema) return { ok: true, value: undefined as z.output<S> };
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      return failure("unavailable", "The collaboration service sent an unexpected response.");
    return { ok: true, value: parsed.data };
  }
}
