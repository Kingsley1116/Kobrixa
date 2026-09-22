import path from "node:path";
import type { RemoteEntry } from "./contracts.js";
import { DeviceOperationError } from "./errors.js";
import { normalizeRemotePath } from "./path.js";

export const REMOTE_PROJECT_ROOT = "/home/root/lms2012/prjs";
export const REMOTE_STORAGE_ROOTS = [
  REMOTE_PROJECT_ROOT,
  `${REMOTE_PROJECT_ROOT}/SD_Card`,
  `${REMOTE_PROJECT_ROOT}/USB_Stick`,
] as const;
export function managedPath(value: string, mutable = false): string {
  const normalized = normalizeRemotePath(value).replace(/\/$/, "");
  if (normalized !== REMOTE_PROJECT_ROOT && !normalized.startsWith(`${REMOTE_PROJECT_ROOT}/`))
    throw new DeviceOperationError("permission", "Choose a location inside the EV3 projects area.");
  if (mutable && REMOTE_STORAGE_ROOTS.some((root) => root === normalized))
    throw new DeviceOperationError("permission", "Storage roots cannot be changed.");
  return normalized;
}
export function remoteChild(parent: string, name: string): string {
  if (!name.trim() || name !== name.trim() || name === "." || name === ".." || /[\\/\0]/.test(name))
    throw new DeviceOperationError("protocol", "Enter a single file or folder name.");
  return managedPath(`${managedPath(parent)}/${name}`, true);
}
export function parseDirectoryListing(directory: string, listing: string): RemoteEntry[] {
  const entries: RemoteEntry[] = [];
  const seen = new Set<string>();
  for (const line of listing.replace(/\0$/, "").split("\n")) {
    if (!line || line === "./" || line === "../") continue;
    const match = /^([a-f\d]{32}) ([a-f\d]{8}) (.+)$/i.exec(line);
    const folder = !match && line.endsWith("/");
    const name = match ? match[3]! : folder ? line.slice(0, -1) : "";
    if (!name || name === "." || name === ".." || /[\\/\0\r\n]/.test(name) || seen.has(name))
      throw new DeviceOperationError("protocol", "Malformed EV3 directory entry.");
    seen.add(name);
    entries.push({
      name,
      path: path.posix.join(directory, name),
      kind: folder ? "directory" : "file",
      ...(match ? { size: Number.parseInt(match[2]!, 16), checksum: match[1]!.toLowerCase() } : {}),
    });
  }
  return entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, "en", { numeric: true })
      : a.kind === "directory"
        ? -1
        : 1,
  );
}
