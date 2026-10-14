import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createMemoryChannelPair, RpcPeer, type ParamsOf } from "@kobrixa/plugin-protocol";
import { definePlugin, electronParentPortChannel, runPlugin } from "./index.js";

const init: ParamsOf<"initialize"> = {
  apiVersion: "1.0.0",
  pluginId: "acme.hello",
  locale: "zh-TW",
  grantedPermissions: ["ui.notifications"],
};
function connect(definition: Parameters<typeof runPlugin>[0]) {
  const [hostEnd, pluginEnd] = createMemoryChannelPair();
  const host = new RpcPeer(hostEnd);
  const exit = vi.fn();
  void runPlugin(definition, { channel: pluginEnd, exit });
  return { host, exit };
}

describe("JS plugin SDK", () => {
  it("activates during initialize and runs registered commands", async () => {
    const messages: unknown[] = [];
    const { host } = connect(
      definePlugin({
        activate(context) {
          context.commands.register("acme.hello.greet", () =>
            context.ui.showMessage(`${context.pluginId}:${context.locale}`),
          );
        },
      }),
    );
    host.handle("ui/showMessage", (params) => {
      messages.push(params);
      return null;
    });
    await expect(host.request("initialize", init)).resolves.toMatchObject({
      apiVersion: "1.0.0",
      sdk: { name: "@kobrixa/plugin-sdk" },
    });
    await host.request("command/execute", { command: "acme.hello.greet" });
    expect(messages).toEqual([{ severity: "info", message: "acme.hello:zh-TW" }]);
  });
  it("passes cancellation to handlers and reports unknown commands", async () => {
    let aborted = false;
    const { host } = connect(
      definePlugin({
        activate(context) {
          context.commands.register(
            "acme.hello.wait",
            ({ signal }) =>
              new Promise<void>((_, reject) =>
                signal.addEventListener("abort", () => {
                  aborted = true;
                  reject(new Error("stopped"));
                }),
              ),
          );
        },
      }),
    );
    await host.request("initialize", init);
    const controller = new AbortController();
    const pending = host.request(
      "command/execute",
      { command: "acme.hello.wait" },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await vi.waitFor(() => expect(aborted).toBe(true));
    await expect(
      host.request("command/execute", { command: "acme.hello.missing" }),
    ).rejects.toMatchObject({ code: -32602 });
  });
  it("deactivates on shutdown and exits on the exit notification", async () => {
    const deactivate = vi.fn();
    const { host, exit } = connect(definePlugin({ activate() {}, deactivate }));
    await host.request("initialize", init);
    await host.request("shutdown", {});
    host.notify("exit", {});
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(deactivate).toHaveBeenCalled();
  });
  it("adapts Electron's parentPort and transferred MessagePort", async () => {
    const parent = new EventEmitter();
    const port = Object.assign(new EventEmitter(), { postMessage: vi.fn(), start: vi.fn() });
    const channel = electronParentPortChannel(parent as never);
    parent.emit("message", { data: {}, ports: [port] });
    const ready = await channel;
    const received = vi.fn();
    ready.onMessage(received);
    port.emit("message", { data: "{}" });
    port.emit("message", { data: 42 });
    ready.send("x");
    expect(received.mock.calls).toEqual([["{}"], [""]]);
    expect(port.postMessage).toHaveBeenCalledWith("x");
    expect(port.start).toHaveBeenCalled();
  });
});
