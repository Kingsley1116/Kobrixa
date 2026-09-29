import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { validFileName } from "../lib/tools-state.js";
import type { ExportState } from "../lib/tools-state.js";
export type Translate = (zh: string, en: string) => string;
export function Icon({
  name = "image",
}: {
  name?: "image" | "audio" | "upload" | "check" | "arrow" | "download";
}) {
  const paths = {
    image: "M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M14 8h.01",
    audio: "M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4",
    upload: "M12 16V3m-5 5 5-5 5 5 M4 15v6h16v-6",
    check: "m5 12 4 4L19 6",
    arrow: "M4 12h16m-6-6 6 6-6 6",
    download: "M12 3v13m-5-5 5 5 5-5 M4 16v5h16v-5",
  };
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
export function useBlobUrl(blob: Blob | undefined) {
  const [entry, setEntry] = useState<{ blob: Blob; url: string }>();
  useEffect(() => {
    if (!blob) {
      setEntry(undefined);
      return;
    }
    const url = URL.createObjectURL(blob);
    setEntry({ blob, url });
    return () => URL.revokeObjectURL(url);
  }, [blob]);
  return entry?.blob === blob ? entry?.url : undefined;
}
export function Range({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  onChange,
  hint,
  t,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (n: number) => void;
  hint?: string;
  t: Translate;
}) {
  const id = useId();
  const invalid = !Number.isFinite(value) || value < min || value > max;
  const description = `${id}-description`;
  return (
    <div className="studio-control">
      <div className="control-top">
        <label htmlFor={id}>{label}</label>
        <div className="number-unit">
          <input
            className="ui-control"
            aria-label={label}
            aria-invalid={invalid}
            aria-describedby={description}
            type="number"
            min={min}
            max={max}
            step={step}
            value={Number.isFinite(value) ? value : ""}
            onChange={(e) => onChange(e.target.valueAsNumber)}
          />
          <span>{unit}</span>
        </div>
      </div>
      <input
        className="ui-range"
        id={id}
        aria-describedby={description}
        type="range"
        style={
          {
            "--ui-progress": `${Number.isFinite(value) && max > min ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0}%`,
          } as CSSProperties
        }
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p id={description} className={invalid ? "studio-error" : "control-hint"}>
        {invalid
          ? t(`請輸入 ${min}–${max}${unit} 的數值。`, `Enter a value from ${min} to ${max}${unit}.`)
          : hint}
      </p>
    </div>
  );
}
export function DropZone({
  kind,
  name,
  info,
  loading,
  active,
  onFile,
  onDemo,
  t,
}: {
  kind: "image" | "audio";
  name?: string | undefined;
  info?: string | undefined;
  loading: boolean;
  active: boolean;
  onFile: (file: File) => void;
  onDemo: () => void;
  t: Translate;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const upload = t("選擇檔案", "Choose file");
  return (
    <div
      id={`${kind}-import`}
      tabIndex={-1}
      aria-label={t("匯入素材", "Import media")}
      aria-busy={loading}
      className={`studio-drop ${drag ? "dragging" : ""} ${name ? "has-file" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget))
          setDrag(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (active && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
      }}
    >
      <span className="drop-icon">
        <Icon name={name ? kind : "upload"} />
      </span>
      <div className="drop-copy">
        <strong>{name ?? t("把素材拖到這裡", "Drop your file here")}</strong>
        <p>
          {loading
            ? t("正在讀取…", "Reading file…")
            : (info ??
              (kind === "image"
                ? t("PNG、JPEG、WebP · 也可以直接貼上圖片", "PNG, JPEG, WebP · or paste an image")
                : t(
                    "WAV、MP3 等瀏覽器可解碼的音頻",
                    "WAV, MP3 and other browser-decodable audio",
                  )))}
        </p>
      </div>
      <div className="drop-actions">
        <button
          type="button"
          className={`studio-button ${name ? "secondary" : "primary"}`}
          onClick={() => input.current?.click()}
        >
          {name ? t("替換檔案", "Replace file") : upload}
        </button>
        <button type="button" className="studio-text-button" onClick={onDemo}>
          {t("試用範例", "Try a demo")} <span aria-hidden="true">↗</span>
        </button>
      </div>
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={
          kind === "image" ? t("選擇圖片", "Choose image") : t("選擇音頻", "Choose audio")
        }
        tabIndex={-1}
        accept={
          kind === "image"
            ? "image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            : "audio/*,.wav,.mp3"
        }
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}
export function statusText(state: ExportState, t: Translate) {
  switch (state) {
    case "empty":
      return t("選擇素材或試用範例，即可開始。", "Choose a file or try a demo to begin.");
    case "loading":
      return t("正在讀取素材，請稍候…", "Reading your file. Please wait…");
    case "updating":
      return t("正在更新預覽與下載檔…", "Updating the preview and download…");
    case "invalid":
      return t("請修正標示的設定後再下載。", "Fix the highlighted settings to download.");
    case "error":
      return t("轉換失敗，請調整設定以重試。", "Conversion failed. Adjust the settings to retry.");
    case "filename":
      return t("請輸入有效的檔案名稱後再下載。", "Enter a valid file name to download.");
    case "ready":
      return t("預覽已更新，可以下載。", "Preview updated. Ready to download.");
  }
}
export function StudioStatus({ state, t }: { state: ExportState; t: Translate }) {
  return (
    <div className={`studio-status state-${state}`} role="status" aria-atomic="true">
      {statusText(state, t)}
    </div>
  );
}
export function StudioWorkflow({
  kind,
  hasSource,
  state,
  t,
}: {
  kind: "image" | "audio";
  hasSource: boolean;
  state: ExportState;
  t: Translate;
}) {
  return (
    <nav className="studio-workflow" aria-label={t("操作流程", "Workflow")}>
      <ol className="studio-steps">
        {[
          ["import", t("匯入", "Import")],
          ["preview", t("調整與預覽", "Adjust & preview")],
          ["download", t("下載", "Download")],
        ].map(([section, label], index) => (
          <li key={section}>
            <button
              type="button"
              disabled={index > 0 && !hasSource}
              onClick={() => {
                const target = document.getElementById(`${kind}-${section}`);
                target?.focus({ preventScroll: true });
                target?.scrollIntoView({
                  block: "start",
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                    ? "instant"
                    : "auto",
                });
              }}
            >
              <span>0{index + 1}</span>
              {label}
              {section === "download" && state === "ready" && (
                <span className="workflow-ready">{t("可下載", "Ready")}</span>
              )}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
export function StudioWorkspace({
  kind,
  preview,
  settings,
  download,
}: {
  kind: "image" | "audio";
  preview: ReactNode;
  settings: ReactNode;
  download: ReactNode;
}) {
  // DOM order also matches the single-column reading and keyboard order.
  return (
    <div className={`studio-workspace ${kind}-workspace`}>
      {preview}
      {settings}
      {download}
    </div>
  );
}
export function PanelTitle({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="studio-panel-title">
      <h2>
        <span>{number}</span>
        {title}
      </h2>
      {children}
    </div>
  );
}
export function DownloadCard({
  bytes,
  name,
  setName,
  extension,
  t,
  state,
  usageCode,
  usageIntro,
  children,
}: {
  bytes?: Uint8Array<ArrayBuffer> | undefined;
  name: string;
  setName: (name: string) => void;
  extension: "rgf" | "rsf" | "zip";
  t: Translate;
  state: ExportState;
  usageCode?: string;
  usageIntro?: string;
  children?: ReactNode;
}) {
  const blob = useMemo(
    () =>
      bytes
        ? new Blob([bytes], {
            type: extension === "zip" ? "application/zip" : "application/octet-stream",
          })
        : undefined,
    [bytes, extension],
  );
  const url = useBlobUrl(blob);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const valid = validFileName(name);
  const id = useId();
  const [downloaded, setDownloaded] = useState(false);
  const effectiveState = state === "ready" && !url ? "updating" : state;
  const ready = effectiveState === "ready";
  useEffect(() => setDownloaded(false), [bytes, name, state]);
  const file = `${name.trim()}.${extension}`;
  const code =
    usageCode ??
    (extension === "rgf"
      ? `LCD.BmpFile(1, 0, 0, "assets/deploy/${name.trim()}")\nLCD.Update()`
      : `Speaker.Play(35, "assets/deploy/${name.trim()}")\nSpeaker.Wait()`);
  useEffect(() => setCopyState("idle"), [code]);
  return (
    <div
      className="studio-download"
      id={`${extension === "rgf" ? "image" : "audio"}-download`}
      tabIndex={-1}
      aria-label={t("下載素材", "Download media")}
    >
      <PanelTitle number="03" title={t("帶到你的 EV3", "Take it to your EV3")} />
      <div className="export-row">
        <label className="export-name">
          {t("檔案名稱", "File name")}
          <div>
            <input
              className="ui-control"
              aria-label={t("檔案名稱", "File name")}
              aria-invalid={!valid}
              aria-describedby={!valid ? `${id}-name-error` : undefined}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <span>.{extension}</span>
          </div>
        </label>
        <div className="export-action">
          <span className="export-size">
            {ready && bytes
              ? `${bytes.length.toLocaleString()} bytes · ${extension.toUpperCase()}`
              : extension.toUpperCase()}
          </span>
          {ready && url ? (
            <a
              className="studio-button primary"
              href={url}
              download={file}
              aria-describedby={`${id}-status`}
              onClick={() => setDownloaded(true)}
            >
              <Icon name="download" />
              {t("下載", "Download")} {extension.toUpperCase()}
            </a>
          ) : (
            <button className="studio-button primary" disabled aria-describedby={`${id}-status`}>
              <Icon name="download" />
              {t("下載", "Download")} {extension.toUpperCase()}
            </button>
          )}
        </div>
      </div>
      <p id={`${id}-status`} className={`download-status state-${effectiveState}`} role="status">
        {downloaded ? t("已開始下載", "Download started") : statusText(effectiveState, t)}
        {ready && <span className="download-filename">{file}</span>}
      </p>
      {!valid && (
        <p id={`${id}-name-error`} className="studio-error" role="alert">
          {t(
            "請輸入不含斜線、引號或特殊路徑符號的檔名。",
            "Enter a file name without slashes, quotes or reserved path characters.",
          )}
        </p>
      )}
      {children}
      <details className="usage-details">
        <summary className="ui-disclosure">
          {t("如何在 Kobrixa 使用？", "How do I use this in Kobrixa?")}
        </summary>
        <p>
          {usageIntro ??
            t(
              "將檔案放進專案的 assets/deploy 資料夾，並在 kobrixa.json 的 assets 加入 assets/deploy/**/*。上傳專案後使用以下程式：",
              "Put the file in your project's assets/deploy folder and include assets/deploy/**/* in kobrixa.json's assets list. Upload the project, then use:",
            )}
        </p>
        {valid && (
          <>
            <pre>
              <code>{code}</code>
            </pre>
            <button
              className="studio-text-button"
              onClick={() => {
                void Promise.resolve()
                  .then(() => navigator.clipboard.writeText(code))
                  .then(() => setCopyState("copied"))
                  .catch(() => setCopyState("failed"));
              }}
            >
              {t("複製程式碼", "Copy code")}
            </button>
            <span role="status">
              {copyState === "copied"
                ? t("已複製", "Copied")
                : copyState === "failed"
                  ? t("請選取上方程式碼複製", "Select the code above to copy")
                  : ""}
            </span>
          </>
        )}
      </details>
    </div>
  );
}
export function EmptyPreview({ kind, t }: { kind: "image" | "audio"; t: Translate }) {
  return (
    <div className="studio-empty">
      <div className={`empty-art ${kind}`}>
        <Icon name={kind} />
        <span />
        <span />
        <span />
      </div>
      <h3>{t("讓素材準備好登上 EV3", "A little file. A big idea.")}</h3>
      <p>
        {kind === "image"
          ? t(
              "匯入圖片，馬上比較原圖與黑白效果。",
              "Import an image to compare the original with its EV3 version.",
            )
          : t(
              "匯入音頻，在波形上選出你想保留的片段。",
              "Import audio and choose the part you want on the waveform.",
            )}
      </p>
    </div>
  );
}
