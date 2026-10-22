import { journalDocument } from "./journal.js";
import { randomUUID } from "node:crypto";
import type { MotionSpec, MotionSnapshot, ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  Principal,
  PhysicalIdentity,
  ProfileWriterLock,
  SafetyFaultEntry,
  DeviceDisposition,
} from "@kobrixa/plugin-runtime";
import type { JournalPort } from "./journal-port.js";
import {
  type ExchangeLane,
  createContexts,
  type BuiltinDeviceProvider,
  type ProviderSessionKey,
  type MotionCompletion,
} from "./provider.js";
import { OwnerLedger, ownerKey, deviceFailure, quota, resourceOwnerKey } from "./registry.js";
export type MotionAdmission = {
  principal: Principal;
  sessionId: string;
  generation: number;
  physical: PhysicalIdentity;
  provider: BuiltinDeviceProvider;
  key: ProviderSessionKey;
  lane: ExchangeLane;
  motion: MotionSpec;
  contextRef: string;
  motionScopeRef: string;
  gestureRef?: string;
};
type Row = {
  input: MotionAdmission;
  snapshot: MotionSnapshot;
  expires: number;
  consumed: boolean;
  control: ReturnType<typeof createContexts> | null;
  fault: SafetyFaultEntry | null;
  pending: boolean;
  cleanup: Promise<void> | null;
  timer: ReturnType<typeof setInterval> | null;
  done: Promise<DeviceDisposition>;
  resolve: (value: DeviceDisposition) => void;
  terminal: boolean;
  journalCommitted: boolean;
  result: MotionCompletion | null;
};
export type OperationDependencies = {
  now: () => number;
  journal: JournalPort;
  profile: ProfileWriterLock;
  check: (input: MotionAdmission) => void;
};
export class OperationStore {
  #listeners = new Set<(snapshot: MotionSnapshot) => void>();
  subscribe(listener: (snapshot: MotionSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #changed(r: Row) {
    for (const listener of this.#listeners) listener(structuredClone(r.snapshot));
  }
  readonly rows = new OwnerLedger<Row>(64, 256, "operation");
  constructor(private readonly deps: OperationDependencies) {}
  prepare(input: MotionAdmission): MotionSnapshot {
    this.deps.profile.assertHeld();
    this.deps.check(input);
    const prepared = [...this.rows.rows.values()].filter(
      (r) => !r.value.consumed && !r.value.terminal && this.deps.now() < r.value.expires,
    );
    if (prepared.length >= 16) quota("operation", 16);
    if (prepared.filter((r) => r.owner === ownerKey(input.principal)).length >= 4)
      quota("operation", 4);
    for (const [id, r] of this.rows.rows)
      if (
        r.value.terminal &&
        r.value.journalCommitted &&
        r.value.snapshot.stopConfirmation !== "unconfirmed" &&
        (this.rows.rows.size >= 255 ||
          [...this.rows.rows.values()].filter((row) => row.owner === ownerKey(input.principal))
            .length >= 64)
      )
        this.rows.remove(id);
    let resolve!: (v: DeviceDisposition) => void;
    const done = new Promise<DeviceDisposition>((r) => {
      resolve = r;
    });
    const row: Row = {
      input: { ...input, motion: structuredClone(input.motion) },
      snapshot: {
        operationId: "",
        sessionId: input.sessionId,
        revision: 1,
        phase: "preparing",
        stage: "prepared",
        startAccepted: false,
        stopRequested: false,
        dispatch: "not-sent",
        movement: "not-started",
        stopConfirmation: "not-required",
        brakeRequired: input.motion.brake,
        elapsedMs: 0,
        angle: null,
        displacement: null,
        preparedRemainingMs: 5000,
      },
      expires: this.deps.now() + 5000,
      consumed: false,
      control: null,
      fault: null,
      pending: false,
      cleanup: null,
      timer: null,
      done,
      resolve,
      terminal: false,
      journalCommitted: true,
      result: null,
    };
    const id = this.rows.add(ownerKey(input.principal), row);
    row.snapshot.operationId = id;
    this.#changed(row);
    return this.query(input.principal, id);
  }
  query(principal: Principal, id: string): MotionSnapshot {
    const r = this.rows.get(ownerKey(principal), id);
    if (!r.consumed && !r.terminal && this.deps.now() >= r.expires) {
      r.consumed = true;
      r.snapshot.phase = "timeout";
      r.snapshot.stage = "terminal";
      this.#finish(r);
    }
    return {
      ...structuredClone(r.snapshot),
      preparedRemainingMs:
        r.consumed || r.terminal ? 0 : Math.max(0, Math.floor(r.expires - this.deps.now())),
    };
  }
  start(principal: Principal, id: string): MotionSnapshot {
    const r = this.rows.get(ownerKey(principal), id);
    if (r.consumed || r.terminal) return deviceFailure("PLUGIN_E_CANCELLED", "cancelled");
    r.consumed = true;
    try {
      if (this.deps.now() >= r.expires) return deviceFailure("PLUGIN_E_TIMEOUT", "deadline");
      this.deps.check(r.input);
      r.input.lane.reserve(id);
    } catch (error) {
      r.snapshot.phase = "failed";
      r.snapshot.stage = "terminal";
      this.#finish(r);
      throw error;
    }
    r.snapshot.startAccepted = true;
    r.snapshot.stage = "waiting-read";
    r.snapshot.preparedRemainingMs = 0;
    r.snapshot.revision++;
    this.#changed(r);
    let lastProgress = -Infinity;
    r.control = createContexts({
      id,
      sessionId: r.input.sessionId,
      generation: r.input.generation,
      operationClass: "finite-motion",
      deadline: this.deps.now() + 30000,
      now: this.deps.now,
      lane: r.input.lane,
      check: () => this.deps.check(r.input),
      progress: (value) => {
        if (!r.terminal && !r.snapshot.stopRequested && this.deps.now() - lastProgress >= 100) {
          lastProgress = this.deps.now();
          Object.assign(r.snapshot, value);
          r.snapshot.phase = "running";
          r.snapshot.revision++;
          this.#changed(r);
        }
      },
      onStop: () => {
        r.snapshot.stopRequested = true;
        r.snapshot.phase = "stopping";
        r.snapshot.brakeRequired =
          r.snapshot.brakeRequired || r.control?.cleanup.brakeRequired() === true;
        r.snapshot.revision++;
        this.#changed(r);
      },
    });
    r.timer = setInterval(() => {
      if (r.terminal) return;
      try {
        r.control!.work.assertContinuation("read");
      } catch {
        this.#stop(r, true);
      }
    }, 100);
    void this.#run(r);
    return this.query(principal, id);
  }
  stop(principal: Principal, id: string, mode: "configured" | "brake"): MotionSnapshot {
    const r = this.rows.get(ownerKey(principal), id);
    this.#stop(r, mode === "brake");
    return this.query(principal, id);
  }
  #stop(r: Row, brake: boolean): void {
    r.snapshot.brakeRequired ||= brake;
    r.snapshot.stopRequested = true;
    // Readback may already be terminal while its journal commit is still in
    // flight. A late release/cancel must not put that observation back into
    // "stopping" forever; durable disposition still waits for #finish below.
    if (r.terminal || r.snapshot.stage === "terminal") return;
    if (!r.snapshot.startAccepted) {
      r.consumed = true;
      r.snapshot.phase = "stopped";
      r.snapshot.stage = "terminal";
      this.#finish(r);
      return;
    }
    r.control!.stop("cancelled", brake);
    r.snapshot.phase = "stopping";
    if (r.fault && r.journalCommitted && !r.cleanup) r.cleanup = this.#cleanup(r);
  }
  async #bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Operation deadline")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async #write(r: Row): Promise<void> {
    this.deps.profile.assertHeld();
    const document = await this.deps.journal.load();
    this.deps.profile.assertHeld();
    const entries = document.entries.filter((e) => e.id !== r.fault!.id);
    while (entries.length >= 64) {
      const safe = entries.findIndex((e) => e.state === "resolved");
      if (safe < 0) quota("journal", 64);
      entries.splice(safe, 1);
    }
    entries.push(structuredClone(r.fault!));
    const next = journalDocument(document.revision + 1, entries);
    await this.#bounded(this.deps.journal.commit(next), 5000);
  }
  async #run(r: Row): Promise<void> {
    const ctx = r.control!;
    try {
      await r.input.lane.drain(ctx.work.deadlineMonotonicMs);
      ctx.work.assertContinuation("preflight");
      const principal = r.input.principal;
      const owner =
        principal.kind === "plugin"
          ? { kind: "plugin" as const, owner: principal.owner }
          : {
              kind: "core" as const,
              adapter: principal.adapter,
              hostEpoch: principal.hostEpoch,
              workbenchInstance: principal.workbenchInstance,
            };
      r.fault = {
        id: randomUUID(),
        revision: 1,
        owner,
        providerId: r.input.provider.id,
        providerGeneration: r.input.generation,
        physical: r.input.physical,
        sessionId: r.input.sessionId,
        operationId: r.snapshot.operationId,
        operationClass: "finite-motion",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: "pending",
        dispatch: "not-sent",
        movement: "not-started",
        stopRequested: false,
        stopConfirmation: "not-required",
        cause: "none",
        resolution: null,
      };
      r.journalCommitted = false;
      await this.#write(r);
      r.journalCommitted = true;
      ctx.work.assertContinuation("preflight");
      r.pending = true;
      r.snapshot.dispatch = "unknown";
      const execution = r.input.provider.executeFiniteMotion(r.input.key, r.input.motion, ctx.work);
      void execution.then(
        () => {
          r.pending = false;
        },
        () => {
          r.pending = false;
        },
      );
      const outcome = await this.#bounded(
        execution,
        Math.max(1, ctx.work.deadlineMonotonicMs - this.deps.now()),
      );
      if (!r.terminal) {
        r.snapshot.dispatch = outcome.dispatch;
        r.result = outcome.value;
        if (outcome.value) {
          r.snapshot.movement = outcome.value.movement;
          r.snapshot.angle = outcome.value.angle;
          r.snapshot.displacement = outcome.value.displacement;
        }
      }
      if (outcome.error) ctx.stop(outcome.error.reason, true);
    } catch {
      if (r.pending) {
        r.input.lane.quarantined = true;
        r.snapshot.dispatch = "unknown";
      }
      if (r.fault && r.journalCommitted) ctx.stop("provider-failure", true);
      else {
        r.snapshot.phase = "failed";
        r.snapshot.stage = "terminal";
        r.snapshot.movement = "not-started";
        r.snapshot.dispatch = "not-sent";
        r.input.lane.release(r.snapshot.operationId);
        this.#finish(r);
        return;
      }
    }
    if (!r.cleanup) r.cleanup = this.#cleanup(r);
    await r.cleanup;
  }
  async #cleanup(r: Row): Promise<void> {
    if (r.terminal) return;
    const ctx = r.control!;
    if (r.result?.movement !== "completed") ctx.stop("cancelled", r.snapshot.brakeRequired);
    r.snapshot.stage = "readback";
    r.snapshot.stopConfirmation = "pending";
    let confirmed = false;
    try {
      const outcome = await this.#bounded(
        r.input.provider.stopAndReadback(
          r.input.key,
          { kind: "operation", operationId: r.snapshot.operationId },
          ctx.cleanup,
        ),
        Math.max(1, ctx.cleanup.deadlineMonotonicMs - this.deps.now()),
      );
      const observation = outcome.value;
      confirmed =
        outcome.stopConfirmation === "confirmed" &&
        !!observation &&
        observation.programStopped &&
        observation.outputs.length === 4 &&
        observation.outputs.every((o) => o.known && o.busy === false && o.speed === 0);
    } catch {
      confirmed = false;
    }
    r.snapshot.stopConfirmation = confirmed ? "confirmed" : "unconfirmed";
    r.snapshot.phase = confirmed
      ? r.result?.movement === "completed"
        ? "completed"
        : "stopped"
      : "unconfirmed";
    r.snapshot.movement =
      r.result?.movement ??
      (r.snapshot.dispatch === "not-sent" ? "not-started" : confirmed ? "interrupted" : "unknown");
    r.snapshot.stage = "terminal";
    r.snapshot.revision++;
    this.#changed(r);
    if (r.fault) {
      Object.assign(r.fault, {
        revision: r.fault.revision + 1,
        updatedAt: Date.now(),
        dispatch: r.snapshot.dispatch,
        movement: r.snapshot.movement,
        stopRequested: r.snapshot.stopRequested,
        stopConfirmation: r.snapshot.stopConfirmation,
        state: confirmed ? "resolved" : "unconfirmed",
        cause: confirmed ? "none" : "readback-failed",
        resolution: confirmed
          ? {
              kind: "confirmed-on-original-session",
              at: Date.now(),
              sessionId: r.input.sessionId,
              identityEvidence: "same-session",
            }
          : null,
      });
      r.journalCommitted = false;
      try {
        await this.#write(r);
        r.journalCommitted = true;
      } catch {
        /* Retain journalCommitted=false and quarantine below. */
      }
    }
    if (!confirmed || !r.journalCommitted || r.pending) r.input.lane.quarantined = true;
    if (!r.pending) r.input.provider.releaseOperation(r.snapshot.operationId);
    r.input.lane.release(r.snapshot.operationId);
    this.#finish(r);
  }
  #finish(r: Row): void {
    if (r.terminal) return;
    r.terminal = true;
    r.snapshot.revision++;
    this.#changed(r);
    if (r.timer) clearInterval(r.timer);
    r.resolve({
      stopConfirmed:
        r.snapshot.stopConfirmation === "confirmed" || r.snapshot.dispatch === "not-sent",
      faultIds:
        r.fault && (!r.journalCommitted || r.snapshot.stopConfirmation === "unconfirmed")
          ? [r.fault.id]
          : [],
      journalCommitted: r.journalCommitted,
    });
  }
  settled(id: string): Promise<DeviceDisposition> {
    const row = this.rows.rows.get(id);
    if (!row) throw new Error("Unknown operation");
    return row.value.done;
  }
  stopScope(scope: string): void {
    for (const { value: r } of this.rows.rows.values())
      if (r.input.motionScopeRef === scope) this.#stop(r, true);
  }
  stopOwner(owner: ResourceOwner): Promise<DeviceDisposition>[] {
    const promises: Promise<DeviceDisposition>[] = [];
    for (const { value: r } of this.rows.rows.values())
      if (
        r.input.principal.kind === "plugin" &&
        resourceOwnerKey(r.input.principal.owner) === resourceOwnerKey(owner)
      ) {
        this.#stop(r, true);
        promises.push(r.done);
      }
    return promises;
  }
  stopSession(session: string): Promise<DeviceDisposition>[] {
    const promises: Promise<DeviceDisposition>[] = [];
    for (const { value: r } of this.rows.rows.values())
      if (r.input.sessionId === session) {
        this.#stop(r, true);
        promises.push(r.done);
      }
    return promises;
  }
}
