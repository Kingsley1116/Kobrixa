import type { Locale } from "./copy.js";
import type { Theme } from "./theme.js";
import { ActionMenu } from "./workbench-ui.js";
export const UI_SCALES = [100, 110, 125] as const;
export const CODE_SIZES = [14, 16, 18, 20, 24] as const;
export function readPreference(key: string, values: readonly number[], fallback: number): number {
  const stored = Number(localStorage.getItem(key));
  return values.includes(stored) ? stored : fallback;
}
export function Appearance({
  locale,
  theme,
  scale,
  fontSize,
  onTheme,
  onScale,
  onFontSize,
}: {
  locale: Locale;
  theme: Theme;
  scale: number;
  fontSize: number;
  onTheme(theme: Theme): void;
  onScale(scale: number): void;
  onFontSize(size: number): void;
}): React.JSX.Element {
  const zh = locale === "zh-TW";
  const label = zh ? "外觀" : "Appearance";
  return (
    <ActionMenu label={label} visibleLabel={label}>
      <div className="menu-section">{zh ? "主題" : "Theme"}</div>
      {(["dark", "light"] as const).map((value) => (
        <button
          key={value}
          role="menuitemradio"
          aria-checked={theme === value}
          onClick={() => onTheme(value)}
        >
          {theme === value ? "✓ " : ""}
          {value === "dark" ? (zh ? "深色" : "Dark") : zh ? "淺色" : "Light"}
        </button>
      ))}
      <div className="menu-section">{zh ? "介面大小" : "Interface size"}</div>
      {UI_SCALES.map((value) => (
        <button
          key={value}
          role="menuitemradio"
          aria-checked={scale === value}
          onClick={() => onScale(value)}
        >
          {scale === value ? "✓ " : ""}
          {value}%
        </button>
      ))}
      <div className="menu-section">{zh ? "程式碼字級" : "Code font size"}</div>
      {CODE_SIZES.map((value) => (
        <button
          key={value}
          role="menuitemradio"
          aria-checked={fontSize === value}
          onClick={() => onFontSize(value)}
        >
          {fontSize === value ? "✓ " : ""}
          {value}px
        </button>
      ))}
    </ActionMenu>
  );
}
