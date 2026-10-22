import { ContextCommands, type ContextCommandHandler } from "./commands.js";
import { UiClient } from "./ui.js";
import { uiEventClientPort } from "./events.js";
import { type ValueSpec, type CommandInvocation, uiFailure } from "@kobrixa/plugin-protocol";
export type { ContextCommandContext, ContextCommandHandler } from "./commands.js";
export { UiClient } from "./ui.js";
import { bindEventChannel } from "./events.js";
import { resourceOwnerSchema } from "@kobrixa/plugin-protocol";
import { createDevicesClient, type DevicesClient } from "./devices.js";
export * from "./devices.js";
export { unwrap } from "@kobrixa/plugin-protocol";
import {
  PLUGIN_API_VERSION,
  RPC_ERRORS,
  RpcError,
  RpcPeer,
  type MessageChannelLike,
  type PluginLocale,
  type Result,
} from "@kobrixa/plugin-protocol";

export const API_VERSION = PLUGIN_API_VERSION;
export const SDK_VERSION = "0.1.0";
export type CommandHandler = (context: { readonly signal: AbortSignal }) => void | Promise<void>;
export interface PluginContext {
  readonly devices: DevicesClient;
  readonly pluginId: string;
  readonly locale: PluginLocale;
  readonly commands: {
    register(commandId: string, handler: CommandHandler): void;
    registerContext(
      commandId: string,
      argumentsSchema: Record<string, ValueSpec>,
      handler: ContextCommandHandler,
    ): void;
  };
  readonly ui: UiClient;
}
export interface PluginDefinition {
  ready?(context: PluginContext): void | Promise<void>;
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
  const launchOwner = process.env.KOBRIXA_RESOURCE_OWNER;
  if (launchOwner !== undefined)
    bindEventChannel(peer, resourceOwnerSchema.parse(JSON.parse(launchOwner)));
  const commands = new Map<string, CommandHandler>();
  const ui = new UiClient(peer.request.bind(peer), uiEventClientPort(peer));
  let contextCommands: ContextCommands | undefined;
  let pluginContext: PluginContext | undefined;
  let negotiated = false;
  let readyResult: Promise<Result<Record<string, never>>> | undefined;
  peer.handle("ui/negotiate", async (params) => {
    if (!pluginContext) return uiFailure("negotiation");
    negotiated = params.commandEnvelopeVersions.includes(1);
    return {
      ok: true as const,
      value: {
        commandEnvelopeVersions: negotiated ? [1] : [],
        uiResourceVersions: params.uiResourceVersions.includes(1) ? [1] : [],
      },
    };
  });
  peer.handle("ui/ready", async () => {
    if (!negotiated || !pluginContext) return uiFailure("negotiation");
    if (!readyResult) {
      ui.markReady();
      const context = pluginContext;
      readyResult = Promise.resolve()
        .then(() => definition.ready?.(context))
        .then(
          () => ({ ok: true as const, value: {} }),
          () => {
            ui.retire();
            return uiFailure<Record<string, never>>("negotiation");
          },
        );
    }
    return readyResult;
  });
  peer.handle("command/invoke", async (invocation, { signal }) => {
    if (!negotiated || !readyResult || !contextCommands) return uiFailure("negotiation");
    const ready = await readyResult;
    if (!ready.ok) return ready;
    return contextCommands.invoke(invocation, signal);
  });

  let initialized!: (version: string) => void;
  const ready = new Promise<string>((resolve) => {
    initialized = resolve;
  });
  const devices = createDevicesClient(peer, ready);
  peer.handle("initialize", async ({ pluginId, locale, apiVersion }, request) => {
    contextCommands = new ContextCommands(pluginId);
    pluginContext = {
      devices,
      pluginId,
      locale,
      commands: {
        register(commandId, handler) {
          if (commands.has(commandId))
            throw new Error(`Command ${commandId} is already registered.`);
          commands.set(commandId, handler);
        },
        registerContext(commandId, argumentsSchema, handler) {
          if (commands.has(commandId))
            throw new Error(`Command ${commandId} is already registered.`);
          contextCommands!.registerContext(commandId, argumentsSchema, (invocation) => {
            const { signal, ...wireInvocation } = invocation;
            const local = createInvocationContext(pluginContext!, wireInvocation, signal);
            return handler(
              Object.freeze(
                Object.assign(local, {
                  version: invocation.version,
                  invocationId: invocation.invocationId,
                  command: invocation.command,
                  arguments: invocation.arguments,
                  context: invocation.context,
                }),
              ),
            );
          });
        },
      },
      ui,
    };
    await definition.activate(pluginContext);
    // Readiness follows successful response publication, without a timer racing
    // the first command or activation continuations overtaking the handshake.
    request.afterReply(
      () => initialized(apiVersion),
      () => {},
    );
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
    ui.retire();
    await definition.deactivate?.();
    return null;
  });
  peer.onNotification("exit", () => exit(0));
  return peer;
}

export function createInvocationContext(
  base: PluginContext,
  invocation: CommandInvocation,
  signal: AbortSignal,
): PluginContext & { readonly invocation: CommandInvocation; readonly signal: AbortSignal } {
  return Object.create(base, {
    invocation: { value: Object.freeze(structuredClone(invocation)), enumerable: true },
    signal: { value: signal, enumerable: true },
  });
}
