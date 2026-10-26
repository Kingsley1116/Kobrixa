import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import type { CaseEvidence, LifecycleCaseInput } from "./plugin-persistence-main.js";
import type { ContentionCheckpoint } from "./plugin-persistence-contention.js";
import type { LifecycleCoordinator } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type { FakeProviderControl } from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import type {
  BuiltinDeviceProvider,
  ProviderOperationContext,
} from "../../apps/desktop/src/main/device-broker/provider.js";
import type {
  CoreWindowScope,
  DeviceDisposition,
  DrainOffer,
  DrainReport,
  ReservationEnded,
  Stage3ChannelContext,
} from "@kobrixa/plugin-runtime";
import type {
  PublicationTicket,
  PersistenceBarrier,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type {
  RecordMeta,
  StorageRequestMap,
  ReservationSnapshot,
  DrainRequest,
} from "@kobrixa/plugin-protocol";

/** All handles belong to the ONE composeDesktopMain instance. No replacement lifecycle/provider. */
export type SuspendCaseInput = LifecycleCaseInput & {
  lifecycle: LifecycleCoordinator; // desktopLifecycle(composition), not PluginController.resume
  channel: Stage3ChannelContext; // original recording context paired with recording.child
  provider: BuiltinDeviceProvider; // exact instance returned by the admitted providerFactory
  providerControl: FakeProviderControl; // same provider, motionProfile: "staged"
  scope(): CoreWindowScope;
  reserveRecording(): Promise<ReservationSnapshot>;
  checkpoint(reservation: ReservationSnapshot): Promise<ContentionCheckpoint>;
  /** Explicit baseline command through the retained runtime/UI adapter, never peer replacement. */
  command(): Promise<void>;
};
function replaysMotion(row: ReturnType<FakeProviderControl["trace"]>[number], operationId: string) {
  return (
    (row.operationId === operationId && !["stop", "readback"].includes(row.step)) ||
    ["preflight", "helper-upload", "helper-run", "helper-arm", "motion-pulse"].includes(row.step)
  );
}
type Trace = { phase: string; kind: string; method: string; params: unknown; callId?: string };
export type SuspendObservation = {
  trace: Trace[];
  providerBefore: ReturnType<FakeProviderControl["trace"]>;
  providerAfter: ReturnType<FakeProviderControl["trace"]>;
  operationId: string;
  deadlineBefore: number;
  deadlineAfter: number;
  oldStart: { ok: boolean };
  oldGesture: { ok: boolean };
  gestureAgeAtProbe: number;
  ended: ReservationEnded;
  reservationAfter: ReservationSnapshot;
  offerBefore: DrainOffer;
  checkpoint: ContentionCheckpoint;
  finalRecord: RecordMeta;
  originalReservation: ReservationSnapshot;
  probeCalls: { start: string; gesture: string };
  grantProbe: {
    owner: Stage3ChannelContext["owner"];
    params: StorageRequestMap["storage/beginWrite"]["params"];
    result: StorageRequestMap["storage/beginWrite"]["result"];
    started: number;
    ended: number;
    before: { barrier: PersistenceBarrier; tickets: readonly PublicationTicket[] };
    after: { barrier: PersistenceBarrier; tickets: readonly PublicationTicket[] };
    recordAfter: RecordMeta;
  };
  requests: DrainRequest[];
  dispatchedAt: number[];
  drainStartedAt: number;
  report: DrainReport;
  finalCheckpoint: string;
  originalOwner: Stage3ChannelContext["owner"];
  currentOwner: Stage3ChannelContext["owner"];
  retire: unknown[];
  freeze: unknown[];
  exits: unknown[];
  windows: { phase: string; started: number; ended: number }[];
  settlements: { phase: string; disposition: DeviceDisposition }[];
};
function accepted<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) throw new Error("Live suspend operation failed");
  return result.value;
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Missing live suspend observation")), 25000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Validates retained observations, not just expected zero counters. Pure tests are not native proof. */
export function assertSuspendObservation(o: SuspendObservation): void {
  assert.deepEqual(o.currentOwner, o.originalOwner, "Original execution replaced");
  for (const rows of [o.retire, o.freeze, o.exits]) assert.equal(rows.length, 0);
  assert.ok(o.operationId);
  assert.equal(
    o.trace.filter((row) => row.kind === "provider-motion").length,
    1,
    "Missing or repeated provider motion invocation",
  );
  assert.ok(Number.isFinite(o.deadlineBefore) && o.deadlineBefore > 0);
  assert.equal(o.deadlineAfter, o.deadlineBefore, "Motion deadline renewed");
  assert.equal(o.oldStart.ok, false, "Old motion token renewed");
  assert.equal(o.oldGesture.ok, false, "Old gesture renewed");
  assert.ok(
    o.gestureAgeAtProbe >= 0 && o.gestureAgeAtProbe < 350,
    "Gesture expired before the revocation probe",
  );
  const binding = o.checkpoint.document.binding;
  assert.ok(binding);
  for (const key of ["sourceKey", "pluginId", "hostEpoch", "processEpoch"] as const)
    assert.ok(o.originalOwner[key]);
  assert.ok(Number.isSafeInteger(o.originalOwner.generation));
  assert.deepEqual(binding.owner, o.originalOwner);
  assert.deepEqual(o.offerBefore.owner, o.originalOwner);
  assert.ok(binding.sessionId && binding.reservationId);
  assert.ok(Number.isSafeInteger(binding.providerGeneration));
  for (const key of ["sessionId", "reservationId", "providerGeneration"] as const)
    assert.equal(o.ended[key], binding[key]);
  for (const row of [o.originalReservation, o.reservationAfter]) {
    assert.equal(row.sessionId, binding.sessionId);
    assert.equal(row.reservationId, binding.reservationId);
  }
  assert.equal(o.originalReservation.state, "active");
  assert.ok(o.checkpoint.checkpoint);
  assert.equal(o.checkpoint.document.checkpoint, o.checkpoint.checkpoint);
  assert.deepEqual(o.checkpoint.document.record, o.checkpoint.record);
  const original = o.checkpoint.record,
    final = o.finalRecord;
  assert.ok(original.id && original.revision && final.revision);
  assert.notEqual(final.revision, original.revision);
  for (const key of ["id", "kind", "schemaVersion", "label", "mediaType", "createdAt"] as const) {
    assert.notEqual(original[key], undefined);
    assert.equal(final[key], original[key]);
  }
  const originalBytes = Buffer.from(o.checkpoint.payloadBase64, "base64");
  assert.equal(original.byteLength, originalBytes.length);
  assert.equal(original.sha256, createHash("sha256").update(originalBytes).digest("hex"));
  // The admitted SDK fixture's final payload is deterministic; retain the actual stat too.
  const finalBytes = Buffer.from(`Synthetic final checkpoint ${original.id}\n`);
  assert.equal(final.byteLength, finalBytes.length);
  assert.equal(final.sha256, createHash("sha256").update(finalBytes).digest("hex"));
  assert.equal(final.checkpoint, "final");
  assert.equal(final.interrupted, false);
  assert.ok(Number.isFinite(final.updatedAt) && final.updatedAt >= original.updatedAt);
  const probe = o.grantProbe;
  assert.deepEqual(probe.owner, o.originalOwner);
  assert.deepEqual(probe.params, {
    target: { mode: "replace", id: final.id, expectedRevision: final.revision },
    ...Object.fromEntries(
      ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"].map((key) => [
        key,
        final[key as keyof RecordMeta],
      ]),
    ),
    checkpoint: { handle: o.checkpoint.checkpoint, phase: "final" },
    drainToken: o.offerBefore.token,
  });
  assert.equal(probe.result.ok, false, "Original grant reused");
  if (!probe.result.ok) {
    assert.equal(probe.result.error.code, "PLUGIN_E_STALE_RESOURCE");
    assert.deepEqual(probe.result.error.detail, {
      kind: "resource",
      reason: "stale",
      resource: "storage-write",
    });
  }
  assert.ok(
    Number.isFinite(probe.started) &&
      probe.started >= o.windows.find((w) => w.phase === "recording")!.started,
  );
  assert.ok(probe.ended >= probe.started && probe.ended < o.offerBefore.deadlineMonotonicMs);
  for (const snapshot of [probe.before, probe.after]) {
    assert.deepEqual(snapshot.barrier.scope, { kind: "namespace", owner: o.originalOwner });
    assert.equal(snapshot.barrier.deadlineMonotonicMs, o.offerBefore.deadlineMonotonicMs);
    assert.ok(Number.isSafeInteger(snapshot.barrier.through));
  }
  assert.equal(
    probe.after.barrier.through,
    probe.before.barrier.through,
    "Engine admission during stale grant probe",
  );
  assert.deepEqual(probe.after.tickets, probe.before.tickets, "New probe ticket");
  assert.deepEqual(probe.recordAfter, final, "Probe changed final record");
  assert.ok(
    o.probeCalls.start && o.probeCalls.gesture && o.probeCalls.start !== o.probeCalls.gesture,
  );
  for (const [name, method] of [
    ["start", "devices/motion/start"],
    ["gesture", "devices/motion/prepare"],
  ] as const) {
    const calls = o.trace.filter((r) => r.callId === o.probeCalls[name]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.phase, "motion-wake");
    assert.equal(calls[0]!.kind, "request");
    assert.equal(calls[0]!.method, method);
  }
  assert.ok(o.offerBefore.token);
  assert.equal(o.ended.reason, "suspended");
  assert.equal(o.reservationAfter.reservationId, o.ended.reservationId);
  assert.equal(o.reservationAfter.state, "ended");
  assert.deepEqual(o.ended.owner, o.originalOwner);
  assert.ok(o.ended.drain);
  assert.deepEqual(o.ended.drain.owner, o.originalOwner);
  assert.equal(o.ended.drain.reservationId, binding.reservationId);
  assert.ok(Number.isSafeInteger(o.ended.lastSequence));
  assert.equal(o.ended.drain.lastSequence, o.ended.lastSequence);
  assert.ok(probe.ended < o.ended.drain.expiresMonotonicMs);
  assert.equal(o.offerBefore.reason, "reservation-ended");
  assert.equal(o.requests[0]!.reason, o.offerBefore.reason);
  assert.deepEqual(o.requests[0]!.checkpoints, o.offerBefore.checkpoints);
  assert.deepEqual(o.requests[0]!.writes, o.offerBefore.writes);
  assert.equal(o.requests[0]!.checkpoints.length, 1);
  assert.deepEqual(o.requests[0]!.checkpoints[0], {
    checkpoint: o.checkpoint.checkpoint,
    record: original,
    reservationEnd: {
      reservationId: binding.reservationId,
      reason: "suspended",
      lastSequence: o.ended.lastSequence,
    },
  });
  assert.ok(o.offerBefore.deadlineMonotonicMs <= o.ended.endedMonotonicMs + 10000);
  assert.ok(o.offerBefore.deadlineMonotonicMs <= o.ended.drain.expiresMonotonicMs);
  assert.equal(o.requests.length, 1, "Missing or repeated original SDK drain");
  assert.equal(o.requests[0]!.token, o.offerBefore.token);
  assert.equal(o.dispatchedAt.length, 1);
  assert.ok(Number.isFinite(o.dispatchedAt[0]));
  assert.ok(o.requests[0]!.remainingMs > 0 && o.requests[0]!.remainingMs <= 10000);
  assert.ok(Number.isFinite(o.drainStartedAt) && o.drainStartedAt <= o.dispatchedAt[0]!);
  assert.ok(o.requests[0]!.remainingMs <= o.offerBefore.deadlineMonotonicMs - o.drainStartedAt);
  assert.ok(
    o.requests[0]!.remainingMs >=
      Math.max(0, o.offerBefore.deadlineMonotonicMs - o.dispatchedAt[0]!),
  );
  assert.ok(
    o.requests[0]!.checkpoints.some(
      (row) =>
        row.reservationEnd?.reservationId === o.ended.reservationId &&
        row.reservationEnd.reason === "suspended",
    ),
  );
  assert.equal(o.report.state, "saved");
  assert.equal(o.report.blocker, false);
  assert.equal(o.report.pendingSettings, false);
  assert.equal(o.report.errors.length, 0);
  assert.equal(o.finalCheckpoint, "final");
  assert.equal(o.report.records.length, 1);
  assert.equal(o.report.records[0]!.id, final.id);
  assert.equal(o.report.records[0]!.committedRevision, final.revision);
  assert.ok(o.report.records.every((r) => r.final && r.committedRevision != null));
  assert.ok(
    o.trace.some(
      (r) =>
        r.phase === "setup" &&
        r.kind === "peer" &&
        r.method === "command/execute" &&
        (r.params as { command?: string })?.command === "acceptance.ui-recording.legacy",
    ),
    "Missing baseline peer command",
  );
  for (const phase of ["motion", "recording"]) {
    const quiesces = o.trace.filter((r) => r.phase === phase && r.kind === "quiesce");
    assert.equal(quiesces.length, 1, "Missing or repeated real quiesce");
    assert.equal(quiesces[0]!.method, "suspended");
    const resumes = o.trace.filter((r) => r.phase === `${phase}-wake` && r.kind === "resume");
    assert.equal(resumes.length, 1, "Missing real broker resume");
    const settlements = o.settlements.filter((r) => r.phase === phase);
    assert.equal(settlements.length, 1, "Missing real quiescence disposition");
    assert.equal(settlements[0]!.disposition.stopConfirmed, true);
    assert.equal(settlements[0]!.disposition.journalCommitted, true);
    assert.deepEqual(settlements[0]!.disposition.faultIds, []);
    const window = o.windows.find((r) => r.phase === phase);
    assert.ok(
      window &&
        Number.isFinite(window.started) &&
        Number.isFinite(window.ended) &&
        window.ended - window.started >= 400,
      "Missing closed wake observation interval",
    );
    assert.ok(
      o.trace.filter(
        (r) => r.phase === `${phase}-wake` && r.kind === "request" && r.method === "devices/list",
      ).length >= 2,
      "Missing live post-wake traffic",
    );
  }
  assert.ok(
    o.trace.some(
      (r) => r.kind === "request" && r.method === "devices/motion/start" && r.phase === "setup",
    ),
  );
  assert.ok(
    o.trace.some(
      (r) =>
        r.kind === "request" &&
        r.method === "devices/recording/reserve" &&
        r.phase === "recording-setup",
    ),
  );
  assert.ok(
    o.providerBefore.some(
      (r) => r.operationId === o.operationId && r.step === "motion-pulse" && r.dispatch === "sent",
    ),
    "Missing held provider dispatch",
  );
  assert.deepEqual(
    o.providerAfter.slice(0, o.providerBefore.length),
    o.providerBefore,
    "Provider trace reset or truncated",
  );
  const later = o.providerAfter.slice(o.providerBefore.length);
  assert.ok(
    later.some(
      (r) => r.operationId === o.operationId && r.step === "stop" && r.dispatch === "sent",
    ),
  );
  assert.ok(
    later.some(
      (r) => r.operationId === o.operationId && r.step === "readback" && r.dispatch === "sent",
    ),
  );
  assert.equal(later.filter((r) => replaysMotion(r, o.operationId)).length, 0, "Provider replay");
  assert.equal(
    o.trace.filter(
      (r) =>
        r.phase.endsWith("-wake") &&
        !Object.values(o.probeCalls).includes(r.callId ?? "") &&
        (r.method === "command/invoke" ||
          r.method === "command/execute" ||
          r.method === "devices/recording/reserve" ||
          r.method === "devices/motion/prepare" ||
          r.method === "devices/motion/start" ||
          r.kind === "drain" ||
          r.kind === "reservation-end"),
    ).length,
    0,
    "Wake replay",
  );
}

