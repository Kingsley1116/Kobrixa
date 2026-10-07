import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollabTokenStore, type SecretCodec } from "./tokens.js";

const roomId = "room-000000000001";
const entry = {
  token: "secret-token",
  participantId: "participant-1",
  role: "host" as const,
  expiresAt: 10_000,
};

/** Reversible stand-in for the OS keychain. */
const codec = (available = true): SecretCodec => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(`enc:${[...text].reverse().join("")}`),
  decryptString: (buffer) => {
    const text = buffer.toString();
    if (!text.startsWith("enc:")) throw new Error("bad ciphertext");
    return [...text.slice(4)].reverse().join("");
  },
});

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("collab token store", () => {
  it("persists tokens only in encrypted form and reloads them", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-tokens-"));
    const store = new CollabTokenStore(directory, codec(), () => 1);
    await store.set(roomId, entry);
    const raw = await readFile(path.join(directory, "collab-tokens.json"), "utf8");
    expect(raw).not.toContain("secret-token");
    expect(await new CollabTokenStore(directory, codec(), () => 1).get(roomId)).toEqual(entry);

    await store.delete(roomId);
    expect(await new CollabTokenStore(directory, codec(), () => 1).get(roomId)).toBeUndefined();
  });

  it("keeps tokens in memory only without OS encryption", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-tokens-"));
    const store = new CollabTokenStore(directory, codec(false), () => 1);
    await store.set(roomId, entry);
    expect(await store.get(roomId)).toEqual(entry);
    await expect(readFile(path.join(directory, "collab-tokens.json"))).rejects.toThrow();
    expect(await new CollabTokenStore(directory, codec(false), () => 1).get(roomId)).toBe(
      undefined,
    );
  });

  it("drops expired tokens", async () => {
    let now = 1;
    const store = new CollabTokenStore(undefined, undefined, () => now);
    await store.set(roomId, entry);
    expect(await store.get(roomId)).toBeDefined();
    now = entry.expiresAt;
    expect(await store.get(roomId)).toBeUndefined();
  });
});
