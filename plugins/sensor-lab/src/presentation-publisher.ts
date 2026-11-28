import { createHash } from "node:crypto";
import type { PluginContext } from "@kobrixa/plugin-sdk";
import {
  canonicalDatasetV2Bytes,
  type DatasetChunkV2,
  type DatasetV2,
  type UiBinding,
  type UiScalar,
} from "@kobrixa/plugin-protocol";
import { immutableSnapshot } from "./model/data.js";
function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
/** One panel writer; feature scheduler owns coalescing and the <=1Hz publish rate.
 * Dataset commits precede the single presentation CAS. No partially completed
 * batch is made visible by a scalar patch. */
export class LabPresentationPublisher {
  #busy = false;
  #abort = new AbortController();
  private readonly binding: UiBinding & { kind: "panel" };
  constructor(
    private readonly ui: PluginContext["ui"],
    binding: UiBinding,
  ) {
    if (binding.kind !== "panel") throw new Error("Panel binding required");
    this.binding = { ...binding, kind: "panel" };
  }
  dispose(): void {
    this.#abort.abort();
  }
  async publish(
    datasets: Readonly<Record<string, DatasetV2>>,
    fields: Readonly<Record<string, UiScalar>> = {},
  ): Promise<boolean> {
    if (this.#busy) throw new Error("Presentation publisher busy");
    if (this.#abort.signal.aborted) return false;
    if (Object.keys(datasets).length > 8) throw new Error("Dataset count exceeded");
    const snapshot = immutableSnapshot(datasets),
      set = { ...fields };
    this.#busy = true;
    let transfer: { handle: string; dataset: string } | undefined;
    const signal = this.#abort.signal;
    try {
      const initial = unwrap(await this.ui.state(this.binding, signal));
      if (!initial.visible || signal.aborted) return false;
      const metadata = unwrap(await this.ui.data.snapshot(this.binding, signal));
      const previous = initial.data.presentation;
      if (typeof previous !== "number" || !Number.isSafeInteger(previous) || previous < 0)
        throw new Error("Invalid presentation state");
      const presentation = Math.max(previous, ...metadata.datasets.map((d) => d.presentation)) + 1;
      if (!Number.isSafeInteger(presentation)) throw new Error("Presentation exhausted");
      for (const [dataset, data] of Object.entries(snapshot)) {
        const bytes = canonicalDatasetV2Bytes(data.header, data.entries);
        const begun = unwrap(
          await this.ui.data.begin(
            {
              binding: this.binding,
              dataset,
              baseRevision: metadata.datasets.find((m) => m.dataset === dataset)?.revision ?? 0,
              presentation,
              header: data.header,
              entryCount: data.entries.length,
              byteLength: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            },
            signal,
          ),
        );
        transfer = { handle: begun.transfer, dataset };
        let offset = 0;
        while (offset < data.entries.length) {
          const entries: unknown[] = [];
          for (let at = offset; at < data.entries.length && entries.length < 256; at++) {
            const proposed = [...entries, data.entries[at]];
            if (
              Buffer.byteLength(JSON.stringify({ kind: data.header.kind, entries: proposed })) >
              49152
            )
              break;
            entries.push(data.entries[at]);
          }
          if (!entries.length) throw new Error("Dataset entry exceeds chunk limit");
          // DatasetV2 already pairs header and entry kinds; the public SDK validates the chunk again.
          const chunk = { kind: data.header.kind, entries } as DatasetChunkV2;
          const result = unwrap(
            await this.ui.data.chunk(
              { binding: this.binding, dataset, transfer: transfer.handle, offset, chunk },
              signal,
            ),
          );
          if (result.nextOffset !== offset + entries.length)
            throw new Error("Unexpected dataset offset");
          offset = result.nextOffset;
        }
        unwrap(
          await this.ui.data.commit(
            { binding: this.binding, dataset, transfer: transfer.handle },
            signal,
          ),
        );
        transfer = undefined;
      }
      if (signal.aborted) return false;
      const current = unwrap(await this.ui.state(this.binding, signal));
      if (!current.visible || current.data.presentation !== previous || signal.aborted)
        return false;
      unwrap(await this.ui.patch(this.binding, current.revision, { ...set, presentation }, signal));
      return !signal.aborted;
    } finally {
      if (transfer) {
        // Best-effort cancellation does not extend the original transfer TTL.
        await this.ui.data
          .abort({ binding: this.binding, dataset: transfer.dataset, transfer: transfer.handle })
          .catch(() => {});
      }
      this.#busy = false;
    }
  }
}