export async function produceSuspendWake(
  input: SuspendCaseInput,
): Promise<CaseEvidence & { suspend: SuspendObservation }> {
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin") throw new Error("Missing admitted consumer");
  assert.ok(principal.authorityContext);
  assert.deepEqual(input.channel.owner, principal.owner);
  assert.equal(input.stage3.persistence, input.host.participant);
  assert.equal(input.stage3.device, input.broker.resources);
  assert.ok(
    input.lifecycle && input.providerControl && input.provider,
    "Missing real composition suspend seams",
  );
  const owner = structuredClone(principal.owner);
  const same = (candidate: typeof owner) =>
    (["sourceKey", "pluginId", "generation", "hostEpoch", "processEpoch"] as const).every(
      (key) => candidate[key] === owner[key],
    );
  const participant = input.host.participant,
    broker = input.broker,
    peer = input.channel.peer;
  const trace: Trace[] = [],
    retire: unknown[] = [],
    freeze: unknown[] = [],
    exits: unknown[] = [];
  const requests: DrainRequest[] = [],
    dispatchedAt: number[] = [],
    reports: Promise<DrainReport>[] = [];
  const windows: SuspendObservation["windows"] = [];
  const settlements: SuspendObservation["settlements"] = [];
  const restore: (() => void)[] = [],
    cleanupErrors: unknown[] = [];
  const controller = new AbortController(),
    signal = controller.signal;
  let phase = "setup",
    scope: string | undefined,
    gesture: string | undefined;
  let reservation: ReservationSnapshot | undefined, operationId: string | undefined;
  let pulse: ReturnType<typeof setInterval> | undefined,
    blocked = false;
  let context: ProviderOperationContext | undefined, deadlineBefore: number | undefined;
  let ended: ReservationEnded | undefined,
    offer: DrainOffer | undefined,
    offerBefore: DrainOffer | undefined;
  let result: (CaseEvidence & { suspend: SuspendObservation }) | undefined;
  let failure: unknown;
  let drainStartedAt: number | undefined;
  const pending: Promise<unknown>[] = [];
  const explicitCalls = new WeakMap<object, string>();
  const probeCalls: SuspendObservation["probeCalls"] = {
    start: randomUUID(),
    gesture: randomUUID(),
  };
  const startProbeParams = { operationId: "" };
  explicitCalls.set(startProbeParams, probeCalls.start);
  try {
    restore.push(input.recording.child.onExit((exit) => exits.push(exit)));
    const request = broker.request;
    broker.request = function (this: typeof broker, ...args) {
      const callId = explicitCalls.get(args[2]);
      explicitCalls.delete(args[2]); // Consume before forwarding, including synchronous re-entry.
      trace.push({
        phase,
        kind: "request",
        method: args[1],
        params: structuredClone(args[2]),
        ...(callId ? { callId } : {}),
      });
      return request.apply(this, args);
    } as typeof request;
    restore.push(() => {
      broker.request = request;
    });
    const peerRequest = peer.request;
    peer.request = function (this: typeof peer, ...args) {
      trace.push({ phase, kind: "peer", method: args[0], params: structuredClone(args[1]) });
      return peerRequest.apply(this, args);
    } as typeof peerRequest;
    restore.push(() => {
      peer.request = peerRequest;
    });
    const quiesce = broker.sessions.quiesce;
    broker.sessions.quiesce = function (...args) {
      trace.push({ phase, kind: "quiesce", method: args[1].reason, params: args[0] });
      const observedPhase = phase;
      const receipt = quiesce.apply(this, args);
      const settled = receipt.settled.then((disposition) => {
        settlements.push({ phase: observedPhase, disposition: structuredClone(disposition) });
      });
      void settled.catch(() => {});
      pending.push(settled);
      return receipt;
    };
    restore.push(() => {
      broker.sessions.quiesce = quiesce;
    });
    const resume = broker.sessions.resume;
    broker.sessions.resume = function (...args) {
      trace.push({ phase, kind: "resume", method: "resume", params: args[0] });
      return resume.apply(this, args);
    };
    restore.push(() => {
      broker.sessions.resume = resume;
    });
    const originalRetire = input.stage3.device.retire,
      originalFreeze = participant.freeze;
    input.stage3.device.retire = function (...args) {
      if (same(args[0])) retire.push(args);
      return originalRetire.apply(this, args);
    };
    restore.push(() => {
      input.stage3.device.retire = originalRetire;
    });
    participant.freeze = function (...args) {
      if (same(args[0])) freeze.push(args);
      return originalFreeze.apply(this, args);
    };
    restore.push(() => {
      participant.freeze = originalFreeze;
    });
    const end = participant.endReservation,
      drain = participant.drain;
    participant.endReservation = function (...args) {
      const value = end.apply(this, args);
      if (same(args[0].owner))
        trace.push({
          phase,
          kind: "reservation-end",
          method: args[0].reason,
          params: structuredClone(args[0]),
        });
      if (same(args[0].owner) && phase === "recording") {
        assert.equal(ended, undefined, "Duplicate reservation end");
        ended = structuredClone(args[0]);
        assert.ok(value, "Missing real drain offer");
        offer = value;
        offerBefore = structuredClone(value);
      }
      return value;
    };
    restore.push(() => {
      participant.endReservation = end;
    });
    participant.drain = function (value, dispatch) {
      if (phase === "recording") assert.equal(value, offer, "Replaced original drain offer");
      if (!same(value.owner)) return drain.call(this, value, dispatch);
      trace.push({ phase, kind: "drain", method: "storage/drain", params: structuredClone(value) });
      assert.ok(dispatch, "Missing original SDK dispatcher");
      if (phase === "recording") drainStartedAt = input.now();
      const work = drain.call(this, value, (target, request, ...rest) => {
        if (phase === "recording") {
          requests.push(structuredClone(request));
          dispatchedAt.push(input.now());
        }
        return dispatch(target, request, ...rest);
      });
      if (phase === "recording") reports.push(work);
      void work.catch(() => {});
      pending.push(work);
      return work;
    };
    restore.push(() => {
      participant.drain = drain;
    });
    const execute = input.provider.executeFiniteMotion;
    input.provider.executeFiniteMotion = function (session, motion, ctx) {
      trace.push({
        phase,
        kind: "provider-motion",
        method: "executeFiniteMotion",
        params: ctx.operationId,
      });
      if (!context) {
        context = ctx;
        deadlineBefore = ctx.deadlineMonotonicMs;
      }
      return execute.call(this, session, motion, ctx);
    };
    restore.push(() => {
      input.provider.executeFiniteMotion = execute;
    });

    await bounded(input.command());
    // Obtain the admitted session using the existing fixture, then release its seed
    // reservation before motion. Recording and motion must never overlap.
    reservation = await bounded(input.reserveRecording());
    const sessionId = reservation.sessionId;
    accepted(
      await bounded(
        broker.request(
          principal,
          "devices/recording/release",
          { reservationId: reservation.reservationId },
          signal,
        ),
      ),
    );
    reservation = undefined;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await bounded(Promise.all(pending));
    const session = accepted(
      await bounded(broker.request(principal, "devices/session", { sessionId }, signal)),
    );
    const actuator = session.sources.actuators.find((row) => row.state === "ready");
    assert.ok(actuator);
    scope = broker.intent.bindMotionScope({
      owner,
      contextRef: principal.authorityContext.ref,
      panelInstance: randomUUID(),
      uiResourceGeneration: 0,
      workbenchInstance: input.scope().workbenchInstance,
    });
    let sequence = 0;
    broker.intent.pulsePanel(scope, ++sequence);
    gesture = broker.intent.beginGesture(scope, ++sequence);
    let lastPulse = input.now();
    const pulseIntent = () => {
      lastPulse = input.now();
      broker.intent.pulsePanel(scope!, ++sequence);
      broker.intent.pulseGesture(gesture!, ++sequence);
    };
    pulse = setInterval(pulseIntent, 100);
    const params = {
      sessionId,
      contextRef: principal.authorityContext.ref,
      motionScopeRef: scope,
      motion: {
        actuatorId: actuator.actuatorId,
        mode: "timed" as const,
        power: 1,
        direction: 1 as const,
        brake: true,
        durationMs: 5000,
      },
    };
    operationId = accepted(
      await bounded(broker.request(principal, "devices/motion/prepare", params, signal)),
    ).operation.operationId;
    input.providerControl.block("after-exchange", "motion-pulse");
    blocked = true;
    const reached = input.providerControl.reached("after-exchange", "motion-pulse");
    accepted(
      await bounded(broker.request(principal, "devices/motion/start", { operationId }, signal)),
    );
    await bounded(reached);
    assert.ok(context && deadlineBefore !== undefined, "Missing actual provider context");
    const held = accepted(
      await bounded(broker.request(principal, "devices/motion/query", { operationId }, signal)),
    ).operation;
    assert.ok(
      held.startAccepted && held.stage !== "terminal" && !held.stopRequested,
      "Motion was not held at suspend",
    );
    const providerBefore = input.providerControl.trace();
    phase = "motion";
    const stopping = input.lifecycle.suspend(sessionId);
    pending.push(stopping);
    void stopping.catch(() => {});
    clearInterval(pulse);
    pulse = undefined;
    assert.ok(
      trace.some((row) => row.phase === phase && row.kind === "quiesce"),
      "Lifecycle did not synchronously quiesce",
    );
    input.providerControl.release("after-exchange", "motion-pulse");
    blocked = false;
    await bounded(stopping);
    const observeWake = async (kind: string, resumedAt?: number) => {
      // Install the wake phase before invoking resume: synchronous replay inside
      // the adapter is evidence too, not just traffic after its promise resolves.
      phase = `${kind}-wake`;
      const started = resumedAt ?? input.now();
      if (resumedAt === undefined) await bounded(input.lifecycle.resume(sessionId));
      accepted(
        await bounded(broker.request(input.recording.principal(), "devices/list", {}, signal)),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 425));
      accepted(
        await bounded(broker.request(input.recording.principal(), "devices/list", {}, signal)),
      );
      windows.push({ phase: kind, started, ended: input.now() });
    };
    // Probe old intent before its 350 ms lease can expire. Keep replay capture
    // active during resume itself, then label only our explicit denial probes.
    phase = "motion-wake";
    const motionWakeStarted = input.now();
    await bounded(input.lifecycle.resume(sessionId));
    startProbeParams.operationId = operationId;
    const oldStart = await bounded(
      broker.request(principal, "devices/motion/start", startProbeParams, signal),
    );
    const gestureAgeAtProbe = input.now() - lastPulse;
    assert.ok(
      gestureAgeAtProbe < 350,
      "Gesture expiry obscures suspend revocation; native observation missing",
    );
    const gestureProbeParams = {
      ...params,
      gestureRef: gesture,
      motion: {
        actuatorId: actuator.actuatorId,
        mode: "jog" as const,
        power: 1,
        direction: 1 as const,
        brake: true,
      },
    };
    explicitCalls.set(gestureProbeParams, probeCalls.gesture);
    const oldGesture = await bounded(
      broker.request(principal, "devices/motion/prepare", gestureProbeParams, signal),
    );
    // If a regression admits a probe, retain its operation for explicit cleanup.
    if (oldGesture.ok) {
      accepted(
        await bounded(
          broker.request(
            principal,
            "devices/motion/stop",
            { operationId: oldGesture.value.operation.operationId, stopMode: "brake" },
            signal,
          ),
        ),
      );
    }
    assert.equal(oldStart.ok, false);
    assert.equal(oldGesture.ok, false);
    if (!oldStart.ok) assert.equal(oldStart.error.code, "PLUGIN_E_CANCELLED");
    if (!oldGesture.ok) assert.equal(oldGesture.error.code, "PLUGIN_E_STALE_RESOURCE");
    await observeWake("motion", motionWakeStarted);
    phase = "recording-setup";
    reservation = await bounded(input.reserveRecording());
    assert.equal(reservation.sessionId, sessionId);
    const checkpoint = await bounded(input.checkpoint(reservation));
    assert.equal(checkpoint.document.binding?.reservationId, reservation.reservationId);
    assert.equal(checkpoint.publication.result.disposition, "committed");
    const active = accepted(
      await bounded(
        broker.request(
          principal,
          "devices/recording/query",
          { reservationId: reservation.reservationId },
          signal,
        ),
      ),
    ).reservation;
    assert.equal(active.state, "active");
    phase = "recording";
    await bounded(input.lifecycle.suspend(sessionId));
    assert.ok(ended && offer && offerBefore, "Missing live reservation end/drain");
    assert.equal(ended.reservationId, reservation.reservationId);
    assert.equal(reports.length, 1);
    assert.ok(drainStartedAt !== undefined);
    const report = await bounded(reports[0]!);
    const final = accepted(
      await bounded(
        input.host.request(principal, "storage/stat", { id: checkpoint.record.id }, signal),
      ),
    ).record;
    assert.equal(final.checkpoint, "final");
    assert.ok(
      report.records.some(
        (row) => row.id === final.id && row.committedRevision === final.revision && row.final,
      ),
      "Final record not in original drain report",
    );
    assert.ok(
      requests[0]?.checkpoints.some((row) => row.checkpoint === checkpoint.checkpoint),
      "Original checkpoint missing from SDK drain",
    );
    await observeWake("recording");
    const snapshotAdmissions = () => {
      const barrier = input.backend.evidence.capture(
        { kind: "namespace", owner },
        offerBefore!.deadlineMonotonicMs,
      );
      return {
        barrier: structuredClone(barrier),
        tickets: structuredClone(input.backend.evidence.tickets(barrier)),
      };
    };
    const grantParams: StorageRequestMap["storage/beginWrite"]["params"] = {
      target: { mode: "replace", id: final.id, expectedRevision: final.revision },
      kind: final.kind,
      schemaVersion: final.schemaVersion,
      label: final.label,
      mediaType: final.mediaType,
      byteLength: final.byteLength,
      sha256: final.sha256,
      checkpoint: { handle: checkpoint.checkpoint, phase: "final" },
      drainToken: offerBefore.token,
    };
    const before = snapshotAdmissions();
    const started = input.now();
    const grantResult = await bounded(
      input.host.request(principal, "storage/beginWrite", grantParams, signal),
    );
    const probeEnded = input.now();
    const after = snapshotAdmissions();
    const recordAfter = accepted(
      await bounded(input.host.request(principal, "storage/stat", { id: final.id }, signal)),
    ).record;
    const grantProbe = {
      owner: structuredClone(owner),
      params: grantParams,
      result: grantResult,
      started,
      ended: probeEnded,
      before,
      after,
      recordAfter,
    };
    if (grantResult.ok)
      accepted(
        await bounded(
          input.host.request(
            principal,
            "storage/abortWrite",
            { write: grantResult.value.write },
            signal,
          ),
        ),
      );
    const reservationAfter = accepted(
      await bounded(
        broker.request(
          principal,
          "devices/recording/query",
          { reservationId: reservation.reservationId },
          signal,
        ),
      ),
    ).reservation;
    windows.find((row) => row.phase === "recording")!.ended = input.now();
    assert.equal(context.cancellation.aborted, true, "Old work cancellation was renewed");
    assert.throws(
      () => context!.assertContinuation("motion-pulse"),
      "Old provider continuation revived",
    );
    const current = input.recording.principal();
    assert.equal(current.kind, "plugin");
    if (current.kind !== "plugin") throw new Error("Lost original channel");
    const observation: SuspendObservation = {
      trace,
      providerBefore,
      providerAfter: input.providerControl.trace(),
      operationId,
      deadlineBefore,
      deadlineAfter: context.deadlineMonotonicMs,
      oldStart,
      oldGesture,
      gestureAgeAtProbe,
      ended,
      reservationAfter,
      offerBefore,
      checkpoint,
      finalRecord: final,
      originalReservation: active,
      probeCalls,
      grantProbe,
      requests,
      dispatchedAt,
      drainStartedAt,
      report,
      finalCheckpoint: final.checkpoint,
      originalOwner: owner,
      currentOwner: current.owner,
      retire,
      freeze,
      exits,
      windows,
      settlements,
    };
    assertSuspendObservation(observation);
    const wake = trace.filter(
      (row) => row.phase.endsWith("-wake") && !Object.values(probeCalls).includes(row.callId ?? ""),
    );
    result = {
      checks: {
        quiesceReason: trace.find((row) => row.kind === "quiesce")!.method,
        retireCalls: retire.length,
        freezeCalls: freeze.length,
        processExits: exits.length,
        replayedMotion:
          wake.filter((row) =>
            ["devices/motion/prepare", "devices/motion/start"].includes(row.method),
          ).length +
          observation.providerAfter
            .slice(providerBefore.length)
            .filter((row) => replaysMotion(row, operationId!)).length,
        replayedRecording: wake.filter((row) => row.method === "devices/recording/reserve").length,
        replayedCommand: wake.filter((row) =>
          ["command/invoke", "command/execute"].includes(row.method),
        ).length,
        renewedOldToken: [
          oldStart.ok,
          oldGesture.ok,
          observation.deadlineAfter !== deadlineBefore,
          grantProbe.result.ok,
        ].filter(Boolean).length,
      },
      events: [],
      samples: {},
      suspend: observation,
    };
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(pulse);
    phase = "cleanup";
    const attempt = async (work: () => unknown) => {
      try {
        await bounded(Promise.resolve().then(work));
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    if (blocked)
      await attempt(() => input.providerControl.release("after-exchange", "motion-pulse"));
    if (scope) await attempt(() => broker.intent.revokeScope(scope!, "closed"));
    if (operationId)
      await attempt(async () =>
        accepted(
          await broker.request(
            principal,
            "devices/motion/stop",
            { operationId: operationId!, stopMode: "brake" },
            signal,
          ),
        ),
      );
    if (reservation)
      await attempt(async () =>
        accepted(
          await broker.request(
            principal,
            "devices/recording/release",
            { reservationId: reservation!.reservationId },
            signal,
          ),
        ),
      );
    await attempt(() => Promise.all(pending));
    controller.abort();
    for (const off of restore.reverse()) await attempt(off);
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failure ? [failure, ...cleanupErrors] : cleanupErrors,
      "Suspend producer cleanup failed",
    );
  if (failure) throw failure;
  assert.ok(result, "Missing suspend result");
  assertSuspendObservation(result.suspend);
  return result;
}
