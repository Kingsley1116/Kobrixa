import {
  emptyStaticLanguagesCatalog,
  type StaticLanguageOwner,
  type StaticLanguagesCatalog,
  type ReportLanguageRegistrationFailureInput,
  type ReportLanguageRegistrationFailureResult,
} from "./static-languages.js";
import path from "node:path";
import {
  DIAGNOSTIC_HELP_LIMITS,
  type LocalizedText,
  type PluginDiagnosticHelpEntry,
  type PluginLocale,
  type Severity,
} from "@kobrixa/plugin-protocol";
import {
  resolveCompilerProviders,
  resolveFrontendProvider,
  resolveLanguageService,
  type CompilerResolution,
  type LanguageServiceResolution,
} from "./compiler-resolution.js";
import { messageOf, PluginError, type PluginErrorCode, type PluginProblem } from "./errors.js";
import {
  developmentSourceKey,
  readSource,
  resolvePlugins,
  type DevelopmentSource,
  type PluginSource,
  type ReadPlugin,
  type RegisteredPlugin,
} from "./registry.js";
import {
  PluginSupervisor,
  type PluginLauncher,
  type StopReason,
  type SupervisorOptions,
} from "./supervisor.js";

export interface PluginPersistedState {
  /** Source keys of development plugins the user disabled. */
  disabled: ReadonlySet<string>;
  /** Manifest ids kept from schema v1; each becomes a source key once a source with it loads. */
  legacyDisabledIds: ReadonlySet<string>;
}
export interface PluginStateStore {
  /** `problem` reports a corrupt store: the manager then keeps third-party plugins disabled. */
  load(): Promise<PluginPersistedState & { problem?: string }>;
  save(state: PluginPersistedState): Promise<void>;
}
export interface PluginManagerOptions {
  sources: readonly PluginSource[];
  store: PluginStateStore;
  safeMode: boolean;
  launcher: PluginLauncher;
  locale: PluginLocale;
  supervisor?: Omit<SupervisorOptions, "locale" | "onNotice" | "onStateChange">;
  /** Bound on reading one development folder; defaults to SOURCE_READ_TIMEOUT_MS. */
  sourceReadTimeoutMs?: number;
  /** Total help budget; defaults to 8 MiB. Tests may lower this limit. */
  diagnosticHelpTotalBytes?: number;
  now?(): number;
}
export interface PluginSummary {
  sourceKey: string;
  id: string;
  source: "builtin" | "development";
  directory?: string;
  version?: string;
  runtime?: "builtin" | "node" | "python" | "static";
  displayName?: LocalizedText;
  status: "enabled" | "disabled" | "invalid" | "failed";
  disabledBy?: "user" | "safe-mode";
  running: boolean;
  problems: PluginProblem[];
  commands: { id: string; title: LocalizedText }[];
}
export interface PluginsSnapshot {
  /** Increases with every state event; keep the snapshot with the highest revision. */
  revision: number;
  /** Revision of the currently published diagnostic help catalog. */
  diagnosticHelpRevision: number;
  staticLanguagesRevision: number;
  staticLanguageOwners: StaticLanguageOwner[];
  safeMode: boolean;
  developmentMode: boolean;
  /** The settings file was corrupt or unreadable; cleared by the next successful save. */
  stateProblem?: PluginProblem;
  plugins: PluginSummary[];
}
export interface DiagnosticHelpCatalog {
  revision: number;
  plugins: Array<{ source: string; sourceKey: string; entries: PluginDiagnosticHelpEntry[] }>;
}
export interface PluginNotice {
  pluginId: string;
  sourceKey: string;
  severity: Severity;
  message: string;
  at: number;
}
export type PluginManagerEvent =
  { type: "state"; state: PluginsSnapshot } | { type: "notice"; notice: PluginNotice };
type Failure = { ok: false; code: PluginErrorCode; message: string };
export type PluginCommandResult = { ok: true } | Failure;
/** `persisted: false`: the change applies to this session but could not be saved. */
export type PluginActionResult = { ok: true; state: PluginsSnapshot; persisted?: false } | Failure;
const failure = (code: PluginErrorCode, message: string): Failure => ({ ok: false, code, message });
/** Default overall bound for shutdown(); the quit cleanup waits slightly longer (task 12). */
export const PLUGIN_SHUTDOWN_DEADLINE_MS = 4_000;
/** Time between force-killing leftovers and the deadline, for exit reports to arrive. */
export const PLUGIN_FORCE_MARGIN_MS = 1_000;

