import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import type {
  ResourceOwner,
  ReservationSnapshot,
  SettingsRequestMap,
  SettingsSnapshot,
  MotionSnapshot,
  DrainRequest,
  StorageRequestMap,
} from "@kobrixa/plugin-protocol";
import type {
  CoreWindowScope,
  SettingsFormBinding,
  DrainReport,
  DrainOffer,
  ReservationEnded,
} from "@kobrixa/plugin-runtime";
import type { CaseEvidence, LifecycleCaseInput } from "./plugin-persistence-main.js";

import type {
  PublicationTicket,
  CheckpointRegistration,
  PersistenceEnginePort,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { RecordMeta, Receipt } from "@kobrixa/plugin-protocol";
export type ContentionCheckpoint = {
  pause: {
    document: CheckpointRegistration;
    ticket: PublicationTicket;
    pausedAt: number;
    releasedAt: number;
    traceBeforeRelease: ReturnType<LifecycleCaseInput["fault"]["trace"]>;
    traceAfterRelease: ReturnType<LifecycleCaseInput["fault"]["trace"]>;
  };
  recordOutcome: Awaited<ReturnType<PersistenceEnginePort["reconcile"]>>;
  recoveryOutcome: Awaited<ReturnType<PersistenceEnginePort["reconcile"]>>;
  record: RecordMeta;
  receipt: Receipt<string>;
  recordTicket: PublicationTicket;
  payloadBase64: string;
  checkpoint: string;
  document: CheckpointRegistration;
  publication: {
    ticket: PublicationTicket;
    result: Awaited<ReturnType<PersistenceEnginePort["publish"]>>;
  };
};
type UpdateParams = SettingsRequestMap["settings/update"]["params"];
type UpdateResult = SettingsRequestMap["settings/update"]["result"];
export type ContentionForm = {
  binding: SettingsFormBinding;
  raw: Record<string, string>;
  state: {
    baseline: SettingsSnapshot;
    draft: SettingsSnapshot["values"];
    busyKeys: string[];
    errors: { key: string }[];
  };
  fieldIds: Record<string, string>;
  input: { id: string; value: string };
  inputEvents: { id: string; type: string; trusted: boolean; key: string | null; value: string }[];
};
export type ContentionObservation = {
  checkpoint: ContentionCheckpoint;
  finalRecord: RecordMeta;
  finalDrain: {
    request: DrainRequest;
    report: DrainReport;
    offer: DrainOffer;
    ended: ReservationEnded;
    deadline: number;
    dispatchedAt: number;
  };
  finalPublication: ContentionCheckpoint["publication"];
  finalWrites: {
    owner: ResourceOwner;
    params: StorageRequestMap["storage/beginWrite"]["params"];
    result: StorageRequestMap["storage/beginWrite"]["result"];
  }[];
  winnerBefore: ContentionForm;
  winnerAfter: ContentionForm;
  owners: ResourceOwner[];
  sessionId: string;
  motionProbes: {
    startedAt: number;
    endedAt: number;
    owner: ResourceOwner;
    result: unknown;
    before: ReservationSnapshot;
    after: ReservationSnapshot;
  }[];
  recordingProbes: {
    owner: ResourceOwner;
    result: unknown;
    before: MotionSnapshot;
    after: MotionSnapshot;
  }[];
  released: ReservationSnapshot;
  stopped: MotionSnapshot;
  updates: {
    caller: "winner" | "form";
    binding: SettingsFormBinding;
    params: UpdateParams;
    result: UpdateResult;
  }[];
  beforeForm: ContentionForm;
  afterForm: ContentionForm;
  persisted: SettingsSnapshot;
  blockedSave: {
    pausedAt: number;
    stopRequestedAt: number;
    stopConfirmedAt: number;
    saveReleasedAt: number;
    writeSettledAtStop: boolean;
    motionDuringSave: MotionSnapshot;
    pausedTicket: string;
    expectedTicket: PublicationTicket;
    traceBeforeRelease: ReturnType<LifecycleCaseInput["fault"]["trace"]>;
    traceAfterRelease: ReturnType<LifecycleCaseInput["fault"]["trace"]>;
  };
};
type Input = LifecycleCaseInput & {
  scope(): CoreWindowScope;
  reserveRecording(): Promise<ReservationSnapshot>;
  checkpoint(
    reservation: ReservationSnapshot,
    whilePaused: () => Promise<void>,
  ): Promise<ContentionCheckpoint>;
  winner: Input["form"];
  form: {
    prepare(): Promise<ContentionForm>;
    edit(): Promise<ContentionForm>;
    submit(): Promise<void>;
    observe(): Promise<ContentionForm>;
  };
};
function value<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) throw new Error("Live contention operation failed");
  return result.value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    }),
    resolve: (value: T) => resolve(value),
    reject: (error: unknown) => reject(error),
  };
}
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const observed = await read();
    if (done(observed)) return observed;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out observing live contention state");
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Missing live contention observation")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const activeMotion = (operation: MotionSnapshot) =>
  ["preparing", "prepared", "running", "stopping"].includes(operation.phase);

