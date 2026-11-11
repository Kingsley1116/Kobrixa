import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createJournalFilesystem, writeAll } from "./journal-filesystem.js";
import { createJournal, journalDocument } from "./journal.js";
import type { SafetyFaultEntry } from "@kobrixa/plugin-runtime";
afterEach(() => vi.unstubAllGlobals());
it("F10 loops on short writes and rejects zero progress", async () => {
  const output: number[] = [];
  await writeAll(new Uint8Array([1, 2, 3]), async (bytes, offset) => {
    output.push(bytes[offset]!);
    return 1;
  });
  expect(output).toEqual([1, 2, 3]);
  await expect(writeAll(new Uint8Array([1]), async () => 0)).rejects.toThrow();
});
it("F10 uses exclusive same-directory temporary files and refuses symlink evidence", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-"));
  try {
    const root = await realpath(temp);
    // Model the unavailable Windows directory barrier; retain real file operations.
    const fs = createJournalFilesystem(
      root,
      process.platform === "win32" ? async () => {} : undefined,
    );
    await fs.initialize();
    await fs.write("faults.next-00000000-0000-4000-8000-000000000001.json", Buffer.from("pending"));
    await fs.sync("faults.next-00000000-0000-4000-8000-000000000001.json");
    await fs.replace("faults.next-00000000-0000-4000-8000-000000000001.json", "faults.json");
    await fs.syncDirectory();
    expect(await readFile(path.join(root, "device-broker/faults.json"), "utf8")).toBe("pending");
    await writeFile(path.join(root, "outside"), "keep");
    await symlink(
      path.join(root, "outside"),
      path.join(root, "device-broker/faults.previous.json"),
    );
    await expect(fs.read("faults.previous.json")).rejects.toThrow();
    expect(await readFile(path.join(root, "outside"), "utf8")).toBe("keep");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it("F10 rejects a non-canonical symlinked root", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-"));
  try {
    const root = await realpath(temp);
    // Model the unavailable Windows directory barrier; retain real file operations.
    const fs = createJournalFilesystem(
      root,
      process.platform === "win32" ? async () => {} : undefined,
    );
    await fs.initialize();
    const linkedRoot = path.join(root, "linked-root");
    await symlink(root, linkedRoot, "dir");
    expect(await realpath(linkedRoot)).toBe(root);
    await expect(createJournalFilesystem(linkedRoot).initialize()).rejects.toThrow(
      "journal directory",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

it("F10 Windows rejects an unsupported directory barrier and marks the journal unwritable", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-policy-"));
  try {
    const root = await realpath(temp);
    vi.stubGlobal("process", { ...process, platform: "win32" });
    const fs = createJournalFilesystem(root);
    await expect(fs.initialize()).rejects.toMatchObject({ code: "ENOTSUP" });
    await expect(fs.syncDirectory()).rejects.toMatchObject({ code: "ENOTSUP" });
    const journal = createJournal(fs, {
      hostEpoch: "00000000-0000-4000-8000-000000000001",
      assertHeld() {},
    });
    await journal.load();
    expect(journal.snapshot().journalHealth).toBe("unwritable");
    await expect(journal.commit(journalDocument(1, []))).rejects.toThrow("journal write blocked");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it.each(["EIO", "EPERM"])("F10 does not downgrade a %s directory barrier failure", async (code) => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-policy-"));
  try {
    const root = await realpath(temp);
    const fs = createJournalFilesystem(root, async () => {
      throw Object.assign(new Error("directory barrier failed"), { code });
    });
    await expect(fs.initialize()).rejects.toMatchObject({ code });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
it.each(["root", "parent"])(
  "W02b failed %s barrier preserves real on-disk faults and denies mutations",
  async (point) => {
    const temp = await mkdtemp(path.join(tmpdir(), "journal-recovery-"));
    try {
      const root = await realpath(temp);
      const directory = path.join(root, "device-broker");
      await mkdir(directory);
      const id = randomUUID();
      const marker: SafetyFaultEntry = {
        id,
        revision: 1,
        owner: { kind: "core", adapter: "motor", hostEpoch: id, workbenchInstance: id },
        providerId: "kobrixa.device-ev3",
        providerGeneration: 1,
        physical: {
          providerId: "kobrixa.device-ev3",
          family: "ev3",
          basis: "serial",
          digest: "a".repeat(64),
          strength: "stable",
        },
        sessionId: id,
        operationId: id,
        operationClass: "finite-motion",
        createdAt: 1,
        updatedAt: 1,
        state: "pending",
        dispatch: "sent",
        movement: "unknown",
        stopRequested: false,
        stopConfirmation: "pending",
        cause: "none",
        resolution: null,
      };
      const bytes = Buffer.from(JSON.stringify(journalDocument(1, [marker])));
      await writeFile(path.join(directory, "faults.json"), bytes);
      const barriers: string[] = [];
      const fs = createJournalFilesystem(root, async (target) => {
        barriers.push(target);
        if (target === (point === "root" ? directory : root))
          throw Object.assign(new Error("barrier unavailable"), { code: "ENOTSUP" });
      });
      const journal = createJournal(fs, { hostEpoch: id, assertHeld() {} });
      await journal.load();
      expect(barriers).toEqual(point === "root" ? [directory] : [directory, root]);
      expect(journal.snapshot()).toMatchObject({
        journalHealth: "unwritable",
        blockers: [id],
        faults: [{ id, state: "unconfirmed", cause: "host-restarted" }],
      });
      await expect(journal.commit(journalDocument(2, [marker]))).rejects.toThrow(
        "journal write blocked",
      );
      const next = `faults.next-${randomUUID()}.json`;
      await expect(fs.write(next, bytes)).rejects.toThrow("journal not writable");
      await expect(fs.sync("faults.json")).rejects.toThrow("journal not writable");
      await expect(fs.replace("faults.json", "faults.previous.json")).rejects.toThrow(
        "journal not writable",
      );
      await expect(fs.remove("faults.json")).rejects.toThrow("journal not writable");
      expect(await fs.inventory()).toEqual([{ name: "faults.json", bytes: bytes.length }]);
      expect(await readFile(path.join(directory, "faults.json"))).toEqual(bytes);
      // Read-only recovery still applies the ordinary unsafe-evidence checks.
      await symlink(
        path.join(directory, "faults.json"),
        path.join(directory, "faults.previous.json"),
      );
      await expect(fs.inventory()).rejects.toThrow("journal unsafe evidence");
      await expect(fs.read("faults.previous.json")).rejects.toThrow("journal unsafe file");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
