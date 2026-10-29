import { assertPressurePartial } from "./plugin-persistence-pressure.ts";
import { assertImportPhase } from "./plugin-persistence-import.ts";
import { assertOptionalEvidence, assertOptionalPhase } from "./plugin-persistence-optional-off.ts";
import { assertRendererLossEvidence } from "./plugin-persistence-renderer-loss.ts";
export { assertRendererLossEvidence };
import { assertSealedTtlEvidence } from "./plugin-persistence-sealed-ttl.ts";
export { assertSealedTtlEvidence };
import assert from "node:assert/strict";
import { assertFoundationOutcome } from "./plugin-persistence-outcomes.mjs";
import {
  assertDisconnectObservation,
  disconnectMilestones,
} from "./plugin-persistence-disconnect.ts";
import { assertActionObservation, actionSummary } from "./plugin-persistence-action-replay.ts";
import { assertUnknownObservation } from "./plugin-persistence-unknown.ts";
import { assertSuspendObservation } from "./plugin-persistence-suspend.ts";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const FAULT_POINTS = Object.freeze([
  "reserve",
  "open-temp",
  "chunk-write",
  "seal-sync",
  "object-rename",
  "object-dir-sync",
  "backup-head",
  "head-write",
  "before-publish",
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
  "import-marker",
]);
export const MATRIX_IDS = Object.freeze(
  Array.from({ length: 29 }, (_, i) => `B2-N${String(i + 1).padStart(2, "0")}`),
);
const OUTCOMES = [
  ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE"],
  [-32602, "PLUGIN_E_SETTINGS_SCHEMA"],
  ["PLUGIN_E_SETTINGS_CONFLICT"],
  ["PLUGIN_E_STORAGE_CONFLICT"],
  ["PLUGIN_E_STORAGE_QUOTA", "secondary-exited"],
  [-32602, "PLUGIN_E_STORAGE_CONFLICT"],
  ["PLUGIN_E_SETTINGS_SAVE", "PLUGIN_E_STORAGE_IO"],
  ["not-committed"],
  [-32800, "PLUGIN_E_STALE_RESOURCE", "checkpoint-only"],
  ["unknown", "committed"],
  ["file-sync-only", "PLUGIN_E_STORAGE_IO"],
  ["committed"],
  ["PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_STORAGE_CONFLICT", "snapshot"],
  ["PLUGIN_E_STORAGE_IO", "PLUGIN_E_STORAGE_VERSION"],
  ["PLUGIN_E_STORAGE_CONFLICT", "timeout"],
  ["resynchronized"],
  ["checkpoint-only", "retryable"],
  ["blocker"],
  ["checkpoint-only"],
  ["drained", "blocker"],
  ["drained", "blocker"],
  ["core-only"],
  ["PLUGIN_E_PERMISSION_DENIED", "PLUGIN_E_STALE_RESOURCE", "cancelled"],
  ["PLUGIN_E_STORAGE_IO", "unknown", "committed"],
  ["PLUGIN_E_PERMISSION_DENIED", -32602, "PLUGIN_E_STORAGE_IO"],
  ["blocked"],
  ["resumed"],
  ["pending", "complete"],
  ["rejected"],
];
export async function readEvidence(file = process.env.PERSISTENCE_EVIDENCE) {
  assert.ok(
    file,
    "PERSISTENCE_EVIDENCE is required; no automatic acceptance without real evidence",
  );
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.equal(value.format, 1);
  return value;
}
function hash(value) {
  assert.match(value, /^[0-9a-f]{64}$/);
}
function identity(value) {
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
}
function reopened(item) {
  identity(item.before.hostEpoch);
  identity(item.after.hostEpoch);
  assert.notEqual(item.before.hostEpoch, item.after.hostEpoch);
  for (const stage of [item.before, item.after]) {
    hash(stage.diskTreeHash);
    for (const key of [
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
    ])
      integer(stage.quota[key], `quota ${key}`);
    assert.equal(stage.quota.recordCount + stage.quota.reservedCreates <= 256, true);
    assert.equal(stage.quota.committedBytes + stage.quota.reservedBytes <= 536870912, true);
    assert.equal(
      stage.quota.hostCommittedBytes + stage.quota.hostReservedBytes <= 1073741824,
      true,
    );
    assert.equal(stage.quota.sourceStaging <= 2 && stage.quota.hostStaging <= 16, true);
    assert.equal(stage.quota.sourceExports <= 1 && stage.quota.hostExports <= 4, true);
    assert.equal(stage.quota.sourceTemporaryBytes <= 33554432, true);
    assert.equal(stage.quota.hostTemporaryBytes <= 134217728, true);
    assert.equal(stage.quota.sourceMetadataBytes <= 4194304, true);
    assert.equal(stage.quota.hostMetadataBytes <= 67108864, true);
    assert.ok(Array.isArray(stage.handles));
    assert.ok(Array.isArray(stage.core.records));
    assert.ok(Array.isArray(stage.core.errors));
  }
  for (const old of item.before.handles) assert.ok(!item.after.handles.includes(old));
}
export function verifyMatrix(report) {
  realReport(report);
  assert.equal(report.level, "real-process", "matrix evidence must be real-process");
  assert.deepEqual(report.cases.map((entry) => entry.id).sort(), MATRIX_IDS);
  for (const [index, id] of MATRIX_IDS.entries()) {
    const entry = report.cases.find((candidate) => candidate.id === id);
    assert.ok(OUTCOMES[index].includes(entry.outcome), `${id}: unexpected outcome`);
    assert.ok(entry.assertions.length > 0, `${id}: no concrete assertions`);
    for (const check of entry.assertions) {
      assert.ok(typeof check.name === "string" && check.name.length > 0);
      assert.ok(
        Object.hasOwn(check, "actual") && Object.hasOwn(check, "expected"),
        "missing assertion observations",
      );
      assert.deepEqual(check.actual, check.expected, `${id}: ${check.name}`);
    }
    reopened(entry);
  }
  const get = (id) => report.cases.find((entry) => entry.id === id);
  hash(get("B2-N01").foreignBeforeHash);
  hash(get("B2-N01").foreignAfterHash);
  hash(get("B2-N29").sentinelBeforeHash);
  hash(get("B2-N29").sentinelAfterHash);
  identity(get("B2-N10").originalCommitId);
  for (const key of ["originalExpiry", "expiryAfterRetry"]) finite(get("B2-N19")[key], key);
  integer(get("B2-N20").nonRetiredGenerationBefore, "generation");
  assert.equal(get("B2-N01").foreignBeforeHash, get("B2-N01").foreignAfterHash);
  assert.equal(get("B2-N02").newTemporaryFiles, 0);
  assert.equal(get("B2-N02").watchEvents, 0);
  assert.equal(get("B2-N03").successfulCommits, 1);
  assert.equal(get("B2-N03").conflictingCommits, 1);
  assert.equal(get("B2-N05").secondaryStoreInitializations, 0);
  assert.equal(get("B2-N05").secondaryWorkerInitializations, 0);
  assert.equal(get("B2-N05").primaryFocusCount, 1);
  assert.equal(get("B2-N10").republishCount, 0);
  assert.equal(get("B2-N10").reconciledCommitId, get("B2-N10").originalCommitId);
  assert.equal(get("B2-N11").unsupportedDurability, "file-sync-only");
  assert.equal(get("B2-N11").eioReason, "sync-failed");
  assert.equal(get("B2-N12").pinnedObjectDeleted, false);
  assert.deepEqual(get("B2-N16").unsubscribeRemoved, [true, false]);
  assert.ok(get("B2-N16").validatedAt <= get("B2-N16").enqueuedAt);
  assert.ok(get("B2-N16").enqueuedAt <= get("B2-N16").ackedAt);
  assert.ok(get("B2-N16").ackedAt < get("B2-N16").callbackFinishedAt);
  assert.equal(get("B2-N18").drainDeadlineMs, 10000);
  assert.equal(get("B2-N18").managerBudgetMs, 4000);
  assert.equal(get("B2-N19").originalExpiry, get("B2-N19").expiryAfterRetry);
  assert.equal(get("B2-N20").nonRetiredGenerationBefore, get("B2-N20").nonRetiredGenerationAfter);
  assert.ok(get("B2-N21").stopConfirmedAt <= get("B2-N21").disconnectAt);
  assert.ok(get("B2-N21").saveConfirmedAt <= get("B2-N21").disconnectAt);
  assert.equal(get("B2-N21").wakeReplayCount, 0);
  for (const key of ["optionalSchemaReads", "mapperCalls", "pluginLaunches", "deviceConnects"])
    assert.equal(get("B2-N22")[key], 0);
  assert.equal(get("B2-N23").destinationMutations, 0);
  assert.equal(get("B2-N23").deviceLocks, 0);
  assert.equal(get("B2-N24").unlinkBeforeReplace, false);
  assert.equal(get("B2-N25").clipboardReads, 0);
  assert.equal(get("B2-N25").otherFormatsWritten, 0);
  assert.equal(get("B2-N26").completeMarker, false);
  assert.equal(get("B2-N29").sentinelBeforeHash, get("B2-N29").sentinelAfterHash);
}
export function verifyInterop(report) {
  assert.equal(report.consumers?.length, 2, "two consumers required");
  realReport(report);
  assert.deepEqual(report.consumers.map((entry) => entry.transport).sort(), [
    "message-port",
    "stdio",
  ]);
  const required = [
    "settings/read",
    "settings/watch",
    "settings/update",
    "storage/beginWrite",
    "storage/writeChunk",
    "storage/sealWrite",
    "storage/commitWrite",
    "storage/list",
    "storage/openRead",
    "storage/readChunk",
    "storage/closeRead",
    "storage/flush",
    "events/unsubscribe",
    "storage/exportBegin",
    "ui/copyText",
    "storage/drain",
  ];
  for (const consumer of report.consumers) {
    assert.equal(consumer.apiVersion, "1.7.0");
    assert.equal(consumer.privateServiceCalls, 0);
    assert.equal(consumer.exitCode, 0);
    for (const method of required) assert.ok(consumer.methods.includes(method), method);
    assert.equal(consumer.settingsConflict, "PLUGIN_E_SETTINGS_CONFLICT");
    assert.equal(consumer.drained, "saved");
    assert.notEqual(consumer.callbackResult, "saved");
    hash(consumer.recordBeforeHash);
    hash(consumer.recordAfterHash);
    assert.equal(consumer.recordBeforeHash, consumer.recordAfterHash);
    assert.equal(consumer.foreignOwnerAccepted, false);
  }
  for (const version of ["1.4.0", "1.5.0", "1.6.0"]) {
    const legacy = report.negotiation.find((entry) => entry.version === version);
    assert.ok(legacy);
    assert.equal(legacy.commandSucceeded, true);
    assert.deepEqual(legacy.persistenceDeliveries, []);
  }
  assert.equal(report.unregistered17DrainCallbacks, 0);
}
// Worker fault hooks acknowledge the BEFORE edge of fs.at. import-marker is
// after gate.dispatch but still BEFORE atomicReplace. Process death is not power loss:
// the post-replacement hooks below must reopen the new head. No named hook pauses
// inside rename, so none of these acknowledged frontiers permits an old/new choice.
export const KILL_HEAD_FRONTIERS = Object.freeze({
  reserve: "old",
  "open-temp": "old",
  "chunk-write": "old",
  "seal-sync": "old",
  "object-rename": "old",
  "object-dir-sync": "old",
  "backup-head": "old",
  "head-write": "old",
  "before-publish": "old",
  "import-marker": "old",
  "after-publish": "new",
  "head-dir-sync": "new",
  "cache-publish": "new",
  "receipt-send": "new",
  cleanup: "new",
});
export function verifyKills(report) {
  realReport(report);
  assert.equal(report.level, "real-process");
  assert.deepEqual(
    [...new Set(report.kills.map((entry) => entry.point))].sort(),
    [...FAULT_POINTS].sort(),
  );
  for (const entry of report.kills) {
    assert.equal(entry.pauseAcknowledged, true);
    assert.ok(
      entry.exitCode === null || (Number.isInteger(entry.exitCode) && entry.exitCode !== 0),
    );
    hash(entry.oldHeadHash);
    hash(entry.newHeadHash);
    hash(entry.after.headHash);
    assert.equal(entry.profileId, entry.reopenedProfileId);
    assert.ok(typeof entry.profileId === "string" && entry.profileId.length > 0);
    if (entry.termination === "worker-terminate") {
      assert.ok(Number.isSafeInteger(entry.workerId) && entry.workerId > 0);
      assert.notEqual(entry.workerId, entry.reopenedWorkerId);
      assert.ok(entry.trace.some((row) => row.point === entry.point));
      assert.equal(entry.exitObserved, true);
    } else {
      assert.ok(Number.isSafeInteger(entry.pid) && entry.pid > 0);
      assert.ok(entry.signal === "SIGKILL" || entry.platformTermination === "taskkill-/T-/F");
      integer(entry.reopenedPid, "reopened pid");
      assert.ok(entry.reopenedPid > 0);
      assert.equal(entry.exitObserved, true);
      assert.notEqual(entry.pid, entry.reopenedPid);
    }
    reopened(entry);
    const frontier = KILL_HEAD_FRONTIERS[entry.point];
    assert.ok(frontier, "Unknown publication frontier");
    assert.notEqual(entry.oldHeadHash, entry.newHeadHash, "Kill trial needs distinguishable heads");
    assert.equal(
      entry.after.headHash,
      frontier === "old" ? entry.oldHeadHash : entry.newHeadHash,
      `${entry.point}: wrong reopened head for publication frontier`,
    );
    identity(entry.originalTicketId);
    assert.equal(entry.reconciledTicketId, entry.originalTicketId, "Reconcile the original ticket");
    assert.ok(
      entry.trace?.some(
        (row) => row.point === entry.point && row.ticket === entry.originalTicketId,
      ),
      "Missing original-ticket frontier trace",
    );
    assert.equal(entry.partialVisible, false);
    if (frontier === "new") {
      assert.equal(entry.republishCount, 0);
      identity(entry.originalCommitId);
      assert.equal(entry.originalCommitId, entry.reconciledCommitId);
    }
  }
}
export function statistics(samples) {
  assert.equal(samples.length, 30, "30 samples required");
  assert.ok(
    [...samples].every((value) => Number.isFinite(value) && value >= 0),
    "finite samples required",
  );
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: 30, p50: sorted[14], p95: sorted[28], max: sorted[29] };
}
export function verifyLoad(report) {
  realReport(report);
  const load = report.load;
  for (const key of [
    "peakMainAddedRss",
    "peakWorkerAddedRss",
    "pendingJobs",
    "pendingSerializedBytes",
    "sourcePendingSerializedBytes",
    "sourceMetadataCacheBytes",
    "hostMetadataCacheBytes",
    "minimumFreeBytes",
  ])
    integer(load[key], key);
  for (const field of [
    "os",
    "architecture",
    "cpu",
    "ram",
    "filesystem",
    "artifact",
    "commit",
    "node",
    "electron",
  ])
    assert.ok(
      typeof load.environment[field] === "string" && load.environment[field].length > 0,
      field,
    );
  assert.equal(load.records, 50);
  assert.equal(load.recordBytes, 8388608);
  assert.equal(load.stagingRecords, 2);
  assert.equal(load.liveLogicalBytes, 436207616);
  assert.equal(load.jobs, 4);
  assert.equal(load.settingsKeys, 128);
  assert.equal(load.settingsBytes, 65536);
  assert.equal(load.visibleFields, 16);
  assert.equal(load.chunkBytes, 262144);
  for (const [name, limit] of [
    ["draftMs", 50],
    ["pageMs", 100],
    ["warmListMs", 200],
    ["extraStopDispatchMs", 50],
  ])
    assert.ok(statistics(load[name]).p95 <= limit, `${name}: p95 exceeded ${limit}`);
  assert.ok(statistics(load.mainSyncSegmentMs).max <= 16);
  assert.ok(statistics(load.commitMs).max <= 10000);
  assert.ok(statistics(load.flushMs).max <= 10000);
  assert.ok(load.peakMainAddedRss <= 33554432);
  assert.ok(load.peakWorkerAddedRss <= 67108864);
  assert.equal(load.rssMethod, "separate-process-baseline-and-peak");
  assert.equal(load.coldWarmSeparated, true);
  assert.ok(load.pendingJobs <= 32 && load.pendingSerializedBytes <= 8388608);
  assert.ok(load.sourcePendingSerializedBytes <= 1048576);
  assert.ok(load.sourceMetadataCacheBytes <= 524288 && load.hostMetadataCacheBytes <= 8388608);
  assert.ok(load.minimumFreeBytes >= 16777216);
  assert.equal(load.claimsPhysicalStopLatency, false);
}
export function verifyImports(report) {
  realReport(report);
  const imports = report.imports;
  verifyRestartDetails(imports.restartDetails);
  assert.equal(imports.records, 50);
  assert.equal(imports.recordBytes, 8388608);
  assert.deepEqual(imports.points, [
    "before-publish",
    "after-publish",
    "before-receipt",
    "after-receipt",
    "before-marker",
    "after-marker",
  ]);
  for (const trial of imports.trials) {
    assert.ok(imports.points.includes(trial.point));
    assert.equal(trial.actualProcessDeath, true);
    assert.ok(trial.reopens.length >= 3);
    const first = trial.reopens[0];
    for (const attempt of trial.reopens) {
      assert.equal(attempt.count, 50);
      assert.equal(attempt.bytes, 419430400);
      assert.deepEqual(attempt.ids, first.ids);
      assert.deepEqual(attempt.hashes, first.hashes);
      assert.equal(attempt.originalsHash, trial.originalsHash);
      assert.equal(attempt.completeMarker, true);
      assert.equal(attempt.republishCount, 0);
    }
  }
  assert.deepEqual(
    [...new Set(imports.trials.map((trial) => trial.point))].sort(),
    [...imports.points].sort(),
  );
  assert.equal(imports.deletedRecordRecreated, false);
  assert.equal(imports.pendingRendererMarkedEmpty, false);
  assert.equal(imports.maxBatch <= 64, true);
  assert.equal(imports.maxCandidateNames <= 4096, true);
  assert.equal(imports.maxJournalItems <= 512, true);
  assert.equal(imports.maxJournalBytes <= 2097152, true);
}

