import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  open,
  rm,
  writeFile,
  readFile,
  readdir,
  rename,
  stat,
} from "node:fs/promises";
import { openStoreRoot } from "../../apps/desktop/src/main/plugins/persistence/filesystem.ts";
import { startPersistenceWorker } from "../../apps/desktop/src/main/plugins/persistence/worker.ts";
import { createLegacyWriterBarrier } from "../../apps/desktop/src/main/plugins/persistence/import-sources.ts";
import { createLegacyImportCoordinator } from "../../apps/desktop/src/main/plugins/persistence/import-coordinator.ts";
import { syntheticImportDescriptor as descriptor } from "../../apps/desktop/src/main/plugins/persistence/import-fixtures.ts";
import { sensorLabImportDescriptors } from "../../apps/desktop/src/main/plugins/persistence/sensor-lab-import.ts";
import { channelKey } from "../../plugins/sensor-lab/src/model/data.ts";
import { identityCalibration } from "../../plugins/sensor-lab/src/model/calibration.ts";

async function launch(
  root,
  testControl,
  importDescriptor = descriptor,
  expectedRecovery = "ready",
) {
  const profile = { hostEpoch: randomUUID(), assertHeld() {} };
  const { backend, recovery } = await startPersistenceWorker({
    profile,
    testControl,
    root: await openStoreRoot({ userData: root, profile }),
    now: () => performance.now(),
    workerEntry: fileURLToPath(
      new URL("./fixtures/plugin-persistence/stream-import-worker.mjs", import.meta.url),
    ),
  });
  if (recovery !== expectedRecovery) await backend.dispose();
  assert.equal(recovery, expectedRecovery);
  const owner = {
    sourceKey: importDescriptor.targetSourceKey,
    pluginId: importDescriptor.id,
    generation: 1,
    hostEpoch: profile.hostEpoch,
    processEpoch: randomUUID(),
  };
  const options = { backend, descriptors: [importDescriptor], importOwner: () => owner };
  const coordinator = createLegacyImportCoordinator({
    ...options,
    sources: backend.sources,
    currentSource: () => true,
    currentScope: () => true,
    barrier: createLegacyWriterBarrier({ ...options, writers: [] }),
  });
  return { backend, owner, coordinator };
}
test("Node worker streams 50 distinct maximum-size originals into byte-identical destinations", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "node-import-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  await mkdir(legacy);
  const chunk = Buffer.alloc(262144, 0x61),
    expected = [];
  for (let i = 0; i < 50; i++) {
    const head = Buffer.from(JSON.stringify({ formatVersion: 1, id: i, payload: "" }).slice(0, -2));
    const fd = await open(path.join(legacy, i + ".json"), "wx");
    const hash = createHash("sha256");
    try {
      for (let n = 0; n < 32; n++) {
        chunk.fill(0x61);
        if (!n) head.copy(chunk);
        if (n === 31) chunk.write('"}', chunk.length - 2);
        await fd.writeFile(chunk);
        hash.update(chunk);
      }
    } finally {
      await fd.close();
    }
    expected.push(hash.digest("hex"));
  }
  const { backend, owner, coordinator } = await launch(root);
  try {
    const started = performance.now();
    const baseline = process.memoryUsage.rss();
    let peak = baseline,
      inventoryPeak;
    const inventory = backend.sources.inventory;
    backend.sources.inventory = async (...args) => {
      const result = await inventory(...args);
      inventoryPeak = Math.max(peak, process.memoryUsage.rss());
      return result;
    };
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 20);
    try {
      assert.deepEqual(await coordinator.run(descriptor, new AbortController().signal), {
        state: "complete",
        completedItems: 50,
        totalItems: 50,
      });
    } finally {
      clearInterval(timer);
    }
    const end = process.memoryUsage.rss();
    peak = Math.max(peak, end);
    t.diagnostic(
      JSON.stringify({
        importMs: Math.round(performance.now() - started),
        baseline,
        peak,
        end,
        inventoryDelta: inventoryPeak - baseline,
        peakDelta: peak - baseline,
        endDelta: end - baseline,
      }),
    );
    const records = (await backend.reads.list(owner, { limit: 64 })).entries;
    assert.equal(records.length, 50);
    const actual = [];
    for (const r of records) {
      const hash = createHash("sha256");
      const pin = await backend.reads.open(owner, r.id, r.revision);
      try {
        assert.equal((await backend.reads.read(owner, pin, r.byteLength, 262144)).length, 0);
        for (let offset = 0; offset < 8388608; offset += 262144) {
          const bytes = await backend.reads.read(owner, pin, offset, 262144);
          assert.equal(bytes.length, 262144);
          hash.update(bytes);
        }
      } finally {
        await backend.reads.close(owner, pin);
      }
      actual.push(hash.digest("hex"));
    }
    assert.deepEqual(actual.sort(), expected.sort());
    // Standalone Node regression guard. Electron acceptance uses its own sampling and thresholds.
    assert.ok(peak - baseline < 128 * 1024 * 1024, "whole-file import working set");
  } finally {
    await backend.dispose();
  }
});

