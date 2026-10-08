import { useId, useState } from "react";
import { Dialog, DialogActions } from "../components/dialog.js";
import type { Locale } from "../i18n/copy.js";
import { collabCopy } from "./collab-copy.js";

/** Unsaved editor text of shared files another participant deleted. */
export interface RemovedFilesPrompt {
  id: number;
  workspaceId: string;
  roomId: string;
  files: readonly { file: string; content: string }[];
}

/**
 * Asks whether to keep unsaved changes of remotely deleted files as a local copy. There is
 * no silent dismissal: the text is only in memory, so Escape does nothing.
 */
export function RemovedFilesDialog({
  prompt,
  locale,
  onKeep,
  onDiscard,
}: {
  prompt: RemovedFilesPrompt;
  locale: Locale;
  /** Saves the copy; rejects to keep the dialog open. */
  onKeep(prompt: RemovedFilesPrompt): Promise<void>;
  onDiscard(prompt: RemovedFilesPrompt): void;
}): React.JSX.Element {
  const copy = collabCopy[locale].removedFiles;
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = useId();
  return (
    <Dialog
      role="alertdialog"
      className="collab-removed-dialog"
      title={copy.title(prompt.files.length)}
      titleId={`${id}-title`}
      descriptionId={`${id}-intro`}
      intro={<p id={`${id}-intro`}>{copy.intro}</p>}
      onClose={() => {}}
    >
      <ul className="collab-removed-files" data-testid="collab-removed-files">
        {prompt.files.map(({ file }) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      <p className="collab-muted">{copy.keepHint}</p>
      <p className="collab-error" role="alert">
        {failed ? copy.failed : ""}
      </p>
      <DialogActions>
        <button
          type="button"
          data-testid="collab-removed-discard"
          disabled={pending}
          onClick={() => onDiscard(prompt)}
        >
          {copy.discard}
        </button>
        <button
          type="button"
          className="primary"
          data-modal-initial
          data-testid="collab-removed-keep"
          disabled={pending}
          onClick={() => {
            setPending(true);
            setFailed(false);
            onKeep(prompt).then(
              () => setPending(false),
              () => {
                setPending(false);
                setFailed(true);
              },
            );
          }}
        >
          {pending ? copy.keeping : copy.keep}
        </button>
      </DialogActions>
    </Dialog>
  );
}
