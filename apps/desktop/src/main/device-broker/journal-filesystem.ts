import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
export interface JournalFilesystem {
  initialize(): Promise<void>;
  inventory(): Promise<Array<{ name: string; bytes: number }>>;
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  sync(name: string): Promise<void>;
  replace(from: string, to: string): Promise<void>;
  syncDirectory(): Promise<void>;
  remove(name: string): Promise<void>;
}
export async function writeAll(bytes: Uint8Array, write: (bytes: Uint8Array, offset: number) => Promise<number>): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const count = await write(bytes, offset);
    if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.length - offset) throw new Error("journal short write");
    offset += count;
  }
}
export function createJournalFilesystem(userData: string): JournalFilesystem {
  const root = path.resolve(userData, "device-broker");
  let initialized = false;
  const safe = (name: string): string => {
    if (!/^(faults(?:\.previous)?\.json|faults\.(?:next|backup)-[0-9a-f-]{36}\.json)$/.test(name)) throw new Error("journal filename");
    return path.join(root, name);
  };
  const directory = async (): Promise<void> => {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) throw new Error("journal directory");
  };
  const regular = async (name: string): Promise<boolean> => {
    await directory();
    try {
      const info = await lstat(safe(name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8388608) throw new Error("journal unsafe file");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  const syncDirectory = async (target = root): Promise<void> => {
    const fd = await open(target, constants.O_RDONLY);
    try { await fd.sync(); } finally { await fd.close(); }
  };
  return {
    async initialize() {
      await mkdir(root, { recursive: true, mode: 0o700 }); await directory();
      // This is a capability probe, not a silent file-sync-only downgrade.
      await syncDirectory(); await syncDirectory(path.dirname(root)); initialized = true;
    },
    async inventory() {
      if (!initialized) throw new Error("journal not initialized"); await directory();
      const names = await readdir(root);
      if (names.length > 256) throw new Error("journal directory entry budget");
      const result: Array<{ name: string; bytes: number }> = [];
      for (const name of names) {
        const info = await lstat(path.join(root, name));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("journal unsafe evidence");
        result.push({ name, bytes: info.size });
      }
      return result;
    },
    async read(name) {
      if (!await regular(name)) return null;
      const fd = await open(safe(name), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.size > 8388608) throw new Error("journal read budget");
        const bytes = new Uint8Array(info.size); let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await fd.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) throw new Error("journal truncated read"); offset += bytesRead;
        }
        if ((await fd.stat()).size !== bytes.length) throw new Error("journal changed during read");
        return bytes;
      } finally { await fd.close(); }
    },
    async write(name, bytes) {
      await directory(); if (bytes.length > 8388608) throw new Error("journal write budget");
      const fd = await open(safe(name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await writeAll(bytes, async (data, offset) => (await fd.write(data, offset, data.length - offset, offset)).bytesWritten); }
      finally { await fd.close(); }
    },
    async sync(name) {
      if (!await regular(name)) throw new Error("journal temp absent");
      const fd = await open(safe(name), constants.O_RDWR | constants.O_NOFOLLOW);
      try { await fd.sync(); } finally { await fd.close(); }
    },
    async replace(from, to) { if (!await regular(from)) throw new Error("journal temp absent"); await regular(to); await rename(safe(from), safe(to)); },
    syncDirectory: () => syncDirectory(),
    async remove(name) { if (await regular(name)) await unlink(safe(name)); },
  };
}
