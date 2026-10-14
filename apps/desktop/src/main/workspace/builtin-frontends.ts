import type { LanguageFrontend } from "@kobrixa/compiler";
import { BasicPlusFrontend } from "@kobrixa/basic-plus";

/** In-process implementations for built-in frontend plugins, keyed by plugin id. */
export const BUILTIN_FRONTENDS: Readonly<Record<string, () => LanguageFrontend>> = {
  "kobrixa.basic-plus": () => new BasicPlusFrontend(),
};
