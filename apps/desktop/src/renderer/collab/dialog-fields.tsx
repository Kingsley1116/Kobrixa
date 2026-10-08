import { useId, useState, type ReactNode, type Ref } from "react";
import { COLLAB_LIMITS } from "@kobrixa/collab-protocol";
import type { CollabCopy } from "./collab-copy.js";
import { displayNameProblem } from "./collab-lobby.js";

/**
 * Whether the display-name problem should be shown. An empty name is only
 * reported once the person leaves the field or tries to submit, so the dialog
 * doesn't open with an error.
 */
export function visibleNameProblem(
  name: string,
  touched: boolean,
): ReturnType<typeof displayNameProblem> {
  const problem = displayNameProblem(name);
  return problem === "empty" && !touched ? null : problem;
}

/** Display-name input shared by the create and join dialogs. */
export function DisplayNameField({
  copy,
  id,
  value,
  onName,
  pending,
  touched,
  onTouched,
  initial,
  inputRef,
}: {
  copy: CollabCopy;
  id: string;
  value: string;
  onName: ((name: string) => void) | undefined;
  pending: boolean;
  /** Show an empty-name problem (after blur or a submit attempt). */
  touched: boolean;
  onTouched(): void;
  /** Receives initial dialog focus. */
  initial: boolean;
  inputRef?: Ref<HTMLInputElement>;
}): React.JSX.Element {
  const problem = visibleNameProblem(value, touched);
  const hintId = `${id}-name-hint`;
  const errorId = `${id}-name-error`;
  return (
    <div className="collab-dialog-field">
      <label htmlFor={`${id}-name`}>{copy.displayName}</label>
      <input
        id={`${id}-name`}
        ref={inputRef}
        data-testid="collab-display-name"
        data-modal-initial={initial || undefined}
        value={value}
        onChange={(event) => onName?.(event.target.value)}
        onBlur={onTouched}
        autoComplete="nickname"
        maxLength={COLLAB_LIMITS.displayNameLength}
        readOnly={pending}
        aria-required
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${hintId} ${errorId}` : hintId}
      />
      <small id={hintId}>{copy.displayNameHint}</small>
      {problem && (
        <small
          id={errorId}
          className="collab-error"
          role="alert"
          data-testid="collab-display-name-error"
        >
          {copy.displayNameProblems[problem]}
        </small>
      )}
    </div>
  );
}

/** Password input with a show/hide toggle. The value never leaves the dialog state. */
export function PasswordField({
  copy,
  testId,
  value,
  onChange,
  pending,
  autoComplete,
  invalid = false,
  describedBy,
  inputRef,
  children,
}: {
  copy: CollabCopy;
  testId: string;
  value: string;
  onChange(value: string): void;
  pending: boolean;
  autoComplete: string;
  invalid?: boolean;
  describedBy: string;
  inputRef?: Ref<HTMLInputElement>;
  /** Hints rendered under the input. */
  children?: ReactNode;
}): React.JSX.Element {
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  return (
    <div className="collab-dialog-field">
      <label htmlFor={inputId}>{copy.roomPassword}</label>
      <span className="collab-password-row">
        <input
          id={inputId}
          ref={inputRef}
          type={visible ? "text" : "password"}
          data-testid={testId}
          value={value}
          maxLength={COLLAB_LIMITS.roomPasswordLength}
          autoComplete={autoComplete}
          spellCheck={false}
          readOnly={pending}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="collab-password-toggle"
          data-testid={`${testId}-toggle`}
          aria-label={visible ? copy.hidePasswordLabel : copy.showPasswordLabel}
          onClick={() => setVisible((shown) => !shown)}
        >
          {visible ? copy.hidePassword : copy.showPassword}
        </button>
      </span>
      {children}
    </div>
  );
}
