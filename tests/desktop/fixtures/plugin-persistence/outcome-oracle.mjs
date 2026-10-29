import {
  pins,
  versions,
  sha,
  verifyCompatibility,
} from "../../plugin-persistence-compatibility.ts";
// Synthetic values for pure oracle unit tests only. Never write these as acceptance evidence.
const handle = (number) => `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const owner = {
  sourceKey: "dev:cross-plan-fixture",
  pluginId: "fixture.cross-plan",
  generation: 1,
  hostEpoch: handle(1),
  processEpoch: handle(2),
};
const grant = { owner, reservationId: handle(3), lastSequence: 9, expiresMonotonicMs: 10_100 };
const samples = (value) => Array.from({ length: 30 }, () => value);
const base = () => ({ checks: {}, events: [], samples: {} });

export function outcomeOracleFixture(id) {
  const evidence = base();
  const good = {
    contention: {
      motionWhileRecording: "busy",
      recordingWhileMotion: "busy",
      concurrentActive: 0,
      settingsSuccess: 1,
      settingsConflict: 1,
      dirtyDraftPreserved: true,
    },
    "registration-end": {
      finalTargets: 1,
      finalPublications: 1,
      firstDeadline: 10_100,
      lastDeadline: 10_100,
      pendingRegistrationIncluded: true,
    },
    "healthy-release": {
      retireCalls: 0,
      freezeCalls: 0,
      processExits: 0,
      generationBefore: 1,
      generationAfter: 1,
      unrelatedSettingsCommitted: true,
    },
    "disconnect-retry": {
      disconnectsBeforeSaved: 0,
      failedSaveBlocker: true,
      retriesWithFreshAction: 1,
      finalTargets: 2,
      finalPublications: 2,
      priorSessionIncluded: true,
      firstDeadline: 10_100,
      lastDeadline: 10_100,
    },
    "suspend-wake": {
      quiesceReason: "suspended",
      retireCalls: 0,
      freezeCalls: 0,
      processExits: 0,
      replayedMotion: 0,
      replayedRecording: 0,
      replayedCommand: 0,
      renewedOldToken: 0,
    },
    "renderer-loss": {
      processExited: true,
      newGeneration: 2,
      previousGeneration: 1,
      explicitRestart: true,
      oldActionDenied: true,
      oldGestureDenied: true,
      oldEpochDenied: true,
      oldCommitDenied: true,
    },
    "sealed-ttl": {
      createdAt: 0,
      lastProgressAt: 10_000,
      observedExpiry: 40_000,
      expiryAfterFailedRetry: 40_000,
      afterExpiry: "checkpoint-only",
      latePublishCalls: 0,
      unresolvedEvidenceDeleted: false,
    },
    "unknown-publication": {
      disposition: "unknown",
      oldEvidenceRetained: true,
      newEvidenceRetained: true,
      namespaceFenced: true,
      secondPublicationCalls: 0,
      reconciledOriginalTicket: true,
      reconciledDisposition: "committed",
    },
    "all-optional-off": {
      optionalProcesses: 0,
      optionalSchemaReads: 0,
      mapperCalls: 0,
      autoConnects: 0,
      coreRecoveryVisible: true,
      coreExportSucceeded: true,
      featureActionRefsMinted: 0,
    },
    "action-replay": {
      forgedDestinationWrites: 0,
      replayedDestinationWrites: 0,
      expiredDestinationWrites: 0,
      lateDialogWrites: 0,
      deniedClipboardWrites: 0,
      deviceLocksDuringDialog: 0,
      leakedPathsOrValues: 0,
    },
    "import-restart": {
      recordCounts: [50, 50, 50],
      byteCounts: [419_430_400, 419_430_400, 419_430_400],
      idsStable: true,
      originalsUnchanged: true,
      deletedRecordReimported: false,
      missingRendererCompletedEmpty: false,
      markerBeforeCrashPending: true,
      markerAfterCrashCompleteOnce: true,
    },
    compatibility: {
      apiVersions: ["1.4.0", "1.5.0", "1.6.0", "1.7.0"],
      schemasEqual: true,
      secondGenerationDrift: false,
      legacyExecutePreserved: true,
      legacyInitializePreserved: true,
      drainSentBelow17: 0,
      pythonExecuted: true,
      publicApi18Published: false,
    },
    installed: {
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
    },
  };
  evidence.checks = good[id] ?? {};
  if (id === "retirement") evidence.checks = { firstDeadline: 10_100 };
  if (id === "retirement")
    evidence.events = [
      { kind: "retire", turn: 1, time: 100, grant },
      { kind: "freeze", turn: 1, time: 100, grant, deadline: 10_100 },
      { kind: "drain", turn: 2, time: 101, deadline: 10_100 },
      { kind: "process-exit", turn: 3, time: 103 },
    ];
  if (id === "disconnect-retry")
    evidence.events = [
      { kind: "quiesce", turn: 1, time: 100 },
      { kind: "stop-confirmed", turn: 2, time: 200 },
      { kind: "save-failed", turn: 2, time: 201 },
      { kind: "save-confirmed", turn: 3, time: 300 },
      { kind: "journal-confirmed", turn: 3, time: 301 },
      { kind: "disconnect", turn: 4, time: 302 },
    ];
  if (id === "storage-ui-pressure") {
    evidence.checks = {
      records: 50,
      recordBytes: 8 * 1024 * 1024,
      activeJobs: 4,
      peakPendingJobs: 32,
      peakQueuedHostBytes: 8 * 1024 * 1024,
      peakQueuedSourceBytes: 1024 * 1024,
      mainExtraRss: 32 * 1024 * 1024,
      workerExtraRss: 64 * 1024 * 1024,
      mainSyncMaxMs: 16,
      uiWarmupMs: 5_000,
      uiSampleMs: 60_000,
      uiRepeats: 3,
      uiHeapBytes: 64 * 1024 * 1024,
      cycles: 1_000,
      liveCounters: 0,
      residualBytes: 2 * 1024 * 1024,
      deviceWorkloadMs: 600_000,
    };
    evidence.samples = {
      stopExtraMs: samples(50),
      draftMs: samples(50),
      pageMs: samples(100),
      listMs: samples(200),
      commitMs: samples(10_000),
      uiApplyMs: samples(16),
      uiInputMs: samples(100),
      uiRevokeMs: samples(50),
    };
  }
  const extra = {
    "all-optional-off": {
      noProcessSettings: true,
      durableRecoveryRestored: true,
      committedExportHash: true,
      sealedExportHash: true,
    },
    "sealed-ttl": {
      originalExpiryPreserved: true,
      expiredPinRejected: true,
      checkpointOnlyNoInventedBytes: true,
    },
    "unknown-publication": {
      exportOriginalJobReconciled: true,
      noRepublish: true,
      destinationIdentityPreserved: true,
    },
    "action-replay": {
      freshCoreAction: true,
      cancelNoWrite: true,
      lateDialogReleased: true,
      identitySwapRejected: true,
    },
    "storage-ui-pressure": {
      namespaceIncludesSettingsImport: true,
      targetExcludesSettings: true,
      afterBarrierExcluded: true,
    },
    "import-restart": {
      atomicImportReceipt: true,
      barrierRestored: true,
      originalBytesUnchanged: true,
    },
  };
  Object.assign(evidence.checks, extra[id]);
  if (id === "compatibility") {
    evidence.compatibility = compatibilityOracleFixture();
    evidence.checks = verifyCompatibility(evidence.compatibility);
  }
  return evidence;
}

// Synthetic transport rows for negative oracle tests ONLY; never a native receipt.
export function compatibilityOracleFixture(hostVersion = "1.8.0") {
  const currentCommit = "a".repeat(40);
  const bytes = JSON.stringify({
    $id: `https://kobrixa.com/schemas/plugin-protocol/${hostVersion}.json`,
  });
  const raw = {
    hostVersion,
    currentCommit,
    schema: { first: bytes, second: bytes, protocol: bytes, python: bytes },
    cases: [],
    rows: [],
  };
  let sequence = 0;
  for (const [slot, version] of [...versions, hostVersion].entries())
    for (const language of ["js", "py"]) {
      const id = `acceptance.compat-${slot}-${language}`;
      const schemaSha256 = sha(version);
      raw.cases.push({
        id,
        sdk: version,
        slot,
        language,
        commit: pins[slot] ?? currentCommit,
        schemaSha256,
        sourceHashes: { source: sha(id) },
      });
      for (const generation of [1, 2]) {
        const identity = {
          sourceKey: `dev:${id}`,
          pluginId: id,
          generation,
          hostEpoch: handle(1),
          processEpoch: handle(100 + raw.rows.length),
        };
        const row = {
          caseId: id,
          generation,
          owner: identity,
          launch: ++sequence,
          boot: {
            pid: 1000 + raw.rows.length,
            sequence: ++sequence,
            schemaId: `https://kobrixa.com/schemas/plugin-protocol/${version}.json`,
            schemaSha256,
          },
          wire: [],
          output: [],
        };
        const pair = (method, params, result) => {
          const requestId = row.wire.length + 1;
          row.wire.push({
            sequence: ++sequence,
            direction: "host",
            message: { jsonrpc: "2.0", id: requestId, method, params },
          });
          row.wire.push({
            sequence: ++sequence,
            direction: "plugin",
            message: { jsonrpc: "2.0", id: requestId, result },
          });
        };
        const capable = Number(version.split(".")[1]) >= 7;
        pair(
          "initialize",
          {
            apiVersion: hostVersion,
            pluginId: id,
            locale: "en",
            grantedPermissions: capable ? ["storage.read", "storage.write"] : [],
          },
          {
            apiVersion: version,
            sdk: {
              name: language === "js" ? "@kobrixa/plugin-sdk" : "kobrixa-plugin-sdk",
              version: "0.1.0",
            },
          },
        );
        pair("command/execute", { command: `${id}.legacy` }, null);
        row.output.push({ sequence: ++sequence, line: `UI_LEGACY_EXECUTED:${id}` });
        if (capable) {
          pair(
            "storage/drain",
            {
              token: handle(30),
              reason: "disable",
              checkpoints: [{ checkpoint: handle(31), record: { id: handle(32) } }],
              writes: [],
              remainingMs: 1000,
            },
            { ok: true, value: { status: "submitted", writes: [handle(33)] } },
          );
          row.drain = {
            offer: { owner: identity, token: handle(30) },
            report: {
              state: "saved",
              blocker: false,
              pendingSettings: false,
              records: [{ id: handle(32), final: true }],
              errors: [],
            },
            sequence: ++sequence,
          };
        }
        pair("shutdown", {}, null);
        row.exit = { code: 0, sequence: ++sequence };
        raw.rows.push(row);
      }
    }
  return raw;
}
