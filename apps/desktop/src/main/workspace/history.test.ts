import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HISTORY_LIMITS, LocalHistory, type HistoryPolicy } from "./history.js";

describe("bounded local history", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "kobrixa-history-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("survives restart, deduplicates latest content, and isolates roots and paths", async () => {
    const history = new LocalHistory(() => directory);
    await history.append("/project-a", "main.bp", "first", "save");
    await history.append("/project-a", "main.bp", "first", "external");
    await history.append("/project-a", "main.bp", "second", "save");
    const restarted = new LocalHistory(() => directory);
    const entries = await restarted.list("/project-a", "main.bp");
    expect(entries).toHaveLength(2);
    expect(await restarted.content("/project-a", "main.bp", entries[1]!.id)).toBe("first");
    await expect(restarted.content("/project-b", "main.bp", entries[1]!.id)).rejects.toThrow(
      "no longer available",
    );
    await expect(restarted.content("/project-a", "other.bp", entries[1]!.id)).rejects.toThrow(
      "no longer available",
    );
    await expect(restarted.content("/project-a", "main.bp", "../../secret")).rejects.toThrow(
      "Invalid",
    );
  });

  it("caps versions, expires old content, and refreshes an expired duplicate", async () => {
    let now = 1000;
    const history = new LocalHistory(
      () => directory,
      { ...HISTORY_LIMITS, versions: 2, ageMs: 100 },
      () => now,
    );
    for (const content of ["one", "two", "three"]) {
      await history.append("root", "main.bp", content, "save");
      now += 1;
    }
    expect((await history.list("root", "main.bp")).map((entry) => entry.size)).toEqual([5, 3]);
    now += 1000;
    await history.append("root", "main.bp", "three", "save");
    const entries = await history.list("root", "main.bp");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.timestamp).toBe(now);
    now += 1000;
    expect(await history.list("root", "main.bp")).toEqual([]);
  });

  it("bounds bytes across files and skips oversized snapshots", async () => {
    const history = new LocalHistory(() => directory, {
      ...HISTORY_LIMITS,
      snapshotBytes: 5,
      workspaceBytes: 8,
    });
    await history.append("root", "a.bp", "12345", "save");
    await history.append("root", "b.bp", "abcde", "save");
    const all = [...(await history.list("root", "a.bp")), ...(await history.list("root", "b.bp"))];
    expect(all.reduce((sum, entry) => sum + entry.size, 0)).toBeLessThanOrEqual(8);
    await history.append("root", "big.bp", "123456", "save");
    expect(await history.list("root", "big.bp")).toEqual([]);
  });

  it("retains snapshots when a file is renamed and rejects damaged content", async () => {
    const history = new LocalHistory(() => directory);
    await history.append("root", "before.bp", "hello", "save");
    const id = (await history.list("root", "before.bp"))[0]!.id;
    await history.move("root", "before.bp", "after.bp");
    expect(await history.list("root", "before.bp")).toEqual([]);
    expect(await history.content("root", "after.bp", id)).toBe("hello");
    const snapshot = (await readdir(directory, { recursive: true })).find((name) =>
      name.endsWith(".txt"),
    )!;
    await writeFile(path.join(directory, snapshot), "xxxxx");
    await expect(history.content("root", "after.bp", id)).rejects.toThrow("damaged");
    await history.append("root", "after.bp", "hello", "save");
    const latest = (await history.list("root", "after.bp"))[0]!;
    expect(latest.id).not.toBe(id);
    expect(await history.content("root", "after.bp", latest.id)).toBe("hello");
    expect(await readFile(path.join(directory, snapshot), "utf8")).toBe("xxxxx");
  });

  it("awaits policy before capturing and keeps existing snapshots readable when disabled", async () => {
    let policy: HistoryPolicy = { ...HISTORY_LIMITS, enabled: false };
    const history = new LocalHistory(
      () => directory,
      async () => policy,
    );
    await history.append("root", "main.bp", "disabled at startup", "save");
    expect(await readdir(directory)).toEqual([]);
    policy = { ...policy, enabled: true };
    await history.append("root", "main.bp", "enabled", "save");
    const entries = await history.list("root", "main.bp");
    policy = { ...policy, enabled: false };
    await history.append("root", "main.bp", "disabled again", "save");
    expect(await history.list("root", "main.bp")).toEqual(entries);
    expect(await history.content("root", "main.bp", entries[0]!.id)).toBe("enabled");
  });

  it("applies lower retention limits while snapshot size only controls new captures", async () => {
    let now = 1000;
    let policy: HistoryPolicy = { ...HISTORY_LIMITS, enabled: true };
    const history = new LocalHistory(
      () => directory,
      async () => policy,
      () => now,
    );
    for (const content of ["one", "two", "three"]) {
      await history.append("root", "main.bp", content, "save");
      now += 1;
    }
    const original = await history.list("root", "main.bp");
    policy = { ...policy, versions: 2 };
    await expect(history.content("root", "main.bp", original[2]!.id)).rejects.toThrow(
      "no longer available",
    );
    expect(await history.list("root", "main.bp")).toHaveLength(2);
    policy = { ...policy, snapshotBytes: 3 };
    await history.append("root", "main.bp", "oversized", "save");
    const remaining = await history.list("root", "main.bp");
    expect(remaining).toHaveLength(2);
    expect(await history.content("root", "main.bp", remaining[0]!.id)).toBe("three");
    now += 100;
    policy = { ...policy, ageMs: 50 };
    expect(await history.list("root", "main.bp")).toEqual([]);
  });

  it("applies a lower workspace budget across paths even when recording is disabled", async () => {
    let policy: HistoryPolicy = { ...HISTORY_LIMITS, enabled: true };
    const history = new LocalHistory(
      () => directory,
      async () => policy,
    );
    await history.append("root", "a.bp", "aaaaa", "save");
    await history.append("root", "b.bp", "bbbbb", "save");
    policy = { ...policy, enabled: false, workspaceBytes: 5 };
    expect(await history.list("root", "a.bp")).toEqual([]);
    const latest = await history.list("root", "b.bp");
    expect(latest).toHaveLength(1);
    expect(await history.content("root", "b.bp", latest[0]!.id)).toBe("bbbbb");
  });
});
