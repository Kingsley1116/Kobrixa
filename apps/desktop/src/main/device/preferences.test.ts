import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  DevicePreferencesStore,
  devicePreferencesPatchSchema,
  loadDevicePreferences,
} from "./preferences.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((file) => rm(file, { recursive: true, force: true })));
});
it("validates IPC presets and ignores undefined fields without overriding defaults", () => {
  expect(devicePreferencesPatchSchema.parse({ usbRetryLimit: undefined })).toEqual({});
  for (const value of [
    { usbRetryLimit: 0 },
    { wifiConnectTimeout: -1 },
    { usbAutoReconnect: "false" },
    { arbitrary: 1 },
  ])
    expect(devicePreferencesPatchSchema.safeParse(value).success).toBe(false);
});
it("merges queued patches and preserves active values when persistence fails", async () => {
  const persist = vi.fn(async () => {});
  const applied = vi.fn();
  const store = new DevicePreferencesStore(undefined, persist);
  await Promise.all([
    store.set({ usbRetryInterval: 2000 }, applied),
    store.set({ usbRetryLimit: 3 }, applied),
  ]);
  expect(store.get()).toMatchObject({ usbRetryInterval: 2000, usbRetryLimit: 3 });
  persist.mockRejectedValueOnce(new Error("disk full"));
  await expect(store.set({ usbAutoReconnect: false }, applied)).rejects.toThrow("disk full");
  expect(store.get().usbAutoReconnect).toBe(true);
  expect(applied).toHaveBeenCalledTimes(2);
  await store.set({ usbAutoReconnect: false }, applied);
  expect(store.get().usbAutoReconnect).toBe(false);
});
it("does not apply policy before the file is saved", async () => {
  let finish!: () => void;
  const store = new DevicePreferencesStore(
    undefined,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const applied = vi.fn();
  const saving = store.set({ usbAutoReconnect: false }, applied);
  await Promise.resolve();
  await Promise.resolve();
  expect(store.get().usbAutoReconnect).toBe(true);
  expect(applied).not.toHaveBeenCalled();
  finish();
  await saving;
  expect(applied).toHaveBeenCalledOnce();
});
it("recovers valid fields independently and persists them across restarts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-preferences-"));
  temporary.push(directory);
  const file = path.join(directory, "device-settings.json");
  await writeFile(file, JSON.stringify({ usbRetryLimit: 5, wifiConnectTimeout: "invalid" }));
  const store = await loadDevicePreferences(directory);
  expect(store.get()).toEqual({ ...DEFAULT_DEVICE_PREFERENCES, usbRetryLimit: 5 });
  await store.set({ wifiHandshakeTimeout: 10000 }, () => {});
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(store.get());
  expect((await loadDevicePreferences(directory)).get()).toEqual(store.get());
  await writeFile(file, "invalid JSON");
  expect((await loadDevicePreferences(directory)).get()).toEqual(DEFAULT_DEVICE_PREFERENCES);
});
