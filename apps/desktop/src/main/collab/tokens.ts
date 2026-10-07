import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { participantIdSchema, roleSchema, roomIdSchema, type Role } from "@kobrixa/collab-protocol";
import { z } from "zod";

export const COLLAB_TOKENS_FILE = "collab-tokens.json";

/** Subset of Electron's `safeStorage`. */
export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface StoredRoomToken {
  token: string;
  participantId: string;
  role: Role;
  expiresAt: number;
}

const persistedSchema = z.record(
  roomIdSchema,
  z
    .object({
      token: z.string().min(1).max(16384),
      participantId: participantIdSchema,
      role: roleSchema,
      expiresAt: z.number().int(),
    })
    .strict(),
);

/**
 * Room tokens are bearer credentials. They are persisted only when the OS
 * keychain (`safeStorage`) can encrypt them; otherwise they live in memory and
 * are lost on restart. Nothing here is ever sent to the renderer except as part
 * of the `CollabConnection` returned by create/join.
 */
export class CollabTokenStore {
  private tokens = new Map<string, StoredRoomToken>();
  private loaded: Promise<void> | undefined;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string | undefined,
    private readonly codec: SecretCodec | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private encryption(): boolean {
    try {
      return this.codec?.isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  private file(): string | undefined {
    return this.directory === undefined ? undefined : path.join(this.directory, COLLAB_TOKENS_FILE);
  }

  /** Lazy so the keychain is only touched once collaboration is actually used. */
  private load(): Promise<void> {
    this.loaded ??= this.read();
    return this.loaded;
  }

  private async read(): Promise<void> {
    const file = this.file();
    if (!file || !this.codec || !this.encryption()) return;
    try {
      const parsed = persistedSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
      if (!parsed.success) return;
      for (const [roomId, entry] of Object.entries(parsed.data)) {
        if (entry.expiresAt <= this.now() || this.tokens.has(roomId)) continue;
        try {
          const token = this.codec.decryptString(Buffer.from(entry.token, "base64"));
          if (token) this.tokens.set(roomId, { ...entry, token });
        } catch {
          /* Encrypted under another keychain or damaged: drop it. */
        }
      }
    } catch {
      /* No stored tokens yet. */
    }
  }

  private persist(): Promise<void> {
    const file = this.file();
    if (!file || !this.codec || !this.encryption()) return Promise.resolve();
    const codec = this.codec;
    const snapshot = [...this.tokens.entries()];
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const data: Record<string, StoredRoomToken> = {};
        for (const [roomId, entry] of snapshot)
          data[roomId] = { ...entry, token: codec.encryptString(entry.token).toString("base64") };
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, JSON.stringify(data), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      });
    this.writes = write;
    return write;
  }

  async get(roomId: string): Promise<StoredRoomToken | undefined> {
    await this.load();
    const entry = this.tokens.get(roomId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      await this.delete(roomId);
      return undefined;
    }
    return { ...entry };
  }

  async set(roomId: string, entry: StoredRoomToken): Promise<void> {
    await this.load();
    this.tokens.set(roomId, { ...entry });
    for (const [id, item] of this.tokens) if (item.expiresAt <= this.now()) this.tokens.delete(id);
    // A failed disk write keeps the token usable for this session.
    await this.persist().catch(() => undefined);
  }

  async delete(roomId: string): Promise<void> {
    await this.load();
    if (!this.tokens.delete(roomId)) return;
    await this.persist().catch(() => undefined);
  }
}
