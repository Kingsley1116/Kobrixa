import { mkdtemp, rm, writeFile, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadProject, ProjectSourceCache } from "./manifest.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-source-cache-"));
  await writeFile(path.join(root, "main.bp"), "value = 1\n");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("reuses disk text while detecting same-size edits, additions, renames, deletion and overlay removal", async () => {
  const cache = new ProjectSourceCache();
  const load = (overlays = new Map<string, string>()) =>
    loadProject(root, overlays, "main.bp", cache);
  await load();
  expect(cache.readFiles).toHaveLength(1);
  await load();
  expect(cache.readFiles).toEqual([]);
  expect((await load(new Map([["main.bp", "overlay = 2\n"]]))).project?.sources[0]?.content).toBe(
    "overlay = 2\n",
  );
  expect(cache.readFiles).toEqual([]);
  await writeFile(path.join(root, "main.bp"), "value = 3\n");
  expect((await load()).project?.sources[0]?.content).toBe("value = 3\n");
  expect(cache.readFiles).toHaveLength(1);
  await writeFile(path.join(root, "helper.bpm"), "LCD.Clear()\n");
  expect((await load()).project?.sources.map((source) => source.path)).toEqual([
    "helper.bpm",
    "main.bp",
  ]);
  expect(cache.readFiles.map((file) => path.basename(file))).toEqual(["helper.bpm"]);
  await rename(path.join(root, "helper.bpm"), path.join(root, "renamed.bpm"));
  expect((await load()).project?.sources.map((source) => source.path)).toEqual([
    "main.bp",
    "renamed.bpm",
  ]);
  await rm(path.join(root, "renamed.bpm"));
  expect((await load()).project?.sources.map((source) => source.path)).toEqual(["main.bp"]);
  expect(cache.readFiles).toEqual([]);
});

it("still validates canonical paths on every cached load", async () => {
  const cache = new ProjectSourceCache();
  const entry = path.join(root, "main.bp");
  const outside = await mkdtemp(path.join(tmpdir(), "kobrixa-outside-"));
  try {
    await writeFile(path.join(outside, "outside.bp"), "LCD.Clear()\n");
    await loadProject(root, new Map(), "main.bp", cache);
    await rm(entry);
    await symlink(path.join(outside, "outside.bp"), entry);
    const loaded = await loadProject(root, new Map(), "main.bp", cache);
    expect(loaded.project).toBeUndefined();
    expect(loaded.diagnostics[0]?.message).toContain("escapes the project root");
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
