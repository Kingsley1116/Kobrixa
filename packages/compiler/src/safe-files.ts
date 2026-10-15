import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { BuildError } from "./build-error.js";
const invalid = (message: string): never => {
  throw new BuildError("BUILD1003", message);
};
export function assertSafeRelative(relative: string): string {
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    path.win32.isAbsolute(relative) ||
    relative.includes("\\") ||
    relative.includes(":")
  )
    return invalid("Artifact paths must be portable project-relative paths.");
  const parts = relative.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.normalize("NFC").toLowerCase().startsWith(".kobrixa") ||
        [...part].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    )
  )
    return invalid("Unsafe or reserved artifact path.");
  return relative;
}
export async function assertNoSymlinks(
  root: string,
  relative: string,
  allowMissing = false,
): Promise<string> {
  assertSafeRelative(relative);
  const canonicalRoot = await realpath(root);
  let cursor = canonicalRoot;
  const parts = relative.split("/");
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]!);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) invalid("Artifact paths must not pass through symbolic links.");
      if (i < parts.length - 1 && !info.isDirectory())
        invalid("An artifact parent is not a directory.");
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return cursor;
}
export async function readBoundedFile(
  root: string,
  relative: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const file = await assertNoSymlinks(root, relative);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes)
      invalid("Artifact exceeds the remaining byte budget.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = new Uint8Array(Math.min(64 * 1024, Math.max(1, maxBytes - total + 1)));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) invalid("Artifact grew beyond the remaining byte budget.");
      chunks.push(chunk.slice(0, bytesRead));
    }
    const after = await handle.stat();
    await assertNoSymlinks(root, relative);
    const current = await lstat(file);
    if (
      before.dev !== current.dev ||
      before.ino !== current.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      total !== after.size
    )
      invalid("A resource changed while capturing the build snapshot.");
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}
