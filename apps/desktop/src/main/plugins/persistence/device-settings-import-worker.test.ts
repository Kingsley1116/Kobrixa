import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  chmod,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import { startPersistenceWorker } from "./worker.js";
import { openStoreRoot } from "./filesystem.js";
import { createLegacyWriterBarrier, importIdFor, snapshotBytes } from "./import-sources.js";
import { createLegacyImportCoordinator } from "./import-coordinator.js";
import {
  deviceSettingsImportDescriptor as descriptor,
  deviceImportSettingsAuthority,
  DEVICE_RENDERER_KEYS,
} from "./device-settings-import.js";
import { devicePreferencesResource } from "./device-preferences-port.js";
import { devicePreferencesEvidenceBytes, importPlanSchema } from "./namespace.js";
import type { PublicationTicket, PersistenceBackend } from "./engine-port.js";
let directory: string, entry: string;
const cleanups: Array<() => Promise<void>> = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "e3-combined-worker-")));
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
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function fixture(existing?: string, authorityEnabled = true) {
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
  let disposed = false;
  const close = async () => {
    if (!disposed) {
      disposed = true;
      await backend.dispose();
    }
  };
  cleanups.push(close);
  let owner: PublicationTicket["owner"] = {
    sourceKey: descriptor.targetSourceKey,
    pluginId: "kobrixa.device-ev3",
    generation: 1,
    hostEpoch: profile.hostEpoch,
    processEpoch: profile.hostEpoch,
  };
  let active = true;
  const scope = { hostEpoch: profile.hostEpoch, workbenchInstance: randomUUID() };
  const counts = { freeze: 0, settle: 0, authority: 0 };
  let settle = Promise.resolve(),
    authorityWait = Promise.resolve();
  const writers = Array.from({ length: 2 }, () => ({
    sourceKey: owner.sourceKey,
    freezeAdmission() {
      counts.freeze++;
    },
    async settled() {
      counts.settle++;
      await settle;
    },
  }));
  const barrier = createLegacyWriterBarrier({
    backend,
    writers,
    descriptors: [descriptor],
    importOwner: () => owner,
  });
  const coordinator = createLegacyImportCoordinator({
    backend,
    sources: backend.sources,
    barrier,
    descriptors: [descriptor],
    currentScope: (s) =>
      s.hostEpoch === scope.hostEpoch && s.workbenchInstance === scope.workbenchInstance,
    currentSource: () => active,
    importOwner: () => owner,
    ...(authorityEnabled
      ? {
          async settingsAuthority(o: typeof owner) {
            counts.authority++;
            expect(o).toEqual(owner);
            await authorityWait;
            return deviceImportSettingsAuthority;
          },
        }
      : {}),
  });
  async function capture(raw: Array<string | null> = ["wifi", "true", "192.168.0.7"]) {
    const challenge = await coordinator.issuePreferences({ descriptorId: descriptor.id, scope });
    const snapshot = {
      nonce: challenge.nonce,
      scope,
      entries: DEVICE_RENDERER_KEYS.map((key, i) => ({ key, raw: raw[i]! })),
    };
    expect(await coordinator.acceptPreferencesEvidence(snapshot)).toEqual({ state: "accepted" });
    return snapshot;
  }
  const run = () => coordinator.run(descriptor, new AbortController().signal);
  const saved = () => backend.imports.load(owner, importIdFor(descriptor.id, owner.sourceKey));
  return {
    userData,
    backend,
    close,
    coordinator,
    scope,
    counts,
    capture,
    run,
    saved,
    get owner() {
      return owner;
    },
    setOwner() {
      owner = { ...owner, generation: owner.generation + 1 };
    },
    disable() {
      active = false;
    },
    setBarrier(p: Promise<void>) {
      settle = p;
    },
    setAuthorityWait(p: Promise<void>) {
      authorityWait = p;
    },
  };
}
it("publishes one null-target nine-field receipt from both originals, and completion survives a fresh worker", async () => {
  const f = await fixture();
  const original = Buffer.from('{ "usbRetryLimit": 5, "wifiConnectTimeout": 30000 }');
  await writeFile(path.join(f.userData, "device-settings.json"), original);
  const snapshot = await f.capture(["wifi", "false", "192.168.0.7"]);
  expect(await f.backend.reads.settings(f.owner)).toBeNull();
  const publish = vi.spyOn(f.backend.engine, "publish");
  expect(await f.run()).toEqual({ state: "complete", completedItems: 1, totalItems: 1 });
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "settings")).toHaveLength(1);
  const saved = (await f.saved())!;
  const item = saved.plan.items[0]!;
  expect(item.ticket.target).toEqual({ kind: "settings", expectedRevision: null });
  expect(item.ticket.metadata).toEqual({ kind: "settings", ...deviceImportSettingsAuthority });
  expect(saved.items[0]?.receipt?.commitId).toBe(saved.items[0]?.publicationTicket?.id);
  expect(saved.complete).toBe(true);
  expect(saved.plan.devicePreferencesEvidence).toEqual({
    formatVersion: 1,
    defaultedKeys: [
      "skipUnchangedAssets",
      "usbAutoReconnect",
      "usbRetryInterval",
      "wifiHandshakeTimeout",
    ],
    device: { state: "present", base64: original.toString("base64"), sha256: hash(original) },
    renderer: {
      nonce: snapshot.nonce,
      digest: hash(snapshotBytes(snapshot, DEVICE_RENDERER_KEYS)),
      base64: Buffer.from(snapshotBytes(snapshot, DEVICE_RENDERER_KEYS)).toString("base64"),
    },
  });
  expect(item.sourceSha256).toBe(
    hash(devicePreferencesEvidenceBytes(saved.plan.devicePreferencesEvidence)),
  );
  const settings = (await f.backend.reads.settings(f.owner))!;
  expect(settings.values).toHaveLength(9);
  expect(settings.values).toContainEqual({ key: "lastWifiAddress", value: "" });
  expect(settings.values).toContainEqual({ key: "usbRetryLimit", value: 5 });
  expect(await readFile(path.join(f.userData, "device-settings.json"))).toEqual(original);
  await f.close();
  const next = await fixture(f.userData);
  // Marker is authoritative: subsequent old bytes cannot resurrect preferences.
  await writeFile(path.join(f.userData, "device-settings.json"), "corrupt after completion");
  expect((await next.run()).state).toBe("complete");
  expect(await next.backend.reads.settings(next.owner)).toEqual(settings);
});
it("requires both settled writers before issuing the snapshot challenge; disabled run reads nothing", async () => {
  const f = await fixture();
  let release!: () => void;
  f.setBarrier(new Promise<void>((r) => (release = r)));
  let issued = false;
  const pending = f.capture().then(() => (issued = true));
  await vi.waitFor(() => expect(f.counts.settle).toBe(2));
  expect(issued).toBe(false);
  release();
  await pending;
  f.disable();
  const register = vi.spyOn(f.backend.sources, "register");
  expect((await f.run()).state).toBe("pending");
  expect(register).not.toHaveBeenCalled();
});
it("validated absent file still imports renderer fields in one complete item", async () => {
  const f = await fixture();
  await f.capture();
  expect((await f.run()).state).toBe("complete");
  expect((await f.saved())?.plan.devicePreferencesEvidence?.device).toEqual({ state: "absent" });
  expect((await f.backend.reads.settings(f.owner))?.values).toContainEqual({
    key: "connectionMode",
    value: "wifi",
  });
});
it.each(["{broken", '{"formatVersion":1}', '{"usbRetryLimit":"5"}', "[1]", '{"unknown":false}'])(
  "corrupt or unsupported file fails closed: %s",
  async (raw) => {
    const f = await fixture();
    await writeFile(path.join(f.userData, "device-settings.json"), raw);
    await f.capture();
    expect((await f.run()).state).toBe("blocked");
    expect(await f.saved()).toBeNull();
    expect(await f.backend.reads.settings(f.owner)).toBeNull();
    expect(await readFile(path.join(f.userData, "device-settings.json"), "utf8")).toBe(raw);
  },
);
it("symlink and permission failures are not absent", async () => {
  const f = await fixture(),
    file = path.join(f.userData, "device-settings.json"),
    outside = path.join(directory, randomUUID());
  await writeFile(outside, "{}");
  await symlink(outside, file);
  await f.capture();
  expect((await f.run()).state).toBe("blocked");
  await unlink(file);
  await writeFile(file, "{}");
  await chmod(file, 0);
  try {
    await expect(readFile(file)).rejects.toMatchObject({ code: "EACCES" });
    expect((await f.run()).state).toBe("blocked");
  } finally {
    await chmod(file, 0o600);
  }
  expect(await f.saved()).toBeNull();
});
it("captures maximum permitted originals within the explicit combined evidence cap", async () => {
  const f = await fixture();
  await writeFile(path.join(f.userData, "device-settings.json"), "{}" + " ".repeat(65534));
  await f.capture();
  expect((await f.run()).state).toBe("complete");
  expect(
    devicePreferencesEvidenceBytes((await f.saved())!.plan.devicePreferencesEvidence).length,
  ).toBeLessThanOrEqual(196608);
});
it("retains an unknown original publication; a fresh worker reconciles its actual receipt without replacement", async () => {
  const f = await fixture();
  await writeFile(path.join(f.userData, "device-settings.json"), "{}");
  await f.capture();
  const actualPublish = f.backend.engine.publish.bind(f.backend.engine);
  let original: PublicationTicket | undefined;
  vi.spyOn(f.backend.engine, "publish").mockImplementation(async (t) => {
    const result = await actualPublish(t);
    if (t.target.kind === "settings") {
      original = t;
      expect(result.disposition).toBe("committed");
      return { disposition: "unknown" };
    }
    return result;
  });
  const actualReconcile = f.backend.imports.reconcile.bind(f.backend.imports);
  vi.spyOn(f.backend.imports, "reconcile").mockImplementation((t) =>
    t.target.kind === "settings" ? Promise.resolve({ disposition: "unknown" }) : actualReconcile(t),
  );
  expect((await f.run()).state).toBe("blocked");
  const plan = (await f.saved())!.plan;
  expect(original).toBeDefined();
  expect((await f.saved())?.complete).toBe(false);
  expect((await f.run()).state).toBe("blocked");
  await f.close();
  const next = await fixture(f.userData);
  const publish = vi.spyOn(next.backend.engine, "publish");
  expect((await next.run()).state).toBe("complete");
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "settings")).toHaveLength(0);
  const saved = (await next.saved())!;
  expect(saved.plan).toEqual(plan);
  expect(saved.items[0]?.publicationTicket).toEqual(original);
  expect(saved.items[0]?.receipt?.commitId).toBe(original!.id);
});
it("changed originals after durable planning block restart, including absent-to-present", async () => {
  const f = await fixture();
  await f.capture();
  vi.spyOn(f.backend.imports, "admit").mockRejectedValue(new Error("stop before publication"));
  expect((await f.run()).state).toBe("blocked");
  const plan = (await f.saved())!.plan;
  expect(plan.devicePreferencesEvidence?.device.state).toBe("absent");
  await f.close();
  await writeFile(path.join(f.userData, "device-settings.json"), "{}");
  const next = await fixture(f.userData);
  expect((await next.run()).state).toBe("blocked");
  expect((await next.saved())?.plan).toEqual(plan);
  expect(await next.backend.reads.settings(next.owner)).toBeNull();
});
it("rejects forged digest/owner, and stale owner after settings evidence await", async () => {
  const f = await fixture();
  const snapshot = await f.capture();
  await f.backend.sources.register({
    descriptorId: descriptor.id,
    mapperId: descriptor.id,
    sourceKind: descriptor.sourceKind,
  });
  const input = {
    descriptorId: descriptor.id,
    owner: f.owner,
    evidence: {
      nonce: snapshot.nonce,
      digest: hash(snapshotBytes(snapshot, DEVICE_RENDERER_KEYS)),
    },
    settings: deviceImportSettingsAuthority,
  };
  await expect(
    f.backend.sources.resolvePreferences({
      ...input,
      settings: { ...input.settings, validationDigest: "a".repeat(64) },
    }),
  ).rejects.toThrow("schema-mismatch");
  await expect(
    f.backend.sources.resolvePreferences({ ...input, owner: { ...f.owner, pluginId: "forged" } }),
  ).rejects.toThrow("persistence-io");
  await expect(
    f.backend.sources.resolvePreferences({
      ...input,
      owner: { ...f.owner, hostEpoch: randomUUID() },
    }),
  ).rejects.toThrow("stale");
  const digest = f.backend.evidence.settingsDigest.bind(f.backend.evidence);
  vi.spyOn(f.backend.evidence, "settingsDigest").mockImplementation(async (o) => {
    const r = await digest(o);
    f.setOwner();
    return r;
  });
  expect((await f.run()).state).toBe("blocked");
  expect(await f.saved()).toBeNull();
});
async function publishSettings(backend: PersistenceBackend, owner: PublicationTicket["owner"]) {
  const ticket: PublicationTicket = {
    id: randomUUID(),
    owner,
    deadlineMonotonicMs: performance.now() + 10000,
    target: { kind: "settings", expectedRevision: null },
    metadata: { kind: "settings", ...deviceImportSettingsAuthority },
  };
  const bytes = Buffer.from(
    JSON.stringify({
      formatVersion: 1,
      ...deviceImportSettingsAuthority,
      values: devicePreferencesResource.fields.map((f) => ({ key: f.key, value: f.default })),
    }),
  );
  await backend.engine.reserve(ticket, bytes.length);
  await backend.engine.append(ticket, 0, bytes);
  await backend.engine.seal(ticket, bytes.length, hash(bytes));
  const result = await backend.engine.publish(ticket);
  expect(result.disposition).toBe("committed");
  return { ticket, receipt: result.receipt };
}
it("preexisting unrelated settings block without adopting their revision", async () => {
  const f = await fixture();
  const { ticket, receipt } = await publishSettings(f.backend, f.owner);
  await f.capture();
  expect((await f.run()).state).toBe("blocked");
  expect(await f.saved()).toBeNull();
  expect((await f.backend.evidence.settingsDigest(f.owner))?.revision).not.toBeNull();
  expect((await f.backend.engine.reconcile(ticket)).receipt).toEqual(receipt);
});
it("strict durable plan rejects altered originals, absent evidence, extra fields, or non-null target", async () => {
  const f = await fixture();
  await f.capture();
  expect((await f.run()).state).toBe("complete");
  const plan = (await f.saved())!.plan;
  for (const mutate of [
    (p: typeof plan) => {
      Reflect.deleteProperty(p, "devicePreferencesEvidence");
    },
    (p: typeof plan) => {
      p.devicePreferencesEvidence!.renderer.digest = "0".repeat(64);
    },
    (p: typeof plan) => {
      Object.assign(p.devicePreferencesEvidence!, { extra: true });
    },
    (p: typeof plan) => {
      Object.assign(p.items[0]!.ticket.target, { expectedRevision: "r_" + "a".repeat(32) });
    },
  ]) {
    const copy = structuredClone(plan);
    mutate(copy);
    expect(importPlanSchema.safeParse(copy).success).toBe(false);
  }
});

