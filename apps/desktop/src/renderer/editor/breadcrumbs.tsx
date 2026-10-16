import type { LanguageSymbolKind } from "../../shared/language-types.js";
import type { LanguageFeatureQuery, LanguageFeatureReply } from "../../shared/language-query.js";
import { supportsFile } from "../../shared/language-services.js";
import type { EditorAnalysis } from "./editor.js";
import type { SourceRange } from "@kobrixa/compiler";
import { Fragment, useEffect, useState, useSyncExternalStore } from "react";
import { ContextMenu } from "../components/context-menu.js";
import type { Locale } from "../i18n/copy.js";
import type { AnalysisSession } from "./analysis-session.js";
import type { CursorStore } from "./documents.js";
import { outlinePath, type OutlineItem } from "./outline.js";

const KIND_LABELS: Record<LanguageSymbolKind, [string, string]> = {
  function: ["Function", "Function"],
  method: ["方法", "Method"],
  variable: ["變數", "Variable"],
  label: ["標籤", "Label"],
  parameter: ["參數", "Parameter"],
  namespace: ["命名空間", "Namespace"],
};

/** File path and enclosing Sub above the editor; the symbol list jumps within the file. */
export function Breadcrumbs({
  file,
  analysisSession,
  query,
  cursor,
  locale,
  onReveal,
}: {
  file: string;
  analysisSession: AnalysisSession;
  query(
    snapshot: EditorAnalysis,
    query: LanguageFeatureQuery,
    signal: AbortSignal,
  ): Promise<LanguageFeatureReply>;
  cursor: CursorStore;
  locale: Locale;
  onReveal(range: SourceRange): void;
}): React.JSX.Element {
  const zh = locale === "zh-TW";
  // Keep the last outline for this file while a newer analysis is pending.
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  useEffect(() => {
    setOutline([]);
    let controller: AbortController | undefined;
    const accept = (snapshot = analysisSession.getCurrent(), event?: string) => {
      controller?.abort();
      if (event === "reset" || event === "failure") setOutline([]);
      if (
        !snapshot ||
        !supportsFile(snapshot.binding, file) ||
        !snapshot.binding.capabilities.includes("documentSymbols") ||
        !(file in snapshot.analysis.index.sources)
      )
        return;
      const request = (controller = new AbortController());
      void query(snapshot, { kind: "documentSymbols", file }, request.signal)
        .then((reply) => {
          if (
            !request.signal.aborted &&
            analysisSession.getCurrent() === snapshot &&
            reply.kind === "result" &&
            reply.epoch === snapshot.epoch &&
            reply.result.kind === "documentSymbols"
          )
            setOutline(reply.result.symbols);
        })
        .catch(() => {
          if (!request.signal.aborted) setOutline([]);
        });
    };
    accept();
    const detach = analysisSession.subscribe(accept);
    return () => {
      controller?.abort();
      detach();
    };
  }, [analysisSession, file, query]);
  const position = useSyncExternalStore(cursor.subscribe, cursor.getSnapshot);
  const path = outlinePath(outline, position.line, position.column);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const segments = file.split("/");
  const flat = outline.flatMap((item) => [
    { item, depth: 0 },
    ...item.children.map((child) => ({ item: child, depth: 1 })),
  ]);
  return (
    <nav
      className="breadcrumb breadcrumbs"
      title={file}
      aria-label={zh ? "檔案位置" : "File location"}
    >
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true">›</span>}
          <span className={index === segments.length - 1 ? "breadcrumb-file" : undefined}>
            {segment}
          </span>
        </Fragment>
      ))}
      {path.map((item) => (
        <Fragment key={`${item.kind}:${item.name}`}>
          <span aria-hidden="true">›</span>
          <button type="button" onClick={() => onReveal(item.selectionRange)}>
            {item.name}
          </button>
        </Fragment>
      ))}
      {flat.length > 0 && (
        <button
          type="button"
          className="breadcrumb-symbols"
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          title={zh ? "跳至符號" : "Go to symbol"}
          // Let a second click close the menu instead of dismissing and reopening it.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            setMenu(menu ? undefined : { x: box.left, y: box.bottom + 2 });
          }}
        >
          {zh ? "符號" : "Symbols"} ▾
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={zh ? "跳至符號" : "Go to symbol"}
          onClose={() => setMenu(undefined)}
        >
          <div className="breadcrumb-menu">
            {flat.map(({ item, depth }) => (
              <button
                key={`${item.kind}:${item.name}:${item.selectionRange.startLine}`}
                role="menuitem"
                type="button"
                style={{ paddingLeft: 9 + depth * 14 }}
                onClick={() => onReveal(item.selectionRange)}
              >
                <span>{item.name}</span>
                <kbd>{item.detail || KIND_LABELS[item.kind][zh ? 0 : 1]}</kbd>
              </button>
            ))}
          </div>
        </ContextMenu>
      )}
    </nav>
  );
}
