import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  DeviceOperationError,
  REMOTE_PROJECT_ROOT,
  managedPath,
  remoteChild,
  type DeviceSession,
  type TransferProgress,
} from "@kobrixa/device";
import type { Dialog } from "electron";
import type { RemoteFileRequest, RemoteFileResult } from "../shared/api.js";

/** Native dialogs own local paths; the renderer may only supply managed EV3 paths. */
export async function remoteFileOperation(
  request: RemoteFileRequest,
  session: DeviceSession,
  signal: AbortSignal,
  dialog: Pick<Dialog, "showOpenDialog" | "showSaveDialog" | "showMessageBox">,
  changed: (paths: string[]) => void,
  progress: TransferProgress,
): Promise<Extract<RemoteFileResult, { ok: true }>> {
  const { action, sessionId, requestId } = request;
  const target = managedPath(request.path, ["rename", "delete", "download"].includes(action));
  const result = { ok: true as const, sessionId, requestId };
  const zh = request.locale === "zh-TW";
  if (action === "list") {
    if (
      target !== REMOTE_PROJECT_ROOT &&
      !(await session.list(path.posix.dirname(target), signal)).some(
        (entry) => entry.path === target && entry.kind === "directory",
      )
    )
      throw new DeviceOperationError("not-found", "The EV3 folder no longer exists.");
    return { ...result, entries: await session.list(target, signal) };
  }
  if (action === "mkdir") {
    const destination = remoteChild(target, request.name ?? "");
    if ((await session.list(target, signal)).some((entry) => entry.path === destination))
      throw new DeviceOperationError("device", "A file or folder with that name already exists.");
    changed([destination]);
    await session.createDirectory(destination, signal);
  } else if (action === "rename") {
    const destination = remoteChild(path.posix.dirname(target), request.name ?? "");
    changed([target, destination]);
    await session.rename(target, destination, signal);
  } else if (action === "delete") {
    // Confirmation is native, so recursive deletion is always explicitly reviewed.
    const answer = await dialog.showMessageBox({
      type: "warning",
      title: zh ? "刪除 EV3 項目" : "Delete EV3 item",
      message: zh
        ? "永久刪除此項目及所有內容？"
        : "Permanently delete this item and all its contents?",
      detail: target,
      buttons: zh ? ["取消", "刪除"] : ["Cancel", "Delete"],
      defaultId: 0,
      cancelId: 0,
    });
    signal.throwIfAborted();
    if (answer.response !== 1) return { ...result, cancelled: true };
    changed([target]);
    await session.delete(target, signal);
  } else if (action === "upload") {
    const selected = await dialog.showOpenDialog({
      title: zh ? "上傳檔案至 EV3" : "Upload file to EV3",
      properties: ["openFile"],
    });
    signal.throwIfAborted();
    if (selected.canceled || !selected.filePaths[0]) return { ...result, cancelled: true };
    const local = selected.filePaths[0];
    let destination: string;
    try {
      destination = remoteChild(target, path.basename(local));
    } catch (error) {
      throw new DeviceOperationError(
        "permission",
        error instanceof Error ? error.message : String(error),
      );
    }
    const existing = (await session.list(target, signal)).find(
      (entry) => entry.path === destination,
    );
    if (existing?.kind === "directory")
      throw new DeviceOperationError("device", "A folder with that name already exists.");
    if (existing) {
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: zh ? "覆寫 EV3 檔案" : "Replace EV3 file",
        message: zh ? "覆寫現有檔案？" : "Replace the existing file?",
        detail: destination,
        buttons: zh ? ["取消", "覆寫"] : ["Cancel", "Replace"],
        defaultId: 0,
        cancelId: 0,
      });
      signal.throwIfAborted();
      if (answer.response !== 1) return { ...result, cancelled: true };
    }
    const source = await open(local, "r");
    try {
      const info = await source.stat();
      if (!info.isFile()) throw new DeviceOperationError("transfer", "Select a regular file.");
      changed([destination]);
      const chunks = async function* (): AsyncGenerator<Uint8Array> {
        for (;;) {
          signal.throwIfAborted();
          const buffer = new Uint8Array(64 * 1024);
          const { bytesRead } = await source.read(buffer);
          if (!bytesRead) return;
          yield buffer.subarray(0, bytesRead);
        }
      };
      await session.uploadStream(destination, info.size, chunks(), signal, progress);
    } finally {
      await source.close();
    }
  } else if (action === "download") {
    const entry = (await session.list(path.posix.dirname(target), signal)).find(
      (entry) => entry.path === target,
    );
    if (!entry || entry.kind !== "file")
      throw new DeviceOperationError("not-found", "Select an existing file to download.");
    const selected = await dialog.showSaveDialog({
      title: zh ? "下載 EV3 檔案" : "Download EV3 file",
      defaultPath: entry.name,
    });
    signal.throwIfAborted();
    if (selected.canceled || !selected.filePath) return { ...result, cancelled: true };
    // Same-directory rename atomically delivers only the fully downloaded file.
    const temporary = path.join(path.dirname(selected.filePath), `.kobrixa-${randomUUID()}.part`);
    const output = await open(temporary, "wx", 0o600);
    let complete = false;
    try {
      let received = 0;
      const checksum = createHash("md5");
      await session.download(
        target,
        async (chunk) => {
          checksum.update(chunk);
          for (let offset = 0; offset < chunk.length;) {
            const { bytesWritten } = await output.write(chunk, offset, chunk.length - offset);
            if (!bytesWritten) throw new Error("Unable to write downloaded file.");
            offset += bytesWritten;
            received += bytesWritten;
          }
        },
        signal,
        progress,
      );
      if (entry.size !== undefined && received !== entry.size)
        throw new DeviceOperationError(
          "transfer",
          "File size changed during download; the destination was not replaced.",
        );
      if (entry.checksum && checksum.digest("hex") !== entry.checksum)
        throw new DeviceOperationError(
          "transfer",
          "Download verification failed; the destination was not replaced.",
        );
      signal.throwIfAborted();
      await output.sync();
      complete = true;
    } finally {
      await output.close();
      if (!complete) await unlink(temporary).catch(() => {});
    }
    try {
      await rename(temporary, selected.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  return result;
}
