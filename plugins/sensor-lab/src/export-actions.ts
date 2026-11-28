import { createHash } from "node:crypto";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import { recordingCsv } from "./model/csv.js";
import { snapshotRecording, type Recording } from "./model/data.js";
import { LabStorageError } from "./persistence.js";
type Actions = PluginContext["actions"];
export type PreparedCsv = { bytes: Buffer; sha256: string; suggestedName: string };
const MAX = 8388608;
function value<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new LabStorageError(r.error.code, r.error.message);
  return r.value;
}
export function prepareCsv(
  record: Recording,
  interval?: { startMs: number; endMs: number },
): PreparedCsv {
  const original = snapshotRecording(record);
  if (
    interval &&
    (!Number.isFinite(interval.startMs) ||
      !Number.isFinite(interval.endMs) ||
      interval.startMs < 0 ||
      interval.endMs < interval.startMs ||
      interval.endMs > original.durationMs)
  )
    throw new LabStorageError("interval", "Choose a valid explicit recording interval");
  const selected = interval
    ? {
        ...original,
        frames: original.frames.filter(
          (f) => f.elapsedMs >= interval.startMs && f.elapsedMs <= interval.endMs,
        ),
      }
    : original;
  const bytes = Buffer.from(recordingCsv(selected), "utf8");
  if (bytes.length > MAX)
    throw new LabStorageError(
      "size",
      "CSV exceeds 8 MiB; choose an explicit smaller time interval",
    );
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    suggestedName: "sensor-lab.csv",
  };
}
export async function copyCalibrationCode(
  actions: Actions,
  actionRef: string,
  code: string,
  signal?: AbortSignal,
): Promise<void> {
  const result = value(await actions.copyText({ actionRef, text: code }, signal));
  if (!result.copied) throw new LabStorageError("receipt", "Clipboard write was not confirmed");
}
export type LabExportState = Readonly<{
  phase: "idle" | "waiting" | "writing" | "completed" | "cancelled" | "error" | "unknown";
  error?: string;
}>;
/** The fresh gesture is consumed once before returning to the command. The native
 * dialog and original export continue independently of the short command timeout. */
