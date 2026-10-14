import {
  PLUGIN_API_VERSION,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  type MessageChannelLike,
  type PluginLocale,
  type Severity,
} from "@kobrixa/plugin-protocol";

export const SDK_VERSION = "0.1.0";
export type CommandHandler = (context: { readonly signal: AbortSignal }) => void | Promise<void>;
export interface PluginContext {
  readonly pluginId: string;
  readonly locale: PluginLocale;
  readonly commands: { register(commandId: string, handler: CommandHandler): void };
  readonly ui: { showMessage(message: string, severity?: Severity): Promise<void> };
}
export interface PluginDefinition {
  activate(context: PluginContext): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export const definePlugin = (definition: PluginDefinition): PluginDefinition => definition;

interface PortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
}
interface ParentPortLike {
  once(event: "message", listener: (event: { data: unknown; ports: PortLike[] }) => void): void;
}

/** Waits for the MessagePort that Kobrixa transfers to a utilityProcess plugin. */
export function electronParentPortChannel(
  parent = (process as unknown as { parentPort?: ParentPortLike }).parentPort,
): Promise<MessageChannelLike> {
  if (!parent)
    return Promise.reject(new Error("Kobrixa JavaScript plugins must be started by Kobrixa."));
  return new Promise((resolve, reject) => {
    parent.once("message", ({ ports }) => {
      const port = ports[0];
      if (!port) return reject(new Error("Kobrixa did not provide a message port."));
      port.start();
      resolve({
        send: (text) => port.postMessage(text),
        onMessage: (listener) => {
          // Non-string data is forwarded as "" so the peer reports a protocol error.
          const handler = (event: { data: unknown }) =>
            listener(typeof event.data === "string" ? event.data : "");
          port.on("message", handler);
          return () => port.off("message", handler);
        },
      });
    });
  });
}

export async function runPlugin(
  definition: PluginDefinition,
  options: { channel?: MessageChannelLike; exit?(code: number): void } = {},
): Promise<RpcPeer> {
  const channel = options.channel ?? (await electronParentPortChannel());
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const peer = new RpcPeer(channel, { onProtocolError: () => exit(1) });
  const commands = new Map<string, CommandHandler>();
  peer.handle("initialize", async ({ pluginId, locale }) => {
    await definition.activate({
      pluginId,
      locale,
      commands: {
        register(commandId, handler) {
          if (commands.has(commandId))
            throw new Error(`Command ${commandId} is already registered.`);
          commands.set(commandId, handler);
        },
      },
      ui: {
        async showMessage(message, severity = "info") {
          await peer.request("ui/showMessage", { severity, message }, { timeoutMs: 10_000 });
        },
      },
    });
    return {
      apiVersion: PLUGIN_API_VERSION,
      sdk: { name: "@kobrixa/plugin-sdk", version: SDK_VERSION },
    };
  });
  peer.handle("command/execute", async ({ command }, { signal }) => {
    const handler = commands.get(command);
    if (!handler)
      throw new RpcError(RPC_ERRORS.invalidParams, `The plugin did not register ${command}.`);
    await handler({ signal });
    return null;
  });
  peer.handle("shutdown", async () => {
    await definition.deactivate?.();
    return null;
  });
  peer.onNotification("exit", () => exit(0));
  return peer;
}
