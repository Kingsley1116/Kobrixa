import type { EditorAnalysis } from "./editor/editor.js";
import { normalizeSource } from "./editor/language-features.js";
import { ResizeHandle } from "./components/resize-handle.js";
import { ClosableTab } from "./components/closable-tab.js";
import { Dialog, DialogActions } from "./components/dialog.js";
import { useKeyboard } from "./keybindings/keyboard-state.js";
import type { AppCommand } from "./keybindings/keybindings.js";
import { FileWriteQueue, saveSnapshot } from "./workspace/save-coordinator.js";
import { formatSource } from "./editor/editor-format.js";
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
import { Editor, type EditorFocusTarget, type EditorHandle } from "./editor/editor.js";
import {
  LAYOUT_DEFAULTS,
  LAYOUT_LIMITS,
  activeFileAfterClose,
  activeFileAfterRemoval,
  clamp,
  nextDiagnosticIndex,
  tabCloseDisposition,
} from "./workbench/workbench-state.js";
import {
  buildFileTree,
  expandAncestors,
  flattenFileTree,
  pathContains,
  pathName,
  pathParent,
  remapTreePaths,
  selectionAfterRemoval,
} from "./workspace/file-tree.js";
import { ProjectTree, type ProjectTreeHandle } from "./workspace/project-tree.js";

import { ExecutionController, filesToSave } from "./execution/execution.js";
import { Welcome } from "./workbench/welcome.js";
import { Toolbar } from "./workbench/toolbar.js";
import { DevicePanel } from "./device/device-panel.js";
import { BottomPanel } from "./workbench/bottom-panel.js";
import { isModalOpen, subscribeModals } from "./components/modal.js";
import { settingsStore, useSettings } from "./settings/settings-state.js";
import type { Settings } from "./settings/settings.js";
import {
  SettingsPanel,
  SettingsQuickControls,
  SettingsTab,
  SettingsError,
  settingsCopy,
} from "./settings/settings-panel.js";
import { ToolsPanel, ActivityPanel } from "./device/tools-panel.js";
import { RemoteFilesPanel } from "./device/remote-files-panel.js";
import { RemoteFilesController } from "./device/remote-files.js";
import { Picker } from "./components/picker.js";
import { CompletionSession } from "./editor/completion-session.js";
import { AnalysisSession } from "./editor/analysis-session.js";
import { AnalysisTransport } from "./editor/analysis-transport.js";
import { Documents, CursorStore, type DocumentTab } from "./editor/documents.js";
import { CursorPosition } from "./editor/cursor-position.js";

import { copy } from "./i18n/copy.js";
type Tab = DocumentTab;
type PendingDraft = { workspaceId: string; file: string; content: () => string; timer: number };
type PendingCreate = { kind: WorkspaceEntry["kind"]; parent: string };

