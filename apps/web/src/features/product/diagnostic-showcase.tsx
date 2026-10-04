import {
  DIAGNOSTIC_HELP,
  getDiagnosticHelp,
  type DiagnosticLocale,
} from "@kobrixa/compiler/diagnostic-help";
import { AppLink } from "../../components/app-link.js";
import "./diagnostic-showcase.css";

const help = getDiagnosticHelp("BP1043")!;

export function DiagnosticShowcase({ locale }: { locale: DiagnosticLocale }) {
  const t = (zh: string, en: string) => (locale === "zh-TW" ? zh : en);
  const steps = [
    [
      t("查看原因", "Understand the cause"),
      t(
        "選取診斷，閱讀原因、處理步驟與原始訊息。完整解說離線也能閱讀。",
        "Select a diagnostic to read its cause, repair steps and original message. Full explanations work offline.",
      ),
    ],
    [
      t("選取修正", "Choose a correction"),
      t(
        "有確定的修正方式時，從診斷面板、編輯器燈泡或 Quick Fix 快捷鍵選取套用。",
        "When a correction is unambiguous, select it in the diagnostics panel, editor lightbulb or Quick Fix shortcut menu.",
      ),
    ],
    [
      t("隨時復原", "Undo when needed"),
      t(
        "每次修正是一個 Undo 步驟，沿用你的草稿與儲存設定；套用後會重新分析。",
        "Each correction is one Undo step and follows your draft and saving preferences. The editor analyzes the result again.",
      ),
    ],
  ];
  const repairs = [
    [t("型別陣列", "Array types"), t("補上缺少的 ]", "Insert a missing ]")],
    [t("右括號", "Closing parentheses"), t("補上行尾缺少的 )", "Insert a missing ) at line end")],
    [t("For 起始值", "For initializers"), t("補上缺少的 =", "Insert a missing =")],
    [t("For 範圍", "For ranges"), t("補上缺少的 To", "Insert a missing To")],
    [
      t("檔尾區塊", "Unfinished blocks"),
      t("依巢狀順序補齊結尾", "Close nested blocks at end of file"),
    ],
  ];
  return (
    <section
      className="product-section diagnostic-showcase"
      id="diagnostics-quick-fix"
      aria-labelledby="diagnostic-showcase-title"
    >
      <div className="product-section-heading">
        <div>
          <p className="product-eyebrow">DIAGNOSTICS / QUICK FIX</p>
          <h2 id="diagnostic-showcase-title">
            {t("診斷解說與 Quick Fix", "Diagnostic explanations & Quick Fix")}
          </h2>
          <p className="diagnostic-showcase-intro">
            {t(
              `${DIAGNOSTIC_HELP.length} 個診斷代碼，提供繁體中文與英文解說。先了解問題，再選擇下一步。`,
              `${DIAGNOSTIC_HELP.length} diagnostic codes, explained in English and Traditional Chinese. Understand the problem before choosing your next step.`,
            )}
          </p>
        </div>
        <span className="diagnostic-offline">
          {t("IDE 內可離線閱讀", "Read offline in the IDE")}
        </span>
      </div>
      <div className="diagnostic-showcase-body">
        <ol className="diagnostic-journey">
          {steps.map(([title, body], index) => (
            <li key={title}>
              <span aria-hidden="true">0{index + 1}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
        <figure className="diagnostic-preview">
          <figcaption>
            {t("修正前後", "Before and after")}
            <code>{help.code}</code>
          </figcaption>
          <div className="diagnostic-preview-help">
            <h3>{help.title[locale]}</h3>
            <p>{help.cause[locale]}</p>
          </div>
          <div className="diagnostic-preview-code">
            <span>{t("修正前", "Before")}</span>
            <pre>
              <code>{help.example!.before}</code>
            </pre>
          </div>
          <div className="diagnostic-preview-code corrected">
            <span>{t("修正後", "After")}</span>
            <pre>
              <code>{help.example!.after}</code>
            </pre>
          </div>
          <AppLink href={`/docs/diagnostics/${help.code}?lang=${locale}`}>
            {t("閱讀這個錯誤的完整解說", "Read the full explanation")} →
          </AppLink>
        </figure>
      </div>
      <h3 className="diagnostic-repairs-title">
        {t("目前支援的五類修正", "Five supported correction types")}
      </h3>
      <ul className="diagnostic-repairs">
        {repairs.map(([title, body]) => (
          <li key={title}>
            <strong>{title}</strong>
            <span>{body}</span>
          </li>
        ))}
      </ul>
      <p className="diagnostic-showcase-note">
        {t(
          "只有位置與語法可確定時才提供修正；歧義語法、未閉字串與錯配區塊會提供解說，讓你自行判斷。",
          "Corrections are offered only when the syntax and insertion point are unambiguous. Ambiguous syntax, unclosed strings and mismatched blocks provide guidance for you to review.",
        )}
      </p>
      <div className="product-actions">
        <AppLink className="product-button primary" href={`/docs/diagnostics?lang=${locale}`}>
          {t("查閱錯誤索引", "Browse the diagnostic index")} →
        </AppLink>
        <AppLink
          className="product-button secondary"
          href={`/docs/reference/keyboard-settings?lang=${locale}`}
        >
          {t("查看操作與快捷鍵", "Explore controls and shortcuts")} →
        </AppLink>
      </div>
    </section>
  );
}
