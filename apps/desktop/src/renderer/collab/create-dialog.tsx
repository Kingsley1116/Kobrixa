import { useId, useState } from "react";
import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
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
        if (!pending) onCreate(password);
      }}
    >
      <p>{copy.createIntro}</p>
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
        <button type="submit" className="primary" data-modal-initial disabled={pending}>
          {pending ? copy.starting : copy.startRoom}
        </button>
      </DialogActions>
    </Dialog>
  );
}
