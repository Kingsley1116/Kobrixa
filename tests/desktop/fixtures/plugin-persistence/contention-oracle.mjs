import { createHash } from "node:crypto";
import { outcomeOracleFixture } from "./outcome-oracle.mjs";
// Synthetic verifier inputs only; never serialize as native acceptance evidence.
export function contentionOracle() {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const owners = [0, 1].map((n) => ({
    sourceKey: `builtin:test.owner${n}`,
    pluginId: `test.owner${n}`,
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(n + 2),
  }));
  const sessionId = id(4),
    reservationId = id(5),
    operationId = id(6);
  const binding = {
    owner: {
      sourceKey: owners[1].sourceKey,
      pluginId: owners[1].pluginId,
      uiResourceGeneration: 1,
    },
    scope: { hostEpoch: id(1), workbenchInstance: id(7) },
    resourceDigest: "a".repeat(64),
  };
  const inputId = `setting-${id(7)}-field0`;
  const baseline = {
    schemaVersion: 1,
    revision: id(8),
    values: [{ key: "fixture.note", value: "" }],
  };
  const persisted = {
    schemaVersion: 1,
    revision: id(9),
    values: [{ key: "fixture.note", value: "Winning write" }],
  };
  const beforeForm = {
    binding,
    fieldIds: { "fixture.note": "field0" },
    raw: { "fixture.note": "Losing draft" },
    input: { id: inputId, value: "Losing draft" },
    state: { baseline, draft: baseline.values, busyKeys: [], errors: [] },
    inputEvents: [{ id: inputId, type: "input", trusted: true, key: null, value: "Losing draft" }],
  };
  const afterForm = structuredClone(beforeForm);
  afterForm.state = {
    baseline: persisted,
    draft: [{ key: "fixture.note", value: "Losing draft" }],
    busyKeys: [],
    errors: [{ key: "fixture.note" }],
  };
  afterForm.inputEvents.push({
    id: inputId,
    type: "keydown",
    trusted: true,
    key: "Enter",
    value: "Losing draft",
  });
  const winnerBefore = structuredClone(beforeForm);
  winnerBefore.binding.scope.workbenchInstance = id(11);
  winnerBefore.input = { id: `setting-${id(11)}-field0`, value: "Winning write" };
  winnerBefore.raw["fixture.note"] = "Winning write";
  winnerBefore.inputEvents = [
    { ...beforeForm.inputEvents[0], id: winnerBefore.input.id, value: "Winning write" },
  ];
  const winnerAfter = structuredClone(winnerBefore);
  winnerAfter.state.baseline = persisted;
  winnerAfter.inputEvents.push({
    id: winnerBefore.input.id,
    type: "keydown",
    key: "Enter",
    trusted: true,
    value: "Winning write",
  });
  const payload = Buffer.from("original checkpoint");
  const record = {
    id: id(12),
    revision: "r_original",
    kind: "recording",
    schemaVersion: 1,
    label: "Original checkpoint",
    mediaType: "text/plain",
    byteLength: payload.length,
    sha256: createHash("sha256").update(payload).digest("hex"),
    createdAt: 0,
    updatedAt: 0,
    checkpoint: "open",
    interrupted: false,
  };
  const receipt = {
    revision: record.revision,
    commitId: id(13),
    durability: "file-and-directory-sync",
  };
  const checkpoint = {
    recordTicket: {
      id: id(17),
      owner: owners[0],
      target: { kind: "record", id: record.id, expectedRevision: null },
      metadata: { kind: "record", record, deleted: false },
    },
    record,
    receipt,
    payloadBase64: payload.toString("base64"),
    checkpoint: id(14),
    document: {
      checkpoint: id(14),
      record,
      state: "open",
      binding: { owner: owners[0], sessionId, reservationId, providerGeneration: 1 },
    },
    publication: {
      ticket: {
        id: id(15),
        owner: owners[0],
        target: { kind: "recovery", key: id(14) },
        metadata: { kind: "recovery", key: id(14) },
      },
      result: { disposition: "committed", receipt: { ...receipt, commitId: id(16) } },
    },
  };
  checkpoint.recordOutcome = { disposition: "committed", receipt: structuredClone(receipt) };
  checkpoint.recoveryOutcome = structuredClone(checkpoint.publication.result);
  checkpoint.pause = {
    document: structuredClone(checkpoint.document),
    ticket: structuredClone(checkpoint.publication.ticket),
    pausedAt: 1,
    releasedAt: 4,
    traceBeforeRelease: [{ point: "before-publish", ticket: id(15), time: 1 }],
    traceAfterRelease: [
      { point: "before-publish", ticket: id(15), time: 1 },
      { point: "after-publish", ticket: id(15), time: 5 },
    ],
  };
  const ended = {
    ...structuredClone(checkpoint.document.binding),
    reason: "released",
    lastSequence: 1,
    endedMonotonicMs: 5,
    drain: { owner: owners[0], reservationId, lastSequence: 1, expiresMonotonicMs: 10005 },
  };
  const offer = {
    owner: owners[0],
    token: id(18),
    reason: "reservation-ended",
    deadlineMonotonicMs: 10005,
    checkpoints: [
      {
        checkpoint: checkpoint.checkpoint,
        record,
        reservationEnd: { reservationId, reason: "released", lastSequence: 1 },
      },
    ],
    writes: [],
    acceptedTickets: [],
  };
  const finalRecord = { ...record, revision: "r_final", checkpoint: "final" };
  const recording = { sessionId, reservationId, state: "active" };
  const motion = { sessionId, operationId, phase: "running" };
  return {
    ...outcomeOracleFixture("contention"),
    contention: {
      finalDrain: {
        ended,
        offer: structuredClone(offer),
        deadline: 10005,
        dispatchedAt: 6,
        request: {
          token: offer.token,
          reason: offer.reason,
          remainingMs: 9999,
          checkpoints: structuredClone(offer.checkpoints),
          writes: [],
        },
        report: {
          state: "saved",
          blocker: false,
          records: [{ id: record.id, committedRevision: finalRecord.revision, final: true }],
          errors: [],
        },
      },
      checkpoint,
      finalRecord,
      finalWrites: [
        {
          owner: owners[0],
          params: {
            kind: finalRecord.kind,
            schemaVersion: finalRecord.schemaVersion,
            label: finalRecord.label,
            mediaType: finalRecord.mediaType,
            byteLength: finalRecord.byteLength,
            sha256: finalRecord.sha256,
            drainToken: offer.token,
            target: { mode: "replace", id: record.id, expectedRevision: record.revision },
            checkpoint: { handle: checkpoint.checkpoint, phase: "final" },
          },
          result: { write: id(19), id: record.id },
        },
      ],
      finalPublication: {
        ticket: {
          id: id(19),
          owner: owners[0],
          target: { kind: "record", id: record.id, expectedRevision: record.revision },
          metadata: { kind: "record", record: finalRecord, deleted: false },
        },
        result: {
          disposition: "committed",
          receipt: { ...receipt, revision: finalRecord.revision, commitId: id(20) },
        },
      },
      winnerBefore,
      winnerAfter,
      blockedSave: {
        pausedAt: 10,
        stopRequestedAt: 11,
        stopConfirmedAt: 12,
        saveReleasedAt: 13,
        writeSettledAtStop: false,
        motionDuringSave: motion,
        pausedTicket: id(10),
        expectedTicket: {
          id: id(10),
          owner: owners[1],
          target: { kind: "settings", expectedRevision: baseline.revision },
          metadata: { kind: "settings" },
        },
        traceBeforeRelease: [{ point: "before-publish", ticket: id(10), time: 10 }],
        traceAfterRelease: [
          { point: "before-publish", ticket: id(10), time: 10 },
          { point: "after-publish", ticket: id(10), time: 14 },
        ],
      },
      owners,
      sessionId,
      motionProbes: owners.map((owner) => ({
        startedAt: 2,
        endedAt: 3,
        owner,
        before: recording,
        after: recording,
        result: { ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } },
      })),
      recordingProbes: owners.map((owner) => ({
        owner,
        before: motion,
        after: motion,
        result: { ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } },
      })),
      released: { ...recording, state: "ended", reason: "released" },
      stopped: { ...motion, phase: "stopped", stage: "terminal", stopConfirmation: "confirmed" },
      updates: [
        {
          caller: "winner",
          binding: winnerBefore.binding,
          params: {
            schemaVersion: 1,
            expectedRevision: baseline.revision,
            changes: [{ key: "fixture.note", value: "Winning write" }],
          },
          result: { ok: true, value: { snapshot: persisted } },
        },
        {
          caller: "form",
          binding,
          params: {
            schemaVersion: 1,
            expectedRevision: baseline.revision,
            changes: [{ key: "fixture.note", value: "Losing draft" }],
          },
          result: { ok: false, error: { code: "PLUGIN_E_SETTINGS_CONFLICT" } },
        },
      ],
      beforeForm,
      afterForm,
      persisted,
    },
  };
}
