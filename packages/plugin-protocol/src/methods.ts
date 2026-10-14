import { z } from "zod";
import {
  MULTI_LINE,
  namespacedIdSchema,
  permissionSchema,
  pluginLocaleSchema,
  semverSchema,
} from "./common.js";
import { PLUGIN_LIMITS } from "./limits.js";
import { jsonRpcIdSchema } from "./rpc.js";

export const severitySchema = z.enum(["info", "warning", "error"]);
export type Severity = z.infer<typeof severitySchema>;
const empty = z.strictObject({});

export const requestMethods = {
  initialize: {
    params: z.strictObject({
      apiVersion: semverSchema,
      pluginId: namespacedIdSchema,
      locale: pluginLocaleSchema,
      grantedPermissions: z.array(permissionSchema).max(16),
    }),
    result: z.strictObject({
      apiVersion: semverSchema,
      sdk: z.strictObject({ name: z.string().min(1).max(64), version: z.string().min(1).max(64) }),
    }),
  },
  "command/execute": { params: z.strictObject({ command: namespacedIdSchema }), result: z.null() },
  shutdown: { params: empty, result: z.null() },
  "ui/showMessage": {
    params: z.strictObject({
      severity: severitySchema,
      message: z.string().min(1).max(PLUGIN_LIMITS.messageLength).regex(MULTI_LINE),
    }),
    result: z.null(),
  },
} as const;
export const notificationMethods = {
  "$/cancelRequest": z.strictObject({ id: jsonRpcIdSchema }),
  exit: empty,
} as const;

export type RequestMethod = keyof typeof requestMethods;
export type NotificationMethod = keyof typeof notificationMethods;
export type ParamsOf<M extends RequestMethod> = z.input<(typeof requestMethods)[M]["params"]>;
export type ResultOf<M extends RequestMethod> = z.output<(typeof requestMethods)[M]["result"]>;
export type NotificationParamsOf<M extends NotificationMethod> = z.output<
  (typeof notificationMethods)[M]
>;
