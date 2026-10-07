import { rm } from "node:fs/promises";
import path from "node:path";
import type { Role } from "@kobrixa/collab-protocol";

export const COLLAB_TOKENS_FILE = "collab-tokens.json";

export interface StoredRoomToken {
  token: string;
  participantId: string;
  role: Role;
  expiresAt: number;
}

/** Remove older encrypted caches without reading them or accessing the OS keychain. */
export async function removeLegacyTokenFiles(directory: string): Promise<void> {
  await Promise.all(
    [COLLAB_TOKENS_FILE, `${COLLAB_TOKENS_FILE}.tmp`].map((name) =>
      rm(path.join(directory, name), { force: true }).catch(() => undefined),
    ),
  );
}

/** Room credentials exist only for this app process and are never persisted. */
export class CollabTokenStore {
  private readonly tokens = new Map<string, StoredRoomToken>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(roomId: string): Promise<StoredRoomToken | undefined> {
    const entry = this.tokens.get(roomId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.tokens.delete(roomId);
      return undefined;
    }
    return { ...entry };
  }

  async set(roomId: string, entry: StoredRoomToken): Promise<void> {
    this.tokens.set(roomId, { ...entry });
    for (const [id, item] of this.tokens) if (item.expiresAt <= this.now()) this.tokens.delete(id);
  }

  async delete(roomId: string): Promise<void> {
    this.tokens.delete(roomId);
  }
}