const finite = (n, label) =>
  assert.ok(typeof n === "number" && Number.isFinite(n) && n >= 0, label);
const integer = (n, label) => {
  finite(n, label);
  assert.ok(Number.isSafeInteger(n), label);
};
export function assertRegistrationEndEvidence(evidence) {
  const observed = evidence.registration;
  assert.ok(observed, "missing registration observation");
  const {
    firstOffer,
    offers,
    requests,
    submissions,
    registrationTicket,
    finalTickets,
    trace,
    endTrace,
    finalRecord,
    payloadSha256,
  } = observed;
  for (const key of [
    "firstOffer",
    "offers",
    "requests",
    "submissions",
    "registrationTicket",
    "finalTickets",
    "trace",
    "endTrace",
    "finalRecord",
    "payloadSha256",
  ])
    assert.ok(Object.hasOwn(observed, key), `missing registration observation ${key}`);
  assert.equal(firstOffer.checkpoints.length, 1);
  assert.equal(firstOffer.writes.length, 0);
  const checkpoint = firstOffer.checkpoints[0];
  assert.equal(registrationTicket.target.kind, "recovery");
  assert.equal(registrationTicket.target.key, checkpoint.checkpoint);
  assert.ok(
    trace.some((row) => row.point === "before-publish" && row.ticket === registrationTicket.id),
    "missing paused registration ticket",
  );
  assert.ok(
    endTrace.some((row) => row.point === "before-publish" && row.ticket === registrationTicket.id),
    "missing pause at reservation end",
  );
  assert.ok(
    !endTrace.some((row) => row.point === "after-publish" && row.ticket === registrationTicket.id),
    "registration published before reservation end",
  );
  const registrationPublication = trace.filter(
    (row) => row.point === "after-publish" && row.ticket === registrationTicket.id,
  );
  assert.equal(registrationPublication.length, 1, "missing durable registration publication");
  assert.equal(offers.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(submissions.length, 1);
  assert.equal(requests[0].checkpoints.length, 1);
  assert.deepEqual(requests[0].checkpoints[0], checkpoint);
  assert.equal(requests[0].reason, "reservation-ended");
  assert.equal(requests[0].token, firstOffer.token);
  assert.equal(requests[0].writes.length, 0, "checkpoint is not a pending staged write");
  assert.equal(submissions[0].ok, true);
  assert.equal(submissions[0].value.status, "submitted");
  assert.equal(submissions[0].value.writes.length, 1);
  assert.equal(finalTickets.length, 1);
  const ticket = finalTickets[0];
  assert.equal(ticket.target.kind, "record");
  assert.equal(ticket.target.id, checkpoint.record.id);
  assert.equal(ticket.target.expectedRevision, checkpoint.record.revision);
  assert.equal(ticket.metadata.record.checkpoint, "final");
  assert.equal(finalRecord.id, checkpoint.record.id);
  assert.equal(finalRecord.revision, ticket.metadata.record.revision);
  assert.equal(finalRecord.checkpoint, "final");
  assert.equal(payloadSha256, finalRecord.sha256);
  assert.equal(
    payloadSha256,
    createHash("sha256").update(`Synthetic final checkpoint ${finalRecord.id}\n`).digest("hex"),
  );
  const publications = trace.filter(
    (row) => row.point === "after-publish" && row.ticket === ticket.id,
  );
  assert.equal(publications.length, 1, "one actual final publication");
  const checks = evidence.checks;
  assert.equal(
    checks.finalTargets,
    new Set(requests.flatMap((request) => request.checkpoints.map((entry) => entry.record.id)))
      .size,
  );
  assert.equal(checks.finalTargets, 1);
  assert.equal(checks.finalPublications, new Set(publications.map((row) => row.ticket)).size);
  assert.equal(checks.finalPublications, 1);
  assert.equal(
    checks.pendingRegistrationIncluded,
    requests[0].checkpoints.filter((entry) => entry.checkpoint === checkpoint.checkpoint).length ===
      1,
  );
  assert.equal(checks.pendingRegistrationIncluded, true);
  finite(checks.firstDeadline, "original end deadline");
  assert.equal(checks.firstDeadline, firstOffer.deadlineMonotonicMs);
  assert.equal(checks.lastDeadline, offers.at(-1).deadlineMonotonicMs);
  assert.equal(checks.lastDeadline, checks.firstDeadline);
}
// Outside-controller binding of every summary to retained original observations.
// Internal consistency is necessary; only the controller's process receipt is native evidence.
export function assertDisconnectEvidence(evidence) {
  const o = evidence.disconnect;
  assert.ok(o, "Missing disconnect observations");
  assertDisconnectObservation(o);
  assert.deepEqual(evidence.events, disconnectMilestones(o.events));
  const [prior, current] = o.reservations;
  assert.notEqual(prior.sessionId, current.sessionId);
  assert.equal(o.ended[0].reason, "disconnected");
  const calls = o.coordinatorCalls.filter((row) => row.kind === "disconnect");
  for (const call of calls) {
    assert.equal(call.args[0], current.sessionId);
    const action = call.args[1];
    const mint = o.actions.find(
      (row) => row.kind === "mint" && row.action.actionToken === action.actionToken,
    );
    assert.deepEqual(mint?.action, action);
    assert.deepEqual(mint?.target, { kind: "device-disconnect", sessionId: current.sessionId });
    assert.ok(
      o.actions.some(
        (row) =>
          row.kind === "claim" &&
          row.accepted &&
          row.action.actionToken === action.actionToken &&
          row.target.kind === "device-disconnect" &&
          row.target.sessionId === current.sessionId,
      ),
    );
  }
  const targets = new Set(o.requests.flatMap(({ request }) => request.writes.map((w) => w.id)));
  const priorWrite = o.staged.find((row) => row.reservationId === prior.reservationId);
  const finals = o.publications.filter(
    (row) =>
      row.ticket.metadata.kind === "record" &&
      row.ticket.metadata.record.checkpoint === "final" &&
      row.result.disposition === "committed",
  );
  for (const final of finals) {
    assert.deepEqual(final.ticket.owner, o.ownerBefore);
    assert.ok(
      o.staged.some((row) => row.id === final.ticket.target.id && row.write === final.ticket.id),
    );
    assert.equal(
      o.fault.filter((row) => row.point === "after-publish" && row.ticket === final.ticket.id)
        .length,
      1,
    );
    assert.ok(
      o.retryDrain.report.records.some(
        (row) =>
          row.id === final.ticket.target.id &&
          row.final &&
          row.committedRevision === final.result.receipt.revision,
      ),
    );
    assert.ok(
      o.flushes.some(
        (row) =>
          final.at <= row.at &&
          row.at <= o.events.find((event) => event.kind === "save-confirmed").time &&
          row.at <= o.disconnects[0] &&
          row.result.state === "saved" &&
          row.result.accepted.includes(final.ticket.id),
      ),
    );
  }
  const journalAt = o.events.find((row) => row.kind === "journal-confirmed").time;
  assert.ok(
    o.journalCommits.some(
      (row) =>
        row.at <= journalAt &&
        row.document.entries.some(
          (entry) =>
            entry.sessionId === current.sessionId &&
            entry.operationId === o.motion.operationId &&
            entry.state === "resolved" &&
            entry.stopConfirmation === "confirmed",
        ),
    ),
  );
  for (const step of ["stop", "readback"])
    assert.ok(
      o.providerTrace.some(
        (row) =>
          row.step === step && row.operationId === o.motion.operationId && row.dispatch === "sent",
      ),
    );
  const saveAt = o.events.find((row) => row.kind === "save-confirmed").time;
  assert.deepEqual(evidence.checks, {
    disconnectsBeforeSaved: o.disconnects.filter((at) => at < saveAt).length,
    failedSaveBlocker:
      o.snapshot.items.find((row) => row.id === o.failed.id)?.state === "retryable" &&
      o.failed.report.blocker,
    retriesWithFreshAction: o.actions.filter(
      (row) => row.kind === "claim" && row.target.kind === "persistence-retry" && row.accepted,
    ).length,
    finalTargets: targets.size,
    finalPublications: new Set(finals.map((row) => row.ticket.id)).size,
    priorSessionIncluded:
      prior.sessionId !== current.sessionId &&
      o.requests.some(({ request }) =>
        request.writes.some((w) => w.id === priorWrite.id && w.write === priorWrite.write),
      ),
    firstDeadline: o.offers[0].deadlineMonotonicMs,
    lastDeadline: o.retryDrain.offer.deadlineMonotonicMs,
  });
}
export function verifyRunReceipt(r, expected = {}) {
  if (r.case === "import-restart" && r.evidence?.importSlice)
    assertImportPhase(r.evidence.importSlice);
  else if (r.case === "storage-ui-pressure") assertPressurePartial(r.evidence.pressure);
  else assertFoundationOutcome(r.case, r.evidence, { serialized: true });
  if (r.case === "all-optional-off") {
    assertOptionalEvidence(r.evidence, r.hostEpoch);
    for (const phase of [r.evidence.optionalOff.seed, r.evidence.optionalOff.settings])
      for (const key of ["commit", "bundleSha256", "artifactSha256"])
        assert.equal(phase[key], r[key], `cross-artifact optional phase: ${key}`);
    for (const key of ["hostEpoch", "pid", "runId", "profileId"])
      assert.equal(r[key], r.evidence.optionalOff.cold[key]);
  }
  if (r.case === "renderer-loss") assertRendererLossEvidence(r.evidence, r.hostEpoch);
  if (r.case === "sealed-ttl") assertSealedTtlEvidence(r.evidence, r.hostEpoch);
  if (r.case === "action-replay") {
    assertActionReplayEvidence(r.evidence);
    assert.equal(
      r.evidence.actionReplay.owner.hostEpoch,
      r.hostEpoch,
      "Action proof belongs to another composition",
    );
  }
  if (r.case === "unknown-publication") {
    assertUnknownEvidence(r.evidence);
    assert.equal(
      r.evidence.unknown.owner.hostEpoch,
      r.hostEpoch,
      "Unknown-publication proof belongs to another composition",
    );
  }
  if (r.case === "disconnect-retry") assertDisconnectEvidence(r.evidence);
  if (r.case === "contention") assertContentionEvidence(r.evidence);
  if (r.case === "suspend-wake") {
    assert.ok(r.evidence.suspend, "Missing suspend observations");
    assertSuspendObservation(r.evidence.suspend);
  }
  if (r.case === "registration-end") assertRegistrationEndEvidence(r.evidence);
  assert.equal(r.level, "real-process");
  assert.equal(r.status, r.case === "storage-ui-pressure" ? "partial-pressure" : "passed");
  for (const field of ["runId", "case", "profileId"])
    assert.ok(typeof r[field] === "string" && r[field].length > 0, field);
  assert.match(r.commit, /^[0-9a-f]{40}$/);
  hash(r.bundleSha256);
  hash(r.artifactSha256);
  identity(r.hostEpoch);
  integer(r.pid, "pid");
  assert.ok(r.pid > 0);
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(r[key], value, `stale receipt: ${key}`);
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
  for (const field of ["closedAt", "exitedAt", "reportedAt"]) finite(r[field], field);
  assert.ok(
    r.closedAt <= r.exitedAt && r.exitedAt <= r.reportedAt,
    "report precedes close/OS exit",
  );
  for (const field of ["workers", "listeners", "children"])
    assert.equal(r.cleanup[field], 0, field);
  assert.deepEqual(r.cleanup.errors, []);
  assert.ok(Array.isArray(r.workerTrace) && r.workerTrace.length >= 2, "missing worker trace");
  const starts = r.workerTrace.filter((e) => e.kind === "start"),
    exits = r.workerTrace.filter((e) => e.kind === "exit");
  assert.equal(starts.length, 1);
  assert.equal(exits.length, 1);
  assert.equal(starts[0].count, 1, "one observed worker");
  assert.equal(exits[0].count, 0, "worker exit must be observed");
  for (const row of r.workerTrace)
    assert.equal(row.pid, r.pid, "worker belongs to another composition phase");
}
export function assertContentionEvidence(evidence) {
  const observed = evidence.contention;
  assert.ok(observed, "Missing contention observations");
  assert.equal(observed.owners.length, 2);
  assert.notEqual(observed.owners[0].sourceKey, observed.owners[1].sourceKey);
  for (const owner of observed.owners) {
    for (const key of ["sourceKey", "pluginId"])
      assert.ok(typeof owner[key] === "string" && owner[key].length > 0);
    integer(owner.generation, "owner generation");
    identity(owner.hostEpoch);
    identity(owner.processEpoch);
  }
  assert.equal(observed.owners[0].hostEpoch, observed.owners[1].hostEpoch);
  identity(observed.sessionId);
  const cp = observed.checkpoint;
  assert.ok(cp, "Missing durable original checkpoint");
  identity(cp.checkpoint);
  identity(cp.record.id);
  identity(cp.recordTicket.id);
  assert.deepEqual(cp.recordTicket.owner, observed.owners[0]);
  assert.deepEqual(cp.recordTicket.target, {
    kind: "record",
    id: cp.record.id,
    expectedRevision: null,
  });
  assert.deepEqual(cp.recordTicket.metadata, { kind: "record", record: cp.record, deleted: false });
  assert.equal(cp.receipt.revision, cp.record.revision);
  identity(cp.receipt.commitId);
  assert.ok(["file-and-directory-sync", "file-sync-only"].includes(cp.receipt.durability));
  assert.equal(cp.document.checkpoint, cp.checkpoint);
  assert.deepEqual(cp.document.record, cp.record);
  assert.equal(cp.document.state, "open");
  assert.deepEqual(cp.document.binding.owner, observed.owners[0]);
  assert.equal(cp.document.binding.reservationId, observed.released.reservationId);
  assert.equal(cp.document.binding.sessionId, observed.sessionId);
  const bytes = Buffer.from(cp.payloadBase64, "base64");
  assert.ok(bytes.length > 0);
  assert.equal(bytes.length, cp.record.byteLength);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), cp.record.sha256);
  assert.deepEqual(cp.publication.ticket.owner, observed.owners[0]);
  assert.deepEqual(cp.publication.ticket.target, { kind: "recovery", key: cp.checkpoint });
  assert.deepEqual(cp.publication.ticket.metadata, { kind: "recovery", key: cp.checkpoint });
  identity(cp.publication.ticket.id);
  assert.equal(cp.publication.result.disposition, "committed");
  identity(cp.publication.result.receipt.commitId);
  assert.ok(
    ["file-and-directory-sync", "file-sync-only"].includes(
      cp.publication.result.receipt.durability,
    ),
  );
  // Worker reconciliation is independent of the API receipt and the publish reply.
  assert.equal(cp.recordOutcome.disposition, "committed");
  assert.deepEqual(cp.recordOutcome.receipt, cp.receipt);
  assert.deepEqual(cp.recoveryOutcome, cp.publication.result);
  assert.ok(typeof cp.recoveryOutcome.receipt.revision === "string");
  const pause = cp.pause;
  assert.deepEqual(pause.document, cp.document);
  assert.deepEqual(pause.ticket, cp.publication.ticket);
  finite(pause.pausedAt, "registration pause");
  finite(pause.releasedAt, "registration resume");
  assert.ok(pause.releasedAt >= pause.pausedAt);
  assert.equal(
    pause.traceBeforeRelease.filter(
      (row) => row.ticket === pause.ticket.id && row.point === "before-publish",
    ).length,
    1,
  );
  assert.ok(
    !pause.traceBeforeRelease.some(
      (row) => row.ticket === pause.ticket.id && row.point === "after-publish",
    ),
  );
  assert.equal(
    pause.traceAfterRelease.filter(
      (row) => row.ticket === pause.ticket.id && row.point === "after-publish",
    ).length,
    1,
  );
  for (const probe of observed.motionProbes) {
    finite(probe.startedAt, "probe start");
    finite(probe.endedAt, "probe end");
    assert.ok(
      pause.pausedAt <= probe.startedAt &&
        probe.startedAt <= probe.endedAt &&
        probe.endedAt <= pause.releasedAt,
      "Motion probe outside original registration pause",
    );
  }
  const { ended, offer, deadline, dispatchedAt, request, report } = observed.finalDrain;
  const binding = cp.document.binding;
  integer(binding.providerGeneration, "original provider generation");
  for (const key of ["owner", "sessionId", "reservationId", "providerGeneration"])
    assert.deepEqual(ended[key], binding[key], `Reservation end changed ${key}`);
  assert.equal(ended.reason, "released");
  integer(ended.lastSequence, "original last sequence");
  finite(ended.endedMonotonicMs, "original reservation end");
  const grant = ended.drain;
  assert.deepEqual(grant.owner, binding.owner);
  assert.equal(grant.reservationId, binding.reservationId);
  assert.equal(grant.lastSequence, ended.lastSequence);
  finite(grant.expiresMonotonicMs, "original grant expiry");
  finite(deadline, "original end deadline");
  finite(dispatchedAt, "drain dispatch");
  assert.deepEqual(offer.owner, binding.owner);
  identity(offer.token);
  assert.equal(offer.reason, "reservation-ended");
  assert.equal(
    offer.deadlineMonotonicMs,
    Math.min(deadline, ended.endedMonotonicMs + 10000, grant.expiresMonotonicMs),
  );
  assert.ok(dispatchedAt >= ended.endedMonotonicMs && dispatchedAt < offer.deadlineMonotonicMs);
  assert.equal(request.token, offer.token);
  assert.equal(request.reason, offer.reason);
  finite(request.remainingMs, "bounded SDK drain budget");
  assert.ok(request.remainingMs > 0 && request.remainingMs <= 10000);
  // Dispatch observation follows request construction in the same call stack.
  assert.ok(Math.abs(dispatchedAt + request.remainingMs - offer.deadlineMonotonicMs) < 5);
  assert.deepEqual(request.writes, []);
  assert.deepEqual(request.checkpoints, offer.checkpoints);
  assert.equal(request.checkpoints.length, 1);
  assert.deepEqual(request.checkpoints[0], {
    checkpoint: cp.checkpoint,
    record: cp.record,
    reservationEnd: {
      reservationId: binding.reservationId,
      reason: ended.reason,
      lastSequence: ended.lastSequence,
    },
  });
  const final = observed.finalPublication;
  assert.equal(observed.finalWrites.length, 1);
  const write = observed.finalWrites[0];
  assert.deepEqual(write.owner, binding.owner);
  for (const key of ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"]) {
    assert.ok(Object.hasOwn(write.params, key), `Missing final SDK record ${key}`);
    assert.ok(Object.hasOwn(observed.finalRecord, key), `Missing final worker record ${key}`);
    assert.equal(write.params[key], observed.finalRecord[key], `Final SDK record ${key}`);
  }
  assert.equal(write.params.drainToken, offer.token);
  assert.deepEqual(write.params.target, {
    mode: "replace",
    id: cp.record.id,
    expectedRevision: cp.record.revision,
  });
  assert.deepEqual(write.params.checkpoint, { handle: cp.checkpoint, phase: "final" });
  assert.equal(write.result.write, final.ticket.id);
  assert.equal(write.result.id, cp.record.id);

  assert.deepEqual(final.ticket.owner, binding.owner);
  assert.deepEqual(final.ticket.target, {
    kind: "record",
    id: cp.record.id,
    expectedRevision: cp.record.revision,
  });
  assert.deepEqual(final.ticket.metadata, {
    kind: "record",
    record: observed.finalRecord,
    deleted: false,
  });
  assert.equal(final.result.disposition, "committed");
  identity(final.result.receipt.commitId);
  assert.equal(final.result.receipt.revision, observed.finalRecord.revision);
  assert.ok(
    ["file-and-directory-sync", "file-sync-only"].includes(final.result.receipt.durability),
  );
  assert.equal(report.records.length, 1);
  assert.equal(report.records[0].id, cp.record.id);
  assert.equal(report.records[0].committedRevision, final.result.receipt.revision);
  assert.equal(report.records[0].final, true);
  assert.deepEqual(report.errors, []);
  assert.equal(observed.finalDrain.report.state, "saved");
  assert.equal(observed.finalDrain.report.blocker, false);
  assert.ok(
    observed.finalDrain.request.checkpoints.some(
      (row) =>
        row.checkpoint === cp.checkpoint &&
        row.record.id === cp.record.id &&
        row.record.revision === cp.record.revision,
    ),
  );
  assert.equal(observed.finalRecord.id, cp.record.id);
  assert.equal(observed.finalRecord.checkpoint, "final");
  assert.notEqual(observed.finalRecord.revision, cp.record.revision);
  const reservationId = observed.released.reservationId;
  const operationId = observed.stopped.operationId;
  identity(reservationId);
  identity(operationId);
  let overlaps = 0;
  for (const [name, active, idKey, id] of [
    ["motionProbes", "active", "reservationId", reservationId],
    ["recordingProbes", "running", "operationId", operationId],
  ]) {
    const probes = observed[name];
    assert.equal(probes.length, 2, `Missing ${name} for both original owners`);
    for (const [index, probe] of probes.entries()) {
      assert.deepEqual(probe.owner, observed.owners[index], "Probe owner changed");
      for (const snapshot of [probe.before, probe.after]) {
        assert.equal(snapshot[idKey], id, "Wrong conflicting resource");
        assert.equal(snapshot.sessionId, observed.sessionId, "Wrong conflicting session");
        assert.equal(snapshot.state ?? snapshot.phase, active, "No active conflicting resource");
      }
      overlaps += Number(probe.result.ok === true);
      assert.equal(probe.result.ok, false);
      assert.equal(probe.result.error.code, "PLUGIN_E_DEVICE_BUSY", "Not an admission conflict");
    }
  }
  assert.equal(observed.released.state, "ended");
  assert.equal(observed.released.reason, "released");
  assert.equal(observed.released.sessionId, observed.sessionId);
  assert.equal(observed.stopped.sessionId, observed.sessionId);
  assert.equal(observed.stopped.stage, "terminal");
  assert.ok(["stopped", "completed"].includes(observed.stopped.phase));
  assert.equal(observed.stopped.stopConfirmation, "confirmed");
  const blocked = observed.blockedSave;
  assert.ok(blocked, "Missing simultaneous blocked-save/stop observations");
  let previous = -1;
  for (const key of ["pausedAt", "stopRequestedAt", "stopConfirmedAt", "saveReleasedAt"]) {
    finite(blocked[key], key);
    assert.ok(blocked[key] >= previous, "Stop did not precede releasing the blocked save");
    previous = blocked[key];
  }
  assert.equal(blocked.motionDuringSave.operationId, operationId);
  assert.equal(blocked.motionDuringSave.sessionId, observed.sessionId);
  assert.equal(blocked.motionDuringSave.phase, "running");
  assert.equal(blocked.writeSettledAtStop, false);
  identity(blocked.pausedTicket);
  assert.equal(blocked.expectedTicket.id, blocked.pausedTicket);
  assert.deepEqual(blocked.expectedTicket.owner, {
    ...observed.owners[1],
    hostEpoch: observed.winnerBefore.binding.scope.hostEpoch,
    processEpoch: observed.winnerBefore.binding.scope.workbenchInstance,
  });
  assert.deepEqual(blocked.expectedTicket.target, {
    kind: "settings",
    expectedRevision: observed.beforeForm.state.baseline.revision,
  });
  assert.equal(blocked.expectedTicket.metadata.kind, "settings");
  assert.ok(
    blocked.traceBeforeRelease.some(
      (row) => row.point === "before-publish" && row.ticket === blocked.pausedTicket,
    ),
  );
  assert.equal(
    blocked.traceBeforeRelease.filter(
      (row) => row.point === "after-publish" && row.ticket === blocked.pausedTicket,
    ).length,
    0,
  );
  assert.equal(
    blocked.traceAfterRelease.filter(
      (row) => row.point === "after-publish" && row.ticket === blocked.pausedTicket,
    ).length,
    1,
  );
  assert.equal(evidence.checks.concurrentActive, overlaps);
  assert.equal(evidence.checks.motionWhileRecording, "busy");
  assert.equal(evidence.checks.recordingWhileMotion, "busy");

  assert.deepEqual(observed.updates.map((row) => row.caller).sort(), ["form", "winner"]);
  const winner = observed.updates.find((row) => row.caller === "winner");
  const loser = observed.updates.find((row) => row.caller === "form");
  const before = observed.beforeForm,
    after = observed.afterForm;
  const wb = observed.winnerBefore,
    wa = observed.winnerAfter;
  assert.ok(wb && wa, "Missing second native window");
  assert.deepEqual(winner.binding, wb.binding);
  assert.deepEqual(loser.binding, before.binding);
  assert.deepEqual(wb.binding.owner, before.binding.owner);
  assert.equal(wb.binding.scope.hostEpoch, before.binding.scope.hostEpoch);
  identity(wb.binding.scope.workbenchInstance);
  identity(before.binding.scope.workbenchInstance);
  assert.notEqual(wb.binding.scope.workbenchInstance, before.binding.scope.workbenchInstance);
  assert.deepEqual(wb.state.baseline, before.state.baseline);
  assert.deepEqual(wa.binding, wb.binding);
  assert.deepEqual(wa.fieldIds, wb.fieldIds);
  const winnerId = `setting-${wb.binding.scope.workbenchInstance}-${wb.fieldIds["fixture.note"]}`;
  assert.equal(wb.input.id, winnerId);
  assert.equal(wa.input.id, winnerId);
  assert.equal(wb.raw["fixture.note"], wb.input.value);
  assert.deepEqual(winner.params.changes, [{ key: "fixture.note", value: wb.input.value }]);
  assert.ok(
    wb.inputEvents.some(
      (e) =>
        e.id === winnerId && e.type === "input" && e.trusted === true && e.value === wb.input.value,
    ),
  );
  assert.ok(
    wa.inputEvents.some(
      (e) =>
        e.id === winnerId &&
        e.type === "keydown" &&
        e.key === "Enter" &&
        e.trusted === true &&
        e.value === wb.input.value,
    ),
  );
  assert.equal(before.binding.owner.sourceKey, observed.owners[1].sourceKey);
  assert.equal(before.binding.owner.pluginId, observed.owners[1].pluginId);
  assert.equal(before.binding.scope.hostEpoch, observed.owners[1].hostEpoch);
  assert.deepEqual(after.binding, before.binding, "The conflicted form was replaced");
  assert.deepEqual(after.fieldIds, before.fieldIds, "Settings field map changed");
  const inputId = `setting-${before.binding.scope.workbenchInstance}-${before.fieldIds["fixture.note"]}`;
  for (const form of [before, after]) {
    assert.ok(typeof form.fieldIds["fixture.note"] === "string");
    assert.equal(form.input.id, inputId, "Wrong native field");
    assert.equal(form.input.value, before.raw["fixture.note"]);
    assert.equal(form.raw["fixture.note"], before.raw["fixture.note"]);
  }
  assert.ok(
    typeof before.raw["fixture.note"] === "string" && before.raw["fixture.note"].length > 0,
  );
  for (const update of observed.updates) {
    assert.equal(
      update.params.expectedRevision,
      before.state.baseline.revision,
      "Not the same CAS revision",
    );
    assert.equal(update.params.schemaVersion, before.state.baseline.schemaVersion);
  }
  assert.deepEqual(loser.params.changes, [
    { key: "fixture.note", value: before.raw["fixture.note"] },
  ]);
  assert.equal(winner.result.ok, true);
  assert.equal(loser.result.ok, false);
  assert.equal(loser.result.error.code, "PLUGIN_E_SETTINGS_CONFLICT");
  assert.notEqual(observed.persisted.revision, before.state.baseline.revision);
  assert.deepEqual(observed.persisted, winner.result.value.snapshot);
  const persisted = observed.persisted.values.find((row) => row.key === "fixture.note");
  assert.ok(persisted);
  assert.deepEqual(winner.params.changes, [{ key: "fixture.note", value: persisted.value }]);
  assert.notEqual(persisted.value, before.raw["fixture.note"]);
  assert.ok(
    after.state.draft.some(
      (row) => row.key === "fixture.note" && row.value === before.raw["fixture.note"],
    ),
  );
  assert.ok(after.state.errors.some((row) => row.key === "fixture.note"));
  assert.ok(!after.state.busyKeys.includes("fixture.note"));
  assert.ok(
    before.inputEvents.some(
      (event) =>
        event.id === inputId &&
        event.type === "input" &&
        event.trusted === true &&
        event.value === before.raw["fixture.note"],
    ),
    "Missing trusted text input",
  );
  assert.ok(
    after.inputEvents.some(
      (event) =>
        event.id === inputId &&
        event.type === "keydown" &&
        event.key === "Enter" &&
        event.trusted === true &&
        event.value === before.raw["fixture.note"],
    ),
    "Missing trusted form submission",
  );
  assert.equal(
    evidence.checks.settingsSuccess,
    observed.updates.filter((row) => row.result.ok).length,
  );
  assert.equal(
    evidence.checks.settingsConflict,
    observed.updates.filter(
      (row) => !row.result.ok && row.result.error.code === "PLUGIN_E_SETTINGS_CONFLICT",
    ).length,
  );
  assert.equal(evidence.checks.dirtyDraftPreserved, true);
}
export function verifyFoundationReports(reports, cases) {
  assert.ok(
    reports.every((r) => !r.evidence?.pressure),
    "partial pressure trial is not full foundation acceptance",
  );
  assert.ok(
    reports.every((r) => !r.evidence?.importSlice),
    "partial import trial is not full foundation acceptance",
  );
  assert.deepEqual(
    reports.map((r) => r.case).sort(),
    [...cases].sort(),
    "missing/duplicate case receipts",
  );
  for (const r of reports) verifyRunReceipt(r);
  assert.equal(
    new Set(reports.map((r) => r.profileId)).size,
    reports.length,
    "one fresh profile per case",
  );
  assert.equal(
    new Set(reports.map((r) => r.hostEpoch)).size,
    reports.length,
    "fresh hostEpoch per case",
  );
  assert.equal(new Set(reports.map((r) => r.pid)).size, reports.length, "fresh process per case");
}
// Disjoint AM-22 ownership. State stores can have several distinct retained instances.
const diagnosticOwners = {
  "ui-state": ["bindings", "subscriptions", "queuedEvents", "queuedBytes"],
  "ui-lifecycle": ["owners"],
  "ui-bridge": ["pendingInvocations", "actionTokens"],
  "state-store": ["queuedEvents", "queuedBytes"],
  "host-ports": ["resourceReaders"],
  worker: ["workerJobs"],
};
export function verifyDiagnostics(rows, final = false) {
  assert.deepEqual(
    [...new Set(rows.map((r) => r.module))].sort(),
    Object.keys(diagnosticOwners).sort(),
    "missing diagnostic modules",
  );
  const seen = new Set();
  for (const row of rows) {
    assert.ok(typeof row.instance === "string" && row.instance.length > 0, "diagnostic identity");
    assert.ok(!seen.has(row.instance), "duplicate diagnostic instance");
    seen.add(row.instance);
    for (const key of [...new Set([...Object.values(diagnosticOwners).flat(), "timers"])]) {
      integer(row.snapshot[key], `diagnostic ${key}`);
      if (final || (key !== "timers" && !diagnosticOwners[row.module].includes(key)))
        assert.equal(row.snapshot[key], 0, `duplicate/leaked diagnostic ${key}`);
    }
  }
}
function realReport(report) {
  assert.equal(report.level, "real-process", "evidence must be real-process");
  verifyRunReceipt(report.execution);
}
export const IMPORT_BOUNDARIES = Object.freeze([
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
]);
export function verifyRestartDetails(trials) {
  assert.deepEqual(
    trials.map((t) => t.boundary).sort(),
    [...IMPORT_BOUNDARIES].sort(),
    "restart boundaries missing/duplicate",
  );
  for (const t of trials) {
    assert.equal(t.actualProcessDeath, true);
    integer(t.pid, "killed pid");
    assert.ok(t.pid > 0);
    identity(t.hostEpoch);
    assert.ok(t.signal === "SIGKILL" || t.platformTermination === "taskkill-/T-/F");
    assert.ok(t.reopens.length >= 3);
    assert.equal(
      new Set([t.hostEpoch, ...t.reopens.map((r) => r.hostEpoch)]).size,
      t.reopens.length + 1,
    );
    assert.ok(t.expectedIds.length > 0);
    t.expectedIds.forEach(identity);
    t.expectedHashes.forEach(hash);
    assert.equal(t.expectedIds.length, t.expectedHashes.length);
    t.originalHashes.forEach(hash);
    hash(t.persistedPreferenceDigest);
    hash(t.expectedPreferenceMappedHash);
    for (const r of t.reopens) {
      identity(r.hostEpoch);
      integer(r.pid, "reopen pid");
      assert.ok(r.pid > 0);
      assert.notEqual(r.pid, t.pid);
      assert.equal(r.profileId, t.profileId);
      assert.ok(typeof t.profileId === "string" && t.profileId.length > 0);
      assert.deepEqual(r.ids, t.expectedIds);
      assert.deepEqual(r.hashes, t.expectedHashes);
      assert.deepEqual(r.originalHashes, t.originalHashes);
      assert.equal(r.committedDestinations, new Set(r.ids).size);
      assert.deepEqual(r.skipReasons, t.skipReasons);
      for (const k of [
        "completedItems",
        "committedItems",
        "skippedItems",
        "barrierRestoredAt",
        "writerStartAttemptAt",
      ])
        integer(r[k], k);
      assert.equal(r.completedItems, r.committedItems + r.skippedItems);
      assert.ok(r.barrierRestoredAt <= r.writerStartAttemptAt);
      for (const k of [
        "writerAdmitted",
        "deletedRecordResurrected",
        "rendererPresent",
        "oldWindowSubmitAccepted",
      ])
        assert.equal(r[k], false, k);
      assert.equal(r.publishesWhileUnknown, 0);
      assert.equal(r.preferenceSourceHash, t.persistedPreferenceDigest);
      assert.equal(r.preferenceMappedHash, t.expectedPreferenceMappedHash);
      assert.ok(
        r.workerTrace?.some((e) => e.kind === "start" && e.pid === r.pid),
        "missing phase worker trace",
      );
    }
  }
}

