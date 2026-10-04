import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_PREFERENCES,
  FILE_PREFERENCE_CHOICES,
} from "../../shared/file-preferences.js";
import { FilePreferencesStore, filePreferencesPatchSchema } from "./preferences.js";

describe("file preferences persistence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "kobrixa-file-preferences-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("uses documented defaults without writing and returns independent snapshots", async () => {
    const store = new FilePreferencesStore(() => directory);
    const value = await store.get();
    expect(value).toEqual(DEFAULT_FILE_PREFERENCES);
    expect(await readdir(directory)).toEqual([]);
    value.localHistoryEnabled = false;
    expect((await store.get()).localHistoryEnabled).toBe(true);
  });

  it("loads persisted history opt-out before the first read and preserves valid fields", async () => {
    await writeFile(
      path.join(directory, "file-settings.json"),
      JSON.stringify({
        localHistoryEnabled: false,
        localHistoryDays: 90,
        externalChangeInterval: 5000,
        localHistoryVersions: "all",
        externalChangeAutoReload: null,
        unknownSetting: "ignored",
      }),
    );
    const store = new FilePreferencesStore(() => directory);
    expect(await store.get()).toEqual({
      ...DEFAULT_FILE_PREFERENCES,
      localHistoryEnabled: false,
      localHistoryDays: 90,
      externalChangeInterval: 5000,
    });
    await store.set({ externalChangesEnabled: false });
    expect(await new FilePreferencesStore(() => directory).get()).toEqual({
      ...DEFAULT_FILE_PREFERENCES,
      localHistoryEnabled: false,
      localHistoryDays: 90,
      externalChangeInterval: 5000,
      externalChangesEnabled: false,
    });
  });

  it("merges concurrent patches durably and lets reads await queued writes", async () => {
    const store = new FilePreferencesStore(() => directory);
    const first = store.set({ externalChangesEnabled: false });
    const second = store.set({ localHistoryDays: 7, localHistoryVersions: 20 });
    const current = store.get();
    const [one, two, final] = await Promise.all([first, second, current]);
    expect(one.externalChangesEnabled).toBe(false);
    expect(two).toEqual({
      ...DEFAULT_FILE_PREFERENCES,
      externalChangesEnabled: false,
      localHistoryDays: 7,
      localHistoryVersions: 20,
    });
    expect(final).toEqual(two);
    expect(JSON.parse(await readFile(path.join(directory, "file-settings.json"), "utf8"))).toEqual(
      two,
    );
    expect(await readdir(directory)).toEqual(["file-settings.json"]);
  });

  it("accepts only listed choices and boolean flags and rejects unknown patch keys", async () => {
    const store = new FilePreferencesStore(() => directory);
    for (const [key, values] of Object.entries(FILE_PREFERENCE_CHOICES)) {
      for (const value of values)
        expect(filePreferencesPatchSchema.safeParse({ [key]: value }).success).toBe(true);
      for (const value of [-1, 0, 1.5, 99999, String(values[0]), null, true]) {
        expect(filePreferencesPatchSchema.safeParse({ [key]: value }).success).toBe(false);
      }
    }
    for (const key of [
      "externalChangesEnabled",
      "externalChangeAutoReload",
      "localHistoryEnabled",
    ]) {
      expect(filePreferencesPatchSchema.safeParse({ [key]: false }).success).toBe(true);
      expect(filePreferencesPatchSchema.safeParse({ [key]: "false" }).success).toBe(false);
    }
    expect(filePreferencesPatchSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(filePreferencesPatchSchema.parse({ localHistoryEnabled: undefined })).toEqual({});
    expect(() => store.set({ localHistoryDays: 1 as never })).toThrow();
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps applied settings on failed persistence and recovers the write queue", async () => {
    const store = new FilePreferencesStore(() => directory);
    await store.set({ localHistoryEnabled: false });
    await rm(directory, { recursive: true });
    await writeFile(directory, "unavailable");
    await expect(store.set({ localHistoryEnabled: true })).rejects.toThrow();
    expect((await store.get()).localHistoryEnabled).toBe(false);
    await rm(directory);
    await mkdir(directory);
    await store.set({ localHistoryDays: 90 });
    expect(await new FilePreferencesStore(() => directory).get()).toEqual({
      ...DEFAULT_FILE_PREFERENCES,
      localHistoryEnabled: false,
      localHistoryDays: 90,
    });
  });

  it("recovers defaults from malformed settings", async () => {
    for (const content of ["not json", "[]", "null"]) {
      await writeFile(path.join(directory, "file-settings.json"), content);
      expect(await new FilePreferencesStore(() => directory).get()).toEqual(
        DEFAULT_FILE_PREFERENCES,
      );
    }
  });
});
