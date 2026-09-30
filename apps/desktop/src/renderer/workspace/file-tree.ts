import type { WorkspaceEntry } from "../../shared/api.js";

export interface FileTreeNode extends WorkspaceEntry {
  name: string;
  parent: string | undefined;
  children: FileTreeNode[];
}

export function pathParent(entryPath: string): string {
  const separator = entryPath.lastIndexOf("/");
  return separator < 0 ? "" : entryPath.slice(0, separator);
}

export function pathName(entryPath: string): string {
  const separator = entryPath.lastIndexOf("/");
  return separator < 0 ? entryPath : entryPath.slice(separator + 1);
}

export function pathContains(parent: string, candidate: string): boolean {
  return parent === "" || candidate === parent || candidate.startsWith(`${parent}/`);
}

export function buildFileTree(rootLabel: string, entries: WorkspaceEntry[]): FileTreeNode {
  const root: FileTreeNode = {
    path: "",
    name: rootLabel,
    parent: undefined,
    kind: "directory",
    children: [],
  };
  const nodes = new Map<string, FileTreeNode>([["", root]]);
  const ensureDirectory = (directoryPath: string): FileTreeNode => {
    const existing = nodes.get(directoryPath);
    if (existing) return existing;
    const parent = pathParent(directoryPath);
    const node: FileTreeNode = {
      path: directoryPath,
      name: pathName(directoryPath),
      parent,
      kind: "directory",
      children: [],
    };
    ensureDirectory(parent).children.push(node);
    nodes.set(directoryPath, node);
    return node;
  };
  for (const entry of entries) {
    if (entry.kind === "directory") ensureDirectory(entry.path);
    else {
      const parent = pathParent(entry.path);
      const node: FileTreeNode = {
        ...entry,
        name: pathName(entry.path),
        parent,
        children: [],
      };
      ensureDirectory(parent).children.push(node);
      nodes.set(entry.path, node);
    }
  }
  const sort = (node: FileTreeNode): void => {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, "en", { sensitivity: "base" });
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function flattenFileTree(root: FileTreeNode, expanded: ReadonlySet<string>): FileTreeNode[] {
  const visible: FileTreeNode[] = [];
  const visit = (node: FileTreeNode): void => {
    visible.push(node);
    if (node.kind === "directory" && expanded.has(node.path)) node.children.forEach(visit);
  };
  visit(root);
  return visible;
}

export function expandAncestors(expanded: ReadonlySet<string>, entryPath: string): Set<string> {
  const next = new Set(expanded);
  next.add("");
  let parent = pathParent(entryPath);
  for (;;) {
    next.add(parent);
    if (!parent) break;
    parent = pathParent(parent);
  }
  return next;
}

export function remapTreePaths(
  paths: ReadonlySet<string>,
  moved: Readonly<Record<string, string>>,
): Set<string> {
  return new Set([...paths].map((entryPath) => moved[entryPath] ?? entryPath));
}

export function selectionAfterRemoval(
  visiblePaths: string[],
  selected: string,
  removed: ReadonlySet<string>,
): string {
  const index = Math.max(0, visiblePaths.indexOf(selected));
  const remaining = visiblePaths.filter((entryPath) => !removed.has(entryPath));
  return remaining[Math.min(index, remaining.length - 1)] ?? "";
}

export function treeListNavigation(
  visiblePaths: readonly string[],
  currentPath: string,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
): string | undefined {
  if (!visiblePaths.length) return undefined;
  const index = Math.max(0, visiblePaths.indexOf(currentPath));
  if (key === "Home") return visiblePaths[0];
  if (key === "End") return visiblePaths.at(-1);
  return key === "ArrowDown"
    ? visiblePaths[Math.min(index + 1, visiblePaths.length - 1)]
    : visiblePaths[Math.max(index - 1, 0)];
}
