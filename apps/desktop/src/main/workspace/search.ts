import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { parseManifest } from "@kobrixa/compiler";
import { z } from "zod";
import {
  findSearchMatches,
  isSearchableFile,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResult,
} from "../../shared/workspace-search.js";

export const workspaceSearchRequestSchema = z
  .object({
    query: z.string().max(1024),
    caseSensitive: z.boolean(),
    wholeWord: z.boolean(),
    overlays: z
      .record(
        z.string().min(1).max(1024).refine(isRelativeSearchPath),
        z.string().max(8 * 1024 * 1024),
      )
      .refine((value) => Object.keys(value).length <= 5000)
      .refine(
        (value) =>
          Object.values(value).reduce((total, item) => total + item.length, 0) <= 16 * 1024 * 1024,
      ),
  })
  .strict();

export interface WorkspaceSearchLimits {
  fileBytes: number;
  totalBytes: number;
  matches: number;
  entries: number;
  files: number;
}

export const workspaceSearchLimits: Readonly<WorkspaceSearchLimits> = {
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  matches: 2000,
  entries: 20000,
  files: 5000,
};

function isRelativeSearchPath(value: string): boolean {
  return (
    !path.posix.isAbsolute(value) &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function isIgnoredWorkspacePath(file: string, outputDirectory: string): boolean {
  return (
    file
      .split("/")
      .some((part) => part.startsWith(".") || part === "assets" || part === "node_modules") ||
    file === outputDirectory ||
    file.startsWith(`${outputDirectory}/`)
  );
}

async function confinedTarget(root: string, file: string): Promise<string> {
  if (!isRelativeSearchPath(file))
    throw new Error("Path must be a normalized project-relative path.");
  if ((await realpath(root)) !== root) throw new Error("The registered project root changed.");
  let cursor = root;
  for (const segment of file.split("/")) {
    cursor = path.join(cursor, segment);
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("Symbolic links cannot be searched from the project tree.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return cursor;
}

class SearchLimitError extends Error {}

/** Read only bounded regular files, without following file or directory links. */
async function readSearchFile(root: string, file: string, limit: number): Promise<string | null> {
  const target = await confinedTarget(root, file);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("The project path is not a regular file.");
    if (before.size > BigInt(limit)) throw new SearchLimitError("File exceeds the search limit.");
    const current = await lstat(target, { bigint: true });
    if (
      (await realpath(target)) !== target ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw new Error("The project file changed while searching.");
    const bytes = Buffer.alloc(Math.min(Number(before.size), limit) + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (length > limit) throw new SearchLimitError("File exceeds the search limit.");
    if (
      BigInt(length) !== after.size ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new Error("The project file changed while searching.");
    return bytes.subarray(0, length).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function searchWorkspace(
  root: string,
  value: WorkspaceSearchRequest,
  limits: Readonly<WorkspaceSearchLimits> = workspaceSearchLimits,
  readManifest = true,
): Promise<WorkspaceSearchResult> {
  const request = workspaceSearchRequestSchema.parse(value);
  const result: WorkspaceSearchResult = { files: [], matchCount: 0, truncated: false, skipped: [] };
  if ((await realpath(root)) !== root) throw new Error("The registered project root changed.");
  const overlays = new Map(Object.entries(request.overlays));
  // Reject malformed overlays even when the query is empty or the traversal is truncated.
  for (const file of overlays.keys()) {
    if (!isSearchableFile(file))
      throw new Error("Only project source and JSON files can be searched.");
    await confinedTarget(root, file);
  }
  if (!request.query) return result;
  const skipped = new Set<string>();
  const skip = (file: string): void => {
    result.truncated = true;
    skipped.add(file);
  };
  let manifestContent: string | null | undefined;
  let outputDirectory = "build";
  if (readManifest) {
    try {
      manifestContent = await readSearchFile(root, "kobrixa.json", limits.fileBytes);
      if (manifestContent !== null) {
        const manifest = parseManifest(JSON.parse(manifestContent)).manifest;
        if (manifest)
          outputDirectory = path.posix.normalize(manifest.outputDir).replace(/^\.\//, "");
      }
    } catch {
      // Invalid manifests do not prevent searching sources; unreadable files are reported below.
    }
  }
  const candidates = new Set<string>();
  let visited = 0;
  const visit = async (relative: string): Promise<void> => {
    try {
      if (relative) await confinedTarget(root, relative);
      const target = path.join(root, relative);
      if ((await realpath(target)) !== target)
        throw new Error("The project directory changed while searching.");
      const directory = await opendir(target);
      for await (const entry of directory) {
        visited += 1;
        if (visited > limits.entries || candidates.size >= limits.files) {
          skip(relative || ".");
          break;
        }
        if (visited % 64 === 0) await setImmediate();
        const file = relative ? `${relative}/${entry.name}` : entry.name;
        if (isIgnoredWorkspacePath(file, outputDirectory)) continue;
        if (entry.isSymbolicLink()) {
          skip(file);
          continue;
        }
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile() && isSearchableFile(file)) candidates.add(file);
      }
    } catch {
      skip(relative || ".");
    }
  };
  await visit("");
  for (const file of overlays.keys()) {
    if (isIgnoredWorkspacePath(file, outputDirectory)) continue;
    if (candidates.has(file) || candidates.size < limits.files) candidates.add(file);
    else skip(file);
  }
  let remainingBytes = limits.totalBytes;
  const files = [...candidates].sort((left, right) => left.localeCompare(right, "en"));
  for (const [index, file] of files.entries()) {
    if (remainingBytes <= 0 || result.matchCount >= limits.matches) {
      result.truncated = true;
      for (const remaining of files.slice(index)) skipped.add(remaining);
      break;
    }
    await setImmediate();
    try {
      const overlay = overlays.get(file);
      const overlayBytes = overlay === undefined ? 0 : Buffer.byteLength(overlay);
      if (overlayBytes > limits.fileBytes || overlayBytes > remainingBytes) {
        skip(file);
        continue;
      }
      const disk =
        file === "kobrixa.json" && manifestContent !== undefined
          ? manifestContent
          : await readSearchFile(
              root,
              file,
              Math.min(limits.fileBytes, remainingBytes - overlayBytes),
            );
      const consumed = (disk === null ? 0 : Buffer.byteLength(disk)) + overlayBytes;
      if (consumed > remainingBytes) {
        skip(file);
        continue;
      }
      remainingBytes -= consumed;
      const content = overlay ?? disk;
      if (content === null || content.includes("\0")) {
        skip(file);
        continue;
      }
      const available = limits.matches - result.matchCount;
      const matches = findSearchMatches(content, request, available + 1);
      if (matches.length > available) {
        matches.length = available;
        result.truncated = true;
      }
      if (matches.length) {
        result.files.push({
          path: file,
          content,
          revision: disk === null ? null : createHash("sha256").update(disk).digest("hex"),
          matches,
        });
        result.matchCount += matches.length;
      }
    } catch {
      skip(file);
    }
  }
  result.skipped = [...skipped].sort((left, right) => left.localeCompare(right, "en"));
  return result;
}
