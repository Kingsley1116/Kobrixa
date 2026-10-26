import { createHash } from "node:crypto";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import type { RecordMeta, RecordWrite } from "@kobrixa/plugin-protocol";
import { immutableSnapshot, snapshotRecording, type Recording } from "./model/data.js";
export type LabStorage = PluginContext["storage"];
export type SaveOptions = {
  storage?: LabStorage;
  signal?: AbortSignal;
  checkpoint?: { handle: string; phase: "checkpoint" | "final" };
  drainToken?: string;
};
function snapshotOptions(options: SaveOptions): SaveOptions {
  // Preserve capability references (including the signal's live abort state),
  // but detach caller-owned options/checkpoint objects before any await.
  return Object.freeze({
    ...options,
    ...(options.checkpoint ? { checkpoint: Object.freeze({ ...options.checkpoint }) } : {}),
  });
}
export type TerminalWrite = Readonly<{
  write: string;
  id: string;
  state: "aborted" | "expired" | "failed";
  receivedBytes: number;
  input: RecordWrite;
}>;
export class LabStorageError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function value<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new LabStorageError(result.error.code, result.error.message);
  return result.value;
}
const MAX_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
type Pending = { write: string; id: string; bytes: Buffer; input: RecordWrite; modelId: string };
/** One logical recording writer, retaining the original write across unknown replies.
 * A committed receipt advances the CAS head; submitted/sealed never means saved. */
