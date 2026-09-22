export type Theme = "light" | "dark";
export const THEME_KEY = "kobrixa.theme";
export function readTheme(storage: Pick<Storage, "getItem">): Theme {
  return storage.getItem(THEME_KEY) === "light" ? "light" : "dark";
}
