import { describe, expect, it, vi } from "vitest";
import { ContextCommands, type ContextCommandContext } from "./commands.js";
import type { CommandInvocation } from "@kobrixa/plugin-protocol";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const call = (n = 1): CommandInvocation => ({
  version: 1,
  invocationId: id(n),
  command: "test.ui.run",
  arguments: {},
  context: {
    contextRef: null,
    origin: "management",
    locale: "en",
    trigger: { kind: "activate" },
    actionRef: id(99),
  },
});
describe("U06/U07 B1-RF3 context commands", () => {
  it("deduplicates pending and completed calls without promoting invocationId to actionRef", async () => {
    const commands = new ContextCommands("test.ui");
    let release!: () => void;
    const wait = new Promise<void>((r) => {
      release = r;
    });
    const handler = vi.fn(async (ctx: ContextCommandContext) => {
      await wait;
      return { output: { action: ctx.context.actionRef ?? null }, fieldErrors: [] };
    });
    commands.registerContext("test.ui.run", {}, handler);
    const signal = new AbortController().signal;
    const a = commands.invoke(call(), signal);
    const b = commands.invoke(call(), signal);
    release();
    expect(await a).toEqual(await b);
    expect(await commands.invoke(call(), signal)).toEqual(await a);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await a).toMatchObject({ ok: true, value: { output: { action: id(99) } } });
    expect(call().invocationId).not.toBe(id(99));
  });
  it("refuses changed payload under the same ID and never invokes a foreign namespace", async () => {
    const commands = new ContextCommands("test.ui");
    const handler = vi.fn(async () => ({ output: {}, fieldErrors: [] }));
    commands.registerContext("test.ui.run", {}, handler);
    const signal = new AbortController().signal;
    await commands.invoke(call(), signal);
    await expect(commands.invoke({ ...call(), command: "other.ui.run" }, signal)).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("caches sanitized failure and cancellation; late completion cannot replay", async () => {
    const commands = new ContextCommands("test.ui");
    const bad = vi.fn(async () => {
      throw new Error("/private/secret stack");
    });
    commands.registerContext("test.ui.run", {}, bad);
    const signal = new AbortController().signal;
    const result = await commands.invoke(call(), signal);
    expect(result).toEqual({
      ok: false,
      error: { code: "PLUGIN_E_COMMAND_FAILED", message: "Command failed." },
    });
    expect(await commands.invoke(call(), signal)).toEqual(result);
    expect(bad).toHaveBeenCalledTimes(1);
    const stop = new AbortController();
    stop.abort();
    expect(await commands.invoke(call(2), stop.signal)).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_E_CANCELLED" },
    });
    expect(bad).toHaveBeenCalledTimes(1);
  });
  it("bounds pending calls and does not evict pending work", async () => {
    const commands = new ContextCommands("test.ui");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    commands.registerContext("test.ui.run", {}, async () => {
      await gate;
      return { output: {}, fieldErrors: [] };
    });
    const signal = new AbortController().signal;
    const pending = Array.from({ length: 16 }, (_, n) => commands.invoke(call(n + 1), signal));
    expect(await commands.invoke(call(17), signal)).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_E_RESOURCE_LIMIT" },
    });
    release();
    await Promise.all(pending);
  });
});

it("U07 times out at thirty seconds and ignores a late successful handler", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ContextCommands("test.ui", () => Date.now());
    const handler = vi.fn(async () => {
      await gate;
      return { output: { late: true }, fieldErrors: [] };
    });
    registry.registerContext("test.ui.run", {}, handler);
    const signal = new AbortController().signal;
    const pending = registry.invoke(call(), signal);
    await vi.advanceTimersByTimeAsync(30000);
    expect(await pending).toMatchObject({ ok: false, error: { code: "PLUGIN_E_TIMEOUT" } });
    release();
    await Promise.resolve();
    expect(await registry.invoke(call(), signal)).toMatchObject({
      ok: false,
      error: { code: "PLUGIN_E_TIMEOUT" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it.each([16384, 16385])(
  "U07 SDK dispatch validates %i serialized argument bytes",
  async (bytes) => {
    const args = {
      a: "a".repeat(4000),
      b: "b".repeat(4000),
      c: "c".repeat(4000),
      d: "界".repeat(1000),
    };
    args.d += "x".repeat(bytes - Buffer.byteLength(JSON.stringify(args)));
    expect(Buffer.byteLength(JSON.stringify(args))).toBe(bytes);
    const registry = new ContextCommands("test.ui");
    const handler = vi.fn(() => ({ output: {}, fieldErrors: [] }));
    registry.registerContext(
      "test.ui.run",
      Object.fromEntries(
        Object.keys(args).map((key) => [
          key,
          { type: "string" as const, maxLength: 4000, nullable: false },
        ]),
      ),
      handler,
    );
    const result = registry.invoke(
      {
        ...call(),
        arguments: args,
        context: {
          ...call().context,
          origin: "panel",
          binding: {
            contributionId: "test.ui.panel",
            panelInstance: id(2),
            kind: "panel",
            uiResourceGeneration: 1,
            generation: 1,
            hostEpoch: id(3),
            processEpoch: id(4),
          },
          form: { revision: 1, values: {} },
        },
      },
      new AbortController().signal,
    );
    if (bytes === 16384) {
      expect(await result).toMatchObject({ ok: true });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]).toBeDefined();
    } else {
      await expect(result).rejects.toMatchObject({ code: -32602 });
      expect(handler).not.toHaveBeenCalled();
    }
  },
);

import { createMemoryChannelPair, RpcPeer } from "@kobrixa/plugin-protocol";
it("U07 lost ordinary command reply times out; a late reply and same-invocation retry never replay its mutation", async () => {
  vi.useFakeTimers();
  const [hostEnd, pluginEnd] = createMemoryChannelPair();
  let held: string | undefined;
  const registry = new ContextCommands("test.ui");
  let mutations = 0;
  const invocations: string[] = [];
  registry.registerContext("test.ui.run", {}, (ctx) => {
    invocations.push(ctx.invocationId);
    mutations++;
    return { output: { mutations }, fieldErrors: [] };
  });
  const plugin = new RpcPeer({
    ...pluginEnd,
    send: (text) => {
      const message = JSON.parse(text);
      if ("result" in message && held === undefined) held = text;
      else pluginEnd.send(text);
    },
  });
  const host = new RpcPeer(hostEnd);
  plugin.handle("command/invoke", (input, context) => registry.invoke(input, context.signal));
  try {
    const first = host.request("command/invoke", call(), { timeoutMs: 100 });
    const rejected = expect(first).rejects.toMatchObject({ code: -32001 });
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBeDefined();
    expect(invocations).toEqual([call().invocationId]);
    expect(mutations).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    pluginEnd.send(held!);
    await vi.advanceTimersByTimeAsync(0);
    expect(invocations).toEqual([call().invocationId]);
    expect(mutations).toBe(1);
    expect(await host.request("command/invoke", call())).toMatchObject({
      ok: true,
      value: { output: { mutations: 1 } },
    });
    expect(invocations).toEqual([call().invocationId]);
    expect(mutations).toBe(1);
  } finally {
    host.close();
    plugin.close();
    vi.useRealTimers();
  }
});
