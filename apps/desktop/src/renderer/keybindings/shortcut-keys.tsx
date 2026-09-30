import { formatSequence, type KeySequence } from "../../shared/keyboard.js";
import type { Locale } from "../i18n/copy.js";
const names: Record<string, [string, string]> = {
  Meta: ["Command", "Command"],
  Ctrl: ["Control", "Control"],
  Alt: ["Alt", "Alt"],
  Shift: ["Shift", "Shift"],
  Enter: ["Enter", "Enter 鍵"],
  Tab: ["Tab", "Tab 鍵"],
  Space: ["Space", "空白鍵"],
  Backspace: ["Backspace", "退格鍵"],
  Delete: ["Delete", "刪除鍵"],
  Escape: ["Escape", "Escape 鍵"],
  ArrowUp: ["Up arrow", "向上方向鍵"],
  ArrowDown: ["Down arrow", "向下方向鍵"],
  ArrowLeft: ["Left arrow", "向左方向鍵"],
  ArrowRight: ["Right arrow", "向右方向鍵"],
};
export function spokenSequence(keys: KeySequence, mac: boolean, locale: Locale): string {
  return keys
    .map((stroke) =>
      stroke
        .split("+")
        .map((key) => {
          if (key === "Meta" && !mac) return "Windows";
          if (key === "Alt" && mac) return "Option";
          return names[key]?.[locale === "zh-TW" ? 1 : 0] ?? formatSequence([key], false);
        })
        .join(" + "),
    )
    .join(locale === "zh-TW" ? "，接著 " : ", then ");
}
export function ShortcutKeys({
  keys,
  mac,
  locale,
}: {
  keys: KeySequence;
  mac: boolean;
  locale: Locale;
}) {
  const title = spokenSequence(keys, mac, locale);
  return (
    <span className="shortcut-sequence" title={title} aria-label={title}>
      {keys.map((stroke, index) => (
        <span className="shortcut-stroke-group" key={`${index}-${stroke}`} aria-hidden="true">
          {index > 0 && (
            <span className="shortcut-then">{locale === "zh-TW" ? "接著" : "then"}</span>
          )}
          <span className="shortcut-stroke">
            {stroke.split("+").map((key) => (
              <kbd key={key}>{formatSequence([key], mac)}</kbd>
            ))}
          </span>
        </span>
      ))}
    </span>
  );
}