for (const boundary of ["inventory", "plan", "map", "tagImport", "appendMapped"]) {
  test("fresh worker resumes after " + boundary, async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "node-import-restart-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const legacy = path.join(root, "legacy");
    await mkdir(legacy);
    const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, large: "x".repeat(280000) }));
    await writeFile(path.join(legacy, "one"), bytes);
    const signal = new AbortController();
    let f = await launch(root);
    const port =
      boundary === "tagImport" || boundary === "plan" ? f.backend.imports : f.backend.sources;
    const call = port[boundary].bind(port);
    port[boundary] = async (...args) => {
      const result = await call(...args);
      signal.abort();
      return result;
    };
    try {
      assert.equal((await f.coordinator.run(descriptor, signal.signal)).state, "blocked");
      assert.ok(signal.signal.aborted);
    } finally {
      await f.backend.dispose();
    }
    f = await launch(root);
    try {
      assert.deepEqual(await f.coordinator.run(descriptor, new AbortController().signal), {
        state: "complete",
        totalItems: 1,
        completedItems: 1,
      });
      const records = (await f.backend.reads.list(f.owner, { limit: 64 })).entries;
      assert.deepEqual(
        records.map((r) => r.sha256),
        [createHash("sha256").update(bytes).digest("hex")],
      );
    } finally {
      await f.backend.dispose();
    }
  });
}
for (const [boundary, save, order] of [
  ["after plan"],
  ["after seal"],
  ...["in-place", "rename", "move-away"].flatMap((save) =>
    ["changed-first", "good-first"].map((order) => ["during append", save, order]),
  ),
]) {
  test(
    ["a source changed", boundary, save, order, "stays pending while the other item commits"]
      .filter(Boolean)
      .join(" "),
    async (t) => {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "node-import-change-")));
      t.after(() => rm(root, { recursive: true, force: true }));
      const legacy = path.join(root, "legacy");
      await mkdir(legacy);
      const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, value: "a".repeat(300000) }));
      const good = Buffer.from('{"formatVersion":1,"other":true}');
      const leaf = path.join(legacy, "changed");
      await writeFile(leaf, bytes);
      await writeFile(path.join(legacy, "good"), good);
      const f = await launch(root),
        changed = Buffer.from(bytes);
      changed[280000] = 98;
      try {
        if (boundary === "after plan") {
          const plan = f.backend.imports.plan;
          f.backend.imports.plan = async (...args) => {
            await plan(...args);
            await writeFile(leaf, changed);
          };
        } else if (boundary === "after seal") {
          const seal = f.backend.engine.seal;
          f.backend.engine.seal = async (ticket, length, sha) => {
            await seal(ticket, length, sha);
            if (ticket.target.kind === "record" && length === bytes.length)
              await writeFile(leaf, changed);
          };
        } else {
          const inventory = f.backend.sources.inventory;
          f.backend.sources.inventory = async (...args) => {
            const result = await inventory(...args);
            result.entries.sort(
              (a, b) => a.key.localeCompare(b.key) * (order === "changed-first" ? 1 : -1),
            );
            return result;
          };
          const append = f.backend.sources.appendMapped;
          f.backend.sources.appendMapped = async (input) => {
            const result = await append(input);
            if (!result.done) {
              if (save === "rename") {
                await writeFile(leaf + ".new", changed);
                await rename(leaf + ".new", leaf);
              } else if (save === "move-away") await rename(leaf, path.join(root, "moved"));
              else await writeFile(leaf, changed);
            }
            return result;
          };
        }
        assert.deepEqual(await f.coordinator.run(descriptor, new AbortController().signal), {
          state: "blocked",
          completedItems: 1,
          totalItems: 2,
        });
        const records = (await f.backend.reads.list(f.owner, { limit: 64 })).entries;
        assert.deepEqual(
          records.map((r) => r.sha256),
          [createHash("sha256").update(good).digest("hex")],
        );
      } finally {
        await f.backend.dispose();
      }
      await writeFile(leaf, bytes);
      const fresh = await launch(root);
      try {
        assert.deepEqual(await fresh.coordinator.run(descriptor, new AbortController().signal), {
          state: "complete",
          completedItems: 2,
          totalItems: 2,
        });
      } finally {
        await fresh.backend.dispose();
      }
    },
  );
}
test("worker blocks invalid UTF-8, malformed JSON and unsupported source schema", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "node-import-invalid-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  await mkdir(legacy);
  const f = await launch(root);
  try {
    await f.backend.sources.register({
      descriptorId: descriptor.id,
      mapperId: descriptor.id,
      sourceKind: descriptor.sourceKind,
    });
    for (const bytes of [
      Buffer.from([0xff]),
      Buffer.from('{"formatVersion":1,'),
      Buffer.from('{"formatVersion":"1"}'),
    ]) {
      await writeFile(path.join(legacy, "item"), bytes);
      assert.deepEqual(await f.backend.sources.inventory(descriptor.id), {
        state: "blocked",
        entries: [],
      });
    }
  } finally {
    await f.backend.dispose();
  }
});

