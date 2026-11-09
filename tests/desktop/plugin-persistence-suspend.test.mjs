import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertSuspendObservation, produceSuspendWake } from "./plugin-persistence-suspend.ts";

// Synthetic validator inputs only. These tests never produce a native receipt.
function observation() {
  const owner = {
    sourceKey: "builtin:test",
    pluginId: "test",
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const record = {
    id: "record",
    revision: "original-revision",
    kind: "test.registration-end",
    schemaVersion: 1,
    label: "record",
    mediaType: "application/octet-stream",
    byteLength: 4,
    sha256: hash("seed"),
    createdAt: 1,
    updatedAt: 1,
    checkpoint: "none",
    interrupted: false,
  };
  const finalBytes = Buffer.from(`Synthetic final checkpoint ${record.id}\n`);
  const finalRecord = {
    ...record,
    revision: "revision",
    checkpoint: "final",
    byteLength: finalBytes.length,
    sha256: hash(finalBytes),
  };
  const binding = {
    owner,
    reservationId: "reservation",
    sessionId: "session",
    providerGeneration: 1,
  };
  const checkpoints = [
    {
      checkpoint: "checkpoint",
      record,
      reservationEnd: { reservationId: "reservation", reason: "suspended", lastSequence: 1 },
    },
  ];
  const offer = {
    owner,
    token: "original",
    deadlineMonotonicMs: 10001,
    reason: "reservation-ended",
    checkpoints,
    writes: [],
  };
  const admission = {
    barrier: { scope: { kind: "namespace", owner }, through: 3, deadlineMonotonicMs: 10001 },
    tickets: [],
  };
  const trace = [
    { phase: "setup", kind: "provider-motion", method: "executeFiniteMotion" },
    {
      phase: "setup",
      kind: "peer",
      method: "command/execute",
      params: { command: "acceptance.ui-recording.legacy" },
    },
    { phase: "setup", kind: "request", method: "devices/motion/start" },
    { phase: "recording-setup", kind: "request", method: "devices/recording/reserve" },
    ...["motion", "recording"].flatMap((phase) => [
      { phase, kind: "quiesce", method: "suspended" },
      { phase: `${phase}-wake`, kind: "resume", method: "resume" },
      { phase: `${phase}-wake`, kind: "request", method: "devices/list" },
      { phase: `${phase}-wake`, kind: "request", method: "devices/list" },
    ]),
  ];
  const providerBefore = [{ operationId: "motion", step: "motion-pulse", dispatch: "sent" }];
  trace.push(
    ...["start", "prepare"].map((method, i) => ({
      phase: "motion-wake",
      kind: "request",
      method: `devices/motion/${method}`,
      callId: i ? "gesture-probe" : "start-probe",
    })),
  );
  return {
    trace,
    checkpoint: {
      checkpoint: "checkpoint",
      record,
      document: { checkpoint: "checkpoint", record, binding },
      payloadBase64: Buffer.from("seed").toString("base64"),
    },
    finalRecord,
    originalReservation: { reservationId: "reservation", sessionId: "session", state: "active" },
    probeCalls: { start: "start-probe", gesture: "gesture-probe" },
    grantProbe: {
      owner,
      params: {
        target: { mode: "replace", id: record.id, expectedRevision: finalRecord.revision },
        kind: record.kind,
        schemaVersion: record.schemaVersion,
        label: record.label,
        mediaType: record.mediaType,
        byteLength: finalRecord.byteLength,
        sha256: finalRecord.sha256,
        checkpoint: { handle: "checkpoint", phase: "final" },
        drainToken: offer.token,
      },
      result: {
        ok: false,
        error: {
          code: "PLUGIN_E_STALE_RESOURCE",
          detail: { kind: "resource", reason: "stale", resource: "storage-write" },
        },
      },
      started: 430,
      ended: 431,
      before: structuredClone(admission),
      after: structuredClone(admission),
      recordAfter: structuredClone(finalRecord),
    },
    originalOwner: owner,
    currentOwner: { ...owner },
    retire: [],
    freeze: [],
    exits: [],
    operationId: "motion",
    deadlineBefore: 30000,
    deadlineAfter: 30000,
    oldStart: { ok: false },
    oldGesture: { ok: false },
    gestureAgeAtProbe: 20,
    offerBefore: offer,
    reservationAfter: { reservationId: "reservation", sessionId: "session", state: "ended" },
    ended: {
      ...binding,
      lastSequence: 1,
      reason: "suspended",
      reservationId: "reservation",
      endedMonotonicMs: 1,
      drain: { owner, reservationId: "reservation", lastSequence: 1, expiresMonotonicMs: 10001 },
    },
    requests: [
      {
        token: "original",
        reason: "reservation-ended",
        writes: [],
        remainingMs: 9999,
        checkpoints: structuredClone(checkpoints),
      },
    ],
    dispatchedAt: [2],
    drainStartedAt: 1,
    report: {
      state: "saved",
      blocker: false,
      pendingSettings: false,
      errors: [],
      records: [{ id: "record", final: true, committedRevision: "revision" }],
    },
    finalCheckpoint: "final",
    providerBefore,
    providerAfter: [
      ...providerBefore,
      ...["stop", "readback"].map((step) => ({ operationId: "motion", step, dispatch: "sent" })),
    ],
    settlements: ["motion", "recording"].map((phase) => ({
      phase,
      disposition: { stopConfirmed: true, journalCommitted: true, faultIds: [] },
    })),
    windows: ["motion", "recording"].map((phase) => ({ phase, started: 1, ended: 426 })),
  };
}

test("suspend validator rejects every missing observation", () => {
  assertSuspendObservation(observation());
  for (const key of Object.keys(observation())) {
    const missing = observation();
    delete missing[key];
    assert.throws(() => assertSuspendObservation(missing), key);
  }
  for (const field of [
    "trace",
    "providerBefore",
    "providerAfter",
    "requests",
    "windows",
    "settlements",
    "dispatchedAt",
  ]) {
    const missing = observation();
    missing[field] = [];
    assert.throws(() => assertSuspendObservation(missing), field);
  }
});

test("suspend validator rejects forged lifecycle, replay, renewal and survival observations", () => {
  for (const mutate of [
    (o) => o.retire.push({}),
    (o) => o.freeze.push({}),
    (o) => o.exits.push({ code: 0 }),
    (o) => o.currentOwner.generation++,
    (o) => (o.reservationAfter.state = "active"),
    (o) => (o.reservationAfter.reservationId = "replacement"),
    (o) => o.trace.push({ phase: "recording-wake", kind: "drain", method: "storage/drain" }),
    (o) => o.deadlineAfter++,
    (o) => (o.oldStart.ok = true),
    (o) => (o.oldGesture.ok = true),
    (o) => (o.gestureAgeAtProbe = 350),
    (o) => o.trace.push({ phase: "recording-wake", kind: "drain", method: "drain" }),
    (o) => (o.grantProbe.params.drainToken = "replacement"),
    (o) => (o.grantProbe.ended = o.offerBefore.deadlineMonotonicMs),
    (o) => (o.ended.reason = "released"),
    (o) => o.ended.drain.expiresMonotonicMs--,
    (o) => (o.requests[0].token = "invented"),
    (o) => (o.requests[0].remainingMs += 2),
    (o) => (o.requests[0].checkpoints = []),
    (o) => o.requests.push(o.requests[0]),
    (o) => (o.finalCheckpoint = "checkpoint"),
    (o) => (o.settlements[0].disposition.stopConfirmed = false),
    (o) => (o.settlements[1].disposition.journalCommitted = false),
    (o) => o.settlements[0].disposition.faultIds.push("fault"),
    (o) => (o.report.state = "checkpoint-only"),
    (o) => (o.report.blocker = true),
    (o) => (o.report.records = []),
    (o) => (o.report.records[0].final = false),
    (o) => delete o.report.records[0].committedRevision,
    (o) => (o.windows[0].ended = Infinity),
    (o) => (o.trace = o.trace.filter((r) => r.kind !== "peer")),
    (o) => (o.trace.find((r) => r.kind === "quiesce").method = "core-disconnect"),
    (o) => (o.trace = o.trace.filter((r) => r.kind !== "resume")),
    (o) => (o.windows[0].ended = o.windows[0].started),
    (o) => o.providerAfter.shift(),
    (o) =>
      o.providerAfter.push({ operationId: "new-replay", step: "motion-pulse", dispatch: "sent" }),
    (o) => o.providerAfter.push({ operationId: "motion", step: "motion-pulse", dispatch: "sent" }),
    ...[
      "command/invoke",
      "command/execute",
      "devices/motion/start",
      "devices/recording/reserve",
    ].map((method) => (o) => o.trace.push({ phase: "recording-wake", kind: "request", method })),
  ]) {
    const forged = observation();
    mutate(forged);
    assert.throws(() => assertSuspendObservation(forged));
  }
});

// These are setup-failure doubles for existing ports. No lifecycle implementation
// is supplied or executed, and no successful evidence can be returned from them.
function setupFailure(stage) {
  const failure = new Error(`injected ${stage}`),
    cleaned = [],
    owner = observation().originalOwner;
  const principal = { kind: "plugin", owner, authorityContext: { ref: "context" } };
  const participant = { freeze() {}, endReservation() {}, drain() {} };
  const resources = { retire() {} };
  const peer = { request() {} };
  const broker = {
    resources,
    sessions: { quiesce() {}, resume() {} },
    intent: {
      bindMotionScope() {
        return "scope";
      },
      pulsePanel() {},
      beginGesture() {
        return "gesture";
      },
      pulseGesture() {},
      revokeScope(id) {
        cleaned.push(id);
        if (stage === "cleanup") throw new Error("revoke failed");
      },
    },
    async request(_principal, method) {
      if (method === "devices/recording/release") {
        cleaned.push("reservation");
        if (stage === "release" && cleaned.length === 1) throw failure;
        return { ok: true, value: {} };
      }
      if (method === "devices/session")
        return {
          ok: true,
          value: { sources: { actuators: [{ state: "ready", actuatorId: "actuator" }] } },
        };
      if (method === "devices/motion/prepare" && stage === "start")
        return { ok: true, value: { operation: { operationId: "held" } } };
      if (method === "devices/motion/stop") {
        cleaned.push("stop");
        return { ok: true, value: {} };
      }
      throw failure; // injected before any lifecycle adapter can run
    },
  };
  const input = {
    now: () => performance.now(),
    broker,
    stage3: { persistence: participant, device: resources },
    host: { participant },
    recording: {
      principal: () => principal,
      child: {
        onExit() {
          return () => cleaned.push("off-exit");
        },
      },
    },
    channel: { owner, peer },
    provider: { executeFiniteMotion() {} },
    providerControl: {
      block() {
        cleaned.push("blocked");
      },
      reached() {
        return Promise.resolve();
      },
      release() {
        cleaned.push("released-block");
      },
    },
    // Truthy sentinel: any accidental lifecycle invocation fails rather than faking suspend.
    lifecycle: Object.freeze({}),
    scope: () => ({ workbenchInstance: "window" }),
    command: async () => {
      if (stage === "command") throw failure;
    },
    reserveRecording: async () => ({ reservationId: "reservation", sessionId: "session" }),
  };
  return { input, cleaned, failure };
}

test("setup failures restore all observers and release reservations/scopes even when cleanup fails", async () => {
  for (const stage of ["command", "release", "prepare", "start", "cleanup"]) {
    const { input, cleaned, failure } = setupFailure(stage);
    const request = input.broker.request,
      peerRequest = input.channel.peer.request;
    const quiesce = input.broker.sessions.quiesce,
      retire = input.stage3.device.retire,
      resume = input.broker.sessions.resume;
    const { freeze, drain, endReservation } = input.host.participant;
    const execute = input.provider.executeFiniteMotion;
    await assert.rejects(produceSuspendWake(input), (error) => {
      if (stage !== "cleanup") return error === failure;
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.includes(failure));
      assert.ok(error.errors.some((e) => e.message === "revoke failed"));
      return true;
    });
    assert.ok(cleaned.includes("off-exit"));
    if (stage !== "command") assert.ok(cleaned.includes("reservation"));
    if (["prepare", "start", "cleanup"].includes(stage)) assert.ok(cleaned.includes("scope"));
    if (stage === "start") {
      assert.ok(cleaned.includes("blocked"));
      assert.ok(cleaned.includes("released-block"));
      assert.ok(cleaned.includes("stop"));
    }
    assert.equal(input.broker.request, request);
    assert.equal(input.channel.peer.request, peerRequest);
    assert.equal(input.broker.sessions.quiesce, quiesce);
    assert.equal(input.broker.sessions.resume, resume);
    assert.equal(input.stage3.device.retire, retire);
    assert.equal(input.host.participant.freeze, freeze);
    assert.equal(input.host.participant.drain, drain);
    assert.equal(input.host.participant.endReservation, endReservation);
    assert.equal(input.provider.executeFiniteMotion, execute);
  }
});

