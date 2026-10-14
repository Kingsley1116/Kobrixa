import { z } from "zod";
import { PLUGIN_LIMITS } from "./limits.js";

// Wire schemas stay exportable to JSON Schema: no transform, coercion or custom refinement.
// Patterns avoid \d, \w, \s and \b so ECMAScript and Python regular expressions agree.
// eslint-disable-next-line no-control-regex -- the pattern rejects control characters.
export const SINGLE_LINE = /^[^\u0000-\u001F\u007F]*$/;
// eslint-disable-next-line no-control-regex -- allows tab and newline, rejects other controls.
export const MULTI_LINE = /^[^\u0000-\u0008\u000B-\u001F\u007F]*$/;

export const namespacedIdSchema = z
  .string()
  .min(3)
  .max(PLUGIN_LIMITS.idLength)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/);
export const semverSchema = z
  .string()
  .max(64)
  .regex(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
  );
export const pluginLocaleSchema = z.enum(["en", "zh-TW"]);
export type PluginLocale = z.infer<typeof pluginLocaleSchema>;
export const permissionSchema = z.enum(["ui.notifications"]);
export type Permission = z.infer<typeof permissionSchema>;
const text = z.string().min(1).max(PLUGIN_LIMITS.textLength).regex(SINGLE_LINE);
export const localizedTextSchema = z.union([
  text,
  z.looseObject({ en: text, "zh-TW": text.optional() }),
]);
export type LocalizedText = z.infer<typeof localizedTextSchema>;
