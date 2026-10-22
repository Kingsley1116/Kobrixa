import type { PluginUiBridge, CoreRecoveryPort } from "./plugin-ui.js";
import type {
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "./static-languages.js";
export type {
  StaticLanguageOwner,
  StaticLanguageProblemDetail,
  ValidatedStaticLanguage,
  StaticLanguageConflict,
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "./static-languages.js";
import type { PluginHelpCatalogView } from "./diagnostic-help.js";
import type {
  PluginActionResult,
  PluginCommandResult,
  PluginErrorCode,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
} from "@kobrixa/plugin-runtime";
import type { LocalizedText } from "@kobrixa/plugin-protocol";

export type {
  LocalizedText,
  PluginActionResult,
  PluginCommandResult,
  PluginNotice,
  PluginsSnapshot,
  PluginSummary,
};
export type PythonStatus = "ok" | "warning" | "error";
export type PythonProblem = "sdk-missing" | "sdk-incompatible" | "too-old" | "failed";
export interface PythonProbe {
  status: PythonStatus;
  problem?: PythonProblem;
  /** Reported by the interpreter itself, never guessed from the command. */
  version?: string;
  path?: string;
  sdkApiVersion?: string;
  detail?: string;
}
/** The only interpreter identifiers the renderer may send; "other" opens a file picker. */
export type PythonChoiceId = "python3" | "python" | "py" | "saved" | "other";
export interface PythonChoice {
  id: Exclude<PythonChoiceId, "other">;
  label: string;
  selected: boolean;
  probe: PythonProbe;
}
export interface PythonView {
  current?: { label: string; origin: "settings" | "command-line" };
  /** Running Python plugins that keep their old interpreter until reloaded. */
  pendingReload: string[];
}
export type PluginOrigin = "builtin" | "linked" | "session";
export interface SafeModeLockView {
  since: string;
  reason: "unclean-exit" | "renderer-unresponsive";
}
export interface PluginsView extends PluginsSnapshot {
  developer: {
    enabled: boolean;
    /** Authorized by --plugin-dev-dir for this session only. */
    commandLine: boolean;
    linkedCount: number;
  };
  safeModeLock?: SafeModeLockView;
  /** Startup session-source recovery, kept in memory even when settings cannot be saved. */
  sessionRecovery?: boolean;
  /** Keyed by source key. */
  origins: Record<string, PluginOrigin>;
  python: PythonView;
  /** Source keys with a command in flight. */
  inflight: string[];
}
export interface StoredNotice extends PluginNotice {
  id: number;
}
export interface LogLine {
  seq: number;
  text: string;
}
export interface LogRead {
  lines: LogLine[];
  /** Pass back as `after` to read only newer lines. */
  next: number;
  /** Lines after the cursor were dropped by the size limits. */
  truncated: boolean;
}
export type PluginsResult =
  | {
      ok: true;
      state: PluginsView;
      persisted?: false;
      outcome?: "cancelled" | "duplicate";
      sourceKey?: string;
    }
  | { ok: false; code: PluginErrorCode; message: string };
export type PluginsViewEvent =
  { type: "state"; state: PluginsView } | { type: "notice"; notice: StoredNotice };
export type PluginEvent = PluginsViewEvent;
export interface PluginsApi {
  ui: PluginUiBridge;
  recovery: CoreRecoveryPort;
  state(): Promise<PluginsView>;
  diagnosticHelp(): Promise<PluginHelpCatalogView>;
  staticLanguages(): Promise<StaticLanguagesCatalog>;
  reportLanguageRegistrationFailure(
    input: ReportLanguageRegistrationFailureInput,
  ): Promise<ReportLanguageRegistrationFailureResult>;
  notices(): Promise<StoredNotice[]>;
  execute(commandId: string): Promise<PluginCommandResult>;
  cancel(sourceKey: string): Promise<void>;
  setEnabled(sourceKey: string, enabled: boolean): Promise<PluginsResult>;
  setDeveloperMode(enabled: boolean): Promise<PluginsResult>;
  linkFolder(): Promise<PluginsResult>;
  relinkFolder(sourceKey: string): Promise<PluginsResult>;
  unlink(sourceKey: string): Promise<PluginsResult>;
  reload(sourceKey: string): Promise<PluginsResult>;
  pythonCandidates(): Promise<PythonChoice[]>;
  setPython(id: PythonChoiceId): Promise<PluginsResult>;
  readLog(sourceKey: string, after: number): Promise<LogRead>;
  clearSafeModeLock(): Promise<PluginsResult>;
  onEvent(listener: (event: PluginEvent) => void): () => void;
}

export type { CoreActionReference, CoreWindowScope } from "./plugin-ui.js";
export type { DrainReport } from "./plugin-persistence.js";
