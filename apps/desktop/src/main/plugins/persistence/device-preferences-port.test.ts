import { afterEach, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
import { settingsValidationText } from "../../../../../../packages/plugin-protocol/src/settings.js";
import { AtomicStore } from "./atomic-store.js";
import { createNodePersistenceFs } from "./filesystem.js";
import type { PersistenceBackend, PersistenceEvidencePort } from "./engine-port.js";
import type { HostSettingsNamespace, PersistenceSourcePort } from "./host-port.js";
import { createBoundSettingsService, settingsRequests } from "./settings-service.js";
import {
  createDevicePreferencesPort,
  devicePreferencesResource,
  DEVICE_PREFERENCES_SOURCE,
} from "./device-preferences-port.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "device-preferences-"));
  const owner = {
    sourceKey: DEVICE_PREFERENCES_SOURCE,
    pluginId: "kobrixa.device-ev3",
    generation: 1,
    hostEpoch: randomUUID(),
    processEpoch: randomUUID(),
  };
  const fs = await createNodePersistenceFs(
    root,
    { hostEpoch: owner.hostEpoch, assertHeld() {} },
    { now: () => 0 },
  );
  const store = new AtomicStore(fs);
  await store.initialize();
  const validationDigest = createHash("sha256")
    .update(settingsValidationText(devicePreferencesResource))
    .digest("hex");
  let namespace: HostSettingsNamespace | null = {
    owner,
    resourceDigest: "a".repeat(64),
    uiResourceGeneration: 1,
  };
  let importReady = true;
  const unavailable = (): never => {
    throw new Error("unexpected-port");
  };
  const evidence: PersistenceEvidencePort = {
    quota: unavailable,
    capture: unavailable,
    tickets: unavailable,
    flush: unavailable,
    settingsDigest: (o) => store.settingsDigest(o),
    auxiliary: unavailable,
    auxiliaryKeys: unavailable,
    recoveryPage: unavailable,
    loadRecovery: unavailable,
    saveRecovery: unavailable,
    removeRecovery: unavailable,
  };
  const backend: PersistenceBackend = {
    engine: store,
    reads: store,
    evidence,
    get imports(): never {
      return unavailable();
    },
    get sources(): never {
      return unavailable();
    },
    get output(): never {
      return unavailable();
    },
    get destinations(): never {
      return unavailable();
    },
    dispose: () => store.dispose(),
  };
  const sources: PersistenceSourcePort = {
    current: () => false, // no running plugin, and ordinary eligibility is never relaxed
    coreOwner: () => null, // no window admitted
    settingsNamespace: () => namespace,
    settings: vi.fn(async () =>
      namespace
        ? {
            owner: {
              sourceKey: owner.sourceKey,
              pluginId: owner.pluginId,
              uiResourceGeneration: namespace.uiResourceGeneration,
            },
            resource: structuredClone(devicePreferencesResource),
            validationDigest,
          }
        : null,
    ),
  };
  const events: CommonEventLedgerPort = {
    diagnostics: unavailable,
    resync: unavailable,
    snapshot: unavailable,
    ack: unavailable,
    closeAfterControl: unavailable,
    create: unavailable,
    publish: unavailable,
    activate: unavailable,
    unsubscribe: unavailable,
    owns: unavailable,
    onRemoved: () => () => {},
  };
  createBoundSettingsService({ backend, sources, events, now: () => 0 });
  const service = settingsRequests(backend);
  const port = createDevicePreferencesPort({ backend, importReady: () => importReady });
  cleanups.push(async () => {
    port.dispose();
    await service.dispose();
    await store.dispose();
    await rm(root, { recursive: true, force: true });
  });
  async function update(changes = [{ key: "skipUnchangedAssets", value: false }]) {
    // Trusted test writer uses the SAME actual service/AtomicStore CAS. It grants
    // no authority to the production host reader (which has no mutation method).
    const prior = await service.hostSnapshot(owner.sourceKey, () => importReady);
    return service.requestOwner(
      owner,
      "settings/update",
      { schemaVersion: 1, expectedRevision: prior.snapshot.revision, changes },
      new AbortController().signal,
      async () => {},
    );
  }
  return {
    port,
    service,
    store,
    sources,
    owner,
    update,
    setReady: (value: boolean) => {
      importReady = value;
    },
    disable: () => {
      namespace = null;
    },
    replace: () => {
      namespace = {
        owner: { ...owner, generation: 2 },
        resourceDigest: "a".repeat(64),
        uiResourceGeneration: 2,
      };
    },
  };
}
it("reads nine validated absence defaults without UI, plugin process, ledger or publication", async () => {
  const f = await fixture();
  const publish = vi.spyOn(f.store, "publish");
  const state = await f.port.read();
  expect(state).toMatchObject({
    state: "ready",
    origin: "validated-absent",
    snapshot: { revision: null },
    values: {
      usbRetryInterval: "backoff",
      usbRetryLimit: "unlimited",
      connectionMode: "usb",
      rememberWifiAddress: false,
      lastWifiAddress: "",
    },
  });
  expect(state.state === "ready" && state.snapshot.values.length).toBe(9);
  expect(publish).not.toHaveBeenCalled();
});
it.each(["disabled", "import-pending"])("%s denies resource and namespace I/O", async (reason) => {
  const f = await fixture();
  if (reason === "disabled") f.disable();
  else f.setReady(false);
  const reads = vi.spyOn(f.store, "settings");
  expect((await f.port.read()).state).toBe("unavailable");
  expect(f.sources.settings).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
});
it.each(["replace", "disable", "import-pending"])(
  "%s during read never publishes old values",
  async (reason) => {
    const f = await fixture();
    const gate = deferred(),
      started = deferred();
    const original = f.store.settings.bind(f.store);
    vi.spyOn(f.store, "settings").mockImplementationOnce(async (o) => {
      started.resolve();
      await gate.promise;
      return original(o);
    });
    const read = f.port.read();
    await started.promise;
    if (reason === "replace") f.replace();
    else if (reason === "disable") f.disable();
    else f.setReady(false);
    gate.resolve();
    expect((await read).state).toBe("unavailable");
  },
);
it("commit observer precedes first snapshot; actual CAS refreshes coalesced observers", async () => {
  const f = await fixture();
  const states: unknown[] = [];
  const off = f.port.watch((s) => states.push(s));
  const result = await f.update();
  expect(result.ok).toBe(true);
  await vi.waitFor(() =>
    expect(f.port.getSnapshot()).toMatchObject({
      origin: "committed",
      values: { skipUnchangedAssets: false },
    }),
  );
  expect(states.length).toBeGreaterThan(0);
  off();
  expect(
    await f.service.request(
      { kind: "plugin", owner: f.owner, authorityContext: null },
      "settings/read",
      { schemaVersion: 1 },
      new AbortController().signal,
    ),
  ).toMatchObject({ ok: false });
});
it("a commit during a pending snapshot invalidates it; slow/throw observers do not block receipt", async () => {
  const f = await fixture();
  await f.port.read();
  const gate = deferred(),
    entered = deferred();
  const snapshot = f.service.hostSnapshot.bind(f.service);
  vi.spyOn(f.service, "hostSnapshot").mockImplementationOnce(async (...args) => {
    const value = await snapshot(...args);
    entered.resolve();
    await gate.promise;
    return value;
  });
  const seen: unknown[] = [];
  f.port.watch((s) => {
    seen.push(s);
    throw new Error("observer");
  });
  await entered.promise;
  expect((await f.update()).ok).toBe(true);
  gate.resolve();
  await vi.waitFor(() =>
    expect(f.port.getSnapshot()).toMatchObject({
      origin: "committed",
      values: { skipUnchangedAssets: false },
    }),
  );
  expect(seen).not.toContainEqual(expect.objectContaining({ origin: "validated-absent" }));
});
it("I/O and corrupt/schema failures retain last committed evidence visibly unavailable, never defaults", async () => {
  const f = await fixture();
  await f.update();
  const committed = await f.port.read();
  vi.spyOn(f.store, "settings").mockRejectedValueOnce(new Error("EACCES"));
  expect(await f.port.read()).toMatchObject({ state: "unavailable", lastCommitted: committed });
  vi.spyOn(f.store, "settings").mockResolvedValueOnce({
    schemaVersion: 1,
    revision: "r_" + "1".repeat(32),
    values: [],
  });
  expect(await f.port.read()).toMatchObject({ state: "unavailable", lastCommitted: committed });
});
it("retire and dispose fence pending snapshots and remove observers independent of callback", async () => {
  const f = await fixture();
  const gate = deferred(),
    entered = deferred();
  const original = f.store.settings.bind(f.store);
  vi.spyOn(f.store, "settings").mockImplementationOnce(async (o) => {
    entered.resolve();
    await gate.promise;
    return original(o);
  });
  const read = f.port.read();
  await entered.promise;
  f.service.retire(f.owner.sourceKey);
  gate.resolve();
  expect(await read).toMatchObject({ state: "unavailable", problem: "Settings source retired." });
  expect((await f.port.read()).state).toBe("unavailable");
  f.port.dispose();
  expect((await f.port.read()).state).toBe("unavailable");
});
it("returned snapshots are private and observer bookkeeping is bounded", async () => {
  const f = await fixture();
  const state = await f.port.read();
  if (state.state !== "ready") throw new Error("not ready");
  state.values.usbAutoReconnect = false;
  expect(f.port.getSnapshot()).toMatchObject({ values: { usbAutoReconnect: true } });
  const off = Array.from({ length: 32 }, () => f.port.watch(() => {}));
  expect(() => f.port.watch(() => {})).toThrow("limit");
  off.forEach((fn) => fn());
});
it("cached policy cannot authorize optional I/O after metadata eligibility/import changes", async () => {
  const f = await fixture();
  await f.port.read();
  f.setReady(false);
  expect(f.port.getSnapshot().state).toBe("unavailable");
});
it("disposing while a read is pending cannot return the previous ready state", async () => {
  const f = await fixture();
  await f.port.read();
  const gate = deferred(),
    entered = deferred();
  const original = f.store.settings.bind(f.store);
  vi.spyOn(f.store, "settings").mockImplementationOnce(async (o) => {
    entered.resolve();
    await gate.promise;
    return original(o);
  });
  const read = f.port.read();
  await entered.promise;
  f.port.dispose();
  gate.resolve();
  expect(await read).toMatchObject({ state: "unavailable", problem: "Disposed." });
});
it("dependent reset commits false and empty address atomically through the real store", async () => {
  const f = await fixture();
  await f.port.read();
  const saved = await f.service.requestOwner(
    f.owner,
    "settings/update",
    {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [
        { key: "rememberWifiAddress", value: true },
        { key: "lastWifiAddress", value: "192.168.0.2" },
      ],
    },
    new AbortController().signal,
    async () => {},
  );
  if (!saved.ok) throw new Error("initial CAS failed");
  const reset = await f.service.requestOwner(
    f.owner,
    "settings/reset",
    {
      schemaVersion: 1,
      expectedRevision: saved.value.snapshot.revision,
      keys: ["rememberWifiAddress"],
    },
    new AbortController().signal,
    async () => {},
  );
  expect(reset).toMatchObject({ ok: true });
  if (!reset.ok) throw new Error("reset failed");
  expect(reset.value.snapshot.values).toContainEqual({ key: "lastWifiAddress", value: "" });
  expect(await f.port.read()).toMatchObject({
    state: "ready",
    values: { rememberWifiAddress: false, lastWifiAddress: "" },
    snapshot: { revision: reset.value.receipt.revision },
  });
});
it("already resolved snapshot is rejected if the namespace retires before the reader continuation", async () => {
  const f = await fixture();
  const snapshot = f.service.hostSnapshot.bind(f.service);
  vi.spyOn(f.service, "hostSnapshot").mockImplementationOnce(async (...args) => {
    const value = await snapshot(...args);
    queueMicrotask(() => f.disable());
    return value;
  });
  expect((await f.port.read()).state).toBe("unavailable");
});
it("real store: failed dependent update leaves BOTH committed values, then competing CAS publishes only one", async () => {
  const f = await fixture();
  await f.port.read();
  const request = (
    changes: Array<{ key: string; value: string | boolean }>,
    expectedRevision: string | null,
  ) =>
    f.service.requestOwner(
      f.owner,
      "settings/update",
      { schemaVersion: 1, expectedRevision, changes },
      new AbortController().signal,
      async () => {},
    );
  const first = await request(
    [
      { key: "rememberWifiAddress", value: true },
      { key: "lastWifiAddress", value: "192.168.0.2" },
    ],
    null,
  );
  if (!first.ok) throw new Error("seed failed");
  vi.spyOn(f.store, "seal").mockRejectedValueOnce(new Error("ENOSPC"));
  expect(
    (await request([{ key: "rememberWifiAddress", value: false }], first.value.receipt.revision))
      .ok,
  ).toBe(false);
  expect(await f.port.read()).toMatchObject({
    state: "ready",
    values: { rememberWifiAddress: true, lastWifiAddress: "192.168.0.2" },
    snapshot: { revision: first.value.receipt.revision },
  });
  const publish = vi.spyOn(f.store, "publish");
  const results = await Promise.all([
    request([{ key: "rememberWifiAddress", value: false }], first.value.receipt.revision),
    request([{ key: "lastWifiAddress", value: "192.168.0.3" }], first.value.receipt.revision),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(await f.port.read()).toMatchObject({
    state: "ready",
    values: { rememberWifiAddress: false, lastWifiAddress: "" },
  });
  const current = await f.port.read();
  if (current.state !== "ready") throw new Error("read failed");
  const explicit = await request(
    [{ key: "lastWifiAddress", value: "192.168.0.4" }],
    current.snapshot.revision,
  );
  expect(explicit.ok && explicit.value.snapshot.values).toContainEqual({
    key: "lastWifiAddress",
    value: "",
  });
});
