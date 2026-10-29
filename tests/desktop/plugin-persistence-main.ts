import {
  SEMANTIC_IMPORT_BOUNDARIES,
  observeImportWriter,
  produceSemanticImport,
  assertSemanticPhase,
} from "./import-boundaries.js";
import {
  pressureTransport,
  pressureStep,
  guardPressure,
  settlePressure,
  verifyPressureWorkerTrace,
  assertPressurePartial,
} from "./plugin-persistence-pressure.js";
import type { PressureRow } from "./plugin-persistence-pressure.js";
import { observeWorkQueue } from "./plugin-persistence-pressure-observer.js";
import { WorkQueue } from "../../apps/desktop/src/main/plugins/persistence/quota.js";
import {
  importObserver,
  produceImportSlice,
  assertImportPhase,
} from "./plugin-persistence-import.js";
import { compatibilityObserver } from "./plugin-persistence-compatibility.js";
import type { Wire as CompatibilityWire } from "./plugin-persistence-compatibility.js";
// @ts-expect-error Node's pure oracle entry imports the test-local TypeScript source.
import * as optionalOffCase from "./plugin-persistence-optional-off.ts";
import type { Wire as OptionalWire } from "./plugin-persistence-optional-off.js";
const {
  optionalStartup,
  produceOptionalOff,
  assertOptionalPhase,
  assertOptionalEvidence,
  optionalKeys,
} = optionalOffCase;
import type { RendererLaunch } from "./plugin-persistence-renderer-loss.js";
import type {
  DeviceDrainGrant,
  ProfileWriterLock,
  Stage3RuntimePorts,
  Stage3ChannelContext,
} from "@kobrixa/plugin-runtime";
import type { IpcHandle } from "../../apps/desktop/src/main/ipc.js";
import type { PersistenceHost } from "../../apps/desktop/src/main/plugins/persistence/host-port.js";
export type FoundationCase =
  | "contention"
  | "retirement"
  | "registration-end"
  | "healthy-release"
  | "disconnect-retry"
  | "suspend-wake"
  | "renderer-loss"
  | "sealed-ttl"
  | "unknown-publication"
  | "all-optional-off"
  | "action-replay"
  | "import-restart"
  | "storage-ui-pressure"
  | "compatibility"
  | "installed";

import type { ContentionObservation, ContentionForm } from "./plugin-persistence-contention.js";

export type CaseEvidence = {
  pressure?: PressureRow;
  importSlice?: CompatibilityWire;
  compatibility?: CompatibilityWire;
  optionalPhase?: OptionalWire;
  optionalOff?: OptionalWire;
  contention?: ContentionObservation;
  checks: Record<string, string | number | boolean | readonly string[] | readonly number[]>;
  events: Array<{
    kind: string;
    turn: number;
    time: number;
    grant?: DeviceDrainGrant | null;
    deadline?: number;
  }>;
  samples: Record<string, number[]>;
  registration?: {
    firstOffer: DrainOffer;
    offers: DrainOffer[];
    requests: DrainRequest[];
    submissions: Array<{ ok: boolean; value?: { status: string; writes: string[] } }>;
    registrationTicket: PublicationTicket;
    finalTickets: PublicationTicket[];
    trace: ReturnType<PersistenceFaultControl["trace"]>;
    endTrace: ReturnType<PersistenceFaultControl["trace"]>;
    finalRecord: RecordMeta;
    payloadSha256: string;
  };
};

export interface FoundationFixture {
  composition: {
    profile: ProfileWriterLock;
    journalProfile: ProfileWriterLock;
    persistenceProfile: ProfileWriterLock;
    reservationListenerCount: number;
    workerCount: number;
    host: PersistenceHost;
    stage3: Stage3RuntimePorts;
  };
  environment: {
    commit: string;
    artifact: string;
    artifactSha256: string;
    os: string;
    architecture: string;
    cpu: string;
    ramBytes: number;
    filesystem: string;
    node: string;
    electron: string;
    memoryMethod: string;
    warmCold: string;
  };
  runCase(id: FoundationCase): Promise<CaseEvidence>;
  close(): Promise<void>;
  finishObservation?(evidence: CaseEvidence): Promise<void>;
}

/* Frozen measurement manifest for the T7 implementation (no measurements claimed).
{
  "settingsKeys":128,"settingsResourceBytes":65536,"settingsValuesBytes":65536,"stringBytes":4096,
  "recordBytes":8388608,"recordsPerSource":256,"sourceBytes":536870912,"hostBytes":1073741824,
  "chunkBytes":262144,"chunkEncodedBytes":349528,"listEntries":64,"listResultBytes":262144,
  "sourceWriteSlots":2,"hostWriteSlots":16,"sourceExportSlots":1,"hostExportSlots":4,
  "temporarySourceBytes":33554432,"temporaryHostBytes":134217728,"metadataSourceBytes":4194304,"metadataHostBytes":67108864,
  "diskHeadroomBytes":16777216,"pendingRequests":32,"pendingHostBytes":8388608,"pendingSourceBytes":1048576,"ioJobs":4,
  "idleMs":30000,"totalMs":120000,"rpcMs":10000,"drainMs":10000,"cleanupMs":24000,"outerMs":25000,
  "workload":{"records":50,"recordBytes":8388608,"stagedRecords":2,"concurrentJobs":4,"samples":30},
  "measurement":["OS","architecture","CPU","RAM","filesystem","artifact","commit","Node","Electron","fixtureBytes","records","warmCold","samples","p50","p95","max","mainRSS","workerRSS","memoryMethod"],
  "thresholds":{"draftP95Ms":50,"pageP95Ms":100,"listP95Ms":200,"mainSyncMaxMs":16,"mainAdditionalRSS":33554432,"workerAdditionalRSS":67108864,"commitFlushMaxMs":10000,"extraStopDispatchP95Ms":50}
}
*/

// @ts-expect-error The shared Node oracle is a test-local JavaScript module.
import * as outcomes from "./plugin-persistence-outcomes.mjs";
const {
  FOUNDATION_CASES: caseIds,
  FOUNDATION_CHECKS: caseChecks,
  assertFoundationOutcome,
} = outcomes;
export const FOUNDATION_CASES = caseIds as readonly FoundationCase[];
export const FOUNDATION_CHECKS = caseChecks as Readonly<
  Record<
    FoundationCase,
    {
      checks: readonly string[];
      events: readonly string[];
      samples: readonly string[];
    }
  >
>;

import assert from "node:assert/strict";
// @ts-expect-error The test-local Node harness has no TypeScript declaration.
import * as evidenceHarness from "./plugin-persistence-harness.mjs";
const {
  assertRegistrationEndEvidence,
  assertContentionEvidence,
  assertUnknownEvidence,
  assertActionReplayEvidence,
  assertRendererLossEvidence,
  assertSealedTtlEvidence,
} = evidenceHarness;
export function assertFoundationEvidence(id: FoundationCase, evidence: CaseEvidence): void {
  const required = FOUNDATION_CHECKS[id];
  assert.ok(required, `Unknown foundation case ${id}`);
  for (const key of required.checks) {
    assert.ok(Object.hasOwn(evidence.checks, key), `${id}: missing check ${key}`);
    const value = evidence.checks[key];
    assert.ok(
      typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (Array.isArray(value) &&
          value.every(
            (item) =>
              typeof item === "string" || (typeof item === "number" && Number.isFinite(item)),
          )),
      `${id}: invalid check ${key}`,
    );
  }
  for (const key of Object.keys(evidence.checks))
    assert.ok(required.checks.includes(key), `${id}: undeclared check ${key}`);
  for (const kind of required.events)
    assert.ok(
      evidence.events.some((event) => event.kind === kind),
      `${id}: missing event ${kind}`,
    );
  for (const event of evidence.events) {
    assert.ok(Number.isSafeInteger(event.turn) && event.turn >= 0, `${id}: invalid event turn`);
    assert.ok(Number.isFinite(event.time) && event.time >= 0, `${id}: invalid event time`);
    if (event.deadline !== undefined)
      assert.ok(Number.isFinite(event.deadline) && event.deadline >= 0, `${id}: invalid deadline`);
  }
  for (const key of required.samples) {
    assert.ok(Object.hasOwn(evidence.samples, key), `${id}: missing sample ${key}`);
    const values = evidence.samples[key]!;
    assert.ok(
      values.length >= 30 && [...values].every((value) => Number.isFinite(value) && value >= 0),
      `${id}: ${key} needs 30 finite nonnegative measurements`,
    );
  }
  if (id === "retirement") {
    const retire = evidence.events.find((e) => e.kind === "retire")!,
      freeze = evidence.events.find((e) => e.kind === "freeze")!,
      drain = evidence.events.find((e) => e.kind === "drain")!,
      exit = evidence.events.find((e) => e.kind === "process-exit")!;
    assert.ok(retire.grant, "Missing original device drain grant");
    assert.equal(retire.grant, freeze.grant, "Exact grant identity required before serialization");
    assert.equal(retire.turn, freeze.turn, "Retire/freeze must be synchronous");
    assert.ok(evidence.events.indexOf(retire) < evidence.events.indexOf(freeze));
    assert.ok(evidence.events.indexOf(freeze) < evidence.events.indexOf(drain));
    assert.ok(evidence.events.indexOf(drain) < evidence.events.indexOf(exit));
    assert.equal(freeze.deadline, evidence.checks.firstDeadline);
    assert.equal(drain.deadline, freeze.deadline);
  }
  if (id === "registration-end") assertRegistrationEndEvidence(evidence);
  if (id === "contention") assertContentionEvidence(evidence);
  if (id === "unknown-publication") assertUnknownEvidence(evidence);
  if (id === "renderer-loss") assertRendererLossEvidence(evidence);
  if (id === "action-replay") assertActionReplayEvidence(evidence);
  if (id === "sealed-ttl") assertSealedTtlEvidence(evidence);
  if (id === "all-optional-off")
    assertOptionalEvidence(evidence, evidence.optionalOff?.cold.hostEpoch);
  if (id === "healthy-release") {
    for (const key of ["retireCalls", "freezeCalls", "processExits"])
      assert.equal(evidence.checks[key], 0, key);
    assert.equal(evidence.checks.unrelatedSettingsCommitted, true);
    assert.equal(evidence.checks.generationBefore, evidence.checks.generationAfter);
  }
  for (const key of Object.keys(evidence.samples))
    assert.ok(required.samples.includes(key), `${id}: undeclared sample ${key}`);
  assertFoundationOutcome(id, evidence);
}
function assertRealComposition(fixture: FoundationFixture): void {
  const c = fixture.composition;
  assert.equal(c.persistenceProfile, c.profile);
  assert.equal(c.journalProfile, c.profile);
  assert.equal(c.workerCount, 1);
  assert.equal(c.reservationListenerCount, 1);
  assert.equal(typeof c.host.settings.open, "function");
  assert.equal(typeof c.host.recovery.export, "function");
  c.profile.assertHeld();
  const off = c.host.recovery.subscribe(() => {});
  try {
    assert.deepEqual(c.host.recovery.snapshot(), c.host.participant.recoverySnapshot());
  } finally {
    off();
  }
}
// runFoundationEvidence belongs to the outside controller, not this Electron producer.

import { randomBytes, createHash } from "node:crypto";
import type { PluginProcess, ProcessExit } from "@kobrixa/plugin-runtime";
import type { ResourceOwner, DrainRequest, RecordMeta } from "@kobrixa/plugin-protocol";
import type { Principal, DrainOffer } from "@kobrixa/plugin-runtime";
import type { DeviceBrokerPort } from "../../apps/desktop/src/main/device-broker/broker-port.js";
import type { PersistenceFaultControl } from "../../apps/desktop/src/main/plugins/persistence/worker.js";

