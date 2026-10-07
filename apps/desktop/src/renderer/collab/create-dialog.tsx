import type { CollabSharePreview } from "../../shared/collab.js";
import type { Locale } from "../i18n/copy.js";
import { useId, useState } from "react";
import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
import { Dialog, DialogActions } from "../components/dialog.js";
import { collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import type { LobbyError } from "./collab-lobby.js";

export function CreateDialog({
  copy,
  locale = "en",
  preview,
  previewLoading = false,
  previewError,
  projectName,
  displayName,
  onName,
  pending,
  error,
  onCreate,
  onClose,
}: {
  copy: CollabCopy;
  locale?: Locale;
  preview?: CollabSharePreview | undefined;
  previewLoading?: boolean;
  previewError?: string;
  projectName: string;
  displayName: string;
  onName?(name: string): void;
  pending: boolean;
  error: LobbyError | null;
  onCreate(password: string): void;
  onClose(): void;
}): React.JSX.Element {
  const id = useId();
  const [password, setPassword] = useState("");
  return (
    <Dialog
      className="collab-create-dialog"
      title={copy.startRoom}
      titleId={`${id}-title`}
      descriptionId={`${id}-intro`}
      intro={<p id={`${id}-intro`}>{copy.startHint(projectName)}</p>}
      onClose={() => {
        if (!pending) onClose();
      }}
      onSubmit={() => {
        if (!pending && !previewLoading) onCreate(password);
      }}
    >
      <label>
        {copy.displayName}
        <input
          data-testid="collab-display-name"
          value={displayName}
          onChange={(event) => onName?.(event.target.value)}
          autoComplete="nickname"
          maxLength={COLLAB_LIMITS.displayNameLength}
          disabled={pending}
          required
        />
      </label>
      <p>{copy.createIntro}</p>
      <p>
        {locale === "zh-TW"
          ? "支援 .bp、.bpi、.bpm、.json；最多 200 個檔案，每個 1 MiB，合計 8 MiB。"
          : "Supports .bp, .bpi, .bpm and .json; up to 200 files, 1 MiB each and 8 MiB total."}
      </p>
      {previewLoading && !previewError && (
        <p role="status">{locale === "zh-TW" ? "正在檢查分享檔案…" : "Checking files to share…"}</p>
      )}
      {previewError && <p role="alert">{previewError}</p>}
      {preview && (
        <details open={preview.skipped.length > 0}>
          <summary>
            {locale === "zh-TW"
              ? `將分享 ${preview.shared.length} 個檔案；${preview.skipped.length} 個不會同步`
              : `${preview.shared.length} files shared; ${preview.skipped.length} excluded`}
          </summary>
          <ul className="collab-share-preview">
            {preview.skipped.map((file) => (
              <li key={file.path}>
                {file.path} —{" "}
                {file.reason === "format"
                  ? locale === "zh-TW"
                    ? "不支援的格式或路徑"
                    : "Unsupported format or path"
                  : locale === "zh-TW"
                    ? "超過分享限制"
                    : "Exceeds sharing limit"}
              </li>
            ))}
            {preview.shared.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </details>
      )}
      <p>{copy.hostingAs(displayName.trim())}</p>
      <label>
        {copy.roomPassword}
        <input
          type="password"
          data-testid="collab-create-password"
          value={password}
          maxLength={COLLAB_LIMITS.roomPasswordLength}
          autoComplete="new-password"
          readOnly={pending}
          aria-describedby={`${id}-password-hint`}
          onChange={(event) => setPassword(event.target.value)}
        />
        <small id={`${id}-password-hint`}>{copy.createPasswordHint}</small>
      </label>
      <p className="collab-error" role="alert" data-testid="collab-create-error">
        {error ? collabErrorMessage(copy, error) : ""}
      </p>
      <DialogActions>
        <button type="button" disabled={pending} onClick={onClose}>
          {copy.cancel}
        </button>
        <button
          type="submit"
          className="primary"
          data-modal-initial
          disabled={pending || previewLoading || !displayName.trim()}
        >
          {pending ? copy.starting : copy.startRoom}
        </button>
      </DialogActions>
    </Dialog>
  );
}
