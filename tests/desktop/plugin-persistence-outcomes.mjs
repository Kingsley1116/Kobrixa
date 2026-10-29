import { verifyCompatibility } from "./plugin-persistence-compatibility.ts";
import assert from "node:assert/strict";
// Shared T7 manifest and X-T1 outcome oracle. Passing this pure oracle does not
// establish live provenance; producers and the outside controller retain that evidence.
export const FOUNDATION_CASES = [
  "contention",
  "retirement",
  "registration-end",
  "healthy-release",
  "disconnect-retry",
  "suspend-wake",
  "renderer-loss",
  "sealed-ttl",
  "unknown-publication",
  "all-optional-off",
  "action-replay",
  "import-restart",
  "storage-ui-pressure",
  "compatibility",
  "installed",
];
export const FOUNDATION_CHECKS = {
  contention: {
    checks: [
      "motionWhileRecording",
      "recordingWhileMotion",
      "concurrentActive",
      "settingsSuccess",
      "settingsConflict",
      "dirtyDraftPreserved",
    ],
    events: [],
    samples: [],
  },
  retirement: {
    checks: ["firstDeadline"],
    events: ["retire", "freeze", "drain", "process-exit"],
    samples: [],
  },
  "registration-end": {
    checks: [
      "finalTargets",
      "finalPublications",
      "pendingRegistrationIncluded",
      "firstDeadline",
      "lastDeadline",
    ],
    events: [],
    samples: [],
  },
  "healthy-release": {
    checks: [
      "retireCalls",
      "freezeCalls",
      "processExits",
      "unrelatedSettingsCommitted",
      "generationBefore",
      "generationAfter",
    ],
    events: [],
    samples: [],
  },
  "disconnect-retry": {
    checks: [
      "disconnectsBeforeSaved",
      "failedSaveBlocker",
      "retriesWithFreshAction",
      "finalTargets",
      "finalPublications",
      "priorSessionIncluded",
      "firstDeadline",
      "lastDeadline",
    ],
    events: [
      "quiesce",
      "stop-confirmed",
      "save-failed",
      "save-confirmed",
      "journal-confirmed",
      "disconnect",
    ],
    samples: [],
  },
  "suspend-wake": {
    checks: [
      "quiesceReason",
      "retireCalls",
      "freezeCalls",
      "processExits",
      "replayedMotion",
      "replayedRecording",
      "replayedCommand",
      "renewedOldToken",
    ],
    events: [],
    samples: [],
  },
  "renderer-loss": {
    checks: [
      "processExited",
      "explicitRestart",
      "oldActionDenied",
      "oldGestureDenied",
      "oldEpochDenied",
      "oldCommitDenied",
      "newGeneration",
      "previousGeneration",
    ],
    events: [],
    samples: [],
  },
  "sealed-ttl": {
    checks: [
      "lastProgressAt",
      "createdAt",
      "observedExpiry",
      "expiryAfterFailedRetry",
      "afterExpiry",
      "latePublishCalls",
      "unresolvedEvidenceDeleted",
      "originalExpiryPreserved",
      "expiredPinRejected",
      "checkpointOnlyNoInventedBytes",
    ],
    events: [],
    samples: [],
  },
  "unknown-publication": {
    checks: [
      "disposition",
      "oldEvidenceRetained",
      "newEvidenceRetained",
      "namespaceFenced",
      "secondPublicationCalls",
      "reconciledOriginalTicket",
      "reconciledDisposition",
      "exportOriginalJobReconciled",
      "noRepublish",
      "destinationIdentityPreserved",
    ],
    events: [],
    samples: [],
  },
  "all-optional-off": {
    checks: [
      "optionalProcesses",
      "optionalSchemaReads",
      "mapperCalls",
      "autoConnects",
      "coreRecoveryVisible",
      "coreExportSucceeded",
      "featureActionRefsMinted",
      "noProcessSettings",
      "durableRecoveryRestored",
      "committedExportHash",
      "sealedExportHash",
    ],
    events: [],
    samples: [],
  },
  "action-replay": {
    checks: [
      "forgedDestinationWrites",
      "replayedDestinationWrites",
      "expiredDestinationWrites",
      "lateDialogWrites",
      "deniedClipboardWrites",
      "deviceLocksDuringDialog",
      "leakedPathsOrValues",
      "freshCoreAction",
      "cancelNoWrite",
      "lateDialogReleased",
      "identitySwapRejected",
    ],
    events: [],
    samples: [],
  },
  "import-restart": {
    checks: [
      "recordCounts",
      "byteCounts",
      "idsStable",
      "originalsUnchanged",
      "deletedRecordReimported",
      "missingRendererCompletedEmpty",
      "markerBeforeCrashPending",
      "markerAfterCrashCompleteOnce",
      "atomicImportReceipt",
      "barrierRestored",
      "originalBytesUnchanged",
    ],
    events: [],
    samples: [],
  },
  "storage-ui-pressure": {
    checks: [
      "records",
      "recordBytes",
      "activeJobs",
      "liveCounters",
      "peakPendingJobs",
      "peakQueuedHostBytes",
      "peakQueuedSourceBytes",
      "mainExtraRss",
      "workerExtraRss",
      "mainSyncMaxMs",
      "uiHeapBytes",
      "residualBytes",
      "cycles",
      "uiWarmupMs",
      "uiSampleMs",
      "uiRepeats",
      "deviceWorkloadMs",
      "namespaceIncludesSettingsImport",
      "targetExcludesSettings",
      "afterBarrierExcluded",
    ],
    events: [],
    samples: [
      "stopExtraMs",
      "draftMs",
      "pageMs",
      "listMs",
      "commitMs",
      "uiApplyMs",
      "uiInputMs",
      "uiRevokeMs",
    ],
  },
  compatibility: {
    checks: [
      "apiVersions",
      "schemasEqual",
      "secondGenerationDrift",
      "legacyExecutePreserved",
      "legacyInitializePreserved",
      "drainSentBelow17",
      "pythonExecuted",
      "publicApi18Published",
    ],
    events: [],
    samples: [],
  },
  installed: {
    checks: [
      "cwdOutsideCheckout",
      "externalNodeUsed",
      "networkRequired",
      "primaryWorkers",
      "secondaryWorkers",
      "secondaryProviders",
      "secondaryPlugins",
      "primaryRecordingInterrupted",
      "primaryFocused",
      "childrenAfterFiveSeconds",
    ],
    events: [],
    samples: [],
  },
};

