import path from "node:path";
import type { LocalizedText, PluginLocale, Severity } from "@kobrixa/plugin-protocol";
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
  now?(): number;
}
export interface PluginSummary {
  sourceKey: string;
  id: string;
  source: "builtin" | "development";
  directory?: string;
  version?: string;
  runtime?: "builtin" | "node" | "python";
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
  safeMode: boolean;
  developmentMode: boolean;
  /** The settings file was corrupt or unreadable; cleared by the next successful save. */
  stateProblem?: PluginProblem;
  plugins: PluginSummary[];
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
const readOptions = (options: PluginManagerOptions) => ({
  safeMode: options.safeMode,
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
  #changes: Promise<unknown> = Promise.resolve();
  #revision = 0;
  #disabled: Set<string>;
  readonly #legacy: Set<string>;
  #stateProblem: PluginProblem | undefined;

  static async create(options: PluginManagerOptions): Promise<PluginManager> {
    let stored: PluginPersistedState & { problem?: string };
    try {
      stored = await options.store.load();
    } catch (error) {
      stored = { disabled: new Set(), legacyDisabledIds: new Set(), problem: messageOf(error) };
    }
    const reads = await Promise.all(
      options.sources.map((source) => readSource(source, readOptions(options))),
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
      safeMode: this.options.safeMode,
      developmentMode: this.#entries.some((entry) => entry.read.source === "development"),
      ...(this.#stateProblem ? { stateProblem: this.#stateProblem } : {}),
      plugins: this.#entries.map((entry) => this.#summary(entry)),
    };
  }

  frontendFor(language: string): string | undefined {
    return this.#entries.find(
      ({ plugin }) =>
        plugin.status === "enabled" &&
        plugin.manifest?.contributes?.frontends?.some((item) => item.language === language),
    )?.plugin.id;
  }

  async executeCommand(commandId: string): Promise<PluginCommandResult> {
    if (this.#shutdown) return failure("PLUGIN_E_DISABLED", "Kobrixa is shutting down plugins.");
    const owner = this.#commands.get(commandId);
    const supervisor = owner ? this.#supervisors.get(owner) : undefined;
    if (!supervisor)
      return failure("PLUGIN_E_UNKNOWN_COMMAND", `No enabled plugin contributes ${commandId}.`);
    try {
      await supervisor.executeCommand(commandId);
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
    if (enabled && this.options.safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restart Kobrixa without --safe-mode to enable development plugins.",
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

  /** Stops and unregisters a development source. Its files are never touched. */
  removeSource(sourceKey: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#removeSource(sourceKey));
  }

  /**
   * Cancels the source's running commands, stops its process within the stop bound, then reads
   * its folder again and re-validates the whole set. Nothing is replayed; the next command starts
   * the new version lazily.
   */
  reloadSource(sourceKey: string): Promise<PluginActionResult> {
    return this.#enqueue(() => this.#reloadSource(sourceKey));
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
    const read = await readSource(source, readOptions(this.options));
    const closedAfterRead = this.#closed();
    if (closedAfterRead) return closedAfterRead;
    this.#entries.push({ source, read, plugin: unresolved(read), generation: 0 });
    if (convertLegacy([read], this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #removeSource(sourceKey: string): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "removed");
    if (refused) return refused;
    this.#entries = this.#entries.filter((entry) => entry.read.sourceKey !== sourceKey);
    if (this.#disabled.delete(sourceKey)) await this.#saveBestEffort();
    await this.#apply("cancelled");
    return { ok: true, state: this.state() };
  }

  async #reloadSource(sourceKey: string): Promise<PluginActionResult> {
    const refused = this.#refuseChange(sourceKey, "reloaded");
    if (refused) return refused;
    if (this.options.safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restart Kobrixa without safe mode to reload development plugins.",
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
    const read = await readSource(entry.source, readOptions(this.options));
    const closed = this.#closed();
    if (closed) return closed;
    entry.read = read;
    if (convertLegacy([read], this.#disabled, this.#legacy)) await this.#saveBestEffort();
    await this.#apply("cancelled");
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
      const stopped = Promise.all(supervisors.map((supervisor) => supervisor.stop())).then(
        () => true,
      );
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
    this.#shutdown = undefined;
    this.#emitState();
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
      { disabled: this.#disabled, safeMode: this.options.safeMode },
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
    return retired;
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
    if (!manifest || manifest.runtime.kind === "builtin" || !plugin.entry || !plugin.directory)
      return;
    const { sourceKey } = plugin;
    const generation = entry.generation;
    // A removed or reloaded source's old process must not reach the current row.
    const current = () => this.#entryOf(sourceKey)?.generation === generation;
    const supervisor = new PluginSupervisor(
      {
        id: plugin.id,
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
      problems: [...plugin.problems, ...(supervisor?.problem ? [supervisor.problem] : [])],
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