import type {
  PersistenceBackend,
  PublicationTicket,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";

import type { PluginController } from "../../apps/desktop/src/main/plugins/controller.js";

type LiveConsumer = {
  principal: () => Principal;
  child: PluginProcess;
};
export type LifecycleCaseInput = {
  now: () => number;
  broker: DeviceBrokerPort;
  host: PersistenceHost;
  stage3: Stage3RuntimePorts;
  plugins: Pick<PluginController, "setEnabled">;
  fault: PersistenceFaultControl;
  backend: PersistenceBackend;
  recording: LiveConsumer;
  settings: LiveConsumer;
};
function accepted<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`Live operation failed: ${JSON.stringify(result.error)}`);
  return result.value;
}
function pluginPrincipal(consumer: LiveConsumer): Extract<Principal, { kind: "plugin" }> {
  const principal = consumer.principal();
  if (principal.kind !== "plugin") throw new Error("Expected admitted plugin channel");
  return principal;
}
function sameExecution(a: ResourceOwner, b: ResourceOwner): boolean {
  return (
    a.sourceKey === b.sourceKey &&
    a.pluginId === b.pluginId &&
    a.generation === b.generation &&
    a.hostEpoch === b.hostEpoch &&
    a.processEpoch === b.processEpoch
  );
}
async function within<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Missing live observation: ${label}`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function eventRecorder(now: () => number) {
  const events: CaseEvidence["events"] = [];
  let turn = 0,
    scheduled = false;
  return {
    events,
    record(kind: string, fields: Pick<CaseEvidence["events"][number], "grant" | "deadline"> = {}) {
      // One ordinal per observed synchronous segment. The boundary is an actual
      // microtask, never an ordinal assigned from the expected event order.
      events.push({ kind, turn, time: now(), ...fields });
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          turn++;
          scheduled = false;
        });
      }
    },
  };
}
async function reserveLiveRecording(input: LifecycleCaseInput) {
  const signal = new AbortController().signal;
  const principal = pluginPrincipal(input.recording);
  const inventory = accepted(await input.broker.request(principal, "devices/list", {}, signal));
  const provider = inventory.providers.find((row) => row.state === "available");
  if (!provider) throw new Error("No admitted fake provider");
  let session = inventory.sessions.find(
    (row) => row.providerId === provider.providerId && row.state === "connected",
  );
  if (!session) {
    const discovered = accepted(
      await input.broker.request(
        principal,
        "devices/discover",
        { providerId: provider.providerId },
        signal,
      ),
    );
    const candidate = discovered.candidates[0];
    if (!candidate) throw new Error("Fake provider returned no candidate");
    session = accepted(
      await input.broker.request(
        principal,
        "devices/connect",
        { target: { kind: "candidate", candidateId: candidate.candidateId } },
        signal,
      ),
    ).session;
  }
  const current = accepted(
    await input.broker.request(
      principal,
      "devices/session",
      { sessionId: session.sessionId },
      signal,
    ),
  );
  const channel = current.sources.channels.find(
    (row) => row.state === "ready" && row.kind === "input",
  );
  if (!channel) throw new Error("Fake provider returned no recording input");
  return accepted(
    await input.broker.request(
      principal,
      "devices/recording/reserve",
      {
        sessionId: session.sessionId,
        channelIds: [channel.channelId],
        expectedSourceRevision: current.sources.sourceRevision,
      },
      signal,
    ),
  ).reservation;
}

export async function produceRetirement(input: LifecycleCaseInput): Promise<CaseEvidence> {
  const participant = input.host.participant;
  if (input.stage3.persistence !== participant) throw new Error("Detached persistence participant");
  const principal = pluginPrincipal(input.recording),
    owner = principal.owner;
  const signal = new AbortController().signal;
  await reserveLiveRecording(input);
  const bytes = randomBytes(4096),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  const write = accepted(
    await input.host.request(
      principal,
      "storage/beginWrite",
      {
        target: { mode: "create" },
        kind: "test.retirement",
        schemaVersion: 1,
        label: "Retirement payload",
        mediaType: "application/octet-stream",
        byteLength: bytes.length,
        sha256,
      },
      signal,
    ),
  );
  accepted(
    await input.host.request(
      principal,
      "storage/writeChunk",
      { write: write.write, offset: 0, data: bytes.toString("base64") },
      signal,
    ),
  );
  accepted(
    await input.host.request(principal, "storage/sealWrite", { write: write.write }, signal),
  );

  const recorder = eventRecorder(input.now),
    frozen = latch<DrainOffer>(),
    exited = latch<ProcessExit>();
  const retire = input.stage3.device.retire,
    freeze = participant.freeze,
    drain = participant.drain,
    endReservation = participant.endReservation;
  let firstDeadline: number | undefined;
  let commit: Promise<unknown> | undefined, disabling: Promise<unknown> | undefined;
  let armed = false;
  const onExit = (exit: ProcessExit) => {
    recorder.record("process-exit");
    exited.resolve(exit);
  };
  const unsubscribeExit = input.recording.child.onExit(onExit);
  const remember = (offer: DrainOffer | null) => {
    if (offer && sameExecution(offer.owner, owner) && firstDeadline === undefined)
      firstDeadline = offer.deadlineMonotonicMs;
  };
  participant.endReservation = function (event, deadline) {
    const offer = endReservation.call(this, event, deadline);
    remember(offer);
    return offer;
  };
  input.stage3.device.retire = function (retired, reason) {
    const result = retire.call(this, retired, reason);
    if (sameExecution(retired, owner)) recorder.record("retire", { grant: result.drain });
    return result;
  };
  participant.freeze = function (retired, reason, deadline, grant) {
    const offer = freeze.call(this, retired, reason, deadline, grant);
    if (sameExecution(retired, owner)) {
      remember(offer);
      recorder.record("freeze", {
        ...(grant === undefined ? {} : { grant }),
        deadline: offer.deadlineMonotonicMs,
      });
      frozen.resolve(offer);
    }
    return offer;
  };
  participant.drain = function (offer, dispatch) {
    if (sameExecution(offer.owner, owner))
      recorder.record("drain", { deadline: offer.deadlineMonotonicMs });
    return drain.call(this, offer, dispatch);
  };
  try {
    const traceStart = input.fault.trace().length;
    const reached = input.fault.reached("before-publish");
    input.fault.arm("before-publish", "pause");
    armed = true;
    // Install rejection handling immediately; losing the owner can reject this call.
    commit = input.host
      .request(principal, "storage/commitWrite", { write: write.write }, signal)
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    await within(reached, "retirement publication pause");
    const trace = input.fault.trace().slice(traceStart);
    if (!trace.some((row) => row.point === "before-publish" && row.ticket !== null))
      throw new Error("Retirement did not pause a worker publication ticket");
    disabling = input.plugins.setEnabled(owner.sourceKey, false).then((result) => {
      if (!result.ok) throw new Error(`Retirement refused: ${JSON.stringify(result)}`);
      return result;
    });
    // Observe synchronously fenced state before permitting the worker continuation.
    await within(
      Promise.race([
        frozen.promise,
        disabling.then(() => {
          throw new Error("Disable completed without freeze");
        }),
      ]),
      "retirement freeze",
    );
    input.fault.release("before-publish");
    armed = false;
    await within(Promise.all([commit, disabling, exited.promise]), "original process exit");
    if (firstDeadline === undefined) throw new Error("No original drain deadline observed");
    const evidence: CaseEvidence = {
      checks: { firstDeadline },
      events: recorder.events,
      samples: {},
    };
    assertFoundationEvidence("retirement", evidence);
    return evidence;
  } finally {
    if (armed) input.fault.release("before-publish");
    // Await any started work before restoring instrumentation; propagate cleanup failure.
    try {
      await within(
        Promise.allSettled([commit, disabling].filter((value) => value !== undefined)),
        "retirement cleanup",
      );
    } finally {
      participant.endReservation = endReservation;
      participant.freeze = freeze;
      participant.drain = drain;
      input.stage3.device.retire = retire;
      unsubscribeExit();
    }
  }
}

export async function produceRegistrationEnd(input: LifecycleCaseInput): Promise<CaseEvidence> {
  const participant = input.host.participant;
  assert.equal(input.stage3.persistence, participant);
  const principal = pluginPrincipal(input.recording),
    owner = principal.owner;
  const signal = new AbortController().signal;
  const reservation = await reserveLiveRecording(input);
  const bytes = Buffer.from("Synthetic registration seed\n");
  const write = accepted(
    await input.host.request(
      principal,
      "storage/beginWrite",
      {
        target: { mode: "create" },
        kind: "test.registration-end",
        schemaVersion: 1,
        label: "Registration race",
        mediaType: "application/octet-stream",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      signal,
    ),
  );
  accepted(
    await input.host.request(
      principal,
      "storage/writeChunk",
      {
        write: write.write,
        offset: 0,
        data: bytes.toString("base64"),
      },
      signal,
    ),
  );
  accepted(
    await input.host.request(principal, "storage/sealWrite", { write: write.write }, signal),
  );
  const seed = accepted(
    await input.host.request(principal, "storage/commitWrite", { write: write.write }, signal),
  );
  const endReservation = participant.endReservation,
    drain = participant.drain;
  const engine = input.backend.engine,
    reserve = engine.reserve;
  const tickets: PublicationTicket[] = [],
    finalTickets: PublicationTicket[] = [];
  const offers: DrainOffer[] = [],
    requests: DrainRequest[] = [];
  const submissions: NonNullable<CaseEvidence["registration"]>["submissions"] = [];
  const dispatchErrors: string[] = [];
  const ended = latch<DrainOffer>(),
    completed = latch<void>();
  let firstOffer: DrainOffer | undefined;
  let endTrace: ReturnType<PersistenceFaultControl["trace"]> | undefined;
  let registration: Promise<Awaited<ReturnType<typeof input.host.request>>> | undefined;
  let draining: Promise<unknown> | undefined;
  let armed = false;
  engine.reserve = function (ticket, size) {
    if (sameExecution(ticket.owner, owner)) tickets.push(structuredClone(ticket));
    return reserve.call(this, ticket, size);
  };
  participant.endReservation = function (event, deadline) {
    const offer = endReservation.call(this, event, deadline);
    if (offer && sameExecution(offer.owner, owner)) {
      assert.ok(armed, "Reservation must end while registration is paused");
      endTrace = input.fault.trace().slice(traceStart);
      firstOffer ??= structuredClone(offer);
      ended.resolve(offer);
    }
    return offer;
  };
  participant.drain = function (offer, dispatch) {
    if (!sameExecution(offer.owner, owner)) return drain.call(this, offer, dispatch);
    assert.ok(dispatch, "Missing original public SDK drain dispatcher");
    offers.push(structuredClone(offer));
    const result = drain.call(this, offer, (target, request, ...rest) => {
      assert.ok(sameExecution(target, owner), "Drain dispatcher changed the original owner");
      requests.push(structuredClone(request));
      return dispatch(target, request, ...rest).then(
        (result) => {
          submissions.push(structuredClone(result));
          return result;
        },
        (error: unknown) => {
          dispatchErrors.push(error instanceof Error ? `${error.stack}` : String(error));
          throw error;
        },
      );
    });
    draining = result.then((report) => {
      assert.equal(
        report.state,
        "saved",
        JSON.stringify({
          report,
          requests,
          submissions,
          dispatchErrors,
          finalTickets,
          trace: input.fault.trace().slice(traceStart),
        }),
      );
      assert.equal(report.blocker, false);
      completed.resolve();
    });
    // Attach immediately; await the same rejection below without an unhandled promise.
    void draining.catch(() => completed.resolve());
    return result;
  };
  const traceStart = input.fault.trace().length;
  try {
    const reached = input.fault.reached("before-publish");
    input.fault.arm("before-publish", "pause");
    armed = true;
    registration = input.host.request(
      principal,
      "storage/registerCheckpoint",
      {
        id: seed.record.id,
        expectedRevision: seed.record.revision,
        reservation: reservation.reservationId,
      },
      signal,
    );
    void registration.catch(() => {});
    await within(reached, "checkpoint registration publication");
    const paused = input.fault
      .trace()
      .slice(traceStart)
      .find((row) => row.point === "before-publish");
    const registrationTicket = tickets.find((ticket) => ticket.id === paused?.ticket);
    assert.ok(registrationTicket, "Missing actual registration publication ticket");
    assert.equal(registrationTicket.target.kind, "recovery");
    accepted(
      await input.broker.request(
        principal,
        "devices/recording/release",
        {
          reservationId: reservation.reservationId,
        },
        signal,
      ),
    );
    await within(ended.promise, "original participant reservation end");
    assert.ok(firstOffer);
    assert.ok(endTrace);
    // The entry is still waiting on durable registration; release only after end was observed.
    input.fault.release("before-publish");
    armed = false;
    const registered = await within(registration, "registration completion");
    assert.equal(registered.ok, false);
    if (!registered.ok) assert.equal(registered.error.code, "PLUGIN_E_STALE_RESOURCE");
    await within(completed.promise, "public SDK final drain");
    await draining;
    // The host copies engine methods when composing its record service. Read
    // the backend's actual admission snapshot instead of wrapping that copy.
    const barrier = input.backend.evidence.capture(
      { kind: "target", owner, recordId: seed.record.id },
      firstOffer.deadlineMonotonicMs,
    );
    finalTickets.push(
      ...input.backend.evidence
        .tickets(barrier)
        .filter(
          (ticket) =>
            sameExecution(ticket.owner, owner) &&
            ticket.metadata.kind === "record" &&
            ticket.metadata.record.checkpoint === "final",
        ),
    );
    assert.equal((await input.backend.evidence.flush(barrier)).state, "saved");
    const finalRecord = accepted(
      await input.host.request(principal, "storage/stat", { id: seed.record.id }, signal),
    ).record;
    assert.equal(finalRecord.checkpoint, "final");
    const read = accepted(
      await input.host.request(
        principal,
        "storage/openRead",
        {
          id: finalRecord.id,
          expectedRevision: finalRecord.revision,
          schemaVersion: 1,
        },
        signal,
      ),
    );
    let payloadSha256: string;
    try {
      const chunk = accepted(
        await input.host.request(
          principal,
          "storage/readChunk",
          {
            read: read.read,
            offset: 0,
            maxBytes: 262144,
          },
          signal,
        ),
      );
      assert.equal(chunk.eof, true);
      payloadSha256 = createHash("sha256").update(Buffer.from(chunk.data, "base64")).digest("hex");
    } finally {
      accepted(
        await input.host.request(principal, "storage/closeRead", { read: read.read }, signal),
      );
    }
    // Worker result and fault telemetry use separate real ports; wait for the matching trace.
    while (
      !input.fault
        .trace()
        .slice(traceStart)
        .some(
          (row) =>
            row.point === "after-publish" &&
            finalTickets.some((ticket) => ticket.id === row.ticket),
        )
    )
      await within(input.fault.reached("after-publish"), "final target publication trace");
    const trace = input.fault.trace().slice(traceStart);
    const targets = requests.flatMap((request) =>
      request.checkpoints.map((checkpoint) => checkpoint.record.id),
    );
    const publications = trace.filter(
      (row) =>
        row.point === "after-publish" && finalTickets.some((ticket) => ticket.id === row.ticket),
    );
    const evidence: CaseEvidence = {
      checks: {
        finalTargets: new Set(targets).size,
        finalPublications: new Set(publications.map((row) => row.ticket)).size,
        pendingRegistrationIncluded:
          firstOffer.checkpoints.some((checkpoint) => checkpoint.record.id === seed.record.id) &&
          targets.filter((id) => id === seed.record.id).length === 1,
        firstDeadline: firstOffer.deadlineMonotonicMs,
        lastDeadline: offers.at(-1)!.deadlineMonotonicMs,
      },
      events: [],
      samples: {},
      registration: {
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
      },
    };
    assertFoundationEvidence("registration-end", evidence);
    return evidence;
  } finally {
    if (armed) input.fault.release("before-publish");
    try {
      await within(
        Promise.allSettled([registration, draining].filter((value) => value !== undefined)),
        "registration-end cleanup",
      );
    } finally {
      engine.reserve = reserve;
      participant.endReservation = endReservation;
      participant.drain = drain;
    }
  }
}

export async function produceHealthyRelease(input: LifecycleCaseInput): Promise<CaseEvidence> {
  if (input.stage3.persistence !== input.host.participant)
    throw new Error("Detached persistence participant");
  const owner = pluginPrincipal(input.recording).owner;
  const other = pluginPrincipal(input.settings);
  if (sameExecution(owner, other.owner))
    throw new Error("Settings needs an unrelated admitted consumer");
  const reservation = await reserveLiveRecording(input);
  const generationBefore = owner.generation;
  const participant = input.host.participant,
    retire = input.stage3.device.retire,
    freeze = participant.freeze,
    drain = participant.drain;
  const retireCalls: ResourceOwner[] = [],
    freezeCalls: ResourceOwner[] = [],
    exits: ProcessExit[] = [];
  const drains: Promise<unknown>[] = [];
  const onExit = (exit: ProcessExit) => {
    exits.push(exit);
  };
  const unsubscribeRecording = input.recording.child.onExit(onExit);
  const unsubscribeSettings = input.settings.child.onExit(onExit);
  input.stage3.device.retire = function (retired, reason) {
    if (sameExecution(retired, owner) || sameExecution(retired, other.owner))
      retireCalls.push(retired);
    return retire.call(this, retired, reason);
  };
  participant.freeze = function (retired, reason, deadline, grant) {
    if (sameExecution(retired, owner) || sameExecution(retired, other.owner))
      freezeCalls.push(retired);
    return freeze.call(this, retired, reason, deadline, grant);
  };
  participant.drain = function (offer, dispatch) {
    const result = drain.call(this, offer, dispatch);
    // Attach both handlers immediately without swallowing a failed drain observation.
    if (sameExecution(offer.owner, owner))
      drains.push(
        result.then(
          (value) => ({ value }),
          (error) => ({ error }),
        ),
      );
    return result;
  };
  try {
    const signal = new AbortController().signal;
    const before = accepted(
      await input.host.request(other, "settings/read", { schemaVersion: 1 }, signal),
    );
    const enabled = before.values.find((row) => row.key === "fixture.enabled");
    if (!enabled || typeof enabled.value !== "boolean")
      throw new Error("Missing live fixture setting");
    accepted(
      await input.broker.request(
        pluginPrincipal(input.recording),
        "devices/recording/release",
        { reservationId: reservation.reservationId },
        signal,
      ),
    );
    // onEnded schedules its real work after the current synchronous turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settled = await within(Promise.all(drains), "reservation-end drains");
    for (const result of settled)
      if (result && typeof result === "object" && "error" in result) throw result.error;
    const updated = await input.host.request(
      other,
      "settings/update",
      {
        schemaVersion: before.schemaVersion,
        expectedRevision: before.revision,
        changes: [{ key: enabled.key, value: !enabled.value }],
      },
      signal,
    );
    const after = accepted(
      await input.host.request(other, "settings/read", { schemaVersion: 1 }, signal),
    );
    // Fresh traffic must succeed on the still-admitted original channel; it must
    // not depend on how long the broker retains an ended reservation tombstone.
    accepted(
      await input.broker.request(pluginPrincipal(input.recording), "devices/list", {}, signal),
    );
    const current = pluginPrincipal(input.recording).owner;
    if (
      !sameExecution(owner, current) ||
      !sameExecution(other.owner, pluginPrincipal(input.settings).owner)
    )
      throw new Error("Healthy release replaced an original execution");
    const evidence: CaseEvidence = {
      checks: {
        retireCalls: retireCalls.length,
        freezeCalls: freezeCalls.length,
        processExits: exits.length,
        unrelatedSettingsCommitted:
          updated.ok &&
          after.revision === updated.value.snapshot.revision &&
          after.revision !== before.revision &&
          after.values.some((row) => row.key === enabled.key && row.value === !enabled.value),
        generationBefore,
        generationAfter: current.generation,
      },
      events: [],
      samples: {},
    };
    assertFoundationEvidence("healthy-release", evidence);
    return evidence;
  } finally {
    input.stage3.device.retire = retire;
    participant.freeze = freeze;
    participant.drain = drain;
    unsubscribeRecording();
    unsubscribeSettings();
  }
}

// Test-local artifact metadata; no executable adapters, host factories or evidence inputs.
// Controller materializes this JSON and configures userData before calling the factory.
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import type * as ElectronModule from "electron";
import path from "node:path";
import os from "node:os";
import type {
  DesktopFoundationOptions,
  DesktopFoundation,
  DesktopMainComposition,
  DesktopMainCompositionInput,
} from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type {
  FoundationCounters,
  FoundationDiagnostics,
  Stage3BuiltinSource,
  BuiltinLaunchDescriptor,
} from "@kobrixa/plugin-runtime";
import type { FakeProviderControl } from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import type { BuiltinDeviceProvider } from "../../apps/desktop/src/main/device-broker/provider.js";

let factoryAttempted = false;
/** Reference panels are not part of the zero-panel pressure baseline. */
export function foundationBuiltinRoles(caseId: string): readonly string[] {
  if (caseId === "storage-ui-pressure") return ["pressure-a", "pressure-b"];
  return ["recording", "settings", ...(caseId === "import-restart" ? ["import"] : [])];
}

export async function createFoundationFixture(): Promise<FoundationFixture> {
  if (factoryAttempted)
    throw new Error("One foundation fixture per Electron process; second factory forbidden");
  factoryAttempted = true;
  const configPath = process.argv
    .find((a) => a.startsWith("--persistence-config="))
    ?.slice("--persistence-config=".length);
  if (!configPath || !path.isAbsolute(configPath))
    throw new Error("BLOCKED: missing controller artifact configuration");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  for (const key of [
    "profile",
    "buildRoot",
    "rendererUrl",
    "preload",
    "workerEntry",
    "commit",
    "artifact",
    "artifactSha256",
    "filesystem",
  ])
    assert.ok(typeof config[key] === "string" && config[key].length > 0, `Missing artifact ${key}`);
  for (const key of ["profile", "buildRoot", "preload", "workerEntry"])
    assert.ok(path.isAbsolute(config[key]), key);
  assert.match(config.commit, /^[0-9a-f]{40}$/);
  assert.match(config.artifactSha256, /^[0-9a-f]{64}$/);
  if (
    ![
      "retirement",
      "healthy-release",
      "registration-end",
      "contention",
      "suspend-wake",
      "disconnect-retry",
      "sealed-ttl",
      "unknown-publication",
      "action-replay",
      "renderer-loss",
      "all-optional-off",
      "compatibility",
      "import-restart",
      "storage-ui-pressure",
    ].includes(config.case)
  )
    throw new Error(
      `BLOCKED: ${config.case} requires its observation-table producer; no implemented producer for this selector`,
    );
  // No native import or service allocation occurs at module import time.
  // Requiring Electron only inside the invoked factory preserves inert imports
  // and avoids an asynchronous ESM load racing app readiness/primary locking.
  const { app, BrowserWindow, ipcMain } = createRequire(configPath)(
    "electron",
  ) as typeof ElectronModule;
  assert.equal(app.isReady(), false, "Profile and primary lock must precede Electron readiness");
  assert.equal(
    app.getPath("userData"),
    config.profile,
    "Controller must set profile before factory",
  );
  const { startPrimary } =
    await import("../../apps/desktop/src/main/plugins/profile-writer-lock.js");
  const { AuthorityContexts } =
    await import("../../apps/desktop/src/main/device-broker/authority-context.js");
  const { createJournal } = await import("../../apps/desktop/src/main/device-broker/journal.js");
  const { createJournalFilesystem } =
    await import("../../apps/desktop/src/main/device-broker/journal-filesystem.js");
  const { createDesktopFoundation } =
    await import("../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js");
  const { createFakeDeviceProvider } =
    await import("../../apps/desktop/src/main/device-broker/fake-provider.js");
  const { createCoreActionLedger, CoreRecovery } =
    await import("../../apps/desktop/src/main/plugins/core-recovery.js");
  const {
    composeDesktopMain,
    desktopUi,
    desktopLifecycle,
    trustedDeviceActions,
    desktopFoundationTestHandles,
    desktopDeviceAccess,
    createWindowRetirementHandler,
  } = await import("../../apps/desktop/src/main/plugins/controller.js");
  const { registerCoreRecoveryIpc, registerSettingsIpc170 } =
    await import("../../apps/desktop/src/main/plugins/ipc.js");
  const { registerPersistenceWindow170 } = await import("../../apps/desktop/src/main/ipc.js");
  const { BUILTIN_PLUGIN_SOURCES } = await import("../../apps/desktop/src/main/plugins/builtin.js");
  const { validateBuiltinLeaf } =
    await import("../../apps/desktop/src/main/plugins/builtin-launch.js");
  const { readSource } = await import("@kobrixa/plugin-runtime");
  const {
    registerUiIpc,
    registerUiEventIpc,
    diagnosticsFor: bridgeDiagnostics,
  } = await import("../../apps/desktop/src/main/plugins/ui-bridge.js");
  const { diagnosticsFor: stateDiagnostics } =
    await import("../../packages/plugin-runtime/src/ui-state.js");
  const { diagnosticsFor: runtimeDiagnostics } =
    await import("../../packages/plugin-runtime/src/ui-lifecycle.js");
  const { diagnosticsFor: workerDiagnostics, persistenceWorkerCount } =
    await import("../../apps/desktop/src/main/plugins/persistence/worker.js");
  const { produceContention, registerContentionCheckpoint } =
    await import("./plugin-persistence-contention.js");
  const { produceDisconnectRetry } = await import("./plugin-persistence-disconnect.js");
  const { produceSuspendWake } = await import("./plugin-persistence-suspend.js");
  const { produceSealedTtl } = await import("./plugin-persistence-sealed-ttl.js");
  const { produceUnknownPublication } = await import("./plugin-persistence-unknown.js");
  const { produceActionReplay, nativeActionControl } =
    await import("./plugin-persistence-action-replay.js");
  const { produceRendererLoss } = await import("./plugin-persistence-renderer-loss.js");
  const { createDesktopLauncher } =
    await import("../../apps/desktop/src/main/plugins/launchers.js");
  const optional =
    config.case === "all-optional-off"
      ? optionalStartup(
          config,
          (await import("../../apps/desktop/src/main/plugins/user-persistence-actions.js"))
            .UserPersistenceActions.prototype,
        )
      : undefined;
  const { syntheticImportDescriptor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-fixtures.js");
  const imported = config.case === "import-restart" ? importObserver(config.importWire) : undefined;
  const semanticImport =
    !!imported && (SEMANTIC_IMPORT_BOUNDARIES as readonly string[]).includes(config.importTrial);
  const importWriter = {
    sourceKey: syntheticImportDescriptor.targetSourceKey,
    freezeAdmission() {},
    async settled() {},
  };
  const importWitness = semanticImport ? observeImportWriter(importWriter) : undefined;
  const compatibility = config.case === "compatibility" ? compatibilityObserver() : undefined;
  const pressure =
    config.case === "storage-ui-pressure"
      ? pressureTransport((row) =>
          appendFileSync(config.pressure.rpcTrace, JSON.stringify(row) + "\n"),
        )
      : undefined;
  const pressureQueue = pressure ? observeWorkQueue(WorkQueue) : undefined;
  let pressureFolder = 0;
  let optionalPolicy: OptionalWire | undefined;
  let window: InstanceType<typeof BrowserWindow> | undefined;
  let fixture: FoundationFixture | undefined;
  const primary = startPrimary(
    app,
    async (profile: ProfileWriterLock) => {
      const now = () => performance.now(),
        userData = app.getPath("userData");
      const win = new BrowserWindow({
        width: 1024,
        height: 768,
        show: true,
        webPreferences: {
          preload: config.preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window = win;
      const second =
        config.case === "contention"
          ? new BrowserWindow({
              show: false,
              width: 1000,
              height: 800,
              webPreferences: {
                preload: config.preload,
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
              },
            })
          : undefined;
      const windows = second ? [win, second] : [win];
      const authority = new AuthorityContexts(profile.hostEpoch);
      const openDocument = (target = win) => {
        const document = authority.open(target.webContents.id);
        authority.report(target.webContents.id, {
          document,
          sequence: 1,
          state: "local",
          roomId: null,
          connected: true,
          synced: true,
          role: null,
          isHolder: true,
        });
      };
      for (const target of windows) {
        openDocument(target);
        target.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace) {
            authority.invalidate(target.webContents.id);
            openDocument(target);
          }
        });
      }
      const windowScope = (target: Electron.BrowserWindow) => {
        const p = authority.core(target.webContents.id, "recovery");
        return { hostEpoch: p.hostEpoch, workbenchInstance: p.workbenchInstance };
      };
      const scope = () => windowScope(win);
      const currentScope: DesktopMainCompositionInput["currentScope"] = (candidate) =>
        windows.some((target) => {
          if (target.isDestroyed()) return false;
          const current = windowScope(target);
          return (
            current.hostEpoch === candidate.hostEpoch &&
            current.workbenchInstance === candidate.workbenchInstance
          );
        });
      const nativeActions = nativeActionControl(now);
      const rendererLaunches: RendererLaunch[] = [];
      let rendererProbe: (() => Promise<void>) | undefined;
      let expectedRendererLoss = false;
      let rendererReopened = false;
      let rendererExit:
        | {
            pid: number;
            at: number;
            reason: string;
            exitCode: number;
            osExit: { at: number; code: string };
          }
        | undefined;
      let rendererRetirement: Promise<void> | undefined;
      const coreActions = createCoreActionLedger({ now, current: currentScope });
      const journalProfile = profile,
        journal = createJournal(createJournalFilesystem(userData), journalProfile);
      let composition: DesktopMainComposition | undefined;
      let listeners = 0,
        fake: FakeProviderControl | undefined,
        provider: BuiltinDeviceProvider | undefined,
        fault: PersistenceFaultControl | undefined;
      let restoreReservation = () => {};
      const ipcNames: string[] = [],
        off: Array<() => void> = [],
        failures: unknown[] = [];
      const report = (error: unknown) => {
        failures.push(error);
        optional?.event("failure", { error: String(error) });
      };
      const acceptanceFoundation = async (
        options: DesktopFoundationOptions,
      ): Promise<DesktopFoundation> => {
        const foundation = await createDesktopFoundation({
          ...options,
          providerFactory(catalog) {
            optional?.event("provider");
            const created = createFakeDeviceProvider({
              catalog,
              now: options.now,
              // The minimal fixture completes motion immediately. Contention
              // must retain an actual timed operation until Stop interrupts it.
              ...(config.case === "contention" ? { profile: "maximum" as const } : {}),
              ...(["suspend-wake", "disconnect-retry"].includes(config.case)
                ? { motionProfile: "staged" as const }
                : {}),
            });
            fake = created.control;
            provider = created.provider;
            if (optional) {
              const connect = provider.connect;
              provider.connect = function (...args) {
                optional.event("connect", { target: args[0] });
                return connect.apply(this, args);
              };
            }
            return created.provider;
          },
        });
        if (optional) {
          const request = foundation.broker.request;
          foundation.broker.request = function (this: typeof foundation.broker, ...args) {
            if (args[1] === "devices/connect")
              optional.event("connect", { site: "broker.request" });
            return request.apply(this, args);
          } as typeof request;
          const reconnect = foundation.broker.reconnectForRecovery;
          foundation.broker.reconnectForRecovery = function (...args) {
            optional.event("reconnect");
            return reconnect.apply(this, args);
          };
        }
        const reservations = foundation.broker.reservations,
          original = reservations.onEnded;
        reservations.onEnded = function (listener) {
          const unsubscribe = original.call(this, listener);
          listeners++;
          let active = true;
          return () => {
            if (!active) return;
            unsubscribe();
            active = false;
            listeners--;
          };
        };
        restoreReservation = () => {
          reservations.onEnded = original;
        };
        return foundation;
      };
      try {
        await journal.load();
        if (optional) {
          const { filePluginStateStore } =
            await import("../../apps/desktop/src/main/plugins/state-store.js");
          const store = filePluginStateStore(userData);
          await store.load();
          if (config.optionalPhase !== "cold") {
            const disabled =
              config.optionalPhase === "seed"
                ? ["builtin:acceptance.ui-settings"]
                : ["builtin:acceptance.ui-recording", "builtin:kobrixa.device-ev3"];
            await store.update((current) => ({ ...current, disabled }));
          }
          const disabled = [...store.settings().disabled].sort();
          assert.deepEqual(
            disabled,
            config.optionalPhase === "seed"
              ? [optionalKeys[1]]
              : config.optionalPhase === "settings"
                ? [optionalKeys[0], optionalKeys[2]]
                : optionalKeys,
            "Actual saved policy must precede optional discovery",
          );
          const policyPath = path.join(userData, "plugins/state.json");
          const data = await readFile(policyPath, "utf8");
          optionalPolicy = {
            at: Date.now(),
            disabled,
            path: policyPath,
            data,
            sha256: createHash("sha256").update(data).digest("hex"),
            beforeCompose: 0,
          };
        }

        const builtins = [...BUILTIN_PLUGIN_SOURCES];
        for (const role of foundationBuiltinRoles(config.case)) {
          if (optional) {
            builtins.push(optional.source(config.buildRoot, role));
            continue;
          }
          const pluginId = role === "import" ? "test.synthetic" : `acceptance.ui-${role}`,
            sourceKey = `builtin:${pluginId}`,
            slug = `acceptance-builtin-${role}`;
          // Explicit test-only sources use the real payload validator and launcher.
          // They are not product registrations: never extend the shipped allowlist
          // or substitute for the motor/lab identities to run this reference fixture.
          const payload = await validateBuiltinLeaf(
            path.join(config.buildRoot, "plugins", slug),
            pluginId,
          );
          const launch: BuiltinLaunchDescriptor = {
            sourceKey,
            pluginId,
            policy: "optional" as const,
            runtime: "node" as const,
            packageRoot: payload.root,
            entry: "main.cjs",
            manifest: "kobrixa-plugin.json",
            resourceIndex: "resource-index.json",
          };
          const manifest = JSON.parse(
            await readFile(path.join(launch.packageRoot, launch.manifest), "utf8"),
          );
          const index = JSON.parse(
            await readFile(path.join(launch.packageRoot, launch.resourceIndex), "utf8"),
          );
          const resources: Record<string, string> = {};
          for (const file of index.files) {
            const relative = path.normalize(file.path);
            assert.ok(
              !path.isAbsolute(relative) &&
                relative !== ".." &&
                !relative.startsWith(`..${path.sep}`),
            );
            const bytes = await readFile(path.join(launch.packageRoot, relative));
            assert.equal(bytes.length, file.bytes);
            assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
            if (relative.endsWith(".json")) resources[file.path] = bytes.toString("utf8");
          }
          const source: Stage3BuiltinSource = {
            kind: "builtin",
            policy: "optional",
            manifest,
            resources,
            launch,
          };
          const validated = await readSource(source, { safeMode: false });
          assert.ok(validated.manifest, `Invalid builtin ${sourceKey}`);
          assert.deepEqual(validated.problems, [], `Invalid builtin ${sourceKey}`);
          assert.equal(validated.sourceKey, sourceKey);
          builtins.push(source);
        }
        if (optional) {
          optionalPolicy!.beforeCompose = Date.now();
          // Keep resources structured-cloneable. The fixture sources already expose
          // observed getters; use getters for any provider resources as well, not a Proxy.
          for (const source of builtins)
            if (source.kind === "builtin" && source.policy === "optional") {
              const key = `builtin:${(source.manifest as { id: string }).id}`;
              if (key !== "builtin:kobrixa.device-ev3") continue;
              const resources = source.resources;
              const observed: Record<string, string> = {};
              for (const name of Object.keys(resources))
                Object.defineProperty(observed, name, {
                  enumerable: true,
                  get() {
                    optional.event("resource", { sourceKey: key, file: name });
                    return resources[name];
                  },
                });
              source.resources = observed;
            }
        }
        const compositionInput: DesktopMainCompositionInput = {
          createFoundation: acceptanceFoundation,
          foundationOptions: {
            profile,
            authority,
            journal,
            coreActions,
            now,
            hasPermission: (principal, permission) =>
              pressure && principal.kind === "core"
                ? currentScope(principal) &&
                  ["devices.read", "devices.connect", "devices.control"].includes(permission)
                : principal.kind === "plugin" &&
                  !!composition &&
                  desktopDeviceAccess(composition.plugins).hasPermission(
                    principal.owner,
                    permission,
                  ),
            requirements: (owner) =>
              composition ? desktopDeviceAccess(composition.plugins).requirements(owner) : null,
            connectionPolicy: () => ({
              wifiConnectTimeoutMs: 10000,
              wifiHandshakeTimeoutMs: 5000,
              usbAutoReconnect: false,
              usbRetryInterval: 2000,
              usbRetryLimit: 3,
            }),
            operationGate: () => ({ ok: true, value: null }),
          },
          plugins: {
            launcher: (hooks) => {
              const launch = createDesktopLauncher({
                ...hooks,
                onOutput(plugin, line) {
                  hooks.onOutput?.(plugin, line);
                  if (
                    pressure &&
                    plugin.channelOwner &&
                    plugin.id.startsWith("acceptance.ui-pressure-")
                  )
                    pressure.output(plugin.channelOwner, line);
                  if (imported && plugin.id === "test.synthetic" && plugin.channelOwner)
                    imported.output(plugin.channelOwner, line);
                  const row = compatibility?.rows.find(
                    (r) => r.owner.processEpoch === plugin.channelOwner?.processEpoch,
                  );
                  if (row) compatibility!.output(row, line);
                },
              });
              return async (plugin) => {
                optional?.event("launch", {
                  owner: plugin.channelOwner,
                  sourceKey: plugin.sourceKey,
                });
                if (plugin.channelOwner)
                  rendererLaunches.push({ owner: structuredClone(plugin.channelOwner), at: now() });
                const row =
                  compatibility && plugin.id.startsWith("acceptance.compat-") && plugin.channelOwner
                    ? compatibility.begin(plugin.channelOwner)
                    : undefined;
                const child = await launch(plugin);
                if (
                  pressure &&
                  plugin.channelOwner &&
                  plugin.id.startsWith("acceptance.ui-pressure-")
                )
                  return pressure.attach(plugin.channelOwner, child);
                return imported && plugin.id === "test.synthetic" && plugin.channelOwner
                  ? imported.attach(plugin.channelOwner, child)
                  : row
                    ? compatibility!.attach(row, child)
                    : child;
              };
            },
            userData,
            builtins,
            commandLine: {
              developmentDirectories: config.compatibility?.sources ?? [],
              safeMode: false,
              ...(config.compatibility ? { python: config.compatibility.python } : {}),
            },
            locale: "en",
            dialogs: {
              confirmDeveloperMode: async () => true,
              chooseFolder: async () =>
                pressure
                  ? config.pressure.uiFolders[pressureFolder++ % config.pressure.uiFolders.length]
                  : undefined,
              confirmLink: async () => true,
              confirmUnlink: async () => true,
              choosePython: async () => undefined,
            },
          },
          principal: (owner) => authority.plugin(win.webContents.id, owner),
          scope,
          currentScope,
          legacyFlush: async () => {},
          report,
        };
        composition = await composeDesktopMain(compositionInput, {
          ...(["action-replay", "renderer-loss", "all-optional-off"].includes(config.case)
            ? { nativeActions }
            : {}),
          ...(imported
            ? {
                legacy: {
                  descriptors: [syntheticImportDescriptor],
                  writers: [importWitness?.writer ?? importWriter],
                },
              }
            : {}),
          worker: {
            entry: config.workerEntry,
            control(control: PersistenceFaultControl) {
              assert.equal(fault, undefined);
              fault = control;
            },
          },
        });
        assert.ok(composition);
        importWitness?.composed();
        const live = composition,
          handles = desktopFoundationTestHandles(live),
          ui = desktopUi(live);
        if (!optional || config.optionalPhase === "seed") {
          assert.ok(fake, "Missing actual provider callback");
          assert.ok(provider, "Missing actual provider instance");
        }
        const admittedProvider = provider!,
          providerControl = fake!;
        assert.ok(fault, "Missing actual worker control");
        if (imported) {
          assert.equal(handles.recovery, "ready");
          assert.equal(live.stage3.persistence, handles.host.participant);
          assert.equal(handles.profile, profile);
          // No document is loaded on restart: the real host/worker and public plugin
          // channel operate without a renderer capture or private fixture handlers.
          let closed: Promise<void> | undefined;
          fixture = {
            composition: {
              profile: handles.profile,
              journalProfile,
              persistenceProfile: handles.persistenceProfile,
              host: handles.host,
              stage3: live.stage3,
              get workerCount() {
                return persistenceWorkerCount(handles.backend);
              },
              get reservationListenerCount() {
                return listeners;
              },
            },
            environment: {
              commit: config.commit,
              artifact: config.artifact,
              artifactSha256: config.artifactSha256,
              os: os.release(),
              architecture: process.arch,
              cpu: os.cpus()[0]?.model ?? "unknown",
              ramBytes: os.totalmem(),
              filesystem: config.filesystem,
              node: process.versions.node,
              electron: process.versions.electron ?? "",
              memoryMethod: "not-measured-partial-import",
              warmCold: "cold",
            },
            async runCase(id) {
              assert.equal(id, "import-restart");
              const evidence = semanticImport
                ? await produceSemanticImport({
                    config,
                    live,
                    observer: imported,
                    witness: importWitness!,
                  })
                : await produceImportSlice({ config, live, fault: fault!, observer: imported });
              if (semanticImport) assertSemanticPhase(evidence.importSlice);
              else assertImportPhase(evidence.importSlice);
              return evidence;
            },
            close() {
              return (closed ??= (async () => {
                await live.dispose();
                restoreReservation();
                assert.equal(persistenceWorkerCount(handles.backend), 0);
                assert.equal(listeners, 0);
                assert.deepEqual(failures, []);
                win.destroy();
              })());
            },
          };
          assertRealComposition(fixture);
          return;
        }

        assert.equal(handles.recovery, "ready");
        assert.equal(live.stage3.persistence, handles.host.participant);
        assert.equal(handles.profile, profile);
        assert.equal(handles.persistenceProfile, profile);
        const trusted = (event: { sender: { id: number }; senderFrame: unknown }) =>
          windows.some(
            (target) =>
              !target.isDestroyed() &&
              event.sender.id === target.webContents.id &&
              event.senderFrame === target.webContents.mainFrame,
          );
        const routes = new Map<string, Map<number, Parameters<IpcHandle>[1]>>();
        const handleFor =
          (target?: Electron.BrowserWindow): IpcHandle =>
          (name, action) => {
            if (!routes.has(name)) {
              routes.set(name, new Map());
              ipcNames.push(name);
              ipcMain.handle(name, (event, ...args) => {
                if (!trusted(event)) throw new Error("Untrusted acceptance sender");
                const route = routes.get(name)!.get(event.sender.id) ?? routes.get(name)!.get(0);
                if (!route) throw new Error("No route for native window");
                return Reflect.apply(route, undefined, [event, ...args]);
              });
            }
            routes
              .get(name)!
              .set(target?.webContents.id ?? 0, (event, ...args) =>
                Reflect.apply(action, undefined, [event, ...args]),
              );
          };
        const handle = handleFor();
        registerUiIpc({ handle, bridge: ui.bridge, trusted });
        off.push(
          registerUiEventIpc({
            handle,
            bridge: ui.bridge,
            trusted,
            send: (channel, event) => {
              if (!win.isDestroyed()) win.webContents.send(channel, event);
            },
          }),
        );
        win.on("blur", () => ui.intent.dispose());
        win.on("hide", () => ui.intent.dispose());
        const retireActionRenderer = createWindowRetirementHandler({
          composition: live,
          scope,
          coreActions,
          invalidate: () => authority.invalidate(win.webContents.id),
          flush: async () => {},
          pause: async () => {},
        });
        win.webContents.on("render-process-gone", (_event, details) => {
          if (expectedRendererLoss) {
            assert.ok(rendererExit);
            rendererExit = {
              ...rendererExit,
              at: now(),
              reason: details.reason,
              exitCode: details.exitCode,
            };
            const retirement = retireActionRenderer(false);
            rendererRetirement = Promise.all([retirement, rendererProbe?.()]).then(() => {});
            void rendererRetirement.catch(report);
            return;
          }
          report(new Error("Reference renderer exited before final diagnostics"));
          coreActions.retire(scope());
          ui.actions.revokeWindow(scope());
          void desktopLifecycle(live).close("close").catch(report);
        });
        const recovery = new CoreRecovery({
          scope,
          now,
          actions: coreActions,
          entries: () =>
            live.foundation.broker.recovery.snapshot().blockers.map((id) => ({
              item: {
                id,
                sourceKey: "core:device",
                kind: "device",
                state: "unconfirmed",
                title: { en: "Device recovery", "zh-TW": "裝置復原" },
                detail: {
                  en: "Stop or journal disposition is unconfirmed.",
                  "zh-TW": "停止或日誌結果尚未確認。",
                },
                actions: [],
              },
              options: new Map(),
            })),
          openDetail() {
            throw new Error("Persistence detail must be routed through D170 attachment");
          },
        });
        off.push(
          registerCoreRecoveryIpc(handle, recovery, () => {
            if (!win.isDestroyed()) win.webContents.send("plugins:recovery:changed");
          }),
        );
        off.push(live.foundation.broker.recovery.subscribe(() => recovery.changed()));
        const facets = live.plugins.persistence170;
        assert.ok(facets, "Missing D170 persistence facets");
        off.push(
          registerPersistenceWindow170({
            handle: handleFor(win),
            facets,
            coreRecovery: recovery,
            renderer: () => (win.isDestroyed() ? undefined : win.webContents),
          }),
        );
        if (second)
          off.push(
            registerSettingsIpc170({
              handle: handleFor(second),
              service: facets.settings,
              scope: () => windowScope(second),
              publish: (expected, channel, payload) => {
                if (
                  !second.isDestroyed() &&
                  currentScope(expected) &&
                  expected.workbenchInstance === windowScope(second).workbenchInstance
                )
                  second.webContents.send(channel, payload);
              },
            }),
          );
        ui.setRecoveryNavigation(() => {
          if (!win.isDestroyed()) win.webContents.send("plugins:recovery:changed");
        });
        const diagnostics: FoundationDiagnostics[] = [
          stateDiagnostics(ui.states),
          runtimeDiagnostics(handles.runtime),
          bridgeDiagnostics(ui.bridge),
          workerDiagnostics(handles.backend),
        ];
        assert.equal(new Set(diagnostics).size, 4, "Duplicate main diagnostics");
        const snapshots = () => diagnostics.map((d) => d.snapshot());
        snapshots(); // Unknown instance lookups fail before activating consumers.
        if (pressure) {
          const { runUiLoad } = await import("./declarative-ui-load-main.js");
          const { snapshotDelay } = await import("./declarative-ui-slow-main.js");
          let ran = false,
            closing: Promise<void> | undefined,
            evidence: CaseEvidence | undefined;
          const observer = pressureQueue!;
          let sinkFaults = 0;
          const flush = () => {
            try {
              appendFileSync(
                config.pressure.mainTrace,
                JSON.stringify({
                  events: observer.drain(),
                  observation: observer.snapshot(),
                  at: performance.now(),
                  memory: process.memoryUsage(),
                }) + "\n",
              );
            } catch {
              sinkFaults++;
            }
          };
          const timer = setInterval(flush, 20);
          timer.unref();
          const command = async (pluginId: string, command: string): Promise<PressureRow> => {
            const startedAt = performance.now();
            const begin = pressure.outputs.length;
            const result = await live.plugins.execute(`${pluginId}.${command}`);
            assert.equal(result.ok, true, JSON.stringify(result));
            const until = performance.now() + 10000;
            let row;
            while (
              !(row = pressure.outputs
                .slice(begin)
                .find((r) => r.pluginId === pluginId && r.command === command))
            ) {
              assert.ok(performance.now() < until, `Missing ${pluginId}.${command} output`);
              assert.deepEqual(pressure.snapshot().faults, []);
              await new Promise((r) => setTimeout(r, 10));
            }
            return {
              ...row,
              commandInterval: {
                realm: "main",
                pid: process.pid,
                timeOrigin: performance.timeOrigin,
                startedAt,
                finishedAt: performance.now(),
              },
            };
          };
          const ids = ["acceptance.ui-pressure-a", "acceptance.ui-pressure-b"];
          const both = (name: string) => settlePressure(ids.map((id) => command(id, name)));
          const close = () =>
            (closing ??= (async () => {
              try {
                await live.dispose();
                const until = performance.now() + 5000;
                while (
                  pressure.snapshot().exits.length < pressure.owners.length &&
                  performance.now() < until
                )
                  await new Promise((r) => setTimeout(r, 10));
                assert.deepEqual(failures, []);
                for (const s of snapshots()) assertZeroCounters(s);
                for (const unsubscribe of off.splice(0)) unsubscribe();
                for (const name of ipcNames.splice(0)) ipcMain.removeHandler(name);
                restoreReservation();
                if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
                win.destroy();
              } finally {
                clearInterval(timer);
                observer.restore();
                flush();
              }
            })());
          fixture = {
            composition: {
              profile: handles.profile,
              journalProfile,
              persistenceProfile: handles.persistenceProfile,
              host: handles.host,
              stage3: live.stage3,
              get workerCount() {
                return persistenceWorkerCount(handles.backend);
              },
              get reservationListenerCount() {
                return listeners;
              },
            },
            environment: {
              commit: config.commit,
              artifact: config.artifact,
              artifactSha256: config.artifactSha256,
              os: os.release(),
              architecture: process.arch,
              cpu: os.cpus()[0]?.model ?? "unknown",
              ramBytes: os.totalmem(),
              filesystem: config.filesystem,
              node: process.versions.node,
              electron: process.versions.electron ?? "",
              memoryMethod: "shared-process-rss-and-isolate-statistics; separate-RSS-unavailable",
              warmCold: "cold-and-warm",
            },
            close,
            async runCase(id) {
              assert.equal(id, "storage-ui-pressure");
              assert.equal(ran, false);
              ran = true;
              const p: PressureRow = {
                status: "partial-memory-unavailable",
                fullPass: false,
                unavailableMemory: ["mainAdditionalRSS32MiB", "workerAdditionalRSS64MiB"],
                seeded: [],
                verified: [],
                steps: [],
                samples: { inventory: [], flush: [], commit: [] },
                memory: [],
                pending: [
                  "separate RSS ruling",
                  "settings draft/page latency",
                  "main synchronous span threshold",
                  "unloaded-vs-loaded physical stop dispatch comparison",
                  "three independent UI measurement repetitions",
                ],
              };
              let sessionId: string | undefined,
                channelIds: string[] = [];
              const principal = () => authority.core(win.webContents.id, "monitor");
              const uiReport = await guardPressure(
                () =>
                  runUiLoad({
                    window: win,
                    composition: live,
                    runtime: runtimeDiagnostics(handles.runtime),
                    directory: config.pressure.uiDirectory,
                    folders: config.pressure.uiFolders,
                    durationMs: 600000,
                    cycles: 1000,
                    snapshotDelay: snapshotDelay(),
                    workload: {
                      async prepare() {
                        for (let i = 0; i < 25; i++)
                          for (const row of await both("seed")) p.seeded.push(row.result);
                        await both("inventory");
                        for (let i = 0; i < 25; i++)
                          for (const row of await both("verify")) p.verified.push(row.result);
                        await both("stage");
                        const inventory = accepted(
                          await live.foundation.broker.request(
                            principal(),
                            "devices/list",
                            {},
                            new AbortController().signal,
                          ),
                        );
                        const provider = inventory.providers.find(
                          (row) => row.state === "available",
                        );
                        assert.ok(provider);
                        const discovered = accepted(
                          await live.foundation.broker.request(
                            principal(),
                            "devices/discover",
                            { providerId: provider.providerId },
                            new AbortController().signal,
                          ),
                        );
                        assert.ok(discovered.candidates[0]);
                        sessionId = accepted(
                          await live.foundation.broker.request(
                            principal(),
                            "devices/connect",
                            {
                              target: {
                                kind: "candidate",
                                candidateId: discovered.candidates[0].candidateId,
                              },
                            },
                            new AbortController().signal,
                          ),
                        ).session.sessionId;
                        const sources = accepted(
                          await live.foundation.broker.request(
                            principal(),
                            "devices/session",
                            { sessionId },
                            new AbortController().signal,
                          ),
                        );
                        channelIds = sources.sources.channels
                          .filter((row) => row.state === "ready")
                          .slice(0, 1)
                          .map((row) => row.channelId);
                        assert.equal(channelIds.length, 1);
                      },
                      async start() {
                        p.startedAt = performance.now();
                      },
                      async step(index, uiSample) {
                        const start = performance.now();
                        assert.ok(sessionId);
                        const work = await Promise.allSettled([
                          live.foundation.broker.request(
                            principal(),
                            "devices/read",
                            { sessionId, channelIds, freshness: "fresh" },
                            new AbortController().signal,
                          ),
                          pressureStep(both, index < 30),
                        ] as const);
                        const rejected = work.filter((r) => r.status === "rejected");
                        if (rejected.length === 1) throw rejected[0]!.reason;
                        if (rejected.length)
                          throw new AggregateError(
                            rejected.map((r) => r.reason),
                            "Pressure provider/storage failed",
                          );
                        if (work[0].status !== "fulfilled" || work[1].status !== "fulfilled")
                          throw new Error("Unreachable pressure rejection");
                        const provider = work[0].value,
                          { committed, staging, inventory, flushed, phases } = work[1].value;
                        assert.equal(provider.ok, true, JSON.stringify(provider));
                        p.steps.push({
                          index,
                          ui: uiSample,
                          startedAt: start,
                          finishedAt: performance.now(),
                          phases,
                          staging: staging.map((r) => r.result),
                          provider,
                        });
                        p.memory.push({ at: performance.now(), ...process.memoryUsage() });
                        if (index < 30) {
                          p.samples.inventory.push(inventory);
                          p.samples.flush.push(flushed);
                          p.samples.commit.push(committed);
                        }
                        assert.deepEqual(pressure.snapshot().faults, []);
                        assert.equal(sinkFaults, 0);
                      },
                      async finish() {
                        p.finishedAt = performance.now();
                        await both("cleanup");
                        await both("flush");
                        if (sessionId)
                          accepted(
                            await live.foundation.broker.request(
                              principal(),
                              "devices/disconnect",
                              { sessionId },
                              new AbortController().signal,
                            ),
                          );
                      },
                    },
                  }),
                () => both("cleanup"),
              );
              p.ui = uiReport;
              p.sdkTimings = pressure.outputs.filter(
                (row) => row.operation && row.at >= p.startedAt && row.at <= p.finishedAt,
              );
              p.owners = pressure.owners;
              evidence = { checks: {}, events: [], samples: {}, pressure: p };
              return evidence;
            },
            async finishObservation(result) {
              assert.equal(result, evidence);
              const p = result.pressure!;
              const bytes = await readFile(config.pressure.workerTrace);
              const rows = bytes
                .toString("utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
              p.worker = verifyPressureWorkerTrace(rows, p.owners);
              p.workerTrace = {
                path: config.pressure.workerTrace,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              };
              p.transport = pressure.snapshot();
              p.mainObserver = observer.snapshot();
              assert.equal(sinkFaults, 0);
              p.artifacts = [];
              for (const file of [config.pressure.mainTrace, config.pressure.rpcTrace])
                p.artifacts.push({
                  path: file,
                  sha256: createHash("sha256")
                    .update(await readFile(file))
                    .digest("hex"),
                });
              assertPressurePartial(p);
            },
          };
          return;
        }

        await win.loadURL(config.rendererUrl);
        win.webContents.debugger.attach("1.3");
        const windowControls = (win: Electron.BrowserWindow, text: string) => {
          const browser = async (expression: string) => {
            const result = await win.webContents.debugger.sendCommand("Runtime.evaluate", {
              expression,
              awaitPromise: true,
              returnByValue: true,
            });
            assert.equal(result.exceptionDetails, undefined, "Browser collector failed");
            return result.result.value;
          };

          const observeForm = async (): Promise<ContentionForm> => {
            const rows = (await browser(
              "window.persistenceAcceptance.settingsSnapshot()",
            )) as ContentionForm[];
            const forms = rows.filter(
              (row) => row.binding.owner.sourceKey === "builtin:acceptance.ui-settings",
            );
            assert.equal(forms.length, 1, "Exactly one live settings form required");
            assert.ok(forms[0]!.input, "Actual mapped input not rendered");
            return forms[0]!;
          };
          const painted = () =>
            browser(
              "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
            );
          const nativeClick = async (selector: string) => {
            const inspect = () =>
              browser(`(() => {
            const node = document.querySelector(${JSON.stringify(selector)});
            if (!(node instanceof HTMLElement) || node.matches(':disabled')) return null;
            node.scrollIntoView({block:'center'});
            const r = node.getBoundingClientRect(), x = Math.floor(r.x + r.width / 2), y = Math.floor(r.y + r.height / 2);
            return r.width > 0 && r.height > 0 && node.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
          })()`);
            const down = await inspect();
            assert.ok(down, `Native target unavailable: ${selector}`);
            win.webContents.sendInputEvent({
              type: "mouseDown",
              button: "left",
              clickCount: 1,
              ...down,
            });
            await painted();
            const up = await inspect();
            assert.ok(up, `Native target disappeared: ${selector}`);
            win.webContents.sendInputEvent({
              type: "mouseUp",
              button: "left",
              clickCount: 1,
              ...up,
            });
            await painted();
          };
          const contentionForm = {
            async prepare() {
              win.show();
              win.focus();
              win.webContents.focus();
              await nativeClick('[data-persistence-open="settings"]');
              const formDeadline = Date.now() + 15000;
              await (async () => {
                while (Date.now() < formDeadline) {
                  const rows = await browser("window.persistenceAcceptance.settingsSnapshot()");
                  if (
                    rows.some(
                      (row: ContentionForm) =>
                        row.binding.owner.sourceKey === "builtin:acceptance.ui-settings" &&
                        row.input,
                    )
                  )
                    return;
                  await new Promise<void>((resolve) => setTimeout(resolve, 10));
                }
                throw new Error("Timed out observing native settings form");
              })();
              const form = await observeForm();
              assert.equal(form.input.value, "", "Contention needs a fresh empty draft");
              return form;
            },
            async edit() {
              win.show();
              win.focus();
              win.webContents.focus();
              const form = await observeForm();
              assert.equal(form.input.value, "", "Contention needs an unedited baseline");
              await nativeClick(`[id=${JSON.stringify(form.input.id)}]`);
              assert.equal(await browser("document.activeElement?.id"), form.input.id);
              await win.webContents.insertText(text);
              await painted();
              const draft = await observeForm();
              assert.equal(draft.raw["fixture.note"], text);
              assert.ok(
                draft.inputEvents.some(
                  (event) => event.type === "input" && event.trusted && event.value === text,
                ),
              );
              return draft;
            },
            async submit() {
              win.show();
              win.focus();
              win.webContents.focus();
              const form = await observeForm();
              assert.equal(await browser("document.activeElement?.id"), form.input.id);
              win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
              win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
              await painted();
            },
            observe: observeForm,
          };
          return { browser, form: contentionForm };
        };
        const { browser, form: contentionForm } = windowControls(win, "Losing draft");
        await browser("window.declarativeAcceptance.foundationDiagnostics()");
        let winnerControls: ReturnType<typeof windowControls> | undefined;
        const prepareWinner = async () => {
          assert.ok(second);
          if (!winnerControls) {
            const url = new URL(config.rendererUrl);
            url.searchParams.set("view", "settings-only");
            await second.loadURL(url.href);
            second.webContents.debugger.attach("1.3");
            winnerControls = windowControls(second, "Winning write");
            await winnerControls.browser("window.declarativeAcceptance.foundationDiagnostics()");
          }
          return winnerControls.form.prepare();
        };
        const activateRole = async (role: string) => {
          const sourceKey = `builtin:acceptance.ui-${role}`;
          const activated = await live.plugins.execute(`acceptance.ui-${role}.legacy`);
          assert.equal(
            activated.ok,
            true,
            `Explicit controller activation failed: ${JSON.stringify({
              result: activated,
              source: live.plugins.state().plugins.find((plugin) => plugin.sourceKey === sourceKey),
            })}`,
          );
          const context = await handles.runtime.activateInitialized(
            sourceKey,
            new AbortController().signal,
          );
          await handles.runtime.ready(context.owner, new AbortController().signal);
        };
        for (const role of optional || compatibility ? [] : ["recording", "settings"])
          await activateRole(role);
        const select = (role: string): LiveConsumer => {
          const sourceKey = `builtin:acceptance.ui-${role}`;
          const rows = handles
            .channels()
            .filter(
              (row: { context: Stage3ChannelContext }) => row.context.owner.sourceKey === sourceKey,
            );
          assert.equal(rows.length, 1, `Missing/duplicate ${role} channel`);
          const row = rows[0]!;
          const principal = row.context.principal();
          assert.equal(principal.kind, "plugin");
          if (principal.kind !== "plugin") throw new Error("Missing plugin principal");
          assert.ok(sameExecution(row.context.owner, principal.owner));
          assert.ok(handles.runtime.current(principal.owner));
          assert.equal(principal.owner.pluginId, `acceptance.ui-${role}`);
          assert.equal(principal.owner.hostEpoch, profile.hostEpoch);
          return { principal: row.context.principal, child: row.process };
        };
        const referenceConsumers =
          optional || compatibility
            ? undefined
            : { recording: select("recording"), settings: select("settings") };
        const input: LifecycleCaseInput = {
          now,
          broker: live.foundation.broker,
          host: handles.host,
          stage3: live.stage3,
          plugins: live.plugins,
          fault,
          backend: handles.backend,
          get recording() {
            assert.ok(referenceConsumers, "This startup policy has no reference consumers");
            return referenceConsumers.recording;
          },
          get settings() {
            assert.ok(referenceConsumers, "This startup policy has no reference consumers");
            return referenceConsumers.settings;
          },
        };
        const consumerExits = (
          optional || compatibility ? [] : [input.recording, input.settings]
        ).map((consumer) => {
          const observed = latch<ProcessExit>();
          off.push(consumer.child.onExit((exit) => observed.resolve(exit)));
          return observed.promise;
        });
        const unavailable = (id: FoundationCase) => async (): Promise<CaseEvidence> => {
          throw new Error(`BLOCKED: ${id} observation-table producer is not implemented`);
        };
        const crashRenderer = async (probe?: () => Promise<void>) => {
          rendererProbe = probe;
          assert.equal(expectedRendererLoss, false);
          expectedRendererLoss = true;
          rendererExit = {
            pid: win.webContents.getOSProcessId(),
            at: 0,
            reason: "pending",
            exitCode: 0,
            osExit: { at: 0, code: "pending" },
          };
          assert.ok(rendererExit.pid > 0);
          const gone = new Promise<void>((resolve) =>
            win.webContents.once("render-process-gone", () => resolve()),
          );
          win.webContents.forcefullyCrashRenderer();
          await within(gone, "Actual renderer exit");
          assert.ok(rendererRetirement);
          await rendererRetirement;
          await within(
            (async () => {
              for (;;) {
                try {
                  process.kill(rendererExit!.pid, 0);
                } catch (error) {
                  assert.equal((error as NodeJS.ErrnoException).code, "ESRCH");
                  rendererExit!.osExit = {
                    at: now(),
                    code: (error as NodeJS.ErrnoException).code!,
                  };
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            })(),
            "Renderer OS exit",
          );
          return rendererExit;
        };
        const finishRecovery = async () => {
          const detail = live.plugins.persistence170!.detail;
          for (const entry of detail.entries()) {
            const snapshot = accepted(await detail.bridge.snapshot({ itemId: entry.item.id }));
            const discard = snapshot.items
              .flatMap((item) => item.actions)
              .find((action) => action.kind === "discard");
            assert.ok(discard, "Seed recovery must offer explicit discard");
            accepted(await detail.bridge.act({ itemId: entry.item.id, optionId: discard.id }));
          }
          assert.equal(input.host.recovery.snapshot().items.length, 0);
        };
        const producers: Record<FoundationCase, () => Promise<CaseEvidence>> = {
          retirement: () => produceRetirement(input),
          "healthy-release": () => produceHealthyRelease(input),
          contention: () =>
            produceContention({
              ...input,
              scope,
              reserveRecording: () => reserveLiveRecording(input),
              form: contentionForm,
              winner: {
                prepare: prepareWinner,
                edit: () => winnerControls!.form.edit(),
                submit: () => winnerControls!.form.submit(),
                observe: () => winnerControls!.form.observe(),
              },
              checkpoint: (reservation, whilePaused) =>
                registerContentionCheckpoint(input, reservation, whilePaused),
            }),
          "registration-end": () => produceRegistrationEnd(input),
          "disconnect-retry": () =>
            produceDisconnectRetry({
              ...input,
              lifecycle: desktopLifecycle(live),
              actions: coreActions,
              channel: handles
                .channels()
                .find((row) => row.context.owner.sourceKey === "builtin:acceptance.ui-recording")!
                .context,
              provider: admittedProvider,
              providerControl,
              journal,
              scope,
              reserveRecording: () => reserveLiveRecording(input),
              checkpoint: (reservation) =>
                registerContentionCheckpoint(input, reservation, async () => {}),
              disconnect: (sessionId) =>
                trustedDeviceActions(
                  live.foundation.broker,
                  desktopLifecycle(live),
                  coreActions,
                ).trustedCoreDisconnect(sessionId, authority.core(win.webContents.id, "recovery")),
              retry: async (id) => {
                // Original composition's trusted recovery bridge owns option lookup,
                // fresh ledger mint/claim and actual participant retry dispatch.
                const detail = live.plugins.persistence170!.detail;
                for (const entry of detail.entries()) {
                  const snapshot = await detail.bridge.snapshot({ itemId: entry.item.id });
                  if (!snapshot.ok) continue;
                  const item = snapshot.value.items.find((row) => row.id === id);
                  const option = item?.actions.find((row) => row.kind === "retry");
                  if (!option) continue;
                  const result = await detail.bridge.act({
                    itemId: entry.item.id,
                    optionId: option.id,
                  });
                  assert.ok(result.ok, JSON.stringify(result));
                  return;
                }
                throw new Error("Original recovery bridge has no Retry option for failed final");
              },
            }),
          "suspend-wake": () =>
            produceSuspendWake({
              ...input,
              lifecycle: desktopLifecycle(live),
              channel: handles
                .channels()
                .find((row) => row.context.owner.sourceKey === "builtin:acceptance.ui-recording")!
                .context,
              provider: admittedProvider,
              providerControl,
              scope,
              reserveRecording: () => reserveLiveRecording(input),
              checkpoint: (reservation) =>
                registerContentionCheckpoint(input, reservation, async () => {}),
              command: async () => {
                const result = await live.plugins.execute("acceptance.ui-recording.legacy");
                assert.equal(result.ok, true, JSON.stringify(result));
              },
            }),
          "renderer-loss": () =>
            produceRendererLoss({
              ...input,
              scope,
              ui: ui.bridge,
              actions: ui.actions,
              seed: async () => {
                assert.equal(
                  (await live.plugins.execute("acceptance.ui-recording.renderer-seed")).ok,
                  true,
                );
              },
              launches: () => rendererLaunches,
              owners: () => [...handles.runtime.owners()],
              crash: crashRenderer,
              restart: async () => {
                // Explicit reopen restores trusted core scope before resolving fixture recovery.
                await win.loadURL(config.rendererUrl);
                rendererReopened = true;
                if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach("1.3");
                await finishRecovery();
                const command = "acceptance.ui-recording.legacy";
                const result = await live.plugins.execute(command);
                assert.equal(result.ok, true, JSON.stringify(result));
                const context = await handles.runtime.activateInitialized(
                  "builtin:acceptance.ui-recording",
                  new AbortController().signal,
                );
                await handles.runtime.ready(context.owner, new AbortController().signal);
                const next = select("recording");
                const exited = latch<ProcessExit>();
                off.push(next.child.onExit((event) => exited.resolve(event)));
                consumerExits.push(exited.promise);
                const principal = next.principal();
                assert.equal(principal.kind, "plugin");
                if (principal.kind !== "plugin") throw new Error("Missing replacement principal");
                return { owner: principal.owner, principal, command, result };
              },
            }),
          "sealed-ttl": () =>
            produceSealedTtl({
              ...input,
              channel: handles
                .channels()
                .find((row) => row.context.owner.sourceKey === "builtin:acceptance.ui-recording")!
                .context,
              command: async (step, signal) => {
                signal.throwIfAborted();
                const result = await live.plugins.execute(`acceptance.ui-recording.ttl-${step}`);
                assert.equal(result.ok, true, JSON.stringify(result));
                signal.throwIfAborted();
              },
              discard: async (id) => {
                const detail = live.plugins.persistence170!.detail;
                for (const entry of detail.entries()) {
                  const snapshot = await detail.bridge.snapshot({ itemId: entry.item.id });
                  if (!snapshot.ok) continue;
                  const option = snapshot.value.items
                    .find((row) => row.id === id)
                    ?.actions.find((row) => row.kind === "discard");
                  if (!option) continue;
                  const result = await detail.bridge.act({
                    itemId: entry.item.id,
                    optionId: option.id,
                  });
                  assert.equal(result.ok, true, JSON.stringify(result));
                  return;
                }
                throw new Error("Original recovery bridge has no exact Discard option");
              },
              retry: async (id) => {
                // Original composition's trusted recovery bridge owns option lookup,
                // fresh ledger mint/claim and actual participant retry dispatch.
                const detail = live.plugins.persistence170!.detail;
                for (const entry of detail.entries()) {
                  const snapshot = await detail.bridge.snapshot({ itemId: entry.item.id });
                  if (!snapshot.ok) continue;
                  const item = snapshot.value.items.find((row) => row.id === id);
                  const option = item?.actions.find((row) => row.kind === "retry");
                  if (!option) continue;
                  const result = await detail.bridge.act({
                    itemId: entry.item.id,
                    optionId: option.id,
                  });
                  assert.ok(result.ok, JSON.stringify(result));
                  return;
                }
                throw new Error("Original recovery bridge has no Retry option for failed final");
              },
            }),
          "unknown-publication": () =>
            produceUnknownPublication({
              ...input,
              profilePath: userData,
              scope,
              channel: handles
                .channels()
                .find((row) => row.context.owner.sourceKey === "builtin:acceptance.ui-recording")!
                .context,
              command: async (step) => {
                const result = await live.plugins.execute(
                  `acceptance.ui-recording.unknown-${step}`,
                );
                assert.equal(result.ok, true, JSON.stringify(result));
              },
              reenable: async () => {
                // Enable alone keeps the source generation. Explicitly reload the
                // retired source before testing old-generation publication rights.
                const reloaded = await live.plugins.reload("builtin:acceptance.ui-recording");
                assert.equal(reloaded.ok, true, JSON.stringify(reloaded));
                const activated = await live.plugins.execute("acceptance.ui-recording.legacy");
                assert.equal(activated.ok, true, JSON.stringify(activated));
                const context = await handles.runtime.activateInitialized(
                  "builtin:acceptance.ui-recording",
                  new AbortController().signal,
                );
                await handles.runtime.ready(context.owner, new AbortController().signal);
                const next = select("recording");
                const observed = latch<ProcessExit>();
                off.push(next.child.onExit((exit) => observed.resolve(exit)));
                consumerExits.push(observed.promise);
                const principal = next.principal();
                assert.equal(principal.kind, "plugin");
                if (principal.kind !== "plugin") throw new Error("Missing replacement principal");
                return principal.owner;
              },
            }),
          "all-optional-off": () => {
            assert.ok(optional && optionalPolicy);
            return produceOptionalOff({
              config,
              plugins: live.plugins,
              input,
              activateRecording: () => activateRole("recording"),
              monitor: optional,
              policy: optionalPolicy,
              scope,
              browser,
              native: nativeActions,
              channels: handles.channels,
              coreActions,
              runtime: handles.runtime,
            });
          },
          "action-replay": () =>
            produceActionReplay({
              ...input,
              profilePath: userData,
              scope,
              ui: ui.bridge,
              actions: coreActions,
              featureActions: ui.actions,
              native: nativeActions,
              command: async (step) => {
                const result = await live.plugins.execute(`acceptance.ui-recording.action-${step}`);
                assert.equal(result.ok, true, JSON.stringify(result));
              },
              prepareCore: async () => {
                const reservation = await reserveLiveRecording(input);
                const checkpoint = await registerContentionCheckpoint(
                  input,
                  reservation,
                  async () => {},
                );
                const seeded = await live.plugins.execute(
                  "acceptance.ui-recording.action-checkpoint-only",
                );
                assert.equal(seeded.ok, true, JSON.stringify(seeded));
                let drainResolve!: () => void;
                let drainReject!: (error: unknown) => void;
                const drained = new Promise<void>((resolve, reject) => {
                  drainResolve = resolve;
                  drainReject = reject;
                });
                void drained.catch(() => {});
                const originalDrain = input.host.participant.drain;
                input.host.participant.drain = function (...args) {
                  const result = originalDrain.apply(this, args);
                  void result.then((report) => {
                    if (report.state === "checkpoint-only" && report.recovery) drainResolve();
                    else drainReject(new Error(`Core export seed drain: ${report.state}`));
                  }, drainReject);
                  return result;
                };
                try {
                  accepted(
                    await input.broker.request(
                      input.recording.principal(),
                      "devices/recording/release",
                      { reservationId: reservation.reservationId },
                      new AbortController().signal,
                    ),
                  );
                  await within(drained, "Core export seed drain");
                  const retained = input.host.recovery.snapshot().items;
                  assert.equal(retained.length, 1, "Expected only the seeded recovery");
                  assert.equal(retained[0]!.recordId, checkpoint.record.id);
                  assert.equal(retained[0]!.committedRevision, checkpoint.record.revision);
                  assert.equal(retained[0]!.payload, "checkpoint-only");
                  assert.ok(retained[0]!.actions.some((action) => action.kind === "export"));
                } finally {
                  input.host.participant.drain = originalDrain;
                }
              },
              coreExport: async () => {
                const detail = live.plugins.persistence170!.detail;
                for (const entry of detail.entries()) {
                  const snapshot = await detail.bridge.snapshot({ itemId: entry.item.id });
                  if (!snapshot.ok) continue;
                  const option = snapshot.value.items
                    .flatMap((item) => item.actions)
                    .find((action) => action.kind === "export");
                  if (option) {
                    const result = await detail.bridge.act({
                      itemId: entry.item.id,
                      optionId: option.id,
                    });
                    assert.equal(result.ok, true, JSON.stringify(result));
                    return result;
                  }
                }
                throw new Error("Actual recovery bridge offered no export");
              },
              finishCore: finishRecovery,
              destroyRenderer: () => crashRenderer(),
            }),
          "import-restart": unavailable("import-restart"),
          "storage-ui-pressure": unavailable("storage-ui-pressure"),
          compatibility: async () => {
            assert.ok(compatibility && config.compatibility);
            return compatibility.run(config.compatibility, live.plugins, handles.host.participant);
          },
          installed: unavailable("installed"),
        };
        assert.deepEqual(Object.keys(producers).sort(), [...FOUNDATION_CASES].sort());
        let closing: Promise<void> | undefined,
          ran = false,
          destroying = false;
        const close = (): Promise<void> =>
          (closing ??= (async () => {
            await live.dispose();
            await within(Promise.all(consumerExits), "original consumer exits during close");
            if (!rendererExit || rendererReopened) {
              await browser("window.declarativeAcceptance.disposeFoundationRenderer()");
              const finalBrowser = await browser(
                "window.declarativeAcceptance.foundationDiagnostics()",
              );
              assertZeroCounters(finalBrowser.snapshot);
            } else {
              assert.notEqual(rendererExit.reason, "pending");
              assert.ok(rendererExit.at > 0 && rendererExit.pid > 0);
            }
            if (winnerControls) {
              const final = await winnerControls.browser(
                "window.declarativeAcceptance.disposeFoundationRenderer()",
              );
              assertZeroCounters(final.snapshot);
            }
            const finalSnapshots = snapshots();
            if (finalSnapshots.some((snapshot) => snapshot.owners !== 0)) {
              const { writeFile } = await import("node:fs/promises");
              await writeFile(
                path.join(userData, "foundation-close-observation.json"),
                JSON.stringify({
                  snapshots: finalSnapshots,
                  recovery: handles.host.participant.recoverySnapshot(),
                  failures,
                }),
                { flag: "wx" },
              );
            }
            for (const snapshot of finalSnapshots) assertZeroCounters(snapshot);
            assert.equal(persistenceWorkerCount(handles.backend), 0);
            assert.equal(listeners, 0);
            assert.deepEqual(failures, [], "Cleanup/lifecycle failures");
            for (const unsubscribe of off.splice(0)) unsubscribe();
            for (const name of ipcNames.splice(0)) ipcMain.removeHandler(name);
            restoreReservation();
            optional?.restore();
            if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
            destroying = true;
            win.destroy();
            if (second && !second.isDestroyed()) second.destroy();
          })());
        win.on("close", (event) => {
          if (destroying) return;
          event.preventDefault();
          void close().catch(report);
        });
        fixture = {
          composition: {
            profile: handles.profile,
            journalProfile,
            persistenceProfile: handles.persistenceProfile,
            get workerCount() {
              return persistenceWorkerCount(handles.backend);
            },
            get reservationListenerCount() {
              return listeners;
            },
            host: handles.host,
            stage3: live.stage3,
          },
          environment: {
            commit: config.commit,
            artifact: config.artifact,
            artifactSha256: config.artifactSha256,
            os: os.release(),
            architecture: process.arch,
            cpu: os.cpus()[0]?.model ?? "unknown",
            ramBytes: os.totalmem(),
            filesystem: config.filesystem,
            node: process.versions.node,
            electron: process.versions.electron ?? "",
            memoryMethod: [
              "registration-end",
              "contention",
              "suspend-wake",
              "disconnect-retry",
              "sealed-ttl",
              "unknown-publication",
              "action-replay",
              "renderer-loss",
              "all-optional-off",
            ].includes(config.case)
              ? "not-measured-scoped-case"
              : "not-measured-reference-only",
            warmCold: "cold",
          },
          async runCase(id) {
            assert.equal(ran, false, "One case per process");
            assert.equal(id, config.case);
            assert.equal(closing, undefined);
            ran = true;
            assertRealComposition(fixture!);
            let evidence: CaseEvidence;
            try {
              evidence = await producers[id]();
            } catch (error) {
              if (
                (id === "sealed-ttl" || id === "all-optional-off") &&
                error instanceof Error &&
                error.cause
              )
                await writeFile(
                  path.join(userData, `${id}-failure-observation.json`),
                  JSON.stringify(error.cause, null, 2),
                );
              throw error;
            }
            if (id === "all-optional-off" && config.optionalPhase !== "cold")
              assertOptionalPhase(evidence.optionalPhase!);
            else assertFoundationEvidence(id, evidence);
            return evidence;
          },
          async finishObservation(evidence) {
            if (!optional) return;
            const p = evidence.optionalPhase ?? evidence.optionalOff!.cold;
            p.observation = await optional.finish(config);
            p.ended = Date.now();
            assertOptionalPhase(p);
          },
          close,
        };
        assertRealComposition(fixture);
      } catch (error) {
        // Composition owns its allocations; the shell only disposes a returned composition.
        // Never dispose the backend independently or reacquire/release the primary lock.
        if (composition)
          try {
            await composition.dispose();
          } catch (cleanup) {
            failures.push(cleanup);
          }
        for (const unsubscribe of off.splice(0)) unsubscribe();
        for (const name of ipcNames.splice(0)) ipcMain.removeHandler(name);
        restoreReservation();
        pressureQueue?.restore();
        if (!win.isDestroyed()) win.destroy();
        if (second && !second.isDestroyed()) second.destroy();
        if (failures.length)
          throw new AggregateError([error, ...failures], "Foundation construction/cleanup failed");
        throw error;
      }
    },
    () => {
      if (!window || window.isDestroyed()) return false;
      window.focus();
      return true;
    },
  );
  if (!primary) throw new Error("BLOCKED: primary profile already held");
  await primary.ready;
  primary.windowReady();
  assert.ok(fixture);
  return fixture;
}
function assertZeroCounters(snapshot: FoundationCounters): void {
  const keys = [
    "owners",
    "bindings",
    "subscriptions",
    "queuedEvents",
    "queuedBytes",
    "timers",
    "pendingInvocations",
    "actionTokens",
    "resourceReaders",
    "workerJobs",
  ] as const;
  for (const key of keys) assert.equal(snapshot[key], 0, `Leaked ${key}`);
}

// Actual whole-process termination only after a real boundary acknowledgement.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
export async function terminateAtBoundary(
  child: ChildProcess,
  evidence: { pid: number; paused: boolean; point: string },
) {
  assert.ok(Number.isSafeInteger(child.pid) && child.pid! > 0);
  assert.equal(evidence.pid, child.pid);
  assert.equal(evidence.paused, true);
  assert.ok(evidence.point.length > 0);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = once(child, "exit");
  // Attach an immediate handler even if taskkill fails before waiting for child exit.
  void exited.catch(() => {});
  try {
    let platformTermination: string | undefined;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      const result = await within(once(killer, "exit"), "taskkill exit");
      assert.equal(result[0], 0);
      platformTermination = "taskkill-/T-/F";
    } else assert.equal(child.kill("SIGKILL"), true);
    const [exitCode, signal] = await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Killed child did not exit within 5 seconds")),
          5000,
        );
      }),
    ]);
    assert.notEqual(exitCode, 0);
    return {
      pid: child.pid,
      point: evidence.point,
      pauseAcknowledged: true,
      exitCode,
      signal,
      ...(platformTermination ? { platformTermination } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}