// Host-side admission probes exercise the actual broker/participant. They are not
// claimed as public SDK transport or generic-UI intent provenance (separate gates).
export async function produceContention(input: Input): Promise<CaseEvidence> {
  const principals = [input.recording.principal(), input.settings.principal()];
  const owners = principals.map((principal) => {
    assert.equal(principal.kind, "plugin");
    if (principal.kind !== "plugin") throw new Error("Missing admitted plugin");
    assert.ok(principal.authorityContext);
    return principal.owner;
  });
  assert.notDeepEqual(owners[0], owners[1]);
  const signal = new AbortController().signal;
  const reservation = await input.reserveRecording();
  const reservations = [{ index: 0, id: reservation.reservationId }];
  const scopes: ReturnType<Input["broker"]["intent"]["bindMotionScope"]>[] = [];
  const operations: { index: number; id: string }[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let failure: unknown;
  let failed = false;
  let evidence: CaseEvidence | undefined;
  const cleanupErrors: unknown[] = [];
  try {
    // Listing is the broker's real session admission for each execution owner.
    // Knowing another owner's session ID does not grant access to that session.
    for (const principal of principals) {
      const inventory = value(await input.broker.request(principal, "devices/list", {}, signal));
      assert.ok(
        inventory.sessions.some(
          (row) => row.sessionId === reservation.sessionId && row.state === "connected",
        ),
      );
    }
    const session = value(
      await input.broker.request(
        principals[0]!,
        "devices/session",
        { sessionId: reservation.sessionId },
        signal,
      ),
    );
    const actuator = session.sources.actuators.find((row) => row.state === "ready");
    assert.ok(actuator, "Missing actual fake-provider actuator");
    for (const [index, principal] of principals.entries()) {
      scopes.push(
        input.broker.intent.bindMotionScope({
          owner: owners[index]!,
          contextRef: principal.authorityContext!.ref,
          panelInstance: randomUUID(),
          uiResourceGeneration: 0,
          workbenchInstance: input.scope().workbenchInstance,
        }),
      );
    }
    let sequence = 0;
    const pulse = () => {
      for (const scope of scopes) input.broker.intent.pulsePanel(scope, ++sequence);
    };
    pulse();
    heartbeat = setInterval(pulse, 100);
    const motionProbes: ContentionObservation["motionProbes"] = [];
    const recordingProbes: ContentionObservation["recordingProbes"] = [];
    const queryReservation = async () =>
      value(
        await input.broker.request(
          principals[0]!,
          "devices/recording/query",
          { reservationId: reservation.reservationId },
          signal,
        ),
      ).reservation;
    const queryMotion = async (id: string) =>
      value(
        await input.broker.request(
          principals[1]!,
          "devices/motion/query",
          { operationId: id },
          signal,
        ),
      ).operation;
    const prepare = (index: number) =>
      input.broker.request(
        principals[index]!,
        "devices/motion/prepare",
        {
          sessionId: reservation.sessionId,
          contextRef: principals[index]!.authorityContext!.ref,
          motionScopeRef: scopes[index]!,
          motion: {
            actuatorId: actuator.actuatorId,
            mode: "timed",
            power: 1,
            direction: 1,
            brake: true,
            durationMs: 5000,
          },
        },
        signal,
      );
    const checkpoint = await input.checkpoint(reservation, async () => {
      for (const index of [0, 1]) {
        const startedAt = input.now();
        const before = await queryReservation();
        const result = await prepare(index);
        if (result.ok) operations.push({ index, id: result.value.operation.operationId });
        const after = await queryReservation();
        motionProbes.push({
          startedAt,
          endedAt: input.now(),
          owner: owners[index]!,
          result,
          before,
          after,
        });
        assert.equal(result.ok, false, "Motion admitted during recording");
        if (!result.ok)
          assert.equal(result.error.code, "PLUGIN_E_DEVICE_BUSY", JSON.stringify(result.error));
      }
    });
    let winnerBefore = await input.winner.prepare();
    let beforeForm = await input.form.prepare();
    assert.notEqual(
      winnerBefore.binding.scope.workbenchInstance,
      beforeForm.binding.scope.workbenchInstance,
    );
    assert.equal(winnerBefore.state.baseline.revision, beforeForm.state.baseline.revision);
    assert.equal(beforeForm.binding.owner.sourceKey, owners[1]!.sourceKey);
    const initial = value(
      await input.host.request(principals[1]!, "settings/read", { schemaVersion: 1 }, signal),
    );
    assert.equal(initial.revision, beforeForm.state.baseline.revision);
    assert.equal(
      value(await input.host.settings.read(winnerBefore.binding)).revision,
      initial.revision,
    );
    assert.equal(
      value(await input.host.settings.read(beforeForm.binding)).revision,
      initial.revision,
    );
    const participant = input.host.participant,
      drain = participant.drain;
    const drained = deferred<ContentionObservation["finalDrain"]>();
    void drained.promise.catch(() => {});
    const endReservation = participant.endReservation;
    let ended: ReservationEnded | undefined;
    let deadline: number | undefined;
    participant.endReservation = function (event, bound) {
      if (event.reservationId === reservation.reservationId) {
        ended = structuredClone(event);
        deadline = bound;
      }
      return endReservation.call(this, event, bound);
    };
    participant.drain = function (offer, dispatch) {
      if (offer.owner.sourceKey !== owners[0]!.sourceKey) return drain.call(this, offer, dispatch);
      let request: DrainRequest | undefined;
      let dispatchedAt = 0;
      const result = drain.call(
        this,
        offer,
        dispatch &&
          ((owner, original, ...rest) => {
            dispatchedAt = input.now();
            request = structuredClone(original);
            return dispatch(owner, original, ...rest);
          }),
      );
      void result.then((report) => {
        if (!request || !ended || deadline === undefined) {
          drained.reject(new Error("Missing original SDK checkpoint drain"));
          return;
        }
        drained.resolve({
          request,
          report: structuredClone(report),
          offer: structuredClone(offer),
          ended,
          deadline,
          dispatchedAt,
        });
      }, drained.reject);
      return result;
    };
    const finalWrites: ContentionObservation["finalWrites"] = [];
    const originalRequest = input.host.request;
    input.host.request = new Proxy(originalRequest, {
      async apply(target, receiver, args) {
        const [principal, method, params] = args;
        const result = await Reflect.apply(target, receiver, args);
        if (
          method === "storage/beginWrite" &&
          principal.owner?.sourceKey === owners[0]!.sourceKey &&
          params.drainToken
        ) {
          assert.ok(result.ok, "Original SDK final write was rejected");
          finalWrites.push(
            structuredClone({ owner: principal.owner, params, result: result.value }),
          );
        }
        return result;
      },
    });
    let released: ReservationSnapshot;
    let finalDrain: ContentionObservation["finalDrain"];
    try {
      released = value(
        await input.broker.request(
          principals[0]!,
          "devices/recording/release",
          { reservationId: reservation.reservationId },
          signal,
        ),
      ).reservation;
      finalDrain = await bounded(drained.promise);
      assert.equal(finalDrain.report.state, "saved");
      assert.equal(finalDrain.report.blocker, false);
      assert.ok(
        finalDrain.request.checkpoints.some(
          (row) =>
            row.checkpoint === checkpoint.checkpoint && row.record.id === checkpoint.record.id,
        ),
      );
    } finally {
      participant.drain = drain;
      participant.endReservation = endReservation;
      input.host.request = originalRequest;
    }
    const finalRecord = value(
      await input.host.request(
        principals[0]!,
        "storage/stat",
        { id: checkpoint.record.id },
        signal,
      ),
    ).record;
    assert.equal(finalRecord.checkpoint, "final");
    const finalBarrier = input.backend.evidence.capture(
      { kind: "namespace", owner: owners[0]! },
      input.now() + 15000,
    );
    const finalTickets = input.backend.evidence
      .tickets(finalBarrier)
      .filter(
        (ticket) =>
          ticket.metadata.kind === "record" &&
          ticket.metadata.record.id === finalRecord.id &&
          ticket.metadata.record.revision === finalRecord.revision,
      );
    // Flush consumes the barrier. Retain its ticket snapshot before awaiting durability.
    assert.equal((await input.backend.evidence.flush(finalBarrier)).state, "saved");
    assert.equal(finalTickets.length, 1);
    const finalTicket = finalTickets[0]!;
    const finalPublication = {
      ticket: structuredClone(finalTicket),
      result: await input.backend.engine.reconcile(finalTicket),
    };
    const prepared = value(await prepare(1)).operation;
    operations.push({ index: 1, id: prepared.operationId });
    value(
      await input.broker.request(
        principals[1]!,
        "devices/motion/start",
        { operationId: prepared.operationId },
        signal,
      ),
    );
    await poll(
      () => queryMotion(prepared.operationId),
      (operation) => {
        assert.ok(activeMotion(operation), "Motion ended before contention probes");
        return operation.phase === "running";
      },
    );
    for (const index of [0, 1]) {
      const before = await queryMotion(prepared.operationId);
      const result = await input.broker.request(
        principals[index]!,
        "devices/recording/reserve",
        {
          sessionId: reservation.sessionId,
          channelIds: reservation.channels.map((row) => row.channelId),
          expectedSourceRevision: session.sources.sourceRevision,
        },
        signal,
      );
      if (result.ok) reservations.push({ index, id: result.value.reservation.reservationId });
      const after = await queryMotion(prepared.operationId);
      recordingProbes.push({ owner: owners[index]!, result, before, after });
      assert.equal(result.ok, false, "Recording admitted during motion");
      if (!result.ok)
        assert.equal(result.error.code, "PLUGIN_E_DEVICE_BUSY", JSON.stringify(result.error));
    }
    const updates: ContentionObservation["updates"] = [];
    const entered = deferred<UpdateParams>(),
      completed = deferred<UpdateResult>(),
      winning = deferred<UpdateResult>();
    void winning.promise.catch(() => {});
    void completed.promise.catch(() => {});
    const originalUpdate = input.host.settings.update;
    input.host.settings.update = function (binding, request) {
      const operation = originalUpdate.call(this, binding, request);
      if (binding.owner.sourceKey === owners[1]!.sourceKey) {
        const isWinner =
          binding.scope.workbenchInstance === winnerBefore.binding.scope.workbenchInstance;
        if (!isWinner) entered.resolve(structuredClone(request));
        void operation.then(
          (result) => {
            updates.push({
              caller: isWinner ? "winner" : "form",
              binding: structuredClone(binding),
              params: structuredClone(request),
              result,
            });
            (isWinner ? winning : completed).resolve(result);
          },
          (error) => {
            winning.reject(error);
            completed.reject(error);
          },
        );
      }
      return operation;
    };
    let first: Promise<UpdateResult> | undefined;
    let writeSettled = false;
    try {
      const priorBarrier = input.backend.evidence.capture(
        { kind: "namespace", owner: owners[1]! },
        input.now() + 15000,
      );
      const priorTickets = new Set(
        input.backend.evidence.tickets(priorBarrier).map((ticket) => ticket.id),
      );
      assert.equal((await input.backend.evidence.flush(priorBarrier)).state, "saved");
      const reached = input.fault.reached("before-publish");
      input.fault.arm("before-publish", "pause");
      first = winning.promise;
      // Native focus transfers commit edited fields on blur. Keep both mounts
      // clean until the original publication pause has been armed.
      winnerBefore = await input.winner.edit();
      await input.winner.submit();
      void first.then(
        () => {
          writeSettled = true;
        },
        () => {
          writeSettled = true;
        },
      );
      await bounded(reached);
      const pausedAt = input.now();
      const pausedTicket = input.fault
        .trace()
        .filter((row) => row.point === "before-publish")
        .at(-1)?.ticket;
      assert.ok(pausedTicket, "Paused write has no original ticket");
      const barrier = input.backend.evidence.capture(
        { kind: "namespace", owner: owners[1]! },
        input.now() + 15000,
      );
      const originalTickets = input.backend.evidence
        .tickets(barrier)
        .filter((ticket) => !priorTickets.has(ticket.id) && ticket.target.kind === "settings");
      assert.equal(originalTickets.length, 1, "Expected one original settings publication");
      const expectedTicket = originalTickets[0];
      assert.ok(expectedTicket, "Paused ticket is not an admitted settings write");
      assert.equal(
        pausedTicket,
        expectedTicket.id,
        "Unrelated publication paused instead of original settings ticket",
      );
      assert.equal(expectedTicket.target.kind, "settings");
      assert.equal(expectedTicket.metadata.kind, "settings");
      if (expectedTicket.target.kind === "settings")
        assert.equal(expectedTicket.target.expectedRevision, initial.revision);
      assert.deepEqual(expectedTicket.owner, owners[1]);
      beforeForm = await input.form.edit();
      await input.form.submit();
      const submitted = await bounded(entered.promise);
      assert.equal(
        submitted.expectedRevision,
        initial.revision,
        "Form used a renewed CAS revision",
      );
      const motionDuringSave = await queryMotion(prepared.operationId);
      assert.equal(motionDuringSave.phase, "running", "Motion ended before the blocked save");
      const stopRequestedAt = input.now();
      value(
        await input.broker.request(
          principals[1]!,
          "devices/motion/stop",
          { operationId: prepared.operationId, stopMode: "brake" },
          signal,
        ),
      );
      const stopped = await poll(
        () => queryMotion(prepared.operationId),
        (operation) => !activeMotion(operation),
      );
      const stopConfirmedAt = input.now();
      const writeSettledAtStop = writeSettled;
      const traceBeforeRelease = input.fault.trace();
      const published = input.fault.reached("after-publish");
      const saveReleasedAt = input.now();
      input.fault.release("before-publish");
      await bounded(first);
      await bounded(published);
      assert.equal((await input.backend.evidence.flush(barrier)).state, "saved");

      await bounded(completed.promise);
      const afterForm = await poll(
        input.form.observe,
        (form) =>
          !form.state.busyKeys.includes("fixture.note") &&
          form.state.errors.some((error) => error.key === "fixture.note"),
      );
      const persisted = value(
        await input.host.request(principals[1]!, "settings/read", { schemaVersion: 1 }, signal),
      );
      const winnerAfter = await input.winner.observe();
      const contention: ContentionObservation = {
        checkpoint,
        finalRecord,
        finalDrain,
        finalPublication,
        finalWrites,
        winnerBefore,
        winnerAfter,
        owners,
        sessionId: reservation.sessionId,
        motionProbes,
        recordingProbes,
        released,
        stopped,
        updates,
        beforeForm,
        afterForm,
        persisted,
        blockedSave: {
          pausedAt,
          stopRequestedAt,
          stopConfirmedAt,
          saveReleasedAt,
          writeSettledAtStop,
          motionDuringSave,
          pausedTicket,
          expectedTicket,
          traceBeforeRelease,
          traceAfterRelease: input.fault.trace(),
        },
      };
      evidence = {
        checks: {
          motionWhileRecording: motionProbes.every((row) => !(row.result as { ok: boolean }).ok)
            ? "busy"
            : "admitted",
          recordingWhileMotion: recordingProbes.every((row) => !(row.result as { ok: boolean }).ok)
            ? "busy"
            : "admitted",
          concurrentActive:
            motionProbes.filter(
              (row) => (row.result as { ok: boolean }).ok && row.before.state === "active",
            ).length +
            recordingProbes.filter(
              (row) => (row.result as { ok: boolean }).ok && activeMotion(row.before),
            ).length,
          settingsSuccess: updates.filter((row) => row.result.ok).length,
          settingsConflict: updates.filter(
            (row) => !row.result.ok && row.result.error.code === "PLUGIN_E_SETTINGS_CONFLICT",
          ).length,
          dirtyDraftPreserved:
            afterForm.raw["fixture.note"] === beforeForm.raw["fixture.note"] &&
            afterForm.input.value === beforeForm.input.value &&
            afterForm.state.draft.some(
              (row) => row.key === "fixture.note" && row.value === beforeForm.input.value,
            ) &&
            persisted.values.some(
              (row) => row.key === "fixture.note" && row.value === "Winning write",
            ),
        },
        events: [],
        samples: {},
        contention,
      };
    } finally {
      input.fault.release("before-publish");
      input.host.settings.update = originalUpdate;
      if (first) await bounded(Promise.allSettled([first]));
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    clearInterval(heartbeat);
    for (const scope of scopes) {
      try {
        input.broker.intent.revokeScope(scope, "closed");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const operation of operations) {
      try {
        value(
          await input.broker.request(
            principals[operation.index]!,
            "devices/motion/stop",
            { operationId: operation.id, stopMode: "brake" },
            signal,
          ),
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const participant = input.host.participant;
    const drain = participant.drain;
    const cleanupDrains: Promise<DrainReport>[] = [];
    participant.drain = function (...args) {
      const pending = drain.apply(this, args);
      cleanupDrains.push(pending);
      void pending.catch(() => {});
      return pending;
    };
    try {
      for (const held of reservations) {
        try {
          value(
            await input.broker.request(
              principals[held.index]!,
              "devices/recording/release",
              { reservationId: held.id },
              signal,
            ),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      // Release schedules the original SDK drain in a microtask. Settle it before
      // fixture.close retires the execution and freezes its storage authority.
      for (const pending of cleanupDrains) {
        try {
          const report = await bounded(pending);
          assert.equal(report.state, "saved");
          assert.equal(report.blocker, false);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    } finally {
      participant.drain = drain;
    }
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Contention cleanup failed",
    );
  if (failed) throw failure;
  assert.ok(evidence, "Missing contention evidence");
  return evidence;
}

// Same admitted consumer and worker as the motion/CAS phase. The existing SDK
// drain fixture supports this record kind and supplies the final checkpoint.
export async function registerContentionCheckpoint(
  input: LifecycleCaseInput,
  reservation: ReservationSnapshot,
  whilePaused: () => Promise<void>,
): Promise<ContentionCheckpoint> {
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin") throw new Error("Missing recording consumer");
  const signal = new AbortController().signal;
  const bytes = Buffer.from("Contention original recording checkpoint\n");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const write = value(
    await input.host.request(
      principal,
      "storage/beginWrite",
      {
        target: { mode: "create" },
        kind: "test.registration-end",
        schemaVersion: 1,
        label: "Contention recording",
        mediaType: "application/octet-stream",
        byteLength: bytes.length,
        sha256,
      },
      signal,
    ),
  );
  value(
    await input.host.request(
      principal,
      "storage/writeChunk",
      { write: write.write, offset: 0, data: bytes.toString("base64") },
      signal,
    ),
  );
  value(await input.host.request(principal, "storage/sealWrite", { write: write.write }, signal));
  const committed = value(
    await input.host.request(principal, "storage/commitWrite", { write: write.write }, signal),
  );
  assert.ok(committed.receipt);
  const barrier = input.backend.evidence.capture(
    { kind: "target", owner: principal.owner, recordId: committed.record.id },
    input.now() + 15000,
  );
  const recordTicket = input.backend.evidence
    .tickets(barrier)
    .find(
      (ticket) =>
        ticket.metadata.kind === "record" &&
        ticket.metadata.record.revision === committed.record.revision,
    );
  assert.ok(recordTicket, "Missing original record worker ticket");
  assert.equal((await input.backend.evidence.flush(barrier)).state, "saved");
  const recordOutcome = await input.backend.engine.reconcile(recordTicket);
  const publications: ContentionCheckpoint["publication"][] = [];
  const tickets: PublicationTicket[] = [];
  const chunks = new Map<string, Buffer[]>();
  const engine = input.backend.engine,
    publish = engine.publish,
    reserve = engine.reserve,
    append = engine.append;
  engine.append = async function (ticket, offset, bytes) {
    const next = await append.call(this, ticket, offset, bytes);
    if (ticket.target.kind === "recovery") {
      const prior = chunks.get(ticket.id) ?? [];
      assert.equal(Buffer.concat(prior).length, offset);
      prior.push(Buffer.from(bytes.subarray(0, next - offset)));
      chunks.set(ticket.id, prior);
    }
    return next;
  };
  engine.reserve = function (ticket, size) {
    tickets.push(structuredClone(ticket));
    return reserve.call(this, ticket, size);
  };
  engine.publish = async function (ticket) {
    const result = await publish.call(this, ticket);
    if (ticket.target.kind === "recovery" && ticket.owner.sourceKey === principal.owner.sourceKey)
      publications.push({ ticket: structuredClone(ticket), result: structuredClone(result) });
    return result;
  };
  let registration: ReturnType<typeof input.host.request<"storage/registerCheckpoint">> | undefined;
  try {
    const traceStart = input.fault.trace().length;
    const reached = input.fault.reached("before-publish");
    input.fault.arm("before-publish", "pause");
    registration = input.host.request(
      principal,
      "storage/registerCheckpoint",
      {
        id: committed.record.id,
        expectedRevision: committed.record.revision,
        reservation: reservation.reservationId,
      },
      signal,
    );
    void registration.catch(() => {});
    await bounded(reached);
    const pausedAt = input.now();
    const trace = input.fault.trace().slice(traceStart);
    const paused = trace.find((row) => row.point === "before-publish");
    const ticket = tickets.find((row) => row.id === paused?.ticket);
    assert.ok(ticket, "Missing original registration admission");
    assert.equal(ticket.target.kind, "recovery");
    assert.deepEqual(ticket.owner, principal.owner);
    const pausedDocument = JSON.parse(
      Buffer.concat(chunks.get(ticket.id) ?? []).toString("utf8"),
    ) as CheckpointRegistration;
    assert.equal(pausedDocument.checkpoint, ticket.target.kind === "recovery" && ticket.target.key);
    assert.deepEqual(pausedDocument.record, committed.record);
    assert.deepEqual(pausedDocument.binding?.owner, principal.owner);
    assert.equal(pausedDocument.binding?.reservationId, reservation.reservationId);
    assert.equal(pausedDocument.binding?.sessionId, reservation.sessionId);
    assert.ok(Number.isSafeInteger(pausedDocument.binding?.providerGeneration));
    await whilePaused();
    const traceBeforeRelease = input.fault.trace().slice(traceStart);
    assert.ok(
      !traceBeforeRelease.some((row) => row.ticket === ticket.id && row.point === "after-publish"),
    );
    const releasedAt = input.now();
    input.fault.release("before-publish");
    const registered = value(await bounded(registration));
    assert.equal(ticket.target.kind === "recovery" && ticket.target.key, registered.checkpoint);
    const publication = publications.find(
      (row) =>
        row.ticket.target.kind === "recovery" && row.ticket.target.key === registered.checkpoint,
    );
    assert.ok(publication, "Original checkpoint worker acknowledgement missing");
    assert.equal(publication.result.disposition, "committed");
    const durable = await input.backend.evidence.auxiliary(
      principal.owner,
      "recovery",
      registered.checkpoint,
    );
    assert.ok(durable, "Original durable checkpoint missing");
    const document = JSON.parse(Buffer.from(durable).toString("utf8")) as CheckpointRegistration;
    assert.equal(document.binding?.reservationId, reservation.reservationId);
    const pin = await input.backend.reads.open(
      principal.owner,
      committed.record.id,
      committed.record.revision,
    );
    let payload: Uint8Array;
    try {
      payload = await input.backend.reads.read(principal.owner, pin, 0, 262144);
    } finally {
      await input.backend.reads.close(principal.owner, pin);
    }
    assert.equal(createHash("sha256").update(payload).digest("hex"), sha256);
    return {
      pause: {
        document: pausedDocument,
        ticket,
        pausedAt,
        releasedAt,
        traceBeforeRelease,
        traceAfterRelease: input.fault.trace().slice(traceStart),
      },
      recordOutcome,
      recoveryOutcome: await engine.reconcile(publication.ticket),
      recordTicket,
      record: committed.record,
      receipt: committed.receipt,
      payloadBase64: Buffer.from(payload).toString("base64"),
      checkpoint: registered.checkpoint,
      document,
      publication,
    };
  } finally {
    input.fault.release("before-publish");
    try {
      if (registration) await bounded(Promise.allSettled([registration]));
    } finally {
      engine.publish = publish;
      engine.reserve = reserve;
      engine.append = append;
    }
  }
}