test("fresh worker resumes after sudden death with open source and stage descriptors", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "abrupt-import-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "legacy"));
  const bytes = Buffer.from(JSON.stringify({ formatVersion: 1, payload: "x".repeat(300000) }));
  await writeFile(path.join(root, "legacy", "one"), bytes);
  let control;
  const f = await launch(root, (c) => (control = c));
  const append = f.backend.sources.appendMapped;
  let killed = false,
    abandonedStage;
  f.backend.sources.appendMapped = async (input) => {
    const result = await append(input);
    assert.equal(result.done, false);
    abandonedStage = path.join(
      root,
      "plugins",
      "persistence-v1",
      "namespaces",
      createHash("sha256").update(f.owner.sourceKey).digest("hex"),
      "staging",
      input.ticket.id,
      "payload.tmp",
    );
    assert.equal((await stat(abandonedStage)).size, 262144);
    await control.terminate();
    killed = true;
    return result;
  };
  try {
    assert.equal(
      (await f.coordinator.run(descriptor, new AbortController().signal)).state,
      "blocked",
    );
    assert.equal(killed, true);
  } finally {
    await assert.rejects(f.backend.dispose(), /worker-dispose-unknown/);
  }
  const fresh = await launch(root);
  try {
    await assert.rejects(stat(abandonedStage), { code: "ENOENT" });
    assert.deepEqual(await fresh.coordinator.run(descriptor, new AbortController().signal), {
      state: "complete",
      totalItems: 1,
      completedItems: 1,
    });
    const entries = (await fresh.backend.reads.list(fresh.owner, { limit: 64 })).entries;
    assert.deepEqual(
      entries.map((r) => r.sha256),
      [createHash("sha256").update(bytes).digest("hex")],
    );
  } finally {
    await fresh.backend.dispose();
  }
});

for (const [kind, fault] of [
  ["identity", "drop-map"],
  ["checked", "drop-map"],
  ["checked", "cancel-before-map"],
])
  test("lost map response releases " + kind + " capacity (" + fault + ")", async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "lost-map-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const id = kind === "checked" ? "test.checked-import" : descriptor.id;
    const folder = path.join(root, kind === "checked" ? "checked" : "legacy");
    await mkdir(folder);
    if (kind === "checked") await mkdir(path.join(root, "legacy"));
    await writeFile(path.join(folder, "item"), '{"formatVersion":1}');
    await writeFile(path.join(root, "fault"), fault);
    const f = await launch(root);
    try {
      const sources = f.backend.sources;
      await sources.register({ descriptorId: id, mapperId: id, sourceKind: "sensor-lab" });
      await assert.rejects(sources.map(id, "item"), /timeout/);
      const held = [];
      for (let i = 0; i < (kind === "checked" ? 1 : 4); i++)
        held.push(await sources.map(id, "item"));
      await assert.rejects(sources.map(id, "item"), /quota/);
      for (const mapped of held) await sources.releaseMapped(mapped.mapped);
    } finally {
      await f.backend.dispose();
    }
  });

