import { afterEach, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mapDeviceSettingsSnapshot, DEVICE_RENDERER_KEYS } from "./device-settings-import.js";
import {
  snapshotBytes,
  type LegacyImportInput,
  type LegacyImportDescriptor,
} from "./import-sources.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../../shared/device-preferences.js";
import { devicePreferencesResource } from "./device-preferences-port.js";
import { WorkerSources } from "./worker.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
const encode = (sourceKind: LegacyImportInput["sourceKind"], raw: unknown): LegacyImportInput => {
  const bytes = Buffer.from(JSON.stringify(raw));
  return {
    sourceKind,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...(sourceKind === "device-settings" ? { file: { basename: "device-settings.json" } } : {}),
  };
};
function renderer(values: Array<string | null> = [null, null, null]) {
  const raw = {
    nonce: randomUUID(),
    scope: { hostEpoch: randomUUID(), workbenchInstance: randomUUID() },
    entries: DEVICE_RENDERER_KEYS.map((key, i) => ({ key, raw: values[i] ?? null })),
  };
  const bytes = snapshotBytes(raw, DEVICE_RENDERER_KEYS);
  return {
    sourceKind: "renderer-preferences" as const,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
function merged(device: unknown, values?: Array<string | null>) {
  return mapDeviceSettingsSnapshot({
    device: { state: "present", original: encode("device-settings", device) },
    renderer: renderer(values),
  });
}
it("nine resource defaults preserve six provider values and three connection defaults", () => {
  const result = mapDeviceSettingsSnapshot({ device: { state: "absent" }, renderer: renderer() });
  expect(Object.fromEntries(result.item.values.map((x) => [x.key, x.value]))).toEqual({
    ...DEFAULT_DEVICE_PREFERENCES,
    connectionMode: "usb",
    rememberWifiAddress: false,
    lastWifiAddress: "",
  });
  expect(result.defaultedKeys).toHaveLength(9);
  expect(devicePreferencesResource.fields).toHaveLength(9);
});
it("one full merge preserves both originals and reports missing fields", () => {
  const device = encode("device-settings", { usbRetryLimit: 5, wifiConnectTimeout: 30000 });
  const preferences = renderer(["wifi", "true", "192.168.0.2"]);
  const before = Buffer.from(device.bytes),
    other = Buffer.from(preferences.bytes);
  const result = mapDeviceSettingsSnapshot({
    device: { state: "present", original: device },
    renderer: preferences,
  });
  expect(result.item.values).toEqual(
    expect.arrayContaining([
      { key: "usbRetryLimit", value: 5 },
      { key: "connectionMode", value: "wifi" },
      { key: "lastWifiAddress", value: "192.168.0.2" },
    ]),
  );
  expect(result.defaultedKeys).toHaveLength(4);
  expect(result.originals).toMatchObject({
    deviceSha256: device.sha256,
    rendererSha256: preferences.sha256,
  });
  result.item.values[0]!.value = "changed";
  expect(Buffer.from(device.bytes)).toEqual(before);
  expect(Buffer.from(preferences.bytes)).toEqual(other);
});
it.each([
  null,
  [],
  { formatVersion: 2 },
  { usbRetryLimit: "5" },
  { usbAutoReconnect: null },
  { wifiConnectTimeout: 42 },
  { unknown: true },
])("rejects corrupt, unknown/versioned, and incorrectly typed provider data: %j", (value) => {
  expect(() => merged(value)).toThrow();
});
it.each([
  ["bluetooth", "false", ""],
  ["usb", "1", ""],
  ["usb", "false", "x".repeat(46)],
  ["usb", "false", "\u0000"],
])("validates all renderer fields even when remembering is off", (...values) => {
  expect(() => merged({}, values)).toThrow();
});
it("remember=false clears a valid original address within the single mapped snapshot", () => {
  expect(merged({}, ["wifi", "false", "192.168.0.2"]).item.values).toContainEqual({
    key: "lastWifiAddress",
    value: "",
  });
});
it("requires the exact nonce/scoped allowlist snapshot, original digest, and observed basename", () => {
  const d = encode("device-settings", {}),
    r = renderer();
  expect(() =>
    mapDeviceSettingsSnapshot({
      device: { state: "present", original: { ...d, sha256: "0".repeat(64) } },
      renderer: r,
    }),
  ).toThrow();
  expect(() =>
    mapDeviceSettingsSnapshot({
      device: { state: "present", original: { ...d, file: { basename: "other.json" } } },
      renderer: r,
    }),
  ).toThrow();
  const raw = JSON.parse(Buffer.from(r.bytes).toString());
  raw.entries.pop();
  expect(() =>
    mapDeviceSettingsSnapshot({
      device: { state: "absent" },
      renderer: encode("renderer-preferences", raw),
    }),
  ).toThrow();
  raw.entries = DEVICE_RENDERER_KEYS.map((key) => ({ key, raw: null }));
  raw.scope.extra = true;
  expect(() =>
    mapDeviceSettingsSnapshot({
      device: { state: "absent" },
      renderer: encode("renderer-preferences", raw),
    }),
  ).toThrow();
});
it("rejects oversized and malformed UTF-8 originals before mapping", () => {
  for (const bytes of [Buffer.alloc(65537), Buffer.from([0xff])]) {
    const d = {
      ...encode("device-settings", {}),
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    expect(() =>
      mapDeviceSettingsSnapshot({
        device: { state: "present", original: d },
        renderer: renderer(),
      }),
    ).toThrow();
  }
});
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
it("ordinary versioned WorkerSources still rejects an unversioned file; only the fixed combined mapper admits it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "device-import-contract-"));
  const source = path.join(root, "legacy");
  await mkdir(source);
  const file = path.join(source, "device-settings.json"),
    original = JSON.stringify(DEFAULT_DEVICE_PREFERENCES);
  await writeFile(file, original);
  await mkdir(path.join(root, "store"));
  const fs = await createNodePersistenceFs(
    path.join(root, "store"),
    { hostEpoch: randomUUID(), assertHeld() {} },
    { now: () => 0 },
  );
  const store = new AtomicStore(fs);
  await store.initialize();
  cleanups.push(async () => {
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });
  // Probe the existing real resolver contract, not a fake combined-source port.
  const descriptor: LegacyImportDescriptor = {
    id: "test.device-prerequisite",
    targetSourceKey: "builtin:kobrixa.device-ev3",
    mappingVersion: 1,
    sourceKind: "device-settings",
    sourceFormatVersions: [1],
    targetSettingsSchemaVersion: 1,
    targetRecordSchemaVersions: [],
    validate: () => true,
    map: () => {
      throw new Error("must not map unsupported inventory");
    },
  };
  const sources = new WorkerSources(
    fs.root,
    store,
    new Map([[descriptor.id, descriptor]]),
    new Map([[descriptor.id, source]]),
  );
  await sources.register({
    descriptorId: descriptor.id,
    mapperId: descriptor.id,
    sourceKind: descriptor.sourceKind,
  });
  expect(await sources.inventory(descriptor.id)).toEqual({ state: "blocked", entries: [] });
  expect(await readFile(file, "utf8")).toBe(original);
});
it("shipped resource validation shape matches the host contract without runtime resource preload", async () => {
  const resource = JSON.parse(
    await readFile(
      new URL("../../../../../../plugins/device-ev3/settings/preferences.json", import.meta.url),
      "utf8",
    ),
  );
  const { validateSettingsResource } =
    await import("../../../../../../packages/plugin-protocol/src/persistence-validation.js");
  const { settingsValidationText } =
    await import("../../../../../../packages/plugin-protocol/src/settings.js");
  expect(
    settingsValidationText(
      validateSettingsResource(resource, Buffer.byteLength(JSON.stringify(resource))),
    ),
  ).toBe(settingsValidationText(devicePreferencesResource));
});
