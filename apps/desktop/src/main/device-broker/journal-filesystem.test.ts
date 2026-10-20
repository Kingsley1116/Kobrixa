import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createJournalFilesystem, writeAll } from "./journal-filesystem.js";
it("F10 loops on short writes and rejects zero progress", async () => {
  const output: number[] = [];
  await writeAll(new Uint8Array([1, 2, 3]), async (bytes, offset) => { output.push(bytes[offset]!); return 1; });
  expect(output).toEqual([1, 2, 3]);
  await expect(writeAll(new Uint8Array([1]), async () => 0)).rejects.toThrow();
});
it("F10 uses exclusive same-directory temporary files and refuses symlink evidence", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-"));
  try {
    const root = await realpath(temp);
    const fs = createJournalFilesystem(root); await fs.initialize();
    await fs.write("faults.next-00000000-0000-4000-8000-000000000001.json", Buffer.from("pending"));
    await fs.sync("faults.next-00000000-0000-4000-8000-000000000001.json");
    await fs.replace("faults.next-00000000-0000-4000-8000-000000000001.json", "faults.json");
    await fs.syncDirectory();
    expect(await readFile(path.join(root, "device-broker/faults.json"), "utf8")).toBe("pending");
    await writeFile(path.join(root, "outside"), "keep");
    await symlink(path.join(root, "outside"), path.join(root, "device-broker/faults.previous.json"));
    await expect(fs.read("faults.previous.json")).rejects.toThrow();
    expect(await readFile(path.join(root, "outside"), "utf8")).toBe("keep");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
it("F10 rejects a non-canonical symlinked root", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "journal-"));
  try {
    const root = await realpath(temp);
    const fs = createJournalFilesystem(root); await fs.initialize();
    const linkedRoot = path.join(root, "linked-root");
    await symlink(root, linkedRoot, "dir");
    expect(await realpath(linkedRoot)).toBe(root);
    await expect(createJournalFilesystem(linkedRoot).initialize()).rejects.toThrow("journal directory");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