export class RecordingWriter {
  #current: RecordMeta | undefined;
  #modelId: string | undefined;
  #committedWrite: string | undefined;
  #pending: Pending | undefined;
  #terminalWrite: TerminalWrite | undefined;
  #busy = false;
  #unknownBegin = false;
  constructor(private readonly storage: LabStorage) {}
  get current(): RecordMeta | undefined {
    return this.#current;
  }
  get committedWrite(): string | undefined {
    return this.#committedWrite;
  }
  get pendingWrite(): string | undefined {
    return this.#pending?.write;
  }
  /** Latest confirmed terminal attempt; bounded diagnostic metadata, not a saved receipt. */
  get terminalWrite(): TerminalWrite | undefined {
    return this.#terminalWrite;
  }
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new LabStorageError("busy", "Recording writer busy");
    if (this.#unknownBegin)
      throw new LabStorageError("uncertain", "Begin outcome unknown; another create is forbidden");
    this.#busy = true;
    try {
      return await work();
    } finally {
      this.#busy = false;
    }
  }
  save(record: Recording, options: SaveOptions = {}): Promise<RecordMeta> {
    options = snapshotOptions(options);
    // Snapshot before the first await: later UI edits cannot alter staged bytes.
    const snapshot = snapshotRecording(record);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshot.id))
      return Promise.reject(new LabStorageError("identity", "A recording needs its own UUID"));
    const bytes = Buffer.from(JSON.stringify(snapshot));
    if (bytes.length > MAX_BYTES)
      return Promise.reject(new LabStorageError("size", "Recording exceeds 8 MiB"));
    return this.#exclusive(async () => {
      if (this.#modelId && this.#modelId !== snapshot.id)
        throw new LabStorageError("identity", "Recording payload identity changed");
      if (this.#pending) await this.#resume(options, true);
      const storage = options.storage ?? this.storage;
      if (!this.#current) {
        let cursor: string | undefined;
        let count = 0;
        const seen = new Set<string>();
        do {
          const page = value(
            await storage.list(
              { kind: "sensor-lab.recording", limit: 64, ...(cursor ? { cursor } : {}) },
              options.signal,
            ),
          );
          count += page.entries.length;
          if (count >= 50) throw new LabStorageError("history", "Recording history is full");
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor))
            throw new LabStorageError("history", "Repeated history cursor");
          if (cursor) seen.add(cursor);
        } while (cursor);
      }
      if (options.drainToken && (!this.#current || options.checkpoint?.phase !== "final"))
        throw new LabStorageError("drain", "Final drain requires a confirmed checkpoint target");
      // The retained drain route admits only final write operations; quota/list
      // cannot borrow the retired owner's ordinary permissions. beginWrite remains authoritative.
      if (!options.drainToken) {
        const quota = value(await storage.quota({}, options.signal));
        if (
          quota.writeSlotsAvailable < 1 ||
          quota.hostAvailableBytes < bytes.length ||
          quota.committedBytes + quota.reservedBytes + bytes.length > quota.sourceLimitBytes ||
          (!this.#current && quota.recordCount + quota.reservedCreates >= quota.sourceLimitRecords)
        )
          throw new LabStorageError("quota", "Insufficient recording storage quota");
      }
      const input: RecordWrite = immutableSnapshot({
        target: this.#current
          ? { mode: "replace", id: this.#current.id, expectedRevision: this.#current.revision }
          : { mode: "create" },
        kind: "sensor-lab.recording",
        schemaVersion: 2,
        label: snapshot.name,
        mediaType: "application/json",
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
        ...(options.drainToken ? { drainToken: options.drainToken } : {}),
      });
      let result: Awaited<ReturnType<LabStorage["beginWrite"]>>;
      try {
        result = await storage.beginWrite(input, options.signal);
      } catch (error) {
        this.#unknownBegin = true;
        throw error;
      }
      const begun = value(result);
      this.#modelId = snapshot.id;
      this.#pending = { write: begun.write, id: begun.id, bytes, input, modelId: snapshot.id };
      return this.#resume(options);
    });
  }
  reconcile(options: SaveOptions = {}): Promise<RecordMeta | undefined> {
    options = snapshotOptions(options);
    return this.#exclusive(async () => (this.#pending ? this.#resume(options) : this.#current));
  }
  async #resume(options: SaveOptions, retryAborted = false): Promise<RecordMeta> {
    const p = this.#pending!;
    if (
      (options.drainToken !== undefined && options.drainToken !== p.input.drainToken) ||
      (options.checkpoint !== undefined &&
        (options.checkpoint.handle !== p.input.checkpoint?.handle ||
          options.checkpoint.phase !== p.input.checkpoint?.phase))
    )
      throw new LabStorageError("drain", "Retry cannot change the original write grant");
    const storage = options.storage ?? this.storage;
    const progress = value(await storage.writeStatus({ write: p.write }, options.signal));
    if (
      progress.write !== p.write ||
      progress.id !== p.id ||
      progress.receivedBytes > p.bytes.length
    )
      throw new LabStorageError("identity", "Write status does not match the original recording");
    if (
      progress.state === "aborted" ||
      progress.state === "expired" ||
      progress.state === "failed"
    ) {
      this.#terminalWrite = immutableSnapshot({
        write: p.write,
        id: p.id,
        state: progress.state,
        receivedBytes: progress.receivedBytes,
        input: p.input,
      });
      if (
        retryAborted &&
        progress.state === "aborted" &&
        p.input.drainToken === undefined &&
        p.input.checkpoint?.phase !== "final" &&
        options.drainToken === undefined &&
        options.checkpoint?.phase !== "final" &&
        p.input.target.mode === "replace" &&
        this.#current?.id === p.input.target.id &&
        this.#current.revision === p.input.target.expectedRevision
      ) {
        // Only save may try another ordinary CAS. Keep the aborted pending write
        // until begin succeeds: quota/admission/CAS failure must not discard it.
        return this.#current;
      }
      throw new LabStorageError(
        "terminal",
        `Recording write is ${progress.state}; retain checkpoint evidence`,
      );
    }
    if (progress.state === "receiving") {
      let offset = progress.receivedBytes;
      while (offset < p.bytes.length) {
        const end = Math.min(offset + CHUNK_BYTES, p.bytes.length);
        const chunk = value(
          await storage.writeChunk(
            { write: p.write, offset, data: p.bytes.subarray(offset, end).toString("base64") },
            options.signal,
          ),
        );
        if (chunk.receivedBytes !== end)
          throw new LabStorageError("offset", "Unexpected recording chunk acknowledgement");
        offset = end;
      }
      const sealed = value(await storage.sealWrite({ write: p.write }, options.signal));
      if (sealed.state !== "sealed" && sealed.state !== "committed")
        throw new LabStorageError("unsealed", "Recording was not sealed");
    }
    const committed = value(
      await storage.commitWrite(
        { write: p.write, ...(p.input.drainToken ? { drainToken: p.input.drainToken } : {}) },
        options.signal,
      ),
    );
    const meta = committed.record;
    if (
      meta.id !== p.id ||
      meta.kind !== p.input.kind ||
      meta.schemaVersion !== 2 ||
      meta.byteLength !== p.bytes.length ||
      meta.sha256 !== p.input.sha256 ||
      committed.receipt.revision !== meta.revision
    )
      throw new LabStorageError("receipt", "Recording receipt does not match staged bytes");
    this.#current = immutableSnapshot(meta);
    this.#committedWrite = p.write;
    this.#modelId = p.modelId;
    this.#pending = undefined;
    return this.#current;
  }
}
