import { z } from "zod";
import { namespacedIdSchema } from "@kobrixa/plugin-protocol";
import { sourceKeySchema } from "@kobrixa/plugin-runtime";
import type { PluginEvent } from "../../shared/plugins.js";
import type { IpcHandle } from "../ipc.js";
import type { PluginController } from "./controller.js";

export type PluginIpcTarget = Pick<
  PluginController,
  | "state"
  | "diagnosticHelp"
  | "notices"
  | "execute"
  | "cancel"
  | "setEnabled"
  | "setDeveloperMode"
  | "linkFolder"
  | "relinkFolder"
  | "unlink"
  | "reload"
  | "pythonCandidates"
  | "setPython"
  | "readLog"
  | "clearSafeModeLock"
  | "onEvent"
>;
const pythonChoiceSchema = z.enum(["python3", "python", "py", "saved", "other"]);
const cursorSchema = z.number().int().nonnegative();

/**
 * Every channel goes through the trusted-sender wrapper. The renderer sends only source keys,
 * command ids, booleans, interpreter ids and log cursors, never a path or an executable; the
 * controller checks developer mode, safe mode and shutdown itself.
 */
export function registerPluginIpc(
  handle: IpcHandle,
  plugins: PluginIpcTarget,
  publish: (event: PluginEvent) => void,
): () => void {
  const key = (value: unknown) => sourceKeySchema.parse(value);
  handle("plugins:state", () => plugins.state());
  handle("plugins:diagnosticHelp", () => plugins.diagnosticHelp());
  handle("plugins:notices", () => plugins.notices());
  handle("plugins:execute", (_event, commandId: unknown) =>
    plugins.execute(namespacedIdSchema.parse(commandId)),
  );
  handle("plugins:cancel", (_event, sourceKey: unknown) => plugins.cancel(key(sourceKey)));
  handle("plugins:set-enabled", (_event, sourceKey: unknown, enabled: unknown) =>
    plugins.setEnabled(key(sourceKey), z.boolean().parse(enabled)),
  );
  handle("plugins:setDeveloperMode", (_event, enabled: unknown) =>
    plugins.setDeveloperMode(z.boolean().parse(enabled)),
  );
  handle("plugins:linkFolder", () => plugins.linkFolder());
  handle("plugins:relinkFolder", (_event, sourceKey: unknown) =>
    plugins.relinkFolder(key(sourceKey)),
  );
  handle("plugins:unlink", (_event, sourceKey: unknown) => plugins.unlink(key(sourceKey)));
  handle("plugins:reload", (_event, sourceKey: unknown) => plugins.reload(key(sourceKey)));
  handle("plugins:pythonCandidates", () => plugins.pythonCandidates());
  handle("plugins:setPython", (_event, id: unknown) =>
    plugins.setPython(pythonChoiceSchema.parse(id)),
  );
  handle("plugins:readLog", (_event, sourceKey: unknown, after: unknown) =>
    plugins.readLog(key(sourceKey), cursorSchema.parse(after)),
  );
  handle("plugins:clearSafeModeLock", () => plugins.clearSafeModeLock());
  return plugins.onEvent(publish);
}
