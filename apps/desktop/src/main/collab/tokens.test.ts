import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CollabTokenStore, removeLegacyTokenFiles } from "./tokens.js";

const roomId = "room-000000000001";
const entry = {
  token: "secret-token",
  participantId: "participant-1",
  role: "host" as const,
  expiresAt: 10_000,
};

describe("collab token store", () => {
  it("keeps credentials for this process only and forgets them on leave", async () => {
    const store = new CollabTokenStore(() => 1);
    await store.set(roomId, entry);
    expect(await store.get(roomId)).toEqual(entry);
    expect(await new CollabTokenStore(() => 1).get(roomId)).toBeUndefined();
    const copy = (await store.get(roomId))!;
    copy.role = "editor";
    expect((await store.get(roomId))?.role).toBe("host");
    await store.delete(roomId);
    expect(await store.get(roomId)).toBeUndefined();
  });

  it("removes old encrypted cache files without loading them or touching preferences", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-collab-tokens-"));
    try {
      await writeFile(path.join(directory, "collab-tokens.json"), "old encrypted content");
      await writeFile(path.join(directory, "collab-tokens.json.tmp"), "interrupted old write");
      await writeFile(path.join(directory, "collab-preferences.json"), "preferences");
      await removeLegacyTokenFiles(directory);
      await removeLegacyTokenFiles(directory);
      expect(await readdir(directory)).toEqual(["collab-preferences.json"]);
      expect(await readFile(path.join(directory, "collab-preferences.json"), "utf8")).toBe(
        "preferences",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("drops expired tokens", async () => {
    let now = 1;
    const store = new CollabTokenStore(() => now);
    await store.set(roomId, entry);
    expect(await store.get(roomId)).toBeDefined();
    now = entry.expiresAt;
    expect(await store.get(roomId)).toBeUndefined();
  });
});
