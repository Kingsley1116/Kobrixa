import { copy, type Locale } from "../i18n/copy.js";
import type { LanguageStatus } from "../../shared/language-services.js";
export function LanguageStatusRow({
  status,
  locale,
  openSettings,
}: {
  status: LanguageStatus | undefined;
  locale: Locale;
  openSettings(): void;
}) {
  if (status?.availability.kind !== "unavailable") return null;
  const { reason, language } = status.availability;
  const t = copy[locale];
  return (
    <div
      className="file-change-banner"
      role="status"
      data-workspace-banner={reason === "conflict" ? "true" : undefined}
    >
      <span>
        {reason === "missing"
          ? t.languageMissing(language)
          : t.languageConflict(language, status.conflicts.join(", "))}
      </span>
      <button onClick={openSettings}>{t.languageSettings}</button>
    </div>
  );
}