export function App(): React.JSX.Element {
  const { values: settings, saveError, reducedMotion } = useSettings();
  const {
    locale,
    theme,
    uiScale,
    codeSize,
    toolTab,
    filesOpen,
    deviceOpen,
    problemsOpen,
    filesWidth,
    deviceWidth,
    problemsHeight,
  } = settings;
  const t = copy[locale];
  const st = settingsCopy[locale];
  const [settingsCategory, setSettingsCategory] = useState<{
    category: "appearance" | "shortcuts";
    request: number;
  }>({ category: "appearance", request: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsActive, setSettingsActive] = useState(false);
  const setToolTab = (
    value: Settings["toolTab"] | ((previous: Settings["toolTab"]) => Settings["toolTab"]),
  ): void => settingsStore.set("toolTab", value);
  const setFilesOpen = (
    value: Settings["filesOpen"] | ((previous: Settings["filesOpen"]) => Settings["filesOpen"]),
  ): void => settingsStore.set("filesOpen", value);
  const setDeviceOpen = (
    value: Settings["deviceOpen"] | ((previous: Settings["deviceOpen"]) => Settings["deviceOpen"]),
  ): void => settingsStore.set("deviceOpen", value);
  const setProblemsOpen = (
    value:
      Settings["problemsOpen"] | ((previous: Settings["problemsOpen"]) => Settings["problemsOpen"]),
  ): void => settingsStore.set("problemsOpen", value);
  const setFilesWidth = (
    value: Settings["filesWidth"] | ((previous: Settings["filesWidth"]) => Settings["filesWidth"]),
  ): void => settingsStore.set("filesWidth", value);
  const setDeviceWidth = (
    value:
      Settings["deviceWidth"] | ((previous: Settings["deviceWidth"]) => Settings["deviceWidth"]),
  ): void => settingsStore.set("deviceWidth", value);
  const setProblemsHeight = (
    value:
      | Settings["problemsHeight"]
      | ((previous: Settings["problemsHeight"]) => Settings["problemsHeight"]),
  ): void => settingsStore.set("problemsHeight", value);
  const [controller] = useState(() => new ExecutionController(window.kobrixa));
  const execution = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const locked = controller.editingLocked;
  const [remoteFiles] = useState(() => new RemoteFilesController(window.kobrixa, controller));
  const remoteState = useSyncExternalStore(remoteFiles.subscribe, remoteFiles.getSnapshot);
  const [deviceOverlay, setDeviceOverlay] = useState(false);
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
  const [workspace, setWorkspaceState] = useState<WorkspaceSummary>();
  const workspaceStateRef = useRef(workspace);
  const setWorkspace = (
    value:
      | WorkspaceSummary
      | undefined
      | ((previous: WorkspaceSummary | undefined) => WorkspaceSummary | undefined),
  ): void => {
    const next = typeof value === "function" ? value(workspaceStateRef.current) : value;
    workspaceStateRef.current = next;
    analysisSession.configure(next);
    completionSession.configure(next);
    setWorkspaceState(next);
  };
  const [documents] = useState(() => new Documents());
  const tabs = useSyncExternalStore(documents.subscribe, documents.getSnapshot);
  const tabsRef = {
    get current() {
      return documents.getSnapshot();
    },
  };
  const setTabs = (value: Tab[] | ((previous: Tab[]) => Tab[])): void => {
    documents.replace(typeof value === "function" ? value(documents.getSnapshot()) : value);
  };
  const [writeQueue] = useState(() => new FileWriteQueue());
  const latestDrafts = useRef(new Map<string, string>());
  const autoSaveFailures = useRef(new Map<string, string>());
  const autoSaveTimers = useRef(new Map<string, { revision: number; timer: number }>());
  const focusSaves = useRef(new Set<string>());
  const [activeFile, setActiveFile] = useState<string>();
  const [liveDiagnostics, setLiveDiagnostics] = useState<Diagnostic[]>([]);
  const [buildDiagnostics, setBuildDiagnostics] = useState<Diagnostic[]>([]);
  const [status, setStatus] = useState<string>(t.ready);
  const [devices, setDevices] = useState<DeviceDescriptor[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<string>();
  const [wifiAddress, setWifiAddress] = useState("");
  const [focusTarget, setFocusTarget] = useState<EditorFocusTarget>();
  const [cursorStore] = useState(() => new CursorStore());
  const [diagnosticIndex, setDiagnosticIndex] = useState(-1);
  const [checking, setChecking] = useState(false);
  const [completionSession] = useState(
    () =>
      new CompletionSession((workspaceId, request) =>
        window.kobrixa.language.completionSync(workspaceId, request),
      ),
  );
  useEffect(() => () => completionSession.dispose(), [completionSession]);
  const [analysisTransport] = useState(
    () =>
      new AnalysisTransport((workspaceId, request) =>
        window.kobrixa.language.sync(workspaceId, request),
      ),
  );
  const [analysisSession] = useState(
    () =>
      new AnalysisSession(documents, {
        analyze: (workspaceId, overlays) => analysisTransport.analyze(workspaceId, overlays),
        cancel: () => {
          void window.kobrixa.language.cancel().catch(() => undefined);
        },
        diagnostics: (analysis) => setLiveDiagnostics(analysis.diagnostics),
        checking: setChecking,
        error: (error) => setStatus(error instanceof Error ? error.message : String(error)),
      }),
  );
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
  const [managingEntries, setManagingEntriesState] = useState(false);
  const managingEntriesRef = useRef(false);
  const setManagingEntries = (value: boolean): void => {
    managingEntriesRef.current = value;
    setManagingEntriesState(value);
  };
  const editorRef = useRef<EditorHandle>(null);
  const treeRef = useRef<ProjectTreeHandle>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef(0);
  const pendingDrafts = useRef(new Map<string, PendingDraft>());
  const draftWrites = useRef(new Map<string, Promise<void>>());
  const active = tabs.find((tab) => tab.file === activeFile);
  const dirty = tabs.some((tab) => tab.dirty);
  const auxiliaryModalOpen = useSyncExternalStore(subscribeModals, isModalOpen);
  const modalOpen = Boolean(
    auxiliaryModalOpen ||
    newProjectOpen ||
    pendingWorkspace ||
    pendingCloseFile ||
    pendingCreate ||
    pendingMove ||
    pendingTrash,
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
  const openFiles = documents.getOpenFiles();
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

  useEffect(() => analysisSession.attach(), [analysisSession]);

  const keyboard = useKeyboard(runCommand, modalOpen);
  const titleWithShortcut = (label: string, command: AppCommand): string =>
    [label, keyboard.hint(command)].filter(Boolean).join(" · ");

  useEffect(() => {
    const sync = () => {
      const enabled =
        workspace &&
        settings.autoSave === "afterDelay" &&
        !locked &&
        !projectBusy &&
        !managingEntries &&
        !modalOpen;
      const dirtyTabs = enabled ? documents.getSnapshot().filter((tab) => tab.dirty) : [];
      for (const [file, scheduled] of autoSaveTimers.current) {
        if (
          !dirtyTabs.some(
            (tab) => tab.file === file && documents.version(file) === scheduled.revision,
          )
        ) {
          window.clearTimeout(scheduled.timer);
          autoSaveTimers.current.delete(file);
        }
      }
      if (!enabled) return;
      for (const tab of dirtyTabs) {
        const failed = autoSaveFailures.current.get(draftKey(workspace.id, tab.file));
        if (
          autoSaveTimers.current.has(tab.file) ||
          (failed !== undefined && failed === tab.content)
        )
          continue;
        const timer = window.setTimeout(() => {
          autoSaveTimers.current.delete(tab.file);
          void autoSaveFile(tab.file);
        }, settings.autoSaveDelay);
        autoSaveTimers.current.set(tab.file, { revision: documents.version(tab.file), timer });
      }
    };
    sync();
    return documents.onChange(sync);
  }, [
    documents,
    workspace?.id,
    settings.autoSave,
    settings.autoSaveDelay,
    locked,
    projectBusy,
    managingEntries,
    modalOpen,
  ]);
  useEffect(() => {
    return () => {
      for (const scheduled of autoSaveTimers.current.values()) window.clearTimeout(scheduled.timer);
      autoSaveTimers.current.clear();
    };
  }, [workspace?.id, settings.autoSave, settings.autoSaveDelay]);
  const previousActive = useRef<{
    workspaceId: string | undefined;
    file: string | undefined;
    settings: boolean;
  }>({ workspaceId: undefined, file: undefined, settings: false });
  useEffect(() => {
    const previous = previousActive.current;
    previousActive.current = {
      workspaceId: workspace?.id,
      file: activeFile,
      settings: settingsActive,
    };
    if (
      previous.workspaceId === workspace?.id &&
      previous.file &&
      (previous.file !== activeFile || (!previous.settings && settingsActive))
    )
      requestFocusSave(previous.file);
    if (
      !locked &&
      !projectBusy &&
      !managingEntries &&
      !modalOpen &&
      settings.autoSave === "onFocusChange"
    ) {
      for (const file of focusSaves.current) void autoSaveFile(file);
      focusSaves.current.clear();
    }
  }, [
    activeFile,
    settingsActive,
    workspace?.id,
    locked,
    projectBusy,
    managingEntries,
    modalOpen,
    settings.autoSave,
  ]);
  useEffect(() => {
    const blur = () => {
      if (activeFile) requestFocusSave(activeFile);
    };
    window.addEventListener("blur", blur);
    return () => window.removeEventListener("blur", blur);
  });

  useEffect(
    () => () => {
      for (const item of pendingDrafts.current.values()) {
        window.clearTimeout(item.timer);
        void enqueueDraftWrite(item.workspaceId, item.file, item.content()).catch(() => undefined);
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
      .then(() =>
        writeQueue.enqueue(workspaceId, file, () => {
          const tab =
            workspaceStateRef.current?.id === workspaceId
              ? tabsRef.current.find((tab) => tab.file === file)
              : undefined;
          const draft =
            content === undefined
              ? undefined
              : tab
                ? tab.content === tab.saved
                  ? undefined
                  : tab.content
                : (latestDrafts.current.get(key) ?? content);
          return window.kobrixa.workspace.saveDraft(workspaceId, file, draft);
        }),
      );
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

  function queueDraft(workspaceId: string, file: string, content: string | (() => string)): void {
    const key = draftKey(workspaceId, file);
    const read = typeof content === "function" ? content : () => content;
    if (typeof content === "string") latestDrafts.current.set(key, content);
    const previous = pendingDrafts.current.get(key);
    if (previous) window.clearTimeout(previous.timer);
    const timer = window.setTimeout(() => {
      pendingDrafts.current.delete(key);
      const text = read();
      latestDrafts.current.set(key, text);
      void enqueueDraftWrite(workspaceId, file, text).catch(report);
    }, 400);
    pendingDrafts.current.set(key, { workspaceId, file, content: read, timer });
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
      ...pending.map((item) => enqueueDraftWrite(item.workspaceId, item.file, item.content())),
      ...draftWrites.current.values(),
    ]);
    await writeQueue.idle();
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
        await writeQueue.enqueue(workspace.id, file, () =>
          window.kobrixa.workspace.saveDraft(workspace.id, file, undefined),
        );
        latestDrafts.current.delete(draftKey(workspace.id, file));
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

  function openSettings(): void {
    setSettingsOpen(true);
    setSettingsActive(true);
    if (settingsActive) document.getElementById("settings-title")?.focus({ preventScroll: true });
  }
  function closeSettings(): void {
    setSettingsOpen(false);
    setSettingsActive(false);
    window.requestAnimationFrame(() => {
      if (workspace && activeFile) editorRef.current?.focus();
      else document.querySelector<HTMLButtonElement>(".settings-trigger")?.focus();
    });
  }
  function cycleTabs(direction: 1 | -1): void {
    const count = tabs.length + Number(settingsOpen);
    if (!count) return;
    const current = settingsActive
      ? tabs.length
      : Math.max(
          0,
          tabs.findIndex((tab) => tab.file === activeFile),
        );
    const next = (current + direction + count) % count;
    if (next === tabs.length) openSettings();
    else {
      setSettingsActive(false);
      setActiveFile(tabs[next]?.file);
      window.requestAnimationFrame(() => editorRef.current?.focus());
    }
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
    await writeQueue.idle();
    focusSaves.current.clear();
    for (const scheduled of autoSaveTimers.current.values()) window.clearTimeout(scheduled.timer);
    autoSaveTimers.current.clear();
    controller.setWorkspace(selected.id);
    setWorkspace(selected);
    setTabs([]);
    setActiveFile(undefined);
    setLiveDiagnostics([]);
    setBuildDiagnostics([]);
    setDiagnosticIndex(-1);
    setFocusTarget(undefined);
    setChecking(false);
    cursorStore.update({ line: 1, column: 1 });
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
    setSettingsActive(false);
    const existing = !replaceTabs && tabsRef.current.find((tab) => tab.file === file);
    if (existing) {
      setActiveFile(file);
      return;
    }
    try {
      const saved = await window.kobrixa.workspace.read(current.id, file);
      if (workspaceStateRef.current?.id !== current.id) return;
      const content = workspaceStateRef.current.drafts[file] ?? saved;
      setTabs((value) =>
        replaceTabs
          ? [{ file, content, saved }]
          : value.some((tab) => tab.file === file)
            ? value
            : [...value, { file, content, saved }],
      );
      setActiveFile(file);
    } catch (error) {
      report(error);
    }
  }

  async function saveTab(file: string, automatic = false): Promise<boolean> {
    const current = workspaceStateRef.current;
    if (!current) return false;
    const workspaceId = current.id;
    const read = () => {
      if (workspaceStateRef.current?.id !== workspaceId) return undefined;
      const tab = tabsRef.current.find((tab) => tab.file === file);
      if (tab) return tab;
      const content = workspaceStateRef.current.drafts[file];
      return content === undefined ? undefined : { content, saved: "" };
    };
    if (!read()) return false;
    try {
      await settleDraft(workspaceId, file);
      await writeQueue.enqueue(workspaceId, file, () =>
        saveSnapshot({
          read,
          format:
            !automatic && settingsStore.getSnapshot().values.formatOnSave
              ? (content) =>
                  formatSource(file, content, settingsStore.getSnapshot().values.indentSize)
              : undefined,
          apply: (before, after) => {
            editorRef.current?.applySavedFormat(file, before, after);
            setTabs((tabs) =>
              tabs.map((tab) => (tab.file === file ? { ...tab, content: after } : tab)),
            );
            latestDrafts.current.set(draftKey(workspaceId, file), after);
            setWorkspace((current) =>
              current?.id === workspaceId && file in current.drafts
                ? { ...current, drafts: { ...current.drafts, [file]: after } }
                : current,
            );
            queueDraft(workspaceId, file, after);
          },
          write: (content) => window.kobrixa.workspace.write(workspaceId, file, content),
          commit: (content) => {
            if (workspaceStateRef.current?.id !== workspaceId) return;
            setTabs((tabs) =>
              tabs.map((tab) => (tab.file === file ? { ...tab, saved: content } : tab)),
            );
            removeWorkspaceDraft(file);
            // A formatting-generated draft timer must not resurrect an already saved buffer.
            if (read()?.content === content) {
              const pending = pendingDrafts.current.get(draftKey(workspaceId, file));
              if (pending) window.clearTimeout(pending.timer);
              pendingDrafts.current.delete(draftKey(workspaceId, file));
            }
          },
          retainDraft: async (content) => {
            if (content !== undefined)
              latestDrafts.current.set(draftKey(workspaceId, file), content);
            else latestDrafts.current.delete(draftKey(workspaceId, file));
            await window.kobrixa.workspace.saveDraft(workspaceId, file, content);
          },
        }),
      );
      autoSaveFailures.current.delete(draftKey(workspaceId, file));
      setStatus(t.savedStatus);
      return true;
    } catch (error) {
      if (automatic)
        autoSaveFailures.current.set(draftKey(workspaceId, file), read()?.content ?? "");
      report(error);
      return false;
    }
  }

  async function autoSaveFile(file: string): Promise<void> {
    if (
      settingsStore.getSnapshot().values.autoSave === "off" ||
      controller.editingLocked ||
      projectBusyRef.current ||
      managingEntriesRef.current ||
      modalOpen ||
      isModalOpen()
    )
      return;
    const tab = tabsRef.current.find((tab) => tab.file === file);
    if (tab && tab.content !== tab.saved) await saveTab(file, true);
  }
  function requestFocusSave(file: string): void {
    if (settingsStore.getSnapshot().values.autoSave !== "onFocusChange") return;
    if (
      controller.editingLocked ||
      projectBusyRef.current ||
      managingEntriesRef.current ||
      modalOpen ||
      isModalOpen()
    )
      focusSaves.current.add(file);
    else void autoSaveFile(file);
  }

  async function saveActive(): Promise<void> {
    if (settingsActive || controller.editingLocked) return;
    if (activeFile) await saveTab(activeFile);
  }

  async function openLocation(file: string, range: Diagnostic["range"]): Promise<boolean> {
    const current = workspaceStateRef.current;
    if (!current?.files.includes(file)) return false;
    await openFile(current, file);
    if (
      workspaceStateRef.current?.id !== current.id ||
      !tabsRef.current.some((tab) => tab.file === file)
    )
      return false;
    setFocusTarget({ file, range, requestId: ++focusRequest.current });
    return true;
  }

  async function applyWorkspaceEdit(
    snapshot: EditorAnalysis,
    apply: () => Record<string, string>,
  ): Promise<void> {
    const current = workspaceStateRef.current;
    const initialTabs = tabsRef.current;
    const revision = documents.revision;
    const editable = () =>
      current &&
      workspaceStateRef.current?.id === current.id &&
      workspaceStateRef.current.files === current.files &&
      documents.revision === revision &&
      !controller.editingLocked &&
      !projectBusyRef.current &&
      !managingEntriesRef.current;
    if (!editable() || analysisSession.getCurrent() !== snapshot)
      throw new Error("The workspace changed. Try renaming again after analysis completes.");
    const saved = Object.fromEntries(
      await Promise.all(
        Object.keys(snapshot.analysis.index.sources).map(async (file) => {
          if (!current!.files.includes(file))
            throw new Error("A source file was moved or removed.");
          const disk = await window.kobrixa.workspace.read(current!.id, file);
          const tab = initialTabs.find((tab) => tab.file === file);
          const content = tab?.content ?? current!.drafts[file] ?? disk;
          if (
            normalizeSource(content) !== normalizeSource(snapshot.analysis.index.sources[file]!) ||
            (tab && normalizeSource(disk) !== normalizeSource(tab.saved))
          )
            throw new Error(`'${file}' changed since analysis. Reopen the file before renaming.`);
          return [file, disk];
        }),
      ),
    );
    if (!editable()) throw new Error("The workspace changed while preparing the rename.");
    // The editor rechecks every model version before making the first edit.
    const changes = apply();
    setTabs((previous) => {
      const next = previous.map((tab) =>
        changes[tab.file] === undefined ? tab : { ...tab, content: changes[tab.file]! },
      );
      for (const [file, content] of Object.entries(changes))
        if (!next.some((tab) => tab.file === file))
          next.push({ file, content, saved: saved[file]! });
      return next;
    });
    setBuildDiagnostics([]);
    for (const [file, content] of Object.entries(changes)) queueDraft(current!.id, file, content);
  }

  const buildDiagnosticsRef = useRef(buildDiagnostics);
  buildDiagnosticsRef.current = buildDiagnostics;
  function updateActive(file: string): void {
    const current = workspaceStateRef.current;
    if (!current || controller.editingLocked) return;
    if (buildDiagnosticsRef.current.length) {
      buildDiagnosticsRef.current = [];
      setBuildDiagnostics([]);
    }
    queueDraft(current.id, file, documents.reader(file));
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
      await flushAllDrafts();
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
    const current = workspaceStateRef.current;
    if (!current) return;
    await flushAllDrafts();
    for (const [file] of filesToSave(workspaceStateRef.current?.drafts ?? {}, tabsRef.current)) {
      if (!(await saveTab(file)))
        throw new Error(
          locale === "zh-TW"
            ? "儲存失敗，已停止後續操作。"
            : "Saving failed; the operation was stopped.",
        );
    }
  }

  function runCommand(command: AppCommand): void {
    if (modalOpen || isModalOpen()) return;
    if (command === "settings" || command === "shortcuts") {
      if (command === "shortcuts")
        setSettingsCategory((value) => ({ category: "shortcuts", request: value.request + 1 }));
      openSettings();
      return;
    }
    if (command === "closeTab" && settingsActive) {
      closeSettings();
      return;
    }
    if (command === "nextTab" || command === "previousTab") {
      cycleTabs(command === "nextTab" ? 1 : -1);
      return;
    }
    if (command === "stop" && execution.phase === "building") {
      void controller.cancelBuild();
      return;
    }
    if (command === "files" || command === "problems" || command === "device") {
      if (command === "files") setFilesOpen((value) => !value);
      else if (command === "problems") setProblemsOpen((value) => !value);
      else setDeviceOpen((value) => !value);
      return;
    }
    if (command === "nextProblem" || command === "previousProblem") {
      if (!settingsActive) void navigateDiagnostics(command === "nextProblem" ? 1 : -1);
      return;
    }
    if (controller.editingLocked || projectBusyRef.current || managingEntriesRef.current) return;
    switch (command) {
      case "newProject":
        setProjectName("my-robot");
        setNewProjectOpen(true);
        break;
      case "openProject":
        void openProject();
        break;
      case "save":
        void saveActive();
        break;
      case "saveAll":
        void saveAllChanges().catch(report);
        break;
      case "closeTab":
        if (activeFile) requestCloseTab(activeFile);
        break;
      case "format":
        if (!settingsActive && activeFile) void editorRef.current?.format().catch(report);
        break;
      case "build":
        requestExecution(false);
        break;
      case "run":
        requestExecution(true);
        break;
      case "stop":
        if (execution.session && !controller.locked) void controller.stop();
        break;
    }
  }

  function requestExecution(run: boolean): void {
    if (
      !workspace ||
      controller.editingLocked ||
      projectBusyRef.current ||
      managingEntries ||
      modalOpen ||
      isModalOpen()
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

  function problemsMaximum(): number {
    return Math.max(
      LAYOUT_LIMITS.problemsHeight.min,
      Math.floor((centerRef.current?.clientHeight ?? 640) * 0.45),
    );
  }

  async function jumpTo(item: Diagnostic, index?: number): Promise<void> {
    if (!workspace) return;
    if (workspace.files.includes(item.file)) await openFile(workspace, item.file);
    if (index !== undefined) setDiagnosticIndex(index);
    setFocusTarget({ file: item.file, range: item.range, requestId: ++focusRequest.current });
    setProblemsOpen(true);
  }

  const settingsPage = (
    <SettingsPanel
      settings={settings}
      keyboard={keyboard}
      requestedCategory={settingsCategory}
      onChange={(key, value) => settingsStore.set(key, value)}
      onReset={settingsStore.resetLayout}
      active={settingsActive}
      saveError={saveError}
      onRetry={settingsStore.save}
    />
  );
  const settingsTab = settingsOpen && (
    <SettingsTab
      locale={locale}
      active={settingsActive}
      onSelect={openSettings}
      onClose={closeSettings}
      shortcut={keyboard.hint("closeTab")}
    />
  );
  return (
    <main className={`app-shell ${saveError && !settingsActive ? "has-settings-error" : ""}`}>
      <Toolbar
        t={t}
        locale={locale}
        shortcutHint={keyboard.hint}
        onSaveAll={() => runCommand("saveAll")}
        appearance={
          <SettingsQuickControls
            settings={settings}
            onChange={(key, value) => settingsStore.set(key, value)}
            onOpen={openSettings}
            shortcut={keyboard.hint("settings")}
          />
        }
        deviceLocked={controller.locked || managingEntries || projectBusy || modalOpen}
        name={workspace?.name}
        locked={locked || managingEntries || projectBusy || modalOpen}
        canSave={Boolean(!settingsActive && active && active.dirty)}
        state={execution}
        onNew={() => runCommand("newProject")}
        onOpen={() => runCommand("openProject")}
        onSave={() => runCommand("save")}
        onRun={() => runCommand("run")}
        onBuild={() => runCommand("build")}
        onStop={() => runCommand("stop")}
        onUpload={() => void controller.upload()}
        onRunUploaded={() => void controller.runDeployed()}
        onDelete={() => void controller.deleteDeployed()}
        onCancel={() => runCommand("stop")}
        onDevice={() => {
          setToolTab("connection");
          setDeviceOpen(true);
        }}
      />
      {saveError && !settingsActive && (
        <SettingsError locale={locale} onRetry={settingsStore.save} />
      )}
      {!workspace ? (
        settingsActive ? (
          <section className="standalone-settings">
            <div className="tabs" role="tablist" aria-label={st.title}>
              {settingsTab}
            </div>
            {settingsPage}
          </section>
        ) : (
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
        )
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
          <ResizeHandle
            className="resize-files"
            axis="x"
            direction={1}
            label={t.resizeFiles}
            min={LAYOUT_LIMITS.filesWidth.min}
            max={sidebarMaximum("files")}
            value={filesWidth}
            visible={filesOpen}
            defaultValue={LAYOUT_DEFAULTS.filesWidth}
            onChange={setFilesWidth}
          />

          <section className={`center ${settingsActive ? "settings-active" : ""}`} ref={centerRef}>
            <div className="editor-toolbar">
              <button
                aria-pressed={filesOpen}
                title={titleWithShortcut(filesOpen ? t.hideFiles : t.showFiles, "files")}
                onClick={() => runCommand("files")}
              >
                <span aria-hidden="true">☰</span>
                {t.files}
              </button>
              <div className="breadcrumb" title={active?.file}>
                {active?.file ?? workspace.name}
              </div>
              <div className="editor-tools">
                <button
                  disabled={settingsActive || !active || locked}
                  title={titleWithShortcut(t.format, "format")}
                  onClick={() => runCommand("format")}
                >
                  {t.format}
                </button>
                <button
                  className="icon-button"
                  disabled={settingsActive || !diagnostics.length}
                  aria-label={t.previousProblem}
                  title={titleWithShortcut(t.previousProblem, "previousProblem")}
                  onClick={() => runCommand("previousProblem")}
                >
                  ↑
                </button>
                <button
                  className="icon-button"
                  disabled={settingsActive || !diagnostics.length}
                  aria-label={t.nextProblem}
                  title={titleWithShortcut(t.nextProblem, "nextProblem")}
                  onClick={() => runCommand("nextProblem")}
                >
                  ↓
                </button>
                <button
                  aria-pressed={problemsOpen}
                  title={titleWithShortcut(
                    problemsOpen ? t.hideProblems : t.showProblems,
                    "problems",
                  )}
                  onClick={() => runCommand("problems")}
                >
                  {t.diagnostics}
                  {diagnostics.length > 0 && <strong>{diagnostics.length}</strong>}
                </button>
                <button
                  aria-pressed={deviceOpen}
                  title={titleWithShortcut(deviceOpen ? t.hideDevice : t.showDevice, "device")}
                  onClick={() => runCommand("device")}
                >
                  EV3
                </button>
              </div>
            </div>

            <div className="tabs" role="tablist" aria-label={t.files}>
              {tabs.map((tab) => {
                const selected = !settingsActive && tab.file === activeFile;
                const tabDirty = tab.dirty;
                return (
                  <ClosableTab
                    active={selected}
                    key={tab.file}
                    ref={selected ? activeTabRef : undefined}
                    title={tab.file}
                    onSelect={() => {
                      setSettingsActive(false);
                      setActiveFile(tab.file);
                      window.requestAnimationFrame(() => editorRef.current?.focus());
                    }}
                    closeDisabled={locked}
                    closeLabel={`${t.closeTab}: ${tab.file}`}
                    closeTitle={titleWithShortcut(t.closeTab, "closeTab")}
                    onClose={() => requestCloseTab(tab.file)}
                  >
                    <span className="tab-kind">
                      {tab.file.split(".").pop()?.toLocaleUpperCase("en-US")}
                    </span>
                    <span className="tab-name">{tab.file}</span>
                    {tabDirty && <i aria-label={t.unsaved}>●</i>}
                  </ClosableTab>
                );
              })}
              {settingsTab}
            </div>

            <div className="editor-stage" hidden={settingsActive}>
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
                  editorOptions={settings}
                  onEditorReady={keyboard.bindEditor}
                  onBlur={requestFocusSave}
                  fontSize={codeSize}
                  wordWrap={settings.wordWrap}
                  indentSize={settings.indentSize}
                  reducedMotion={reducedMotion}
                  readOnly={locked || projectBusy || managingEntries}
                  file={active.file}
                  documents={documents}
                  analysisSession={analysisSession}
                  completionSession={completionSession}
                  openFiles={openFiles}
                  diagnostics={diagnostics}
                  focusTarget={focusTarget}
                  ariaLabel={t.editorLabel}
                  onChange={updateActive}
                  onOpenLocation={openLocation}
                  onWorkspaceEdit={applyWorkspaceEdit}
                  onCursorChange={cursorStore.update}
                />
              ) : (
                <div className="empty">{t.chooseFile}</div>
              )}
            </div>

            {settingsPage}
            <ResizeHandle
              className="resize-problems"
              axis="y"
              direction={-1}
              label={t.resizeProblems}
              min={LAYOUT_LIMITS.problemsHeight.min}
              max={problemsMaximum()}
              value={problemsHeight}
              visible={problemsOpen}
              defaultValue={LAYOUT_DEFAULTS.problemsHeight}
              onChange={setProblemsHeight}
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

          <ResizeHandle
            className="resize-device"
            axis="x"
            direction={-1}
            label={t.resizeDevice}
            min={LAYOUT_LIMITS.deviceWidth.min}
            max={sidebarMaximum("device")}
            value={deviceWidth}
            visible={deviceOpen}
            defaultValue={LAYOUT_DEFAULTS.deviceWidth}
            onChange={setDeviceWidth}
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
        <Dialog
          onClose={() => {
            setNewProjectOpen(false);
          }}
          title={t.newProject}
          titleId="new-project-title"
          onSubmit={() => {
            void createProject();
          }}
        >
          <label>
            {t.projectName}
            <input
              data-modal-initial
              maxLength={80}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
            />
            <small>{t.projectNameHint}</small>
          </label>
          <DialogActions>
            <button type="button" onClick={() => setNewProjectOpen(false)}>
              {t.close}
            </button>
            <button className="primary" type="submit" disabled={!projectName.trim()}>
              {t.create}
            </button>
          </DialogActions>
        </Dialog>
      )}
      {pendingWorkspace && (
        <Dialog
          onClose={() => {
            setPendingWorkspace(undefined);
          }}
          title={t.chooseEntry}
          titleId="entry-title"
          onSubmit={() => {
            void confirmEntry();
          }}
        >
          <Picker<string>
            locale={locale}
            label={t.chooseEntry}
            searchable
            value={selectedEntry}
            onChange={setSelectedEntry}
            options={pendingWorkspace.entryCandidates.map((entry) => ({
              value: entry,
              label: entry,
            }))}
          />
          <DialogActions>
            <button type="button" onClick={() => setPendingWorkspace(undefined)}>
              {t.close}
            </button>
            <button className="primary" type="submit" disabled={!selectedEntry}>
              {t.continue}
            </button>
          </DialogActions>
        </Dialog>
      )}
      {pendingCreate && (
        <Dialog
          fallbackFocus={() => treeRef.current?.focus(pendingCreate.parent)}
          onClose={() => {
            if (!managingEntries) setPendingCreate(undefined);
          }}
          title={pendingCreate.kind === "file" ? t.createFileTitle : t.createFolderTitle}
          titleId="create-entry-title"
          onSubmit={() => {
            void confirmCreateEntry();
          }}
        >
          <p className="modal-path">
            {t.entryParent}: {pendingCreate.parent || workspace?.rootLabel}
          </p>
          <label>
            {t.entryName}
            <input
              data-modal-initial
              maxLength={255}
              value={entryName}
              onChange={(event) => setEntryName(event.target.value)}
            />
          </label>
          <DialogActions>
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
          </DialogActions>
        </Dialog>
      )}
      {pendingMove && (
        <Dialog
          fallbackFocus={() => treeRef.current?.focus(pendingMove)}
          onClose={() => {
            if (!managingEntries) setPendingMove(undefined);
          }}
          title={t.moveTitle}
          titleId="move-entry-title"
          onSubmit={() => {
            void confirmMoveEntry();
          }}
        >
          <p className="modal-path">{pendingMove}</p>
          <label>
            {t.moveDestination}
            <Picker<string>
              locale={locale}
              label={t.moveDestination}
              searchable
              value={moveDestination}
              disabled={managingEntries}
              onChange={setMoveDestination}
              options={moveDestinations.map((directory) => ({
                value: directory,
                label: directory || workspace?.rootLabel || "/",
              }))}
            />
          </label>
          <DialogActions>
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
          </DialogActions>
        </Dialog>
      )}
      {pendingTrash && (
        <Dialog
          fallbackFocus={() => treeRef.current?.focus(pendingTrash)}
          onClose={() => {
            if (!managingEntries) setPendingTrash(undefined);
          }}
          title={t.trashTitle}
          titleId="trash-entry-title"
          role="alertdialog"
          descriptionId="trash-entry-description"
        >
          <p id="trash-entry-description" className="modal-description">
            {t.trashBody(pendingTrash)}
          </p>
          {tabs.some(
            (tab) => pathContains(pendingTrash, tab.file) && tab.content !== tab.saved,
          ) && <p className="modal-warning">{t.trashDirty}</p>}
          <DialogActions>
            <button
              data-modal-initial
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
          </DialogActions>
        </Dialog>
      )}
      {pendingCloseFile && (
        <Dialog
          onClose={() => {
            if (!closingTab) setPendingCloseFile(undefined);
          }}
          title={t.unsavedTitle}
          titleId="close-tab-title"
          role="alertdialog"
          descriptionId="close-tab-description"
        >
          <p id="close-tab-description" className="modal-description">
            {t.unsavedBody(pendingCloseFile)}
          </p>
          <DialogActions className="three-actions">
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
              data-modal-initial
              className="primary"
              type="button"
              disabled={closingTab}
              onClick={() => void resolveTabClose("save")}
            >
              {t.saveAndClose}
            </button>
          </DialogActions>
        </Dialog>
      )}
      <footer>
        <div className="status-group">
          {active ? (
            <span className={active.dirty ? "dirty" : ""}>
              {active.dirty ? `● ${t.unsaved}` : `✓ ${t.saved}`}
            </span>
          ) : (
            <span>{workspace ? t.ready : "Kobrixa"}</span>
          )}
          {dirty && !active?.dirty && <span className="dirty">●</span>}
        </div>
        <span className="operation-status" role="status" title={status}>
          {locked ? t.phases[execution.phase] : checking ? t.checking : status}
        </span>
        <div className="status-group status-details">
          {active && !settingsActive && (
            <>
              <CursorPosition store={cursorStore} lineLabel={t.line} columnLabel={t.column} />
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
