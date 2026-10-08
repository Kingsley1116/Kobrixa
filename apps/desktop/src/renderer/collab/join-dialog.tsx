import { useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogActions } from "../components/dialog.js";
import { collabErrorMessage, type CollabCopy } from "./collab-copy.js";
import {
  displayNameProblem,
  formatInviteCode,
  isValidInviteCode,
  type LobbyError,
} from "./collab-lobby.js";
import { DisplayNameField, PasswordField } from "./dialog-fields.js";

/** Server errors that mean the invite code itself is wrong. */
const CODE_ERRORS: ReadonlySet<LobbyError> = new Set(["not-found", "expired", "bad-request"]);
const PASSWORD_ERRORS: ReadonlySet<LobbyError> = new Set(["password-required", "invalid-password"]);

/** Invite-code entry for guests. The lobby controller performs the join. */
export function JoinDialog({
  copy,
  displayName,
  onName,
  initialCode = "",
  roomName,
  pending,
  error,
  onJoin,
  onEdit,
  onClose,
}: {
  copy: CollabCopy;
  displayName: string;
  onName?(name: string): void;
  initialCode?: string;
  /** Project name of the room being rejoined from the recent list, for context. */
  roomName?: string | undefined;
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
  const [nameTouched, setNameTouched] = useState(false);
  // Focus the name first when it still has to be filled in.
  const [nameFirst] = useState(() => displayNameProblem(displayName) !== null);
  const nameInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const invalid = showInvalid && !isValidInviteCode(code);
  const codeError = invalid || (error !== null && CODE_ERRORS.has(error));
  const passwordError = error !== null && PASSWORD_ERRORS.has(error);
  const message = invalid ? copy.inviteCodeInvalid : error ? collabErrorMessage(copy, error) : "";
  const nameValid = displayNameProblem(displayName) === null;

  // Move focus to the field the server rejected so it can be corrected right away.
  useEffect(() => {
    if (error === "invalid-password") setPassword("");
    if (error !== null && PASSWORD_ERRORS.has(error)) passwordInput.current?.focus();
    else if (error !== null && CODE_ERRORS.has(error)) {
      codeInput.current?.focus();
      codeInput.current?.select();
    }
  }, [error]);

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
        if (!nameValid) {
          setNameTouched(true);
          nameInput.current?.focus();
          return;
        }
        if (!isValidInviteCode(code)) {
          setShowInvalid(true);
          codeInput.current?.focus();
          return;
        }
        onJoin(code, password);
      }}
    >
      {roomName && (
        <p className="collab-callout" data-testid="collab-join-room">
          {copy.joinRoomContext(roomName)}
        </p>
      )}
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
      <label className="collab-dialog-field">
        {copy.inviteCode}
        <input
          ref={codeInput}
          data-modal-initial={nameFirst ? undefined : true}
          data-testid="collab-invite-code"
          className="collab-invite-input"
          value={code}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          inputMode="text"
          placeholder="ABCD-EFGH-JK23"
          readOnly={pending}
          aria-invalid={codeError}
          aria-describedby={codeError ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => {
            const next = formatInviteCode(event.target.value);
            setCode(next);
            if (showInvalid && isValidInviteCode(next)) setShowInvalid(false);
            onEdit();
          }}
        />
        <small id={hintId}>{copy.inviteCodeHint}</small>
      </label>
      <PasswordField
        copy={copy}
        testId="collab-join-password"
        value={password}
        onChange={(value) => {
          setPassword(value);
          onEdit();
        }}
        pending={pending}
        autoComplete="off"
        invalid={passwordError}
        describedBy={passwordError ? `${id}-password-hint ${errorId}` : `${id}-password-hint`}
        inputRef={passwordInput}
      >
        <small id={`${id}-password-hint`}>{copy.joinPasswordHint}</small>
      </PasswordField>
      {nameValid && <p className="collab-join-as">{copy.joiningAs(displayName.trim())}</p>}
      <p id={errorId} className="collab-error" role="alert" data-testid="collab-join-error">
        {message}
      </p>
      <DialogActions>
        <button type="button" disabled={pending} onClick={onClose}>
          {copy.cancel}
        </button>
        <button className="primary" type="submit" disabled={pending}>
          {pending ? copy.joining : copy.join}
        </button>
      </DialogActions>
    </Dialog>
  );
}