for (const phase of ["inventory", "inventory directory", "failed map", "release", "dispose"])
  test("contains source close failure during " + phase, async (t) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "source-close-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const legacy = path.join(root, "legacy"),
      file = path.join(legacy, "item");
    await mkdir(legacy);
    await writeFile(file, '{"formatVersion":1}');
    await writeFile(
      path.join(root, "fault"),
      phase === "inventory directory" ? "inventory-directory-close" : "source-close",
    );
    const f = await launch(root);
    const sources = f.backend.sources;
    try {
      await sources.register({
        descriptorId: descriptor.id,
        mapperId: descriptor.id,
        sourceKind: "sensor-lab",
      });
      const held = [];
      if (phase === "release" || phase === "dispose")
        for (let i = 0; i < 3; i++) held.push(await sources.map(descriptor.id, "item"));
      if (phase === "failed map") {
        assert.equal((await sources.inventory(descriptor.id)).state, "present");
        await writeFile(file, '{"formatVersion":11}');
      }
      await writeFile(path.join(root, "armed"), "");
      if (phase === "inventory" || phase === "inventory directory")
        assert.equal((await sources.inventory(descriptor.id)).state, "blocked");
      if (phase === "failed map") await assert.rejects(sources.map(descriptor.id, "item"));
      if (phase === "release") await assert.rejects(sources.releaseMapped(held[0].mapped));
      if (phase !== "dispose") {
        const flush = (owner) =>
          f.backend.evidence.flush(
            f.backend.evidence.captureDrain(
              { kind: "namespace", owner },
              performance.now() + 10000,
            ),
          );
        const drain = await flush(f.owner);
        assert.equal(drain.state, "unknown");
        assert.ok(drain.unknown.includes(drain.restartBlocker));
        assert.equal((await flush({ ...f.owner, sourceKey: "builtin:test.peer" })).state, "saved");
      }
    } finally {
      await assert.rejects(f.backend.dispose(), /worker-dispose-unknown/);
    }
    const attempts = await readFile(path.join(root, "attempts"), "utf8");
    assert.equal(attempts.length, phase === "release" || phase === "dispose" ? 3 : 1);
  });