it("fresh worker resumes a planned pristine import using the same immutable original plan", async () => {
  const f = await fixture();
  await writeFile(path.join(f.userData, "device-settings.json"), '{"usbAutoReconnect":false}');
  await f.capture();
  vi.spyOn(f.backend.imports, "admit").mockRejectedValue(new Error("stop before attempt"));
  expect((await f.run()).state).toBe("blocked");
  const plan = (await f.saved())!.plan;
  await f.close();
  const next = await fixture(f.userData);
  expect((await next.run()).state).toBe("complete");
  expect((await next.saved())!.plan).toEqual(plan);
  expect((await next.saved())!.items[0]?.publicationTicket?.owner.hostEpoch).toBe(
    next.owner.hostEpoch,
  );
  expect((await next.backend.reads.settings(next.owner))?.values).toContainEqual({
    key: "usbAutoReconnect",
    value: false,
  });
});
it("resumes a pristine planned import after source generation changes in the same worker", async () => {
  const f = await fixture();
  await f.capture();
  const admit = vi
    .spyOn(f.backend.imports, "admit")
    .mockRejectedValueOnce(new Error("pause before publication"));
  expect((await f.run()).state).toBe("blocked");
  const original = (await f.saved())!.plan;
  expect(await f.backend.reads.settings(f.owner)).toBeNull();
  admit.mockRestore();
  f.setOwner();
  expect((await f.run()).state).toBe("complete");
  expect((await f.saved())!.plan).toEqual(original);
});

