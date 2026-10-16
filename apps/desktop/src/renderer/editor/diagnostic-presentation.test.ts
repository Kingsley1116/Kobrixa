import { expect, it } from "vitest";
import type { Diagnostic } from "../../shared/api.js";
import type { PluginHelpCatalogView } from "../../shared/diagnostic-help.js";
import { diagnosticMarkerMessage, diagnosticSummary } from "./diagnostic-presentation.js";

const diagnostic: Diagnostic = {
  source: "acme.x",
  code: "BP1043",
  severity: "error",
  file: "main.bp",
  range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
  message: "raw message",
};
const catalog: PluginHelpCatalogView = {
  revision: 1,
  plugins: {
    "acme.x": {
      entries: [
        {
          code: "BP1043",
          title: { en: "Acme title" },
          cause: { en: "Acme cause", "zh-TW": "原因" },
          steps: { en: ["Acme step"] },
        },
      ],
    },
  },
};
it("uses only the source's help for summaries and marker messages, with locale fallback", () => {
  expect(diagnosticSummary(diagnostic, "zh-TW", catalog)).toBe("Acme title");
  expect(diagnosticMarkerMessage(diagnostic, "zh-TW", catalog)).toBe(
    "BP1043: Acme title\n原因\nAcme step\n\nraw message",
  );
});
it("keeps unknown sources' raw messages even when their code has built-in help", () => {
  const unknown = { ...diagnostic, source: "acme.y" };
  expect(diagnosticSummary(unknown, "en", catalog)).toBe("raw message");
  expect(diagnosticMarkerMessage(unknown, "en", catalog)).toBe("BP1043: raw message");
  expect(diagnosticSummary(diagnostic, "en", undefined)).toBe("raw message");
});
it("keeps built-in help available without a plugin catalog", () => {
  const builtin = { ...diagnostic, source: "kobrixa.basic-plus" };
  expect(diagnosticSummary(builtin, "en", undefined)).toBe("Call is missing a closing parenthesis");
  expect(diagnosticMarkerMessage(builtin, "en", undefined)).toContain("\n\nraw message");
});
