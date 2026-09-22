import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import type { WorkspaceEntry } from "../shared/api.js";
import {
  buildFileTree,
  flattenFileTree,
  pathContains,
  pathName,
  pathParent,
  treeListNavigation,
  type FileTreeNode,
} from "./file-tree.js";

export interface ProjectTreeCopy {
  treeLabel: string;
  newFile: string;
  newFolder: string;
  moreActions: string;
  rename: string;
  move: string;
  trash: string;
  expand: string;
  collapse: string;
}

interface ProjectTreeProps {
  rootLabel: string;
  entries: WorkspaceEntry[];
  activeFile: string | undefined;
  buildEntry: string | undefined;
  selectedPath: string;
  expandedPaths: ReadonlySet<string>;
  busy: boolean;
  copy: ProjectTreeCopy;
  onSelectedPath(path: string): void;
  onExpandedPaths(paths: Set<string>): void;
  onOpenFile(path: string): void;
  onCreate(kind: WorkspaceEntry["kind"], parent: string): void;
  onRename(source: string, name: string): Promise<boolean>;
  onMoveRequest(source: string): void;
  onMove(source: string, target: string): Promise<void>;
  onTrash(source: string): void;
}

export interface ProjectTreeHandle {
  focus(entryPath: string): void;
}

interface ContextMenuState {
  path: string;
  x: number;
  y: number;
}

