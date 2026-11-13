import { mkdtemp, realpath, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { startPersistenceWorker, shippedLegacySourceRoots } from "./worker.js";
import { openStoreRoot } from "./filesystem.js";
import { sensorLabImportDescriptors } from "./sensor-lab-import.js";
import { importIdFor, barrierKeyFor, parseBarrierDocument } from "./import-sources.js";
import type { PublicationTicket } from "./engine-port.js";
import { SensorLabMigrationGate } from "./sensor-lab-migration.js";
import { legacy, id, bytes } from "../../../builtin-features/sensor-lab/legacy-import.test.js";
let directory: string, entry: string;
beforeAll(async () => {
  directory = await realpath(await mkdtemp(path.join(tmpdir(), "shipped-lab-import-")));
  const source = path.join(directory, "entry.ts");
  await writeFile(
    source,
    `import { runShippedPersistenceWorker } from ${JSON.stringify(fileURLToPath(new URL("./worker.ts", import.meta.url)))};runShippedPersistenceWorker();`,
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
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function launch(userData: string) {
  await mkdir(userData, { recursive: true });
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const root = await openStoreRoot({ userData, profile });
  return {
    ...(await startPersistenceWorker({
      profile,
      root,
      workerEntry: entry,
      now: () => performance.now(),
    })),
    profile,
  };
}
it("derives fixed source paths only from the profile store", () => {
  const roots = shippedLegacySourceRoots(path.resolve("/profile/plugins/persistence-v1"));
  expect([...roots.values()]).toEqual([
    path.resolve("/profile/sensor-lab/recordings"),
    path.resolve("/profile/sensor-lab/calibrations"),
    path.resolve("/profile"),
  ]);
  for (const root of [
    "relative/plugins/persistence-v1",
    path.resolve("/profile/other/persistence-v1"),
    `${path.resolve("/profile/plugins")}${path.sep}..${path.sep}plugins${path.sep}persistence-v1`,
  ])
    expect(() => shippedLegacySourceRoots(root)).toThrow("invalid-store-root");
});
it("cold worker startup does not inspect disabled legacy roots; later admitted reads reject symlinks", async () => {
  const profile = path.join(directory, randomUUID());
  await mkdir(profile);
  const outside = path.join(directory, randomUUID());
  await mkdir(outside);
  await symlink(outside, path.join(profile, "sensor-lab"));
  const launched = await launch(profile);
  try {
    const descriptor = sensorLabImportDescriptors[0]!;
    // Boot succeeded despite inaccessible-by-policy legacy root; no eager mapper run.
    await launched.backend.sources.register({
      descriptorId: descriptor.id,
      mapperId: descriptor.id,
      sourceKind: descriptor.sourceKind,
    });
    expect((await launched.backend.sources.inventory(descriptor.id)).state).toBe("blocked");
  } finally {
    await launched.backend.dispose();
  }
});
it("shipped worker imports true legacy envelopes and treats an absent new-install root as empty", async () => {
  const profile = path.join(directory, randomUUID()),
    recordings = path.join(profile, "sensor-lab", "recordings");
  await mkdir(recordings, { recursive: true });
  await writeFile(path.join(recordings, `${id}.json`), bytes(legacy()));
  const launched = await launch(profile);
  try {
    for (const descriptor of sensorLabImportDescriptors)
      await launched.backend.sources.register({
        descriptorId: descriptor.id,
        mapperId: descriptor.id,
        sourceKind: descriptor.sourceKind,
      });
    const record = sensorLabImportDescriptors[0]!,
      calibration = sensorLabImportDescriptors[1]!;
    expect(await launched.backend.sources.inventory(record.id)).toMatchObject({
      state: "present",
      entries: [{ key: `${id}.json`, format: 1 }],
    });
    expect(await launched.backend.sources.inventory(calibration.id)).toEqual({
      state: "absent",
      entries: [],
    });
    const mapped = await launched.backend.sources.map(record.id, `${id}.json`);
    expect(mapped).toMatchObject({
      kind: "record",
      metadata: { kind: "sensor-lab.recording", schemaVersion: 2 },
    });
    await launched.backend.sources.releaseMapped(mapped.mapped);
  } finally {
    await launched.backend.dispose();
  }
});

// Multiple real worker publications/retries exceed 5 s on Windows CI.
it("gates activation on both durable imports and never registers or maps a disabled source", async () => {
  const profile = path.join(directory, randomUUID()),
    base = path.join(profile, "sensor-lab");
  await mkdir(path.join(base, "recordings"), { recursive: true });
  await mkdir(path.join(base, "calibrations"));
  const source = legacy();
  await writeFile(path.join(base, "recordings", `${id}.json`), bytes(source));
  await writeFile(
    path.join(base, "calibrations", `${id}.json`),
    bytes({ schemaVersion: 1, profile: { id, name: "Profile", ...source.channels[0]! } }),
  );
  const launched = await launch(profile);
  let active = false,
    frozen = false;
  const register = vi.spyOn(launched.backend.sources, "register");
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const writer = {
    sourceKey: owner.sourceKey,
    freezeAdmission() {
      frozen = true;
    },
    async settled() {
      expect(frozen).toBe(true);
    },
  };
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [writer],
    active: () => active,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    await expect(gate.prepare(new AbortController().signal)).rejects.toThrow("not admitted");
    expect(register).not.toHaveBeenCalled();
    expect(frozen).toBe(false);
    active = true;
    await Promise.all([
      gate.prepare(new AbortController().signal),
      gate.prepare(new AbortController().signal),
    ]);
    const records = await launched.backend.reads.list(owner, { limit: 64 });
    expect(records.entries.map((r) => r.kind).sort()).toEqual([
      "sensor-lab.calibration",
      "sensor-lab.recording",
    ]);
    expect(register).toHaveBeenCalledTimes(2);
    expect(frozen).toBe(true);
    await gate.prepare(new AbortController().signal);
    expect(register).toHaveBeenCalledTimes(2);
    // Re-entry from a new host gate reuses durable markers rather than copying again.
    const reopened = new SensorLabMigrationGate({
      backend: launched.backend,
      writers: [writer],
      active: () => active,
      owner: () => owner,
      currentScope: () => true,
    });
    await reopened.prepare(new AbortController().signal);
    expect((await launched.backend.reads.list(owner, { limit: 64 })).entries).toHaveLength(2);
  } finally {
    await launched.backend.dispose();
  }
}, 30000);
// Multiple real worker publications/retries exceed 5 s on Windows CI.
it("does not pass a half-completed migration when the other source is malformed", async () => {
  const profile = path.join(directory, randomUUID()),
    base = path.join(profile, "sensor-lab");
  await mkdir(path.join(base, "recordings"), { recursive: true });
  await mkdir(path.join(base, "calibrations"));
  await writeFile(path.join(base, "recordings", `${id}.json`), bytes(legacy()));
  await writeFile(path.join(base, "calibrations", `${id}.json`), Buffer.from("invalid"));
  const launched = await launch(profile),
    owner = {
      sourceKey: "builtin:kobrixa.sensor-lab",
      pluginId: "kobrixa.sensor-lab",
      generation: 1,
      hostEpoch: launched.profile.hostEpoch,
      processEpoch: launched.profile.hostEpoch,
    };
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    await expect(gate.prepare(new AbortController().signal)).rejects.toThrow("migration blocked");
    expect((await launched.backend.reads.list(owner, { limit: 64 })).entries).toHaveLength(1);
    const source = legacy();
    await writeFile(
      path.join(base, "calibrations", `${id}.json`),
      bytes({ schemaVersion: 1, profile: { id, name: "Profile", ...source.channels[0]! } }),
    );
    await gate.prepare(new AbortController().signal);
    expect((await launched.backend.reads.list(owner, { limit: 64 })).entries).toHaveLength(2);
  } finally {
    await launched.backend.dispose();
  }
}, 30000);

// Multiple real worker publications/retries exceed 5 s on Windows CI.
it("reconciles original retained maps across retries without exhausting worker slots", async () => {
  const profile = path.join(directory, randomUUID()),
    base = path.join(profile, "sensor-lab", "recordings");
  await mkdir(base, { recursive: true });
  for (let n = 0; n < 5; n++) {
    const rec = { ...legacy(), id: randomUUID() };
    await writeFile(path.join(base, rec.id + ".json"), bytes(rec));
  }
  const launched = await launch(profile),
    backend = launched.backend;
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const originalPublish = backend.engine.publish.bind(backend.engine),
    originalReconcile = backend.imports.reconcile.bind(backend.imports);
  const uncertain = new Set<string>(),
    mapped = new Set<string>();
  let uncertainRecords = 0;
  vi.spyOn(backend.engine, "publish").mockImplementation(async (ticket) => {
    const result = await originalPublish(ticket);
    if (ticket.metadata.kind === "record" && uncertainRecords++ < 4) {
      uncertain.add(ticket.id);
      return { disposition: "unknown" };
    }
    return result;
  });
  vi.spyOn(backend.imports, "reconcile").mockImplementation(async (ticket) => {
    if (uncertain.delete(ticket.id)) return { disposition: "unknown" };
    return originalReconcile(ticket);
  });
  const map = backend.sources.map.bind(backend.sources),
    release = backend.sources.releaseMapped.bind(backend.sources);
  vi.spyOn(backend.sources, "map").mockImplementation(async (...args) => {
    const result = await map(...args);
    mapped.add(result.mapped);
    return result;
  });
  vi.spyOn(backend.sources, "releaseMapped").mockImplementation(async (handle) => {
    await release(handle);
    mapped.delete(handle);
  });
  const gate = new SensorLabMigrationGate({
    backend,
    writers: [],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    for (let n = 0; n < 4; n++)
      await expect(gate.prepare(new AbortController().signal)).rejects.toThrow("blocked");
    expect(mapped.size).toBe(1);
    await gate.prepare(new AbortController().signal);
    expect((await backend.reads.list(owner, { limit: 64 })).entries).toHaveLength(5);
    expect(uncertain.size).toBe(0);
    expect(mapped.size).toBe(0);
    for (const descriptor of sensorLabImportDescriptors) {
      expect(
        (await backend.imports.load(owner, importIdFor(descriptor.id, owner.sourceKey)))?.complete,
      ).toBe(true);
      const marker = await backend.evidence.auxiliary(
        owner,
        "import",
        barrierKeyFor(descriptor.id),
      );
      expect(parseBarrierDocument(marker!).state).toBe("complete");
    }
    expect(() => gate.assertReady()).not.toThrow();
  } finally {
    await backend.dispose();
  }
}, 30000);
it("first caller cancellation does not fail a live coalesced caller", async () => {
  const launched = await launch(path.join(directory, randomUUID()));
  let release!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((r) => {
    entered = r;
  });
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [
      {
        sourceKey: owner.sourceKey,
        freezeAdmission() {},
        async settled() {
          entered();
          await wait;
        },
      },
    ],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  const first = new AbortController(),
    second = new AbortController();
  try {
    const a = gate.prepare(first.signal).then(
      () => "ready",
      () => "rejected",
    );
    await enteredPromise;
    const b = gate.prepare(second.signal).then(
      () => "ready",
      () => "rejected",
    );
    first.abort();
    expect(await a).toBe("rejected");
    release();
    expect(await b).toBe("ready");
    expect(second.signal.aborted).toBe(false);
    // A fresh call immediately succeeds with both empty descriptor markers.
    await gate.prepare(second.signal);
    expect(() => gate.assertReady()).not.toThrow();
  } finally {
    release();
    await launched.backend.dispose();
  }
});
// Multiple real worker publications/retries exceed 5 s on Windows CI.
it("disabled and replaced owners cannot resume source reads after a pending writer settles", async () => {
  for (const mode of ["disable", "generation", "processEpoch"] as const) {
    const launched = await launch(path.join(directory, randomUUID()));
    let active = true,
      release!: () => void,
      entered!: () => void;
    const wait = new Promise<void>((r) => {
        release = r;
      }),
      started = new Promise<void>((r) => {
        entered = r;
      });
    const owner = {
      sourceKey: "builtin:kobrixa.sensor-lab",
      pluginId: "kobrixa.sensor-lab",
      generation: 1,
      hostEpoch: launched.profile.hostEpoch,
      processEpoch: launched.profile.hostEpoch,
    };
    const inventory = vi.spyOn(launched.backend.sources, "inventory");
    const gate = new SensorLabMigrationGate({
      backend: launched.backend,
      writers: [
        {
          sourceKey: owner.sourceKey,
          freezeAdmission() {},
          async settled() {
            entered();
            await wait;
          },
        },
      ],
      active: () => active,
      owner: () => owner,
      currentScope: () => true,
    });
    try {
      const pending = gate.prepare(new AbortController().signal).then(
        () => "ready",
        () => "rejected",
      );
      await started;
      if (mode === "disable") active = false;
      else if (mode === "generation") owner.generation++;
      else owner.processEpoch = randomUUID();
      release();
      expect(await pending).toBe("rejected");
      expect(inventory).not.toHaveBeenCalled();
      active = true;
      await gate.prepare(new AbortController().signal);
      expect(inventory).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await launched.backend.dispose();
    }
  }
}, 30000);

it("owner transitions reconcile retained original tickets but publish only under the new owner", async () => {
  const profile = path.join(directory, randomUUID()),
    base = path.join(profile, "sensor-lab", "recordings");
  await mkdir(base, { recursive: true });
  for (let n = 0; n < 2; n++) {
    const rec = { ...legacy(), id: randomUUID() };
    await writeFile(path.join(base, rec.id + ".json"), bytes(rec));
  }
  const launched = await launch(profile),
    backend = launched.backend;
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const publish = backend.engine.publish.bind(backend.engine),
    reconcile = backend.imports.reconcile.bind(backend.imports);
  let original: PublicationTicket | undefined,
    unknown = true;
  const publishes = vi.spyOn(backend.engine, "publish").mockImplementation(async (ticket) => {
    const result = await publish(ticket);
    if (ticket.metadata.kind === "record" && !original) {
      original = structuredClone(ticket);
      return { disposition: "unknown" };
    }
    return result;
  });
  const reconciles = vi.spyOn(backend.imports, "reconcile").mockImplementation(async (ticket) => {
    if (unknown && ticket.id === original?.id) return { disposition: "unknown" };
    return reconcile(ticket);
  });
  const release = vi.spyOn(backend.sources, "releaseMapped");
  const gate = new SensorLabMigrationGate({
    backend,
    writers: [],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    await expect(gate.prepare(new AbortController().signal)).rejects.toThrow("blocked");
    expect(original).toBeDefined();
    owner.generation++;
    owner.processEpoch = randomUUID();
    const count = publishes.mock.calls.length,
      released = release.mock.calls.length;
    await expect(gate.prepare(new AbortController().signal)).rejects.toThrow("unknown");
    expect(publishes.mock.calls).toHaveLength(count);
    expect(release.mock.calls).toHaveLength(released);
    unknown = false;
    await gate.prepare(new AbortController().signal);
    gate.assertReady();
    expect(
      reconciles.mock.calls.some(([ticket]) => JSON.stringify(ticket) === JSON.stringify(original)),
    ).toBe(true);
    expect(
      publishes.mock.calls
        .slice(count)
        .every(
          ([ticket]) =>
            ticket.owner.generation === 2 && ticket.owner.processEpoch === owner.processEpoch,
        ),
    ).toBe(true);
    expect(release.mock.calls.length).toBeGreaterThan(released);
    expect((await backend.reads.list(owner, { limit: 64 })).entries).toHaveLength(2);
  } finally {
    await backend.dispose();
  }
});
it("joining caller cancellation is prompt and does not cancel the original caller", async () => {
  const launched = await launch(path.join(directory, randomUUID()));
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [
      {
        sourceKey: owner.sourceKey,
        freezeAdmission() {},
        async settled() {
          entered();
          await wait;
        },
      },
    ],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    const original = gate.prepare(new AbortController().signal);
    await started;
    const cancel = new AbortController();
    const join = gate.prepare(cancel.signal).then(
      () => "ready",
      () => "cancelled",
    );
    cancel.abort();
    expect(await join).toBe("cancelled");
    release();
    await original;
    gate.assertReady();
  } finally {
    release();
    await launched.backend.dispose();
  }
});
it("all callers cancelled stop before inventory; one fresh caller can wait for cleanup and retry", async () => {
  const launched = await launch(path.join(directory, randomUUID()));
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const inventory = vi.spyOn(launched.backend.sources, "inventory");
  let settlements = 0;
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [
      {
        sourceKey: owner.sourceKey,
        freezeAdmission() {},
        async settled() {
          if (++settlements === 1) {
            entered();
            await wait;
          }
        },
      },
    ],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    const cancel = new AbortController();
    const old = gate.prepare(cancel.signal).then(
      () => "ready",
      () => "cancelled",
    );
    await started;
    cancel.abort();
    expect(await old).toBe("cancelled");
    expect(inventory).not.toHaveBeenCalled();
    const fresh = gate.prepare(new AbortController().signal);
    release();
    await fresh;
    gate.assertReady();
    expect(inventory).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await launched.backend.dispose();
  }
});
it("assertReady synchronously rejects disabled, forged and changed owners without I/O", async () => {
  const launched = await launch(path.join(directory, randomUUID()));
  let active = true;
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [],
    active: () => active,
    owner: () => owner,
    currentScope: () => true,
  });
  const inventory = vi.spyOn(launched.backend.sources, "inventory"),
    load = vi.spyOn(launched.backend.imports, "load");
  try {
    expect(() => gate.assertReady()).toThrow();
    await gate.prepare(new AbortController().signal);
    gate.assertReady();
    const counts = [inventory.mock.calls.length, load.mock.calls.length];
    active = false;
    expect(() => gate.assertReady()).toThrow();
    active = true;
    for (const key of [
      "sourceKey",
      "pluginId",
      "generation",
      "hostEpoch",
      "processEpoch",
    ] as const) {
      const saved = { ...owner };
      Object.assign(owner, { [key]: key === "generation" ? 2 : "changed" });
      expect(() => gate.assertReady()).toThrow();
      Object.assign(owner, saved);
    }
    expect([inventory.mock.calls.length, load.mock.calls.length]).toEqual(counts);
  } finally {
    await launched.backend.dispose();
  }
});
it("bounds cancelled waiter attachments while a shared attempt remains pending", async () => {
  const launched = await launch(path.join(directory, randomUUID()));
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [
      {
        sourceKey: owner.sourceKey,
        freezeAdmission() {},
        async settled() {
          entered();
          await wait;
        },
      },
    ],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    const original = gate.prepare(new AbortController().signal);
    await started;
    for (let n = 0; n < 31; n++) {
      const cancel = new AbortController(),
        joined = gate.prepare(cancel.signal).catch(() => {});
      cancel.abort();
      await joined;
    }
    await expect(gate.prepare(new AbortController().signal)).rejects.toThrow("caller limit");
    release();
    await original;
    gate.assertReady();
  } finally {
    release();
    await launched.backend.dispose();
  }
});

it("synchronous cancellation during legacy freeze cannot leave an unowned migration running", async () => {
  const launched = await launch(path.join(directory, randomUUID())),
    cancel = new AbortController();
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: launched.profile.hostEpoch,
    processEpoch: launched.profile.hostEpoch,
  };
  const inventory = vi.spyOn(launched.backend.sources, "inventory");
  const gate = new SensorLabMigrationGate({
    backend: launched.backend,
    writers: [
      {
        sourceKey: owner.sourceKey,
        freezeAdmission() {
          cancel.abort();
        },
        async settled() {},
      },
    ],
    active: () => true,
    owner: () => owner,
    currentScope: () => true,
  });
  try {
    await expect(gate.prepare(cancel.signal)).rejects.toThrow();
    await Promise.resolve();
    expect(inventory).not.toHaveBeenCalled();
    expect(() => gate.assertReady()).toThrow();
  } finally {
    await launched.backend.dispose();
  }
});
