import { useId, type ReactNode } from "react";
import type { Locale } from "../i18n/copy.js";
import { Picker, type PickerOption } from "../components/picker.js";

interface FieldProps {
  id: string;
  label: string;
  hint?: string | undefined;
  hintId?: string | undefined;
}

export function SettingField({
  id,
  label,
  hint,
  hintId,
  children,
}: FieldProps & {
  children: ReactNode;
}): React.JSX.Element {
  return (
    <div className="setting-row">
      <div>
        <label htmlFor={id}>{label}</label>
        {hint && <p id={hintId ?? `${id}-hint`}>{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function SettingSelect<T extends string | number>({
  id,
  label,
  hint,
  hintId,
  ...picker
}: Omit<FieldProps, "id"> & {
  id?: string;
  locale: Locale;
  value: T;
  options: PickerOption<T>[];
  onChange(value: T): void;
  disabled?: boolean;
}): React.JSX.Element {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const descriptionId = hint ? (hintId ?? `${controlId}-hint`) : undefined;
  return (
    <SettingField id={controlId} label={label} hint={hint} hintId={descriptionId}>
      <Picker
        {...picker}
        id={controlId}
        label={label}
        {...(descriptionId ? { describedBy: descriptionId } : {})}
      />
    </SettingField>
  );
}

export function SettingToggle({
  id,
  label,
  hint,
  hintId,
  checked,
  onChange,
  onLabel,
  offLabel,
  disabled,
}: FieldProps & {
  checked: boolean;
  onChange(checked: boolean): void;
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
}): React.JSX.Element {
  const descriptionId = hint ? (hintId ?? `${id}-hint`) : undefined;
  return (
    <SettingField id={id} label={label} hint={hint} hintId={descriptionId}>
      <button
        id={id}
        type="button"
        className="setting-switch"
        role="switch"
        disabled={disabled}
        aria-checked={checked}
        aria-label={label}
        aria-describedby={descriptionId}
        onClick={() => onChange(!checked)}
      >
        <span aria-hidden="true" />
        {checked ? onLabel : offLabel}
      </button>
    </SettingField>
  );
}
