import { z } from "zod";
import { compilerIdSchema, namespacedIdSchema } from "@kobrixa/plugin-protocol";
import { sourceKeySchema } from "@kobrixa/plugin-runtime";
import type { PluginEvent } from "../../shared/plugins.js";
import type { ReportLanguageRegistrationFailureInput } from "../../shared/static-languages.js";
import type { IpcHandle } from "../ipc.js";
import type { PluginController } from "./controller.js";

export type PluginIpcTarget = Pick<
  PluginController,
  | "state"
  | "diagnosticHelp"
  | "staticLanguages"
  | "reportLanguageRegistrationFailure"
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
const reportCounterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const registrationFailureSchema: z.ZodType<ReportLanguageRegistrationFailureInput> = z.strictObject(
  {
    sourceKey: sourceKeySchema,
    generation: reportCounterSchema,
    languageId: compilerIdSchema,
    revision: reportCounterSchema,
    reason: z.enum(["dto-version", "validation", "adapter", "monaco", "session-language-ids"]),
    detail: z
      .string()
      .max(4096)
      .refine((value) => Array.from(value).length <= 2048, "Detail exceeds 2,048 code points.")
      .refine(
        (value) => !/(?:^|[\s"'(=])(?:\/[^\s]|[a-z]:[\\/]|\\\\|file:\/\/)/iu.test(value),
        "Registration detail must not contain a physical path.",
      ),
  },
);

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
  handle("plugins:static-languages", () => plugins.staticLanguages());
  handle("plugins:report-language-registration-failure", (_event, input: unknown) =>
    plugins.reportLanguageRegistrationFailure(registrationFailureSchema.parse(input)),
  );
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
