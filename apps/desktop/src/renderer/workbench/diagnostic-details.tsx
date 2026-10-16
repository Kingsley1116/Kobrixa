import {
  resolveDiagnosticHelp,
  localizeHelp,
  diagnosticSourceLabel,
  type PluginHelpCatalogView,
} from "../../shared/diagnostic-help.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { languages } from "monaco-editor";
import type { DiagnosticLocale } from "@kobrixa/compiler/diagnostic-help";
import type { Diagnostic } from "../../shared/api.js";
import type { DocumentationRequest } from "../../shared/documentation.js";
import { sameDiagnostic } from "../../shared/quick-fixes.js";
import { offersBasicPlusQuickFix } from "../../shared/basic-plus-quick-fixes.js";
import type { AnalysisSession } from "../editor/analysis-session.js";

export interface DiagnosticDetailsHost {
  fixesDisabled?: boolean;
  locale: DiagnosticLocale;
  helpCatalog: PluginHelpCatalogView | undefined;
  analysisSession: AnalysisSession;
  getQuickFixes(diagnostic: Diagnostic, signal?: AbortSignal): Promise<languages.CodeAction[]>;
  applyQuickFix(action: languages.CodeAction): Promise<void>;
  openDocumentation(request: DocumentationRequest): Promise<void>;
}

export function DiagnosticDetails({
  diagnostic,
  ...host
}: DiagnosticDetailsHost & { diagnostic: Diagnostic }) {
  const { locale, analysisSession } = host;
  const callbacks = useRef(host);
  callbacks.current = host;
  const snapshot = useSyncExternalStore(analysisSession.subscribe, analysisSession.getCurrent);
  const [actions, setActions] = useState<languages.CodeAction[]>([]);
  const [pending, setPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const resolved = resolveDiagnosticHelp(diagnostic, host.helpCatalog);
  const text = resolved && localizeHelp(resolved, locale);
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  useEffect(() => {
    let current = true;
    setActions([]);
    setError("");
    setPending(false);
    if (
      host.fixesDisabled ||
      !snapshot ||
      !offersBasicPlusQuickFix(diagnostic) ||
      !snapshot.analysis.diagnostics.some(
        (d) => d.file === diagnostic.file && sameDiagnostic(d, diagnostic),
      )
    )
      return;
    const controller = new AbortController();
    setPending(true);
    void callbacks.current
      .getQuickFixes(diagnostic, controller.signal)
      .then((next) => {
        if (current) setActions(next);
      })
      .catch((reason) => {
        if (current) setError(String(reason instanceof Error ? reason.message : reason));
      })
      .finally(() => {
        if (current) setPending(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [diagnostic, snapshot, locale, host.fixesDisabled]);
  const open = (link: { relatedIndex?: number } | { linkIndex: number } = {}) => {
    void host
      .openDocumentation({
        source: diagnostic.source,
        code: diagnostic.code,
        ...(diagnostic.helpKey ? { helpKey: diagnostic.helpKey } : {}),
        locale,
        ...link,
      })
      .catch((reason) => setError(String(reason instanceof Error ? reason.message : reason)));
  };
  return (
    <section className="diagnostic-details" aria-label={t("診斷解說", "Diagnostic explanation")}>
      <h3>
        <code>{diagnostic.code}</code> {text?.title ?? t("診斷資訊", "Diagnostic information")}
      </h3>
      {resolved?.kind === "plugin" && (
        <p>
          {t("由 {name} 提供", "Provided by {name}").replace("{name}", () =>
            diagnosticSourceLabel(diagnostic.source, host.helpCatalog, locale),
          )}
        </p>
      )}
      <p>
        {text?.cause ??
          t(
            "尚未提供此代碼的專用解說。請查看原始訊息及來源位置。",
            "There is no specific explanation for this code yet. Check the original message and source location.",
          )}
      </p>
      {text && (
        <ol>
          {text.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
      )}
      <div className="diagnostic-fixes" aria-busy={pending || applying}>
        {pending && <span role="status">{t("正在檢查修正…", "Checking fixes…")}</span>}
        {actions.map((action, index) => (
          <button
            className="secondary"
            key={`${action.title}-${index}`}
            disabled={host.fixesDisabled || applying || !snapshot}
            onClick={() => {
              setApplying(true);
              setError("");
              void host
                .applyQuickFix(action)
                .catch((reason) =>
                  setError(String(reason instanceof Error ? reason.message : reason)),
                )
                .finally(() => setApplying(false));
            }}
          >
            {action.title}
          </button>
        ))}
        {!pending && !actions.length && (
          <span>
            {t(
              "請依下方原始訊息與上述說明檢查程式。",
              "Use the original message and guidance to review the program.",
            )}
          </span>
        )}
      </div>
      {error && (
        <p className="diagnostic-error" role="alert">
          {error}
        </p>
      )}
      {text?.example && (
        <div className="diagnostic-examples">
          <div>
            <h4>{t("錯誤範例", "Before")}</h4>
            <pre>
              <code>{text.example.before}</code>
            </pre>
          </div>
          <div>
            <h4>{t("修正範例", "After")}</h4>
            <pre>
              <code>{text.example.after}</code>
            </pre>
          </div>
        </div>
      )}
      <details className="diagnostic-original" open>
        <summary>{t("原始診斷", "Original diagnostic")}</summary>
        <pre>{diagnostic.message}</pre>
        <small>
          {diagnostic.file}:{diagnostic.range.startLine}:{diagnostic.range.startColumn}
        </small>
      </details>
      {resolved?.kind === "builtin" && (
        <div className="diagnostic-links">
          <button onClick={() => open()}>
            {t("在官網查看此錯誤 ↗", "View this diagnostic online ↗")}
          </button>
          {resolved.help.related.map((link, index) => (
            <button key={link.path} onClick={() => open({ relatedIndex: index })}>
              {link.label[locale]} ↗
            </button>
          ))}
        </div>
      )}
      {resolved?.kind === "plugin" && !!resolved.entry.links?.length && (
        <div className="diagnostic-links">
          {resolved.entry.links.map((link, index) => (
            <button key={index} onClick={() => open({ linkIndex: index })}>
              {locale === "zh-TW" ? (link.label["zh-TW"] ?? link.label.en) : link.label.en} ↗
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
