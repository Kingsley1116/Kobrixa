import { z } from "zod";
import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
import { sourceKeySchema, type PluginManager } from "@kobrixa/plugin-runtime";
import type { PluginEvent } from "../../shared/plugins.js";
import type { IpcHandle } from "../ipc.js";

export function registerPluginIpc(
  handle: IpcHandle,
  plugins: Pick<PluginManager, "state" | "executeCommand" | "setEnabled" | "onEvent">,
  publish: (event: PluginEvent) => void,
): () => void {
  handle("plugins:state", () => plugins.state());
  handle("plugins:execute", (_event, commandId: unknown) =>
    plugins.executeCommand(namespacedIdSchema.parse(commandId)),
  );
  handle("plugins:set-enabled", (_event, sourceKey: unknown, enabled: unknown) =>
    plugins.setEnabled(sourceKeySchema.parse(sourceKey), z.boolean().parse(enabled)),
  );
  return plugins.onEvent(publish);
}
