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

export type CaseEvidence = {
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
] as const satisfies readonly FoundationCase[];
export const FOUNDATION_CHECKS: Readonly<
  Record<
    FoundationCase,
    {
      checks: readonly string[];
      events: readonly string[];
      samples: readonly string[];
    }
  >
> = {
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

import assert from "node:assert/strict";
// @ts-expect-error The test-local Node harness has no TypeScript declaration.
import { assertRegistrationEndEvidence } from "./plugin-persistence-harness.mjs";
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
  if (id === "healthy-release") {
    for (const key of ["retireCalls", "freezeCalls", "processExits"])
      assert.equal(evidence.checks[key], 0, key);
    assert.equal(evidence.checks.unrelatedSettingsCommitted, true);
    assert.equal(evidence.checks.generationBefore, evidence.checks.generationAfter);
  }
  for (const key of Object.keys(evidence.samples))
    assert.ok(required.samples.includes(key), `${id}: undeclared sample ${key}`);
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
type LifecycleCaseInput = {
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
    reserve = engine.reserve,
    reserveFinal = engine.reserveFinal;
  assert.ok(reserveFinal, "Missing actual final admission port");
  const tickets: PublicationTicket[] = [],
    finalTickets: PublicationTicket[] = [];
  const offers: DrainOffer[] = [],
    requests: DrainRequest[] = [];
  const submissions: NonNullable<CaseEvidence["registration"]>["submissions"] = [];
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
  engine.reserveFinal = function (ticket, size, grant) {
    if (sameExecution(ticket.owner, owner)) finalTickets.push(structuredClone(ticket));
    return reserveFinal.call(this, ticket, size, grant);
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
      return dispatch(target, request, ...rest).then((result) => {
        submissions.push(structuredClone(result));
        return result;
      });
    });
    draining = result.then((report) => {
      assert.equal(report.state, "saved");
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
      engine.reserveFinal = reserveFinal;
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
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
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

let factoryAttempted = false;
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
  if (!["retirement", "healthy-release", "registration-end"].includes(config.case))
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
    desktopFoundationTestHandles,
    desktopDeviceAccess,
  } = await import("../../apps/desktop/src/main/plugins/controller.js");
  const { registerCoreRecoveryIpc } = await import("../../apps/desktop/src/main/plugins/ipc.js");
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
      const authority = new AuthorityContexts(profile.hostEpoch);
      const openDocument = () => {
        const document = authority.open(win.webContents.id);
        authority.report(win.webContents.id, {
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
      openDocument();
      // Each actual top-level navigation receives a new main-owned document scope.
      // No renderer-supplied authority or stale initial about:blank scope is reused.
      win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) {
          authority.invalidate(win.webContents.id);
          openDocument();
        }
      });
      const scope = () => {
        const p = authority.core(win.webContents.id, "recovery");
        return { hostEpoch: p.hostEpoch, workbenchInstance: p.workbenchInstance };
      };
      const currentScope: DesktopMainCompositionInput["currentScope"] = (candidate) => {
        if (win.isDestroyed()) return false;
        const current = scope();
        return (
          current.hostEpoch === candidate.hostEpoch &&
          current.workbenchInstance === candidate.workbenchInstance
        );
      };
      const coreActions = createCoreActionLedger({ now, current: currentScope });
      const journalProfile = profile,
        journal = createJournal(createJournalFilesystem(userData), journalProfile);
      let composition: DesktopMainComposition | undefined;
      let listeners = 0,
        fake: FakeProviderControl | undefined,
        fault: PersistenceFaultControl | undefined;
      let restoreReservation = () => {};
      const ipcNames: string[] = [],
        off: Array<() => void> = [],
        failures: unknown[] = [];
      const report = (error: unknown) => {
        failures.push(error);
      };
      const acceptanceFoundation = async (
        options: DesktopFoundationOptions,
      ): Promise<DesktopFoundation> => {
        const foundation = await createDesktopFoundation({
          ...options,
          providerFactory(catalog) {
            const created = createFakeDeviceProvider({ catalog, now: options.now });
            fake = created.control;
            return created.provider;
          },
        });
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
        const builtins = [...BUILTIN_PLUGIN_SOURCES];
        for (const role of ["recording", "settings"]) {
          const pluginId = `acceptance.ui-${role}`,
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
        const compositionInput: DesktopMainCompositionInput = {
          createFoundation: acceptanceFoundation,
          foundationOptions: {
            profile,
            authority,
            journal,
            coreActions,
            now,
            hasPermission: (principal, permission) =>
              principal.kind === "plugin" &&
              !!composition &&
              desktopDeviceAccess(composition.plugins).hasPermission(principal.owner, permission),
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
            userData,
            builtins,
            commandLine: { developmentDirectories: [], safeMode: false },
            locale: "en",
            dialogs: {
              confirmDeveloperMode: async () => true,
              chooseFolder: async () => undefined,
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
          worker: {
            entry: config.workerEntry,
            control(control: PersistenceFaultControl) {
              assert.equal(fault, undefined);
              fault = control;
            },
          },
        });
        assert.ok(composition);
        const live = composition,
          handles = desktopFoundationTestHandles(live),
          ui = desktopUi(live);
        assert.ok(fake, "Missing actual provider callback");
        assert.ok(fault, "Missing actual worker control");
        assert.equal(handles.recovery, "ready");
        assert.equal(live.stage3.persistence, handles.host.participant);
        assert.equal(handles.profile, profile);
        assert.equal(handles.persistenceProfile, profile);
        const trusted = (event: { sender: { id: number }; senderFrame: unknown }) =>
          !win.isDestroyed() &&
          event.sender.id === win.webContents.id &&
          event.senderFrame === win.webContents.mainFrame;
        const handle: IpcHandle = (name, action) => {
          ipcNames.push(name);
          ipcMain.handle(name, (event, ...args) => {
            if (!trusted(event)) throw new Error("Untrusted acceptance sender");
            return Reflect.apply(action, undefined, [event, ...args]);
          });
        };
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
        win.webContents.on("render-process-gone", () => {
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
            handle,
            facets,
            coreRecovery: recovery,
            renderer: () => (win.isDestroyed() ? undefined : win.webContents),
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
        await win.loadURL(config.rendererUrl);
        win.webContents.debugger.attach("1.3");
        const browser = async (expression: string) => {
          const result = await win.webContents.debugger.sendCommand("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
          });
          assert.equal(result.exceptionDetails, undefined, "Browser collector failed");
          return result.result.value;
        };
        await browser("window.declarativeAcceptance.foundationDiagnostics()");
        for (const role of ["recording", "settings"]) {
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
        }
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
        const input: LifecycleCaseInput = {
          now,
          broker: live.foundation.broker,
          host: handles.host,
          stage3: live.stage3,
          plugins: live.plugins,
          fault,
          backend: handles.backend,
          recording: select("recording"),
          settings: select("settings"),
        };
        const consumerExits = [input.recording, input.settings].map((consumer) => {
          const observed = latch<ProcessExit>();
          off.push(consumer.child.onExit((exit) => observed.resolve(exit)));
          return observed.promise;
        });
        const unavailable = (id: FoundationCase) => async (): Promise<CaseEvidence> => {
          throw new Error(`BLOCKED: ${id} observation-table producer is not implemented`);
        };
        const producers: Record<FoundationCase, () => Promise<CaseEvidence>> = {
          retirement: () => produceRetirement(input),
          "healthy-release": () => produceHealthyRelease(input),
          contention: unavailable("contention"),
          "registration-end": () => produceRegistrationEnd(input),
          "disconnect-retry": unavailable("disconnect-retry"),
          "suspend-wake": unavailable("suspend-wake"),
          "renderer-loss": unavailable("renderer-loss"),
          "sealed-ttl": unavailable("sealed-ttl"),
          "unknown-publication": unavailable("unknown-publication"),
          "all-optional-off": unavailable("all-optional-off"),
          "action-replay": unavailable("action-replay"),
          "import-restart": unavailable("import-restart"),
          "storage-ui-pressure": unavailable("storage-ui-pressure"),
          compatibility: unavailable("compatibility"),
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
            await browser("window.declarativeAcceptance.disposeFoundationRenderer()");
            const finalBrowser = await browser(
              "window.declarativeAcceptance.foundationDiagnostics()",
            );
            assertZeroCounters(finalBrowser.snapshot);
            for (const snapshot of snapshots()) assertZeroCounters(snapshot);
            assert.equal(persistenceWorkerCount(handles.backend), 0);
            assert.equal(listeners, 0);
            assert.deepEqual(failures, [], "Cleanup/lifecycle failures");
            for (const unsubscribe of off.splice(0)) unsubscribe();
            for (const name of ipcNames.splice(0)) ipcMain.removeHandler(name);
            restoreReservation();
            win.webContents.debugger.detach();
            destroying = true;
            win.destroy();
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
            memoryMethod:
              config.case === "registration-end"
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
            const evidence = await producers[id]();
            assertFoundationEvidence(id, evidence);
            return evidence;
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
        if (!win.isDestroyed()) win.destroy();
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