function same(e, expected) {
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(e.checks[key], value, `Unexpected ${key}`);
}
function numeric(e, key) {
  const value = e.checks[key];
  assert.equal(typeof value, "number", `Missing numeric ${key}`);
  assert.ok(Number.isFinite(value) && value >= 0, `Invalid numeric ${key}`);
  return value;
}
function bounded(e, key, maximum) {
  const value = numeric(e, key);
  assert.ok(value >= 0 && value <= maximum, `${key}: ${value} > ${maximum}`);
}
function ordered(e, kinds) {
  let previous = -1;
  for (const kind of kinds) {
    const index = e.events.findIndex((event) => event.kind === kind);
    assert.ok(index > previous, `Missing/out-of-order ${kind}`);
    previous = index;
  }
}
function samples(e, name, p95Limit, maxLimit) {
  const values = e.samples[name];
  assert.ok(values && values.length >= 30, `${name} needs 30 actual samples`);
  assert.ok([...values].every((value) => Number.isFinite(value) && value >= 0));
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  assert.ok(p95 <= p95Limit, `${name} p95 ${p95} > ${p95Limit}`);
  if (maxLimit !== undefined)
    assert.ok(sorted.at(-1) <= maxLimit, `${name} max exceeds ${maxLimit}`);
}

export function assertFoundationOutcome(id, e, { serialized = false } = {}) {
  const required = FOUNDATION_CHECKS[id];
  assert.ok(Object.hasOwn(FOUNDATION_CHECKS, id), `Unknown case ${id}`);
  assert.ok(e && typeof e === "object", "Missing foundation evidence");
  for (const field of ["checks", "samples"])
    assert.ok(
      e[field] && typeof e[field] === "object" && !Array.isArray(e[field]),
      `Missing ${field}`,
    );
  assert.ok(Array.isArray(e.events), "Missing events");
  assert.deepEqual(Object.keys(e.checks).sort(), [...required.checks].sort(), `${id}: check keys`);
  assert.deepEqual(
    Object.keys(e.samples).sort(),
    [...required.samples].sort(),
    `${id}: sample keys`,
  );
  let previousTime = -1,
    previousTurn = -1;
  for (const event of e.events) {
    assert.ok(event && required.events.includes(event.kind), `${id}: unexpected event`);
    assert.ok(Number.isSafeInteger(event.turn) && event.turn >= 0, "Invalid event turn");
    assert.ok(Number.isFinite(event.time) && event.time >= 0, "Invalid event time");
    assert.ok(
      event.time >= previousTime && event.turn >= previousTurn,
      "Event chronology regressed",
    );
    previousTime = event.time;
    previousTurn = event.turn;
  }
  assert.deepEqual(
    e.events.map((event) => event.kind).sort(),
    [...required.events].sort(),
    `${id}: event keys`,
  );
  const extra = {
    "all-optional-off": [
      "noProcessSettings",
      "durableRecoveryRestored",
      "committedExportHash",
      "sealedExportHash",
    ],
    "sealed-ttl": [
      "originalExpiryPreserved",
      "expiredPinRejected",
      "checkpointOnlyNoInventedBytes",
    ],
    "unknown-publication": [
      "exportOriginalJobReconciled",
      "noRepublish",
      "destinationIdentityPreserved",
    ],
    "action-replay": [
      "freshCoreAction",
      "cancelNoWrite",
      "lateDialogReleased",
      "identitySwapRejected",
    ],
    "storage-ui-pressure": [
      "namespaceIncludesSettingsImport",
      "targetExcludesSettings",
      "afterBarrierExcluded",
    ],
    "import-restart": ["atomicImportReceipt", "barrierRestored", "originalBytesUnchanged"],
  };
  for (const key of extra[id] ?? []) assert.equal(e.checks[key], true, `${id}.${key}`);
  switch (id) {
    case "contention":
      same(e, {
        motionWhileRecording: "busy",
        recordingWhileMotion: "busy",
        concurrentActive: 0,
        settingsSuccess: 1,
        settingsConflict: 1,
        dirtyDraftPreserved: true,
      });
      return;
    case "retirement": {
      const index = e.events.findIndex((event) => event.kind === "retire");
      assert.ok(index >= 0);
      const retired = e.events[index];
      const frozen = e.events[index + 1];
      assert.equal(frozen?.kind, "freeze");
      assert.equal(frozen?.turn, retired.turn, "Retire and freeze must share a synchronous turn");
      assert.ok(retired.grant !== undefined && retired.grant !== null);
      if (serialized) assert.deepEqual(frozen?.grant, retired.grant, "Serialized grant changed");
      else assert.equal(frozen?.grant, retired.grant, "The grant is the original object");
      assert.ok(frozen?.deadline !== undefined && frozen.deadline <= retired.time + 10_000);
      assert.ok(frozen.deadline <= retired.grant.expiresMonotonicMs);
      assert.equal(
        frozen.deadline,
        numeric(e, "firstDeadline"),
        "Retirement cannot extend an earlier offer",
      );
      const drain = e.events.find((event) => event.kind === "drain");
      assert.ok(drain && drain.turn > retired.turn, "Dispatch is deferred until fencing completes");
      assert.equal(drain.deadline, frozen?.deadline);
      ordered(e, ["retire", "freeze", "drain", "process-exit"]);
      return;
    }
    case "registration-end":
      same(e, { finalTargets: 1, finalPublications: 1, pendingRegistrationIncluded: true });
      assert.equal(numeric(e, "firstDeadline"), numeric(e, "lastDeadline"));
      return;
    case "healthy-release":
      same(e, {
        retireCalls: 0,
        freezeCalls: 0,
        processExits: 0,
        unrelatedSettingsCommitted: true,
      });
      assert.equal(numeric(e, "generationBefore"), numeric(e, "generationAfter"));
      return;
    case "disconnect-retry":
      same(e, {
        disconnectsBeforeSaved: 0,
        failedSaveBlocker: true,
        retriesWithFreshAction: 1,
        finalTargets: 2,
        finalPublications: 2,
        priorSessionIncluded: true,
      });
      assert.equal(numeric(e, "firstDeadline"), numeric(e, "lastDeadline"));
      ordered(e, ["quiesce", "stop-confirmed", "disconnect"]);
      ordered(e, ["quiesce", "save-failed", "save-confirmed", "disconnect"]);
      ordered(e, ["quiesce", "journal-confirmed", "disconnect"]);
      return;
    case "suspend-wake":
      same(e, {
        quiesceReason: "suspended",
        retireCalls: 0,
        freezeCalls: 0,
        processExits: 0,
        replayedMotion: 0,
        replayedRecording: 0,
        replayedCommand: 0,
        renewedOldToken: 0,
      });
      return;
    case "renderer-loss":
      same(e, {
        processExited: true,
        explicitRestart: true,
        oldActionDenied: true,
        oldGestureDenied: true,
        oldEpochDenied: true,
        oldCommitDenied: true,
      });
      assert.ok(numeric(e, "newGeneration") > numeric(e, "previousGeneration"));
      return;
    case "sealed-ttl": {
      assert.ok(
        numeric(e, "lastProgressAt") >= numeric(e, "createdAt"),
        "Progress precedes creation",
      );
      const original = Math.min(
        numeric(e, "lastProgressAt") + 30_000,
        numeric(e, "createdAt") + 120_000,
      );
      assert.equal(numeric(e, "observedExpiry"), original);
      assert.equal(numeric(e, "expiryAfterFailedRetry"), original);
      same(e, {
        afterExpiry: "checkpoint-only",
        latePublishCalls: 0,
        unresolvedEvidenceDeleted: false,
      });
      return;
    }
    case "unknown-publication":
      same(e, {
        disposition: "unknown",
        oldEvidenceRetained: true,
        newEvidenceRetained: true,
        namespaceFenced: true,
        secondPublicationCalls: 0,
        reconciledOriginalTicket: true,
        reconciledDisposition: "committed",
      });
      return;
    case "all-optional-off":
      same(e, {
        optionalProcesses: 0,
        optionalSchemaReads: 0,
        mapperCalls: 0,
        autoConnects: 0,
        coreRecoveryVisible: true,
        coreExportSucceeded: true,
        featureActionRefsMinted: 0,
      });
      return;
    case "action-replay":
      same(e, {
        forgedDestinationWrites: 0,
        replayedDestinationWrites: 0,
        expiredDestinationWrites: 0,
        lateDialogWrites: 0,
        deniedClipboardWrites: 0,
        deviceLocksDuringDialog: 0,
        leakedPathsOrValues: 0,
      });
      return;
    case "import-restart":
      same(e, {
        recordCounts: [50, 50, 50],
        byteCounts: [419_430_400, 419_430_400, 419_430_400],
        idsStable: true,
        originalsUnchanged: true,
        deletedRecordReimported: false,
        missingRendererCompletedEmpty: false,
        markerBeforeCrashPending: true,
        markerAfterCrashCompleteOnce: true,
      });
      return;
    case "storage-ui-pressure":
      same(e, { records: 50, recordBytes: 8 * 1024 * 1024, activeJobs: 4, liveCounters: 0 });
      bounded(e, "peakPendingJobs", 32);
      bounded(e, "peakQueuedHostBytes", 8 * 1024 * 1024);
      bounded(e, "peakQueuedSourceBytes", 1024 * 1024);
      bounded(e, "mainExtraRss", 32 * 1024 * 1024);
      bounded(e, "workerExtraRss", 64 * 1024 * 1024);
      bounded(e, "mainSyncMaxMs", 16);
      bounded(e, "uiHeapBytes", 64 * 1024 * 1024);
      bounded(e, "residualBytes", 2 * 1024 * 1024);
      assert.ok(numeric(e, "cycles") >= 1_000);
      assert.ok(numeric(e, "uiWarmupMs") >= 5_000);
      assert.ok(numeric(e, "uiSampleMs") >= 60_000);
      assert.ok(numeric(e, "uiRepeats") >= 3);
      assert.ok(numeric(e, "deviceWorkloadMs") >= 600_000);
      samples(e, "stopExtraMs", 50);
      samples(e, "draftMs", 50);
      samples(e, "pageMs", 100);
      samples(e, "listMs", 200);
      samples(e, "commitMs", 10_000, 10_000);
      samples(e, "uiApplyMs", 16, 50);
      samples(e, "uiInputMs", 100);
      samples(e, "uiRevokeMs", 50, 100);
      return;
    case "compatibility":
      assert.deepEqual(
        e.checks,
        verifyCompatibility(e.compatibility),
        "Compatibility summary must match original observations",
      );
      return;
    case "installed":
      same(e, {
        cwdOutsideCheckout: true,
        externalNodeUsed: false,
        networkRequired: false,
        primaryWorkers: 1,
        secondaryWorkers: 0,
        secondaryProviders: 0,
        secondaryPlugins: 0,
        primaryRecordingInterrupted: false,
        primaryFocused: true,
        childrenAfterFiveSeconds: 0,
      });
      return;
  }
}