// Test-only entry finalization shared by the generated Electron entry and pure flow tests.
export function diagnosticError(error, depth = 0) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    ...(typeof error?.stack === "string" ? { stack: error.stack } : {}),
    ...(depth < 4 && error?.cause !== undefined
      ? { cause: diagnosticError(error.cause, depth + 1) }
      : {}),
    ...(depth < 4 && Array.isArray(error?.errors)
      ? { errors: error.errors.slice(0, 16).map((child) => diagnosticError(child, depth + 1)) }
      : {}),
  };
}
export async function runReferenceEntry(createFixture, config, io) {
  let fixture,
    originalError,
    closed = false;
  const cleanupErrors = [];
  const recordFailure = async (cleanupState, suffix) => {
    const failure = {
      format: 1,
      kind: "persistence-entry-failure",
      status: "failed",
      runId: config.runId,
      case: config.case,
      pid: io.pid,
      originalError,
      cleanupState,
      cleanupErrors: [...cleanupErrors],
      reportedAt: io.now(),
    };
    try {
      await io.write(`${config.report}.${suffix}.json`, JSON.stringify(failure));
    } catch (error) {
      const diagnostic = diagnosticError(error);
      cleanupErrors.push(diagnostic);
      failure.cleanupErrors.push(diagnostic);
      (io.reportFailure ?? console.error)(failure);
    }
  };
  try {
    fixture = await createFixture();
    const started = fixture.composition.workerCount;
    const evidence = await fixture.runCase(config.case);
    const phase = config.case === "all-optional-off" ? config.optionalPhase : undefined;
    if (phase === "seed") {
      assertOptionalPhase(evidence.optionalPhase);
      // Deliberate retained-profile exit. Do not claim clean lifecycle/worker shutdown.
      closed = true;
    } else {
      await fixture.close();
      await fixture.close();
      closed = true;
    }
    await fixture.finishObservation?.(evidence);
    const workers = fixture.composition.workerCount,
      listeners = fixture.composition.reservationListenerCount;
    await io.write(
      config.report,
      JSON.stringify({
        format: 1,
        level: "real-process",
        status:
          phase === "seed"
            ? "retained-phase"
            : phase === "settings"
              ? "closed-phase"
              : ["retirement", "healthy-release"].includes(config.case)
                ? "closed-reference"
                : "closed-case",
        runId: config.runId,
        case: config.case,
        commit: config.commit,
        bundleSha256: config.bundleSha256,
        artifactSha256: config.artifactSha256,
        pid: io.pid,
        profileId: config.profileId,
        hostEpoch: fixture.composition.profile.hostEpoch,
        environment: fixture.environment,
        evidence,
        ...(phase === "seed" ? { retainedAt: io.now() } : { closedAt: io.now() }),
        cleanup: { workers, listeners, errors: [] },
        workerTrace: [
          { kind: "start", count: started, pid: io.pid },
          ...(phase === "seed" ? [] : [{ kind: "exit", count: workers, pid: io.pid }]),
        ],
      }),
    );
    return 0;
  } catch (error) {
    originalError = diagnosticError(error);
  } finally {
    if (fixture && !closed) {
      // Keep an immutable first-failure record outside the potentially hanging
      // close. A later final record must never truncate this fallback evidence.
      await recordFailure("pending", "entry-failure-pending");
      try {
        await fixture.close();
      } catch (error) {
        cleanupErrors.push(diagnosticError(error));
      }
    }
  }
  await recordFailure(cleanupErrors.length ? "failed" : "settled", "entry-failure");
  return 1;
}

