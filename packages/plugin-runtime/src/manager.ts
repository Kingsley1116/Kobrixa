import type { LocalizedText, PluginLocale, Severity } from "@kobrixa/plugin-protocol";
import { messageOf, PluginError, type PluginErrorCode, type PluginProblem } from "./errors.js";
import { loadPlugins, type PluginSource, type RegisteredPlugin } from "./registry.js";
import { PluginSupervisor, type PluginLauncher, type SupervisorOptions } from "./supervisor.js";

export interface PluginStateStore {
  load(): Promise<Set<string>>;
  save(disabled: ReadonlySet<string>): Promise<void>;
}
export interface PluginManagerOptions {
  sources: readonly PluginSource[];
  store: PluginStateStore;
  safeMode: boolean;
  launcher: PluginLauncher;
  locale: PluginLocale;
  supervisor?: Omit<SupervisorOptions, "locale" | "onNotice" | "onStateChange">;
  now?(): number;
}
export interface PluginSummary {
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
  safeMode: boolean;
  developmentMode: boolean;
  plugins: PluginSummary[];
}
export interface PluginNotice {
  pluginId: string;
  severity: Severity;
  message: string;
  at: number;
}
export type PluginManagerEvent =
  { type: "state"; state: PluginsSnapshot } | { type: "notice"; notice: PluginNotice };
type Failure = { ok: false; code: PluginErrorCode; message: string };
export type PluginCommandResult = { ok: true } | Failure;
export type PluginActionResult = { ok: true; state: PluginsSnapshot } | Failure;
const failure = (code: PluginErrorCode, message: string): Failure => ({ ok: false, code, message });
/** Default overall bound for shutdown(); the quit cleanup waits slightly longer (task 12). */
export const PLUGIN_SHUTDOWN_DEADLINE_MS = 4_000;
/** Time between force-killing leftovers and the deadline, for exit reports to arrive. */
export const PLUGIN_FORCE_MARGIN_MS = 1_000;

export class PluginManager {
  readonly #supervisors = new Map<string, PluginSupervisor>();
  /** Supervisors of plugins being disabled stay tracked until their processes are gone. */
  readonly #retiring = new Set<PluginSupervisor>();
  readonly #commands = new Map<string, string>();
  readonly #listeners = new Set<(event: PluginManagerEvent) => void>();
  #shutdown: Promise<void> | undefined;
  #changes: Promise<unknown> = Promise.resolve();

  static async create(options: PluginManagerOptions): Promise<PluginManager> {
    const disabled = await options.store.load();
    const plugins = await loadPlugins(options.sources, { disabled, safeMode: options.safeMode });
    return new PluginManager(options, disabled, plugins);
  }

  private constructor(
    private readonly options: PluginManagerOptions,
    private disabled: Set<string>,
    private readonly plugins: RegisteredPlugin[],
  ) {
    for (const plugin of plugins) if (plugin.status === "enabled") this.#register(plugin);
  }

  state(): PluginsSnapshot {
    return {
      safeMode: this.options.safeMode,
      developmentMode: this.plugins.some((plugin) => plugin.source === "development"),
      plugins: this.plugins.map((plugin) => this.#summary(plugin)),
    };
  }

  frontendFor(language: string): string | undefined {
    return this.plugins.find(
      (plugin) =>
        plugin.status === "enabled" &&
        plugin.manifest?.contributes?.frontends?.some((item) => item.language === language),
    )?.id;
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

  /** Changes are serialized so each one computes and saves the next state from the latest one. */
  setEnabled(pluginId: string, enabled: boolean): Promise<PluginActionResult> {
    const change = this.#changes.then(() => this.#setEnabled(pluginId, enabled));
    this.#changes = change.catch(() => undefined);
    return change;
  }

  async #setEnabled(pluginId: string, enabled: boolean): Promise<PluginActionResult> {
    if (this.#shutdown) return failure("PLUGIN_E_DISABLED", "Kobrixa is shutting down plugins.");
    const plugin = this.plugins.find((item) => item.id === pluginId && item.status !== "invalid");
    if (!plugin)
      return failure("PLUGIN_E_UNKNOWN_PLUGIN", `No valid plugin has the id ${pluginId}.`);
    if (plugin.source === "builtin")
      return failure(
        "PLUGIN_E_BUILTIN_REQUIRED",
        `${pluginId} is part of Kobrixa and cannot be disabled in this version.`,
      );
    if (enabled && this.options.safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Restart Kobrixa without --safe-mode to enable development plugins.",
      );
    const unchanged = enabled ? plugin.status === "enabled" : this.disabled.has(pluginId);
    if (unchanged) return { ok: true, state: this.state() };
    const next = new Set(this.disabled);
    if (enabled) next.delete(pluginId);
    else next.add(pluginId);
    try {
      await this.options.store.save(next);
    } catch (error) {
      return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    }
    this.disabled = next;
    if (enabled) {
      plugin.status = "enabled";
      delete plugin.disabledBy;
      this.#register(plugin);
    } else {
      const supervisor = this.#supervisors.get(pluginId);
      this.#supervisors.delete(pluginId);
      for (const [command, owner] of this.#commands)
        if (owner === pluginId) this.#commands.delete(command);
      plugin.status = "disabled";
      plugin.disabledBy = "user";
      if (supervisor) {
        this.#retiring.add(supervisor);
        try {
          await supervisor.stop();
        } finally {
          this.#retiring.delete(supervisor);
        }
      }
    }
    this.#emitState();
    return { ok: true, state: this.state() };
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
   * and enable/disable requests are refused.
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

  #register(plugin: RegisteredPlugin): void {
    const manifest = plugin.manifest;
    if (!manifest || manifest.runtime.kind === "builtin" || !plugin.entry || !plugin.directory)
      return;
    const commands = (manifest.contributes?.commands ?? []).map((command) => command.id);
    const supervisor = new PluginSupervisor(
      {
        id: plugin.id,
        directory: plugin.directory,
        entry: plugin.entry,
        runtime: manifest.runtime.kind,
        permissions: manifest.permissions ?? [],
        commands,
      },
      this.options.launcher,
      {
        ...this.options.supervisor,
        locale: this.options.locale,
        onNotice: (notice) =>
          this.#emit({
            type: "notice",
            notice: { pluginId: plugin.id, ...notice, at: (this.options.now ?? Date.now)() },
          }),
        onStateChange: () => this.#emitState(),
      },
    );
    this.#supervisors.set(plugin.id, supervisor);
    for (const command of commands) this.#commands.set(command, plugin.id);
  }

  #summary(plugin: RegisteredPlugin): PluginSummary {
    const supervisor = this.#supervisors.get(plugin.id);
    const manifest = plugin.manifest;
    return {
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
