import type { Locale } from "../i18n/copy.js";
export function versionLabel(
  version: { path?: string; buildId: string; time: number },
  locale: Locale,
): string {
  const name =
    version.path?.split("/").at(-1) ??
    (locale === "zh-TW" ? "建置 " : "Build ") + version.buildId.slice(0, 8);
  return `${name} · ${new Date(version.time).toLocaleTimeString(locale, { hour12: false })}`;
}
