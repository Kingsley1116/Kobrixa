import { SIMULATOR_ENABLED } from "../shared/features.js";
import { ProjectSessions, type ProjectSession } from "./workspace/project-sessions.js";
import { ProjectTabs } from "./workspace/project-tabs.js";
import { QuickOpen } from "./workspace/quick-open.js";
import { SearchPanel } from "./workspace/search-panel.js";
import {
  isSearchableFile,
  type WorkspaceSearchFile,
  type WorkspaceSearchMatch,
} from "../shared/workspace-search.js";
import { FileConflictDialog, LocalHistoryDialog } from "./workspace/file-review-dialog.js";
import type { LocalHistoryEntry, WorkspaceFileSnapshot } from "../shared/workspace-files.js";
import "./workspace/file-changes.css";
import { useUpdates } from "./updates/updates.js";
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
  useCallback,
  useEffect,
  useLayoutEffect,
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
  WorkspaceView,
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
import { useFilePreferences } from "./settings/file-settings.js";
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
import { motorTestActive } from "../shared/motor-test.js";
import { MotorTestController } from "./device/motor-test-controller.js";
import { MonitorController } from "./device/monitor-controller.js";
import { MonitorWorkspace } from "./device/monitor-workspace.js";
import { SensorLabController } from "./device/sensor-lab-controller.js";
import { RecordingStatus } from "./device/recording-status.js";
import { CollabStore } from "./collab/store.js";
import { applyMinimalDiff, canShareFile, CollabFileSyncManager } from "./collab/file-sync.js";
import { preserveRoom } from "./collab/preserve-room.js";
import { sharedTypes } from "./collab/types.js";
import { CollabSyncStatus } from "./collab/sync-status.js";
import { RemovedFilesDialog, type RemovedFilesPrompt } from "./collab/removed-files-dialog.js";
import { collabCopy } from "./collab/collab-copy.js";
import { canEdit } from "./collab/types.js";
import { createCollabSession } from "./collab/collab-session.js";
import { CollabWorkspace } from "./collab/collab-workspace.js";
import { chatDrafts } from "./collab/chat-drafts.js";
import { CollabStatusChip } from "./collab/status-chip.js";
import { DeviceControlBar, blockedNotice, useDeviceControl } from "./collab/device-control-bar.js";
import { Picker } from "./components/picker.js";
import { CompletionSession } from "./editor/completion-session.js";
import { AnalysisSession } from "./editor/analysis-session.js";
import { AnalysisTransport } from "./editor/analysis-transport.js";
import type { WorkspaceEditContext } from "./editor/workspace-edits.js";
import { Documents, CursorStore, type DocumentTab } from "./editor/documents.js";
import { CursorPosition } from "./editor/cursor-position.js";
import {
  SIMULATOR_SCENE_FILE,
  type SimulationScene,
  type PreparedSimulation,
} from "../shared/simulator.js";
import { createDefaultScene, validateScene } from "../simulation/scene.js";
import { SimulatorWorkspace } from "./simulator/simulator-workspace.js";
import "./simulator-integration.css";

import { copy } from "./i18n/copy.js";
type Tab = DocumentTab;
type PendingDraft = { workspaceId: string; file: string; content: () => string; timer: number };
type PendingCreate = { kind: WorkspaceEntry["kind"]; parent: string };
type FileReview = {
  workspaceId: string;
  file: string;
  snapshot: WorkspaceFileSnapshot;
  error?: string;
};
type HistoryReview = {
  workspaceId: string;
  file: string;
  entries: LocalHistoryEntry[];
  loading: boolean;
  selectedId?: string;
  selectedContent?: string;
  error?: string;
};

