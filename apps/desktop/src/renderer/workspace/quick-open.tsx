import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../components/dialog.js";
import { canFocus } from "../components/modal.js";
import type { Locale } from "../i18n/copy.js";
import { quickOpenMatches, type QuickOpenPosition } from "./quick-open-matcher.js";
import "./quick-open.css";

const copy = {
  en: {
    title: "Quick open",
    query: "Find a project file",
    placeholder: "File name or path; add :line[:column] to jump",
    help: "↑ ↓ to choose · Enter to open · Esc to close",
    empty: "No matching files. Try a different name or path.",
    noFiles: "No editable files in this project.",
    results: "Matching project files",
    close: "Close quick open",
    current: "Current",
    recent: "Recent",
    count: (shown: number, total: number) =>
      shown < total ? `${shown} of ${total} files · type more to narrow` : `${total} files`,
    position: (line: number, column: number) => `Open at line ${line}, column ${column}`,
  },
  "zh-TW": {
    title: "快速開檔",
    query: "尋找專案檔案",
    placeholder: "輸入檔名或路徑；加上 :行號[:欄號] 跳轉",
    help: "↑ ↓ 選擇 · Enter 開啟 · Esc 關閉",
    empty: "沒有符合的檔案，試試其他檔名或路徑。",
    noFiles: "此專案尚無可編輯的檔案。",
    results: "符合的專案檔案",
    close: "關閉快速開檔",
    current: "目前",
    recent: "最近",
    count: (shown: number, total: number) =>
      shown < total
        ? `顯示 ${total} 個檔案中的 ${shown} 個 · 繼續輸入以縮小範圍`
        : `${total} 個檔案`,
    position: (line: number, column: number) => `開啟至第 ${line} 行、第 ${column} 欄`,
  },
} as const;

export interface QuickOpenProps {
  locale: Locale;
  files: string[];
  activeFile?: string | undefined;
  recentFiles?: string[] | undefined;
  onOpen(file: string, position?: QuickOpenPosition): void;
  onClose(): void;
}

function highlighted(text: string, positions: number[], offset: number): React.ReactNode {
  const matched = new Set(positions);
  const parts: React.ReactNode[] = [];
  for (let start = 0; start < text.length;) {
    const selected = matched.has(start + offset);
    let end = start + 1;
    while (end < text.length && matched.has(end + offset) === selected) end++;
    const part = text.slice(start, end);
    parts.push(selected ? <mark key={start}>{part}</mark> : part);
    start = end;
  }
  return parts;
}

export function QuickOpen({
  locale,
  files,
  activeFile,
  recentFiles,
  onOpen,
  onClose,
}: QuickOpenProps): React.JSX.Element {
  const t = copy[locale];
  const id = useId();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  const opening = useRef(false);
  const composing = useRef(false);
  const list = useRef<HTMLUListElement>(null);
  const result = useMemo(
    () => quickOpenMatches(files, query, { activeFile, recentFiles }),
    [files, query, activeFile, recentFiles],
  );
  const index = Math.min(selected, Math.max(result.matches.length - 1, 0));
  const optionId = (value: number) => `${id}-option-${value}`;
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView?.({ block: "nearest" });
  }, [index, result]);
  useEffect(
    () => () => {
      // Modal removes its inert background before this passive cleanup. A chosen
      // file owns focus through onOpen; dismissing restores the original control.
      if (!opening.current && canFocus(opener)) opener.focus();
    },
    [opener],
  );
  const open = (file: string) => {
    opening.current = true;
    onClose();
    onOpen(file, result.position);
  };
  return (
    <Dialog
      title={t.title}
      className="quick-open-dialog"
      descriptionId={`${id}-help`}
      restoreFocus={false}
      onClose={onClose}
    >
      <div data-quick-open className="quick-open-content">
        <button className="quick-open-close" aria-label={t.close} onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
        <input
          data-modal-initial
          data-quick-open-query
          role="combobox"
          aria-label={t.query}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-activedescendant={result.matches.length ? optionId(index) : undefined}
          aria-describedby={`${id}-help ${id}-count`}
          placeholder={t.placeholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelected(0);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
              // In particular, Escape must not bubble to Modal while cancelling IME.
              event.stopPropagation();
              return;
            }
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            let next: number | undefined;
            if (event.key === "ArrowDown") next = index + 1;
            else if (event.key === "ArrowUp") next = index - 1;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = result.matches.length - 1;
            else if (event.key === "Enter") {
              const match = result.matches[index];
              if (match) open(match.file);
            } else if (event.key === "Escape") onClose();
            else return;
            event.preventDefault();
            event.stopPropagation();
            if (next !== undefined)
              setSelected(Math.max(0, Math.min(next, result.matches.length - 1)));
          }}
        />
        <div className="quick-open-summary" id={`${id}-count`} role="status" aria-live="polite">
          <span>{t.count(result.matches.length, result.total)}</span>
          {result.position && (
            <span>{t.position(result.position.line, result.position.column)}</span>
          )}
        </div>
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label={t.results}>
          {result.matches.map((match, matchIndex) => {
            const split = Math.max(match.file.lastIndexOf("/"), match.file.lastIndexOf("\\")) + 1;
            const name = match.file.slice(split);
            const directory = match.file.slice(0, Math.max(split - 1, 0));
            return (
              <li
                key={match.file}
                id={optionId(matchIndex)}
                role="option"
                aria-selected={index === matchIndex}
                aria-label={match.file}
                data-quick-open-path={match.file}
                title={match.file}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => open(match.file)}
              >
                <span className="quick-open-file">
                  <span className="quick-open-name">
                    {highlighted(name, match.positions, split)}
                  </span>
                  {directory && (
                    <span className="quick-open-directory">
                      {highlighted(directory, match.positions, 0)}
                    </span>
                  )}
                </span>
                {(match.file === activeFile || recentFiles?.includes(match.file)) && (
                  <span className="quick-open-badge">
                    {match.file === activeFile ? t.current : t.recent}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {!result.matches.length && (
          <p className="quick-open-empty">{files.length ? t.empty : t.noFiles}</p>
        )}
        <p className="quick-open-help" id={`${id}-help`}>
          {t.help}
        </p>
      </div>
    </Dialog>
  );
}
