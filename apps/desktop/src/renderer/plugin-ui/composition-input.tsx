import { useRef, useState, type InputHTMLAttributes } from "react";

export function composingKey(event: { isComposing: boolean; keyCode: number }): boolean {
  return event.isComposing || event.keyCode === 229;
}

// Keep preedit local: only the completed composition may enter the host draft.
export function CompositionInput({
  value,
  onValue,
  onBlur,
  onKeyDown,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & {
  value: string;
  onValue: (value: string) => void;
}) {
  const composing = useRef(false);
  const [preedit, setPreedit] = useState<string | null>(null);
  return (
    <input
      {...props}
      value={preedit ?? value}
      onCompositionStart={(event) => {
        composing.current = true;
        setPreedit(event.currentTarget.value);
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        setPreedit(null);
        onValue(event.currentTarget.value);
      }}
      onChange={(event) => {
        if (composing.current) setPreedit(event.currentTarget.value);
        else onValue(event.currentTarget.value);
      }}
      onBlur={(event) => {
        if (!composing.current) onBlur?.(event);
      }}
      onKeyDown={(event) => {
        if (composing.current || composingKey(event.nativeEvent)) return;
        onKeyDown?.(event);
      }}
    />
  );
}
