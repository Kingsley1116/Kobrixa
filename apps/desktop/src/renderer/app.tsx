import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import type {
  DeviceDescriptor,
  Diagnostic,
  WorkspaceEntry,
  WorkspaceMutationResult,
  WorkspaceSummary,
} from "../shared/api.js";
import {
  Editor,
  type CursorPosition,
  type EditorFocusTarget,
  type EditorHandle,
} from "./editor.js";
import {
  LAYOUT_DEFAULTS,
  LAYOUT_LIMITS,
  LAYOUT_STORAGE_KEYS,
  activeFileAfterClose,
  activeFileAfterRemoval,
  clamp,
  nextDiagnosticIndex,
  readStoredBoolean,
  readStoredNumber,
  tabCloseDisposition,
} from "./editor-state.js";
import {
  buildFileTree,
  expandAncestors,
  flattenFileTree,
  pathContains,
  pathName,
  pathParent,
  remapTreePaths,
  selectionAfterRemoval,
} from "./file-tree.js";
import { ProjectTree, type ProjectTreeHandle } from "./project-tree.js";

import { ExecutionController, filesToSave } from "./execution.js";
import { Welcome, Toolbar, DevicePanel, BottomPanel, Modal } from "./workbench-ui.js";
import { Appearance, readPreference, UI_SCALES, CODE_SIZES } from "./appearance.js";
import { ToolsPanel, ActivityPanel, RemoteFilesPanel, type ToolTab } from "./tools-panel.js";
import { RemoteFilesController } from "./remote-files.js";
import { readTheme, THEME_KEY, type Theme } from "./theme.js";

import { copy, type Locale } from "./copy.js";
type Tab = { file: string; content: string; saved: string };
type PendingDraft = { workspaceId: string; file: string; content: string; timer: number };
type PendingCreate = { kind: WorkspaceEntry["kind"]; parent: string };

