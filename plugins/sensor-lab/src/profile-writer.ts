import { createHash } from "node:crypto";
import type { RecordMeta, RecordWrite } from "@kobrixa/plugin-protocol";
import { LabStorageError, type LabStorage, type TerminalWrite } from "./persistence.js";
import { LabLibrary } from "./library.js";
import {
  calibrationSnapshot,
  immutableSnapshot,
  snapshotPublicSource,
  validateLegacyChannel,
  text,
  type CalibrationProfile,
} from "./model/data.js";
function value<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new LabStorageError(r.error.code, r.error.message);
  return r.value;
}
type Pending = { write: string; id: string; bytes: Buffer; input: RecordWrite; modelId: string };
/** One feature-owned writer. Unknown outcomes retain the original create identity. */
export class CalibrationWriter {
  #pending: Pending | undefined;
  #unknown = false;
  #busy = false;
  #confirmed = new Map<string, { meta: RecordMeta; sha256: string }>();
  #terminal: TerminalWrite | undefined;
  constructor(private readonly storage: LabStorage) {}
  get pendingWrite(): string | undefined {
    return this.#pending?.write;
  }
  get terminalWrite(): TerminalWrite | undefined {
    return this.#terminal;
  }
  async save(profile: CalibrationProfile, signal?: AbortSignal): Promise<RecordMeta> {
    if (this.#busy || this.#unknown)
      throw new LabStorageError("uncertain", "Profile write busy or admission unknown");
    if (
      profile.schemaVersion !== 2 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profile.id)
    )
      throw new LabStorageError("schema", "Invalid new profile identity");
    text(profile.name, 160, "name", true);
    const source =
      profile.source.origin === "public"
        ? snapshotPublicSource(profile.source.channel, profile.source.provenance)
        : { origin: "legacy-ev3" as const, channel: validateLegacyChannel(profile.source.channel) };
    const snapshot = immutableSnapshot({
      schemaVersion: 2 as const,
      id: profile.id,
      name: profile.name,
      source,
      calibration: calibrationSnapshot(profile.calibration),
    });
    const bytes = Buffer.from(JSON.stringify(snapshot)),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length > 8388608) throw new LabStorageError("size", "Profile exceeds 8 MiB");
    this.#busy = true;
    try {
      let aborted = false;
      if (this.#pending) {
        const progress = await this.#progress(signal);
        aborted = progress.state === "aborted";
        if (!aborted && this.#pending.input.sha256 !== sha256)
          throw new LabStorageError(
            "pending",
            "Reconcile the original profile before saving another",
          );
        if (!aborted) return await this.#finish(signal);
      }
      // A terminal status is evidence, not authority for a new create. Keep the
      // original pending write until ordinary quota/admission is healthy again.
      const quota = value(await this.storage.quota({}, signal));
      if (signal?.aborted) signal.throwIfAborted();
      const confirmed = this.#confirmed.get(snapshot.id);
      if (confirmed) {
        if (confirmed.sha256 !== sha256)
          throw new LabStorageError("identity", "Profile payload identity was reused");
        if (aborted) this.#pending = undefined;
        return confirmed.meta;
      }
      const existing = await this.#existing(snapshot.id, sha256, signal);
      if (this.#confirmed.size >= 256)
        throw new LabStorageError("identity-limit", "Profile identity capacity reached");
      if (existing) {
        this.#confirmed.set(snapshot.id, { meta: existing, sha256 });
        if (aborted) this.#pending = undefined;
        return existing;
      }
      if (
        quota.writeSlotsAvailable < 1 ||
        quota.hostAvailableBytes < bytes.length ||
        quota.recordCount + quota.reservedCreates >= quota.sourceLimitRecords ||
        quota.committedBytes + quota.reservedBytes + bytes.length > quota.sourceLimitBytes
      )
        throw new LabStorageError("quota", "Insufficient profile storage quota");
      if (aborted) this.#pending = undefined;
      if (!this.#pending) {
        const input: RecordWrite = {
          target: { mode: "create" },
          kind: "sensor-lab.calibration",
          schemaVersion: 2,
          label: snapshot.name,
          mediaType: "application/json",
          byteLength: bytes.length,
          sha256,
        };
        let begun;
        try {
          begun = await this.storage.beginWrite(input, signal);
        } catch (error) {
          this.#unknown = true;
          throw error;
        }
        const admitted = value(begun);
        this.#pending = {
          write: admitted.write,
          id: admitted.id,
          bytes,
          input,
          modelId: snapshot.id,
        };
      }
      return await this.#finish(signal);
    } finally {
      this.#busy = false;
    }
  }
  async reconcile(signal?: AbortSignal): Promise<RecordMeta> {
    if (this.#busy || this.#unknown || !this.#pending)
      throw new LabStorageError("uncertain", "No reconcilable original profile write");
    this.#busy = true;
    try {
      return await this.#finish(signal);
    } finally {
      this.#busy = false;
    }
  }
  /** Scan current committed profiles on a cache miss. Each read is pinned to
   * its listed revision and hash-checked; no payload UUID is used as a handle. */
  async #existing(
    modelId: string,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<RecordMeta | undefined> {
    const library = new LabLibrary(this.storage);
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    let found: RecordMeta | undefined;
    for (let page = 0; page < 6; page++) {
      const result = await library.list("sensor-lab.calibration", cursor, signal);
      for (const meta of result.entries) {
        if (ids.has(meta.id) || ids.size >= 256)
          throw new LabStorageError("identity", "Ambiguous or over-budget profile inventory");
        ids.add(meta.id);
        const profile = await library.read(meta, signal);
        if (profile.id !== modelId) continue;
        if (found || meta.sha256 !== sha256)
          throw new LabStorageError("identity", "Profile payload identity was reused or ambiguous");
        found = meta;
      }
      if (!result.nextCursor) return found;
      if (cursors.has(result.nextCursor))
        throw new LabStorageError("page", "Profile inventory cursor repeated");
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new LabStorageError("page", "Profile inventory exceeds bounded scan");
  }
  async #progress(signal?: AbortSignal) {
    const p = this.#pending!;
    const progress = value(await this.storage.writeStatus({ write: p.write }, signal));
    if (
      progress.write !== p.write ||
      progress.id !== p.id ||
      !Number.isSafeInteger(progress.receivedBytes) ||
      progress.receivedBytes < 0 ||
      progress.receivedBytes > p.bytes.length
    )
      throw new LabStorageError("identity", "Profile write status mismatch");
    if (progress.state === "aborted" || progress.state === "expired" || progress.state === "failed")
      this.#terminal = immutableSnapshot({
        write: p.write,
        id: p.id,
        state: progress.state,
        receivedBytes: progress.receivedBytes,
        input: p.input,
      });
    return progress;
  }
  async #finish(signal?: AbortSignal): Promise<RecordMeta> {
    const p = this.#pending!;
    const progress = await this.#progress(signal);
    if (["aborted", "expired", "failed"].includes(progress.state))
      throw new LabStorageError("terminal", "Original profile write ended without a receipt");
    if (progress.state === "receiving") {
      for (let offset = progress.receivedBytes; offset < p.bytes.length;) {
        const end = Math.min(offset + 262144, p.bytes.length);
        const ack = value(
          await this.storage.writeChunk(
            { write: p.write, offset, data: p.bytes.subarray(offset, end).toString("base64") },
            signal,
          ),
        );
        if (ack.receivedBytes !== end)
          throw new LabStorageError("offset", "Profile acknowledgement mismatch");
        offset = end;
      }
      const sealed = value(await this.storage.sealWrite({ write: p.write }, signal));
      if (
        sealed.write !== p.write ||
        sealed.id !== p.id ||
        !["sealed", "committed"].includes(sealed.state)
      )
        throw new LabStorageError("receipt", "Profile seal mismatch");
    }
    const result = value(await this.storage.commitWrite({ write: p.write }, signal)),
      meta = result.record;
    if (
      meta.id !== p.id ||
      meta.kind !== p.input.kind ||
      meta.schemaVersion !== 2 ||
      meta.mediaType !== p.input.mediaType ||
      meta.byteLength !== p.bytes.length ||
      meta.sha256 !== p.input.sha256 ||
      meta.revision !== result.receipt.revision ||
      !result.receipt.commitId ||
      !["file-sync-only", "file-and-directory-sync"].includes(result.receipt.durability)
    )
      throw new LabStorageError("receipt", "Profile receipt mismatch");
    const confirmed = immutableSnapshot(meta);
    this.#confirmed.set(p.modelId, { sha256: p.input.sha256, meta: confirmed });
    this.#pending = undefined;
    return confirmed;
  }
}