interface PointerDragState {
  path: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

function fileBadge(entryPath: string): string {
  return entryPath.toLocaleLowerCase("en-US").endsWith(".json") ? "{}" : "BP";
}

export const ProjectTree = forwardRef<ProjectTreeHandle, ProjectTreeProps>(function ProjectTree(
  {
    rootLabel,
    entries,
    activeFile,
    buildEntry,
    selectedPath,
    expandedPaths,
    busy,
    copy,
    onSelectedPath,
    onExpandedPaths,
    onOpenFile,
    onCreate,
    onRename,
    onMoveRequest,
    onMove,
    onTrash,
  },
  handleRef,
): React.JSX.Element {
  const root = useMemo(() => buildFileTree(rootLabel, entries), [entries, rootLabel]);
  const visible = useMemo(() => flattenFileTree(root, expandedPaths), [expandedPaths, root]);
  const allNodes = useMemo(() => {
    const result = new Map<string, FileTreeNode>();
    const visit = (node: FileTreeNode): void => {
      result.set(node.path, node);
      node.children.forEach(visit);
    };
    visit(root);
    return result;
  }, [root]);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const moreButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [renamingPath, setRenamingPath] = useState<string>();
  const [renameValue, setRenameValue] = useState("");
  const [menu, setMenu] = useState<ContextMenuState>();
  const pointerDrag = useRef<PointerDragState | undefined>(undefined);
  const suppressClick = useRef(false);
  const [dropPath, setDropPath] = useState<string>();

  const selectedNode = allNodes.get(selectedPath) ?? root;
  const creationParent =
    selectedNode.kind === "directory" ? selectedNode.path : pathParent(selectedNode.path);

  useImperativeHandle(handleRef, () => ({
    focus: (entryPath) => itemRefs.current.get(entryPath)?.focus(),
  }));

  useEffect(() => {
    if (!menu) return undefined;
    const dismiss = (): void => setMenu(undefined);
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("blur", dismiss);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("blur", dismiss);
    };
  }, [menu]);

  useEffect(() => {
    if (allNodes.has(selectedPath)) return;
    onSelectedPath("");
  }, [allNodes, onSelectedPath, selectedPath]);

  useEffect(() => {
    itemRefs.current.get(selectedPath)?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

  useEffect(() => {
    if (menu)
      window.requestAnimationFrame(() =>
        menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(),
      );
  }, [menu]);

  function toggle(node: FileTreeNode): void {
    if (node.kind !== "directory") return;
    const next = new Set(expandedPaths);
    if (next.has(node.path)) next.delete(node.path);
    else next.add(node.path);
    onExpandedPaths(next);
  }

  function select(entryPath: string, focus = false): void {
    onSelectedPath(entryPath);
    if (focus)
      window.requestAnimationFrame(() => {
        const item = itemRefs.current.get(entryPath);
        // A quick F2 can open the rename field before this deferred row focus runs.
        // Do not steal focus from that field and cancel the rename on blur.
        if (!item?.querySelector("input")) item?.focus();
      });
  }

  function protectedEntry(entryPath: string): boolean {
    return entryPath === "" || entryPath === "kobrixa.json";
  }

  function deletable(entryPath: string): boolean {
    return !protectedEntry(entryPath) && !(buildEntry && pathContains(entryPath, buildEntry));
  }

  function startRename(entryPath: string): void {
    if (busy || protectedEntry(entryPath)) return;
    setMenu(undefined);
    select(entryPath);
    setRenamingPath(entryPath);
    setRenameValue(pathName(entryPath));
  }

  function cancelRename(): void {
    const entryPath = renamingPath;
    setRenamingPath(undefined);
    if (entryPath !== undefined) {
      window.requestAnimationFrame(() => itemRefs.current.get(entryPath)?.focus());
    }
  }

  async function submitRename(): Promise<void> {
    if (!renamingPath) return;
    const name = renameValue.trim();
    if (!name || name === pathName(renamingPath)) {
      cancelRename();
      return;
    }
    const target = pathParent(renamingPath) ? `${pathParent(renamingPath)}/${name}` : name;
    if (await onRename(renamingPath, name)) {
      setRenamingPath(undefined);
      window.requestAnimationFrame(() => itemRefs.current.get(target)?.focus());
    }
  }

  function openMenu(entryPath: string, x: number, y: number): void {
    select(entryPath);
    setMenu({ path: entryPath, x, y });
  }

  function handleMenuKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setMenu(undefined);
      itemRefs.current.get(selectedPath)?.focus();
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    const buttons = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (Math.max(0, current) + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length;
    buttons[next]?.focus();
  }

  function openKeyboardMenu(entryPath: string): void {
    const bounds = itemRefs.current.get(entryPath)?.getBoundingClientRect();
    openMenu(entryPath, bounds?.left ?? 16, bounds?.bottom ?? 16);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>, node: FileTreeNode): void {
    if (event.target instanceof HTMLInputElement) return;
    let nextPath: string | undefined;
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      nextPath = treeListNavigation(
        visible.map((item) => item.path),
        node.path,
        event.key,
      );
    } else if (event.key === "ArrowRight" && node.kind === "directory") {
      if (!expandedPaths.has(node.path)) toggle(node);
      else nextPath = node.children[0]?.path;
    } else if (event.key === "ArrowLeft") {
      if (node.kind === "directory" && expandedPaths.has(node.path)) toggle(node);
      else nextPath = node.parent;
    } else if (event.key === "Enter" || event.key === " ") {
      if (node.kind === "directory") toggle(node);
      else onOpenFile(node.path);
    } else if (event.key === "F2") startRename(node.path);
    else if (event.key === "Delete" && deletable(node.path)) onTrash(node.path);
    else if (event.key === "F10" && event.shiftKey) openKeyboardMenu(node.path);
    else if (event.key === "Escape") {
      setRenamingPath(undefined);
      setMenu(undefined);
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    if (nextPath !== undefined) select(nextPath, true);
  }

  function dropTargetAt(
    clientX: number,
    clientY: number,
    source: string,
  ): FileTreeNode | undefined {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-tree-path]")?.dataset.treePath;
    const node = target === undefined ? undefined : allNodes.get(target);
    return node?.kind === "directory" && !pathContains(source, node.path) ? node : undefined;
  }

  function beginPointerDrag(event: PointerEvent<HTMLDivElement>, entryPath: string): void {
    if (
      event.button !== 0 ||
      busy ||
      protectedEntry(entryPath) ||
      (event.target instanceof Element && event.target.closest("button, input"))
    )
      return;
    pointerDrag.current = {
      path: entryPath,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updatePointerDrag(event: PointerEvent<HTMLDivElement>): void {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5)
      return;
    drag.active = true;
    suppressClick.current = true;
    setDropPath(dropTargetAt(event.clientX, event.clientY, drag.path)?.path);
  }

  async function finishPointerDrag(event: PointerEvent<HTMLDivElement>): Promise<void> {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const node = drag.active ? dropTargetAt(event.clientX, event.clientY, drag.path) : undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    pointerDrag.current = undefined;
    setDropPath(undefined);
    if (!node) return;
    const target = node.path ? `${node.path}/${pathName(drag.path)}` : pathName(drag.path);
    if (target !== drag.path) await onMove(drag.path, target);
  }

  function cancelPointerDrag(event: PointerEvent<HTMLDivElement>): void {
    const drag = pointerDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    pointerDrag.current = undefined;
    setDropPath(undefined);
  }

  function renderNode(node: FileTreeNode, depth: number): React.JSX.Element {
    const expanded = node.kind === "directory" && expandedPaths.has(node.path);
    const selected = selectedPath === node.path;
    const active = activeFile === node.path;
    const isDropTarget = dropPath === node.path;
    return (
      <div
        aria-expanded={node.kind === "directory" ? expanded : undefined}
        aria-selected={selected}
        className="tree-item-shell"
        key={node.path || "root"}
        role="treeitem"
        tabIndex={selected ? 0 : -1}
        ref={(element) => {
          if (element) itemRefs.current.set(node.path, element);
          else itemRefs.current.delete(node.path);
        }}
        onKeyDown={(event) => handleKey(event, node)}
      >
        <div
          className={`tree-row ${selected ? "selected" : ""} ${active ? "active" : ""} ${
            isDropTarget ? "drop-target" : ""
          } ${node.path === "" ? "root" : ""}`}
          data-tree-path={node.path}
          style={{ "--tree-depth": depth } as CSSProperties}
          title={node.path || rootLabel}
          onClick={(event) => {
            if (suppressClick.current) {
              suppressClick.current = false;
              return;
            }
            select(node.path, true);
            if (node.kind === "file") onOpenFile(node.path);
            else if (event.detail <= 1) toggle(node);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(node.path, event.clientX, event.clientY);
          }}
          onPointerCancel={cancelPointerDrag}
          onPointerDown={(event) => beginPointerDrag(event, node.path)}
          onPointerMove={updatePointerDrag}
          onPointerUp={(event) => void finishPointerDrag(event)}
        >
          {node.kind === "directory" ? (
            <button
              aria-label={`${expanded ? copy.collapse : copy.expand}: ${node.name}`}
              className={`tree-chevron ${expanded ? "expanded" : ""}`}
              tabIndex={-1}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                toggle(node);
              }}
            />
          ) : (
            <span aria-hidden="true" className="tree-chevron-spacer" />
          )}
          <span className={`tree-kind ${node.kind}`} aria-hidden="true">
            {node.kind === "file" ? (
              fileBadge(node.path)
            ) : (
              <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M3 7V5h6l2 2h10v13H3Z" />
              </svg>
            )}
          </span>
          {renamingPath === node.path ? (
            <input
              autoFocus
              aria-label={copy.rename}
              className="tree-rename"
              value={renameValue}
              onBlur={() => setRenamingPath(undefined)}
              onChange={(event) => setRenameValue(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
          ) : (
            <span className="tree-name">{node.name}</span>
          )}
        </div>
        {node.kind === "directory" && expanded && node.children.length > 0 && (
          <div
            className="tree-group"
            role="group"
            style={{ "--tree-guide-depth": depth } as CSSProperties}
          >
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  const menuNode = menu ? allNodes.get(menu.path) : undefined;
  const canManageMenuNode = menuNode && !protectedEntry(menuNode.path);

  return (
    <>
      <div className="tree-toolbar">
        <div className="tree-toolbar-actions">
          <button
            aria-label={copy.newFile}
            disabled={busy}
            title={copy.newFile}
            type="button"
            onClick={() => onCreate("file", creationParent)}
          >
            <svg aria-hidden="true" className="tree-action-icon" viewBox="0 0 16 16">
              <path d="M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M8 7v5M5.5 9.5h5" />
            </svg>
          </button>
          <button
            aria-label={copy.newFolder}
            disabled={busy}
            title={copy.newFolder}
            type="button"
            onClick={() => onCreate("directory", creationParent)}
          >
            <svg aria-hidden="true" className="tree-action-icon" viewBox="0 0 16 16">
              <path d="M1.5 4.5h5l1.5 2h6.5v7.5h-13zM8 8v4M6 10h4" />
            </svg>
          </button>
          <button
            aria-label={copy.moreActions}
            disabled={busy}
            ref={moreButton}
            title={copy.moreActions}
            type="button"
            onClick={() => {
              const bounds = moreButton.current?.getBoundingClientRect();
              openMenu(selectedNode.path, bounds?.left ?? 16, bounds?.bottom ?? 16);
            }}
          >
            <svg aria-hidden="true" className="tree-action-icon" viewBox="0 0 16 16">
              <circle cx="3" cy="8" r="0.8" />
              <circle cx="8" cy="8" r="0.8" />
              <circle cx="13" cy="8" r="0.8" />
            </svg>
          </button>
        </div>
      </div>
      <div aria-label={copy.treeLabel} className="project-tree" role="tree">
        {renderNode(root, 0)}
      </div>
      {menu && menuNode && (
        <div
          className="tree-context-menu"
          ref={menuRef}
          role="menu"
          style={{ left: menu.x, top: menu.y }}
          onKeyDown={handleMenuKey}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {menuNode.kind === "directory" && (
            <>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(undefined);
                  onCreate("file", menuNode.path);
                }}
              >
                {copy.newFile}
              </button>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenu(undefined);
                  onCreate("directory", menuNode.path);
                }}
              >
                {copy.newFolder}
              </button>
            </>
          )}
          <button
            disabled={!canManageMenuNode}
            role="menuitem"
            type="button"
            onClick={() => startRename(menuNode.path)}
          >
            {copy.rename}
            <kbd>F2</kbd>
          </button>
          <button
            disabled={!canManageMenuNode}
            role="menuitem"
            type="button"
            onClick={() => {
              setMenu(undefined);
              onMoveRequest(menuNode.path);
            }}
          >
            {copy.move}
          </button>
          <button
            className="danger"
            disabled={!deletable(menuNode.path)}
            role="menuitem"
            type="button"
            onClick={() => {
              setMenu(undefined);
              onTrash(menuNode.path);
            }}
          >
            {copy.trash}
            <kbd>Del</kbd>
          </button>
        </div>
      )}
    </>
  );
});
