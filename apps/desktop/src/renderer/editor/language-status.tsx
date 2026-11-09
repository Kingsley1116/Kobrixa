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
  const availability = status.availability;
  const { reason } = availability;
  const t = copy[locale];
  return (
    <div
      className="file-change-banner"
      role="status"
      data-workspace-banner={reason === "conflict" ? "true" : undefined}
    >
      <span>
        {availability.reason === "project-error"
          ? availability.diagnostics.length
            ? availability.message
            : t.languageChooseEntry
          : availability.reason === "missing"
            ? t.languageMissing(availability.language)
            : t.languageConflict(availability.language, status.conflicts.join(", "))}
      </span>
      {reason !== "project-error" && <button onClick={openSettings}>{t.languageSettings}</button>}
    </div>
  );
}
