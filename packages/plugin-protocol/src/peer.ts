import type { z } from "zod";
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
  method: RequestMethod;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

const encoder = new TextEncoder();
const tooLarge = (text: string) =>
  text.length > PLUGIN_LIMITS.messageBytes ||
  encoder.encode(text).length > PLUGIN_LIMITS.messageBytes;
const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(
    0,
    PLUGIN_LIMITS.errorMessageLength,
  );
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
    if (options.signal?.aborted)
      return Promise.reject(new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`));
    const parsed = (requestMethods[method].params as z.ZodType).parse(params);
    const id = this.#nextId++;
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
      const abandon = (error: RpcError) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        pending.cleanup();
        this.#pending.delete(id);
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
    const text = JSON.stringify(message);
    if (tooLarge(text)) throw new RpcError(RPC_ERRORS.internalError, "Message exceeds 1 MiB.");
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
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return this.#protocolError("Message is not valid JSON.");
    }
    const parsed = jsonRpcMessageSchema.safeParse(value);
    if (!parsed.success) return this.#protocolError("Message is not a valid JSON-RPC 2.0 message.");
    const message = parsed.data;
    if ("method" in message) {
      if ("id" in message) void this.#onRequest(message.id, message.method, message.params);
      else this.#onNotification(message.method, message.params);
    } else if ("result" in message) this.#onResponse(message.id, { result: message.result });
    else if (message.id === null) this.#protocolError(`Peer reported: ${message.error.message}`);
    else this.#onResponse(message.id, { error: message.error });
  }

  async #onRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const handler = this.#handlers.get(method);
    const definition = own<Definition>(requestMethods, method);
    if (!handler || !definition)
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
    if (!input.success)
      return this.#trySend({
        jsonrpc: "2.0",
        id,
        error: { code: RPC_ERRORS.invalidParams, message: `Invalid parameters for ${method}.` },
      });
    const controller = new AbortController();
    this.#incoming.set(id, controller);
    try {
      const result = definition.result.parse(
        await handler(input.data, { signal: controller.signal }),
      );
      if (controller.signal.aborted)
        throw new RpcError(RPC_ERRORS.requestCancelled, `${method} was cancelled.`);
      if (!this.#closed) this.#trySend({ jsonrpc: "2.0", id, result });
    } catch (error) {
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
      this.#incoming.delete(id);
    }
  }

  #onNotification(method: string, params: unknown): void {
    const schema = own<z.ZodType>(notificationMethods, method);
    if (!schema) return; // Unknown notifications are ignored, as JSON-RPC allows.
    const input = schema.safeParse(params);
    if (!input.success) return this.#protocolError(`Invalid parameters for ${method}.`);
    if (method === "$/cancelRequest")
      this.#incoming.get((input.data as { id: JsonRpcId }).id)?.abort();
    else this.#notificationHandlers.get(method)?.(input.data);
  }

  #onResponse(
    id: JsonRpcId,
    outcome: { result: unknown } | { error: { code: number; message: string } },
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
    if ("error" in outcome)
      return pending.reject(new RpcError(outcome.error.code, outcome.error.message));
    const result = requestMethods[pending.method].result.safeParse(outcome.result);
    if (result.success) pending.resolve(result.data);
    else
      pending.reject(
        new RpcError(RPC_ERRORS.internalError, `Invalid result for ${pending.method}.`),
      );
  }
}