interface Entry {
  readonly source: PluginSource;
  read: ReadPlugin;
  plugin: RegisteredPlugin;
  /** Increases on every reload; events from an older generation's supervisor are dropped. */
  generation: number;
}
const commandIds = (plugin: RegisteredPlugin) =>
  (plugin.manifest?.contributes?.commands ?? []).map((command) => command.id);
const unresolved = (read: ReadPlugin): RegisteredPlugin => ({
  ...read,
  problems: [...read.problems],
  status: "invalid",
});
const readOptions = (options: PluginManagerOptions, safeMode: boolean) => ({
  safeMode,
  ...(options.sourceReadTimeoutMs === undefined ? {} : { timeoutMs: options.sourceReadTimeoutMs }),
});
/** Converts schema v1 disables (manifest ids) once a development source with that id was read. */
function convertLegacy(
  reads: Iterable<ReadPlugin>,
  disabled: Set<string>,
  legacy: Set<string>,
): boolean {
  let changed = false;
  for (const read of reads) {
    if (read.source !== "development" || !read.manifest || !legacy.has(read.id)) continue;
    disabled.add(read.sourceKey);
    legacy.delete(read.id);
    changed = true;
  }
  return changed;
}

export class PluginManager {
  #entries: Entry[];
  /** Keyed by source key: only the current supervisor of each enabled plugin. */
  readonly #supervisors = new Map<string, PluginSupervisor>();
  /** Supervisors of plugins being disabled, reloaded or removed stay tracked until they stop. */
  readonly #retiring = new Set<PluginSupervisor>();
  /** Command id → source key. */
  readonly #commands = new Map<string, string>();
  readonly #listeners = new Set<(event: PluginManagerEvent) => void>();
  #shutdown: Promise<void> | undefined;
  #supervisorsStopped: Promise<void> | undefined;
  #changes: Promise<unknown> = Promise.resolve();
  #revision = 0;
  #help: {
    revision: number;
    key: string;
    catalog: DiagnosticHelpCatalog["plugins"];
    overBudget: Set<string>;
  } = { revision: 0, key: "", catalog: [], overBudget: new Set() };
  #disabled: Set<string>;
  readonly #legacy: Set<string>;
  #stateProblem: PluginProblem | undefined;
  #safeMode: boolean;

  static async create(options: PluginManagerOptions): Promise<PluginManager> {
    let stored: PluginPersistedState & { problem?: string };
    try {
      stored = await options.store.load();
    } catch (error) {
      stored = { disabled: new Set(), legacyDisabledIds: new Set(), problem: messageOf(error) };
    }
    const reads = await Promise.all(
      options.sources.map((source) => readSource(source, readOptions(options, options.safeMode))),
    );
    const disabled = new Set(stored.disabled);
    const legacy = new Set(stored.legacyDisabledIds);
    const converted = convertLegacy(reads, disabled, legacy);
    const manager = new PluginManager(
      options,
      { disabled, legacy, problem: stored.problem },
      options.sources.map((source, index) => ({ source, read: reads[index]! })),
    );
    if (converted) await manager.#saveBestEffort();
    return manager;
  }

  private constructor(
    private readonly options: PluginManagerOptions,
    stored: { disabled: Set<string>; legacy: Set<string>; problem: string | undefined },
    sources: { source: PluginSource; read: ReadPlugin }[],
  ) {
    this.#safeMode = options.safeMode;
    this.#disabled = stored.disabled;
    this.#legacy = stored.legacy;
    this.#entries = sources.map(({ source, read }) => ({
      source,
      read,
      plugin: unresolved(read),
      generation: 0,
    }));
    if (stored.problem !== undefined) {
      this.#stateProblem = { code: "PLUGIN_E_STATE_CORRUPT", message: stored.problem };
      // Fail closed: the unreadable file may have kept a problem plugin disabled.
      for (const { read } of this.#entries)
        if (read.source === "development") this.#disabled.add(read.sourceKey);
    }
    this.#reconcile();
  }

  state(): PluginsSnapshot {
    return {
      revision: this.#revision,
      diagnosticHelpRevision: this.#help.revision,
      staticLanguagesRevision: this.staticLanguagesRevision,
      staticLanguageOwners: [],
      safeMode: this.#safeMode,
      developmentMode: this.#entries.some((entry) => entry.read.source === "development"),
      ...(this.#stateProblem ? { stateProblem: this.#stateProblem } : {}),
      plugins: this.#entries.map((entry) => this.#summary(entry)),
    };
  }

  get staticLanguagesRevision(): number {
    return 0;
  }

  staticLanguages(): StaticLanguagesCatalog {
    return emptyStaticLanguagesCatalog(this.staticLanguagesRevision);
  }

  reportLanguageRegistrationFailure(
    input: ReportLanguageRegistrationFailureInput,
  ): ReportLanguageRegistrationFailureResult {
    void input;
    return { accepted: false, revision: this.staticLanguagesRevision };
  }

  diagnosticHelp(): DiagnosticHelpCatalog {
    return structuredClone({ revision: this.#help.revision, plugins: this.#help.catalog });
  }

  resolveCompiler(language: string, target: string): CompilerResolution {
    return resolveCompilerProviders(
      this.#entries.map((entry) => entry.plugin),
      language,
      target,
    );
  }

  resolveLanguageService(language: string): LanguageServiceResolution {
    const plugins = this.#entries.map((entry) => entry.plugin);
    const result = resolveFrontendProvider(plugins, language);
    if (!result.ok) return result;
    const entry = this.#entries.find(
      (entry) => entry.plugin.sourceKey === result.frontend.sourceKey,
    )!;
    return resolveLanguageService(plugins, language, entry.generation);
  }

  async executeCommand(commandId: string, signal?: AbortSignal): Promise<PluginCommandResult> {
    if (this.#shutdown) return failure("PLUGIN_E_DISABLED", "Kobrixa is shutting down plugins.");
    const owner = this.#commands.get(commandId);
    const supervisor = owner ? this.#supervisors.get(owner) : undefined;
    if (!supervisor)
      return failure("PLUGIN_E_UNKNOWN_COMMAND", `No enabled plugin contributes ${commandId}.`);
    try {
      await supervisor.executeCommand(commandId, signal);
      return { ok: true };
    } catch (error) {
      return error instanceof PluginError
        ? failure(error.code, error.message)
        : failure("PLUGIN_E_COMMAND_FAILED", messageOf(error));
    }
  }

  setEnabled(sourceKey: string, enabled: boolean): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#setEnabled(sourceKey, enabled));
  }

  async #setEnabled(sourceKey: string, enabled: boolean): Promise<PluginActionResult> {
    const closed = this.#closed();
    if (closed) return closed;
    const entry = this.#entryOf(sourceKey);
    if (!entry || entry.plugin.status === "invalid")
      return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No valid plugin has the source ${sourceKey}.`);
    if (entry.read.source === "builtin")
      return failure(
        "PLUGIN_E_BUILTIN_REQUIRED",
        `${entry.plugin.id} is part of Kobrixa and cannot be disabled in this version.`,
      );
    if (enabled && this.#safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restore plugins first, or restart without --safe-mode.",
      );
    if (this.#disabled.has(sourceKey) !== enabled) return { ok: true, state: this.state() };
    const next = new Set(this.#disabled);
    if (enabled) next.delete(sourceKey);
    else next.add(sourceKey);
    let persisted = true;
    try {
      await this.#save(next);
    } catch (error) {
      // Enabling must be saved first; a disable still applies now so a problem plugin can stop.
      if (enabled) return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
      persisted = false;
    }
    this.#disabled = next;
    await this.#apply("disabled");
    return { ok: true, state: this.state(), ...(persisted ? {} : { persisted: false as const }) };
  }

  /** Adds a development folder after startup. The folder is read before anything registers. */
  addSource(source: DevelopmentSource): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#addSource(source));
  }

  /**
   * Stops and unregisters a development source. Its files are never touched. `forget: false`
   * keeps its disabled choice for when the same folder is added again.
   */
  removeSource(sourceKey: string, options: { forget?: boolean } = {}): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#removeSource(sourceKey, options.forget !== false));
  }

  /**
   * Cancels the source's running commands, stops its process within the stop bound, then reads
   * its folder again and re-validates the whole set. Nothing is replayed; the next command starts
   * the new version lazily.
   */
  reloadSource(sourceKey: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#reloadSource(sourceKey));
  }

  /**
   * Leaves safe mode for the rest of the session: every development folder is read now and
   * enabled plugins start lazily on their next command.
   */
  leaveSafeMode(): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#leaveSafeMode());
  }

  async #addSource(source: DevelopmentSource): Promise<PluginActionResult> {
    const closed = this.#closed();
    if (closed) return closed;
    const sourceKey = developmentSourceKey(source.directory);
    if (this.#entryOf(sourceKey))
      return failure(
        "PLUGIN_E_SOURCE_EXISTS",
        `${path.resolve(source.directory)} is already loaded.`,
      );
    const read = await readSource(source, readOptions(this.options, this.#safeMode));
    const closedAfterRead = this.#closed();
    if (closedAfterRead) return closedAfterRead;
    this.#entries.push({ source, read, plugin: unresolved(read), generation: 0 });
    if (convertLegacy([read], this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #removeSource(sourceKey: string, forget: boolean): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "removed");
    if (refused) return refused;
    this.#entries = this.#entries.filter((entry) => entry.read.sourceKey !== sourceKey);
    if (forget && this.#disabled.delete(sourceKey)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #reloadSource(sourceKey: string): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "reloaded");
    if (refused) return refused;
    if (this.#safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restore plugins first, or restart without --safe-mode.",
      );
    const entry = this.#entryOf(sourceKey)!;
    // Block new commands and cancel running ones before the folder is read again.
    const supervisor = this.#supervisors.get(sourceKey);
    if (supervisor) {
      this.#supervisors.delete(sourceKey);
      for (const [command, owner] of this.#commands)
        if (owner === sourceKey) this.#commands.delete(command);
      this.#emitState();
      await this.#retire([supervisor], "cancelled");
    }
    entry.generation += 1;
    const read = await readSource(entry.source, readOptions(this.options, this.#safeMode));
    const closed = this.#closed();
    if (closed) return closed;
    entry.read = read;
    if (convertLegacy([read], this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #leaveSafeMode(): Promise<PluginActionResult> {
    const closed = this.#closed();
    if (closed) return closed;
    if (!this.#safeMode) return { ok: true, state: this.state() };
    const development = this.#entries.filter((entry) => entry.read.source === "development");
    const reads = await Promise.all(
      development.map((entry) => readSource(entry.source, readOptions(this.options, false))),
    );
    const closedAfterRead = this.#closed();
    if (closedAfterRead) return closedAfterRead;
    development.forEach((entry, index) => {
      entry.read = reads[index]!;
    });
    this.#safeMode = false;
    if (convertLegacy(reads, this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("disabled");
    return { ok: true, state: this.state() };
  }

  #refuseChange(sourceKey: string, verb: "removed" | "reloaded"): Failure | undefined {
    const closed = this.#closed();
    if (closed) return closed;
    const entry = this.#entryOf(sourceKey);
    if (!entry)
      return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No plugin source has the key ${sourceKey}.`);
    if (entry.read.source === "builtin")
      return failure(
        "PLUGIN_E_BUILTIN_REQUIRED",
        `${entry.plugin.id} is part of Kobrixa and cannot be ${verb}.`,
      );
    return undefined;
  }

  onEvent(listener: (event: PluginManagerEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** True while any plugin process is starting, running or stopping, including disabled ones. */
  get active(): boolean {
    return (
      this.#retiring.size > 0 ||
      [...this.#supervisors.values()].some((supervisor) =>
        ["starting", "running", "stopping"].includes(supervisor.state),
      )
    );
  }

  /**
   * Stops every plugin process, including plugins still being disabled, within deadlineMs.
   * Graceful stops run first; whatever is still alive at deadlineMs - PLUGIN_FORCE_MARGIN_MS is
   * force-killed, so callers can quit as soon as this resolves. Idempotent; afterwards commands
   * and changes are refused.
   */
  shutdown(deadlineMs: number = PLUGIN_SHUTDOWN_DEADLINE_MS): Promise<void> {
    this.#shutdown ??= (async () => {
      const supervisors = [...this.#supervisors.values(), ...this.#retiring];
      this.#supervisorsStopped = Promise.all(
        supervisors.map((supervisor) => supervisor.stop()),
      ).then(() => undefined);
      const stopped = this.#supervisorsStopped.then(() => true);
      const waitForStop = async (ms: number) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            stopped,
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), ms);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const forceAt = Math.max(0, deadlineMs - PLUGIN_FORCE_MARGIN_MS);
      if (await waitForStop(forceAt)) return;
      for (const supervisor of supervisors) supervisor.forceKill();
      await waitForStop(deadlineMs - forceAt);
    })();
    return this.#shutdown;
  }

  /**
   * Reopens plugin services after a shutdown that did not end the app, such as a failed update
   * installation. Stopped plugins restart lazily on their next command; nothing is replayed.
   */
  async resume(): Promise<void> {
    if (!this.#shutdown) return;
    await this.#shutdown.catch(() => undefined);
    await this.#supervisorsStopped?.catch(() => undefined);
    this.#supervisorsStopped = undefined;
    this.#shutdown = undefined;
    // A change interrupted by the shutdown may have left an enabled plugin without a supervisor.
    await this.#enqueue(() => this.#apply("cancelled"));
  }

  /** Changes are serialized so each one computes and saves the next state from the latest one. */
  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const change = this.#changes.then(work);
    this.#changes = change.catch(() => undefined);
    return change;
  }

  #closed(): Failure | undefined {
    return this.#shutdown
      ? failure("PLUGIN_E_SHUTTING_DOWN", "Kobrixa is shutting down plugins.")
      : undefined;
  }

  #entryOf(sourceKey: string): Entry | undefined {
    return this.#entries.find((entry) => entry.read.sourceKey === sourceKey);
  }

  /** Reconciles, publishes the new statuses at once, then waits for retired processes to stop. */
  async #apply(reason: StopReason): Promise<void> {
    const retired = this.#reconcile();
    this.#emitState();
    if (!retired.length) return;
    await this.#retire(retired, reason);
    this.#emitState();
  }

  /**
   * Recomputes every status from the whole set and keeps only the supervisors of plugins that
   * are still enabled. Returns the supervisors that must now stop.
   */
  #reconcile(): PluginSupervisor[] {
    const resolved = resolvePlugins(
      this.#entries.map((entry) => entry.read),
      { disabled: this.#disabled, safeMode: this.#safeMode },
    );
    const live = new Set<string>();
    this.#commands.clear();
    this.#entries.forEach((entry, index) => {
      entry.plugin = resolved[index]!;
      if (entry.plugin.status !== "enabled") return;
      const key = entry.read.sourceKey;
      live.add(key);
      if (!this.#supervisors.has(key)) this.#register(entry);
      if (this.#supervisors.has(key))
        for (const command of commandIds(entry.plugin)) this.#commands.set(command, key);
    });
    const retired: PluginSupervisor[] = [];
    for (const [key, supervisor] of this.#supervisors)
      if (!live.has(key)) {
        this.#supervisors.delete(key);
        retired.push(supervisor);
      }
    this.#rebuildHelp();
    return retired;
  }

  #rebuildHelp(): void {
    const budget = this.options.diagnosticHelpTotalBytes ?? DIAGNOSTIC_HELP_LIMITS.totalBytes;
    const enabled = this.#entries
      .filter((entry) => entry.plugin.status === "enabled")
      .sort((a, b) =>
        a.read.sourceKey < b.read.sourceKey ? -1 : a.read.sourceKey > b.read.sourceKey ? 1 : 0,
      );
    const key = enabled
      .map((entry) =>
        [
          entry.read.sourceKey,
          entry.generation,
          entry.plugin.id,
          JSON.stringify(entry.plugin.manifest?.displayName ?? null),
          Boolean(entry.read.diagnosticHelp),
        ].join("\t"),
      )
      .join("\n");
    if (key === this.#help.key) return;
    const contributors = enabled.filter((entry) => entry.read.diagnosticHelp);
    let total = 0;
    const catalog: DiagnosticHelpCatalog["plugins"] = [];
    const overBudget = new Set<string>();
    for (const entry of contributors) {
      const help = entry.read.diagnosticHelp!;
      if (total + help.bytes > budget) {
        overBudget.add(entry.read.sourceKey);
        continue;
      }
      total += help.bytes;
      catalog.push({
        source: entry.plugin.id,
        sourceKey: entry.read.sourceKey,
        entries: help.entries,
      });
    }
    this.#help = { revision: this.#help.revision + 1, key, catalog, overBudget };
  }

  async #retire(supervisors: readonly PluginSupervisor[], reason: StopReason): Promise<void> {
    await Promise.all(
      supervisors.map(async (supervisor) => {
        this.#retiring.add(supervisor);
        try {
          await supervisor.stop(reason);
        } finally {
          this.#retiring.delete(supervisor);
        }
      }),
    );
  }

  async #save(disabled: ReadonlySet<string>): Promise<void> {
    await this.options.store.save({ disabled, legacyDisabledIds: this.#legacy });
    this.#stateProblem = undefined;
  }

  async #saveBestEffort(): Promise<void> {
    try {
      await this.#save(this.#disabled);
    } catch {
      // Kept in memory; the next successful save writes it.
    }
  }

  #register(entry: Entry): void {
    const { plugin } = entry;
    const manifest = plugin.manifest;
    if (
      !manifest ||
      manifest.runtime.kind === "builtin" ||
      manifest.runtime.kind === "static" ||
      !plugin.entry ||
      !plugin.directory
    )
      return;
    const { sourceKey } = plugin;
    const generation = entry.generation;
    // A removed or reloaded source's old process must not reach the current row.
    const current = () => this.#entryOf(sourceKey)?.generation === generation;
    const supervisor = new PluginSupervisor(
      {
        id: plugin.id,
        sourceKey,
        directory: plugin.directory,
        entry: plugin.entry,
        runtime: manifest.runtime.kind,
        permissions: manifest.permissions ?? [],
        commands: commandIds(plugin),
      },
      this.options.launcher,
      {
        ...this.options.supervisor,
        locale: this.options.locale,
        onNotice: (notice) => {
          if (!current()) return;
          this.#emit({
            type: "notice",
            notice: {
              pluginId: plugin.id,
              sourceKey,
              ...notice,
              at: (this.options.now ?? Date.now)(),
            },
          });
        },
        onStateChange: () => {
          if (current()) this.#emitState();
        },
      },
    );
    this.#supervisors.set(sourceKey, supervisor);
  }

  #summary({ plugin }: Entry): PluginSummary {
    const supervisor = this.#supervisors.get(plugin.sourceKey);
    const manifest = plugin.manifest;
    return {
      sourceKey: plugin.sourceKey,
      id: plugin.id,
      source: plugin.source,
      ...(plugin.directory ? { directory: plugin.directory } : {}),
      ...(manifest ? { version: manifest.version, runtime: manifest.runtime.kind } : {}),
      ...(manifest?.displayName ? { displayName: manifest.displayName } : {}),
      status: supervisor?.state === "failed" ? "failed" : plugin.status,
      ...(plugin.disabledBy ? { disabledBy: plugin.disabledBy } : {}),
      running: supervisor?.state === "running",
      problems: [
        ...plugin.problems,
        ...(plugin.status === "enabled" && plugin.helpProblem ? [plugin.helpProblem] : []),
        ...(this.#help.overBudget.has(plugin.sourceKey)
          ? [
              {
                code: "PLUGIN_E_DIAGNOSTIC_HELP" as const,
                message: "Diagnostic help was not loaded because all plugins' help exceeds 8 MiB.",
              },
            ]
          : []),
        ...(supervisor?.problem ? [supervisor.problem] : []),
      ],
      commands:
        plugin.status === "enabled"
          ? (manifest?.contributes?.commands ?? []).map(({ id, title }) => ({ id, title }))
          : [],
    };
  }

  #emitState(): void {
    this.#revision += 1;
    this.#emit({ type: "state", state: this.state() });
  }

  #emit(event: PluginManagerEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener must not interrupt plugin lifecycle operations or other listeners.
      }
    }
  }
}
