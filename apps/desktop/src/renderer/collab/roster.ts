import { collabPathSchema, roleSchema, type Role } from "@kobrixa/collab-protocol";
import type { CollabParticipant } from "./types.js";

export interface RosterEntry {
  participantId: string;
  name: string;
  role: Role;
  online: boolean;
  /** Presence color from awareness, when the participant has published one. */
  color?: string;
  /** Shared file the participant has open, from awareness (online participants only). */
  file?: string;
  /** Holds EV3 device control (see `DeviceControl`). */
  controlHolder?: true;
  /** Built from awareness alone because no server roster has arrived yet. */
  provisional?: true;
  self: boolean;
}

interface Presence {
  participantId: string;
  name?: string;
  color?: string;
  role?: Role;
  file?: string;
}

function presence(state: unknown): Presence | null {
  if (!state || typeof state !== "object") return null;
  const { participantId, name, color, role, file } = state as Record<string, unknown>;
  if (typeof participantId !== "string" || !participantId) return null;
  return {
    participantId,
    ...(typeof name === "string" && name.trim() ? { name } : {}),
    ...(typeof color === "string" && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}),
    ...(roleSchema.safeParse(role).success ? { role: role as Role } : {}),
    ...(collabPathSchema.safeParse(file).success ? { file: file as string } : {}),
  };
}

const rank = (entry: RosterEntry): number =>
  (entry.self ? 0 : 4) + (entry.role === "host" ? 0 : 2) + (entry.online ? 0 : 1);

/**
 * Combines the server roster (authoritative for name, role and membership) with
 * awareness colors. Before the first roster notice, awareness provides an
 * initial roster. Once a server roster exists, it alone decides membership and
 * online state; delayed awareness cannot resurrect kicked participants.
 * Order: you, the host, then online before offline, otherwise roster order.
 * `controlHolder` marks the participant holding device control.
 */
export function mergeRoster(
  participants: readonly CollabParticipant[],
  awarenessStates: Iterable<unknown>,
  selfId: string,
  controlHolder: string | null = null,
): RosterEntry[] {
  const live = new Map<string, Presence>();
  for (const state of awarenessStates) {
    const entry = presence(state);
    if (entry && !live.has(entry.participantId)) live.set(entry.participantId, entry);
  }
  const entries: RosterEntry[] = participants.map((participant) => {
    const seen = live.get(participant.participantId);
    live.delete(participant.participantId);
    return {
      participantId: participant.participantId,
      name: participant.name,
      role: participant.role,
      online: participant.online,
      ...(seen?.color ? { color: seen.color } : {}),
      ...(seen?.file && participant.online ? { file: seen.file } : {}),
      ...(participant.participantId === controlHolder ? { controlHolder: true as const } : {}),
      self: participant.participantId === selfId,
    };
  });
  for (const seen of participants.length ? [] : live.values()) {
    if (!seen.name || !seen.role) continue;
    entries.push({
      participantId: seen.participantId,
      name: seen.name,
      role: seen.role,
      online: true,
      ...(seen.color ? { color: seen.color } : {}),
      ...(seen.file ? { file: seen.file } : {}),
      ...(seen.participantId === controlHolder ? { controlHolder: true as const } : {}),
      provisional: true,
      self: seen.participantId === selfId,
    });
  }
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
    .map(({ entry }) => entry);
}

/** True until the first server roster arrives (it always lists you). */
export function rosterLoading(entries: readonly RosterEntry[]): boolean {
  return entries.every((entry) => entry.provisional);
}

export function onlineCount(entries: readonly RosterEntry[]): number {
  return entries.filter((entry) => entry.online).length;
}
