import { uiRequestSchemas } from "./ui-methods.js";
import { validUiWireV2, isUiDataMethod, supportsUiV2 } from "./ui-v2-session.js";
import { validUiWire } from "./ui-validation.js";
import type { z } from "zod";
import { validateDeviceWire } from "./device-validation.js";
import { RPC_ERRORS } from "./errors.js";
import { PLUGIN_LIMITS } from "./limits.js";
import {
  notificationMethods,
  requestMethods,
  type NotificationMethod,
  type NotificationParamsOf,
  type ParamsOf,
  type RequestMethod,
  type ResultOf,
} from "./methods.js";
import { jsonRpcMessageSchema, type JsonRpcId } from "./rpc.js";

// The envelope has already passed JSON.parse. Preserve the last top-level member's
// original whitespace and escape expansion for the payload byte budget.
function serializedMember(text: string, field: string): string | undefined {
  let depth = 0,
    key = "";
  let start: number | undefined, found: string | undefined;
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g)) {
    const token = match[0];
    if (depth === 1) {
      if (token === "," || token === "}") {
        if (start !== undefined && key === field) found = text.slice(start, match.index);
        start = undefined;
        key = "";
      } else if (token === ":") start = match.index + 1;
      else if (start === undefined && token.startsWith('"')) key = JSON.parse(token) as string;
    }
    if (token === "{" || token === "[") depth++;
    else if (token === "}" || token === "]") depth--;
  }
  return found;
}

