import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { filePluginStateStore } from "./state-store.js";

let root: string;
const file = () => path.join(root, "plugins/state.json");
const stored = async () => JSON.parse(await readFile(file(), "utf8"));
const state = (disabled: string[], legacy: string[] = []) => ({
  disabled: new Set(disabled),
  legacyDisabledIds: new Set(legacy),
});
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kobrixa-plugin-state-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

it("starts empty on first launch and round-trips schema v2", async () => {
  const store = filePluginStateStore(root);
  expect(await store.load()).toEqual(state([]));
  await store.save(state(["dev:bbbbbbbbbbbbbbbb", "dev:aaaaaaaaaaaaaaaa"]));
  expect(await stored()).toEqual({
    schemaVersion: 2,
    developerMode: false,
    sources: [],
    disabled: ["dev:aaaaaaaaaaaaaaaa", "dev:bbbbbbbbbbbbbbbb"],
    legacyDisabledIds: [],
  });
  expect(await filePluginStateStore(root).load()).toEqual(
    state(["dev:aaaaaaaaaaaaaaaa", "dev:bbbbbbbbbbbbbbbb"]),
  );
});

it("migrates schema v1 manifest ids into legacyDisabledIds", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(file(), JSON.stringify({ schemaVersion: 1, disabled: ["acme.b", "acme.a"] }));
  const store = filePluginStateStore(root);
  expect(await store.load()).toEqual(state([], ["acme.a", "acme.b"]));
  await store.save(state(["dev:aaaaaaaaaaaaaaaa"], ["acme.b"]));
  expect(await stored()).toMatchObject({
    schemaVersion: 2,
    disabled: ["dev:aaaaaaaaaaaaaaaa"],
    legacyDisabledIds: ["acme.b"],
  });
});

it("keeps fields it does not manage when saving", async () => {
  await mkdir(path.join(root, "plugins"));
  const document = {
    schemaVersion: 2,
    developerMode: true,
    sources: [{ directory: "/work/hello" }],
    disabled: [],
    legacyDisabledIds: [],
    python: { executable: "/usr/bin/python3", args: [] },
    safeModeLock: { since: "2026-10-15T00:00:00.000Z", reason: "unclean-exit" },
  };
  await writeFile(file(), JSON.stringify(document));
  const store = filePluginStateStore(root);
  await store.load();
  await store.save(state(["dev:aaaaaaaaaaaaaaaa"]));
  expect(await stored()).toEqual({ ...document, disabled: ["dev:aaaaaaaaaaaaaaaa"] });
});

it("backs up a corrupt file and reports it instead of silently enabling everything", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(file(), "{broken");
  const store = filePluginStateStore(root, { now: () => new Date("2026-10-15T01:02:03.000Z") });
  const loaded = await store.load();
  expect(loaded).toMatchObject(state([]));
  expect(loaded.problem).toContain("state.json.corrupt-2026-10-15T01-02-03.000Z");
  expect(await readdir(path.join(root, "plugins"))).toEqual([
    "state.json.corrupt-2026-10-15T01-02-03.000Z",
  ]);
});

it("treats a schema-invalid file as corrupt", async () => {
  await mkdir(path.join(root, "plugins"));
  await writeFile(file(), JSON.stringify({ schemaVersion: 2, disabled: "nope" }));
  expect((await filePluginStateStore(root).load()).problem).toBeDefined();
});

it("serializes concurrent saves so the last one wins", async () => {
  const store = filePluginStateStore(root);
  await Promise.all([
    store.save(state(["dev:aaaaaaaaaaaaaaaa"])),
    store.save(state(["dev:bbbbbbbbbbbbbbbb"])),
  ]);
  expect((await stored()).disabled).toEqual(["dev:bbbbbbbbbbbbbbbb"]);
});

it("removes its temporary file when the final rename fails", async () => {
  // A non-empty directory where the file should be makes rename fail on every platform.
  await mkdir(path.join(file(), "blocker"), { recursive: true });
  const store = filePluginStateStore(root);
  await expect(store.save(state(["dev:aaaaaaaaaaaaaaaa"]))).rejects.toThrow();
  expect(
    (await readdir(path.join(root, "plugins"))).filter((name) => name.endsWith(".tmp")),
  ).toEqual([]);
});
