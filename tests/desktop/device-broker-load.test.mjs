import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLoad } from "./device-broker-harness.mjs";
import * as harness from "./device-broker-harness.mjs";

const identity = {
  commit: "a".repeat(40),
  artifact: { dirty: false, sha256: { "main.cjs": "b".repeat(64) } },
};

const sample = () => ({
  durationMs: 600_000,
  retainedHeap: Array.from({ length: 11 }, (_, index) => ({
    elapsedMs: index * 60_000,
    bytes: 12_000_000,
  })),
  stopDispatchMs: Array.from({ length: 100 }, () => 10),
  traffic: { peakQueuedBytes: 260_000, overflowFrames: 10 },
  scale: {
    channels: 38,
    actuators: 4,
    providers: 8,
    candidatesPerProvider: 32,
    candidatesGlobal: 64,
    subscriptions: 32,
    queueBytes: 262_144,
    journalEntries: 64,
  },
  measurements: { transport: [2], readback: [3], journal: [4] },
  environment: {
    commit: "a".repeat(40),
    artifact: "test",
    bundle: identity.artifact,
    os: "test",
    arch: "test",
    cpu: "test",
    ramBytes: 1,
    filesystem: "test",
    node: "test",
    electron: "test",
    warmCold: "warm",
    memoryMethod: "forced GC retained heap, 60s samples",
  },
});

test("load identity stays tied to the captured bundle and rejects mismatched commit or hashes", () => {
  assertLoad(sample(), identity);
  harness.assertArtifactIdentity(structuredClone(identity), identity);
  const otherCommit = sample();
  otherCommit.environment.commit = "c".repeat(40);
  assert.throws(() => assertLoad(otherCommit, identity), /commit/);
  const otherBundle = sample();
  otherBundle.environment.bundle = { ...identity.artifact, sha256: { "main.cjs": "d".repeat(64) } };
  assert.throws(() => assertLoad(otherBundle, identity), /artifact/);
  assert.throws(
    () => harness.assertArtifactIdentity({ ...identity, commit: "c".repeat(40) }, identity),
    /commit/,
  );
});

test("load gate rejects short runs, missing measurements and stop p95 above 50ms", () => {
  assertLoad(sample(), identity);
  assert.throws(() => assertLoad({ ...sample(), durationMs: 599_999 }, identity));
  assert.throws(() =>
    assertLoad({ ...sample(), stopDispatchMs: Array(100).fill(50.001) }, identity),
  );
  assert.throws(() => assertLoad({ ...sample(), measurements: { transport: [2] } }, identity));
  assert.throws(() => assertLoad({ ...sample(), retainedHeap: [] }, identity));
  assert.throws(() =>
    assertLoad({ ...sample(), traffic: { peakQueuedBytes: 262_145, overflowFrames: 1 } }, identity),
  );
  assert.throws(() =>
    assertLoad({ ...sample(), traffic: { peakQueuedBytes: 1, overflowFrames: 0 } }, identity),
  );
  const growing = sample();
  growing.retainedHeap = growing.retainedHeap.map((entry, index) => ({
    ...entry,
    bytes: 12_000_000 + index * 1_000_000,
  }));
  assert.throws(() => assertLoad(growing, identity));
});