export interface MessageChannelLike {
  send(text: string): void;
  onMessage(listener: (text: string) => void): () => void;
}
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}
export interface RequestContext {
  readonly signal: AbortSignal;
  afterReply(published: () => void, abandoned: () => void): void;
}
export interface RpcPeerOptions {
  timeoutMs?: number;
  cancelGraceMs?: number;
  onProtocolError?(error: RpcError): void;
  onUnresponsive?(method: string): void;
}
type Definition = { params: z.ZodType; result: z.ZodType };
type AnyHandler = (params: unknown, context: RequestContext) => unknown;
interface Pending {
  uiInput?: unknown;
  definition: Definition;
  uiEpoch: number;
  method: RequestMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

const encoder = new TextEncoder();
const tooLarge = (text: string) =>
  text.length > PLUGIN_LIMITS.messageBytes ||
  encoder.encode(text).length > PLUGIN_LIMITS.messageBytes;
const errorText = (error: unknown) => {
  try {
    return (error instanceof Error ? error.message : String(error)).slice(
      0,
      PLUGIN_LIMITS.errorMessageLength,
    );
  } catch {
    return "Unknown error";
  }
};
// Method names come from the peer: look them up as own properties only, so names such as
// "constructor" or "__proto__" never resolve to inherited Object members.
const own = <T>(table: object, key: string): T | undefined =>
  Object.hasOwn(table, key) ? ((table as Record<string, T>)[key] as T) : undefined;
const invokeCallback = (callback: () => void): void => {
  try {
    callback();
  } catch {
    /* Callback failures must not escape into a channel listener or timer. */
  }
};

export class RpcPeer {
  #nextId = 1;
  #uiCandidate = false;
  #uiEpoch = 0;
  #uiVersion: 1 | 2 | null = null;
  #uiReady = false;
  readonly #incomingMethods = new Map<JsonRpcId, string>();
  get uiSessionEpoch(): number {
    return this.#uiEpoch;
  }
  get uiResourceVersion(): 1 | 2 | null {
    return this.#uiVersion;
  }
  /** Lifecycle attachment calls this only from initialized/negotiated host state. */
  setUiSession(version: 1 | 2 | null, ready = false): void {
    if (version === 2 && !this.#uiCandidate) throw new Error("UI v2 was not initialized.");
    if (version === null) this.#uiEpoch++;
    this.#uiVersion = version;
    this.#uiReady = ready && version !== null;
  }
  setUiCandidate(enabled: boolean): void {
    this.#uiCandidate = enabled;
    this.setUiSession(null);
  }
  #definition(method: string): Definition | undefined {
    if (method === "ui/negotiate" ? !this.#uiCandidate : this.#uiVersion !== 2) {
      const old = own<Definition>(uiRequestSchemas, method);
      if (old) return old;
    }
    return own<Definition>(requestMethods, method);
  }
  #valid(method: string, phase: "params" | "result", value: unknown, params?: unknown): boolean {
    return (this.#uiCandidate ? validUiWireV2 : validUiWire)(method, phase, value, params);
  }
  #observe(method: string, result: unknown, initializeOffer?: unknown): void {
    // Only an outgoing initialize's correlated, validated offer/reply can enable
    // the caller side. Incoming params alone never establish remote support.
    if (method === "initialize" && initializeOffer !== undefined) {
      const offer = requestMethods.initialize.params.parse(initializeOffer);
      const reply = requestMethods.initialize.result.parse(result);
      this.setUiCandidate(supportsUiV2(offer.apiVersion) && supportsUiV2(reply.apiVersion));
    }
    const reply = result as {
      ok?: boolean;
      value?: { uiResourceVersions?: number[]; commandEnvelopeVersions?: number[] };
    };
    if (method === "ui/negotiate") {
      const versions =
        reply.ok && reply.value?.commandEnvelopeVersions?.includes(1)
          ? (reply.value.uiResourceVersions ?? [])
          : [];
      this.setUiSession(versions.includes(2) ? 2 : versions.includes(1) ? 1 : null);
    }
    if (method === "ui/ready") this.#uiReady = !!reply.ok && this.#uiVersion !== null;
  }
  #closed: RpcError | undefined;
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #abandoned = new Map<JsonRpcId, ReturnType<typeof setTimeout>>();
  readonly #incoming = new Map<JsonRpcId, AbortController>();
  readonly #handlers = new Map<string, AnyHandler>();
  readonly #notificationHandlers = new Map<string, (params: unknown) => void>();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly channel: MessageChannelLike,
    private readonly options: RpcPeerOptions = {},
  ) {
    this.#unsubscribe = channel.onMessage((text) => {
      // Nothing a peer sends may throw into the transport's event loop (the Electron main process).
      try {
        this.#receive(text);
      } catch (error) {
        this.#protocolError(`Failed to process a message: ${errorText(error)}`);
      }
    });
  }

  get closed(): boolean {
    return this.#closed !== undefined;
  }

  handle<M extends RequestMethod>(
    method: M,
    handler: (
      params: z.output<(typeof requestMethods)[M]["params"]>,
      context: RequestContext,
    ) =>
      | z.input<(typeof requestMethods)[M]["result"]>
      | Promise<z.input<(typeof requestMethods)[M]["result"]>>,
  ): void {
    this.#handlers.set(method, handler as AnyHandler);
  }

  onNotification<M extends Exclude<NotificationMethod, "$/cancelRequest">>(
    method: M,
    handler: (params: NotificationParamsOf<M>) => void,
  ): void {
    this.#notificationHandlers.set(method, handler as (params: unknown) => void);
  }

  request<M extends RequestMethod>(
    method: M,
    params: ParamsOf<M>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ResultOf<M>> {
    if (this.#closed) return Promise.reject(this.#closed);
    // Initialization is not capability negotiation until a successful reply.
    // Clear even for a pre-aborted or locally invalid initialization attempt.
    if (method === "initialize") this.setUiCandidate(false);
    if (options.signal?.aborted)
      return Promise.reject(new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`));
    if (isUiDataMethod(method) && (this.#uiVersion !== 2 || !this.#uiReady))
      return Promise.reject(new RpcError(RPC_ERRORS.invalidRequest, "UI v2 data is not ready."));
    if (method === "shutdown") this.setUiSession(null);
    const definition = this.#definition(method)!;
    const parsed = definition.params.parse(params);
    validateDeviceWire(`${method}.params`, parsed);
    if (!this.#valid(method, "params", params))
      return Promise.reject(
        new RpcError(RPC_ERRORS.invalidParams, `Invalid parameters for ${method}.`),
      );
    if (method === "ui/negotiate") this.setUiSession(null);
    const uiEpoch = this.#uiEpoch;
    if (method === "ui/ready") this.#uiReady = this.#uiVersion !== null;
    const id = this.#nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
      const abandon = (error: RpcError) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.cleanup();
        this.#pending.delete(id);
        if (uiEpoch === this.#uiEpoch && (method === "ui/ready" || method === "ui/negotiate"))
          this.setUiSession(null);
        this.#abandoned.set(
          id,
          setTimeout(() => {
            this.#abandoned.delete(id);
            invokeCallback(() => this.options.onUnresponsive?.(method));
          }, this.options.cancelGraceMs ?? 5_000),
        );
        reject(error);
        this.#trySend({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
      };
      const onAbort = () =>
        abandon(new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`));
      const timer = setTimeout(
        () =>
          abandon(new RpcError(RPC_ERRORS.timeout, `${method} timed out after ${timeoutMs} ms.`)),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        uiInput: structuredClone(parsed),
        definition,
        uiEpoch,
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params: parsed });
      } catch (error) {
        this.#pending.get(id)?.cleanup();
        this.#pending.delete(id);
        if (uiEpoch === this.#uiEpoch && (method === "ui/ready" || method === "ui/negotiate"))
          this.setUiSession(null);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify<M extends NotificationMethod>(
    method: M,
    params: z.input<(typeof notificationMethods)[M]>,
  ): void {
    if (this.#closed) return;
    this.#send({
      jsonrpc: "2.0",
      method,
      params: (notificationMethods[method] as z.ZodType).parse(params),
    });
  }

  close(error = new RpcError(RPC_ERRORS.connectionClosed, "The connection was closed.")): void {
    if (this.#closed) return;
    this.setUiSession(null);
    this.#closed = error;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const timer of this.#abandoned.values()) clearTimeout(timer);
    this.#abandoned.clear();
    for (const controller of this.#incoming.values()) controller.abort();
  }

  #send(message: object): void {
    const wire = message as { id?: JsonRpcId; method?: string; params?: { kind?: string } };
    const method =
      wire.method ?? (wire.id === undefined ? undefined : this.#incomingMethods.get(wire.id));
    if (wire.method) validateDeviceWire(`${wire.method}.params`, wire.params);
    const text = JSON.stringify(message);
    if (tooLarge(text)) throw new RpcError(RPC_ERRORS.internalError, "Message exceeds 1 MiB.");
    if ((method && isUiDataMethod(method)) || wire.params?.kind === "ui.data") {
      if (encoder.encode(text).length > 65536)
        throw new RpcError(RPC_ERRORS.internalError, "UI data frame exceeds 64 KiB.");
    }
    if (wire.params?.kind === "ui.data" && (this.#uiVersion !== 2 || !this.#uiReady))
      throw new RpcError(RPC_ERRORS.invalidRequest, "UI v2 data is not ready.");
    this.channel.send(text);
  }

  #trySend(message: object): void {
    try {
      this.#send(message);
    } catch {
      /* The channel is gone; the close path reports the failure. */
    }
  }

  #protocolError(message: string): void {
    invokeCallback(() =>
      this.options.onProtocolError?.(new RpcError(RPC_ERRORS.invalidRequest, message)),
    );
  }

  #receive(text: string): void {
    if (this.#closed) return;
    if (tooLarge(text)) return this.#protocolError("Message exceeds 1 MiB.");
    const frameBytes = encoder.encode(text).length;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.#protocolError("Message is not valid JSON.");
    }
    const parsed = jsonRpcMessageSchema.safeParse(value);
    if (!parsed.success) return this.#protocolError("Message is not a valid JSON-RPC 2.0 message.");
    const message = parsed.data;
    const method =
      "method" in message
        ? message.method
        : message.id === null
          ? undefined
          : this.#pending.get(message.id)?.method;
    const dataEvent =
      "method" in message &&
      message.method === "events/deliver" &&
      message.params?.kind === "ui.data";
    if (((method && isUiDataMethod(method)) || dataEvent) && frameBytes > 65536) {
      if (!("method" in message) && message.id !== null) {
        const pending = this.#pending.get(message.id);
        pending?.cleanup();
        this.#pending.delete(message.id);
        pending?.reject(new RpcError(RPC_ERRORS.internalError, "UI data frame exceeds 64 KiB."));
      } else if ("id" in message)
        this.#trySend({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: RPC_ERRORS.invalidParams, message: "UI data frame exceeds 64 KiB." },
        });
      else this.#protocolError("UI data frame exceeds 64 KiB.");
      return;
    }
    if (dataEvent && (this.#uiVersion !== 2 || !this.#uiReady))
      return this.#protocolError("UI data event before v2 ready.");
    if ("method" in message) {
      if ("id" in message)
        void this.#onRequest(
          message.id,
          message.method,
          message.params,
          serializedMember(text, "params"),
        );
      else this.#onNotification(message.method, message.params, serializedMember(text, "params"));
    } else if ("result" in message)
      this.#onResponse(message.id, { result: message.result }, serializedMember(text, "result"));
    else if (message.id === null) this.#protocolError(`Peer reported: ${message.error.message}`);
    else this.#onResponse(message.id, { error: message.error });
  }

  async #onRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
    serialized?: string,
  ): Promise<void> {
    const handler = this.#handlers.get(method);
    const definition = this.#definition(method);
    if (
      !handler ||
      !definition ||
      (isUiDataMethod(method) && (this.#uiVersion !== 2 || !this.#uiReady))
    )
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.methodNotFound, message: `Unknown method ${method}.` },
      });
    if (this.#incoming.has(id))
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.invalidRequest, message: "Duplicate request id." },
      });
    const input = definition.params.safeParse(params);
    if (!input.success || !this.#valid(method, "params", params))
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.invalidParams, message: `Invalid parameters for ${method}.` },
      });
    try {
      validateDeviceWire(`${method}.params`, input.data, serialized);
    } catch {
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.invalidParams, message: `Invalid parameters for ${method}.` },
      });
    }
    if (method === "ui/negotiate") this.setUiSession(null);
    const uiEpoch = this.#uiEpoch;
    const controller = new AbortController();
    this.#incoming.set(id, controller);
    this.#incomingMethods.set(id, method);
    let outcome: "pending" | "published" | "abandoned" = "pending";
    const callbacks: Array<{ published: () => void; abandoned: () => void }> = [];
    const settle = (next: "published" | "abandoned") => {
      if (outcome !== "pending") return;
      outcome = next;
      for (const pair of callbacks.splice(0)) invokeCallback(pair[next]);
    };
    const onAbort = () => settle("abandoned");
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const context: RequestContext = {
      signal: controller.signal,
      afterReply(published, abandoned) {
        if (outcome === "pending") callbacks.push({ published, abandoned });
        else invokeCallback(outcome === "published" ? published : abandoned);
      },
    };
    try {
      const rawResult = await handler(input.data, context);
      const result = definition.result.parse(rawResult);
      if (!this.#valid(method, "result", rawResult, input.data))
        throw new RpcError(RPC_ERRORS.internalError, `Invalid result for ${method}.`);
      validateDeviceWire(`${method}.result`, result);
      if (controller.signal.aborted)
        throw new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`);
      if (this.#closed) throw this.#closed;
      if (
        method.startsWith("ui/") &&
        uiEpoch !== this.#uiEpoch &&
        !(typeof result === "object" && result !== null && "ok" in result && result.ok === false)
      )
        throw new RpcError(RPC_ERRORS.requestCancelled, "UI session retired.");
      this.#send({ jsonrpc: "2.0", id, result });
      if (uiEpoch === this.#uiEpoch) this.#observe(method, result);
      settle("published");
    } catch (error) {
      if (uiEpoch === this.#uiEpoch && (method === "ui/ready" || method === "ui/negotiate"))
        this.setUiSession(null);
      settle("abandoned");
      const code = controller.signal.aborted
        ? RPC_ERRORS.requestCancelled
        : error instanceof RpcError
          ? error.code
          : RPC_ERRORS.internalError;
      if (!this.#closed)
        this.#trySend({
          jsonrpc: "2.0",
          id,
          error: {
            code,
            message: controller.signal.aborted ? `${method} was cancelled.` : errorText(error),
          },
        });
    } finally {
      settle("abandoned");
      controller.signal.removeEventListener("abort", onAbort);
      this.#incoming.delete(id);
      this.#incomingMethods.delete(id);
    }
  }

  #onNotification(method: string, params: unknown, serialized?: string): void {
    const schema = own<z.ZodType>(notificationMethods, method);
    if (!schema) return; // Unknown notifications are ignored, as JSON-RPC allows.
    const input = schema.safeParse(params);
    if (!input.success) return this.#protocolError(`Invalid parameters for ${method}.`);
    try {
      validateDeviceWire(`${method}.params`, input.data, serialized);
    } catch {
      return this.#protocolError(`Invalid parameters for ${method}.`);
    }
    if (method === "$/cancelRequest")
      this.#incoming.get((input.data as { id: JsonRpcId }).id)?.abort();
    else this.#notificationHandlers.get(method)?.(input.data);
  }

  #onResponse(
    id: JsonRpcId,
    outcome: { result: unknown } | { error: { code: number; message: string } },
    serialized?: string,
  ): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      const abandoned = this.#abandoned.get(id);
      if (abandoned === undefined)
        return this.#protocolError(`Unexpected response id ${String(id)}.`);
      clearTimeout(abandoned);
      this.#abandoned.delete(id);
      return;
    }
    pending.cleanup();
    this.#pending.delete(id);
    if (
      (pending.method === "initialize" || pending.method.startsWith("ui/")) &&
      pending.uiEpoch !== this.#uiEpoch
    )
      return pending.reject(new RpcError(RPC_ERRORS.requestCancelled, "UI session retired."));
    if ("error" in outcome) {
      if (pending.method === "ui/ready" || pending.method === "ui/negotiate")
        this.setUiSession(null);
      return pending.reject(new RpcError(outcome.error.code, outcome.error.message));
    }
    const result = pending.definition.result.safeParse(outcome.result);
    if (result.success && this.#valid(pending.method, "result", outcome.result, pending.uiInput)) {
      try {
        validateDeviceWire(`${pending.method}.result`, result.data, serialized);
        this.#observe(pending.method, result.data, pending.uiInput);
        pending.resolve(result.data);
      } catch {
        pending.reject(
          new RpcError(RPC_ERRORS.internalError, `Invalid result for ${pending.method}.`),
        );
      }
    } else {
      if (pending.method === "ui/ready" || pending.method === "ui/negotiate")
        this.setUiSession(null);
      pending.reject(
        new RpcError(RPC_ERRORS.internalError, `Invalid result for ${pending.method}.`),
      );
    }
  }
}
