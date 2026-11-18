import {
  uiDataRequestSchemasV2,
  validateDatasetHeaderV2,
  validateDatasetChunkV2,
  validateUiDataReadValueV2,
  validateUiDataSnapshotValueV2,
  type UiBinding,
  type UiDataRequestMapV2,
} from "@kobrixa/plugin-protocol";

type Method = keyof UiDataRequestMapV2;
type Params<M extends Method> = UiDataRequestMapV2[M]["params"];
type Result<M extends Method> = UiDataRequestMapV2[M]["result"];
export interface UiDataRequestPort {
  <M extends Method>(
    method: M,
    params: Params<M>,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<Result<M>>;
}
/** Local v2 facade: not yet attached to PluginContext or public negotiation.
 * Readiness must be set by the negotiated UI lifecycle. Calls never retry,
 * choose revisions, cache payloads or convert cancellation into transfer abort.
 */
export class UiDataClient {
  #ready = false;
  #epoch = 0;
  constructor(private readonly request: UiDataRequestPort) {}
  markReady(): void {
    this.#epoch++;
    this.#ready = true;
  }
  retire(): void {
    this.#epoch++;
    this.#ready = false;
  }
  async #call<M extends Method>(
    method: M,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<Result<M>> {
    if (!this.#ready) throw new Error("UI v2 data is not ready.");
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const epoch = this.#epoch;
    const parsed = uiDataRequestSchemasV2[method].params.safeParse(input);
    if (!parsed.success) throw new TypeError("Invalid UI data parameters.");
    const params = parsed.data;
    if ("header" in params) validateDatasetHeaderV2(params.header);
    if ("chunk" in params) validateDatasetChunkV2(params.chunk);
    // Parsing creates the private request snapshot used to validate a later page.
    const result = await this.request(method, params as Params<M>, {
      timeoutMs: 5000,
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    if (!this.#ready || this.#epoch !== epoch) throw new Error("UI data session retired.");
    const checked = uiDataRequestSchemasV2[method].result.safeParse(result);
    if (!checked.success) throw new TypeError("Invalid UI data result.");
    if (checked.data.ok) {
      if (method === "ui/dataRead")
        validateUiDataReadValueV2(checked.data.value, params as Params<"ui/dataRead">);
      if (method === "ui/dataSnapshot") validateUiDataSnapshotValueV2(checked.data.value);
    }
    return checked.data as Result<M>;
  }
  begin(params: Params<"ui/dataBegin">, signal?: AbortSignal): Promise<Result<"ui/dataBegin">> {
    return this.#call("ui/dataBegin", params, signal);
  }
  chunk(params: Params<"ui/dataChunk">, signal?: AbortSignal): Promise<Result<"ui/dataChunk">> {
    return this.#call("ui/dataChunk", params, signal);
  }
  commit(params: Params<"ui/dataCommit">, signal?: AbortSignal): Promise<Result<"ui/dataCommit">> {
    return this.#call("ui/dataCommit", params, signal);
  }
  abort(params: Params<"ui/dataAbort">, signal?: AbortSignal): Promise<Result<"ui/dataAbort">> {
    return this.#call("ui/dataAbort", params, signal);
  }
  read(params: Params<"ui/dataRead">, signal?: AbortSignal): Promise<Result<"ui/dataRead">> {
    return this.#call("ui/dataRead", params, signal);
  }
  snapshot(binding: UiBinding, signal?: AbortSignal): Promise<Result<"ui/dataSnapshot">> {
    return this.#call("ui/dataSnapshot", { binding }, signal);
  }
}