test("missing real composition seams cannot emit zero evidence", async () => {
  const { input } = setupFailure("command");
  delete input.lifecycle;
  await assert.rejects(produceSuspendWake(input), /Missing real composition suspend seams/);
});

test("original grant probe rejects masking errors, admissions, mutations and unrelated evidence", () => {
  for (const mutate of [
    (o) => (o.grantProbe.result = { ok: true, value: {} }),
    (o) => (o.grantProbe.result.error.code = "PLUGIN_E_STORAGE_CONFLICT"),
    (o) => (o.grantProbe.result.error.detail.resource = "rpc"),
    (o) => (o.grantProbe.params.target.expectedRevision = o.checkpoint.record.revision),
    (o) => o.grantProbe.after.barrier.through++,
    (o) => o.grantProbe.after.tickets.push({ id: "admitted" }),
    (o) => (o.grantProbe.recordAfter.revision = "changed"),
    (o) => (o.report.records[0].id = "unrelated"),
    (o) => (o.report.records[0].committedRevision = "unrelated"),
    (o) => (o.checkpoint.document.binding.sessionId = "unrelated"),
    (o) => o.checkpoint.document.binding.providerGeneration++,
    (o) => (o.ended.drain = { ...o.ended.drain, owner: { ...o.originalOwner, generation: 9 } }),
    (o) => (o.ended.drain.reservationId = "unrelated"),
    (o) => o.ended.drain.lastSequence++,
    (o) => (o.finalRecord.sha256 = "forged"),
    (o) => (o.finalRecord.id = "unrelated"),
    (o) => (o.trace.find((r) => r.kind === "peer").params.command = "renamed"),
  ]) {
    const o = observation();
    mutate(o);
    assert.throws(() => assertSuspendObservation(o));
  }
  for (const path of [
    "checkpoint.document.binding.owner",
    "checkpoint.document.binding.providerGeneration",
    "checkpoint.document.binding.sessionId",
    "ended.drain.owner",
    "ended.drain.reservationId",
    "ended.drain.lastSequence",
    "finalRecord.id",
    "finalRecord.revision",
    "finalRecord.sha256",
    "finalRecord.label",
    "grantProbe.params.checkpoint",
    "grantProbe.result.error.detail",
  ]) {
    const o = observation(),
      keys = path.split("."),
      key = keys.pop();
    const parent = keys.reduce((v, k) => v[k], o);
    delete parent[key];
    assert.throws(() => assertSuspendObservation(o), path);
  }
});

test("wake traffic during awaited probes and synchronous resume cannot borrow probe exemption", () => {
  for (const method of [
    "command/execute",
    "command/invoke",
    "devices/recording/reserve",
    "devices/motion/prepare",
    "devices/motion/start",
  ]) {
    for (const location of ["resume", "probe"]) {
      const o = observation();
      const index = o.trace.findIndex((r) =>
        location === "resume" ? r.kind === "resume" : r.callId === o.probeCalls.start,
      );
      o.trace.splice(index + 1, 0, { phase: "motion-wake", kind: "request", method });
      assert.throws(() => assertSuspendObservation(o), `${location}: ${method}`);
      o.trace[index + 1].callId = o.probeCalls.start;
      assert.throws(() => assertSuspendObservation(o), "duplicate probe identity");
    }
  }
});
