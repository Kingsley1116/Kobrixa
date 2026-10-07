import { useId, useState } from "react";
import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
import { Dialog, DialogActions } from "../components/dialog.js";
import { collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import { formatInviteCode, isValidInviteCode, type LobbyError } from "./collab-lobby.js";

/** Invite-code entry for guests. The lobby controller performs the join. */
export function JoinDialog({
  copy,
  displayName,
  initialCode = "",
  pending,
  error,
  onJoin,
  onEdit,
  onClose,
}: {
  copy: CollabCopy;
  displayName: string;
  initialCode?: string;
  pending: boolean;
  error: LobbyError | null;
  onJoin(code: string, password: string): void;
  /** Called when the code changes, so a stale server error can be cleared. */
  onEdit(): void;
  onClose(): void;
}): React.JSX.Element {
  const [code, setCode] = useState(() => formatInviteCode(initialCode));
  const [password, setPassword] = useState("");
  const [showInvalid, setShowInvalid] = useState(false);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = showInvalid && !isValidInviteCode(code);
  const message = invalid ? copy.inviteCodeInvalid : error ? collabErrorMessage(copy, error) : "";
  return (
    <Dialog
      className="collab-join-dialog"
      title={copy.joinTitle}
      titleId={`${id}-title`}
      descriptionId={`${id}-intro`}
      intro={<p id={`${id}-intro`}>{copy.joinIntro}</p>}
      onClose={() => {
        if (!pending) onClose();
      }}
      onSubmit={() => {
        if (pending) return;
        if (!isValidInviteCode(code)) {
          setShowInvalid(true);
          return;
        }
        onJoin(code, password);
      }}
    >
      <label>
        {copy.inviteCode}
        <input
          data-modal-initial
          data-testid="collab-invite-code"
          className="collab-invite-input"
          value={code}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          inputMode="text"
          placeholder="ABCD-EFGH-JK23"
          readOnly={pending}
          aria-invalid={
            invalid ||
            (Boolean(error) && error !== "password-required" && error !== "invalid-password")
          }
          aria-describedby={message ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            const next = formatInviteCode(event.target.value);
            setCode(next);
            if (showInvalid && isValidInviteCode(next)) setShowInvalid(false);
            onEdit();
          }}
        />
        <small id={hintId}>{copy.inviteCodeHint}</small>
      </label>
      <label>
        {copy.roomPassword}
        <input
          type="password"
          data-testid="collab-join-password"
          value={password}
          maxLength={COLLAB_LIMITS.roomPasswordLength}
          autoComplete="off"
          readOnly={pending}
          aria-invalid={error === "password-required" || error === "invalid-password"}
          aria-describedby={`${id}-password-hint ${errorId}`}
          onChange={(event) => {
            setPassword(event.target.value);
            onEdit();
          }}
        />
        <small id={`${id}-password-hint`}>{copy.joinPasswordHint}</small>
      </label>
      <p className="collab-join-as">{copy.joiningAs(displayName.trim())}</p>
      <p id={errorId} className="collab-error" role="alert" data-testid="collab-join-error">
        {message}
      </p>
      <DialogActions>
        <button type="button" disabled={pending} onClick={onClose}>
          {copy.cancel}
        </button>
        <button className="primary" type="submit" disabled={pending || !code}>
          {pending ? copy.joining : copy.join}
        </button>
      </DialogActions>
    </Dialog>
  );
}
