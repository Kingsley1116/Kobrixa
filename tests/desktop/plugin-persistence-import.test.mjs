import test from "node:test";
import assert from "node:assert/strict";
import { readEvidence, verifyImports } from "./plugin-persistence-harness.mjs";
test("B2-RF5: actual import kill/reopen repeats preserve IDs, bytes and originals", async () => {
  const report = await readEvidence();
  verifyImports(report);
  const required = [
    "before-plan",
    "after-plan",
    "before-attempt",
    "after-attempt",
    "before-head",
    "after-head",
    "before-receipt",
    "after-receipt",
    "before-skip",
    "after-skip",
    "before-raw",
    "after-raw",
    "before-consumption",
    "after-consumption",
    "before-marker",
    "after-marker",
    "before-barrier",
    "after-barrier",
  ];
  const trials = report.imports.restartDetails;
  assert.deepEqual([...new Set(trials.map((t) => t.boundary))].sort(), required.slice().sort());
  for (const trial of trials) {
    assert.equal(trial.actualProcessDeath, true);
    assert.ok(trial.signal === "SIGKILL" || trial.platformTermination === "taskkill-/T-/F");
    assert.ok(trial.reopens.length >= 3);
    assert.equal(
      new Set([trial.hostEpoch, ...trial.reopens.map((r) => r.hostEpoch)]).size,
      trial.reopens.length + 1,
    );
    for (const reopen of trial.reopens) {
      assert.notEqual(reopen.pid, trial.pid);
      assert.deepEqual(reopen.ids, trial.expectedIds);
      assert.deepEqual(reopen.hashes, trial.expectedHashes);
      assert.deepEqual(reopen.originalHashes, trial.originalHashes);
      assert.equal(reopen.committedDestinations, new Set(reopen.ids).size);
      assert.deepEqual(reopen.skipReasons, trial.skipReasons);
      assert.equal(reopen.completedItems, reopen.committedItems + reopen.skippedItems);
      assert.ok(reopen.barrierRestoredAt <= reopen.writerStartAttemptAt);
      assert.equal(reopen.writerAdmitted, false);
      assert.equal(reopen.publishesWhileUnknown, 0);
      assert.equal(reopen.deletedRecordResurrected, false);
      assert.equal(reopen.rendererPresent, false);
      assert.equal(reopen.preferenceSourceHash, trial.persistedPreferenceDigest);
      assert.equal(reopen.preferenceMappedHash, trial.expectedPreferenceMappedHash);
      assert.equal(reopen.oldWindowSubmitAccepted, false);
    }
  }
});

import { verifyRestartDetails, IMPORT_BOUNDARIES } from "./plugin-persistence-harness.mjs";
test("verifier negatives: import boundaries and death observations are mandatory", () => {
  assert.equal(IMPORT_BOUNDARIES.length, 18);
  assert.throws(() => verifyRestartDetails([]), /boundaries/);
  assert.throws(
    () =>
      verifyRestartDetails(
        IMPORT_BOUNDARIES.map((boundary) => ({ boundary, actualProcessDeath: false })),
      ),
    /./,
  );
  assert.throws(() => verifyImports({ level: "unit", imports: { trials: [] } }), /real-process/);
});
