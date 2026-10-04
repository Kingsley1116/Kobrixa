export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}
export const THEME_KEY = "kobrixa.theme";
export function readTheme(storage: Pick<Storage, "getItem">): Theme {
  return storage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}
