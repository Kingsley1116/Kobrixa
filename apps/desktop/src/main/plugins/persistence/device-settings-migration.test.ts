import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { DeviceSettingsMigrationGate } from "./device-settings-migration.js";
import { createDeviceSettingsHost } from "./device-settings-host.js";
import { createBoundSettingsService, settingsRequests } from "./settings-service.js";
import type { CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
import { DevicePreferencesStore } from "../../device/preferences.js";
import { SettingsStore } from "../../../renderer/settings/settings.js";
import { startPersistenceWorker } from "./worker.js";
import { openStoreRoot } from "./filesystem.js";
import type { PersistenceSourcePort, HostSettingsNamespace } from "./host-port.js";
import { devicePreferencesResource } from "./device-preferences-port.js";
import {
  deviceSettingsImportDescriptor as descriptor,
  deviceImportSettingsAuthority,
  DEVICE_RENDERER_KEYS,
} from "./device-settings-import.js";

let directory: string, entry: string;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "e3-migration-gate-")));
  const source = path.join(directory, "entry.ts");
  await writeFile(
    source,
    `import {runShippedPersistenceWorker} from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};runShippedPersistenceWorker();`,
  );
  await build({
    configFile: false,
    logLevel: "error",
    build: {
      target: "node24",
      outDir: path.join(directory, "bundle"),
      emptyOutDir: true,
      lib: { entry: source, formats: ["cjs"], fileName: () => "worker.cjs" },
      rollupOptions: { external: [/^node:/] },
      minify: false,
    },
  });
  entry = path.join(directory, "bundle", "worker.cjs");
}, 60000);
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture(existing?: string) {
  const userData = existing ?? path.join(directory, randomUUID());
  await mkdir(userData, { recursive: true });
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const root = await openStoreRoot({ userData, profile });
  const { backend } = await startPersistenceWorker({
    profile,
    root,
    workerEntry: entry,
    now: () => performance.now(),
  });
  let namespace: HostSettingsNamespace = {
    owner: {
      sourceKey: descriptor.targetSourceKey,
      pluginId: "kobrixa.device-ev3",
      generation: 1,
      hostEpoch: profile.hostEpoch,
      processEpoch: randomUUID(),
    },
    resourceDigest: "a".repeat(64),
    uiResourceGeneration: 1,
  };
  let active = true,
    scopeLive = true;
  const scope = { hostEpoch: profile.hostEpoch, workbenchInstance: randomUUID() };
  const resource = vi.fn<PersistenceSourcePort["settings"]>(async () => ({
    owner: {
      sourceKey: namespace.owner.sourceKey,
      pluginId: namespace.owner.pluginId,
      uiResourceGeneration: namespace.uiResourceGeneration,
    },
    resource: devicePreferencesResource,
    validationDigest: deviceImportSettingsAuthority.validationDigest,
  }));
  const sources: PersistenceSourcePort = {
    settingsNamespace: () => (active ? structuredClone(namespace) : null),
    current: () => false,
    coreOwner: () => null,
    settings: resource,
  };
  const writer = new DevicePreferencesStore();
  const gate = new DeviceSettingsMigrationGate({
    backend,
    sources,
    writer: {
      sourceKey: descriptor.targetSourceKey,
      freezeAdmission: () => writer.freezeAdmission(),
      settled: () => writer.settleMigration(),
    },
    currentScope: (s) =>
      scopeLive &&
      s.hostEpoch === scope.hostEpoch &&
      s.workbenchInstance === scope.workbenchInstance,
  });
  const unexpected = (): never => {
    throw new Error("unexpected event publication");
  };
  const events: CommonEventLedgerPort = {
    diagnostics: unexpected,
    create: unexpected,
    publish: unexpected,
    activate: unexpected,
    resync: unexpected,
    snapshot: unexpected,
    ack: unexpected,
    closeAfterControl: unexpected,
    unsubscribe: unexpected,
    owns: unexpected,
    onRemoved: () => () => {},
  };
  createBoundSettingsService({ backend, sources, events, now: () => performance.now() });
  const service = settingsRequests(backend);
  const host = createDeviceSettingsHost({
    backend,
    namespace: () => sources.settingsNamespace!(descriptor.targetSourceKey),
    migration: gate,
  });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      host.dispose();
      await service.dispose();
      await backend.dispose();
    }
  };
  cleanups.push(close);
  const raw = new Map(
    DEVICE_RENDERER_KEYS.map((key, i) => [key, ["wifi", "true", "192.168.1.2"][i]!]),
  );
  const storage = {
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => {
      raw.set(key, value);
    },
  };
  const renderer = new SettingsStore(() => storage, "en");
  async function capture() {
    renderer.freezeDevicePreferences();
    const challenge = await gate.issuePreferences({ descriptorId: descriptor.id, scope });
    return gate.acceptPreferencesEvidence({
      nonce: challenge.nonce,
      scope,
      entries: DEVICE_RENDERER_KEYS.map((key) => ({ key, raw: storage.getItem(key) })),
    });
  }
  return {
    userData,
    backend,
    gate,
    host,
    service,
    scope,
    writer,
    renderer,
    resource,
    close,
    capture,
    namespace: () => namespace,
    active(value: boolean) {
      active = value;
    },
    replace(sameGeneration = false) {
      namespace = {
        ...namespace,
        owner: {
          ...namespace.owner,
          generation: namespace.owner.generation + (sameGeneration ? 0 : 1),
          processEpoch: randomUUID(),
        },
        uiResourceGeneration: namespace.uiResourceGeneration + 1,
      };
    },
    retire() {
      scopeLive = false;
      gate.retirePreferences(scope);
    },
  };
}
it("policy uses the committed namespace with no process or window and fences disable/replacement immediately", async () => {
  const f = await fixture();
  expect(() => f.host.connectionPolicy()).toThrow();
  await f.capture();
  await f.host.refresh();
  expect(f.host.connectionPolicy().usbRetryLimit).toBe("unlimited");
  expect(f.host.skipUnchangedAssets()).toBe(true);
  f.active(false);
  expect(() => f.host.connectionPolicy()).toThrow();
  const calls = f.resource.mock.calls.length;
  f.host.sourceChanged();
  await f.host.refresh();
  expect(f.resource).toHaveBeenCalledTimes(calls);
  f.active(true);
  f.replace();
  f.retire();
  f.host.sourceChanged();
  await f.host.refresh();
  expect(f.host.connectionPolicy().usbAutoReconnect).toBe(true);
  f.host.dispose();
  expect(() => f.host.skipUnchangedAssets()).toThrow("Disposed");
});
it("actual CAS invalidates cached host policy until its committed refresh completes", async () => {
  const f = await fixture();
  await f.capture();
  await f.host.refresh();
  const prior = f.host.getSnapshot();
  if (prior.state !== "ready") throw new Error("not ready");
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const original = f.service.hostSnapshot.bind(f.service);
  vi.spyOn(f.service, "hostSnapshot").mockImplementation(async (...args) => {
    await wait;
    return original(...args);
  });
  expect(
    (
      await f.service.requestOwner(
        f.namespace().owner,
        "settings/update",
        {
          schemaVersion: 1,
          expectedRevision: prior.snapshot.revision,
          changes: [{ key: "usbAutoReconnect", value: false }],
        },
        new AbortController().signal,
        async () => {},
      )
    ).ok,
  ).toBe(true);
  expect(() => f.host.connectionPolicy()).toThrow();
  release();
  await vi.waitFor(() => expect(f.host.connectionPolicy().usbAutoReconnect).toBe(false));
});
it("does no optional I/O while disabled and does not invent a headless renderer snapshot", async () => {
  const f = await fixture();
  const reads = vi.spyOn(f.backend.evidence, "auxiliaryKeys");
  f.active(false);
  await expect(f.gate.prepare(new AbortController().signal)).rejects.toThrow("unavailable");
  expect(reads).not.toHaveBeenCalled();
  expect(f.resource).not.toHaveBeenCalled();
  f.active(true);
  await expect(f.gate.prepare(new AbortController().signal)).rejects.toThrow();
  expect(f.gate.ready()).toBe(false);
  expect(await f.backend.reads.settings(f.namespace().owner)).toBeNull();
  await expect(f.writer.set({ usbAutoReconnect: false }, () => {})).rejects.toThrow("frozen");
});
it("freezes actual legacy writers and publishes once before enabling policy reads; completed restart needs no renderer", async () => {
  const f = await fixture();
  const bytes = '{"usbRetryLimit":5}';
  await writeFile(path.join(f.userData, "device-settings.json"), bytes);
  const publish = vi.spyOn(f.backend.engine, "publish");
  expect(await f.capture()).toEqual({ state: "accepted" });
  expect(f.gate.ready()).toBe(true);
  expect(() => f.renderer.set("connectionMode", "usb")).toThrow("frozen");
  await expect(f.writer.set({ usbAutoReconnect: false }, () => {})).rejects.toThrow("frozen");
  await Promise.all(Array.from({ length: 4 }, () => f.gate.prepare(new AbortController().signal)));
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "settings")).toHaveLength(1);
  expect(await readFile(path.join(f.userData, "device-settings.json"), "utf8")).toBe(bytes);
  const settings = await f.backend.reads.settings(f.namespace().owner);
  expect(settings?.values).toContainEqual({ key: "usbRetryLimit", value: 5 });
  await f.close();
  const next = await fixture(f.userData);
  await next.gate.prepare(new AbortController().signal);
  expect(next.gate.ready()).toBe(true);
  expect(await next.backend.reads.settings(next.namespace().owner)).toEqual(settings);
});
it("invalidates readiness on disable and replacement and rejects a retired renderer capture", async () => {
  const f = await fixture();
  await f.capture();
  f.active(false);
  expect(f.gate.ready()).toBe(false);
  await expect(f.gate.prepare(new AbortController().signal)).rejects.toThrow();
  f.active(true);
  f.replace();
  expect(f.gate.ready()).toBe(false);
  await f.gate.prepare(new AbortController().signal);
  expect(f.gate.ready()).toBe(true);
  f.retire();
  await expect(
    f.gate.issuePreferences({ descriptorId: descriptor.id, scope: f.scope }),
  ).rejects.toThrow("Stale");
});
it("resumes the original consumed capture headlessly after a crash before the first plan", async () => {
  const f = await fixture();
  const register = vi
    .spyOn(f.backend.sources, "register")
    .mockRejectedValue(new Error("interrupted before plan"));
  await expect(f.capture()).rejects.toThrow("pending or blocked");
  expect(await f.backend.reads.settings(f.namespace().owner)).toBeNull();
  register.mockRestore();
  await f.close();
  const next = await fixture(f.userData);
  await next.gate.prepare(new AbortController().signal);
  expect(next.gate.ready()).toBe(true);
  expect((await next.backend.reads.settings(next.namespace().owner))?.values).toContainEqual({
    key: "lastWifiAddress",
    value: "192.168.1.2",
  });
});
it("does not replace an unreadable original with defaults or mark migration ready", async () => {
  const f = await fixture();
  await mkdir(path.join(f.userData, "device-settings.json"));
  await expect(f.capture()).rejects.toThrow("pending or blocked");
  expect(f.gate.ready()).toBe(false);
  expect(await f.backend.reads.settings(f.namespace().owner)).toBeNull();
});
it("resumes an incomplete original import after disable/re-enable without a manager generation change", async () => {
  const f = await fixture();
  const admit = f.backend.imports.admit.bind(f.backend.imports);
  const failure = vi.spyOn(f.backend.imports, "admit").mockImplementation(async (...args) => {
    const ticket = await admit(...args);
    await f.backend.engine.abort(ticket);
    throw new Error("interrupted after original plan");
  });
  await expect(f.capture()).rejects.toThrow();
  expect(await f.backend.reads.settings(f.namespace().owner)).toBeNull();
  failure.mockRestore();
  f.active(false);
  expect(f.gate.ready()).toBe(false);
  f.replace(true);
  f.active(true);
  await f.gate.prepare(new AbortController().signal);
  expect(f.gate.ready()).toBe(true);
});
it("keeps the original shared publication alive when a read observer aborts", async () => {
  const f = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const original = f.resource.getMockImplementation()!;
  f.resource.mockImplementation(async (request) => {
    await wait;
    return original(request);
  });
  const capture = f.capture();
  await vi.waitFor(() => expect(f.resource).toHaveBeenCalled());
  const control = new AbortController();
  const cancelled = f.gate.prepare(control.signal);
  control.abort(new Error("observer cancelled"));
  await expect(cancelled).rejects.toThrow("observer cancelled");
  release();
  await expect(capture).resolves.toEqual({ state: "accepted" });
  expect(f.gate.ready()).toBe(true);
});
it("does not publish using a resource whose namespace changed during its async read", async () => {
  const f = await fixture();
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const original = f.resource.getMockImplementation()!;
  f.resource.mockImplementation(async (request) => {
    const resource = await original(request);
    await wait;
    return resource;
  });
  const capture = f.capture();
  await vi.waitFor(() => expect(f.resource).toHaveBeenCalled());
  f.replace();
  release();
  await expect(capture).rejects.toThrow();
  expect(f.gate.ready()).toBe(false);
  expect(await f.backend.reads.settings(f.namespace().owner)).toBeNull();
});

it("temporary source withdrawal during initial restore does not permanently poison the host gate", async () => {
  const f = await fixture();
  const opening = f.gate.prepare(new AbortController().signal);
  f.active(false);
  await expect(opening).rejects.toThrow();
  f.active(true);
  f.replace(true);
  await expect(f.capture()).resolves.toEqual({ state: "accepted" });
  expect(f.gate.ready()).toBe(true);
});
