import { expect, it } from "vitest";
import {
  DIAGNOSTIC_HELP,
  DIAGNOSTIC_HELP_VARIANTS,
  diagnosticDocumentationUrl,
} from "@kobrixa/compiler/diagnostic-help";

it("keeps every official diagnostic URL format unchanged", () => {
  for (const help of [...DIAGNOSTIC_HELP, ...DIAGNOSTIC_HELP_VARIANTS])
    for (const locale of ["en", "zh-TW"] as const)
      expect(diagnosticDocumentationUrl(help.code, help.helpKey, locale)).toBe(
        `https://kobrixa.com/docs/diagnostics/${help.code}?lang=${locale}${help.helpKey ? `#${help.helpKey}` : ""}`,
      );
  expect(diagnosticDocumentationUrl("BP1015", undefined, "en")).toBe(
    "https://kobrixa.com/docs/diagnostics/BP1015?lang=en",
  );
});
