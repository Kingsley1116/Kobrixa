import { useId } from "react";
import { Dialog, DialogActions } from "../components/dialog.js";
import { collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import type { LobbyError } from "./collab-lobby.js";

export function CreateDialog({
  copy,
  projectName,
  displayName,
  pending,
  error,
  onCreate,
  onClose,
}: {
  copy: CollabCopy;
  projectName: string;
  displayName: string;
  pending: boolean;
  error: LobbyError | null;
  onCreate(): void;
  onClose(): void;
}): React.JSX.Element {
  const id = useId();
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
        if (!pending) onCreate();
      }}
    >
      <p>{copy.createIntro}</p>
      <p>{copy.hostingAs(displayName.trim())}</p>
      <p className="collab-error" role="alert" data-testid="collab-create-error">
        {error ? collabErrorMessage(copy, error) : ""}
      </p>
      <DialogActions>
        <button type="button" disabled={pending} onClick={onClose}>
          {copy.cancel}
        </button>
        <button type="submit" className="primary" data-modal-initial disabled={pending}>
          {pending ? copy.starting : copy.startRoom}
        </button>
      </DialogActions>
    </Dialog>
  );
}