export class LabExport {
  #state: LabExportState = { phase: "idle" };
  #control = new AbortController();
  #job: string | undefined;
  #starting = false;
  #running = false;
  #reconciling = false;
  #completion: Promise<void> | undefined;
  #disposed = false;
  constructor(
    private readonly actions: Actions,
    private readonly onChange?: (state: LabExportState) => void,
  ) {}
  get state(): LabExportState {
    return this.#state;
  }
  get completion(): Promise<void> | undefined {
    return this.#completion;
  }
  #set(state: LabExportState) {
    this.#state = Object.freeze(state);
    try {
      this.onChange?.(this.#state);
    } catch {
      /* Observer failure must not change export outcome. */
    }
  }
  async start(
    actionRef: string,
    prepared: PreparedCsv,
    invocationSignal?: AbortSignal,
  ): Promise<void> {
    if (
      this.#disposed ||
      this.#starting ||
      this.#reconciling ||
      this.#job ||
      this.#state.phase === "unknown"
    )
      throw new LabStorageError("busy", "An export is already active or unresolved");
    const bytes = Buffer.from(prepared.bytes);
    if (bytes.length > MAX || createHash("sha256").update(bytes).digest("hex") !== prepared.sha256)
      throw new LabStorageError("checksum", "Invalid prepared CSV");
    const sha256 = prepared.sha256,
      suggestedName = prepared.suggestedName;
    let unknownAdmission = false;
    this.#starting = true;
    this.#set({ phase: "waiting" });
    try {
      let begun;
      try {
        begun = await this.actions.exportBegin(
          { actionRef, suggestedName, mediaType: "text/csv", byteLength: bytes.length, sha256 },
          invocationSignal,
        );
      } catch (error) {
        unknownAdmission = true;
        this.#set({ phase: "unknown", error: "Export admission outcome unknown" });
        throw error;
      }
      const admitted = value(begun);
      this.#job = admitted.export;
      // A disposed view/process cannot revive a delayed native destination job.
      if (this.#disposed) {
        await this.actions.exportCancel({ export: admitted.export }).catch(() => {});
        return;
      }
      this.#running = true;
      this.#completion = this.#run(
        admitted.export,
        bytes,
        Math.min(admitted.expiresAt, Date.now() + 120000),
      );
    } catch (error) {
      if (!unknownAdmission)
        this.#set({
          phase: "error",
          error: error instanceof Error ? error.message : "Export failed",
        });
      throw error;
    } finally {
      this.#starting = false;
    }
  }
  /** Query only the original admitted job. No begin/chunk/commit or new gesture. */
  async reconcile(signal?: AbortSignal): Promise<LabExportState> {
    if (this.#disposed) throw new LabStorageError("disposed", "Export owner disposed");
    if (this.#starting || this.#running || this.#reconciling)
      throw new LabStorageError("busy", "Export is still active");
    const job = this.#job;
    if (!job) {
      if (this.#state.phase === "unknown")
        throw new LabStorageError("uncertain", "Export admission outcome unknown");
      return this.#state;
    }
    this.#reconciling = true;
    try {
      const status = value(await this.actions.exportStatus({ export: job }, signal));
      if (this.#disposed || signal?.aborted || this.#job !== job) return this.#state;
      if (status.state === "completed") {
        if (
          !status.commitId ||
          !status.durability ||
          !["file-sync-only", "file-and-directory-sync"].includes(status.durability)
        )
          throw new LabStorageError("receipt", "Export completion not confirmed");
        this.#job = undefined;
        this.#set({ phase: "completed" });
      } else if (["cancelled", "expired", "failed"].includes(status.state)) {
        this.#job = undefined;
        this.#set(
          status.state === "cancelled"
            ? { phase: "cancelled" }
            : { phase: "error", error: `Export ${status.state}` },
        );
      } else {
        this.#set({ phase: "unknown", error: "Export publication outcome unknown" });
      }
      return this.#state;
    } finally {
      this.#reconciling = false;
    }
  }
  async #pause(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, 100);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  async #run(job: string, bytes: Buffer, deadline: number): Promise<void> {
    const signal = this.#control.signal;
    let publishing = false;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new LabStorageError("expired", "Export expired");
        const status = value(await this.actions.exportStatus({ export: job }, signal));
        if (status.state === "receiving") {
          if (status.receivedBytes !== 0)
            throw new LabStorageError("offset", "Unexpected export offset");
          break;
        }
        if (status.state === "cancelled") {
          this.#set({ phase: "cancelled" });
          return;
        }
        if (status.state !== "waiting")
          throw new LabStorageError(status.state, "Export is not ready");
        await this.#pause(signal);
      }
      this.#set({ phase: "writing" });
      for (let offset = 0; offset < bytes.length;) {
        signal.throwIfAborted();
        const end = Math.min(offset + 262144, bytes.length);
        const ack = value(
          await this.actions.exportChunk(
            { export: job, offset, data: bytes.subarray(offset, end).toString("base64") },
            signal,
          ),
        );
        if (ack.receivedBytes !== end)
          throw new LabStorageError("offset", "Unexpected export acknowledgement");
        offset = end;
      }
      publishing = true;
      const committed = value(await this.actions.exportCommit({ export: job }, signal));
      if (!committed.exported || !committed.commitId || !committed.durability)
        throw new LabStorageError("receipt", "Export completion not confirmed");
      this.#set({ phase: "completed" });
    } catch (error) {
      if (publishing) {
        // Reconcile only the original job. A lost commit reply never starts another export.
        try {
          const status = value(await this.actions.exportStatus({ export: job }));
          if (status.state === "completed" && status.commitId && status.durability) {
            this.#set({ phase: "completed" });
            return;
          }
          if (status.state === "publishing") {
            this.#set({ phase: "unknown", error: "Export publication outcome unknown" });
            return;
          }
        } catch {
          this.#set({ phase: "unknown", error: "Export publication outcome unknown" });
          return;
        }
      }
      const cancelled = await this.actions.exportCancel({ export: job }).catch(() => undefined);
      if (cancelled?.ok && cancelled.value.disposition === "committed" && cancelled.value.commitId)
        this.#set({ phase: "completed" });
      else if (!cancelled?.ok || cancelled.value.disposition === "unknown")
        this.#set({ phase: "unknown", error: "Export cancellation outcome unknown" });
      else
        this.#set({
          phase: this.#disposed ? "cancelled" : "error",
          error: error instanceof Error ? error.message : "Export failed",
        });
    } finally {
      this.#running = false;
      if (this.#state.phase !== "unknown") this.#job = undefined;
    }
  }
  dispose(): void {
    this.#disposed = true;
    this.#control.abort();
    if (this.#job) void this.actions.exportCancel({ export: this.#job }).catch(() => {});
  }
}
