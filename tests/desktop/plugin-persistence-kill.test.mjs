import test from "node:test";
import { readEvidence, verifyKills } from "./plugin-persistence-harness.mjs";
test("B2-RF1: actual process death at every publication frontier", async () => {
  verifyKills(await readEvidence());
});

import assert from "node:assert/strict";
test("verifier negatives: mock kill and missing OS exit cannot pass", () => {
  assert.throws(() => verifyKills({ level: "unit", kills: [] }), /real-process/);
  assert.throws(() => verifyKills({ level: "real-process", kills: [] }), /./);
});

import { FAULT_POINTS } from "./plugin-persistence-harness.mjs";
const beforeReplacement = [
  "reserve",
  "open-temp",
  "chunk-write",
  "seal-sync",
  "object-rename",
  "object-dir-sync",
  "backup-head",
  "head-write",
  "before-publish",
  "import-marker",
];
const afterReplacement = [
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Pure oracle inputs. Never persisted or promoted to real-process evidence.
function killOracle() {
  const quota = Object.fromEntries(
    [
      "recordCount",
      "reservedCreates",
      "committedBytes",
      "reservedBytes",
      "hostCommittedBytes",
      "hostReservedBytes",
      "sourceStaging",
      "hostStaging",
      "sourceExports",
      "hostExports",
      "sourceTemporaryBytes",
      "hostTemporaryBytes",
      "sourceMetadataBytes",
      "hostMetadataBytes",
    ].map((k) => [k, 0]),
  );
  const snapshot = (epoch) => ({
    hostEpoch: uuid(epoch),
    diskTreeHash: "d".repeat(64),
    quota: { ...quota },
    handles: [],
    core: { records: [], errors: [] },
  });
  return {
    level: "real-process",
    execution: {
      level: "real-process",
      status: "passed",
      runId: "oracle-only",
      case: "kill",
      profileId: "oracle-profile",
      commit: "a".repeat(40),
      bundleSha256: "b".repeat(64),
      artifactSha256: "c".repeat(64),
      pid: 100,
      hostEpoch: uuid(1),
      exitCode: 0,
      signal: null,
      closedAt: 1,
      exitedAt: 2,
      reportedAt: 3,
      cleanup: { workers: 0, listeners: 0, children: 0, errors: [] },
      workerTrace: [
        { kind: "start", count: 1, pid: 100 },
        { kind: "exit", count: 0, pid: 100 },
      ],
    },
    kills: FAULT_POINTS.map((point) => ({
      point,
      pauseAcknowledged: true,
      exitCode: null,
      signal: "SIGKILL",
      exitObserved: true,
      pid: 100,
      reopenedPid: 200,
      profileId: "oracle-profile",
      reopenedProfileId: "oracle-profile",
      before: snapshot(1),
      after: {
        ...snapshot(2),
        headHash: (beforeReplacement.includes(point) ? "a" : "b").repeat(64),
      },
      oldHeadHash: "a".repeat(64),
      newHeadHash: "b".repeat(64),
      partialVisible: false,
      republishCount: 0,
      originalTicketId: uuid(3),
      reconciledTicketId: uuid(3),
      originalCommitId: uuid(4),
      reconciledCommitId: uuid(4),
      trace: [{ point, ticket: uuid(3) }],
    })),
  };
}
test("T7fix I2: each actual publication frontier accepts its observed whole head", () => {
  assert.deepEqual([...beforeReplacement, ...afterReplacement].sort(), [...FAULT_POINTS].sort());
  verifyKills(killOracle());
});
test("T7fix I2: new heads at every pre-replacement frontier are rejected", () => {
  for (const point of beforeReplacement) {
    const report = killOracle(),
      entry = report.kills.find((e) => e.point === point);
    entry.after.headHash = entry.newHeadHash;
    assert.throws(() => verifyKills(report), /head|publication/i, point);
  }
});
test("T7fix I2: old/partial post-replacement heads and changed original tickets fail", () => {
  for (const point of afterReplacement)
    for (const mutate of [
      (e) => (e.after.headHash = e.oldHeadHash),
      (e) => (e.after.headHash = "f".repeat(64)),
      (e) => (e.republishCount = 1),
      (e) => (e.reconciledCommitId = uuid(5)),
      (e) => (e.reconciledTicketId = uuid(5)),
      (e) => (e.trace[0].ticket = uuid(5)),
    ]) {
      const report = killOracle();
      mutate(report.kills.find((e) => e.point === point));
      assert.throws(() => verifyKills(report), /./, point);
    }
});