export function App(): React.JSX.Element {
  const [simulator, setSimulator] = useState<{
    workspaceId: string;
    projectName: string;
    scene: SimulationScene;
  }>();
  const [simulatorSceneError, setSimulatorSceneError] = useState<string>();
  const simulationPreparation = useRef(0);
  // Form edits may temporarily be incomplete; only editor/disk JSON blocks the form.
  const simulationFormDraft = useRef<{ workspaceId: string; content: string } | undefined>(
    undefined,
  );
  const updates = useUpdates();
  const filePreferences = useFilePreferences();
  const filePreferencesRef = useRef(filePreferences.value);
  filePreferencesRef.current = filePreferences.value;
  const [updatePreparing, setUpdatePreparing] = useState(false);
  const [confirmUpdate, setConfirmUpdate] = useState(false);
  const [dismissedUpdate, setDismissedUpdate] = useState<string>();
  const updatePreparingRef = useRef(false);
  const { values: settings, saveError, reducedMotion, resolvedTheme } = useSettings();
  const {
    locale,
    connectionMode,
    uiScale,
    codeSize,
    ev3Tab: toolTab,
    rightPanel,
    bottomTab,
    filesOpen,

    problemsOpen,
    filesWidth,
    deviceWidth,
    problemsHeight,
  } = settings;
  const deviceOpen = rightPanel !== null;
  const t = copy[locale];
  const st = settingsCopy[locale];
  const [settingsCategory, setSettingsCategory] = useState<{
    category: "appearance" | "shortcuts" | "updates";
    request: number;
  }>({ category: "appearance", request: 0 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsActive, setSettingsActive] = useState(false);
  const [sidebarMode, setSidebarMode] = useState<"files" | "search">("files");
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [quickOpenWorkspace, setQuickOpenWorkspace] = useState<string>();
  const setToolTab = (value: Settings["ev3Tab"]): void => settingsStore.set("ev3Tab", value);
  const toggleRightPanel = (panel: "ev3" | "collab"): void =>
    settingsStore.set("rightPanel", (previous) => (previous === panel ? null : panel));
  const setFilesOpen = (
    value: Settings["filesOpen"] | ((previous: Settings["filesOpen"]) => Settings["filesOpen"]),
  ): void => settingsStore.set("filesOpen", value);
  const setDeviceOpen = (
    value: Settings["deviceOpen"] | ((previous: Settings["deviceOpen"]) => Settings["deviceOpen"]),
  ): void =>
    settingsStore.set("rightPanel", (previous) =>
      (typeof value === "function" ? value(previous === "ev3") : value) ? "ev3" : null,
    );
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
  const [sessions] = useState(() => new ProjectSessions());
  const projects = useSyncExternalStore(sessions.subscribe, sessions.getSnapshot);
  const activeSession = sessions.active;
  const [restoring, setRestoring] = useState(true);
  const [sessionIssues, setSessionIssues] = useState<string[]>([]);
  const sessionReady = useRef(false);
  const sessionSaveTimer = useRef<number | undefined>(undefined);
  const sessionWrites = useRef<Promise<void>>(Promise.resolve());
  const [pendingCloseProject, setPendingCloseProject] = useState<string>();
  const [closingProject, setClosingProject] = useState(false);
  const closingProjectRef = useRef(false);
  const [controller] = useState(() => new ExecutionController(window.kobrixa));
  const execution = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const executionLocked =
    controller.editingLockedFor(activeSession?.workspace.id) || updatePreparing || closingProject;
  const [motorTest] = useState(() => new MotorTestController(window.kobrixa.device));
  const motorBusy = useSyncExternalStore(motorTest.subscribe, motorTest.getBusy);
  const [remoteFiles] = useState(() => new RemoteFilesController(window.kobrixa, controller));
  const [monitor] = useState(
    () =>
      new MonitorController({
        ...window.kobrixa.device,
        setInputMode: (...args) =>
          controller.withMonitor(() => window.kobrixa.device.setInputMode(...args)),
      }),
  );
  const remoteState = useSyncExternalStore(remoteFiles.subscribe, remoteFiles.getSnapshot);
  const [sensorLab] = useState(() => new SensorLabController(window.kobrixa.sensorLab));
  const [monitorView, setMonitorView] = useState<"readings" | "lab">("readings");
  const [collab] = useState(
    () =>
      new CollabStore((connection) =>
        createCollabSession(connection, {
          refreshConnection: (roomId) => window.kobrixa.collab.resumeRoom(roomId),
        }),
      ),
  );
  useEffect(() => () => collab.stop(), [collab]);
  const collabSession = useSyncExternalStore(collab.subscribe, collab.getSnapshot);
  const subscribeCollabSession = useCallback(
    (listener: () => void) => collabSession?.subscribe(listener) ?? (() => undefined),
    [collabSession],
  );
  const collabSnapshot = useSyncExternalStore(subscribeCollabSession, () =>
    collabSession?.getSnapshot(),
  );
  const collabRole = collabSnapshot?.role;
  const collabCallbacks = useRef({
    adopt: async (_summary: WorkspaceSummary) => {},
    diskWrite: (_id: string, _file: string, _snapshot: WorkspaceFileSnapshot) => {},
    treeChange: (_result: WorkspaceMutationResult) => {},
    report: (_error: unknown) => {},
  });
  const [collabFiles] = useState(
    () =>
      new CollabFileSyncManager(collab, {
        workspace: {
          ...window.kobrixa.workspace,
          write: (...args) =>
            writeQueue.enqueue(args[0], args[1], () => window.kobrixa.workspace.write(...args)),
        },
        collab: window.kobrixa.collab,
        activeWorkspaceId: () => sessions.activeId,
        summary: (id) => sessions.get(id)?.workspace,
        seedContent: (id, file) => {
          const project = sessions.get(id);
          return project?.documents.getOpenFiles().includes(file)
            ? project.documents.reader(file)()
            : project?.workspace.drafts[file];
        },
        adopt: (summary) => collabCallbacks.current.adopt(summary),
        onDiskWrite: (...args) => collabCallbacks.current.diskWrite(...args),
        onTreeChange: (result) => collabCallbacks.current.treeChange(result),
        // Revisions the editor saved itself are not outside edits.
        knownRevision: (id, file, revision) =>
          revision !== null && sessions.get(id)?.files.baseline(file)?.revision === revision,
        report: (error) => collabCallbacks.current.report(error),
      }),
  );
  useEffect(() => collabFiles.attach(), [collabFiles]);
  const [collabLeaving, setCollabLeaving] = useState(false);
  const collabLeavingRef = useRef(false);
  const collabBinding = useSyncExternalStore(collabFiles.subscribe, collabFiles.getSnapshot);
  const subscribeFileSync = useCallback(
    (listener: () => void) => collabBinding?.sync.subscribe(listener) ?? (() => {}),
    [collabBinding],
  );
  const fileSyncPhase = useSyncExternalStore(
    subscribeFileSync,
    () => collabBinding?.sync.getSnapshot().phase,
  );
  const sharedProject =
    collabBinding?.workspaceId === activeSession?.workspace.id && !!collabBinding;
  const collabReadOnly =
    sharedProject &&
    (collabLeaving ||
      collabBinding.readOnly ||
      fileSyncPhase !== "syncing" ||
      (collabRole !== undefined && !canEdit(collabRole)));
  const locked = executionLocked || collabReadOnly;
  const deviceControl = useDeviceControl(collab, window.kobrixa.collab);
  const controlNotice = blockedNotice(locale, deviceControl);
  useEffect(
    () => controller.setDeviceControlBlocked(Boolean(controlNotice)),
    [controller, controlNotice],
  );
  useEffect(() => {
    void sensorLab.initialize();
    void motorTest.initialize();
    const stopMotorActivity = motorTest.subscribe(() =>
      controller.recordMotorTest(motorTest.getSnapshot()),
    );
    return () => {
      sensorLab.dispose();
      stopMotorActivity();
      void motorTest.dispose();
      void monitor.dispose().catch(() => {});
    };
  }, [sensorLab, monitor, motorTest, controller]);
  const [deviceOverlay, setDeviceOverlay] = useState(false);
  useEffect(() => {
    remoteFiles.setSession(execution.session?.id, execution.deployed?.path);
  }, [remoteFiles, execution.session?.id, execution.deployed?.path]);
  useEffect(() => window.kobrixa.device.onEvent(remoteFiles.onEvent), [remoteFiles]);
  const setConnectionMode = (mode: Settings["connectionMode"]) =>
    settingsStore.set("connectionMode", mode);
  const connectionModeRef = useRef(connectionMode);
  connectionModeRef.current = connectionMode;
  const [projectBusy, setProjectBusy] = useState(false);
  const projectBusyRef = useRef(false);
  useEffect(() => controller.attach(), [controller]);
  const workspace = activeSession?.workspace;
  const workspaceStateRef = {
    get current() {
      return sessions.active?.workspace;
    },
  };
  const setWorkspace = (
    value:
      | WorkspaceSummary
      | undefined
      | ((previous: WorkspaceSummary | undefined) => WorkspaceSummary | undefined),
  ): void => {
    const next = typeof value === "function" ? value(workspaceStateRef.current) : value;
    if (next) {
      const session = sessions.get(next.id);
      if (session) {
        session.workspace = next;
        sessions.changed();
      }
    }
  };
  const [emptyDocuments] = useState(() => new Documents());
  const documents = activeSession?.documents ?? emptyDocuments;
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
  useEffect(() => {
    if (!simulator) return;
    const project = sessions.get(simulator.workspaceId);
    if (!project) {
      setSimulator(undefined);
      return;
    }
    const synchronize = () => {
      try {
        const source = project.documents
          .getSnapshot()
          .find((tab) => tab.file === SIMULATOR_SCENE_FILE)?.content;
        if (source === undefined) {
          // Closing/discarding the scene document also closes its live view. Reopening
          // reads the accepted disk/draft version, never a discarded scene object.
          setSimulator((current) =>
            current?.workspaceId === project.workspace.id ? undefined : current,
          );
          setSimulatorSceneError(undefined);
          return;
        }
        if (
          simulationFormDraft.current?.workspaceId === project.workspace.id &&
          simulationFormDraft.current.content === source
        ) {
          setSimulatorSceneError(undefined);
          return;
        }
        const scene = validateScene(JSON.parse(source));
        setSimulatorSceneError(undefined);
        setSimulator((current) =>
          current?.workspaceId === project.workspace.id &&
          JSON.stringify(current.scene) !== JSON.stringify(scene)
            ? { ...current, scene }
            : current,
        );
      } catch (error) {
        setSimulatorSceneError(error instanceof Error ? error.message : String(error));
      }
    };
    synchronize();
    return project.documents.onChange(synchronize);
  }, [sessions, simulator?.workspaceId, projects]);

  const [fileReview, setFileReview] = useState<FileReview>();
  const [fileReviewBusy, setFileReviewBusy] = useState(false);
  const [historyReview, setHistoryReview] = useState<HistoryReview>();
  const historyRequest = useRef(0);
  const refreshFilesRef = useRef<() => Promise<void>>(async () => {});
  const refreshingFiles = useRef(false);
  const refreshErrors = useRef(new Set<string>());
  const refreshInvalidations = useRef(new Set<string>());
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
  const [wifiAddress, setWifiAddress] = useState(() => settingsStore.getWifiAddress());
  useEffect(() => {
    setSelectedDevice(undefined);
  }, [connectionMode]);
  const [focusTarget, setFocusTarget] = useState<EditorFocusTarget>();
  const [cursorStore] = useState(() => new CursorStore());
  const [diagnosticIndex, setDiagnosticIndex] = useState(-1);
  const [checking, setChecking] = useState(false);
  const completionSession = useMemo(
    () =>
      new CompletionSession((workspaceId, request) =>
        window.kobrixa.language.completionSync(workspaceId, request),
      ),
    [documents],
  );
  useEffect(() => () => completionSession.dispose(), [completionSession]);
  const [analysisTransport] = useState(
    () =>
      new AnalysisTransport(
        (workspaceId, request) => window.kobrixa.language.sync(workspaceId, request),
        (workspaceId, request) => window.kobrixa.language.quickFixes(workspaceId, request),
        (workspaceId, requestId) => window.kobrixa.language.cancelQuickFix(workspaceId, requestId),
      ),
  );
  const analysisSession = useMemo(
    () =>
      new AnalysisSession(documents, {
        analyze: (workspaceId, overlays) => analysisTransport.analyze(workspaceId, overlays),
        cancel: () => {
          void window.kobrixa.language.cancel().catch(() => undefined);
        },
        diagnostics: (analysis) => {
          if (sessions.active?.documents === documents) setLiveDiagnostics(analysis.diagnostics);
        },
        checking: (value) => {
          if (sessions.active?.documents === documents) setChecking(value);
        },
        error: (error) => {
          if (sessions.active?.documents === documents) report(error);
        },
      }),
    [documents],
  );
  useLayoutEffect(() => {
    analysisSession.configure(workspace);
    completionSession.configure(workspace);
  }, [analysisSession, completionSession, workspace]);
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
  const focusEditorOnMount = useRef(true);
  const treeRef = useRef<ProjectTreeHandle>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef(0);
  const fileOpenRequest = useRef({ target: "", generation: 0, sequence: 0 });
  const pendingDrafts = useRef(new Map<string, PendingDraft>());
  const draftWrites = useRef(new Map<string, Promise<void>>());
  const viewRef = useRef({
    workspaceId: workspace?.id,
    activeFile,
    selectedTreePath,
    expandedTreePaths,
  });
  viewRef.current = { workspaceId: workspace?.id, activeFile, selectedTreePath, expandedTreePaths };
  const closeHandler = useRef<(id: string) => Promise<void>>(async () => {});
  closeHandler.current = async (requestId) => {
    updatePreparingRef.current = true;
    setUpdatePreparing(true);
    try {
      await restoration.current;
      await window.kobrixa.sensorLab.stop("close");
      await motorTest.drain();
      await monitor.drain();
      editorRef.current?.captureView();
      await flushDrafts();
      await flushSharedRoom();
      await persistSession();
      await window.kobrixa.workspace.finishClose(requestId, true);
    } catch (error) {
      sessionFailure(error);
      updatePreparingRef.current = false;
      setUpdatePreparing(false);
      await window.kobrixa.workspace.finishClose(requestId, false);
    }
  };
  const restoration = useRef<Promise<void> | undefined>(undefined);
  useEffect(() => {
    restoration.current ??= (async () => {
      try {
        const saved = await window.kobrixa.workspace.restoreSession();
        setSessionIssues(saved.issues);
        for (const summary of saved.workspaces)
          await initializeProject(
            summary,
            saved.projects.find((view) => view.workspaceId === summary.id),
          );
        activateProject(saved.activeWorkspaceId ?? sessions.getSnapshot()[0]?.workspace.id);
      } catch (error) {
        sessionFailure(error);
      } finally {
        sessionReady.current = true;
        setRestoring(false);
      }
    })();
    return window.kobrixa.workspace.onBeforeClose((id) => {
      void closeHandler.current(id);
    });
  }, []);
  useEffect(() => {
    captureCurrentView();
    scheduleSessionSave();
  }, [activeFile, selectedTreePath, expandedTreePaths, projects]);
  const active = tabs.find((tab) => tab.file === activeFile);
  const activeConflict = active && activeSession?.files.conflicts.get(active.file);
  const dirty = tabs.some((tab) => tab.dirty);
  const auxiliaryModalOpen = useSyncExternalStore(subscribeModals, isModalOpen);
  const modalOpen = Boolean(
    auxiliaryModalOpen ||
    newProjectOpen ||
    pendingWorkspace ||
    pendingCloseFile ||
    pendingCloseProject ||
    pendingCreate ||
    pendingMove ||
    pendingTrash ||
    fileReview ||
    historyReview ||
    (workspace && quickOpenWorkspace === workspace.id),
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
    "--files-width": workspace && filesOpen ? `${filesWidth}px` : "0px",
    "--files-divider": workspace && filesOpen ? "5px" : "0px",
    "--device-width": deviceOpen ? `${deviceWidth}px` : "0px",
    "--device-panel-width": `${deviceWidth}px`,
    "--device-divider": deviceOpen ? "5px" : "0px",
    "--problems-height": problemsOpen ? `${problemsHeight}px` : `${(40 * uiScale) / 100}px`,
    "--problems-divider": problemsOpen ? "5px" : "0px",
  } as CSSProperties;

  useEffect(() => {
    const workspaceElement = workspaceRef.current;
    const centerElement = centerRef.current ?? workspaceElement;
    if (!workspaceElement || !centerElement) return undefined;
    const fitLayout = (): void => {
      setDeviceOverlay(
        workspaceElement.clientWidth <
          (workspace && filesOpen ? filesWidth + 5 : 0) + 420 + deviceWidth + 5,
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
    const policy = settingsStore.getSnapshot().values.revealDiagnostics;
    if (
      policy !== "never" &&
      execution.diagnostics.some(
        (item) =>
          item.severity === "error" || (policy === "warnings" && item.severity === "warning"),
      )
    ) {
      setProblemsOpen(true);
    }
  }, [execution.diagnostics]);

  useEffect(() => {
    if (execution.phase === "awaitingDevice") {
      setDeviceOpen(true);
      setToolTab("connection");
    }
    if (execution.error && !execution.fileBusy) {
      if (execution.error.phase === "building" && execution.diagnostics.length) {
        if (settingsStore.getSnapshot().values.revealDiagnostics !== "never") setProblemsOpen(true);
      } else if (settingsStore.getSnapshot().values.revealDeviceErrors) {
        setProblemsOpen(true);
        settingsStore.set("bottomTab", "activity");
      }
    }
  }, [execution.phase, execution.error]);

  useEffect(() => analysisSession.attach(), [analysisSession]);

  refreshFilesRef.current = async () => {
    const preferences = filePreferencesRef.current;
    if (
      !preferences?.externalChangesEnabled ||
      refreshingFiles.current ||
      !sessionReady.current ||
      document.hidden ||
      updatePreparingRef.current ||
      closingProjectRef.current ||
      projectBusyRef.current ||
      managingEntriesRef.current
    )
      return;
    refreshingFiles.current = true;
    try {
      for (const project of sessions.getSnapshot()) {
        if (preferences !== filePreferencesRef.current) break;
        const id = project.workspace.id;
        if (controller.editingLockedFor(id)) continue;
        const generation = project.files.generation;
        try {
          const sync = collabFiles.for(id);
          if (sync) {
            await sync.checkDisk((file) => project.documents.getOpenFiles().includes(file));
            await sync.flush();
          }
          const result = await window.kobrixa.workspace.refresh(id, project.files.known());
          if (
            preferences !== filePreferencesRef.current ||
            sessions.get(id) !== project ||
            generation !== project.files.generation ||
            controller.editingLockedFor(id) ||
            managingEntriesRef.current ||
            closingProjectRef.current ||
            updatePreparingRef.current
          ) {
            // The service has observed these changes even if this reply's file snapshots
            // are stale. Preserve closed-dependency invalidation for the next refresh.
            if (result.changed && sessions.get(id) === project)
              refreshInvalidations.current.add(id);
            continue;
          }
          refreshErrors.current.delete(id);
          let changed = false;
          for (const [file, snapshot] of Object.entries(result.files)) {
            const tab = project.documents.getSnapshot().find((item) => item.file === file);
            const draft = project.workspace.drafts[file];
            const local =
              tab ??
              (draft === undefined
                ? undefined
                : {
                    content: draft,
                    saved: project.files.baseline(file)?.content ?? "",
                  });
            const action = project.files.observe(
              file,
              snapshot,
              local,
              preferences.externalChangeAutoReload,
            );
            if (action === "unchanged") continue;
            changed = true;
            if (action === "reload" && snapshot.content !== null) {
              if (tab) replaceFileText(project, file, snapshot.content, snapshot.content);
              removeWorkspaceDraft(file, id);
              void settleDraft(id, file)
                .then(() => enqueueDraftWrite(id, file, snapshot.content!))
                .catch(report);
            } else if (local) {
              queueDraft(id, file, local.content);
            }
          }
          const previous = project.workspace;
          const next = result.workspace;
          const treeChanged =
            JSON.stringify([previous.entries, previous.manifest, previous.entryCandidates]) !==
            JSON.stringify([next.entries, next.manifest, next.entryCandidates]);
          if (changed || result.changed || treeChanged || refreshInvalidations.current.has(id)) {
            refreshInvalidations.current.delete(id);
            project.workspace = {
              ...next,
              drafts: project.workspace.drafts,
              draftRevisions: project.workspace.draftRevisions ?? {},
              // A new identity also invalidates analysis for closed dependency changes.
              files: [...next.files],
            };
            sessions.changed();
            controller.clearDiagnostics(id);
            if (sessions.activeId === id) setBuildDiagnostics([]);
          }
        } catch (error) {
          if (
            preferences === filePreferencesRef.current &&
            sessions.get(id) === project &&
            !refreshErrors.current.has(id)
          ) {
            refreshErrors.current.add(id);
            report(error);
          }
        }
      }
    } finally {
      refreshingFiles.current = false;
    }
  };
  useEffect(() => {
    if (!filePreferences.value?.externalChangesEnabled) return;
    const refresh = () => {
      void refreshFilesRef.current();
    };
    refresh();
    const timer = window.setInterval(refresh, filePreferences.value.externalChangeInterval);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [
    filePreferences.value?.externalChangesEnabled,
    filePreferences.value?.externalChangeInterval,
    filePreferences.value?.externalChangeAutoReload,
  ]);

  const keyboard = useKeyboard(runCommand, modalOpen);
  const titleWithShortcut = (label: string, command: AppCommand): string =>
    [label, keyboard.hint(command)].filter(Boolean).join(" · ");

  useEffect(() => {
    const sync = () => {
      const enabled =
        settings.autoSave === "afterDelay" &&
        !updatePreparing &&
        !projectBusy &&
        !managingEntries &&
        !modalOpen;
      const wanted = new Set<string>();
      for (const project of sessions.getSnapshot()) {
        const id = project.workspace.id;
        if (!enabled || controller.editingLockedFor(id)) continue;
        for (const tab of project.documents.getSnapshot()) {
          if (!tab.dirty || project.files.conflicts.has(tab.file)) continue;
          const key = draftKey(id, tab.file);
          wanted.add(key);
          const revision = project.documents.version(tab.file);
          const scheduled = autoSaveTimers.current.get(key);
          if (scheduled?.revision === revision) continue;
          if (scheduled) window.clearTimeout(scheduled.timer);
          const failed = autoSaveFailures.current.get(key);
          if (failed !== undefined && failed === tab.content) {
            autoSaveTimers.current.delete(key);
            continue;
          }
          const timer = window.setTimeout(() => {
            autoSaveTimers.current.delete(key);
            void autoSaveFile(tab.file, id);
          }, settings.autoSaveDelay);
          autoSaveTimers.current.set(key, { revision, timer });
        }
      }
      for (const [key, scheduled] of autoSaveTimers.current) {
        if (!wanted.has(key)) {
          window.clearTimeout(scheduled.timer);
          autoSaveTimers.current.delete(key);
        }
      }
    };
    sync();
    const stops = projects.map((project) => project.documents.onChange(sync));
    return () => stops.forEach((stop) => stop());
  }, [
    projects,
    settings.autoSave,
    settings.autoSaveDelay,
    execution,
    updatePreparing,
    projectBusy,
    managingEntries,
    modalOpen,
  ]);
  useEffect(
    () => () => {
      for (const scheduled of autoSaveTimers.current.values()) window.clearTimeout(scheduled.timer);
      autoSaveTimers.current.clear();
    },
    [settings.autoSave, settings.autoSaveDelay],
  );
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
      previous.workspaceId &&
      previous.file &&
      (previous.workspaceId !== workspace?.id ||
        previous.file !== activeFile ||
        (!previous.settings && settingsActive))
    )
      requestFocusSave(previous.file, previous.workspaceId);
    if (
      !locked &&
      !projectBusy &&
      !managingEntries &&
      !modalOpen &&
      settings.autoSave === "onFocusChange"
    ) {
      for (const key of focusSaves.current) {
        const [id, file] = key.split("\0");
        if (file && id && !controller.editingLockedFor(id)) {
          focusSaves.current.delete(key);
          void autoSaveFile(file, id);
        }
      }
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
    execution,
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
          const tab = sessions
            .get(workspaceId)
            ?.documents.getSnapshot()
            .find((tab) => tab.file === file);
          const draft =
            content === undefined
              ? undefined
              : tab
                ? tab.content === tab.saved && !sessions.get(workspaceId)?.files.conflicts.has(file)
                  ? undefined
                  : tab.content
                : (latestDrafts.current.get(key) ?? content);
          return window.kobrixa.workspace.saveDraft(
            workspaceId,
            file,
            draft,
            sessions.get(workspaceId)?.files.baseline(file)?.revision,
          );
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

  async function flushDrafts(workspaceId?: string): Promise<void> {
    chatDrafts.flush();
    const pending = [...pendingDrafts.current.values()].filter(
      (item) => !workspaceId || item.workspaceId === workspaceId,
    );
    for (const item of pending) {
      window.clearTimeout(item.timer);
      pendingDrafts.current.delete(draftKey(item.workspaceId, item.file));
    }
    const pendingKeys = new Set(pending.map((item) => draftKey(item.workspaceId, item.file)));
    const retry = sessions
      .getSnapshot()
      .filter((project) => !workspaceId || project.workspace.id === workspaceId)
      .flatMap((project) =>
        project.documents
          .getSnapshot()
          .filter(
            (tab) =>
              (tab.dirty || project.files.conflicts.has(tab.file)) &&
              !pendingKeys.has(draftKey(project.workspace.id, tab.file)),
          )
          .map((tab) => enqueueDraftWrite(project.workspace.id, tab.file, tab.content)),
      );
    await Promise.all([
      ...retry,
      ...pending.map((item) => enqueueDraftWrite(item.workspaceId, item.file, item.content())),
      ...[...draftWrites.current]
        .filter(([key]) => !workspaceId || key.startsWith(`${workspaceId}\0`))
        .map(([, write]) => write),
    ]);
    await writeQueue.idle();
  }

  async function flushSharedRoom(): Promise<void> {
    const binding = collabFiles.getSnapshot();
    if (!binding) return;
    const copy = await preserveRoom(binding, flushDrafts, window.kobrixa.collab);
    if (copy)
      setStatus(
        locale === "zh-TW"
          ? `未確認同步的內容已另存副本：${copy}`
          : `Unconfirmed changes were saved separately: ${copy}`,
      );
  }

  function removeWorkspaceDraft(file: string, workspaceId = workspaceStateRef.current?.id): void {
    const project = sessions.get(workspaceId);
    if (!project || !(file in project.workspace.drafts)) return;
    const drafts = { ...project.workspace.drafts };
    const draftRevisions = { ...project.workspace.draftRevisions };
    delete drafts[file];
    delete draftRevisions[file];
    project.workspace = { ...project.workspace, drafts, draftRevisions };
    sessions.changed();
  }

  function replaceFileText(
    project: ProjectSession,
    file: string,
    content: string,
    saved?: string,
  ): void {
    const before = project.documents.getSnapshot().find((tab) => tab.file === file);
    if (!before) return;
    const oldContent = before.content;
    const oldSaved = before.saved;
    if (sessions.active === project) editorRef.current?.applySavedFormat(file, oldContent, content);
    else project.editor.format(file, oldContent, content);
    project.documents.replace(
      project.documents
        .getSnapshot()
        .map((tab) => (tab.file === file ? { file, content, saved: saved ?? oldSaved } : tab)),
    );
  }

  function beginFileReview(project: ProjectSession, file: string): void {
    const snapshot = project.files.conflicts.get(file);
    if (!snapshot) return;
    historyRequest.current++;
    setHistoryReview(undefined);
    setFileReview({ workspaceId: project.workspace.id, file, snapshot });
  }

  async function resolveFileReview(action: "reload" | "save"): Promise<void> {
    if (!fileReview || fileReviewBusy) return;
    const review = fileReview;
    const project = sessions.get(review.workspaceId);
    if (
      !project ||
      !canMutateWorkspace(review.workspaceId) ||
      controller.editingLockedFor(review.workspaceId)
    )
      return;
    setFileReviewBusy(true);
    try {
      if (action === "save") {
        if (await saveTab(review.file, false, review.workspaceId, review.snapshot))
          setFileReview(undefined);
        return;
      }
      const snapshot = await window.kobrixa.workspace.readFile(review.workspaceId, review.file);
      if (sessions.get(review.workspaceId) !== project) return;
      if (snapshot.revision !== review.snapshot.revision || snapshot.content === null) {
        project.files.reject(review.file, snapshot);
        sessions.changed();
        setFileReview({
          ...review,
          snapshot,
          error:
            locale === "zh-TW"
              ? "磁碟檔案再次變更，請檢查最新版本後再選擇。"
              : "The file changed again on disk. Review the latest version before choosing.",
        });
        return;
      }
      await settleDraft(review.workspaceId, review.file);
      await writeQueue.enqueue(review.workspaceId, review.file, async () => {
        project.files.accept(review.file, snapshot);
        replaceFileText(project, review.file, snapshot.content!, snapshot.content!);
        await window.kobrixa.workspace.saveDraft(review.workspaceId, review.file, undefined);
        latestDrafts.current.delete(draftKey(review.workspaceId, review.file));
        removeWorkspaceDraft(review.file, review.workspaceId);
      });
      sessions.changed();
      setFileReview(undefined);
    } catch (error) {
      setFileReview({ ...review, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setFileReviewBusy(false);
    }
  }

  async function openHistory(): Promise<void> {
    const project = sessions.active;
    if (!project || !activeFile) return;
    const file = activeFile,
      workspaceId = project.workspace.id;
    const request = ++historyRequest.current;
    setHistoryReview({ workspaceId, file, entries: [], loading: true });
    try {
      const entries = await window.kobrixa.workspace.history(workspaceId, file);
      if (request !== historyRequest.current || sessions.get(workspaceId) !== project) return;
      const first = entries[0];
      if (!first) {
        setHistoryReview({ workspaceId, file, entries, loading: false });
        return;
      }
      const content = await window.kobrixa.workspace.historyContent(workspaceId, file, first.id);
      if (request !== historyRequest.current || sessions.get(workspaceId) !== project) return;
      setHistoryReview({
        workspaceId,
        file,
        entries,
        loading: false,
        selectedId: first.id,
        selectedContent: content,
      });
    } catch (error) {
      if (request === historyRequest.current)
        setHistoryReview({
          workspaceId,
          file,
          entries: [],
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }

  async function selectHistory(id: string): Promise<void> {
    if (!historyReview) return;
    const review = historyReview;
    const request = ++historyRequest.current;
    setHistoryReview({
      workspaceId: review.workspaceId,
      file: review.file,
      entries: review.entries,
      selectedId: id,
      loading: true,
    });
    try {
      const content = await window.kobrixa.workspace.historyContent(
        review.workspaceId,
        review.file,
        id,
      );
      if (request === historyRequest.current)
        setHistoryReview({
          workspaceId: review.workspaceId,
          file: review.file,
          entries: review.entries,
          selectedId: id,
          selectedContent: content,
          loading: false,
        });
    } catch (error) {
      if (request === historyRequest.current)
        setHistoryReview({
          workspaceId: review.workspaceId,
          file: review.file,
          entries: review.entries,
          selectedId: id,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        });
    }
  }

  function restoreHistory(): void {
    if (!historyReview || historyReview.loading || historyReview.selectedContent === undefined)
      return;
    const project = sessions.get(historyReview.workspaceId);
    if (
      !project ||
      !canMutateWorkspace(project.workspace.id) ||
      controller.editingLockedFor(project.workspace.id)
    )
      return;
    const { file, selectedContent } = historyReview;
    try {
      publishSharedText(project.workspace.id, file, selectedContent);
    } catch (error) {
      report(error);
      return;
    }
    replaceFileText(project, file, selectedContent);
    queueDraft(project.workspace.id, file, selectedContent);
    controller.clearDiagnostics(project.workspace.id);
    historyRequest.current++;
    setHistoryReview(undefined);
    setStatus(
      locale === "zh-TW"
        ? "歷史版本已還原到編輯器，可使用復原撤銷。"
        : "Version restored to the editor. Undo is available.",
    );
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }

  function closeTab(file: string): void {
    const nextActive = activeFileAfterClose(
      tabs.map((tab) => tab.file),
      file,
      activeFile,
    );
    setTabs((current) => current.filter((tab) => tab.file !== file));
    sessions.active?.files.forget(file);
    setActiveFile(nextActive);
    if (focusTarget?.file === file) setFocusTarget(undefined);
  }

  function requestCloseTab(file: string): void {
    if (controller.editingLockedFor(workspaceStateRef.current?.id)) return;
    const tab = tabs.find((item) => item.file === file);
    if (!tab) return;
    const disposition = tabCloseDisposition(
      tab.content !== tab.saved || Boolean(sessions.active?.files.conflicts.has(file)),
    );
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

  function canMutateWorkspace(id: string | undefined): boolean {
    const sync = collabFiles.for(id);
    return (
      !sync ||
      (!collabLeavingRef.current && sync.canMutate && sync.getSnapshot().phase === "syncing")
    );
  }

  function managedEntryContext(id: string) {
    const project = sessions.get(id);
    const sync = collabFiles.for(id);
    const assertCurrent = () => {
      if (
        !project ||
        sessions.get(id) !== project ||
        sessions.activeId !== id ||
        collabFiles.for(id) !== sync ||
        !canMutateWorkspace(id) ||
        controller.editingLockedFor(id)
      )
        throw new Error(
          locale === "zh-TW"
            ? "專案或協作權限已變更，請重試。"
            : "The project or collaboration permissions changed. Try again.",
        );
    };
    assertCurrent();
    return { project: project!, sync, assertCurrent };
  }

  function sharedFileLimitError(file: string): Error {
    return new Error(
      locale === "zh-TW"
        ? `「${file}」超出協作限制：僅支援文字原始碼，每個檔案 1 MiB、共 8 MiB、最多 200 個檔案。`
        : `'${file}' exceeds collaboration limits: supported source text only, 1 MiB per file, 8 MiB total, and 200 files.`,
    );
  }

  function assertSharedFileFits(id: string, file: string, content: string): void {
    const sync = collabFiles.for(id);
    if (!sync) return;
    const files = sharedTypes(sync.session.doc).files;
    if (!canShareFile(files, file, content)) throw sharedFileLimitError(file);
  }

  function publishSharedText(id: string, file: string, content: string): void {
    const sync = collabFiles.for(id);
    if (!sync || !canMutateWorkspace(id)) return;
    assertSharedFileFits(id, file, content);
    const text = sharedTypes(sync.session.doc).files.get(file);
    if (text) sync.session.doc.transact(() => applyMinimalDiff(text, content));
  }

  const [removedPrompts, setRemovedPrompts] = useState<RemovedFilesPrompt[]>([]);
  const removedPromptId = useRef(0);

  /** Saves unsaved text of remotely deleted files into a project copy outside the room. */
  async function keepRemovedFiles(prompt: RemovedFilesPrompt): Promise<void> {
    try {
      // The copy includes drafts, so the deleted files reappear at their original paths.
      // Draft writes go through the per-file queue that `treeChange` already cleared.
      for (const { file, content } of prompt.files)
        await enqueueDraftWrite(prompt.workspaceId, file, content);
      const target = await window.kobrixa.collab.saveCopy(prompt.roomId, true);
      if (sessions.activeId === prompt.workspaceId)
        setStatus(collabCopy[locale].removedFiles.saved(target));
    } finally {
      const open = new Set(sessions.get(prompt.workspaceId)?.documents.getOpenFiles());
      for (const { file } of prompt.files)
        if (!open.has(file))
          await enqueueDraftWrite(prompt.workspaceId, file, undefined).catch(() => undefined);
    }
    setRemovedPrompts((prompts) => prompts.filter((item) => item.id !== prompt.id));
  }

  collabCallbacks.current = {
    adopt: async (summary) => {
      await flushDrafts();
      await loadWorkspace(summary);
    },
    diskWrite: (id, file, snapshot) => {
      const project = sessions.get(id);
      if (!project || snapshot.content === null) return;
      project.files.accept(file, snapshot);
      const sync = collabFiles.for(id);
      const text = sync ? sharedTypes(sync.session.doc).files.get(file)?.toString() : undefined;
      if (text !== undefined) replaceFileText(project, file, text, snapshot.content);
      const tab = project.documents.getSnapshot().find((tab) => tab.file === file);
      if (tab) {
        if (tab.content === tab.saved) removeWorkspaceDraft(file, id);
        void settleDraft(id, file)
          .then(() => enqueueDraftWrite(id, file, tab.content))
          .catch(report);
      }
      controller.clearDiagnostics(id);
      sessions.changed();
    },
    treeChange: (result) => {
      const project = sessions.get(result.workspace.id);
      if (!project) return;
      const { moved, removed } = result;
      const deleted = new Set(removed);
      // The room deleted these files; ask before dropping text that only this editor has.
      const unsaved = filesToSave(project.workspace.drafts, project.documents.getSnapshot())
        .filter(([file]) => deleted.has(file))
        .map(([file, content]) => ({ file, content }));
      const roomId = collabFiles.for(result.workspace.id)?.session.connection.roomId;
      if (unsaved.length && roomId) {
        const prompt = {
          id: ++removedPromptId.current,
          workspaceId: result.workspace.id,
          roomId,
          files: unsaved,
        };
        setRemovedPrompts((prompts) => [...prompts, prompt]);
      }
      // Drop pending draft writes of deleted files so a late write cannot restore them.
      for (const file of removed) {
        const key = draftKey(result.workspace.id, file);
        const pending = pendingDrafts.current.get(key);
        latestDrafts.current.delete(key);
        if (!pending && !draftWrites.current.has(key)) continue;
        if (pending) window.clearTimeout(pending.timer);
        pendingDrafts.current.delete(key);
        void enqueueDraftWrite(result.workspace.id, file, undefined).catch(report);
      }
      if (sessions.active === project) editorRef.current?.remapFiles(moved);
      else project.editor.remap(moved);
      project.files.remap(moved);
      for (const file of removed) project.files.forget(file);
      project.documents.replace(
        project.documents
          .getSnapshot()
          .filter((tab) => !deleted.has(tab.file))
          .map((tab) => ({ ...tab, file: moved[tab.file] ?? tab.file })),
      );
      project.workspace = result.workspace;
      const currentFile = project.view.activeFile;
      if (currentFile)
        project.view.activeFile = deleted.has(currentFile)
          ? project.documents.getOpenFiles()[0]
          : (moved[currentFile] ?? currentFile);
      if (sessions.active === project) {
        setActiveFile((file) =>
          file && !deleted.has(file) ? (moved[file] ?? file) : project.documents.getOpenFiles()[0],
        );
        setSelectedTreePath((file) => (deleted.has(file) ? "" : (moved[file] ?? file)));
        setExpandedTreePaths((paths) =>
          remapTreePaths(new Set([...paths].filter((file) => !deleted.has(file))), moved),
        );
      }
      controller.clearDiagnostics(result.workspace.id);
      sessions.changed();
    },
    report,
  };

  async function adoptWorkspace(next: WorkspaceSummary | undefined): Promise<void> {
    if (!next) return;
    await flushDrafts();
    if (next.entryCandidates.length > 1) {
      setPendingWorkspace(next);
      setSelectedEntry(next.entryCandidates[0] ?? "");
      return;
    }
    await loadWorkspace(next);
  }

  function captureCurrentView(): void {
    const project = sessions.active;
    const view = viewRef.current;
    if (!project || view.workspaceId !== project.workspace.id) return;
    project.view = {
      ...project.view,
      selectedTreePath: view.selectedTreePath,
      expandedTreePaths: [...view.expandedTreePaths],
    };
    if (view.activeFile) project.view.activeFile = view.activeFile;
    else delete project.view.activeFile;
  }

  function selectProject(id: string, focusEditor = true): void {
    if (
      restoring ||
      updatePreparingRef.current ||
      projectBusyRef.current ||
      managingEntriesRef.current ||
      closingProjectRef.current ||
      modalOpen
    )
      return;
    activateProject(id, focusEditor);
  }

  function activateProject(id: string | undefined, focusEditor = true): void {
    focusEditorOnMount.current = focusEditor;
    if (id === sessions.activeId) {
      setSettingsActive(false);
      if (focusEditor) window.requestAnimationFrame(() => editorRef.current?.focus());
      return;
    }
    editorRef.current?.captureView();
    captureCurrentView();
    sessions.activate(id);
    controller.setWorkspace(id);
    const project = sessions.active;
    setActiveFile(project?.view.activeFile);
    setSelectedTreePath(project?.view.selectedTreePath ?? "");
    setExpandedTreePaths(new Set(project?.view.expandedTreePaths ?? [""]));
    setLiveDiagnostics([]);
    setBuildDiagnostics(controller.getSnapshot().diagnostics);
    setDiagnosticIndex(-1);
    setFocusTarget(undefined);
    setChecking(false);
    setSettingsActive(false);
    setStatus(t.ready);
    cursorStore.update({ line: 1, column: 1 });
    if (focusEditor) window.requestAnimationFrame(() => editorRef.current?.focus());
    scheduleSessionSave();
  }

  async function initializeProject(
    selected: WorkspaceSummary,
    view?: WorkspaceView,
  ): Promise<ProjectSession> {
    const existing = sessions.get(selected.id);
    if (existing) return existing;
    const project = sessions.add(selected, view);
    const first =
      selected.manifest?.entry ??
      selected.files.find((file) => file.endsWith(".bp")) ??
      selected.files[0];
    const files = view ? view.files : first ? [first] : [];
    const opened: Tab[] = [];
    for (const file of [...new Set([...files, ...Object.keys(selected.drafts)])]) {
      try {
        const snapshot = await window.kobrixa.workspace.readFile(selected.id, file);
        const draft = selected.drafts[file];
        project.files.recover(file, snapshot, draft, selected.draftRevisions?.[file]);
        if (snapshot.content === null && draft === undefined) throw new Error("File is missing.");
        if (files.includes(file) || project.files.conflicts.has(file)) {
          const saved = snapshot.content ?? "";
          opened.push({ file, content: draft ?? saved, saved });
        }
      } catch {
        setSessionIssues((issues) => [
          ...issues,
          `${selected.name}: ${file} — ${locale === "zh-TW" ? "無法恢復檔案；草稿仍保留。" : "Could not restore file; its draft is retained."}`,
        ]);
      }
    }
    project.documents.replace(opened);
    const active =
      view?.activeFile && opened.some((tab) => tab.file === view.activeFile)
        ? view.activeFile
        : opened[0]?.file;
    project.view = { ...project.view, activeFile: active };
    return project;
  }

  async function loadWorkspace(selected: WorkspaceSummary): Promise<void> {
    await initializeProject(selected);
    activateProject(selected.id);
  }

  function scheduleSessionSave(): void {
    if (!sessionReady.current || closingProjectRef.current) return;
    if (sessionSaveTimer.current !== undefined) window.clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = window.setTimeout(() => {
      sessionSaveTimer.current = undefined;
      void persistSession().catch(sessionFailure);
    }, 400);
  }

  function sessionFailure(error: unknown): void {
    report(error);
    const message =
      locale === "zh-TW"
        ? "工作狀態儲存失敗，請重試。"
        : "Could not save the session. Please retry.";
    setSessionIssues((issues) => (issues.includes(message) ? issues : [...issues, message]));
  }

  async function persistSession(): Promise<void> {
    if (!sessionReady.current) return;
    if (sessionSaveTimer.current !== undefined) window.clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = undefined;
    captureCurrentView();
    const state = sessions.snapshot();
    const pending = sessionWrites.current
      .catch(() => undefined)
      .then(() => window.kobrixa.workspace.saveSession(state));
    sessionWrites.current = pending;
    await pending;
  }

  function requestCloseProject(id: string): void {
    if (
      controller.editingLockedFor(id) ||
      updatePreparingRef.current ||
      projectBusyRef.current ||
      managingEntriesRef.current ||
      modalOpen
    )
      return;
    const project = sessions.get(id);
    if (!project) return;
    if (project.dirty) setPendingCloseProject(id);
    else void closeProject(id, "save");
  }

  async function closeProject(id: string, action: "save" | "discard"): Promise<void> {
    const project = sessions.get(id);
    if (!project || controller.editingLockedFor(id)) return;
    closingProjectRef.current = true;
    setClosingProject(true);
    try {
      if (action === "save") {
        await flushDrafts(id);
        await saveProjectChanges(id);
      } else {
        for (const file of new Set([
          ...Object.keys(project.workspace.drafts),
          ...project.documents.getOpenFiles(),
        ])) {
          await settleDraft(id, file);
          await writeQueue.enqueue(id, file, () =>
            window.kobrixa.workspace.saveDraft(id, file, undefined),
          );
          latestDrafts.current.delete(draftKey(id, file));
        }
      }
      await writeQueue.idle();
      editorRef.current?.captureView();
      captureCurrentView();
      if (collabFiles.for(id)) await flushSharedRoom();
      const state = sessions.snapshot();
      const next = sessions.nextAfterClose(id);
      state.projects = state.projects.filter((item) => item.workspaceId !== id);
      if (next) state.activeWorkspaceId = next;
      else delete state.activeWorkspaceId;
      if (sessionSaveTimer.current !== undefined) window.clearTimeout(sessionSaveTimer.current);
      sessionSaveTimer.current = undefined;
      await sessionWrites.current.catch(() => undefined);
      await window.kobrixa.workspace.saveSession(state);
      const sync = collabFiles.for(id);
      if (sync) {
        await sync.stop();
        await window.kobrixa.collab.leave(sync.session.connection.roomId);
        collab.stop();
      }
      await window.kobrixa.workspace.close(id);
      if (sessions.activeId === id) activateProject(next);
      sessions.remove(id);
      for (const key of latestDrafts.current.keys())
        if (key.startsWith(`${id}\0`)) latestDrafts.current.delete(key);
      for (const key of autoSaveFailures.current.keys())
        if (key.startsWith(`${id}\0`)) autoSaveFailures.current.delete(key);
      for (const key of focusSaves.current)
        if (key.startsWith(`${id}\0`)) focusSaves.current.delete(key);
      controller.forgetWorkspace(id);
      setPendingCloseProject(undefined);
      scheduleSessionSave();
    } catch (error) {
      report(error);
    } finally {
      closingProjectRef.current = false;
      setClosingProject(false);
      scheduleSessionSave();
    }
  }

  async function createProject(): Promise<void> {
    if (updatePreparingRef.current || projectBusyRef.current || !sessionReady.current) return;
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
    if (updatePreparingRef.current || projectBusyRef.current || !sessionReady.current) return;
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
  ): Promise<boolean> {
    const target = `${current.id}\0${file}`;
    if (fileOpenRequest.current.target !== target) {
      fileOpenRequest.current.target = target;
      fileOpenRequest.current.generation += 1;
    }
    const generation = fileOpenRequest.current.generation;
    const request = ++fileOpenRequest.current.sequence;
    setSettingsActive(false);
    const existing = !replaceTabs && tabsRef.current.find((tab) => tab.file === file);
    if (existing) {
      setActiveFile(file);
      return true;
    }
    try {
      const snapshot = await window.kobrixa.workspace.readFile(current.id, file);
      if (
        workspaceStateRef.current?.id !== current.id ||
        generation !== fileOpenRequest.current.generation
      )
        return false;
      // Another navigation may have opened (and edited) this file while the read waited.
      // Its baseline belongs to that buffer; a later refresh will reconcile this read.
      if (!replaceTabs && tabsRef.current.some((tab) => tab.file === file)) {
        setActiveFile(file);
        return request === fileOpenRequest.current.sequence;
      }
      const draft = workspaceStateRef.current.drafts[file];
      if (snapshot.content === null && draft === undefined)
        throw new Error(locale === "zh-TW" ? "檔案已不存在。" : "The file no longer exists.");
      const saved = snapshot.content ?? "";
      const content = draft ?? saved;
      sessions
        .get(current.id)
        ?.files.recover(file, snapshot, draft, workspaceStateRef.current.draftRevisions?.[file]);
      setTabs((value) =>
        replaceTabs
          ? [{ file, content, saved }]
          : value.some((tab) => tab.file === file)
            ? value
            : [...value, { file, content, saved }],
      );
      setActiveFile(file);
      return request === fileOpenRequest.current.sequence;
    } catch (error) {
      report(error);
      return false;
    }
  }

  async function saveTab(
    file: string,
    automatic = false,
    workspaceId = workspaceStateRef.current?.id,
    reviewed?: WorkspaceFileSnapshot,
  ): Promise<boolean> {
    const project = sessions.get(workspaceId);
    if (!project || !workspaceId || !canMutateWorkspace(workspaceId)) return false;
    const sharedSync = collabFiles.for(workspaceId);
    const canWrite = () =>
      sessions.get(workspaceId) === project &&
      collabFiles.for(workspaceId) === sharedSync &&
      canMutateWorkspace(workspaceId);
    const projectTabs = () => project.documents.getSnapshot();
    const replaceTabs = (change: (tabs: Tab[]) => Tab[]) =>
      project.documents.replace(change(projectTabs()));
    const read = () => {
      if (sessions.get(workspaceId) !== project) return undefined;
      const tab = projectTabs().find((tab) => tab.file === file);
      if (tab) return tab;
      const content = project.workspace.drafts[file];
      return content === undefined ? undefined : { content, saved: "" };
    };
    if (!read()) return false;
    if (project.files.conflicts.has(file) && !reviewed) {
      if (!automatic) beginFileReview(project, file);
      return false;
    }
    let warning: string | undefined;
    try {
      await collabFiles.for(workspaceId)?.flush();
      await settleDraft(workspaceId, file);
      if (!project.files.baseline(file)) {
        const snapshot = await window.kobrixa.workspace.readFile(workspaceId, file);
        project.files.recover(
          file,
          snapshot,
          read()?.content,
          project.workspace.draftRevisions?.[file],
        );
        if (project.files.conflicts.has(file) && !reviewed) {
          if (!automatic) beginFileReview(project, file);
          return false;
        }
      }
      await writeQueue.enqueue(workspaceId, file, () =>
        saveSnapshot({
          read,
          format:
            !automatic && settingsStore.getSnapshot().values.formatOnSave
              ? (content) =>
                  formatSource(file, content, settingsStore.getSnapshot().values.indentSize)
              : undefined,
          apply: (before, after) => {
            if (!canWrite()) throw new Error("This shared project is read-only.");
            publishSharedText(workspaceId, file, after);
            if (sessions.activeId === workspaceId)
              editorRef.current?.applySavedFormat(file, before, after);
            else project.editor.format(file, before, after);
            replaceTabs((tabs) =>
              tabs.map((tab) => (tab.file === file ? { ...tab, content: after } : tab)),
            );
            latestDrafts.current.set(draftKey(workspaceId, file), after);
            if (file in project.workspace.drafts)
              project.workspace = {
                ...project.workspace,
                drafts: { ...project.workspace.drafts, [file]: after },
              };
            queueDraft(workspaceId, file, after);
          },
          write: async (content) => {
            if (!canWrite()) throw new Error("This shared project is read-only.");
            if (project.files.conflicts.has(file) && !reviewed) {
              if (!automatic) beginFileReview(project, file);
              throw new Error("Review external changes before saving.");
            }
            // The exact version shown in the comparison is the only version approved.
            const baseline = reviewed ?? project.files.baseline(file);
            if (!baseline) throw new Error("Missing file baseline.");
            assertSharedFileFits(workspaceId, file, content);
            const result = await window.kobrixa.workspace.write(
              workspaceId,
              file,
              content,
              baseline.revision,
            );
            if (result.status === "conflict") {
              project.files.reject(file, result.snapshot);
              sessions.changed();
              if (!automatic)
                setFileReview({
                  workspaceId,
                  file,
                  snapshot: result.snapshot,
                  ...(reviewed
                    ? {
                        error:
                          locale === "zh-TW"
                            ? "磁碟檔案再次變更，請檢查最新版本後再選擇。"
                            : "The file changed again on disk. Review the latest version before choosing.",
                      }
                    : {}),
                });
              throw new Error(
                locale === "zh-TW"
                  ? "檔案在外部已變更，本機修改已保留。"
                  : "The file changed externally. Your edits have been kept.",
              );
            }
            if (sharedSync && !sharedTypes(sharedSync.session.doc).files.has(file)) {
              // The first binding must include typing that arrived while the save
              // was in flight; only `content` below is marked as saved on disk.
              const sharedContent = read()?.content ?? content;
              assertSharedFileFits(workspaceId, file, sharedContent);
              if (!canWrite() || !sharedSync.recordCreate(file, "file", sharedContent))
                throw new Error(
                  "The file was saved locally, but collaboration permissions or limits changed.",
                );
            }
            warning = result.warning;
            project.files.accept(file, result.snapshot);
          },
          commit: (content) => {
            replaceTabs((tabs) =>
              tabs.map((tab) => (tab.file === file ? { ...tab, saved: content } : tab)),
            );
            removeWorkspaceDraft(file, workspaceId);
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
            await window.kobrixa.workspace.saveDraft(
              workspaceId,
              file,
              content,
              project.files.baseline(file)?.revision,
            );
          },
        }),
      );
      autoSaveFailures.current.delete(draftKey(workspaceId, file));
      sessions.changed();
      if (sessions.activeId === workspaceId) setStatus(warning ?? t.savedStatus);
      return true;
    } catch (error) {
      if (automatic)
        autoSaveFailures.current.set(draftKey(workspaceId, file), read()?.content ?? "");
      if (!project.files.conflicts.has(file)) report(error);
      else if (sessions.activeId === workspaceId)
        setStatus(
          locale === "zh-TW"
            ? "檔案在外部已變更，請先比較變更。"
            : "The file changed externally. Compare changes before saving.",
        );
      return false;
    }
  }

  async function autoSaveFile(file: string, id = workspaceStateRef.current?.id): Promise<void> {
    if (
      !id ||
      settingsStore.getSnapshot().values.autoSave === "off" ||
      controller.editingLockedFor(id) ||
      updatePreparingRef.current ||
      closingProjectRef.current ||
      projectBusyRef.current ||
      managingEntriesRef.current ||
      modalOpen ||
      isModalOpen()
    )
      return;
    if (sessions.get(id)?.files.conflicts.has(file)) return;
    const tab = sessions
      .get(id)
      ?.documents.getSnapshot()
      .find((tab) => tab.file === file);
    if (tab?.dirty) await saveTab(file, true, id);
  }
  function requestFocusSave(file: string, id = workspaceStateRef.current?.id): void {
    if (!id || settingsStore.getSnapshot().values.autoSave !== "onFocusChange") return;
    if (
      controller.editingLockedFor(id) ||
      projectBusyRef.current ||
      managingEntriesRef.current ||
      modalOpen ||
      isModalOpen()
    )
      focusSaves.current.add(draftKey(id, file));
    else void autoSaveFile(file, id);
  }

  async function saveActive(): Promise<void> {
    if (settingsActive || controller.editingLockedFor(workspaceStateRef.current?.id)) return;
    if (activeFile) await saveTab(activeFile);
  }

  async function openLocation(file: string, range: Diagnostic["range"]): Promise<boolean> {
    const current = workspaceStateRef.current;
    if (!current?.files.includes(file)) return false;
    if (!(await openFile(current, file))) return false;
    if (
      workspaceStateRef.current?.id !== current.id ||
      !tabsRef.current.some((tab) => tab.file === file)
    )
      return false;
    setFocusTarget({ file, range, requestId: ++focusRequest.current });
    return true;
  }

  async function openQuickFile(
    file: string,
    position?: { line: number; column: number },
  ): Promise<void> {
    const current = workspaceStateRef.current;
    if (!current) return;
    if (!position) setFocusTarget(undefined);
    if (!(await openFile(current, file))) return;
    if (workspaceStateRef.current?.id !== current.id || !documents.getOpenFiles().includes(file))
      return;
    if (position)
      setFocusTarget({
        file,
        range: {
          startLine: position.line,
          startColumn: position.column,
          endLine: position.line,
          endColumn: position.column,
        },
        requestId: ++focusRequest.current,
      });
    window.requestAnimationFrame(() => editorRef.current?.focus());
  }

  async function openSearchResult(
    file: WorkspaceSearchFile,
    match: WorkspaceSearchMatch,
  ): Promise<boolean> {
    const current = workspaceStateRef.current;
    if (!current) return false;
    if (!(await openFile(current, file.path))) return false;
    if (workspaceStateRef.current?.id !== current.id) return false;
    const tab = documents.getSnapshot().find((tab) => tab.file === file.path);
    // Navigation must not select an obsolete range after an external edit.
    if (!tab || tab.content !== file.content) return false;
    const bom = file.content.startsWith("\uFEFF") ? 1 : 0;
    setFocusTarget({
      file: file.path,
      requestId: ++focusRequest.current,
      range: {
        startLine: match.startLine,
        startColumn: Math.max(1, match.startColumn - (match.startLine === 1 ? bom : 0)),
        endLine: match.endLine,
        endColumn: Math.max(1, match.endColumn - (match.endLine === 1 ? bom : 0)),
      },
    });
    window.requestAnimationFrame(() => editorRef.current?.focus());
    return true;
  }

  async function replaceSearchResults(
    files: WorkspaceSearchFile[],
    replacement: string,
  ): Promise<void> {
    const project = sessions.active;
    if (!project || !files.length) return;
    const current = project.workspace;
    const changed = () =>
      new Error(
        locale === "zh-TW"
          ? "檔案或專案在預覽後已變更，請關閉預覽並重新搜尋。"
          : "A file or project changed since the preview. Close it and search again.",
      );
    const editable = () =>
      sessions.active === project &&
      canMutateWorkspace(current.id) &&
      !controller.editingLockedFor(current.id) &&
      !updatePreparingRef.current &&
      !closingProjectRef.current &&
      !projectBusyRef.current &&
      !managingEntriesRef.current;
    if (!editable()) throw changed();
    // Closing every editor tab should not make a project-wide replacement unavailable.
    if (!editorRef.current) {
      await openFile(current, files[0]!.path);
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
    const revision = documents.revision;
    const fileGeneration = project.files.generation;
    const snapshots = new Map<string, WorkspaceFileSnapshot>();
    for (const file of files) {
      if (!editable() || documents.revision !== revision || !isSearchableFile(file.path))
        throw changed();
      const snapshot = await window.kobrixa.workspace.readFile(current.id, file.path);
      const tab = documents.getSnapshot().find((tab) => tab.file === file.path);
      const draft = project.workspace.drafts[file.path];
      const baseline = project.files.baseline(file.path);
      if (
        snapshot.content === null ||
        snapshot.revision !== file.revision ||
        project.files.conflicts.has(file.path) ||
        (baseline && baseline.revision !== snapshot.revision) ||
        (!tab &&
          draft !== undefined &&
          project.workspace.draftRevisions?.[file.path] !== snapshot.revision) ||
        (tab?.content ?? draft ?? snapshot.content) !== file.content
      )
        throw changed();
      snapshots.set(file.path, snapshot);
    }
    if (
      !editable() ||
      documents.revision !== revision ||
      project.files.generation !== fileGeneration ||
      !editorRef.current
    )
      throw changed();
    // No await between the last validation and the first edit. The editor validates
    // every model before applying separate undo stops to each affected file.
    const changes = editorRef.current.replaceMatches(files, replacement);
    for (const [file, snapshot] of snapshots) project.files.accept(file, snapshot);
    setTabs((previous) => {
      const next = previous.map((tab) =>
        changes[tab.file] === undefined ? tab : { ...tab, content: changes[tab.file]! },
      );
      for (const [file, content] of Object.entries(changes))
        if (!next.some((tab) => tab.file === file))
          next.push({ file, content, saved: snapshots.get(file)!.content! });
      return next;
    });
    setBuildDiagnostics([]);
    controller.clearDiagnostics(current.id);
    for (const [file, content] of Object.entries(changes)) {
      publishSharedText(current.id, file, content);
      queueDraft(current.id, file, content);
    }
  }

  async function applyWorkspaceEdit(
    snapshot: EditorAnalysis,
    apply: () => Record<string, string>,
    context?: WorkspaceEditContext,
  ): Promise<void> {
    const current = workspaceStateRef.current;
    const initialTabs = tabsRef.current;
    const revision = documents.revision;
    const editable = () =>
      current &&
      workspaceStateRef.current?.id === current.id &&
      workspaceStateRef.current.files === current.files &&
      documents.revision === revision &&
      canMutateWorkspace(current.id) &&
      !controller.editingLockedFor(workspaceStateRef.current?.id) &&
      !updatePreparingRef.current &&
      !projectBusyRef.current &&
      !managingEntriesRef.current;
    if (!editable() || analysisSession.getCurrent() !== snapshot)
      throw new Error(
        locale === "zh-TW"
          ? "工作區已變更，請等分析完成後重試。"
          : "The workspace changed. Try again after analysis completes.",
      );
    const saved = Object.fromEntries(
      await Promise.all(
        (context?.kind === "quick-fix"
          ? context.files!
          : Object.keys(snapshot.analysis.index.sources)
        ).map(async (file) => {
          if (!current!.files.includes(file))
            throw new Error("A source file was moved or removed.");
          const diskSnapshot = await window.kobrixa.workspace.readFile(current!.id, file);
          if (diskSnapshot.content === null) throw new Error(`'${file}' no longer exists.`);
          const disk = diskSnapshot.content;
          const tab = initialTabs.find((tab) => tab.file === file);
          const content = tab?.content ?? current!.drafts[file] ?? disk;
          if (
            normalizeSource(content) !== normalizeSource(snapshot.analysis.index.sources[file]!) ||
            (tab && normalizeSource(disk) !== normalizeSource(tab.saved))
          )
            throw new Error(
              locale === "zh-TW"
                ? `「${file}」已變更，請先比較外部變更再重試。`
                : `'${file}' changed since analysis. Review external changes before editing.`,
            );
          if (sessions.active?.files.conflicts.has(file))
            throw new Error(`'${file}' has unresolved external changes.`);
          sessions.get(current!.id)?.files.accept(file, diskSnapshot);
          return [file, disk];
        }),
      ),
    );
    if (!editable())
      throw new Error(
        locale === "zh-TW"
          ? "工作區已變更，請重試。"
          : "The workspace changed while preparing the edit.",
      );
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
    controller.clearDiagnostics(current!.id);
    for (const [file, content] of Object.entries(changes)) {
      publishSharedText(current!.id, file, content);
      queueDraft(current!.id, file, content);
    }
  }

  const buildDiagnosticsRef = useRef(buildDiagnostics);
  buildDiagnosticsRef.current = buildDiagnostics;
  function updateActive(file: string, workspaceId: string): void {
    const project = sessions.get(workspaceId);
    if (!project || controller.editingLockedFor(workspaceId)) return;
    if (sessions.activeId === workspaceId && buildDiagnosticsRef.current.length) {
      buildDiagnosticsRef.current = [];
      setBuildDiagnostics([]);
    }
    controller.clearDiagnostics(workspaceId);
    queueDraft(workspaceId, file, project.documents.reader(file));
  }

  function beginCreateEntry(kind: WorkspaceEntry["kind"], parent: string): void {
    if (collabReadOnly || controller.editingLockedFor(workspaceStateRef.current?.id)) return;
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
    sessions.get(result.workspace.id)?.files.remap(moved);
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
    if (!workspace || collabReadOnly || controller.editingLockedFor(workspaceStateRef.current?.id))
      return false;
    if (buildEntryMovesWith(source) && manifestHasUnsavedChanges()) {
      setStatus(t.manifestDirty);
      return false;
    }
    setManagingEntries(true);
    setStatus(t.managingFiles);
    try {
      const context = managedEntryContext(workspace.id);
      await flushDrafts(workspace.id);
      context.assertCurrent();
      const result = await window.kobrixa.workspace.moveEntry(workspace.id, source, target);
      const manifestSnapshot =
        buildEntryMovesWith(source) && !workspace.implicit
          ? await window.kobrixa.workspace
              .readFile(workspace.id, "kobrixa.json")
              .catch(() => undefined)
          : undefined;
      if (manifestSnapshot)
        sessions.get(workspace.id)?.files.accept("kobrixa.json", manifestSnapshot);
      if (collabFiles.for(workspace.id) === context.sync) context.sync?.recordMove(result);
      if (sessions.get(workspace.id) !== context.project) return false;
      if (sessions.activeId !== workspace.id) {
        collabCallbacks.current.treeChange(result);
        if (manifestSnapshot?.content !== null && manifestSnapshot)
          replaceFileText(
            context.project,
            "kobrixa.json",
            manifestSnapshot.content,
            manifestSnapshot.content,
          );
        return false;
      }
      applyMoveMutation(result, manifestSnapshot?.content ?? undefined);
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
    if (!workspace || !pendingCreate || collabReadOnly) return;
    const name = entryName.trim();
    if (!name) return;
    setManagingEntries(true);
    setStatus(t.managingFiles);
    try {
      const context = managedEntryContext(workspace.id);
      const createdPath = pendingCreate.parent ? `${pendingCreate.parent}/${name}` : name;
      await flushDrafts(workspace.id);
      context.assertCurrent();
      if (pendingCreate.kind === "file") assertSharedFileFits(workspace.id, createdPath, "");
      const result = await window.kobrixa.workspace.createEntry(
        workspace.id,
        pendingCreate.parent,
        pendingCreate.kind,
        name,
      );
      const created =
        pendingCreate.kind === "file"
          ? await window.kobrixa.workspace.readFile(workspace.id, createdPath)
          : undefined;
      if (collabFiles.for(workspace.id) === context.sync)
        context.sync?.recordCreate(createdPath, pendingCreate.kind, created?.content ?? "");
      if (sessions.get(workspace.id) !== context.project) return;
      context.project.workspace = result.workspace;
      sessions.changed();
      if (sessions.activeId !== workspace.id) return;
      setSelectedTreePath(createdPath);
      setExpandedTreePaths((current) => {
        const next = expandAncestors(current, createdPath);
        if (pendingCreate.kind === "directory") next.add(createdPath);
        return next;
      });
      if (pendingCreate.kind === "file") await openFile(result.workspace, createdPath);
      if (sessions.activeId !== workspace.id || sessions.get(workspace.id) !== context.project)
        return;
      setPendingCreate(undefined);
      setStatus(t.ready);
      window.requestAnimationFrame(() => {
        if (sessions.activeId !== workspace.id) return;
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
    const id = workspace?.id;
    const target = moveDestination
      ? `${moveDestination}/${pathName(pendingMove)}`
      : pathName(pendingMove);
    if ((await moveManagedEntry(pendingMove, target)) && sessions.activeId === id) {
      setPendingMove(undefined);
      window.requestAnimationFrame(() => {
        if (sessions.activeId === id) treeRef.current?.focus(target);
      });
    }
  }

  async function confirmTrashEntry(): Promise<void> {
    if (!workspace || !pendingTrash || collabReadOnly) return;
    setManagingEntries(true);
    setStatus(t.managingFiles);
    try {
      const context = managedEntryContext(workspace.id);
      await flushDrafts(workspace.id);
      context.assertCurrent();
      const result = await window.kobrixa.workspace.trashEntry(workspace.id, pendingTrash);
      if (collabFiles.for(workspace.id) === context.sync) context.sync?.recordTrash(result.removed);
      if (sessions.get(workspace.id) !== context.project) return;
      if (sessions.activeId !== workspace.id) {
        collabCallbacks.current.treeChange(result);
        return;
      }
      const removed = new Set(result.removed);
      for (const file of removed) sessions.get(workspace.id)?.files.forget(file);
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
      window.requestAnimationFrame(() => {
        if (sessions.activeId === workspace.id) treeRef.current?.focus(focusPath);
      });
    } catch (error) {
      report(error);
    } finally {
      setManagingEntries(false);
    }
  }

  async function saveProjectChanges(id: string, automatic = false): Promise<void> {
    await collabFiles.for(id)?.flush();
    if (!canMutateWorkspace(id)) return;
    const project = sessions.get(id);
    if (!project) return;
    for (const file of new Set([
      ...filesToSave(project.workspace.drafts, project.documents.getSnapshot()).map(
        ([file]) => file,
      ),
      ...project.files.conflicts.keys(),
    ])) {
      if (!(await saveTab(file, automatic, id)))
        throw new Error(
          locale === "zh-TW"
            ? "儲存失敗，已停止後續操作。"
            : "Saving failed; the operation was stopped.",
        );
    }
  }
  async function saveAllChanges(): Promise<void> {
    await flushDrafts();
    for (const project of sessions.getSnapshot())
      await saveProjectChanges(
        project.workspace.id,
        controller.editingLockedFor(project.workspace.id),
      );
  }

  const updateBusy =
    controller.locked || managingEntries || projectBusy || remoteState.busy || updatePreparing;
  function requestUpdate(): void {
    if (updateBusy) return;
    if (sessions.getSnapshot().some((project) => project.dirty)) setConfirmUpdate(true);
    else void installUpdate();
  }
  async function installUpdate(): Promise<void> {
    if (
      updatePreparingRef.current ||
      controller.locked ||
      managingEntries ||
      projectBusy ||
      remoteState.busy
    )
      return;
    updatePreparingRef.current = true;
    setUpdatePreparing(true);
    setConfirmUpdate(false);
    try {
      await window.kobrixa.sensorLab.stop("update");
      await motorTest.drain();
      await monitor.drain();
      await flushSharedRoom();
      await window.kobrixa.updates.prepareInstall();
      await saveAllChanges();
      await flushDrafts();
      await persistSession();
      if (sessions.getSnapshot().some((project) => project.dirty))
        throw new Error(
          locale === "zh-TW"
            ? "內容仍有未儲存的變更，更新已取消。"
            : "Unsaved changes remain; the update was cancelled.",
        );
      await window.kobrixa.updates.install();
    } catch (error) {
      await window.kobrixa.updates.cancelInstall().catch(() => undefined);
      report(error);
      updatePreparingRef.current = false;
      setUpdatePreparing(false);
    }
  }
  useEffect(() => {
    if (updates?.phase === "error") {
      updatePreparingRef.current = false;
      setUpdatePreparing(false);
    }
  }, [updates?.phase]);

  function runCommand(command: AppCommand): void {
    if (
      command === "stop" &&
      (motorTestActive(motorTest.getSnapshot()) || motorTest.getSnapshot().phase === "unconfirmed")
    ) {
      void motorTest.stop();
      return;
    }
    if (updatePreparingRef.current || closingProjectRef.current) return;
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
    if (command === "collab") {
      toggleRightPanel("collab");
      return;
    }
    if (command === "files" || command === "problems" || command === "device") {
      if (command === "files") setFilesOpen((value) => !value);
      else if (command === "problems") setProblemsOpen((value) => !value);
      else setDeviceOpen((value) => !value);
      return;
    }
    if (command === "quickOpen" || command === "search") {
      if (!workspace || projectBusyRef.current || managingEntriesRef.current) return;
      setSettingsActive(false);
      if (command === "quickOpen") setQuickOpenWorkspace(workspace.id);
      else {
        setFilesOpen(true);
        setSidebarMode("search");
        setSearchFocusRequest((value) => value + 1);
      }
      return;
    }
    if (command === "nextProblem" || command === "previousProblem") {
      if (!settingsActive) void navigateDiagnostics(command === "nextProblem" ? 1 : -1);
      return;
    }
    if (projectBusyRef.current || managingEntriesRef.current || !sessionReady.current) return;
    if (command === "newProject") {
      setProjectName("my-robot");
      setNewProjectOpen(true);
      return;
    }
    if (command === "openProject") {
      void openProject();
      return;
    }
    if (controller.editingLockedFor(workspaceStateRef.current?.id)) return;
    if (!canMutateWorkspace(workspaceStateRef.current?.id) && ["save", "format"].includes(command))
      return;
    switch (command) {
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
      case "preview":
        if (SIMULATOR_ENABLED) void requestPreview();
        break;
      case "run":
        if (!controller.deviceControlBlocked) requestExecution(true);
        break;
      case "stop":
        if (execution.session && !controller.locked) void controller.stop();
        break;
    }
  }

  function requestExecution(run: boolean): void {
    if (run && motorTestActive(motorTest.getSnapshot())) return;
    if (
      !workspace ||
      controller.locked ||
      projectBusyRef.current ||
      managingEntries ||
      modalOpen ||
      isModalOpen()
    )
      return;
    const id = workspace.id;
    const request = { workspaceId: id, saveAll: () => saveProjectChanges(id) };
    if (run) void controller.run(request);
    else void controller.build(request);
  }

  async function requestPreview(): Promise<void> {
    if (
      !workspace ||
      controller.locked ||
      projectBusyRef.current ||
      managingEntries ||
      updatePreparing ||
      modalOpen ||
      isModalOpen()
    )
      return;
    const { id, name } = workspace;
    if (simulator?.workspaceId === id) {
      setSettingsActive(false);
      return;
    }
    try {
      const project = sessions.get(id)!;
      const snapshot = await window.kobrixa.workspace.readFile(id, SIMULATOR_SCENE_FILE);
      if (sessions.activeId !== id || sessions.get(id) !== project) return;
      const existing = project.documents
        .getSnapshot()
        .find((tab) => tab.file === SIMULATOR_SCENE_FILE);
      const draft = project.workspace.drafts[SIMULATOR_SCENE_FILE];
      const entry =
        (activeFile && /\.bp$/i.test(activeFile) ? activeFile : undefined) ??
        project.workspace.manifest?.entry ??
        project.workspace.entryCandidates[0] ??
        "src/main.bp";
      const content =
        existing?.content ??
        draft ??
        snapshot.content ??
        JSON.stringify(createDefaultScene(entry), null, 2) + "\n";
      const scene = validateScene(JSON.parse(content));
      if (!existing) {
        project.files.recover(
          SIMULATOR_SCENE_FILE,
          snapshot,
          draft,
          project.workspace.draftRevisions?.[SIMULATOR_SCENE_FILE],
        );
        project.documents.replace([
          ...project.documents.getSnapshot(),
          { file: SIMULATOR_SCENE_FILE, content, saved: snapshot.content ?? "" },
        ]);
        if (content !== snapshot.content) queueDraft(id, SIMULATOR_SCENE_FILE, content);
      }
      simulationFormDraft.current = undefined;
      setSimulatorSceneError(undefined);
      setSimulator({ workspaceId: id, projectName: name, scene });
      setSettingsActive(false);
      setProblemsOpen(false);
    } catch (error) {
      report(error);
    }
  }

  function changeSimulatorScene(scene: SimulationScene): void {
    if (!simulator) return;
    const project = sessions.get(simulator.workspaceId);
    if (!project || !canMutateWorkspace(simulator.workspaceId)) return;
    const content = JSON.stringify(scene, null, 2) + "\n";
    try {
      publishSharedText(simulator.workspaceId, SIMULATOR_SCENE_FILE, content);
    } catch (error) {
      report(error);
      return;
    }
    simulationFormDraft.current = { workspaceId: simulator.workspaceId, content };
    const existing = project.documents
      .getSnapshot()
      .find((tab) => tab.file === SIMULATOR_SCENE_FILE);
    if (existing) replaceFileText(project, SIMULATOR_SCENE_FILE, content);
    else
      project.documents.replace([
        ...project.documents.getSnapshot(),
        {
          file: SIMULATOR_SCENE_FILE,
          content,
          saved: project.files.baseline(SIMULATOR_SCENE_FILE)?.content ?? "",
        },
      ]);
    queueDraft(project.workspace.id, SIMULATOR_SCENE_FILE, content);
    setSimulator((current) =>
      current?.workspaceId === project.workspace.id ? { ...current, scene } : current,
    );
    setSimulatorSceneError(undefined);
  }

  async function saveSimulatorScene(scene: SimulationScene): Promise<void> {
    changeSimulatorScene(scene);
    if (!simulator || !(await saveTab(SIMULATOR_SCENE_FILE, false, simulator.workspaceId)))
      throw new Error(
        locale === "zh-TW"
          ? "場景儲存失敗；請檢查檔案衝突。"
          : "Scene was not saved. Check file conflicts.",
      );
  }

  function cancelSimulationPreparation(): void {
    simulationPreparation.current += 1;
    if (simulator) void window.kobrixa.simulator.cancel(simulator.workspaceId).catch(report);
  }

  async function prepareSimulator(scene: SimulationScene): Promise<PreparedSimulation> {
    if (!simulator) throw new Error("Simulator is closed.");
    const id = simulator.workspaceId;
    const generation = ++simulationPreparation.current;
    const project = sessions.get(id);
    if (!project || sessions.activeId !== id) throw new Error("Simulation project is not active.");
    const sceneSource = project.documents
      .getSnapshot()
      .find((tab) => tab.file === SIMULATOR_SCENE_FILE)?.content;
    if (sceneSource !== undefined) validateScene(JSON.parse(sceneSource));
    validateScene(scene);
    await saveProjectChanges(id);
    if (
      generation !== simulationPreparation.current ||
      sessions.get(id) !== project ||
      sessions.activeId !== id
    )
      throw new Error("Simulation preparation was cancelled.");
    const entries = scene.robots.flatMap((robot) =>
      robot.controller.kind === "program" ? [robot.controller.entry] : [],
    );
    const overlays = Object.fromEntries(
      project.documents.getSnapshot().map((tab) => [tab.file, tab.content]),
    );
    const result = await window.kobrixa.simulator.prepare(id, overlays, entries);
    if (
      generation !== simulationPreparation.current ||
      sessions.get(id) !== project ||
      sessions.activeId !== id
    )
      throw new Error("Simulation preparation was cancelled.");
    setBuildDiagnostics(result.diagnostics);
    if (!result.success) {
      setProblemsOpen(true);
      throw new Error(
        result.diagnostics.map((item) => `${item.file}: ${item.message}`).join("\n") ||
          "Simulation compilation failed.",
      );
    }
    setProblemsOpen(false);
    return result.prepared;
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
    else if (connectionMode === "wifi" && wifiAddress.trim()) {
      const address = wifiAddress.trim();
      const previous = controller.getSnapshot().session?.id;
      void controller.connect(address).then(() => {
        const session = controller.getSnapshot().session;
        if (session?.transport === "wifi" && session.id !== previous)
          settingsStore.rememberAddress(address);
      });
    }
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
      filePreferences={filePreferences}
      reducedMotion={reducedMotion}
      settings={settings}
      updates={updates}
      updateBusy={updateBusy}
      onInstallUpdate={requestUpdate}
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
      {workspace && quickOpenWorkspace === workspace.id && (
        <QuickOpen
          locale={locale}
          files={[...new Set([...workspace.files, ...Object.keys(workspace.drafts), ...openFiles])]}
          activeFile={activeFile}
          recentFiles={[...openFiles].reverse()}
          onOpen={(file, position) => void openQuickFile(file, position)}
          onClose={() => setQuickOpenWorkspace(undefined)}
        />
      )}
      <div className="workbench-header">
        <Toolbar
          t={t}
          locale={locale}
          shortcutHint={keyboard.hint}
          onSaveAll={() => runCommand("saveAll")}
          onSaveCopy={
            workspace?.sharedRoomId
              ? () => {
                  void flushDrafts(workspace.id)
                    .then(() => window.kobrixa.collab.saveCopy(workspace.sharedRoomId!))
                    .catch(report);
                }
              : undefined
          }
          appearance={
            <SettingsQuickControls
              resolvedTheme={resolvedTheme}
              settings={settings}
              onChange={(key, value) => settingsStore.set(key, value)}
              onOpen={openSettings}
              shortcut={keyboard.hint("settings")}
            />
          }
          deviceControlNotice={controlNotice}
          deviceLocked={
            updatePreparing ||
            controller.locked ||
            motorBusy ||
            managingEntries ||
            projectBusy ||
            modalOpen
          }
          projectLocked={
            restoring || updatePreparing || managingEntries || projectBusy || modalOpen
          }
          name={workspace?.name}
          locked={executionLocked || managingEntries || projectBusy || modalOpen}
          canSave={Boolean(!settingsActive && active && active.dirty)}
          state={execution}
          motorTesting={motorBusy}
          onNew={() => runCommand("newProject")}
          onOpen={() => runCommand("openProject")}
          onSave={() => runCommand("save")}
          onRun={() => runCommand("run")}
          onBuild={() => runCommand("build")}
          onPreview={() => runCommand("preview")}
          onStop={() => runCommand("stop")}
          onUpload={() => void controller.upload()}
          onRunUploaded={() => void controller.runDeployed()}
          onDelete={() => void controller.deleteDeployed()}
          onCancel={() => runCommand("stop")}
          devicePanelOpen={rightPanel === "ev3"}
          onDevice={() => toggleRightPanel("ev3")}
          collab={
            <CollabStatusChip
              store={collab}
              locale={locale}
              active={rightPanel === "collab"}
              pending={deviceControl?.state.requests.length ?? 0}
              onOpen={() => toggleRightPanel("collab")}
            />
          }
        />
        <ProjectTabs
          projects={projects.map((project) => ({
            id: project.workspace.id,
            name: project.workspace.sharedRoomId
              ? `${project.workspace.name} · ${collabSession?.connection.roomId === project.workspace.sharedRoomId && collabSnapshot?.status === "connected" ? (locale === "zh-TW" ? "共享" : "Shared") : locale === "zh-TW" ? "已離線" : "Offline"}`
              : project.workspace.name,
            location: project.workspace.locationLabel ?? project.workspace.rootLabel,
            dirty: project.dirty,
            phase: controller.editingLockedFor(project.workspace.id)
              ? t.phases[execution.phase]
              : undefined,
            closeDisabled: controller.editingLockedFor(project.workspace.id),
          }))}
          activeId={workspace?.id}
          locale={locale}
          disabled={
            restoring ||
            updatePreparing ||
            projectBusy ||
            managingEntries ||
            closingProject ||
            modalOpen
          }
          onSelect={selectProject}
          onClose={requestCloseProject}
        />
        {execution.operationWorkspaceId &&
          execution.operationWorkspaceId !== workspace?.id &&
          controller.editingLocked && (
            <aside className="project-operation" role="status">
              <span>
                {sessions.get(execution.operationWorkspaceId)?.workspace.name}:{" "}
                {t.phases[execution.phase]}
              </span>
              <button
                onClick={() => {
                  if (execution.operationWorkspaceId) selectProject(execution.operationWorkspaceId);
                }}
                disabled={modalOpen || updatePreparing}
              >
                {locale === "zh-TW" ? "切換至專案" : "Show project"}
              </button>
              {execution.phase === "building" && (
                <button onClick={() => void controller.cancelBuild()}>{t.cancel}</button>
              )}
              {execution.phase === "awaitingDevice" && (
                <button onClick={() => controller.cancelWaiting()}>{t.cancel}</button>
              )}
            </aside>
          )}
        {sessionIssues.length > 0 && (
          <aside className="session-issues" role="alert">
            <span>{sessionIssues.join("\n")}</span>
            <button
              onClick={() =>
                void persistSession()
                  .then(() => setSessionIssues([]))
                  .catch(sessionFailure)
              }
            >
              {locale === "zh-TW" ? "重試儲存" : "Retry saving"}
            </button>
            <button onClick={() => setSessionIssues([])}>
              {locale === "zh-TW" ? "關閉提示" : "Dismiss"}
            </button>
          </aside>
        )}
        {updates &&
          ["ready", "manual"].includes(updates.phase) &&
          dismissedUpdate !== `${updates.version}:${updates.phase}` && (
            <aside className="update-notice" role="status">
              <span>
                {locale === "zh-TW"
                  ? `新版本 ${updates.version} 已${updates.phase === "ready" ? "下載" : "推出"}。`
                  : `Version ${updates.version} is ${updates.phase === "ready" ? "ready to install" : "available"}.`}
              </span>
              <button
                disabled={updateBusy}
                onClick={() => {
                  if (updates.phase === "ready") requestUpdate();
                  else void window.kobrixa.updates.openRelease().catch(report);
                }}
              >
                {locale === "zh-TW"
                  ? updates.phase === "ready"
                    ? "重新啟動並更新"
                    : "下載新版"
                  : updates.phase === "ready"
                    ? "Restart and update"
                    : "Download update"}
              </button>
              <button
                onClick={() => {
                  setSettingsCategory((previous) => ({
                    category: "updates",
                    request: previous.request + 1,
                  }));
                  openSettings();
                }}
              >
                {locale === "zh-TW" ? "更新設定" : "Update settings"}
              </button>
              <button onClick={() => setDismissedUpdate(`${updates.version}:${updates.phase}`)}>
                {locale === "zh-TW" ? "稍後" : "Later"}
              </button>
            </aside>
          )}
        {confirmUpdate && (
          <Dialog
            title={locale === "zh-TW" ? "儲存並更新" : "Save and update"}
            onClose={() => setConfirmUpdate(false)}
          >
            <p>
              {locale === "zh-TW"
                ? "更新將重新啟動 Kobrixa。請先儲存所有未儲存的變更。"
                : "Updating will restart Kobrixa. Save all unsaved changes first."}
            </p>
            <DialogActions>
              <button data-modal-initial onClick={() => setConfirmUpdate(false)}>
                {locale === "zh-TW" ? "取消" : "Cancel"}
              </button>
              <button onClick={() => void installUpdate()}>
                {locale === "zh-TW" ? "儲存全部並更新" : "Save all and update"}
              </button>
            </DialogActions>
          </Dialog>
        )}
        {saveError && !settingsActive && (
          <SettingsError locale={locale} onRetry={settingsStore.save} />
        )}
      </div>
      <section
        id="project-workbench"
        className={`workspace ${!workspace ? "welcome-workbench" : ""} ${deviceOverlay ? "device-overlay" : ""}`}
        ref={workspaceRef}
        style={workspaceStyle}
      >
        {restoring ? (
          <div className="empty" role="status">
            {locale === "zh-TW" ? "正在恢復專案…" : "Restoring projects…"}
          </div>
        ) : !workspace ? (
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
          <>
            <aside
              className={`sidebar files-panel ${filesOpen ? "" : "collapsed"}`}
              aria-hidden={!filesOpen}
            >
              {filesOpen && (
                <>
                  <div
                    className="files-navigation"
                    role="group"
                    aria-label={locale === "zh-TW" ? "專案導覽" : "Project navigation"}
                  >
                    <button
                      aria-pressed={sidebarMode === "files"}
                      onClick={() => setSidebarMode("files")}
                    >
                      {t.files}
                    </button>
                    <button
                      aria-pressed={sidebarMode === "search"}
                      title={titleWithShortcut(
                        locale === "zh-TW" ? "跨檔案搜尋" : "Search in project",
                        "search",
                      )}
                      onClick={() => runCommand("search")}
                    >
                      {locale === "zh-TW" ? "搜尋" : "Search"}
                    </button>
                    <button
                      className="quick-open-trigger"
                      title={titleWithShortcut(
                        locale === "zh-TW" ? "快速開啟檔案" : "Quick open",
                        "quickOpen",
                      )}
                      aria-label={locale === "zh-TW" ? "快速開啟檔案" : "Quick open"}
                      onClick={() => runCommand("quickOpen")}
                    >
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        aria-hidden="true"
                      >
                        <circle cx="10" cy="10" r="6" />
                        <path d="m15 15 6 6" />
                      </svg>
                    </button>
                  </div>
                  {sidebarMode === "files" && (
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
                  )}
                </>
              )}
              <SearchPanel
                key={workspace.id}
                workspace={workspace}
                documents={documents}
                active={filesOpen && sidebarMode === "search"}
                focusRequest={searchFocusRequest}
                locale={locale}
                resolvedTheme={resolvedTheme}
                readOnly={locked || projectBusy || managingEntries}
                onOpen={openSearchResult}
                onReplace={replaceSearchResults}
                onClose={() => {
                  setSidebarMode("files");
                  window.requestAnimationFrame(() => editorRef.current?.focus());
                }}
              />
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

            <section
              className={`center ${settingsActive ? "settings-active" : ""}`}
              ref={centerRef}
            >
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
                    className="local-history-trigger"
                    disabled={settingsActive || !active || locked}
                    onClick={() => void openHistory()}
                  >
                    {locale === "zh-TW" ? "本機歷史" : "Local history"}
                  </button>
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
                      {activeSession?.files.conflicts.has(tab.file) && (
                        <span
                          className="file-conflict-mark"
                          aria-label={
                            locale === "zh-TW" ? "外部變更待處理" : "External changes need review"
                          }
                        >
                          !
                        </span>
                      )}
                    </ClosableTab>
                  );
                })}
                {settingsTab}
              </div>

              <div
                className={`editor-simulation-layout ${simulator?.workspaceId === workspace.id ? "with-simulator" : ""}`}
                hidden={settingsActive}
              >
                <div
                  className={`editor-stage ${activeConflict ? "file-change-stage" : ""}`}
                  hidden={settingsActive}
                >
                  {activeConflict && active && (
                    <div className="file-change-banner" role="status">
                      <span>
                        {activeConflict.content === null
                          ? locale === "zh-TW"
                            ? "檔案已在外部刪除，編輯器內容已保留。"
                            : "File deleted outside Kobrixa. Editor contents are preserved."
                          : locale === "zh-TW"
                            ? "檔案已在外部變更，此檔案的自動儲存已暫停。"
                            : "File changed outside Kobrixa. Automatic saving is paused for this file."}
                      </span>
                      <button
                        disabled={locked}
                        onClick={() => beginFileReview(activeSession!, active.file)}
                      >
                        {locale === "zh-TW" ? "比較變更" : "Compare changes"}
                      </button>
                    </div>
                  )}
                  {locked && (
                    <div className="editor-lock" role="status">
                      {t.phases[execution.phase]} <span>{t.locked}</span>
                    </div>
                  )}
                  {active ? (
                    <Editor
                      locale={locale}
                      onQuickFixes={(snapshot, diagnostic, signal) =>
                        analysisTransport.quickFixes(snapshot.analysis, diagnostic, signal)
                      }
                      key={workspace.id}
                      retainedModels={activeSession!.editor}
                      focusOnMount={focusEditorOnMount.current}
                      onViewChange={scheduleSessionSave}
                      ref={editorRef}
                      theme={resolvedTheme}
                      editorOptions={settings}
                      onEditorReady={keyboard.bindEditor}
                      onBlur={(file) => requestFocusSave(file, workspace.id)}
                      fontSize={codeSize}
                      wordWrap={settings.wordWrap}
                      indentSize={settings.indentSize}
                      reducedMotion={reducedMotion}
                      readOnly={locked || projectBusy || managingEntries || collabReadOnly}
                      collabSession={sharedProject ? collabSession : null}
                      onCollabLimit={(file) => report(sharedFileLimitError(file))}
                      file={active.file}
                      documents={documents}
                      analysisSession={analysisSession}
                      completionSession={completionSession}
                      openFiles={openFiles}
                      diagnostics={diagnostics}
                      focusTarget={focusTarget}
                      ariaLabel={t.editorLabel}
                      onChange={(file) => updateActive(file, workspace.id)}
                      onOpenLocation={openLocation}
                      onWorkspaceEdit={applyWorkspaceEdit}
                      onCursorChange={cursorStore.update}
                    />
                  ) : (
                    <div className="empty">{t.chooseFile}</div>
                  )}
                </div>

                {simulator && (
                  <div className="simulator-host" hidden={simulator.workspaceId !== workspace.id}>
                    {simulatorSceneError && (
                      <div className="simulation-scene-error" role="alert">
                        {simulatorSceneError}
                      </div>
                    )}
                    <SimulatorWorkspace
                      key={simulator.workspaceId}
                      scene={simulator.scene}
                      entries={
                        sessions
                          .get(simulator.workspaceId)
                          ?.workspace.files.filter((file) => /\.bp$/i.test(file)) ?? []
                      }
                      locale={locale}
                      projectName={simulator.projectName}
                      active={
                        simulator.workspaceId === workspace.id &&
                        !settingsActive &&
                        !updatePreparing
                      }
                      blocked={!!simulatorSceneError}
                      onSceneChange={changeSimulatorScene}
                      onSave={saveSimulatorScene}
                      onPrepare={prepareSimulator}
                      onCancelPrepare={cancelSimulationPreparation}
                      onClose={() => setSimulator(undefined)}
                      onSource={(span) => {
                        void openQuickFile(span.file, {
                          line: span.start.line,
                          column: span.start.column,
                        }).catch(report);
                      }}
                    />
                  </div>
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
                tab={bottomTab}
                onTab={(tab) => {
                  settingsStore.set("bottomTab", tab);
                  setProblemsOpen(true);
                }}
                activity={<ActivityPanel t={t} locale={locale} state={execution} />}
                fixesDisabled={locked || projectBusy || managingEntries}
                locale={locale}
                analysisSession={analysisSession}
                getQuickFixes={(diagnostic, signal) =>
                  editorRef.current?.quickFixes(diagnostic, signal) ?? Promise.resolve([])
                }
                applyQuickFix={(action) =>
                  editorRef.current?.applyQuickFix(action) ??
                  Promise.reject(new Error("Editor unavailable."))
                }
                openDocumentation={(request) => window.kobrixa.documentation.open(request)}
                open={problemsOpen}
                onToggle={() => setProblemsOpen((value) => !value)}
                diagnostics={diagnostics}
                selected={diagnosticIndex}
                checking={checking}
                onJump={(item, index) => void jumpTo(item, index)}
              />
            </section>
          </>
        )}
        <ResizeHandle
          className="resize-device"
          axis="x"
          direction={-1}
          label={locale === "zh-TW" ? "調整右側面板寬度" : "Resize right panel"}
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
          <div className="right-pane-content" hidden={rightPanel !== "ev3"}>
            <ToolsPanel
              tab={toolTab}
              onTab={setToolTab}
              locale={locale}
              onClose={() => {
                settingsStore.set("rightPanel", null);
              }}
              monitor={
                <MonitorWorkspace
                  lab={sensorLab}
                  motor={motorTest}
                  view={monitorView}
                  onView={setMonitorView}
                  controller={monitor}
                  locale={locale}
                  sessionId={execution.session?.id}
                  active={toolTab === "monitor" && !updatePreparing}
                  locked={updatePreparing || controller.locked}
                  controlNotice={controlNotice}
                  onConnect={() => setToolTab("connection")}
                />
              }
              connection={
                <>
                  {deviceControl && (
                    <p className="collab-muted">
                      {controlNotice ??
                        (locale === "zh-TW" ? "你持有 EV3 控制權" : "You have EV3 control")}{" "}
                      <button onClick={() => settingsStore.set("rightPanel", "collab")}>
                        {locale === "zh-TW" ? "協作控制權" : "Room controls"}
                      </button>
                    </p>
                  )}
                  <DevicePanel
                    t={t}
                    locale={locale}
                    state={execution}
                    devices={devices}
                    discovering={discovering}
                    locked={updatePreparing || controller.locked || motorBusy}
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
                </>
              }
              files={
                <RemoteFilesPanel
                  controller={remoteFiles}
                  state={remoteState}
                  active={toolTab === "files"}
                  locale={locale}
                  locked={updatePreparing || controller.locked || motorBusy}
                  controlNotice={controlNotice}
                  deployedPath={execution.deployed?.path}
                  onConnect={() => setToolTab("connection")}
                />
              }
            />
          </div>
          <div className="right-pane-content collaboration-pane" hidden={rightPanel !== "collab"}>
            <div className="tools-heading">
              <h2>{locale === "zh-TW" ? "協作" : "Collaborate"}</h2>
              <button
                aria-label={locale === "zh-TW" ? "收合協作面板" : "Collapse collaboration"}
                onClick={() => settingsStore.set("rightPanel", null)}
              >
                ×
              </button>
            </div>
            <CollabSyncStatus sync={collabBinding?.sync} locale={locale} />
            {removedPrompts[0] && (
              <RemovedFilesDialog
                key={removedPrompts[0].id}
                prompt={removedPrompts[0]}
                locale={locale}
                onKeep={keepRemovedFiles}
                onDiscard={(prompt) =>
                  setRemovedPrompts((prompts) => prompts.filter((item) => item.id !== prompt.id))
                }
              />
            )}
            <CollabWorkspace
              store={collab}
              api={window.kobrixa.collab}
              locale={locale}
              projectName={workspace?.name}
              projectId={workspace?.id}
              onOpenProject={() => void openProject()}
              onStart={async (connection) => {
                const selected = sessions.activeId;
                await flushDrafts();
                const summary = await window.kobrixa.collab.prepareProject(
                  connection.roomId,
                  selected,
                );
                if (!summary) return false;
                await collabCallbacks.current.adopt(summary);
                collab.start({ ...connection, workspaceId: summary.id });
                return true;
              }}
              onLeavingChange={(leaving) => {
                collabLeavingRef.current = leaving;
                setCollabLeaving(leaving);
              }}
              onLeave={async () => {
                await flushDrafts();
                await flushSharedRoom();
              }}
              control={
                deviceControl ? (
                  <DeviceControlBar
                    control={deviceControl.control}
                    state={deviceControl.state}
                    locale={locale}
                  />
                ) : null
              }
            />
          </div>
        </aside>
      </section>
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
      {pendingCloseProject && (
        <Dialog
          title={locale === "zh-TW" ? "關閉專案" : "Close project"}
          titleId="close-project-title"
          role="alertdialog"
          onClose={() => {
            if (!closingProject) setPendingCloseProject(undefined);
          }}
        >
          <p>
            {locale === "zh-TW"
              ? `「${sessions.get(pendingCloseProject)?.workspace.name}」有未儲存的變更。`
              : `“${sessions.get(pendingCloseProject)?.workspace.name}” has unsaved changes.`}
          </p>
          <DialogActions className="three-actions">
            <button disabled={closingProject} onClick={() => setPendingCloseProject(undefined)}>
              {locale === "zh-TW" ? "取消" : "Cancel"}
            </button>
            <button
              className="danger"
              disabled={closingProject}
              onClick={() => void closeProject(pendingCloseProject, "discard")}
            >
              {locale === "zh-TW" ? "捨棄變更" : "Discard changes"}
            </button>
            <button
              data-modal-initial
              className="primary"
              disabled={closingProject}
              onClick={() => void closeProject(pendingCloseProject, "save")}
            >
              {locale === "zh-TW" ? "全部儲存" : "Save all"}
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
      {fileReview && (
        <FileConflictDialog
          locale={locale}
          resolvedTheme={resolvedTheme}
          file={fileReview.file}
          localContent={
            sessions
              .get(fileReview.workspaceId)
              ?.documents.getSnapshot()
              .find((tab) => tab.file === fileReview.file)?.content ??
            sessions.get(fileReview.workspaceId)?.workspace.drafts[fileReview.file] ??
            ""
          }
          diskContent={fileReview.snapshot.content}
          busy={fileReviewBusy}
          error={fileReview.error}
          onClose={() => {
            if (!fileReviewBusy) setFileReview(undefined);
          }}
          onReload={() => void resolveFileReview("reload")}
          onKeepLocal={() => void resolveFileReview("save")}
        />
      )}
      {historyReview && (
        <LocalHistoryDialog
          locale={locale}
          resolvedTheme={resolvedTheme}
          preferences={filePreferences.value}
          file={historyReview.file}
          currentContent={
            sessions
              .get(historyReview.workspaceId)
              ?.documents.getSnapshot()
              .find((tab) => tab.file === historyReview.file)?.content ?? ""
          }
          entries={historyReview.entries}
          selectedId={historyReview.selectedId}
          selectedContent={historyReview.selectedContent}
          loading={historyReview.loading}
          busy={false}
          error={historyReview.error}
          onSelect={(id) => void selectHistory(id)}
          onRestore={restoreHistory}
          onClose={() => {
            historyRequest.current++;
            setHistoryReview(undefined);
          }}
        />
      )}
      <footer>
        <div className="status-group">
          {active ? (
            <span className={active.dirty || activeConflict ? "dirty" : ""}>
              {activeConflict
                ? locale === "zh-TW"
                  ? "! 外部變更待處理"
                  : "! Review external changes"
                : active.dirty
                  ? `● ${t.unsaved}`
                  : `✓ ${t.saved}`}
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
          <RecordingStatus
            controller={sensorLab}
            locale={locale}
            onOpen={() => {
              setDeviceOpen(true);
              setToolTab("monitor");
              setMonitorView("lab");
            }}
          />
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
