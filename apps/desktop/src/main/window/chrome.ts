import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { z } from "zod";
import type { IpcHandle } from "../ipc.js";

// Match the workbench's --surface and --text colors.
const colors = {
  dark: { color: "#1e2933", symbolColor: "#e6eaf0" },
  light: { color: "#f5f0e7", symbolColor: "#1e2933" },
};

export const WINDOWS_WINDOW_CHROME = {
  titleBarStyle: "hidden",
  titleBarOverlay: { ...colors.dark, height: 62 },
} satisfies BrowserWindowConstructorOptions;

const appearanceSchema = z
  .object({
    theme: z.enum(["light", "dark"]),
    height: z.number().int().min(1).max(512),
  })
  .strict();

export function registerWindowChromeIpc(
  handle: IpcHandle,
  currentWindow: () => BrowserWindow | undefined,
): void {
  handle("window-chrome:appearance", (_event, value: unknown) => {
    const { theme, height } = appearanceSchema.parse(value);
    const window = currentWindow();
    if (!window || window.isDestroyed()) return;
    window.setTitleBarOverlay({ ...colors[theme], height });
  });
}
