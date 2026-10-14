import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { filePluginStateStore } from "./state-store.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-plugin-state-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

it("round-trips the disabled set atomically", async () => {
  const store = filePluginStateStore(root);
  expect(await store.load()).toEqual(new Set());
  await store.save(new Set(["b.x", "a.x"]));
  expect(JSON.parse(await readFile(path.join(root, "plugins/state.json"), "utf8"))).toEqual({
    schemaVersion: 1,
    disabled: ["a.x", "b.x"],
  });
  expect(await store.load()).toEqual(new Set(["a.x", "b.x"]));
});

it("treats an unreadable or invalid file as empty", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(path.join(root, "plugins/state.json"), "{broken");
  expect(await filePluginStateStore(root).load()).toEqual(new Set());
});