async function smallImport(t, count = 1) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "worker-import-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "legacy");
  await mkdir(folder);
  for (let i = 0; i < count; i++)
    await writeFile(path.join(folder, "item" + i), JSON.stringify({ formatVersion: 1, i }));
  return root;
}
for (const [point, interference] of [
  ["object-rename", "none"],
  ...[
    "duplicate",
    "duplicate changed installed",
    "duplicate changed staged",
    "duplicate wrong attempt",
    "duplicate wrong seal",
    "duplicate wrong tag",
    "duplicate wrong candidate digest",
  ].map((shape) => ["object-rename", shape]),
  ["object-dir-sync", "none"],
  ["object-dir-sync", "changed byte"],
]) {
  test(`recovery after worker death at ${point} with interference: ${interference}`, async (t) => {
    const root = await smallImport(t);
    let control, attempt;
    const f = await launch(root, (c) => (control = c));
    const publish = f.backend.engine.publish;
    f.backend.engine.publish = (ticket) => {
      if (ticket.target.kind === "record") {
        attempt = ticket;
        control.arm(point, "kill");
      }
      return publish(ticket);
    };
    const signal = new AbortController().signal;
    try {
      assert.equal((await f.coordinator.run(descriptor, signal)).state, "blocked");
    } finally {
      await assert.rejects(f.backend.dispose(), /worker-dispose-unknown/);
    }
    if (interference.startsWith("duplicate")) {
      // Reproduce the two payload names for the same pending attempt.
      const ns = path.join(
        root,
        "plugins",
        "persistence-v1",
        "namespaces",
        createHash("sha256").update(f.owner.sourceKey).digest("hex"),
      );
      const { id, revision } = attempt.metadata.record;
      const stage = path.join(ns, "staging", attempt.id);
      const installed = path.join(ns, "records", id, "objects", revision + ".bin");
      const payload = path.join(stage, "payload.tmp");
      const bytes = await readFile(payload);
      await writeFile(installed, bytes);
      if (
        interference === "duplicate changed installed" ||
        interference === "duplicate changed staged"
      ) {
        bytes[0] ^= 1;
        await writeFile(interference.endsWith("staged") ? payload : installed, bytes);
      }
      const changes = {
        "duplicate wrong attempt": [
          path.join(stage, "intent.json"),
          (value) => {
            value.ticket.id = randomUUID();
          },
        ],
        "duplicate wrong seal": [
          path.join(stage, "sealed.json"),
          (value) => {
            value.sha256 = "0".repeat(64);
          },
        ],
        "duplicate wrong tag": [
          path.join(stage, "import-tag.json"),
          (value) => {
            value.tag.itemKey += "-other";
          },
        ],
        "duplicate wrong candidate digest": [
          path.join(ns, "records", id, "head." + attempt.id + ".tmp"),
          (value) => {
            value.sha256 = "0".repeat(64);
          },
        ],
      };
      if (Object.hasOwn(changes, interference)) {
        const [name, change] = changes[interference];
        const value = JSON.parse(await readFile(name));
        change(value);
        await writeFile(name, JSON.stringify(value));
      }
    }
    if (interference === "changed byte") {
      const objects = (await readdir(root, { recursive: true })).filter((file) =>
        file.endsWith(".bin"),
      );
      assert.equal(objects.length, 1);
      const object = path.join(root, objects[0]);
      const bytes = await readFile(object);
      bytes[0] ^= 1;
      await writeFile(object, bytes);
    }
    const ready = interference === "none" || interference === "duplicate";
    for (let boot = 0; boot < 2; boot++) {
      const fresh = await launch(root, undefined, descriptor, ready ? "ready" : "blocked");
      try {
        if (!ready) {
          assert.deepEqual(await fresh.coordinator.run(descriptor, signal), {
            state: "blocked",
            completedItems: 0,
            totalItems: 1,
          });
          await assert.rejects(fresh.backend.reads.list(fresh.owner, { limit: 64 }));
          continue;
        }
        if (boot === 0)
          assert.deepEqual(
            (await fresh.backend.reads.list(fresh.owner, { limit: 64 })).entries,
            [],
          );
        assert.deepEqual(await fresh.coordinator.run(descriptor, signal), {
          state: "complete",
          completedItems: 1,
          totalItems: 1,
        });
        const { entries } = await fresh.backend.reads.list(fresh.owner, { limit: 64 });
        assert.deepEqual(
          entries.map((r) => r.id),
          [attempt.target.id],
        );
        const pin = await fresh.backend.reads.open(
          fresh.owner,
          attempt.target.id,
          entries[0].revision,
        );
        try {
          assert.deepEqual(
            Buffer.from(await fresh.backend.reads.read(fresh.owner, pin, 0, 262144)),
            await readFile(path.join(root, "legacy", "item0")),
          );
        } finally {
          await fresh.backend.reads.close(fresh.owner, pin);
        }
      } finally {
        await fresh.backend.dispose();
      }
    }
  });
}
for (const missing of [0, 1])
  test("missing checked original leaves one sibling committed, index " + missing, async (t) => {
    const root = await smallImport(t, 0);
    await mkdir(path.join(root, "recordings"));
    const checked = sensorLabImportDescriptors[0];
    const source = {
      kind: "input",
      port: 0,
      type: 30,
      mode: 0,
      channel: 1,
      name: "US",
      modeName: "distance",
      unit: "cm",
      decimals: 1,
    };
    source.id = channelKey(source);
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      await writeFile(
        path.join(root, "recordings", id + ".json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          name: "Trial " + i,
          startedAt: 100,
          durationMs: 0,
          frameCount: 1,
          device: { id: "brick", name: "EV3", transport: "usb" },
          channels: [{ source, calibration: identityCalibration("cm") }],
          frames: [{ sampledAt: 100, elapsedMs: 0, values: [3], status: "ok", segment: 0 }],
        }),
      );
    }
    const f = await launch(root, undefined, checked);
    try {
      let plan;
      const persist = f.backend.imports.plan;
      f.backend.imports.plan = async (owner, p) => {
        await persist(owner, p);
        plan = p;
        await rename(
          path.join(root, "recordings", p.items[missing].key),
          path.join(root, "removed"),
        );
      };
      assert.deepEqual(await f.coordinator.run(checked, new AbortController().signal), {
        state: "blocked",
        totalItems: 2,
        completedItems: 1,
      });
      const journal = await f.backend.imports.load(f.owner, plan.id);
      assert.deepEqual(
        journal.items.map((item) => item.state),
        missing === 0 ? ["pending", "committed"] : ["committed", "pending"],
      );
      assert.deepEqual(
        (await f.backend.reads.list(f.owner, { limit: 64 })).entries.map((r) => r.sha256),
        [plan.items[1 - missing].mappedSha256],
      );
    } finally {
      await f.backend.dispose();
    }
  });
