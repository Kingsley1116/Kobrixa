import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  participantIdSchema,
  roomIdSchema,
  inviteCodeSchema,
  resumeCredentialSchema,
} from "@kobrixa/collab-protocol";

const identitySchema = z
  .object({
    serverUrl: z.string().url(),
    roomId: roomIdSchema,
    participantId: participantIdSchema,
    credential: resumeCredentialSchema,
    inviteCode: inviteCodeSchema,
    workspaceRoot: z.string().optional(),
    baseline: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type RoomIdentity = z.infer<typeof identitySchema>;

/** Main-process-only recovery credentials. Never sent to the renderer or the OS keychain. */
export class CollabIdentityStore {
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private entries: RoomIdentity[] = [],
    private persist: (entries: RoomIdentity[]) => Promise<void> = async () => {},
    private loadError?: Error,
  ) {}

  assertAvailable(): void {
    if (this.loadError) throw this.loadError;
  }

  get(serverUrl: string, roomId: string): RoomIdentity | undefined {
    this.assertAvailable();
    const entry = this.entries.find(
      (item) => item.serverUrl === serverUrl && item.roomId === roomId,
    );
    return entry ? { ...entry } : undefined;
  }
  byInvite(serverUrl: string, inviteCode: string): RoomIdentity | undefined {
    this.assertAvailable();
    return this.entries.find(
      (item) => item.serverUrl === serverUrl && item.inviteCode === inviteCode,
    );
  }
  set(entry: RoomIdentity): Promise<void> {
    this.assertAvailable();
    const next = identitySchema.parse(entry);
    const write = this.writes
      .catch(() => undefined)
      .then(async () => {
        const entries = [
          ...this.entries.filter(
            (item) => item.serverUrl !== next.serverUrl || item.roomId !== next.roomId,
          ),
          next,
        ];
        await this.persist(entries);
        this.entries = entries;
      });
    this.writes = write;
    return write;
  }
}

export async function loadCollabIdentities(directory: string): Promise<CollabIdentityStore> {
  const file = path.join(directory, "collab-identities.json");
  let entries: RoomIdentity[] = [];
  try {
    entries = z.array(identitySchema).parse(JSON.parse(await readFile(file, "utf8")));
    await chmod(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return new CollabIdentityStore(
        [],
        undefined,
        new Error(
          "Could not read saved room identities. Your saved access has not been replaced.",
          { cause: error },
        ),
      );
  }
  return new CollabIdentityStore(entries, async (next) => {
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.tmp`;
    await writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  });
}
