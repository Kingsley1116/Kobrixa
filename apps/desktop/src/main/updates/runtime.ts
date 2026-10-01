import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { app, shell, type WebContents } from "electron";
import { autoUpdater, CancellationToken } from "electron-updater";
import { z } from "zod";
import { fetchReleases, validateUpdateInfo } from "./catalog.js";
import { UpdateService, type UpdateBackend } from "./service.js";
import type { UpdateState } from "../../shared/updates.js";

export const preferencesSchema = z
  .object({ enabled: z.boolean(), channel: z.enum(["stable", "preview"]) })
  .strict();
export async function createUpdateService(
  renderer: () => WebContents | undefined,
  busy: () => boolean,
): Promise<UpdateService> {
  const file = path.join(app.getPath("userData"), "updates.json");
  let preferences = { enabled: true, channel: "stable" as "stable" | "preview" };
  try {
    preferences = preferencesSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch {
    /* First launch or invalid preferences: use documented defaults. */
  }
  let reason: UpdateState["reason"];
  let signedMac = false;
  try {
    signedMac =
      JSON.parse(await readFile(path.join(process.resourcesPath, "kobrixa-update.json"), "utf8"))
        .signedMac === true;
  } catch {
    /* Ordinary development/archive builds have no capability marker. */
  }
  if (!app.isPackaged) reason = "development";
  else if (!(
    (process.platform === "darwin" && process.arch === "arm64") ||
    (["win32", "linux"].includes(process.platform) && process.arch === "x64")
  ))
    reason = "platform";
  else if (process.platform === "darwin" && !signedMac) reason = "unsigned-mac";
  else if (
    (process.platform === "linux" && !process.env.APPIMAGE) ||
    (process.platform === "win32" &&
      !existsSync(path.join(path.dirname(app.getPath("exe")), "Uninstall Kobrixa.exe")))
  )
    reason = "archive";

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableDifferentialDownload = true;
  const backend: UpdateBackend = {
    async download(release, progress, signal) {
      if (signal.aborted) throw new Error("cancelled");
      autoUpdater.allowPrerelease = true; // The catalog already applied the user's stable/preview policy.
      autoUpdater.setFeedURL({
        provider: "generic",
        url: release.feed,
        channel: "latest",
        useMultipleRangeRequest: false,
      });
      autoUpdater.allowDowngrade = false;
      const token = new CancellationToken();
      const cancel = () => token.cancel();
      const onProgress = (value: { percent: number }) =>
        progress(Math.max(0, Math.min(100, value.percent)));
      signal.addEventListener("abort", cancel, { once: true });
      autoUpdater.on("download-progress", onProgress);
      try {
        const result = await autoUpdater.checkForUpdates();
        if (signal.aborted) throw new Error("cancelled");
        if (!result || result.updateInfo.version !== release.version)
          throw new Error("invalid-metadata");
        validateUpdateInfo(result.updateInfo, release, process.platform, process.arch);
        await autoUpdater.downloadUpdate(token);
        if (signal.aborted) throw new Error("cancelled");
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (/SIGNATURE|CHECKSUM|DIGEST/.test(code)) throw new Error("verification-failed");
        if (
          error instanceof z.ZodError ||
          (error instanceof Error && error.message === "invalid-metadata")
        )
          throw new Error("invalid-metadata");
        throw new Error("download-failed");
      } finally {
        signal.removeEventListener("abort", cancel);
        autoUpdater.removeListener("download-progress", onProgress);
      }
    },
    install: () => autoUpdater.quitAndInstall(false, true),
  };
  const service = new UpdateService({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    reason,
    preferences,
    list: (signal) => fetchReleases(signal),
    backend,
    busy,
    publish: (state) => {
      const target = renderer();
      if (target && !target.isDestroyed()) target.send("updates:state", state);
    },
    open: (url) => shell.openExternal(url),
    persist: async (value) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    },
  });
  // Always consume updater errors; download failures are also returned by its promise.
  autoUpdater.on("error", () => {
    if (service.installing) service.installationFailed("install-failed");
  });
  return service;
}