test("inventory detects a late directory member and recaptures all six", async (t) => {
  const root = await smallImport(t, 5);
  await writeFile(path.join(root, "fault"), "late-file");
  const f = await launch(root);
  try {
    const run = () => f.coordinator.run(descriptor, new AbortController().signal);
    assert.equal((await run()).state, "blocked");
    assert.deepEqual(await run(), { state: "complete", completedItems: 6, totalItems: 6 });
  } finally {
    await f.backend.dispose();
  }
});
for (const fault of ["destination-close", "candidate-head-close"])
  test(`failed ${fault} requires restart for this source`, async (t) => {
    const root = await smallImport(t);
    await writeFile(path.join(root, "fault"), fault);
    const f = await launch(root);
    const run = (f) => f.coordinator.run(descriptor, new AbortController().signal);
    let first, retry, drain, peer, disposal;
    try {
      first = await run(f);
      retry = await run(f);
      const flush = (owner) =>
        f.backend.evidence.flush(
          f.backend.evidence.captureDrain({ kind: "namespace", owner }, performance.now() + 10000),
        );
      drain = await flush(f.owner);
      peer = await flush({ ...f.owner, sourceKey: "builtin:test.peer" });
    } finally {
      disposal = await Promise.allSettled([f.backend.dispose()]);
    }
    assert.deepEqual(first, { state: "blocked", completedItems: 0, totalItems: 1 });
    assert.deepEqual(retry, first);
    assert.equal(drain.state, "unknown");
    assert.ok(drain.restartBlocker && drain.unknown.includes(drain.restartBlocker));
    assert.equal(peer.state, "saved");
    assert.equal(disposal[0].status, "rejected");
    assert.match(disposal[0].reason.message, /worker-dispose-unknown/);
    await rm(path.join(root, "fault"));
    const fresh = await launch(root);
    try {
      assert.deepEqual(await run(fresh), { state: "complete", completedItems: 1, totalItems: 1 });
    } finally {
      await fresh.backend.dispose();
    }
  });

