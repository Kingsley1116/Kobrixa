import type { Locale } from "../i18n/copy.js";

export function versionLabel(version: { path: string; time: number }, locale: Locale): string {
  return `${version.path.split("/").at(-1)} · ${new Date(version.time).toLocaleTimeString(locale, { hour12: false })}`;
}
