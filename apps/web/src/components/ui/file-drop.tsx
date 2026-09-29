import { useRef, useState } from "react";

type Translate = (zh: string, en: string) => string;
export function FileDrop({
  accept,
  multiple = false,
  disabled = false,
  label,
  onFiles,
  t,
}: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  label: string;
  onFiles: (files: File[]) => void;
  t: Translate;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [names, setNames] = useState<string[]>([]);
  function receive(files: File[]) {
    if (!files.length || disabled || input.current?.matches(":disabled")) return;
    setNames(
      files
        .map((file) => file.name)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    );
    onFiles(files);
  }
  return (
    <div
      className="ui-file-drop"
      data-dragging={drag}
      data-disabled={disabled}
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled && !input.current?.matches(":disabled")) setDrag(true);
      }}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setDrag(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDrag(false);
        receive(Array.from(event.dataTransfer.files));
      }}
    >
      <svg className="ui-upload-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="ui-file-copy">
        <strong>{label}</strong>
        <p>
          {t("拖曳檔案到這裡，或使用按鈕選擇。", "Drop files here, or use the button to browse.")}
        </p>
        {names.length > 0 && (
          <div role="status">
            <p>{t(`已選擇 ${names.length} 個檔案`, `${names.length} file(s) selected`)}</p>
            <ul>
              {names.map((name, index) => (
                <li key={`${name}-${index}`}>{name}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <button
        type="button"
        className="ui-button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {names.length ? t("替換檔案", "Replace files") : t("選擇檔案", "Choose files")}
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => {
          receive(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
    </div>
  );
}
