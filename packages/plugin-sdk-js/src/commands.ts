import {
  RpcError,
  RPC_ERRORS,
  acceptsValue,
  validValueSpec,
  validateCommandInvocation,
  validateCommandValue,
  type CommandInvocation,
  type CommandValue,
  type Result,
  type UiScalar,
  type ValueSpec,
} from "@kobrixa/plugin-protocol";
export type ContextCommandContext = Readonly<CommandInvocation> & { readonly signal: AbortSignal };
export type ContextCommandHandler = (
  context: ContextCommandContext,
) => CommandValue | Promise<CommandValue>;
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function failure(
  code: "PLUGIN_E_CANCELLED" | "PLUGIN_E_TIMEOUT" | "PLUGIN_E_COMMAND_FAILED",
): Result<CommandValue> {
  return {
    ok: false,
    error: {
      code,
      message: code === "PLUGIN_E_COMMAND_FAILED" ? "Command failed." : "Command did not complete.",
    },
  };
}
export class ContextCommands {
  readonly #handlers = new Map<
    string,
    { arguments: Record<string, ValueSpec>; handler: ContextCommandHandler }
  >();
  readonly #pending = new Map<string, { key: string; promise: Promise<Result<CommandValue>> }>();
  readonly #completed = new Map<string, { key: string; value: Result<CommandValue>; at: number }>();
  constructor(
    readonly pluginId: string,
    private readonly now: () => number = () => performance.now(),
  ) {}
  registerContext(
    id: string,
    argumentsSchema: Record<string, ValueSpec>,
    handler: ContextCommandHandler,
  ): void {
    if (
      !id.startsWith(`${this.pluginId}.`) ||
      this.#handlers.has(id) ||
      Object.keys(argumentsSchema).length > 32 ||
      Object.entries(argumentsSchema).some(
        ([key, value]) =>
          !/^[a-z][a-z0-9-]{0,31}$/.test(key) ||
          ["constructor", "prototype", "__proto__"].includes(key) ||
          !validValueSpec(value),
      )
    )
      throw new TypeError("Invalid context command registration.");
    this.#handlers.set(id, { arguments: freeze(structuredClone(argumentsSchema)), handler });
  }
  async invoke(input: CommandInvocation, signal: AbortSignal): Promise<Result<CommandValue>> {
    const checked = validateCommandInvocation(input);
    if (!checked.ok) throw new RpcError(RPC_ERRORS.invalidParams, "Invalid command invocation.");
    const invocation = freeze(structuredClone(checked.value));
    const record = this.#handlers.get(invocation.command);
    if (!record || !invocation.command.startsWith(`${this.pluginId}.`))
      throw new RpcError(RPC_ERRORS.invalidParams, "Unknown context command.");
    if (
      Object.keys(record.arguments).length !== Object.keys(invocation.arguments).length ||
      Object.keys(record.arguments).some(
        (key) =>
          !Object.hasOwn(invocation.arguments, key) ||
          !acceptsValue(record.arguments[key]!, invocation.arguments[key] as UiScalar),
      )
    )
      throw new RpcError(RPC_ERRORS.invalidParams, "Invalid command arguments.");
    if (
      invocation.context.binding &&
      !invocation.context.binding.contributionId.startsWith(`${this.pluginId}.`)
    )
      throw new RpcError(RPC_ERRORS.invalidParams, "Foreign UI binding.");
    const key = canonical(invocation);
    for (const [id, done] of this.#completed)
      if (this.now() - done.at >= 30000) this.#completed.delete(id);
    const pending = this.#pending.get(invocation.invocationId);
    const done = this.#completed.get(invocation.invocationId);
    if (pending || done) {
      if ((pending?.key ?? done!.key) !== key)
        throw new RpcError(RPC_ERRORS.invalidParams, "Invocation ID was reused.");
      return pending ? pending.promise : structuredClone(done!.value);
    }
    if (this.#pending.size >= 16)
      return {
        ok: false,
        error: {
          code: "PLUGIN_E_RESOURCE_LIMIT",
          message: "Command queue is full.",
          detail: { kind: "resource", reason: "queue", resource: "rpc", limit: 16 },
        },
      };
    let resolve!: (value: Result<CommandValue>) => void;
    const promise = new Promise<Result<CommandValue>>((r) => {
      resolve = r;
    });
    this.#pending.set(invocation.invocationId, { key, promise });
    const local = new AbortController();
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: Result<CommandValue>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      this.#pending.delete(invocation.invocationId);
      this.#completed.set(invocation.invocationId, {
        key,
        value: structuredClone(value),
        at: this.now(),
      });
      while (this.#completed.size > 64)
        this.#completed.delete(this.#completed.keys().next().value!);
      resolve(value);
    };
    const cancel = () => {
      local.abort();
      finish(failure("PLUGIN_E_CANCELLED"));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    else {
      timer = setTimeout(() => {
        local.abort();
        finish(failure("PLUGIN_E_TIMEOUT"));
      }, 30000);
      Promise.resolve()
        .then(() => {
          if (local.signal.aborted) return undefined;
          return record.handler({ ...invocation, signal: local.signal });
        })
        .then(
          (value) => {
            if (finished) return;
            const valid = validateCommandValue(value, invocation);
            finish(valid.ok ? valid : failure("PLUGIN_E_COMMAND_FAILED"));
          },
          () => finish(failure("PLUGIN_E_COMMAND_FAILED")),
        );
    }
    return promise;
  }
}