// Independent receipt binding: no producer summary helper or checks constants.
export function assertUnknownEvidence(evidence) {
  const o = evidence.unknown;
  assert.ok(o, "Missing unknown-publication observations");
  assertUnknownObservation(o);
  const digest = (blob) =>
    createHash("sha256").update(Buffer.from(blob.data, "base64")).digest("hex");
  const publish = o.calls.filter(
    (r) => r.phase === "publish" && r.method === "storage/commitWrite",
  );
  const create = o.calls.filter((r) => r.phase === "probe" && r.method === "storage/beginWrite");
  const exported = o.export.calls.filter((r) => r.method === "reconcile");
  assert.deepEqual(o.reconciliation.ticket, o.ticket);
  assert.deepEqual(evidence.events, []);
  assert.deepEqual(evidence.samples, {});
  assert.deepEqual(evidence.checks, {
    disposition: publish[0].result.error.detail.disposition,
    oldEvidenceRetained: digest(o.disk.oldObject) === o.oldTicket.metadata.record.sha256,
    newEvidenceRetained: digest(o.disk.newObject) === o.ticket.metadata.record.sha256,
    namespaceFenced:
      create.length === 1 &&
      create[0].result.ok === false &&
      o.traces.probe.length === o.traces.unknown.length,
    secondPublicationCalls:
      o.traces.final.filter((r) => r.point === "after-publish" && r.ticket === o.ticket.id).length -
      1,
    reconciledOriginalTicket: o.reconciliation.ticket.id === o.ticket.id,
    reconciledDisposition: o.reconciliation.result.disposition,
    exportOriginalJobReconciled:
      exported.length === 3 && exported.every((r) => r.job === o.export.job),
    noRepublish:
      o.export.calls.filter((r) => r.method === "commit").length === 1 &&
      exported.every((r) => r.trace.every((t) => t.point !== "after-publish")),
    destinationIdentityPreserved: o.export.staged.identity === o.export.final.identity,
  });
}

export function assertActionReplayEvidence(evidence) {
  assert.ok(evidence.actionReplay, "Missing action replay observations");
  assertActionObservation(evidence.actionReplay);
  assert.deepEqual(
    evidence.checks,
    actionSummary(evidence.actionReplay),
    "Action summary differs from raw observations",
  );
}
