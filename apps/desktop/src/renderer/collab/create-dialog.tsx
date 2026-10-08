import type { CollabSharePreview } from "../../shared/collab.js";
import type { Locale } from "../i18n/copy.js";
import { useId, useRef, useState } from "react";
import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
import { Dialog, DialogActions } from "../components/dialog.js";
import { collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import { displayNameProblem, type LobbyError } from "./collab-lobby.js";
import { DisplayNameField, PasswordField } from "./dialog-fields.js";

const MIB = 1024 * 1024;

export function CreateDialog({
  copy,
  preview,
  previewLoading = false,
  previewError,
  onRetryPreview,
  projectName,
  displayName,
  onName,
  pending,
  error,
  onCreate,
  onClose,
}: {
  copy: CollabCopy;
  /** Unused: `copy` is already localized. Kept so existing callers still type-check. */
  locale?: Locale;
  preview?: CollabSharePreview | undefined;
  previewLoading?: boolean;
  previewError?: string | undefined;
  /** When provided, a failed preview offers a retry button. */
  onRetryPreview?(): void;
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
  const [nameTouched, setNameTouched] = useState(false);
  // Focus the name first when it still has to be filled in.
  const [nameFirst] = useState(() => displayNameProblem(displayName) !== null);
  const nameInput = useRef<HTMLInputElement>(null);
  const nameValid = displayNameProblem(displayName) === null;
  // A failed preview must not keep the dialog blocked as if it were still checking.
  const checking = previewLoading && !previewError;
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
        if (pending || checking) return;
        if (!nameValid) {
          setNameTouched(true);
          nameInput.current?.focus();
          return;
        }
        onCreate(password);
      }}
    >
      <DisplayNameField
        copy={copy}
        id={id}
        value={displayName}
        onName={onName}
        pending={pending}
        touched={nameTouched}
        onTouched={() => setNameTouched(true)}
        initial={nameFirst}
        inputRef={nameInput}
      />
      <div className="collab-callout" data-testid="collab-create-privacy">
        <p>{copy.createIntro}</p>
        <p className="collab-muted">
          {copy.shareLimits(
            COLLAB_LIMITS.files,
            COLLAB_LIMITS.fileBytes / MIB,
            COLLAB_LIMITS.roomFileBytes / MIB,
          )}
        </p>
      </div>
      <SharePreview
        copy={copy}
        preview={preview}
        loading={checking}
        error={previewError}
        onRetry={onRetryPreview}
      />
      {nameValid && <p className="collab-dialog-note">{copy.hostingAs(displayName.trim())}</p>}
      <PasswordField
        copy={copy}
        testId="collab-create-password"
        value={password}
        onChange={setPassword}
        pending={pending}
        autoComplete="new-password"
        describedBy={`${id}-password-hint ${id}-password-share`}
      >
        <small id={`${id}-password-hint`}>{copy.createPasswordHint}</small>
        <small id={`${id}-password-share`}>{copy.createPasswordShare}</small>
      </PasswordField>
      <p className="collab-error" role="alert" data-testid="collab-create-error">
        {error ? collabErrorMessage(copy, error) : ""}
      </p>
      <DialogActions>
        <button
          type="button"
          data-testid="collab-create-cancel"
          disabled={pending}
          onClick={onClose}
        >
          {copy.cancel}
        </button>
        <button
          type="submit"
          className="primary"
          data-modal-initial={nameFirst ? undefined : true}
          disabled={pending || checking}
        >
          {pending ? copy.starting : copy.startRoom}
        </button>
      </DialogActions>
    </Dialog>
  );
}

function SharePreview({
  copy,
  preview,
  loading,
  error,
  onRetry,
}: {
  copy: CollabCopy;
  preview: CollabSharePreview | undefined;
  loading: boolean;
  error: string | undefined;
  onRetry: (() => void) | undefined;
}): React.JSX.Element | null {
  if (error)
    return (
      <div className="collab-share-status">
        <p className="collab-error" role="alert" data-testid="collab-share-preview-error">
          {error}
        </p>
        {onRetry && (
          <button type="button" data-testid="collab-share-preview-retry" onClick={onRetry}>
            {copy.sharePreviewRetry}
          </button>
        )}
      </div>
    );
  if (loading)
    return (
      <p className="collab-muted" role="status">
        {copy.sharePreviewChecking}
      </p>
    );
  if (!preview) return null;
  const { shared, skipped } = preview;
  return (
    <div className="collab-share-summary" data-testid="collab-share-preview">
      <p>{copy.sharePreviewSummary(shared.length, skipped.length)}</p>
      {skipped.length > 0 && (
        <details open data-testid="collab-share-excluded">
          <summary>{copy.sharePreviewExcluded(skipped.length)}</summary>
          <ul className="collab-share-preview">
            {skipped.map((file) => (
              <li key={file.path}>
                <span className="collab-share-path">{file.path}</span>{" "}
                <span className="collab-muted">— {copy.shareSkipReasons[file.reason]}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {shared.length > 0 && (
        <details data-testid="collab-share-shared">
          <summary>{copy.sharePreviewShared(shared.length)}</summary>
          <ul className="collab-share-preview">
            {shared.map((file) => (
              <li key={file} className="collab-share-path">
                {file}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