export function App(): React.JSX.Element {
  const [locale, setLocale] = useState<Locale>(() =>
    navigator.language.toLowerCase().startsWith("zh") ? "zh-TW" : "en",
  );
  const t = copy[locale];
  const [theme, setTheme] = useState<Theme>(() => readTheme(window.localStorage));
  const [controller] = useState(() => new ExecutionController(window.kobrixa));
  const execution = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const locked = controller.editingLocked;
  const [remoteFiles] = useState(() => new RemoteFilesController(window.kobrixa, controller));
  const remoteState = useSyncExternalStore(remoteFiles.subscribe, remoteFiles.getSnapshot);
  const [toolTab, setToolTab] = useState<ToolTab>(() => {
    const stored = localStorage.getItem("kobrixa.tools.tab");
    return stored === "files" || stored === "activity" ? stored : "connection";
  });
  const [uiScale, setUiScale] = useState(() => readPreference("kobrixa.uiScale", UI_SCALES, 100));
  const [codeSize, setCodeSize] = useState(() =>
    readPreference("kobrixa.codeSize", CODE_SIZES, 16),
  );
  const [deviceOverlay, setDeviceOverlay] = useState(false);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(uiScale / 100));
    localStorage.setItem("kobrixa.uiScale", String(uiScale));
    localStorage.setItem("kobrixa.codeSize", String(codeSize));
    localStorage.setItem("kobrixa.tools.tab", toolTab);
  }, [uiScale, codeSize, toolTab]);
  useEffect(() => {
    remoteFiles.setSession(execution.session?.id, execution.deployed?.path);
  }, [remoteFiles, execution.session?.id, execution.deployed?.path]);
  useEffect(() => window.kobrixa.device.onEvent(remoteFiles.onEvent), [remoteFiles]);
  const [connectionMode, setConnectionMode] = useState<"usb" | "wifi">("usb");
  const connectionModeRef = useRef(connectionMode);
  connectionModeRef.current = connectionMode;
  const [projectBusy, setProjectBusy] = useState(false);
  const projectBusyRef = useRef(false);
  useEffect(() => controller.attach(), [controller]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeFile, setActiveFile] = useState<string>();
  const [liveDiagnostics, setLiveDiagnostics] = useState<Diagnostic[]>([]);
  const [buildDiagnostics, setBuildDiagnostics] = useState<Diagnostic[]>([]);
  const [status, setStatus] = useState<string>(t.ready);
  const [devices, setDevices] = useState<DeviceDescriptor[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<string>();
  const [wifiAddress, setWifiAddress] = useState("");
  const [focusTarget, setFocusTarget] = useState<EditorFocusTarget>();
  const [cursor, setCursor] = useState<CursorPosition>({ line: 1, column: 1 });
  const [diagnosticIndex, setDiagnosticIndex] = useState(-1);
  const [checking, setChecking] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("my-robot");
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceSummary>();
  const [selectedEntry, setSelectedEntry] = useState("");
  const [pendingCloseFile, setPendingCloseFile] = useState<string>();
  const [closingTab, setClosingTab] = useState(false);
  const [selectedTreePath, setSelectedTreePath] = useState("");
  const [expandedTreePaths, setExpandedTreePaths] = useState<Set<string>>(() => new Set([""]));
  const [pendingCreate, setPendingCreate] = useState<PendingCreate>();
  const [entryName, setEntryName] = useState("");
  const [pendingMove, setPendingMove] = useState<string>();
  const [moveDestination, setMoveDestination] = useState("");
  const [pendingTrash, setPendingTrash] = useState<string>();
  const [managingEntries, setManagingEntries] = useState(false);
  const [filesOpen, setFilesOpen] = useState(() =>
    readStoredBoolean(
      window.localStorage,
      LAYOUT_STORAGE_KEYS.filesOpen,
      LAYOUT_DEFAULTS.filesOpen,
    ),
  );
  const [deviceOpen, setDeviceOpen] = useState(() =>
    readStoredBoolean(
      window.localStorage,
      LAYOUT_STORAGE_KEYS.deviceOpen,
      LAYOUT_DEFAULTS.deviceOpen,
    ),
  );
  const [problemsOpen, setProblemsOpen] = useState(() =>
    readStoredBoolean(
      window.localStorage,
      LAYOUT_STORAGE_KEYS.problemsOpen,
      LAYOUT_DEFAULTS.problemsOpen,
    ),
  );
  const [filesWidth, setFilesWidth] = useState(() =>
    readStoredNumber(
      window.localStorage,
      LAYOUT_STORAGE_KEYS.filesWidth,
      LAYOUT_DEFAULTS.filesWidth,
      LAYOUT_LIMITS.filesWidth.min,
      LAYOUT_LIMITS.filesWidth.max,
    ),
  );
  const [deviceWidth, setDeviceWidth] = useState(() => {
    const stored = localStorage.getItem(LAYOUT_STORAGE_KEYS.deviceWidth);
    const value = stored === null ? LAYOUT_DEFAULTS.deviceWidth : Number(stored);
    return Number.isFinite(value)
      ? clamp(value, LAYOUT_LIMITS.deviceWidth.min, LAYOUT_LIMITS.deviceWidth.max)
      : LAYOUT_DEFAULTS.deviceWidth;
  });
  const [problemsHeight, setProblemsHeight] = useState(() =>
    readStoredNumber(
      window.localStorage,
      LAYOUT_STORAGE_KEYS.problemsHeight,
      LAYOUT_DEFAULTS.problemsHeight,
      LAYOUT_LIMITS.problemsHeight.min,
      500,
    ),
  );
  const editorRef = useRef<EditorHandle>(null);
  const treeRef = useRef<ProjectTreeHandle>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef(0);
  const pendingDrafts = useRef(new Map<string, PendingDraft>());
  const draftWrites = useRef(new Map<string, Promise<void>>());
  const active = tabs.find((tab) => tab.file === activeFile);
  const dirty = tabs.some((tab) => tab.content !== tab.saved);
  const modalOpen = Boolean(
    newProjectOpen ||
    pendingWorkspace ||
    pendingCloseFile ||
    pendingCreate ||
    pendingMove ||
    pendingTrash,
  );
  const sourceOverlays = useMemo<Record<string, string>>(
    () =>
      Object.fromEntries([
        ...Object.entries(workspace?.drafts ?? {}).filter(([file]) =>
          /\.(bp|bpi|bpm)$/i.test(file),
        ),
        ...tabs
          .filter((tab) => /\.(bp|bpi|bpm)$/i.test(tab.file))
          .map((tab) => [tab.file, tab.content] as const),
      ]),
    [tabs, workspace?.drafts],
  );
  const diagnostics = useMemo(() => {
    const seen = new Set<string>();
    return [...liveDiagnostics, ...buildDiagnostics].filter((item) => {
      const key = `${item.code}\0${item.severity}\0${item.file}\0${item.range.startLine}\0${
        item.range.startColumn
      }\0${item.range.endLine}\0${item.range.endColumn}\0${item.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [buildDiagnostics, liveDiagnostics]);
  const openFiles = useMemo(() => tabs.map((tab) => tab.file), [tabs]);
  const treeRoot = useMemo(
    () => buildFileTree(workspace?.rootLabel ?? "", workspace?.entries ?? []),
    [workspace?.entries, workspace?.rootLabel],
  );
  const visibleTreePaths = useMemo(
    () => flattenFileTree(treeRoot, expandedTreePaths).map((node) => node.path),
    [expandedTreePaths, treeRoot],
  );
  const moveDestinations = useMemo(
    () => [
      "",
      ...(workspace?.entries
        .filter(
          (entry) =>
            entry.kind === "directory" && !(pendingMove && pathContains(pendingMove, entry.path)),
        )
        .map((entry) => entry.path) ?? []),
    ],
    [pendingMove, workspace?.entries],
  );
  const workspaceStyle = {
    "--files-width": filesOpen ? `${filesWidth}px` : "0px",
    "--files-divider": filesOpen ? "5px" : "0px",
    "--device-width": deviceOpen ? `${deviceWidth}px` : "0px",
    "--device-panel-width": `${deviceWidth}px`,
    "--device-divider": deviceOpen ? "5px" : "0px",
    "--problems-height": problemsOpen ? `${problemsHeight}px` : `${(40 * uiScale) / 100}px`,
    "--problems-divider": problemsOpen ? "5px" : "0px",
  } as CSSProperties;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    window.localStorage.setItem(LAYOUT_STORAGE_KEYS.filesOpen, String(filesOpen));
    window.localStorage.setItem(LAYOUT_STORAGE_KEYS.deviceOpen, String(deviceOpen));
    window.localStorage.setItem(LAYOUT_STORAGE_KEYS.problemsOpen, String(problemsOpen));
    window.localStorage.setItem(LAYOUT_STORAGE_KEYS.filesWidth, String(filesWidth));
    window.localStorage.setItem(LAYOUT_STORAGE_KEYS.deviceWidth, String(deviceWidth));
    window.localStorage.setItem(LAYOUT_STORAGE_KEYS.problemsHeight, String(problemsHeight));
  }, [deviceOpen, deviceWidth, filesOpen, filesWidth, problemsHeight, problemsOpen]);

  useEffect(() => {
    const workspaceElement = workspaceRef.current;
    const centerElement = centerRef.current;
    if (!workspaceElement || !centerElement) return undefined;
    const fitLayout = (): void => {
      setDeviceOverlay(
        workspaceElement.clientWidth < (filesOpen ? filesWidth + 5 : 0) + 420 + deviceWidth + 5,
      );
      const problemsMaximum = Math.max(
        LAYOUT_LIMITS.problemsHeight.min,
        Math.floor(centerElement.clientHeight * 0.45),
      );
      setProblemsHeight((value) => clamp(value, LAYOUT_LIMITS.problemsHeight.min, problemsMaximum));
    };
    fitLayout();
    const observer = new ResizeObserver(fitLayout);
    observer.observe(workspaceElement);
    observer.observe(centerElement);
    return () => observer.disconnect();
  }, [deviceOpen, deviceWidth, filesOpen, filesWidth, workspace?.id]);

  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeFile]);

  useEffect(() => {
    if (!activeFile) return;
    setSelectedTreePath(activeFile);
    setExpandedTreePaths((current) => expandAncestors(current, activeFile));
  }, [activeFile]);

  useEffect(() => {
    if (diagnosticIndex >= diagnostics.length) setDiagnosticIndex(-1);
  }, [diagnosticIndex, diagnostics.length]);

  useEffect(() => {
    const last = execution.logs.at(-1);
    if (last)
      setStatus(
        last.failed
          ? `${t.phases.error}: ${last.detail ?? t.messages[last.message]}`
          : t.messages[last.message],
      );
  }, [execution.logs, t]);

  useEffect(() => {
    setBuildDiagnostics(execution.diagnostics);
    if (execution.diagnostics.some((item) => item.severity === "error")) {
      setProblemsOpen(true);
    }
  }, [execution.diagnostics]);

  useEffect(() => {
    if (execution.phase === "awaitingDevice") {
      setDeviceOpen(true);
      setToolTab("connection");
    }
    if (execution.error && !execution.fileBusy) {
      if (execution.error.phase === "building" && execution.diagnostics.length)
        setProblemsOpen(true);
      else {
        setDeviceOpen(true);
        setToolTab("activity");
      }
    }
  }, [execution.phase, execution.error]);

  useEffect(() => {
    const workspaceId = workspace?.id;
    if (!workspaceId) return undefined;
    let current = true;
    const timer = window.setTimeout(() => {
      setChecking(true);
      void window.kobrixa.language
        .diagnostics(workspaceId, sourceOverlays)
        .then((items) => {
          if (current) setLiveDiagnostics(items);
        })
        .catch((error: unknown) => {
          if (current) setStatus(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          if (current) setChecking(false);
        });
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [sourceOverlays, workspace?.id]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (modalOpen) return;
      if (locked || projectBusy || managingEntries) {
        if (
          ((event.metaKey || event.ctrlKey) && ["s", "w"].includes(event.key.toLowerCase())) ||
          (event.altKey && event.shiftKey && event.key.toLowerCase() === "f")
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLocaleLowerCase("en-US");
      const consume = (): void => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (modifier && key === "s") {
        consume();
        void saveActive();
      } else if (modifier && key === "w" && activeFile) {
        consume();
        requestCloseTab(activeFile);
      } else if (modifier && key === "j") {
        consume();
        setProblemsOpen((value) => !value);
      } else if (modifier && key === "b") {
        consume();
        setFilesOpen((value) => !value);
      } else if (event.ctrlKey && key === "tab") {
        consume();
        cycleTabs(event.shiftKey ? -1 : 1);
      } else if (event.key === "F8") {
        consume();
        void navigateDiagnostics(event.shiftKey ? -1 : 1);
      } else if (event.altKey && event.shiftKey && key === "f") {
        consume();
        void editorRef.current?.format();
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  });

  useEffect(
    () => () => {
      for (const item of pendingDrafts.current.values()) {
        window.clearTimeout(item.timer);
        void enqueueDraftWrite(item.workspaceId, item.file, item.content).catch(() => undefined);
      }
      pendingDrafts.current.clear();
    },
    [],
  );

  function draftKey(workspaceId: string, file: string): string {
    return `${workspaceId}\0${file}`;
  }

  function enqueueDraftWrite(
    workspaceId: string,
    file: string,
    content: string | undefined,
  ): Promise<void> {
    const key = draftKey(workspaceId, file);
    const previous = draftWrites.current.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => window.kobrixa.workspace.saveDraft(workspaceId, file, content));
    draftWrites.current.set(key, next);
    next.then(
      () => {
        if (draftWrites.current.get(key) === next) draftWrites.current.delete(key);
      },
      () => {
        if (draftWrites.current.get(key) === next) draftWrites.current.delete(key);
      },
    );
    return next;
  }

  function queueDraft(workspaceId: string, file: string, content: string): void {
    const key = draftKey(workspaceId, file);
    const previous = pendingDrafts.current.get(key);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      pendingDrafts.current.delete(key);
      void enqueueDraftWrite(workspaceId, file, content).catch(report);
    }, 400);
    pendingDrafts.current.set(key, { workspaceId, file, content, timer });
  }

  async function settleDraft(workspaceId: string, file: string): Promise<void> {
    const key = draftKey(workspaceId, file);
    const pending = pendingDrafts.current.get(key);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingDrafts.current.delete(key);
    }
    await draftWrites.current.get(key)?.catch(() => undefined);
  }

  async function flushAllDrafts(): Promise<void> {
    const pending = [...pendingDrafts.current.values()];
    for (const item of pending) {
      window.clearTimeout(item.timer);
      pendingDrafts.current.delete(draftKey(item.workspaceId, item.file));
    }
    await Promise.all([
      ...pending.map((item) => enqueueDraftWrite(item.workspaceId, item.file, item.content)),
      ...draftWrites.current.values(),
    ]);
  }

  function removeWorkspaceDraft(file: string): void {
    setWorkspace((current) => {
      if (!current || !(file in current.drafts)) return current;
      const drafts = { ...current.drafts };
      delete drafts[file];
      return { ...current, drafts };
    });
  }

  function closeTab(file: string): void {
    const nextActive = activeFileAfterClose(
      tabs.map((tab) => tab.file),
      file,
      activeFile,
    );
    setTabs((current) => current.filter((tab) => tab.file !== file));
    setActiveFile(nextActive);
    if (focusTarget?.file === file) setFocusTarget(undefined);
  }

  function requestCloseTab(file: string): void {
    if (controller.editingLocked) return;
    const tab = tabs.find((item) => item.file === file);
    if (!tab) return;
    const disposition = tabCloseDisposition(tab.content !== tab.saved);
    if (disposition === "prompt") setPendingCloseFile(file);
    else closeTab(file);
  }

  async function resolveTabClose(action: "save" | "discard"): Promise<void> {
    if (!workspace || !pendingCloseFile) return;
    const file = pendingCloseFile;
    setClosingTab(true);
    try {
      if (action === "save") {
        const saved = await saveTab(file);
        if (!saved) return;
      } else {
        await settleDraft(workspace.id, file);
        await window.kobrixa.workspace.saveDraft(workspace.id, file, undefined);
        removeWorkspaceDraft(file);
      }
      closeTab(file);
      setPendingCloseFile(undefined);
    } catch (error) {
      report(error);
    } finally {
      setClosingTab(false);
    }
  }

  function cycleTabs(direction: 1 | -1): void {
    if (!tabs.length) return;
    const current = Math.max(
      0,
      tabs.findIndex((tab) => tab.file === activeFile),
    );
    const next = (current + direction + tabs.length) % tabs.length;
    setActiveFile(tabs[next]?.file);
  }

  async function navigateDiagnostics(direction: 1 | -1): Promise<void> {
    const next = nextDiagnosticIndex(diagnostics.length, diagnosticIndex, direction);
    if (next < 0) return;
    setDiagnosticIndex(next);
    await jumpTo(diagnostics[next]!, next);
  }

  async function adoptWorkspace(next: WorkspaceSummary | undefined): Promise<void> {
    if (!next) return;
    await flushAllDrafts();
    if (next.entryCandidates.length > 1) {
      setPendingWorkspace(next);
      setSelectedEntry(next.entryCandidates[0] ?? "");
      return;
    }
    await loadWorkspace(next);
  }

  async function loadWorkspace(selected: WorkspaceSummary): Promise<void> {
    controller.setWorkspace(selected.id);
    setWorkspace(selected);
    setTabs([]);
    setActiveFile(undefined);
    setLiveDiagnostics([]);
    setBuildDiagnostics([]);
    setDiagnosticIndex(-1);
    setFocusTarget(undefined);
    setChecking(false);
    setCursor({ line: 1, column: 1 });
    setSelectedTreePath("");
    setExpandedTreePaths(new Set([""]));
    setPendingCreate(undefined);
    setPendingMove(undefined);
    setPendingTrash(undefined);
    const first =
      selected.manifest?.entry ??
      selected.files.find((file) => file.endsWith(".bp")) ??
      selected.files[0];
    if (first) await openFile(selected, first, true);
    if (first) window.requestAnimationFrame(() => editorRef.current?.focus());
  }

  async function createProject(): Promise<void> {
    if (controller.editingLocked || projectBusyRef.current) return;
    const name = projectName.trim();
    if (!name) return;
    setNewProjectOpen(false);
    projectBusyRef.current = true;
    setProjectBusy(true);
    try {
      setStatus(t.choosingLocation);
      const next = await window.kobrixa.workspace.create(name);
      if (next) await adoptWorkspace(next);
      else setStatus(t.ready);
    } catch (error) {
      setNewProjectOpen(true);
      report(error);
    } finally {
      projectBusyRef.current = false;
      setProjectBusy(false);
    }
  }

  async function openProject(): Promise<void> {
    if (controller.editingLocked || projectBusyRef.current) return;
    projectBusyRef.current = true;
    setProjectBusy(true);
    try {
      await adoptWorkspace(await window.kobrixa.workspace.open());
    } catch (error) {
      report(error);
    } finally {
      projectBusyRef.current = false;
      setProjectBusy(false);
    }
  }

  async function confirmEntry(): Promise<void> {
    if (!pendingWorkspace || !pendingWorkspace.entryCandidates.includes(selectedEntry)) return;
    try {
      const selected = await window.kobrixa.workspace.selectEntry(
        pendingWorkspace.id,
        selectedEntry,
      );
      setPendingWorkspace(undefined);
      await loadWorkspace(selected);
    } catch (error) {
      report(error);
    }
  }

  async function openFile(
    current: WorkspaceSummary,
    file: string,
    replaceTabs = false,
  ): Promise<void> {
    const existing = !replaceTabs && tabs.find((tab) => tab.file === file);
    if (existing) {
      setActiveFile(file);
      return;
    }
    try {
      const saved = await window.kobrixa.workspace.read(current.id, file);
      const content = current.drafts[file] ?? saved;
      setTabs((value) =>
        replaceTabs ? [{ file, content, saved }] : [...value, { file, content, saved }],
      );
      setActiveFile(file);
    } catch (error) {
      report(error);
    }
  }

  async function saveTab(file: string): Promise<boolean> {
    if (!workspace) return false;
    const tab = tabs.find((item) => item.file === file);
    if (!tab) return false;
    try {
      await settleDraft(workspace.id, file);
      await window.kobrixa.workspace.write(workspace.id, file, tab.content);
      setTabs((value) =>
        value.map((item) => (item.file === file ? { ...item, saved: item.content } : item)),
      );
      removeWorkspaceDraft(file);
      setStatus(t.savedStatus);
      return true;
    } catch (error) {
      report(error);
      return false;
    }
  }

  async function saveActive(): Promise<void> {
    if (controller.editingLocked) return;
    if (activeFile) await saveTab(activeFile);
  }

  function updateActive(file: string, content: string): void {
    if (!workspace || controller.editingLocked) return;
    setBuildDiagnostics([]);
    setTabs((value) => value.map((tab) => (tab.file === file ? { ...tab, content } : tab)));
    queueDraft(workspace.id, file, content);
  }

  function beginCreateEntry(kind: WorkspaceEntry["kind"], parent: string): void {
    if (controller.editingLocked) return;
    setPendingCreate({ kind, parent });
    setEntryName(kind === "file" ? "untitled.bp" : "new-folder");
  }

  function requestMoveEntry(source: string): void {
    setPendingMove(source);
    setMoveDestination(pathParent(source));
  }

  function buildEntryMovesWith(source: string): boolean {
    const entry = workspace?.manifest?.entry;
    return Boolean(entry && pathContains(source, entry));
  }

  function manifestHasUnsavedChanges(): boolean {
    const manifest = tabs.find((tab) => tab.file === "kobrixa.json");
    return Boolean(
      (manifest && manifest.content !== manifest.saved) ||
      workspace?.drafts["kobrixa.json"] !== undefined,
    );
  }

  function applyMoveMutation(result: WorkspaceMutationResult, refreshedManifest?: string): void {
    const { moved } = result;
    editorRef.current?.remapFiles(moved);
    setWorkspace(result.workspace);
    setTabs((current) =>
      current.map((tab) => {
        const file = moved[tab.file] ?? tab.file;
        return file === "kobrixa.json" && refreshedManifest !== undefined
          ? { file, content: refreshedManifest, saved: refreshedManifest }
          : { ...tab, file };
      }),
    );
    setActiveFile((current) => (current ? (moved[current] ?? current) : current));
    setFocusTarget((current) =>
      current ? { ...current, file: moved[current.file] ?? current.file } : current,
    );
    const remapDiagnostic = (item: Diagnostic): Diagnostic => ({
      ...item,
      file: moved[item.file] ?? item.file,
    });
    setLiveDiagnostics((current) => current.map(remapDiagnostic));
    setBuildDiagnostics((current) => current.map(remapDiagnostic));
    setSelectedTreePath((current) => moved[current] ?? current);
    setExpandedTreePaths((current) => {
      const remapped = remapTreePaths(current, moved);
      const movedSelection = moved[selectedTreePath];
      return movedSelection ? expandAncestors(remapped, movedSelection) : remapped;
    });
    controller.invalidateBuild();
  }

  async function moveManagedEntry(source: string, target: string): Promise<boolean> {
    if (!workspace || controller.editingLocked) return false;
    if (buildEntryMovesWith(source) && manifestHasUnsavedChanges()) {
      setStatus(t.manifestDirty);
      return false;
    }
    setManagingEntries(true);
    setStatus(t.managingFiles);
    try {
      await flushAllDrafts();
      const result = await window.kobrixa.workspace.moveEntry(workspace.id, source, target);
      const refreshedManifest =
        buildEntryMovesWith(source) && !workspace.implicit
          ? await window.kobrixa.workspace.read(workspace.id, "kobrixa.json").catch(() => undefined)
          : undefined;
      applyMoveMutation(result, refreshedManifest);
      setStatus(t.ready);
      return true;
    } catch (error) {
      report(error);
      return false;
    } finally {
      setManagingEntries(false);
    }
  }

  async function renameManagedEntry(source: string, name: string): Promise<boolean> {
    const parent = pathParent(source);
    const target = parent ? `${parent}/${name.trim()}` : name.trim();
    return moveManagedEntry(source, target);
  }

  async function confirmCreateEntry(): Promise<void> {
    if (!workspace || !pendingCreate) return;
    const name = entryName.trim();
    if (!name) return;
    setManagingEntries(true);
    setStatus(t.managingFiles);
    try {
      const result = await window.kobrixa.workspace.createEntry(
        workspace.id,
        pendingCreate.parent,
        pendingCreate.kind,
        name,
      );
      const createdPath = pendingCreate.parent ? `${pendingCreate.parent}/${name}` : name;
      setWorkspace(result.workspace);
      setSelectedTreePath(createdPath);
      setExpandedTreePaths((current) => {
        const next = expandAncestors(current, createdPath);
        if (pendingCreate.kind === "directory") next.add(createdPath);
        return next;
      });
      if (pendingCreate.kind === "file") await openFile(result.workspace, createdPath);
      setPendingCreate(undefined);
      setStatus(t.ready);
      window.requestAnimationFrame(() => {
        if (pendingCreate.kind === "file") editorRef.current?.focus();
        else treeRef.current?.focus(createdPath);
      });
    } catch (error) {
      report(error);
    } finally {
      setManagingEntries(false);
    }
  }

  async function confirmMoveEntry(): Promise<void> {
    if (!pendingMove) return;
    const target = moveDestination
      ? `${moveDestination}/${pathName(pendingMove)}`
      : pathName(pendingMove);
    if (await moveManagedEntry(pendingMove, target)) {
      setPendingMove(undefined);
      window.requestAnimationFrame(() => treeRef.current?.focus(target));
    }
  }

  async function confirmTrashEntry(): Promise<void> {
    if (!workspace || !pendingTrash) return;
    setManagingEntries(true);
    setStatus(t.managingFiles);
    try {
      await flushAllDrafts();
      const result = await window.kobrixa.workspace.trashEntry(workspace.id, pendingTrash);
      const removed = new Set(result.removed);
      const remainingTabs = tabs.filter((tab) => !removed.has(tab.file));
      const nextActive = activeFileAfterRemoval(
        tabs.map((tab) => tab.file),
        activeFile,
        removed,
      );
      const nextTreeSelection = removed.has(selectedTreePath)
        ? selectionAfterRemoval(visibleTreePaths, selectedTreePath, removed)
        : selectedTreePath;
      const focusPath =
        activeFile && removed.has(activeFile) ? (nextActive ?? "") : nextTreeSelection;
      setWorkspace(result.workspace);
      setTabs(remainingTabs);
      setActiveFile(nextActive);
      setSelectedTreePath(focusPath);
      setExpandedTreePaths(
        (current) => new Set([...current].filter((entryPath) => !removed.has(entryPath))),
      );
      setLiveDiagnostics((current) => current.filter((item) => !removed.has(item.file)));
      setBuildDiagnostics((current) => current.filter((item) => !removed.has(item.file)));
      setFocusTarget((current) => (current && removed.has(current.file) ? undefined : current));
      controller.invalidateBuild();
      setPendingTrash(undefined);
      setStatus(t.ready);
      window.requestAnimationFrame(() => treeRef.current?.focus(focusPath));
    } catch (error) {
      report(error);
    } finally {
      setManagingEntries(false);
    }
  }

  async function saveAllChanges(): Promise<void> {
    if (!workspace) return;
    await flushAllDrafts();
    for (const [file, content] of filesToSave(workspace.drafts, tabs)) {
      await window.kobrixa.workspace.write(workspace.id, file, content);
      setTabs((current) =>
        current.map((tab) => (tab.file === file ? { ...tab, saved: content } : tab)),
      );
      removeWorkspaceDraft(file);
    }
  }

  function requestExecution(run: boolean): void {
    if (
      !workspace ||
      controller.editingLocked ||
      projectBusyRef.current ||
      managingEntries ||
      modalOpen
    )
      return;
    const request = { workspaceId: workspace.id, saveAll: saveAllChanges };
    if (run) void controller.run(request);
    else void controller.build(request);
  }

  async function discover(): Promise<void> {
    if (discovering) return;
    try {
      setDiscovering(true);
      setStatus(t.searching);
      const found = await window.kobrixa.device.discover();
      setDevices(found);
      setSelectedDevice(found.find((device) => device.transport === connectionModeRef.current)?.id);
      const count = found.filter((device) => device.transport === connectionModeRef.current).length;
      setStatus(count ? t.devicesFound(count) : t.noDevice);
    } catch (error) {
      report(error);
    } finally {
      setDiscovering(false);
    }
  }

  function connect(): void {
    const descriptor = devices.find(
      (device) => device.id === selectedDevice && device.transport === connectionMode,
    );
    if (descriptor) void controller.connect(descriptor);
    else if (connectionMode === "wifi" && wifiAddress.trim())
      void controller.connect(wifiAddress.trim());
  }

  function report(error: unknown): void {
    setStatus(error instanceof Error ? error.message : String(error));
  }

  function sidebarMaximum(side: "files" | "device"): number {
    if (side === "device") return LAYOUT_LIMITS.deviceWidth.max;
    const workspaceWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
    const otherWidth =
      side === "files"
        ? deviceOpen && !deviceOverlay
          ? deviceWidth
          : 0
        : filesOpen
          ? filesWidth
          : 0;
    const dividerWidth = (filesOpen ? 5 : 0) + (deviceOpen ? 5 : 0);
    const limit = side === "files" ? LAYOUT_LIMITS.filesWidth : LAYOUT_LIMITS.deviceWidth;
    return Math.max(
      limit.min,
      Math.min(limit.max, workspaceWidth - 420 - otherWidth - dividerWidth),
    );
  }

  function beginSidebarResize(
    side: "files" | "device",
    event: React.PointerEvent<HTMLDivElement>,
  ): void {
    event.currentTarget.focus();
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "files" ? filesWidth : deviceWidth;
    const limit = side === "files" ? LAYOUT_LIMITS.filesWidth : LAYOUT_LIMITS.deviceWidth;
    const maximum = sidebarMaximum(side);
    document.body.classList.add("is-resizing-horizontal");
    const move = (pointerEvent: PointerEvent): void => {
      const delta = pointerEvent.clientX - startX;
      const next = clamp(startWidth + (side === "files" ? delta : -delta), limit.min, maximum);
      if (side === "files") setFilesWidth(next);
      else setDeviceWidth(next);
    };
    const finish = (): void => {
      document.body.classList.remove("is-resizing-horizontal");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function resizeSidebarWithKeyboard(
    side: "files" | "device",
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const current = side === "files" ? filesWidth : deviceWidth;
    const limit = side === "files" ? LAYOUT_LIMITS.filesWidth : LAYOUT_LIMITS.deviceWidth;
    const delta = side === "files" ? direction * 16 : direction * -16;
    const next = clamp(current + delta, limit.min, sidebarMaximum(side));
    if (side === "files") setFilesWidth(next);
    else setDeviceWidth(next);
  }

  function problemsMaximum(): number {
    return Math.max(
      LAYOUT_LIMITS.problemsHeight.min,
      Math.floor((centerRef.current?.clientHeight ?? 640) * 0.45),
    );
  }

  function beginProblemsResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.currentTarget.focus();
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = problemsHeight;
    const maximum = problemsMaximum();
    document.body.classList.add("is-resizing-vertical");
    const move = (pointerEvent: PointerEvent): void =>
      setProblemsHeight(
        clamp(
          startHeight + startY - pointerEvent.clientY,
          LAYOUT_LIMITS.problemsHeight.min,
          maximum,
        ),
      );
    const finish = (): void => {
      document.body.classList.remove("is-resizing-vertical");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function resizeProblemsWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    setProblemsHeight((value) =>
      clamp(
        value + (event.key === "ArrowUp" ? 16 : -16),
        LAYOUT_LIMITS.problemsHeight.min,
        problemsMaximum(),
      ),
    );
  }

  async function jumpTo(item: Diagnostic, index?: number): Promise<void> {
    if (!workspace) return;
    if (workspace.files.includes(item.file)) await openFile(workspace, item.file);
    if (index !== undefined) setDiagnosticIndex(index);
    setFocusTarget({ file: item.file, range: item.range, requestId: ++focusRequest.current });
    setProblemsOpen(true);
  }

  return (
    <main className="app-shell">
      <Toolbar
        t={t}
        locale={locale}
        appearance={
          <Appearance
            locale={locale}
            theme={theme}
            scale={uiScale}
            fontSize={codeSize}
            onTheme={setTheme}
            onScale={setUiScale}
            onFontSize={setCodeSize}
          />
        }
        deviceLocked={controller.locked || managingEntries || projectBusy || modalOpen}
        name={workspace?.name}
        locked={locked || managingEntries || projectBusy || modalOpen}
        canSave={Boolean(active && active.content !== active.saved)}
        state={execution}
        onNew={() => {
          setProjectName("my-robot");
          setNewProjectOpen(true);
        }}
        onOpen={() => void openProject()}
        onSave={() => void saveActive()}
        onRun={() => requestExecution(true)}
        onBuild={() => requestExecution(false)}
        onStop={() => void controller.stop()}
        onUpload={() => void controller.upload()}
        onRunUploaded={() => void controller.runDeployed()}
        onDelete={() => void controller.deleteDeployed()}
        onCancel={() => void controller.cancelBuild()}
        onDevice={() => {
          setToolTab("connection");
          setDeviceOpen(true);
        }}
        onLocale={() => setLocale((value) => (value === "en" ? "zh-TW" : "en"))}
      />
      {!workspace ? (
        <Welcome
          t={t}
          onNew={() => {
            if (!projectBusy) {
              setProjectName("my-robot");
              setNewProjectOpen(true);
            }
          }}
          onOpen={() => void openProject()}
        />
      ) : (
        <section
          className={`workspace ${deviceOverlay ? "device-overlay" : ""}`}
          ref={workspaceRef}
          style={workspaceStyle}
        >
          <aside
            className={`sidebar files-panel ${filesOpen ? "" : "collapsed"}`}
            aria-hidden={!filesOpen}
          >
            {filesOpen && (
              <>
                <h2>{t.files}</h2>
                <ProjectTree
                  ref={treeRef}
                  activeFile={activeFile}
                  buildEntry={workspace.manifest?.entry}
                  busy={managingEntries || locked || projectBusy}
                  copy={{
                    treeLabel: t.fileTree,
                    newFile: t.newFile,
                    newFolder: t.newFolder,
                    moreActions: t.moreActions,
                    rename: t.rename,
                    move: t.move,
                    trash: t.trash,
                    expand: t.expand,
                    collapse: t.collapse,
                  }}
                  entries={workspace.entries}
                  expandedPaths={expandedTreePaths}
                  rootLabel={workspace.rootLabel}
                  selectedPath={selectedTreePath}
                  onCreate={beginCreateEntry}
                  onExpandedPaths={setExpandedTreePaths}
                  onMove={async (source, target) => {
                    await moveManagedEntry(source, target);
                  }}
                  onMoveRequest={requestMoveEntry}
                  onOpenFile={(file) => void openFile(workspace, file)}
                  onRename={renameManagedEntry}
                  onSelectedPath={setSelectedTreePath}
                  onTrash={setPendingTrash}
                />
              </>
            )}
          </aside>
          <div
            className="resize-handle resize-files"
            role="separator"
            aria-label={t.resizeFiles}
            aria-orientation="vertical"
            aria-valuemin={LAYOUT_LIMITS.filesWidth.min}
            aria-valuemax={sidebarMaximum("files")}
            aria-valuenow={filesWidth}
            aria-hidden={!filesOpen}
            tabIndex={filesOpen ? 0 : -1}
            onDoubleClick={() => setFilesWidth(LAYOUT_DEFAULTS.filesWidth)}
            onKeyDown={(event) => resizeSidebarWithKeyboard("files", event)}
            onPointerDown={(event) => beginSidebarResize("files", event)}
          />

          <section className="center" ref={centerRef}>
            <div className="editor-toolbar">
              <button
                aria-pressed={filesOpen}
                title={filesOpen ? t.hideFiles : t.showFiles}
                onClick={() => setFilesOpen((value) => !value)}
              >
                <span aria-hidden="true">☰</span>
                {t.files}
              </button>
              <div className="breadcrumb" title={active?.file}>
                {active?.file ?? workspace.name}
              </div>
              <div className="editor-tools">
                <button
                  disabled={!active || locked}
                  title={`${t.format} · Shift+Alt/Option+F`}
                  onClick={() => void editorRef.current?.format()}
                >
                  {t.format}
                </button>
                <button
                  className="icon-button"
                  disabled={!diagnostics.length}
                  aria-label={t.previousProblem}
                  title={`${t.previousProblem} · Shift+F8`}
                  onClick={() => void navigateDiagnostics(-1)}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  disabled={!diagnostics.length}
                  aria-label={t.nextProblem}
                  title={`${t.nextProblem} · F8`}
                  onClick={() => void navigateDiagnostics(1)}
                >
                  ↓
                </button>
                <button
                  aria-pressed={problemsOpen}
                  title={problemsOpen ? t.hideProblems : t.showProblems}
                  onClick={() => setProblemsOpen((value) => !value)}
                >
                  {t.diagnostics}
                  {diagnostics.length > 0 && <strong>{diagnostics.length}</strong>}
                </button>
                <button
                  aria-pressed={deviceOpen}
                  title={deviceOpen ? t.hideDevice : t.showDevice}
                  onClick={() => setDeviceOpen((value) => !value)}
                >
                  EV3
                </button>
              </div>
            </div>

            <div className="tabs" role="tablist" aria-label={t.files}>
              {tabs.map((tab) => {
                const selected = tab.file === activeFile;
                const tabDirty = tab.content !== tab.saved;
                return (
                  <div
                    className={`tab ${selected ? "active" : ""}`}
                    key={tab.file}
                    ref={selected ? activeTabRef : undefined}
                  >
                    <button
                      className="tab-select"
                      role="tab"
                      aria-selected={selected}
                      title={tab.file}
                      onClick={() => {
                        setActiveFile(tab.file);
                        window.requestAnimationFrame(() => editorRef.current?.focus());
                      }}
                    >
                      <span className="tab-kind">
                        {tab.file.split(".").pop()?.toLocaleUpperCase("en-US")}
                      </span>
                      <span className="tab-name">{tab.file}</span>
                      {tabDirty && <i aria-label={t.unsaved}>●</i>}
                    </button>
                    <button
                      className="tab-close"
                      disabled={locked}
                      aria-label={`${t.closeTab}: ${tab.file}`}
                      title={`${t.closeTab} · Mod+W`}
                      onClick={() => requestCloseTab(tab.file)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="editor-stage">
              {locked && (
                <div className="editor-lock" role="status">
                  {t.phases[execution.phase]} <span>{t.locked}</span>
                </div>
              )}
              {active ? (
                <Editor
                  key={workspace.id}
                  ref={editorRef}
                  theme={theme}
                  fontSize={codeSize}
                  readOnly={locked || projectBusy}
                  file={active.file}
                  value={active.content}
                  openFiles={openFiles}
                  diagnostics={diagnostics}
                  focusTarget={focusTarget}
                  ariaLabel={t.editorLabel}
                  onChange={updateActive}
                  onCursorChange={setCursor}
                />
              ) : (
                <div className="empty">{t.chooseFile}</div>
              )}
            </div>

            <div
              className="resize-handle resize-problems"
              role="separator"
              aria-label={t.resizeProblems}
              aria-orientation="horizontal"
              aria-valuemin={LAYOUT_LIMITS.problemsHeight.min}
              aria-valuemax={problemsMaximum()}
              aria-valuenow={problemsHeight}
              aria-hidden={!problemsOpen}
              tabIndex={problemsOpen ? 0 : -1}
              onDoubleClick={() => setProblemsHeight(LAYOUT_DEFAULTS.problemsHeight)}
              onKeyDown={resizeProblemsWithKeyboard}
              onPointerDown={beginProblemsResize}
            />
            <BottomPanel
              t={t}
              open={problemsOpen}
              onToggle={() => setProblemsOpen((value) => !value)}
              diagnostics={diagnostics}
              selected={diagnosticIndex}
              checking={checking}
              onJump={(item, index) => void jumpTo(item, index)}
            />
          </section>

          <div
            className="resize-handle resize-device"
            role="separator"
            aria-label={t.resizeDevice}
            aria-orientation="vertical"
            aria-valuemin={LAYOUT_LIMITS.deviceWidth.min}
            aria-valuemax={sidebarMaximum("device")}
            aria-valuenow={deviceWidth}
            aria-hidden={!deviceOpen}
            tabIndex={deviceOpen ? 0 : -1}
            onDoubleClick={() => setDeviceWidth(LAYOUT_DEFAULTS.deviceWidth)}
            onKeyDown={(event) => resizeSidebarWithKeyboard("device", event)}
            onPointerDown={(event) => beginSidebarResize("device", event)}
          />
          <aside
            className={`sidebar device-panel ${deviceOpen ? "" : "collapsed"}`}
            aria-hidden={!deviceOpen}
          >
            {deviceOpen && (
              <ToolsPanel
                tab={toolTab}
                onTab={setToolTab}
                locale={locale}
                onClose={() => {
                  controller.cancelWaiting();
                  setDeviceOpen(false);
                }}
                connection={
                  <DevicePanel
                    t={t}
                    locale={locale}
                    state={execution}
                    devices={devices}
                    discovering={discovering}
                    locked={controller.locked}
                    mode={connectionMode}
                    onMode={(mode) => {
                      setConnectionMode(mode);
                      setSelectedDevice(undefined);
                    }}
                    selected={selectedDevice}
                    onSelect={setSelectedDevice}
                    address={wifiAddress}
                    onAddress={(address) => {
                      setWifiAddress(address);
                      setSelectedDevice(undefined);
                    }}
                    onDiscover={() => void discover()}
                    onConnect={connect}
                    onDisconnect={() => void controller.disconnect()}
                    onCancel={() => controller.cancelWaiting()}
                  />
                }
                files={
                  <RemoteFilesPanel
                    controller={remoteFiles}
                    state={remoteState}
                    active={toolTab === "files"}
                    locale={locale}
                    locked={controller.locked}
                    deployedPath={execution.deployed?.path}
                    onConnect={() => setToolTab("connection")}
                  />
                }
                activity={<ActivityPanel t={t} locale={locale} state={execution} />}
              />
            )}
          </aside>
        </section>
      )}
      {newProjectOpen && (
        <Modal
          onClose={() => {
            setNewProjectOpen(false);
          }}
        >
          <form
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-project-title"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <h2 id="new-project-title">{t.newProject}</h2>
            <label>
              {t.projectName}
              <input
                autoFocus
                maxLength={80}
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
              <small>{t.projectNameHint}</small>
            </label>
            <div className="modal-actions">
              <button type="button" onClick={() => setNewProjectOpen(false)}>
                {t.close}
              </button>
              <button className="primary" type="submit" disabled={!projectName.trim()}>
                {t.create}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingWorkspace && (
        <Modal
          onClose={() => {
            setPendingWorkspace(undefined);
          }}
        >
          <form
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="entry-title"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmEntry();
            }}
          >
            <h2 id="entry-title">{t.chooseEntry}</h2>
            <select
              value={selectedEntry}
              onChange={(event) => setSelectedEntry(event.target.value)}
            >
              {pendingWorkspace.entryCandidates.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingWorkspace(undefined)}>
                {t.close}
              </button>
              <button className="primary" type="submit" disabled={!selectedEntry}>
                {t.continue}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingCreate && (
        <Modal
          onClose={() => {
            if (!managingEntries) setPendingCreate(undefined);
          }}
        >
          <form
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-entry-title"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmCreateEntry();
            }}
          >
            <h2 id="create-entry-title">
              {pendingCreate.kind === "file" ? t.createFileTitle : t.createFolderTitle}
            </h2>
            <p className="modal-path">
              {t.entryParent}: {pendingCreate.parent || workspace?.rootLabel}
            </p>
            <label>
              {t.entryName}
              <input
                autoFocus
                maxLength={255}
                value={entryName}
                onChange={(event) => setEntryName(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <button
                type="button"
                disabled={managingEntries}
                onClick={() => setPendingCreate(undefined)}
              >
                {t.close}
              </button>
              <button
                className="primary"
                type="submit"
                disabled={managingEntries || !entryName.trim()}
              >
                {t.createEntryAction}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingMove && (
        <Modal
          onClose={() => {
            if (!managingEntries) setPendingMove(undefined);
          }}
        >
          <form
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="move-entry-title"
            onSubmit={(event) => {
              event.preventDefault();
              void confirmMoveEntry();
            }}
          >
            <h2 id="move-entry-title">{t.moveTitle}</h2>
            <p className="modal-path">{pendingMove}</p>
            <label>
              {t.moveDestination}
              <select
                autoFocus
                value={moveDestination}
                onChange={(event) => setMoveDestination(event.target.value)}
              >
                {moveDestinations.map((directory) => (
                  <option key={directory || "root"} value={directory}>
                    {directory || workspace?.rootLabel}
                  </option>
                ))}
              </select>
            </label>
            <div className="modal-actions">
              <button
                type="button"
                disabled={managingEntries}
                onClick={() => setPendingMove(undefined)}
              >
                {t.close}
              </button>
              <button className="primary" type="submit" disabled={managingEntries}>
                {t.move}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {pendingTrash && (
        <Modal
          onClose={() => {
            if (!managingEntries) setPendingTrash(undefined);
          }}
        >
          <div
            className="modal-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="trash-entry-title"
            aria-describedby="trash-entry-description"
          >
            <h2 id="trash-entry-title">{t.trashTitle}</h2>
            <p id="trash-entry-description" className="modal-description">
              {t.trashBody(pendingTrash)}
            </p>
            {tabs.some(
              (tab) => pathContains(pendingTrash, tab.file) && tab.content !== tab.saved,
            ) && <p className="modal-warning">{t.trashDirty}</p>}
            <div className="modal-actions">
              <button
                autoFocus
                type="button"
                disabled={managingEntries}
                onClick={() => setPendingTrash(undefined)}
              >
                {t.close}
              </button>
              <button
                className="danger"
                type="button"
                disabled={managingEntries}
                onClick={() => void confirmTrashEntry()}
              >
                {t.trash}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {pendingCloseFile && (
        <Modal
          onClose={() => {
            if (!closingTab) setPendingCloseFile(undefined);
          }}
        >
          <div
            className="modal-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="close-tab-title"
            aria-describedby="close-tab-description"
          >
            <h2 id="close-tab-title">{t.unsavedTitle}</h2>
            <p id="close-tab-description" className="modal-description">
              {t.unsavedBody(pendingCloseFile)}
            </p>
            <div className="modal-actions three-actions">
              <button
                type="button"
                disabled={closingTab}
                onClick={() => setPendingCloseFile(undefined)}
              >
                {t.close}
              </button>
              <button
                className="danger"
                type="button"
                disabled={closingTab}
                onClick={() => void resolveTabClose("discard")}
              >
                {t.discardAndClose}
              </button>
              <button
                autoFocus
                className="primary"
                type="button"
                disabled={closingTab}
                onClick={() => void resolveTabClose("save")}
              >
                {t.saveAndClose}
              </button>
            </div>
          </div>
        </Modal>
      )}
      <footer>
        <div className="status-group">
          {active ? (
            <span className={active.content !== active.saved ? "dirty" : ""}>
              {active.content !== active.saved ? `● ${t.unsaved}` : `✓ ${t.saved}`}
            </span>
          ) : (
            <span>{workspace ? t.ready : "Kobrixa"}</span>
          )}
          {dirty && active?.content === active?.saved && <span className="dirty">●</span>}
        </div>
        <span className="operation-status" role="status" title={status}>
          {locked ? t.phases[execution.phase] : checking ? t.checking : status}
        </span>
        <div className="status-group status-details">
          {active && (
            <>
              <span>
                {t.line} {cursor.line}, {t.column} {cursor.column}
              </span>
              <span>
                {active.file.toLocaleLowerCase("en-US").endsWith(".json") ? "JSON" : t.basicPlus}
              </span>
            </>
          )}
          <span>{workspace?.manifest?.target ?? "ev3-native"}</span>
        </div>
      </footer>
    </main>
  );
}