it("requires explicit schema authority and rejects generation change during its await", async () => {
  const no = await fixture(undefined, false);
  await no.capture();
  expect((await no.run()).state).toBe("blocked");
  expect(await no.saved()).toBeNull();
  const f = await fixture();
  await f.capture();
  let release!: () => void;
  f.setAuthorityWait(new Promise<void>((r) => (release = r)));
  const running = f.run();
  await vi.waitFor(() => expect(f.counts.authority).toBe(1));
  f.setOwner();
  release();
  expect((await running).state).toBe("blocked");
  expect(await f.saved()).toBeNull();
  expect(await f.backend.reads.settings(f.owner)).toBeNull();
});
it("retired window cannot replace a captured renderer original", async () => {
  const f = await fixture();
  const snapshot = await f.capture();
  f.coordinator.retirePreferences(f.scope);
  await expect(
    f.coordinator.acceptPreferencesEvidence({
      ...snapshot,
      entries: snapshot.entries.map((e) => ({ ...e, raw: null })),
    }),
  ).rejects.toThrow("stale");
  expect((await f.run()).state).toBe("complete");
  expect((await f.saved())?.plan.preferencesEvidence?.digest).toBe(
    hash(snapshotBytes(snapshot, DEVICE_RENDERER_KEYS)),
  );
});
it("both 64KiB encoded originals plus exact fixed overhead fit below the declared 192KiB cap", () => {
  const nonce = randomUUID(),
    device = Buffer.alloc(65536, 32),
    text = JSON.stringify({ nonce });
  const renderer = Buffer.from(text + " ".repeat(65536 - Buffer.byteLength(text)));
  const value = {
    formatVersion: 1 as const,
    defaultedKeys: [],
    device: { state: "present" as const, base64: device.toString("base64"), sha256: hash(device) },
    renderer: { nonce, digest: hash(renderer), base64: renderer.toString("base64") },
  };
  const encoded = devicePreferencesEvidenceBytes(value);
  expect(encoded.length).toBe(
    174768 +
      devicePreferencesEvidenceBytes({
        ...value,
        device: { ...value.device, base64: "", sha256: hash(Buffer.alloc(0)) },
        renderer: {
          ...value.renderer,
          base64: Buffer.from(text).toString("base64"),
          digest: hash(Buffer.from(text)),
        },
      }).length -
      Buffer.from(text).toString("base64").length,
  );
  expect(encoded.length).toBeLessThan(196608);
});