// Capture the actual ordered effects, then kill at each after-edge in a separate
// profile. The committed sibling is the first plan item; the faulted item has
// its own never-published target (expectedRevision === null).
for (const failure of [
  null,
  "seal-sync",
  "publish/head-write",
  "object-rename",
  "before-publish",
]) {
  test("interrupt each first-record step " + (failure ?? "through commit"), async (t) => {
    let reference;
    function compareTrace(expected, actual) {
      const width = Math.max(9, ...expected.map((s) => s.length));
      return [
        "reference".padEnd(width) + " | actual",
        ...Array.from(
          { length: Math.max(expected.length, actual.length) },
          (_, i) => (expected[i] ?? "").padEnd(width) + " | " + (actual[i] ?? ""),
        ),
      ].join("\n");
    }
    async function trial(context, kill, committed = false, blocked = false) {
      const root = await smallImport(context, 2);
      await writeFile(path.join(root, "fault"), "record-steps");
      let control;
      const f = await launch(root, (c) => (control = c));
      const publish = f.backend.engine.publish;
      let sibling, attempt, termination;
      async function arm(point, action) {
        let timeout;
        const armed = control.reached("armed/" + point);
        control.arm(point, action);
        try {
          await Promise.race([
            armed,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Missing worker acknowledgment for " + point)),
                30000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      async function armTrial() {
        for (const [point, action] of [
          [failure, "fail"],
          [kill, "pause"],
        ]) {
          if (!point) continue;
          await arm(point, action);
          // The acknowledgment also drains earlier tickets’ events on this port.
          if (point === kill) {
            // Both ports are asynchronous. Observe the paused after-edge on the
            // parent before killing, so worker exit cannot discard its trace.
            void control.reached(point).then(() => {
              termination = control.terminate();
            });
          }
        }
      }
      if (failure === "seal-sync") {
        const seal = f.backend.engine.seal;
        f.backend.engine.seal = async (ticket, ...args) => {
          if (sibling && ticket.target.kind === "record") {
            attempt = ticket;
            await armTrial();
          }
          return seal(ticket, ...args);
        };
      }
      f.backend.engine.publish = async (ticket) => {
        if (ticket.target.kind === "record") {
          if (!sibling) {
            const result = await publish(ticket);
            assert.equal(result.disposition, "committed");
            sibling = ticket;
            return result;
          }
          attempt = ticket;
          assert.equal(ticket.target.expectedRevision, null);
          if (failure !== "seal-sync") await armTrial();
        }
        return publish(ticket);
      };
      const run = (f) => f.coordinator.run(descriptor, new AbortController().signal);
      let first, disposed;
      try {
        first = await run(f);
        // The RPC result and the trace use different ports. Read through the
        // final trace event while the reference worker is still alive.
        if (!kill) await arm("reference-trace-drain", "pause");
      } finally {
        disposed = await Promise.allSettled([f.backend.dispose()]);
      }
      await termination;
      const events = control.trace().filter((e) => attempt && e.ticket === attempt.id);
      const phase = failure ? "abort" : "publish";
      const actual = events.filter((e) => e.point.startsWith(phase + "/")).map((e) => e.point);
      if (!kill) {
        assert.ok(sibling && attempt, "missing sibling or target ticket");
        assert.deepEqual(disposed, [{ status: "fulfilled", value: undefined }]);
        assert.deepEqual(first, {
          state: failure ? "blocked" : "complete",
          completedItems: failure ? 1 : 2,
          totalItems: 2,
        });
        if (failure)
          assert.ok(
            events.some((e) => e.point === failure),
            "missing fault " + failure,
          );
        assert.deepEqual(
          events.filter((e) => e.point.startsWith("finished/" + phase + "/")).map((e) => e.point),
          ["finished/" + phase + "/" + actual.length],
          "incomplete reference trace\n" + actual.join("\n"),
        );
        assert.equal(new Set(actual).size, actual.length);
        return actual;
      }
      const prefix = reference.slice(0, reference.indexOf(kill) + 1);
      assert.deepEqual(
        actual,
        prefix,
        "expected kill at " + kill + "\n" + compareTrace(reference, actual),
      );
      assert.ok(termination, "worker was never paused at " + kill);
      assert.equal(disposed[0].status, "rejected");
      assert.match(disposed[0].reason.message, /worker-dispose-unknown/);
      assert.equal(first.state, "blocked");
      const fresh = await launch(root, undefined, descriptor, blocked ? "blocked" : "ready");
      const original = new Map();
      for (const name of ["item0", "item1"]) {
        const bytes = await readFile(path.join(root, "legacy", name));
        original.set(createHash("sha256").update(bytes).digest("hex"), bytes);
      }
      const recordDir = (ticket) =>
        path.join(
          root,
          "plugins",
          "persistence-v1",
          "namespaces",
          createHash("sha256").update(ticket.owner.sourceKey).digest("hex"),
          "records",
          ticket.target.id,
        );
      async function verifyDisk(ticket) {
        const head = JSON.parse(await readFile(path.join(recordDir(ticket), "head.json")));
        assert.equal(head.receipt.commitId, ticket.id);
        assert.deepEqual(
          await readFile(path.join(recordDir(ticket), "objects", head.object)),
          original.get(ticket.metadata.record.sha256),
        );
      }
      async function verifyVisible(expected) {
        const entries = (await fresh.backend.reads.list(fresh.owner, { limit: 64 })).entries;
        assert.deepEqual(entries.map((r) => r.id).sort(), expected.map((t) => t.target.id).sort());
        for (const r of entries) {
          const planned = expected.find((ticket) => ticket.target.id === r.id).metadata.record;
          assert.equal(r.sha256, planned.sha256);
          assert.equal(r.revision, planned.revision);
          const pin = await fresh.backend.reads.open(fresh.owner, r.id, r.revision);
          try {
            assert.deepEqual(
              Buffer.from(await fresh.backend.reads.read(fresh.owner, pin, 0, 262144)),
              original.get(r.sha256),
            );
          } finally {
            await fresh.backend.reads.close(fresh.owner, pin);
          }
        }
      }
      try {
        await verifyDisk(sibling);
        if (committed) await verifyDisk(attempt);
        if (blocked) {
          await assert.rejects(fresh.backend.reads.list(fresh.owner, { limit: 64 }));
          await assert.rejects(stat(path.join(recordDir(attempt), "head.json")), {
            code: "ENOENT",
          });
        } else await verifyVisible(committed ? [sibling, attempt] : [sibling]);
        const retry = await run(fresh);
        if (blocked) {
          // The already committed sibling accounts for the one completed item.
          assert.deepEqual(retry, { state: "blocked", completedItems: 1, totalItems: 2 });
        } else {
          assert.deepEqual(retry, { state: "complete", completedItems: 2, totalItems: 2 });
          await verifyVisible([sibling, attempt]);
        }
        await verifyDisk(sibling);
        if (committed) await verifyDisk(attempt);
      } finally {
        await fresh.backend.dispose();
      }
    }
    try {
      reference = await trial(t);
    } catch (error) {
      throw new Error(
        "Failed interruption reference for " + (failure ?? "through commit") + ": " + error.message,
        { cause: error },
      );
    }
    const required = failure
      ? [
          "abort/unlink/stage/sealed.json",
          "abort/unlink/stage/import-tag.json",
          "abort/unlink/stage/intent.json",
          "abort/removeEmpty/stage",
        ]
      : [
          "publish/head-write",
          "publish/atomicReplace/record/candidate",
          "publish/atomicReplace/record/object",
          "publish/object-dir-sync",
          "publish/before-publish",
          "publish/dispatch",
          "publish/atomicReplace/record/head.json",
          "publish/after-publish",
          "publish/head-dir-sync",
          "publish/cache-publish",
          "publish/cleanup",
          "publish/receipt-send",
        ];
    if (failure === "seal-sync")
      required.splice(0, 1, "abort/closeOwned/stage/payload.tmp", "abort/unlink/stage/payload.tmp");
    if (failure === "publish/head-write") required.push("abort/unlink/stage/publication.json");
    if (failure === "object-rename")
      required.push("abort/unlink/stage/payload.tmp", "abort/unlink/record/candidate");
    if (failure === "before-publish")
      required.push("abort/unlink/record/object", "abort/unlink/record/candidate");
    // Lower bounds from the full first-record paths. The file-sync-only adapter
    // omits open/sync/close for each directory sync (six on publish, one on abort).
    const minimum =
      { "seal-sync": 17, "publish/head-write": 18, "object-rename": 18, "before-publish": 19 }[
        failure
      ] ?? 76;
    const missingDirectoryEdges = process.platform === "win32" ? (failure ? 3 : 18) : 0;
    const incomplete =
      "Incomplete interruption reference for " +
      (failure ?? "through commit") +
      "\n" +
      reference.join("\n");
    assert.ok(reference.length >= minimum - missingDirectoryEdges, incomplete);
    for (const edge of required)
      assert.ok(reference.includes(edge), incomplete + "\nmissing " + edge);
    let committed = false,
      blocked = false;
    for (const step of reference) {
      if (step === "publish/atomicReplace/record/head.json") committed = true;
      // BL1 W16R9 High 1: abort removed the only payload while its candidate still exists.
      if (
        step === "abort/unlink/record/object" ||
        (failure === "object-rename" && step === "abort/unlink/stage/payload.tmp")
      )
        blocked = true;
      if (step === "abort/unlink/record/candidate") blocked = false;
      await t.test(step, (context) => trial(context, step, committed, blocked));
    }
  });
}
