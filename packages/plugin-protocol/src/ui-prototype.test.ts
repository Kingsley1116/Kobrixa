import { describe, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer, RPC_ERRORS } from "./index.js";
import {
  validateCommandInvocation,
  validateCommandValue,
  validateUiResource,
} from "./ui-validation.js";

const context = { pluginId: "test.ui", commands: [], panels: [] };
const invocation = () => ({
  version: 1 as const,
  invocationId: "00000000-0000-4000-8000-000000000001",
  command: "test.ui.run",
  arguments: {},
  context: {
    contextRef: null,
    origin: "management" as const,
    locale: "en" as const,
    trigger: { kind: "activate" as const },
  },
});
const record = (key: string, value: unknown) => Object.fromEntries([[key, value]]);
const panel = () => ({
  kind: "panel",
  data: {},
  fields: {},
  root: "root",
  nodes: [
    { id: "root", type: "group", layout: "stack", children: ["body"] },
    {
      id: "body",
      type: "text",
      value: { text: { en: "constructor and prototype are valid text" } },
      emphasis: "normal",
    },
  ],
});
const validate = (value: unknown) =>
  validateUiResource(value, context, Buffer.byteLength(JSON.stringify(value)));

describe("raw UI record keys survive validation boundaries", () => {
  it.each(["__proto__", "constructor", "prototype"])(
    "rejects own %s keys in otherwise valid resources",
    (key) => {
      expect(validate(panel()).ok).toBe(true);
      for (const field of ["data", "fields"] as const) {
        const value = {
          ...panel(),
          [field]: record(key, {
            schema: { type: "boolean", nullable: false },
            initial: false,
            ...(field === "fields" ? { required: false } : {}),
          }),
        };
        expect(validate(value)).toMatchObject({
          ok: false,
          error: { detail: { reason: "schema" } },
        });
        expect(Object.hasOwn(value[field], key)).toBe(true);
      }
      expect(
        validate({
          kind: "status",
          data: record(key, {
            schema: { type: "boolean", nullable: false },
            initial: false,
          }),
          tone: "neutral",
          text: { text: { en: "Ready" } },
        }).ok,
      ).toBe(false);
    },
  );

  it("rejects prototype entries before parsing command arguments and outputs", () => {
    const call = invocation();
    expect(validateCommandInvocation(call).ok).toBe(true);
    expect(validateCommandValue({ output: {}, fieldErrors: [] }, call).ok).toBe(true);
    expect(validateCommandInvocation({ ...call, arguments: record("__proto__", false) }).ok).toBe(
      false,
    );
    expect(
      validateCommandValue({ output: record("__proto__", false), fieldErrors: [] }, call).ok,
    ).toBe(false);
  });

  it("does not send a request whose raw arguments would be erased by parsing", async () => {
    const [channel, remote] = createMemoryChannelPair();
    const peer = new RpcPeer(channel);
    const other = new RpcPeer(remote);
    const handler = vi.fn(() => ({ ok: true as const, value: { output: {}, fieldErrors: [] } }));
    other.handle("command/invoke", handler);
    try {
      await expect(
        peer.request("command/invoke", {
          ...invocation(),
          arguments: record("__proto__", false),
        } as ReturnType<typeof invocation>),
      ).rejects.toMatchObject({ code: RPC_ERRORS.invalidParams });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      peer.close();
      other.close();
    }
  });

  it("rejects raw incoming arguments before dispatching to a handler", async () => {
    const [channel, remote] = createMemoryChannelPair();
    const peer = new RpcPeer(channel);
    const handler = vi.fn(() => ({ ok: true as const, value: { output: {}, fieldErrors: [] } }));
    peer.handle("command/invoke", handler);
    try {
      const reply = new Promise<string>((resolve) => remote.onMessage(resolve));
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "command/invoke",
          params: {
            ...invocation(),
            arguments: record("__proto__", false),
          },
        }),
      );
      expect(JSON.parse(await reply)).toMatchObject({
        id: 7,
        error: { code: RPC_ERRORS.invalidParams },
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      peer.close();
    }
  });

  it("rejects a handler's raw output before publishing a sanitized success", async () => {
    const [channel, remote] = createMemoryChannelPair();
    const peer = new RpcPeer(channel);
    const other = new RpcPeer(remote);
    other.handle("command/invoke", () => ({
      ok: true,
      value: { output: { ["__proto__"]: false }, fieldErrors: [] },
    }));
    try {
      await expect(peer.request("command/invoke", invocation())).rejects.toMatchObject({
        code: RPC_ERRORS.internalError,
      });
    } finally {
      peer.close();
      other.close();
    }
  });

  it("rejects a remote raw result before resolving the caller", async () => {
    const [channel, remote] = createMemoryChannelPair();
    const peer = new RpcPeer(channel);
    remote.onMessage((text) => {
      const request = JSON.parse(text);
      remote.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            ok: true,
            value: { output: record("__proto__", false), fieldErrors: [] },
          },
        }),
      );
    });
    try {
      await expect(peer.request("command/invoke", invocation())).rejects.toMatchObject({
        code: RPC_ERRORS.internalError,
      });
    } finally {
      peer.close();
    }
  });
});
