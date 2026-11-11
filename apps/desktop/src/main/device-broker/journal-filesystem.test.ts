import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createJournalFilesystem, writeAll } from "./journal-filesystem.js";
import { createJournal, journalDocument } from "./journal.js";
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
