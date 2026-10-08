import { useId } from "react";
import type { CollabJoinChange, CollabJoinResolution } from "../../shared/collab.js";
import type { Locale } from "../i18n/copy.js";
import { Dialog, DialogActions } from "../components/dialog.js";
import { collabCopy } from "./collab-copy.js";

/** Lists up to this many differing files expanded; longer lists start collapsed. */
const EXPANDED_FILES = 5;

/**
 * Asks how to handle local changes made since the last room sync before the
 * room's version is synced over them. `onChoose(null)` cancels joining.
 */
export function JoinConflictDialog({
  locale,
  projectName,
  changes,
  onChoose,
}: {
  locale: Locale;
  projectName: string;
  changes: readonly CollabJoinChange[];
  onChoose(resolution: CollabJoinResolution | null): void;
}): React.JSX.Element {
  const copy = collabCopy[locale];
  const id = useId();
  const colon = locale === "zh-TW" ? "：" : ": ";
  return (
    <Dialog
      className="collab-join-conflict-dialog"
      title={copy.joinConflictTitle}
      titleId={`${id}-title`}
      descriptionId={`${id}-intro`}
      role="alertdialog"
      onClose={() => onChoose(null)}
    >
      <p id={`${id}-intro`} className="modal-description">
        {copy.joinConflictIntro(projectName)}
      </p>
      <details open={changes.length <= EXPANDED_FILES}>
        <summary>{copy.joinConflictFiles(changes.length)}</summary>
        <ul className="collab-share-preview" data-testid="collab-conflict-files">
          {changes.map((change) => (
            <li key={change.path}>
              {change.path} — {copy.joinConflictChanges[change.change]}
            </li>
          ))}
        </ul>
      </details>
      <p id={`${id}-keep`}>
        <strong>
          {copy.joinKeepCopy}
          {colon}
        </strong>
        {copy.joinKeepCopyHint}
      </p>
      <p id={`${id}-replace`}>
        <strong>
          {copy.joinReplace}
          {colon}
        </strong>
        {copy.joinReplaceHint}
      </p>
      <DialogActions className="three-actions">
        <button type="button" data-testid="collab-conflict-cancel" onClick={() => onChoose(null)}>
          {copy.cancel}
        </button>
        <button
          type="button"
          className="danger"
          data-testid="collab-conflict-replace"
          aria-describedby={`${id}-replace`}
          onClick={() => onChoose("replace")}
        >
          {copy.joinReplace}
        </button>
        <button
          type="button"
          className="primary"
          data-modal-initial
          data-testid="collab-conflict-keep"
          aria-describedby={`${id}-keep`}
          onClick={() => onChoose("keep-copy")}
        >
          {copy.joinKeepCopy}
        </button>
      </DialogActions>
    </Dialog>
  );
}
