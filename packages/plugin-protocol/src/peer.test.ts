import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryChannelPair,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  type MessageChannelLike,
  type ParamsOf,
} from "./index.js";

afterEach(() => vi.useRealTimers());
const pair = (hostOptions = {}, pluginOptions = {}) => {
  const [a, b] = createMemoryChannelPair();
  return {
    host: new RpcPeer(a, hostOptions),
    plugin: new RpcPeer(b, pluginOptions),
    raw: b,
    hostRaw: a,
  };
};
const synchronousPair = (): [MessageChannelLike, MessageChannelLike] => {
  const listeners = [new Set<(text: string) => void>(), new Set<(text: string) => void>()] as const;
  const end = (self: 0 | 1): MessageChannelLike => ({
    send: (text) => listeners[self === 0 ? 1 : 0].forEach((listener) => listener(text)),
    onMessage: (listener) => {
      listeners[self].add(listener);
      return () => listeners[self].delete(listener);
    },
  });
  return [end(0), end(1)];
};
const init: ParamsOf<"initialize"> = {
  apiVersion: "1.0.0",
  pluginId: "acme.x",
  locale: "en",
  grantedPermissions: [],
};
const initResult = { apiVersion: "1.0.0", sdk: { name: "t", version: "1" } };

describe("RpcPeer", () => {
  it("routes requests and validates results", async () => {
    const { host, plugin } = pair();
    plugin.handle("initialize", (params) => ({
      ...initResult,
      sdk: { name: params.pluginId, version: "1" },
    }));
    await expect(host.request("initialize", init)).resolves.toEqual({
      ...initResult,
      sdk: { name: "acme.x", version: "1" },
    });
  });
  it("reports unknown methods, invalid params and handler errors", async () => {
    const { host, plugin } = pair();
    await expect(host.request("shutdown", {})).rejects.toMatchObject({
      code: RPC_ERRORS.methodNotFound,
    });
    plugin.handle("command/execute", () => {
      throw new RpcError(RPC_ERRORS.permissionDenied, "no");
    });
    await expect(host.request("command/execute", { command: "acme.x.y" })).rejects.toMatchObject({
      code: RPC_ERRORS.permissionDenied,
    });
    plugin.handle("shutdown", () => ({ unexpected: true }) as unknown as null);
    await expect(host.request("shutdown", {})).rejects.toMatchObject({
      code: RPC_ERRORS.internalError,
    });
  });
  it("cancels on timeout, then reports an unresponsive peer after the grace period", async () => {
    vi.useFakeTimers();
    const onUnresponsive = vi.fn();
    const { host, plugin } = pair({ cancelGraceMs: 50, onUnresponsive });
    let signal: AbortSignal | undefined;
    plugin.handle("command/execute", (_params, context) => {
      signal = context.signal;
      return new Promise(() => {});
    });
    const result = host.request("command/execute", { command: "acme.x.y" }, { timeoutMs: 100 });
    const assertion = expect(result).rejects.toMatchObject({ code: RPC_ERRORS.timeout });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(onUnresponsive).toHaveBeenCalledWith("command/execute");
  });
  it("drops a late response after cancellation without a protocol error", async () => {
    const onProtocolError = vi.fn();
    const onUnresponsive = vi.fn();
    const { host, plugin, hostRaw } = pair({
      onProtocolError,
      onUnresponsive,
      cancelGraceMs: 1000,
    });
    const replies: unknown[] = [];
    hostRaw.onMessage((text) => replies.push(JSON.parse(text)));
    plugin.handle("command/execute", async (_params, { signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve));
      return null;
    });
    const controller = new AbortController();
    const pending = host.request(
      "command/execute",
      { command: "acme.x.y" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: RPC_ERRORS.requestCancelled });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(replies).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32800, message: "command/execute was cancelled." },
      },
    ]);
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(onUnresponsive).not.toHaveBeenCalled();
  });
  it("treats malformed or oversized input as protocol errors", async () => {
    const onProtocolError = vi.fn();
    const [a, b] = createMemoryChannelPair();
    new RpcPeer(a, { onProtocolError });
    b.send("not json");
    b.send(JSON.stringify({ jsonrpc: "2.0", id: 99, result: null }));
    b.send(`"${"x".repeat(1024 * 1024)}"`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onProtocolError).toHaveBeenCalledTimes(3);
  });
  it("rejects pending requests on close and refuses new ones", async () => {
    const { host, plugin } = pair();
    plugin.handle("shutdown", () => new Promise(() => {}));
    const pending = host.request("shutdown", {});
    host.close(new RpcError(RPC_ERRORS.connectionClosed, "gone"));
    await expect(pending).rejects.toMatchObject({ code: RPC_ERRORS.connectionClosed });
    await expect(host.request("shutdown", {})).rejects.toMatchObject({
      code: RPC_ERRORS.connectionClosed,
    });
  });
  it("never resolves method names through the prototype chain", async () => {
    const onProtocolError = vi.fn();
    const [a, b] = createMemoryChannelPair();
    new RpcPeer(a, { onProtocolError });
    const replies: unknown[] = [];
    b.onMessage((text) => replies.push(JSON.parse(text)));
    // Names must pass the envelope's method pattern to reach the lookup ("__proto__" does not).
    for (const method of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(() => b.send(JSON.stringify({ jsonrpc: "2.0", method, params: {} }))).not.toThrow();
      b.send(JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} }));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onProtocolError).not.toHaveBeenCalled();
    expect(replies).toHaveLength(4);
    for (const reply of replies)
      expect(reply).toMatchObject({ error: { code: RPC_ERRORS.methodNotFound } });
  });
  it("delivers notifications", async () => {
    const { host, plugin } = pair();
    const exit = vi.fn();
    plugin.onNotification("exit", exit);
    host.notify("exit", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(exit).toHaveBeenCalledWith({});
  });
  it.each(["abort", "timeout"] as const)(
    "registers abandonment and rejects before a synchronous cancellation reply on %s",
    async (cause) => {
      vi.useFakeTimers();
      const [a, b] = synchronousPair();
      const onProtocolError = vi.fn();
      const onUnresponsive = vi.fn();
      const host = new RpcPeer(a, { cancelGraceMs: 50, onProtocolError, onUnresponsive });
      const events: string[] = [];
      b.onMessage((text) => {
        const message = JSON.parse(text) as { method: string; params: { id: number } };
        if (message.method !== "$/cancelRequest") return;
        queueMicrotask(() => events.push("cancel"));
        b.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.params.id,
            error: { code: RPC_ERRORS.requestCancelled, message: "shutdown was cancelled." },
          }),
        );
      });
      const controller = new AbortController();
      const result = host.request("shutdown", {}, { signal: controller.signal, timeoutMs: 100 });
      const assertion = expect(result).rejects.toMatchObject({
        code: cause === "abort" ? RPC_ERRORS.requestCancelled : RPC_ERRORS.timeout,
      });
      const observed = result.catch(() => events.push("rejected"));
      try {
        if (cause === "abort") controller.abort();
        else await vi.advanceTimersByTimeAsync(100);
        await assertion;
        await observed;
        expect(events).toEqual(["rejected", "cancel"]);
        expect(onProtocolError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(50);
        expect(onUnresponsive).not.toHaveBeenCalled();
      } finally {
        host.close();
      }
    },
  );
  it.each([new RpcError(RPC_ERRORS.permissionDenied, "denied"), new Error("handler failed")])(
    "replies with cancellation when an aborted handler throws %s",
    async (error) => {
      const [hostRaw, pluginRaw] = createMemoryChannelPair();
      const plugin = new RpcPeer(pluginRaw);
      plugin.handle("command/execute", async (_params, { signal }) => {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw error;
      });
      const reply = new Promise<unknown>((resolve) => {
        hostRaw.onMessage((text) => resolve(JSON.parse(text)));
      });
      hostRaw.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "command/execute",
          params: { command: "acme.x.y" },
        }),
      );
      hostRaw.send(
        JSON.stringify({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 1 } }),
      );
      try {
        await expect(reply).resolves.toEqual({
          jsonrpc: "2.0",
          id: 1,
          error: { code: RPC_ERRORS.requestCancelled, message: "command/execute was cancelled." },
        });
      } finally {
        plugin.close();
      }
    },
  );
  it("contains a throwing protocol-error callback during synchronous delivery", () => {
    const [a, b] = synchronousPair();
    const onProtocolError = vi.fn(() => {
      throw new Error("callback failed");
    });
    const peer = new RpcPeer(a, { onProtocolError });
    try {
      expect(() => b.send("not json")).not.toThrow();
      expect(onProtocolError).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: RPC_ERRORS.invalidRequest }),
      );
    } finally {
      peer.close();
    }
  });
  it("contains a throwing protocol-error callback during asynchronous delivery", async () => {
    vi.useFakeTimers({ toFake: ["queueMicrotask"] });
    const [a, b] = createMemoryChannelPair();
    const onProtocolError = vi.fn(() => {
      throw new Error("callback failed");
    });
    const peer = new RpcPeer(a, { onProtocolError });
    try {
      expect(() => b.send("not json")).not.toThrow();
      expect(onProtocolError).not.toHaveBeenCalled();
      expect(() => vi.runAllTicks()).not.toThrow();
      expect(onProtocolError).toHaveBeenCalledOnce();
    } finally {
      peer.close();
    }
  });
  it("contains a throwing unresponsive callback in the grace timer", async () => {
    vi.useFakeTimers();
    const onUnresponsive = vi.fn(() => {
      throw new Error("callback failed");
    });
    const { host, plugin } = pair({ timeoutMs: 100, cancelGraceMs: 50, onUnresponsive });
    plugin.handle("shutdown", () => new Promise(() => {}));
    const result = host.request("shutdown", {});
    const assertion = expect(result).rejects.toMatchObject({ code: RPC_ERRORS.timeout });
    try {
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
      await expect(vi.advanceTimersByTimeAsync(50)).resolves.toBeDefined();
      expect(onUnresponsive).toHaveBeenCalledExactlyOnceWith("shutdown");
    } finally {
      host.close();
      plugin.close();
    }
  });
});
