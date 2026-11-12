import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createWin32JournalAdapter } from "./journal-win32.js";
import type { Win32JournalAdapter } from "./journal-win32.js";
export interface JournalFilesystem {
  // Failed durability initialization must not prevent independently validated reads
  // of existing evidence. It never authorizes writes or repair.
  initialize(): Promise<void>;
  inventory(): Promise<Array<{ name: string; bytes: number }>>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  sync(name: string): Promise<void>;
  replace(from: string, to: string): Promise<void>;
  syncDirectory(): Promise<void>;
  remove(name: string): Promise<void>;
  durableReplace?(
    temporary: string,
    target: string,
    bytes: Uint8Array,
  ): Promise<{ directoryFlushed: true }>;
}
export async function writeAll(
  bytes: Uint8Array,
  write: (bytes: Uint8Array, offset: number) => Promise<number>,
): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const count = await write(bytes, offset);
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset)
      throw new Error("journal short write");
    offset += count;
  }
}
// Unlike plugin persistence, the safety journal cannot report file-sync-only success.
// Windows uses the native adapter below. Never classify POSIX EIO/EPERM as unsupported.
async function syncJournalDirectory(target: string): Promise<void> {
  if (process.platform === "win32")
    throw Object.assign(new Error("journal directory sync unsupported"), { code: "ENOTSUP" });
  const fd = await open(target, constants.O_RDONLY);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
export function createJournalFilesystem(
  userData: string,
  // Host-only barrier injection for adapter tests; production uses the policy above.
  directoryBarrier?: (target: string) => Promise<void>,
  windowsAdapter?: Win32JournalAdapter,
): JournalFilesystem {
  const root = path.resolve(userData, "device-broker");
  // Explicit host-only injections allow unit tests without loading Electron/native code.
  const windows =
    windowsAdapter ??
    (process.platform === "win32" && !directoryBarrier ? createWin32JournalAdapter() : undefined);
  const barrier = directoryBarrier ?? (windows ? windows.syncDirectory : syncJournalDirectory);
  let readable = false;
  let writable = false;
  const assertWritable = (): void => {
    if (!writable) throw new Error("journal not writable");
  };
  const safe = (name: string): string => {
    if (!/^(faults(?:\.previous)?\.json|faults\.(?:next|backup)-[0-9a-f-]{36}\.json)$/.test(name))
      throw new Error("journal filename");
    return path.join(root, name);
  };
  const directory = async (): Promise<void> => {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root)
      throw new Error("journal directory");
  };
  const regular = async (name: string): Promise<boolean> => {
    await directory();
    try {
      const info = await lstat(safe(name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8388608)
        throw new Error("journal unsafe file");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const syncDirectory = (target = root): Promise<void> => barrier(target);
  return {
    ...(windows
      ? {
          async durableReplace(temporary: string, target: string, bytes: Uint8Array) {
            assertWritable();
            safe(temporary);
            safe(target);
            await directory();
            await windows.durableReplace(root, target, temporary, bytes);
            // Adapter resolves only after validating the complete native receipt.
            return { directoryFlushed: true as const };
          },
        }
      : {}),
    async initialize() {
      readable = false;
      writable = false;
      await mkdir(root, { recursive: true, mode: 0o700 });
      await directory();
      // Retain read-only recovery access even when either durability probe fails.
      readable = true;
      // This is a capability probe, not a silent file-sync-only downgrade.
      await syncDirectory();
      await syncDirectory(path.dirname(root));
      writable = true;
    },
    async inventory() {
      if (!readable) throw new Error("journal not initialized");
      await directory();
      const names = await readdir(root);
      if (names.length > 256) throw new Error("journal directory entry budget");
      const result: Array<{ name: string; bytes: number }> = [];
      for (const name of names) {
        const info = await lstat(path.join(root, name));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
          throw new Error("journal unsafe evidence");
        result.push({ name, bytes: info.size });
      }
      return result;
    },
    async read(name) {
      if (!(await regular(name))) return null;
      const fd = await open(safe(name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await fd.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 8388608)
          throw new Error("journal read budget");
        const bytes = new Uint8Array(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error("journal truncated read");
          offset += bytesRead;
        }
        if ((await fd.stat()).size !== bytes.length) throw new Error("journal changed during read");
        return bytes;
      } finally {
        await fd.close();
      }
    },
    async write(name, bytes) {
      assertWritable();
      await directory();
      if (bytes.length > 8388608) throw new Error("journal write budget");
      const fd = await open(
        safe(name),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await writeAll(
          bytes,
          async (data, offset) =>
            (await fd.write(data, offset, data.length - offset, offset)).bytesWritten,
        );
      } finally {
        await fd.close();
      }
    },
    async sync(name) {
      assertWritable();
      if (!(await regular(name))) throw new Error("journal temp absent");
      const fd = await open(safe(name), constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        await fd.sync();
      } finally {
        await fd.close();
      }
    },
    async replace(from, to) {
      assertWritable();
      if (!(await regular(from))) throw new Error("journal temp absent");
      await regular(to);
      await rename(safe(from), safe(to));
    },
    syncDirectory: () => syncDirectory(),
    async remove(name) {
      assertWritable();
      if (await regular(name)) {
        // Deadline cleanup cannot unlink staging while native publication is live.
        windows?.assertIdle();
        await unlink(safe(name));
      }
    },
  };
}