it("requires a real receipt: cannot skip the combined item, and changed bytes cannot complete its marker", async () => {
  const f = await fixture();
  await f.capture();
  const admit = vi.spyOn(f.backend.imports, "admit").mockRejectedValue(new Error("pause planned"));
  expect((await f.run()).state).toBe("blocked");
  const saved = (await f.saved())!;
  await expect(
    f.backend.imports.record(f.owner, saved.plan.id, {
      ...saved.items[0]!,
      state: "skipped",
      skipReason: "no fake success",
    }),
  ).rejects.toThrow();
  expect((await f.saved())?.items[0]?.state).toBe("pending");
  admit.mockRestore();
  const original = f.backend.engine.publish.bind(f.backend.engine);
  const publish = vi.spyOn(f.backend.engine, "publish").mockImplementation(async (ticket) => {
    const result = await original(ticket);
    if (ticket.target.kind === "settings")
      await writeFile(path.join(f.userData, "device-settings.json"), "{}");
    return result;
  });
  expect((await f.run()).state).toBe("blocked");
  expect((await f.saved())?.complete).toBe(false);
  expect((await f.saved())?.items[0]?.state).toBe("committed");
  await unlink(path.join(f.userData, "device-settings.json"));
  publish.mockClear();
  expect((await f.run()).state).toBe("complete");
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "settings")).toHaveLength(0);
});

