import { randomUUID } from "node:crypto";
import type { PersistenceDrainContext, PluginContext } from "@kobrixa/plugin-sdk";
import type {
  DrainReason,
  RecordMeta,
  ReservationSnapshot,
  StorageRequestMap,
  TelemetryFrame,
} from "@kobrixa/plugin-protocol";
import { preflightRecording, RecordingWriter } from "./persistence.js";
import {
  LIMITS,
  immutableSnapshot,
  publicFrame,
  snapshotRecording,
  type CalibratedChannel,
  type Recording,
  type StopReason,
} from "./model/data.js";

export type LabRecorderStart = { name: string; sessionId: string; channels: CalibratedChannel[] };
export type LabRecorderState = {
  phase:
    | "idle"
    | "starting"
    | "recording"
    | "stopping"
    | "ended"
    | "draining"
    | "submitted"
    | "error"
    | "disposed";
  reservation: ReservationSnapshot | null;
  checkpoint: string | null;
  record: RecordMeta | null;
  pendingWrite: string | null;
  error: string | null;
  end: {
    reservation: ReservationSnapshot;
    observedMonotonicMs: number;
    drainReason?: DrainReason;
  } | null;
};
type DrainResult = StorageRequestMap["storage/drain"]["result"];
type Run = {
  writer: RecordingWriter;
  control: AbortController;
  record: Recording | null;
  reservation: ReservationSnapshot | null;
  checkpoint: string | null;
  last: number;
  started: number;
  limitAt: number | null;
  end: LabRecorderState["end"];
  phase: LabRecorderState["phase"];
  error: string | null;
  draining: boolean;
  stopRequested: boolean;
  reserveAttempted: boolean;
  poll?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  checkpointTimer?: ReturnType<typeof setTimeout>;
  starting?: Promise<void>;
  reading?: Promise<void>;
  writing?: Promise<void>;
  releasing?: Promise<void>;
  drain?: Promise<DrainResult>;
  drainToken?: string;
};
function value<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
function reason(
  end: ReservationSnapshot["reason"],
  limit: boolean,
  drain: DrainReason,
): StopReason {
  switch (end) {
    case "released":
      return limit ? "limit" : "manual";
    case "limit":
      return "limit";
    case "source-changed":
      return "source-changed";
    case "disconnected":
    case "core-disconnect":
      return "disconnected";
    case "suspended":
      return "suspend";
    case "retired":
      return drain === "shutdown" ? "close" : drain === "update" ? "update" : "interrupted";
    case "overflow":
    case "renderer-lost":
      return "interrupted";
    case "active":
      throw new Error("An active reservation cannot be finalized");
  }
}
/** One public reservation consumer. Only the host drain callback may finalize. */
export class LabRecorder {
  #run: Run | null = null;
  #disposed = false;
  readonly #now: () => number;
  readonly #wall: () => number;
  constructor(
    private readonly input: {
      devices: PluginContext["devices"];
      storage: PluginContext["storage"];
      now?: () => number;
      wallNow?: () => number;
      onChange?: () => void;
    },
  ) {
    this.#now = input.now ?? (() => performance.now());
    this.#wall = input.wallNow ?? Date.now;
  }
  get state(): Readonly<LabRecorderState> {
    const r = this.#run;
    return immutableSnapshot({
      phase: this.#disposed ? "disposed" : (r?.phase ?? "idle"),
      reservation: r?.reservation ?? null,
      checkpoint: r?.checkpoint ?? null,
      record: r?.writer.current ?? null,
      pendingWrite: r?.writer.pendingWrite ?? null,
      error: r?.error ?? null,
      end: r?.end ?? null,
    });
  }
  get snapshot(): Recording | null {
    return this.#run?.record ? snapshotRecording(this.#run.record) : null;
  }
  #publish(r: Run): void {
    if (this.#run === r && !this.#disposed) {
      try {
        this.input.onChange?.();
      } catch {
        /* Observers cannot control recording. */
      }
    }
  }
  #active(r: Run): boolean {
    return this.#run === r && !this.#disposed && !r.draining && !r.control.signal.aborted;
  }
  #check(r: Run): void {
    if (!this.#active(r)) throw new Error("Recording work retired");
  }
  #clear(r: Run): void {
    clearTimeout(r.poll);
    clearTimeout(r.deadline);
    clearTimeout(r.checkpointTimer);
    delete r.poll;
    delete r.deadline;
    delete r.checkpointTimer;
  }
  #evidence(r: Run, reservation: ReservationSnapshot): void {
    if (
      !r.reservation ||
      reservation.reservationId !== r.reservation.reservationId ||
      reservation.sessionId !== r.reservation.sessionId
    )
      throw new Error("Foreign reservation reply");
    if (reservation.firstSequence !== r.reservation.firstSequence)
      throw new Error("Reservation origin changed");
    // Never let a delayed active snapshot or released reply erase host terminal evidence.
    if (r.end) {
      if (reservation.reason === "active" || reservation.reason === "released") return;
    }
    r.reservation = immutableSnapshot(reservation);
    if (reservation.reason !== "active") {
      r.end = {
        reservation: immutableSnapshot(reservation),
        observedMonotonicMs: r.end?.observedMonotonicMs ?? this.#now(),
      };
      this.#clear(r);
      if (!r.draining && r.phase !== "error") r.phase = "ended";
    }
  }
  start(options: LabRecorderStart): Promise<void> {
    const previous = this.#run;
    const preflightOnly = previous?.phase === "error" && !previous.reserveAttempted;
    const stoppedBeforeWrite =
      previous?.phase === "ended" &&
      previous.stopRequested &&
      previous.record === null &&
      previous.end !== null;
    if (
      this.#disposed ||
      (previous && previous.phase !== "submitted" && !preflightOnly && !stoppedBeforeWrite)
    )
      return Promise.reject(new Error("Recording or unresolved recovery already exists"));
    const copy = immutableSnapshot(options);
    const r: Run = {
      writer: new RecordingWriter(this.input.storage),
      control: new AbortController(),
      record: null,
      reservation: null,
      checkpoint: null,
      last: 0,
      started: this.#now(),
      limitAt: null,
      end: null,
      phase: "starting",
      error: null,
      draining: false,
      stopRequested: false,
      reserveAttempted: false,
    };
    this.#run = r;
    this.#publish(r);
    const job = this.#start(r, copy);
    r.starting = job;
    return job;
  }
  async #start(r: Run, options: LabRecorderStart): Promise<void> {
    try {
      if (options.channels.length < 1 || options.channels.length > LIMITS.channels)
        throw new Error("Select 1..4 channels");
      const first = options.channels[0]!.source;
      if (first.origin !== "public") throw new Error("Recording requires public sources");
      if (
        options.sessionId !== first.provenance.sessionId ||
        options.channels.some(
          (c) =>
            c.source.origin !== "public" ||
            c.source.provenance.sessionId !== options.sessionId ||
            c.source.provenance.providerId !== first.provenance.providerId ||
            c.source.provenance.sourceRevision !== first.provenance.sourceRevision ||
            c.source.channel.state !== "ready",
        )
      )
        throw new Error("Sources must share a ready public session/revision");
      // Validate the complete model before reserving; firstFrame supplies the real origin later.
      const provisional = snapshotRecording({
        schemaVersion: 2,
        id: randomUUID(),
        name: options.name,
        startedAt: this.#wall(),
        durationMs: 0,
        frameCount: 0,
        channels: options.channels,
        frames: [],
        recordingOrigin: {
          providerId: first.provenance.providerId,
          sessionId: options.sessionId,
          sessionElapsedMs: 0,
        },
      });
      const current = value(
        await this.input.devices.session({ sessionId: options.sessionId }, r.control.signal),
      );
      this.#check(r);
      if (
        current.session.sessionId !== options.sessionId ||
        current.sources.sessionId !== options.sessionId ||
        current.session.state !== "connected" ||
        current.session.providerId !== first.provenance.providerId ||
        current.session.sourceRevision !== first.provenance.sourceRevision ||
        current.sources.sourceRevision !== first.provenance.sourceRevision ||
        options.channels.some(
          (c) =>
            !current.sources.channels.some((s) =>
              Object.entries(c.source.channel).every(([k, v]) =>
                Object.entries(s).some(([key, val]) => key === k && val === v),
              ),
            ),
        )
      )
        throw new Error("Selected sources are no longer current");
      await preflightRecording(
        this.input.storage,
        Buffer.byteLength(JSON.stringify(provisional)),
        true,
        r.control.signal,
      );
      this.#check(r);
      if (r.stopRequested) throw new Error("Recording start stopped before reservation");
      r.reserveAttempted = true;
      const result = await this.input.devices.recording.reserve(
        {
          sessionId: options.sessionId,
          channelIds: options.channels.map((c) =>
            c.source.origin === "public" ? c.source.channel.channelId : "",
          ),
          expectedSourceRevision: first.provenance.sourceRevision,
        },
        r.control.signal,
      );
      if (
        !result.ok &&
        result.error.detail?.kind === "device" &&
        result.error.detail.dispatch === "not-sent"
      )
        r.reserveAttempted = false; // Explicit non-admission, never a lost/unknown reply.
      const reserved = value(result);
      r.reservation = immutableSnapshot(reserved.reservation);
      r.started = this.#now();
      this.#check(r);
      if (r.stopRequested) {
        await this.#release(r, false);
        return;
      }
      if (
        reserved.reservation.sessionId !== options.sessionId ||
        reserved.firstFrame.sequence !== reserved.reservation.firstSequence ||
        reserved.reservation.channels.length !== options.channels.length ||
        options.channels.some(
          (c) =>
            !reserved.reservation.channels.some((s) =>
              Object.entries(c.source.channel).every(([k, v]) =>
                Object.entries(s).some(([key, val]) => key === k && val === v),
              ),
            ),
        )
      )
        throw new Error("Reservation source mismatch");
      const origin = {
        providerId: first.provenance.providerId,
        sessionId: options.sessionId,
        sessionElapsedMs: reserved.firstFrame.elapsedMs,
      };
      const frame = publicFrame(
        options.channels.map((c) => c.source),
        reserved.firstFrame,
        0,
        origin,
      );
      r.record = {
        schemaVersion: 2,
        id: randomUUID(),
        name: options.name,
        startedAt: this.#wall(),
        durationMs: 0,
        frameCount: 1,
        channels: options.channels,
        frames: [frame],
        recordingOrigin: origin,
      };
      r.last = reserved.firstFrame.sequence;
      this.#evidence(r, reserved.reservation);
      r.deadline = setTimeout(() => {
        if (this.#active(r) && !r.end) void this.#release(r, true);
      }, LIMITS.durationMs);
      await r.writer.save(r.record, { signal: r.control.signal });
      this.#check(r);
      if (r.stopRequested || r.end) {
        this.#publish(r);
        return;
      }
      const registered = value(
        await this.input.storage.registerCheckpoint(
          {
            id: r.writer.current!.id,
            expectedRevision: r.writer.current!.revision,
            reservation: r.reservation.reservationId,
          },
          r.control.signal,
        ),
      );
      r.checkpoint = registered.checkpoint;
      this.#check(r);
      if (r.stopRequested || r.end) {
        this.#publish(r);
        return;
      }
      this.#evidence(
        r,
        value(
          await this.input.devices.recording.query(
            { reservationId: r.reservation.reservationId },
            r.control.signal,
          ),
        ).reservation,
      );
      this.#check(r);
      if (!r.end && !r.stopRequested) {
        r.phase = "recording";
        this.#schedulePoll(r, 0);
        this.#scheduleCheckpoint(r);
      }
      this.#publish(r);
    } catch (error) {
      if (!r.draining) {
        r.error = error instanceof Error ? error.message : String(error);
        r.phase = "error";
        this.#clear(r);
        await this.#release(r, false);
        this.#publish(r);
      }
      throw error;
    }
  }
  #append(r: Run, frames: TelemetryFrame[], maximum = Number.MAX_SAFE_INTEGER): void {
    const record = r.record!;
    for (const frame of frames) {
      if (frame.sequence <= r.last) continue;
      if (frame.sequence > maximum) break;
      if (frame.sequence !== r.last + 1) throw new Error("Recording frame gap");
      const elapsed = frame.elapsedMs - record.recordingOrigin!.sessionElapsedMs;
      // Read through the fixed end cursor even when the model's hard cap excludes tail frames.
      if (record.frames.length < LIMITS.frames && elapsed <= LIMITS.durationMs) {
        const segment = record.frames.at(-1)?.segment ?? 0;
        record.frames.push(
          publicFrame(
            record.channels.map((c) => c.source),
            frame,
            segment + (frame.status !== "ok" || frame.gap ? 1 : 0),
            record.recordingOrigin!,
          ),
        );
        record.frameCount = record.frames.length;
        record.durationMs = Math.max(record.durationMs, elapsed);
      }
      r.last = frame.sequence;
      if (
        !r.draining &&
        !r.end &&
        (record.frameCount >= LIMITS.frames || elapsed >= LIMITS.durationMs)
      )
        void this.#release(r, true);
    }
  }
  #schedulePoll(r: Run, delay = 250): void {
    if (!this.#active(r) || r.end || r.phase !== "recording") return;
    r.poll = setTimeout(() => {
      delete r.poll;
      const job = this.#poll(r);
      r.reading = job;
      void job.finally(() => {
        if (r.reading === job) delete r.reading;
      });
    }, delay);
  }
  async #poll(r: Run): Promise<void> {
    try {
      const read = value(
        await this.input.devices.recording.read(
          { reservationId: r.reservation!.reservationId, afterSequence: r.last, limit: 64 },
          r.control.signal,
        ),
      );
      if (!this.#active(r)) return;
      this.#evidence(r, read.reservation);
      if (read.gap) throw new Error("Reservation buffer overflow; retain checkpoint");
      this.#append(r, read.frames);
      this.#publish(r);
      this.#schedulePoll(r, read.hasMore ? 0 : 250);
    } catch (error) {
      if (this.#active(r)) {
        r.error = error instanceof Error ? error.message : String(error);
        r.phase = "error";
        this.#clear(r);
        await this.#release(r, false);
        this.#publish(r);
      }
    }
  }
  #scheduleCheckpoint(r: Run): void {
    if (!this.#active(r) || r.end || r.phase !== "recording") return;
    r.checkpointTimer = setTimeout(() => {
      delete r.checkpointTimer;
      const job = this.#checkpoint(r);
      r.writing = job;
      void job.finally(() => {
        if (r.writing === job) delete r.writing;
      });
    }, LIMITS.checkpointMs);
  }
  async #checkpoint(r: Run): Promise<void> {
    try {
      await r.writer.save(r.record!, {
        signal: r.control.signal,
        checkpoint: { handle: r.checkpoint!, phase: "checkpoint" },
      });
      if (this.#active(r)) {
        this.#publish(r);
        this.#scheduleCheckpoint(r);
      }
    } catch (error) {
      if (this.#active(r)) {
        r.error = error instanceof Error ? error.message : String(error);
        r.phase = "error";
        this.#clear(r);
        await this.#release(r, false);
        this.#publish(r);
      }
    }
  }
  async #release(r: Run, limit: boolean): Promise<void> {
    if (!r.reservation || r.end) return;
    if (r.releasing) return r.releasing;
    if (limit && r.limitAt === null) r.limitAt = this.#now(); // fixed before the public release call
    this.#clear(r);
    if (r.phase !== "error" && !r.draining) r.phase = "stopping";
    this.#publish(r);
    const job = (async () => {
      try {
        const result = value(
          await this.input.devices.recording.release({
            reservationId: r.reservation!.reservationId,
          }),
        );
        if (this.#run === r) {
          this.#evidence(r, result.reservation);
          this.#publish(r);
        }
      } catch (error) {
        if (this.#run === r) {
          r.error = error instanceof Error ? error.message : String(error);
          if (!r.draining) r.phase = "error";
          this.#publish(r);
        }
      }
    })();
    r.releasing = job;
    await job;
    if (r.releasing === job) delete r.releasing;
  }
  async stop(): Promise<void> {
    const r = this.#run;
    if (!r || this.#disposed || r.draining) return;
    r.stopRequested = true;
    // Do not couple Stop to storage startup. A reserve still in flight observes
    // stopRequested as soon as its original handle arrives; it is never replayed.
    await this.#release(r, false);
  }
  drain(context: PersistenceDrainContext): Promise<DrainResult> {
    const r = this.#run;
    if (!r) return Promise.resolve({ ok: true, value: { status: "checkpoint-only", writes: [] } });
    // A late callback for the preceding recording cannot abort a new reservation.
    if (
      !context.request.checkpoints.some(
        (c) =>
          c.record.id === r.writer.current?.id &&
          c.reservationEnd?.reservationId === r.reservation?.reservationId &&
          (!r.checkpoint || c.checkpoint === r.checkpoint),
      )
    )
      return Promise.resolve(this.#failure("No matching host reservation end/checkpoint grant"));
    if (r.drain)
      return r.drainToken === context.request.token
        ? r.drain
        : Promise.resolve(this.#failure("Another drain already owns this recording"));
    r.draining = true;
    r.drainToken = context.request.token;
    r.phase = "draining";
    this.#clear(r);
    r.control.abort(new Error("Host drain owns finalization"));
    this.#publish(r);
    r.drain = this.#drain(r, context);
    return r.drain;
  }
  #failure(message: string): DrainResult {
    return {
      ok: false,
      error: {
        code: "PLUGIN_E_STORAGE_IO",
        message: message.slice(0, 2000),
        detail: {
          kind: "persistence",
          reason: "io",
          disposition: "unknown",
          payload: this.#run?.writer.current ? "checkpoint-only" : "none",
        },
      },
    };
  }
  async #drain(r: Run, context: PersistenceDrainContext): Promise<DrainResult> {
    try {
      const signal = context.signal;
      signal.throwIfAborted();
      await wait(
        Promise.all([r.starting, r.reading, r.writing, r.releasing].map((p) => p?.catch(() => {}))),
        signal,
      );
      const offer = context.request.checkpoints.find(
        (c) =>
          c.record.id === r.writer.current?.id &&
          c.reservationEnd?.reservationId === r.reservation?.reservationId &&
          (!r.checkpoint || c.checkpoint === r.checkpoint),
      );
      if (!offer || !offer.reservationEnd || !r.record || !r.reservation)
        throw new Error("No matching host reservation end/checkpoint grant");
      r.checkpoint = offer.checkpoint;
      const end = offer.reservationEnd;
      this.#evidence(r, {
        ...r.reservation,
        state: "ended",
        reason: end.reason,
        lastSequence: end.lastSequence,
      });
      r.end = {
        reservation: immutableSnapshot(r.reservation),
        observedMonotonicMs: r.end!.observedMonotonicMs,
        drainReason: context.request.reason,
      };
      if (r.last > end.lastSequence)
        throw new Error("Host fixed lastSequence precedes consumed data");
      while (r.last < end.lastSequence) {
        const before = r.last;
        const read = value(
          await this.input.devices.recording.read(
            { reservationId: end.reservationId, afterSequence: r.last, limit: 64 },
            signal,
          ),
        );
        signal.throwIfAborted();
        if (
          read.reservation.reservationId !== end.reservationId ||
          read.reservation.sessionId !== r.reservation.sessionId ||
          read.gap
        )
          throw new Error("Drain frame gap/foreign reservation");
        this.#append(r, read.frames, end.lastSequence);
        if (r.last === before) throw new Error("Drain did not reach fixed lastSequence");
      }
      // Reconcile a lost receipt before choosing the next confirmed CAS revision.
      await r.writer.reconcile({
        storage: context.storage,
        signal,
      });
      const terminal = reason(r.end.reservation.reason, r.limitAt !== null, context.request.reason);
      r.record = {
        ...r.record,
        durationMs: Math.min(
          LIMITS.durationMs,
          Math.max(r.record.durationMs, r.end.observedMonotonicMs - r.started),
        ),
        endedAt: this.#wall(),
        reason: terminal,
      };
      const previousWrite = r.writer.committedWrite;
      const final = await r.writer.save(r.record, {
        storage: context.storage,
        signal,
        checkpoint: { handle: r.checkpoint, phase: "final" },
        drainToken: context.request.token,
      });
      signal.throwIfAborted();
      const submitted = r.writer.committedWrite;
      if (!submitted || submitted === previousWrite || final.checkpoint !== "final")
        throw new Error("Missing receipt for this final write");
      r.phase = "submitted";
      r.error = null;
      this.#publish(r);
      return { ok: true, value: { status: "submitted", writes: [submitted] } };
    } catch (error) {
      r.error = error instanceof Error ? error.message : String(error);
      r.phase = "error";
      this.#publish(r);
      return this.#failure(r.error);
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const r = this.#run;
    if (r) {
      this.#clear(r);
      r.control.abort(new Error("Recorder disposed"));
    }
  }
}
