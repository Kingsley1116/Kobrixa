import { expect, it } from "vitest";
import type { CommandInvocation } from "@kobrixa/plugin-protocol";
import { PluginSupervisor } from "./supervisor.js";
import { memoryPlugin } from "./test-process.js";

it.each([16384, 16385])(
  "U07 runtime original command channel validates %i serialized argument bytes",
  async (bytes) => {
    const args = {
      a: "a".repeat(4000),
      b: "b".repeat(4000),
      c: "c".repeat(4000),
      d: "界".repeat(1000),
    };
    args.d += "x".repeat(bytes - Buffer.byteLength(JSON.stringify(args)));
    expect(Buffer.byteLength(JSON.stringify(args))).toBe(bytes);
    const received: CommandInvocation[] = [];
    const supervisor = new PluginSupervisor(
      {
        id: "test.ui",
        directory: "/fixture",
        entry: "/fixture/main.js",
        runtime: "node",
        permissions: [],
        commands: ["test.ui.run"],
      },
      async () =>
        memoryPlugin((peer, control) => {
          peer.handle("initialize", () => ({
            apiVersion: "1.6.0",
            sdk: { name: "port-fixture", version: "1" },
          }));
          peer.handle("command/invoke", (invocation) => {
            received.push(invocation);
            return { ok: true, value: { output: {}, fieldErrors: [] } };
          });
          peer.handle("shutdown", () => null);
          peer.onNotification("exit", () => control.exit());
        }).process,
      { locale: "en", onNotice() {} },
    );
    const invocation: CommandInvocation = {
      version: 1,
      invocationId: "00000000-0000-4000-8000-000000000001",
      command: "test.ui.run",
      arguments: args,
      context: {
        contextRef: null,
        origin: "panel",
        locale: "en",
        binding: {
          contributionId: "test.ui.panel",
          panelInstance: "00000000-0000-4000-8000-000000000002",
          kind: "panel",
          uiResourceGeneration: 1,
          generation: 1,
          hostEpoch: "00000000-0000-4000-8000-000000000003",
          processEpoch: "00000000-0000-4000-8000-000000000004",
        },
        form: { revision: 1, values: {} },
        trigger: { kind: "activate" },
      },
    };
    try {
      if (bytes === 16384) {
        expect(await supervisor.invoke(invocation)).toMatchObject({ ok: true });
        expect(received).toEqual([invocation]);
      } else {
        await expect(supervisor.invoke(invocation)).rejects.toMatchObject({
          code: "PLUGIN_E_COMMAND_FAILED",
          message: "Invalid parameters for command/invoke.",
        });
        expect(received).toEqual([]);
      }
    } finally {
      await supervisor.stop();
    }
  },
);