it("generation continuation rejects stale, foreign and rolled-back execution identities without changing originals", async () => {
  const f = await fixture();
  const snapshot = await f.capture();
  const request = () => ({
    descriptorId: descriptor.id,
    owner: f.owner,
    evidence: {
      nonce: snapshot.nonce,
      digest: hash(snapshotBytes(snapshot, DEVICE_RENDERER_KEYS)),
    },
    settings: deviceImportSettingsAuthority,
  });
  await f.backend.sources.register({
    descriptorId: descriptor.id,
    mapperId: descriptor.id,
    sourceKind: descriptor.sourceKind,
  });
  // Even before a cached execution binding exists, the durable nonce is a floor.
  await expect(
    f.backend.sources.resolvePreferences({ ...request(), owner: { ...f.owner, generation: 0 } }),
  ).rejects.toThrow();
  const admit = vi
    .spyOn(f.backend.imports, "admit")
    .mockRejectedValue(new Error("pause pristine plan"));
  expect((await f.run()).state).toBe("blocked");
  const original = (await f.saved())!.plan;
  const oldOwner = structuredClone(f.owner);
  f.setOwner();
  await f.backend.sources.resolvePreferences(request());
  for (const owner of [
    oldOwner,
    { ...f.owner, generation: 0 },
    { ...f.owner, generation: f.owner.generation + 1, pluginId: "foreign.plugin" },
    { ...f.owner, generation: f.owner.generation + 1, sourceKey: "builtin:foreign.namespace" },
    { ...f.owner, generation: f.owner.generation + 1, hostEpoch: randomUUID() },
    { ...f.owner, processEpoch: randomUUID() },
  ]) {
    await expect(f.backend.sources.resolvePreferences({ ...request(), owner })).rejects.toThrow();
  }
  await expect(
    f.backend.sources.resolvePreferences({
      ...request(),
      evidence: { ...request().evidence, nonce: randomUUID() },
    }),
  ).rejects.toThrow();
  await expect(
    f.backend.sources.resolvePreferences({
      ...request(),
      evidence: { ...request().evidence, digest: "a".repeat(64) },
    }),
  ).rejects.toThrow();
  await expect(
    f.backend.sources.resolvePreferences({
      ...request(),
      settings: { ...deviceImportSettingsAuthority, validationDigest: "a".repeat(64) },
    }),
  ).rejects.toThrow();
  await expect(
    f.coordinator.acceptPreferencesEvidence({
      ...snapshot,
      entries: snapshot.entries.map((e) => ({ ...e, raw: null })),
    }),
  ).rejects.toThrow();
  // Physical input replacement must not be adopted by the newer owner either.
  await writeFile(path.join(f.userData, "device-settings.json"), "{}");
  expect((await f.backend.sources.inventory(descriptor.id)).state).toBe("blocked");
  await unlink(path.join(f.userData, "device-settings.json"));
  expect((await f.saved())!.plan).toEqual(original);
  admit.mockRestore();
  expect((await f.run()).state).toBe("complete");
  expect((await f.saved())!.plan).toEqual(original);
  expect((await f.saved())!.items[0]?.publicationTicket?.owner).toEqual(f.owner);
});
it("same-worker generation change retains an uncertain original pin until its original receipt is reconciled", async () => {
  const f = await fixture();
  await f.capture();
  const actualPublish = f.backend.engine.publish.bind(f.backend.engine),
    actualReconcile = f.backend.imports.reconcile.bind(f.backend.imports);
  let original: PublicationTicket | undefined;
  const publish = vi.spyOn(f.backend.engine, "publish").mockImplementation(async (ticket) => {
    const result = await actualPublish(ticket);
    if (ticket.target.kind === "settings") {
      original = structuredClone(ticket);
      expect(result.disposition).toBe("committed");
      return { disposition: "unknown" };
    }
    return result;
  });
  const reconcile = vi
    .spyOn(f.backend.imports, "reconcile")
    .mockImplementation((ticket) =>
      ticket.target.kind === "settings"
        ? Promise.resolve({ disposition: "unknown" })
        : actualReconcile(ticket),
    );
  const map = vi.spyOn(f.backend.sources, "map"),
    release = vi.spyOn(f.backend.sources, "releaseMapped");
  expect((await f.run()).state).toBe("blocked");
  const pin = (await map.mock.results.at(-1)!.value).mapped;
  expect(release.mock.calls.some(([id]) => id === pin)).toBe(false);
  const planned = (await f.saved())!.plan;
  f.setOwner();
  expect((await f.run()).state).toBe("blocked");
  expect(release.mock.calls.some(([id]) => id === pin)).toBe(false);
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "settings")).toHaveLength(1);
  reconcile.mockImplementation(actualReconcile);
  expect((await f.run()).state).toBe("complete");
  expect(
    reconcile.mock.calls.some(([ticket]) => JSON.stringify(ticket) === JSON.stringify(original)),
  ).toBe(true);
  expect(release.mock.calls.filter(([id]) => id === pin)).toHaveLength(1);
  expect(publish.mock.calls.filter(([t]) => t.target.kind === "settings")).toHaveLength(1);
  const saved = (await f.saved())!;
  expect(saved.plan).toEqual(planned);
  expect(saved.items[0]?.publicationTicket).toEqual(original);
  expect(saved.items[0]?.receipt?.commitId).toBe(original!.id);
});
