import type { RemoteEntry } from "../shared/api.js";
import { protectedRemotePath } from "./remote-files.js";
import { updateSelection } from "./selection.js";
export function visibleRemoteEntries(entries: RemoteEntry[], query: string): RemoteEntry[] {
  const text = query.trim().toLocaleLowerCase();
  return entries
    .filter((item) => item.name.toLocaleLowerCase().includes(text))
    .sort((a, b) =>
      a.kind === b.kind
        ? a.name.localeCompare(b.name, "en", { numeric: true })
        : a.kind === "directory"
          ? -1
          : 1,
    );
}
export function selectRemoteEntries(
  entries: RemoteEntry[],
  selected: string[],
  path: string,
  anchor: string | undefined,
  mode: "single" | "toggle" | "range",
): string[] {
  return updateSelection(
    entries.map((item) => ({ value: item.path, disabled: protectedRemotePath(item.path) })),
    selected,
    path,
    mode,
    anchor,
  );
}
