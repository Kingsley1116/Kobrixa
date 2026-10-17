import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
  LocalizedText,
  PluginLocale,
  PluginDiagnosticHelpEntry,
} from "@kobrixa/plugin-protocol";
import {
  developmentSourceKey,
  messageOf,
  PluginManager,
  PluginError,
  type PluginProblem,
  readSource,
  type LaunchablePlugin,
  type PluginActionResult,
  type PluginCommandResult,
  type PluginErrorCode,
  type PluginLauncher,
  type PluginManagerOptions,
  type PluginPersistedState,
  type PluginsSnapshot,
  type PluginSource,
} from "@kobrixa/plugin-runtime";
import type {
  LogRead,
  PluginOrigin,
  PluginsResult,
  PluginsView,
  PluginsViewEvent,
  PythonChoice,
  PythonChoiceId,
  PythonProbe,
  StoredNotice,
} from "../../shared/plugins.js";
import { resolveDiagnosticHelp, type PluginHelpCatalogView } from "../../shared/diagnostic-help.js";
import type {
  StaticLanguagesCatalog,
  ReportLanguageRegistrationFailureInput,
  ReportLanguageRegistrationFailureResult,
} from "../../shared/static-languages.js";
import type { PluginDialogs } from "./dialogs.js";
import { createDesktopLauncher } from "./launchers.js";
import { PluginLogs, PluginNotices } from "./logs.js";
import type { PluginOptions } from "./options.js";
import {
  commandLabel,
  probePython,
  pythonCommands,
  sameCommand,
  type PythonCommand,
} from "./python.js";
import { SessionMarkerFile } from "./session.js";
import { filePluginStateStore, type PluginSettingsStore } from "./state-store.js";

type Failure = Extract<PluginsResult, { ok: false }>;
const failure = (code: PluginErrorCode, message: string): Failure => ({ ok: false, code, message });
const localized = (text: LocalizedText, locale: PluginLocale) =>
  typeof text === "string" ? text : locale === "zh-TW" ? (text["zh-TW"] ?? text.en) : text.en;

/** Keeps the first spelling of each folder, by source key. */
function uniqueDirectories(directories: readonly string[]): string[] {
  const seen = new Set<string>();
  return directories.filter((directory) => {
    const key = developmentSourceKey(directory);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export type PluginManagerPort = Pick<
  PluginManager,
  | "state"
  | "diagnosticHelp"
  | "staticLanguages"
  | "staticLanguagesRevision"
  | "reportLanguageRegistrationFailure"
  | "executeCommand"
  | "setEnabled"
  | "addSource"
  | "removeSource"
  | "reloadSource"
  | "leaveSafeMode"
  | "onEvent"
  | "active"
  | "shutdown"
  | "resume"
  | "resolveCompiler"
  | "resolveLanguageService"
>;
export interface PluginControllerDependencies {
  manager: PluginManagerPort;
  settings: Pick<PluginSettingsStore, "settings" | "update">;
  dialogs: PluginDialogs;
  logs: PluginLogs;
  notices: PluginNotices;
  marker: Pick<SessionMarkerFile, "update" | "finish" | "markThirdPartyStaticContributions">;
  probe(command: PythonCommand): Promise<PythonProbe>;
  realpath(directory: string): Promise<string>;
  locale: PluginLocale;
  platform: NodeJS.Platform;
  session: {
    /** Real paths from --plugin-dev-dir. */
    directories: readonly string[];
    /** --plugin-python, which overrides the saved choice for this session only. */
    python?: PythonCommand;
    /** --safe-mode, which lasts the whole session. */
    safeMode: boolean;
  };
}
type Extra = { persisted?: false; outcome?: "cancelled" | "duplicate"; sourceKey?: string };

/**
 * Decides whether a plugin change may happen (developer mode, safe mode, shutdown) and owns what
 * the runtime must not know about: native dialogs, user settings, Python probing, logs, notices
 * and the session marker. The renderer only ever sends source keys and ids.
 *
 * These checks stop a renderer from adding paths or executables the user never chose; they
 * cannot protect against a compromised renderer that the user keeps clicking through.
 */
export class PluginController {
  #revision = 0;
  #helpCatalog: PluginHelpCatalogView | undefined;
  #staticRiskRecorded = false;
  #staticSaveProblem: PluginProblem | undefined;
  #developer: boolean;
  #commandLine: boolean;
  #closing = false;
  readonly #inflight = new Map<string, Set<AbortController>>();
  #candidates = new Map<string, PythonCommand>();
  readonly #pendingReload = new Set<string>();
  readonly #listeners = new Set<(event: PluginsViewEvent) => void>();

  constructor(private readonly deps: PluginControllerDependencies) {
    const saved = deps.settings.settings().developerMode;
    this.#developer = saved || deps.session.directories.length > 0;
    this.#commandLine = !saved && deps.session.directories.length > 0;
    deps.manager.onEvent((event) => {
      if (event.type === "notice") {
        this.#emit({ type: "notice", notice: deps.notices.add(event.notice) });
        return;
      }
      deps.marker.update({ thirdPartyRunning: deps.manager.active });
      for (const plugin of event.state.plugins)
        if (!plugin.running) this.#pendingReload.delete(plugin.sourceKey);
      this.#emit({ type: "state", state: this.#view(event.state) });
    });
  }

  state(): PluginsView {
    return this.#view(this.deps.manager.state());
  }

  staticLanguages(): StaticLanguagesCatalog {
    const snapshot = this.deps.manager.state();
    const permitted = this.#permitThirdPartyStatic(snapshot);
    const catalog = this.deps.manager.staticLanguages();
    if (catalog.revision !== snapshot.staticLanguagesRevision)
      throw new Error("Static language catalog and owner snapshot revisions differ.");
    if (permitted) return catalog;
    const builtinKeys = new Set(
      snapshot.plugins
        .filter((plugin) => plugin.source === "builtin")
        .map((plugin) => plugin.sourceKey),
    );
    const languages = catalog.languages.filter((language) => builtinKeys.has(language.sourceKey));
    const ids = new Set(languages.map((language) => language.id));
    const extensions = new Set(languages.flatMap((language) => language.extensions));
    return {
      ...catalog,
      languages,
      // A former ambiguous route remains null; filtering never elects a new winner.
      extensionRoutes: Object.fromEntries(
        Object.entries(catalog.extensionRoutes).filter(([extension, id]) =>
          id === null ? extensions.has(extension) : ids.has(id),
        ),
      ),
      conflicts: catalog.conflicts.filter((conflict) =>
        conflict.sources.every((source) => builtinKeys.has(source.sourceKey)),
      ),
    };
  }

  reportLanguageRegistrationFailure(
    input: ReportLanguageRegistrationFailureInput,
  ): ReportLanguageRegistrationFailureResult {
    const catalog = this.staticLanguages();
    if (input.revision > catalog.revision) return { accepted: false, revision: catalog.revision };
    const snapshot = this.deps.manager.state();
    const owner = snapshot.staticLanguageOwners.find(
      (candidate) =>
        candidate.sourceKey === input.sourceKey &&
        candidate.languageId === input.languageId &&
        candidate.generation === input.generation,
    );
    const language = catalog.languages.find(
      (candidate) =>
        candidate.sourceKey === input.sourceKey &&
        candidate.id === input.languageId &&
        candidate.generation === input.generation,
    );
    const plugin = snapshot.plugins.find((candidate) => candidate.sourceKey === input.sourceKey);
    // Process failure preserves static eligibility while the delivered catalog
    // and complete owner identity remain
    // current. running/manager.active do not authorize or withdraw contributions.
    if (
      !owner ||
      !language ||
      !plugin ||
      (plugin.status !== "enabled" && plugin.status !== "failed") ||
      owner.pluginId !== language.pluginId ||
      plugin.id !== owner.pluginId
    ) {
      if (input.revision < catalog.revision) return { accepted: false, revision: catalog.revision };
      throw new PluginError(
        "PLUGIN_E_MANIFEST",
        "Registration report does not match a current static language owner.",
      );
    }
    // The manager owns atomic quarantine, host-authored structured problems, revision changes
    // and retry only after reload/explicit enable. Never call reload in response here.
    return this.deps.manager.reportLanguageRegistrationFailure(input);
  }

  #permitThirdPartyStatic(snapshot: PluginsSnapshot): boolean {
    if (snapshot.safeMode) return false;
    if (this.#staticSaveProblem) return false;
    const thirdParty = snapshot.staticLanguageOwners.some(
      (owner) =>
        !snapshot.plugins.some(
          (plugin) =>
            plugin.sourceKey === owner.sourceKey &&
            plugin.id === owner.pluginId &&
            plugin.source === "builtin",
        ),
    );
    if (!thirdParty || this.#staticRiskRecorded) return true;
    try {
      this.deps.marker.markThirdPartyStaticContributions();
      this.#staticRiskRecorded = true;
      return true;
    } catch {
      this.#staticSaveProblem = {
        code: "PLUGIN_E_STATE_SAVE",
        message:
          "Third-party static languages were withheld because the recovery marker could not be saved. Restart Kobrixa after restoring writable settings storage.",
      };
      return false;
    }
  }

  /** Clone the manager catalog only once per help revision, including for link lookups. */
  diagnosticHelp(): PluginHelpCatalogView {
    const snapshot = this.deps.manager.state();
    if (this.#helpCatalog?.revision === snapshot.diagnosticHelpRevision) return this.#helpCatalog;
    const catalog = this.deps.manager.diagnosticHelp();
    const plugins: PluginHelpCatalogView["plugins"] = Object.create(null);
    for (const plugin of snapshot.plugins)
      if (plugin.status === "enabled")
        plugins[plugin.id] = {
          ...(plugin.displayName ? { displayName: plugin.displayName } : {}),
          entries: [],
        };
    for (const item of catalog.plugins)
      plugins[item.source] = { ...plugins[item.source], entries: item.entries };
    this.#helpCatalog = { revision: catalog.revision, plugins };
    return this.#helpCatalog;
  }

  diagnosticHelpEntry(
    source: string,
    code: string,
    helpKey?: string,
  ): PluginDiagnosticHelpEntry | undefined {
    const resolved = resolveDiagnosticHelp(
      { source, code, ...(helpKey ? { helpKey } : {}) },
      this.diagnosticHelp(),
    );
    return resolved?.kind === "plugin" ? resolved.entry : undefined;
  }

  notices(): StoredNotice[] {
    return this.deps.notices.list();
  }

  readLog(sourceKey: string, after: number): LogRead {
    return this.deps.logs.read(sourceKey, after);
  }

  /** The interpreter the launcher uses for the next Python plugin process. */
  python(): PythonCommand | undefined {
    return this.#currentPython()?.command;
  }

  get active(): boolean {
    return this.deps.manager.active;
  }

  resolveCompiler(language: string, target: string): ReturnType<PluginManager["resolveCompiler"]> {
    return this.deps.manager.resolveCompiler(language, target);
  }

  resolveLanguageService(language: string): ReturnType<PluginManager["resolveLanguageService"]> {
    return this.deps.manager.resolveLanguageService(language);
  }

  onEvent(listener: (event: PluginsViewEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async execute(commandId: string): Promise<PluginCommandResult> {
    const owner = this.deps.manager
      .state()
      .plugins.find((plugin) =>
        plugin.commands.some((command) => command.id === commandId),
      )?.sourceKey;
    if (!owner) return this.deps.manager.executeCommand(commandId);
    const abort = new AbortController();
    const running = this.#inflight.get(owner) ?? new Set<AbortController>();
    this.#inflight.set(owner, running);
    running.add(abort);
    this.#changed();
    try {
      return await this.deps.manager.executeCommand(commandId, abort.signal);
    } finally {
      running.delete(abort);
      if (running.size === 0 && this.#inflight.get(owner) === running) this.#inflight.delete(owner);
      this.#changed();
    }
  }

  /** Cancels this source's in-flight commands through the protocol's cancellation. */
  cancel(sourceKey: string): void {
    for (const abort of this.#inflight.get(sourceKey) ?? []) abort.abort();
  }

  async setEnabled(sourceKey: string, enabled: boolean): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: enabled });
    if (refused) return refused;
    return this.#result(await this.deps.manager.setEnabled(sourceKey, enabled));
  }

  async setDeveloperMode(enabled: boolean): Promise<PluginsResult> {
    const refused = this.#refuse({});
    if (refused) return refused;
    if (enabled === this.#developer) return this.#ok();
    if (enabled) {
      if (!(await this.deps.dialogs.confirmDeveloperMode()))
        return this.#ok({ outcome: "cancelled" });
      const closed = this.#refuse({});
      if (closed) return closed;
      try {
        await this.deps.settings.update((current) => ({ ...current, developerMode: true }));
      } catch (error) {
        return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
      }
      this.#developer = true;
      this.#commandLine = false;
      for (const directory of this.#directories())
        await this.deps.manager.addSource({ kind: "development", directory });
      this.#changed();
      return this.#ok();
    }
    let persisted = true;
    try {
      await this.deps.settings.update((current) => ({ ...current, developerMode: false }));
    } catch {
      // Turning off still applies now, like disabling a plugin.
      persisted = false;
    }
    this.#developer = false;
    this.#commandLine = false;
    for (const plugin of this.deps.manager.state().plugins)
      if (plugin.source === "development")
        await this.deps.manager.removeSource(plugin.sourceKey, { forget: false });
    this.#pendingReload.clear();
    this.#changed();
    return this.#ok(persisted ? {} : { persisted: false });
  }

  async linkFolder(): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    const picked = await this.deps.dialogs.chooseFolder();
    return picked === undefined ? this.#ok({ outcome: "cancelled" }) : this.#link(picked);
  }

  /** Points a linked source whose folder moved or broke at another folder. */
  async relinkFolder(sourceKey: string): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    if (!this.#linked().has(sourceKey))
      return failure("PLUGIN_E_SESSION_SOURCE", "Only linked folders can be pointed elsewhere.");
    const picked = await this.deps.dialogs.chooseFolder();
    return picked === undefined
      ? this.#ok({ outcome: "cancelled" })
      : this.#link(picked, sourceKey);
  }

  async unlink(sourceKey: string): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true });
    if (refused) return refused;
    const directory = this.#linked().get(sourceKey);
    if (directory === undefined)
      return failure(
        "PLUGIN_E_SESSION_SOURCE",
        "Folders from --plugin-dev-dir cannot be unlinked; start Kobrixa without that option instead.",
      );
    const plugin = this.deps.manager.state().plugins.find((item) => item.sourceKey === sourceKey);
    const name = plugin?.displayName
      ? localized(plugin.displayName, this.deps.locale)
      : (plugin?.id ?? path.basename(directory));
    if (!(await this.deps.dialogs.confirmUnlink({ name, directory })))
      return this.#ok({ outcome: "cancelled" });
    const closed = this.#refuse({ developer: true });
    if (closed) return closed;
    const removed = await this.deps.manager.removeSource(sourceKey);
    if (!removed.ok && removed.code !== "PLUGIN_E_UNKNOWN_PLUGIN") return removed;
    let persisted = true;
    try {
      await this.deps.settings.update((current) => ({
        ...current,
        sources: current.sources.filter(
          (source) => developmentSourceKey(source.directory) !== sourceKey,
        ),
      }));
    } catch {
      persisted = false;
    }
    this.#clear(sourceKey);
    this.#changed();
    return this.#ok(persisted ? {} : { persisted: false });
  }

  async reload(sourceKey: string): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    this.#pendingReload.delete(sourceKey);
    return this.#result(await this.deps.manager.reloadSource(sourceKey));
  }

  async pythonCandidates(): Promise<PythonChoice[]> {
    const commands = pythonCommands(this.deps.platform, this.deps.settings.settings().python);
    const probes = await Promise.all(commands.map(({ command }) => this.deps.probe(command)));
    const current = this.#currentPython()?.command;
    this.#candidates = new Map(commands.map(({ id, command }) => [id, command]));
    return commands.map(({ id, command }, index) => ({
      id,
      label: commandLabel(command),
      selected: current !== undefined && sameCommand(current, command),
      probe: probes[index]!,
    }));
  }

  async setPython(id: PythonChoiceId): Promise<PluginsResult> {
    const refused = this.#refuse({ developer: true });
    if (refused) return refused;
    let command: PythonCommand | undefined;
    if (id === "other") {
      const picked = await this.deps.dialogs.choosePython();
      if (picked === undefined) return this.#ok({ outcome: "cancelled" });
      command = { executable: picked, args: [] };
    } else command = this.#candidates.get(id);
    if (!command)
      return failure("PLUGIN_E_PYTHON_UNUSABLE", "Refresh the interpreter list and choose again.");
    // Probe again: the list may be stale and "other" was never probed.
    const probe = await this.deps.probe(command);
    if (probe.status === "error")
      return failure(
        "PLUGIN_E_PYTHON_UNUSABLE",
        `${commandLabel(command)}: ${probe.detail ?? probe.problem ?? "unusable"}`,
      );
    const closed = this.#refuse({ developer: true });
    if (closed) return closed;
    const chosen = command;
    try {
      await this.deps.settings.update((current) => ({ ...current, python: chosen }));
    } catch (error) {
      return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    }
    if (!this.deps.session.python)
      for (const plugin of this.deps.manager.state().plugins)
        if (plugin.runtime === "python" && plugin.running)
          this.#pendingReload.add(plugin.sourceKey);
    this.#changed();
    return this.#ok();
  }

  /** "Restore plugins": removes the lock and, unless --safe-mode was given, leaves safe mode. */
  async clearSafeModeLock(): Promise<PluginsResult> {
    const refused = this.#refuse({});
    if (refused) return refused;
    if (this.deps.settings.settings().safeModeLock) {
      try {
        await this.deps.settings.update((current) => {
          const next = { ...current };
          delete next.safeModeLock;
          return next;
        });
      } catch (error) {
        return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
      }
    }
    if (!this.deps.session.safeMode) {
      const left = await this.deps.manager.leaveSafeMode();
      if (!left.ok) return left;
    }
    this.#changed();
    return this.#ok();
  }

  shutdown(deadlineMs?: number): Promise<void> {
    this.#closing = true;
    return this.deps.manager.shutdown(deadlineMs);
  }

  async resume(): Promise<void> {
    await this.deps.manager.resume();
    this.#closing = false;
    this.#changed();
  }

  markRendererUnresponsive(): void {
    if (
      !this.#staticRiskRecorded &&
      !this.deps.manager.state().plugins.some((plugin) => plugin.source === "development")
    )
      return;
    this.deps.marker.update({ rendererUnresponsive: true });
  }

  /** Call from Electron's quit event, after plugins were shut down. */
  finishSession(): void {
    this.deps.marker.finish();
  }

  async #link(picked: string, replacing?: string): Promise<PluginsResult> {
    let directory: string;
    try {
      directory = await this.deps.realpath(picked);
    } catch (error) {
      return failure("PLUGIN_E_MANIFEST", `${picked} cannot be opened: ${messageOf(error)}`);
    }
    const sourceKey = developmentSourceKey(directory);
    if (sourceKey !== replacing && this.#linked().has(sourceKey))
      return this.#ok({ outcome: "duplicate", sourceKey });
    const read = await readSource({ kind: "development", directory }, { safeMode: false });
    const confirmed = await this.deps.dialogs.confirmLink({
      name: read.manifest?.displayName
        ? localized(read.manifest.displayName, this.deps.locale)
        : read.id,
      id: read.id,
      ...(read.manifest ? { runtime: read.manifest.runtime.kind } : {}),
      directory,
      problems: read.problems.map((problem) => problem.message),
    });
    if (!confirmed) return this.#ok({ outcome: "cancelled" });
    // The dialog may have stayed open while Kobrixa started quitting or changed mode.
    const refused = this.#refuse({ developer: true, outsideSafeMode: true });
    if (refused) return refused;
    try {
      await this.deps.settings.update((current) => ({
        ...current,
        sources:
          replacing === undefined
            ? current.sources.some((source) => developmentSourceKey(source.directory) === sourceKey)
              ? current.sources
              : [...current.sources, { directory }]
            : current.sources.map((source) =>
                developmentSourceKey(source.directory) === replacing ? { directory } : source,
              ),
      }));
    } catch (error) {
      return failure("PLUGIN_E_STATE_SAVE", messageOf(error));
    }
    if (replacing !== undefined && replacing !== sourceKey) {
      await this.deps.manager.removeSource(replacing);
      this.#clear(replacing);
    }
    const result =
      replacing === sourceKey
        ? await this.deps.manager.reloadSource(sourceKey)
        : await this.deps.manager.addSource({ kind: "development", directory });
    this.#changed();
    // A --plugin-dev-dir folder is already loaded; linking it only makes it permanent.
    if (!result.ok && result.code !== "PLUGIN_E_SOURCE_EXISTS") return result;
    return this.#ok({ sourceKey });
  }

  #refuse(needs: { developer?: boolean; outsideSafeMode?: boolean }): Failure | undefined {
    if (this.#closing)
      return failure("PLUGIN_E_SHUTTING_DOWN", "Kobrixa is shutting down plugins.");
    if (needs.developer && !this.#developer)
      return failure(
        "PLUGIN_E_DEVELOPER_MODE",
        "Turn on developer mode under Settings → Plugins first.",
      );
    if (needs.outsideSafeMode && this.deps.manager.state().safeMode)
      return failure(
        "PLUGIN_E_SAFE_MODE",
        "Plugins are paused in safe mode. Restore plugins first.",
      );
    return undefined;
  }

  #linked(): Map<string, string> {
    return new Map(
      this.deps.settings
        .settings()
        .sources.map((source) => [developmentSourceKey(source.directory), source.directory]),
    );
  }

  /** Saved links first, then command-line folders that are not also saved. */
  #directories(): string[] {
    return uniqueDirectories([
      ...this.deps.settings.settings().sources.map((source) => source.directory),
      ...this.deps.session.directories,
    ]);
  }

  #currentPython(): { command: PythonCommand; origin: "settings" | "command-line" } | undefined {
    if (this.deps.session.python)
      return { command: this.deps.session.python, origin: "command-line" };
    const saved = this.deps.settings.settings().python;
    return saved ? { command: saved, origin: "settings" } : undefined;
  }

  #clear(sourceKey: string): void {
    this.deps.logs.clear(sourceKey);
    this.deps.notices.clear(sourceKey);
    this.#pendingReload.delete(sourceKey);
  }

  #result(result: PluginActionResult): PluginsResult {
    if (!result.ok) return result;
    return this.#ok(result.persisted === false ? { persisted: false } : {});
  }

  #ok(extra: Extra = {}): PluginsResult {
    return { ok: true, state: this.state(), ...extra };
  }

  #view(snapshot: PluginsSnapshot): PluginsView {
    const permitted = this.#permitThirdPartyStatic(snapshot);
    if (!permitted) {
      const builtinKeys = new Set(
        snapshot.plugins
          .filter((plugin) => plugin.source === "builtin")
          .map((plugin) => plugin.sourceKey),
      );
      const problem = this.#staticSaveProblem;
      snapshot = {
        ...snapshot,
        staticLanguageOwners: snapshot.staticLanguageOwners.filter((owner) =>
          builtinKeys.has(owner.sourceKey),
        ),
        ...(problem && !snapshot.stateProblem ? { stateProblem: problem } : {}),
        plugins: snapshot.plugins.map((plugin) =>
          problem && plugin.source === "development"
            ? { ...plugin, problems: [...plugin.problems, problem] }
            : plugin,
        ),
      };
    }
    const settings = this.deps.settings.settings();
    const linked = this.#linked();
    const current = this.#currentPython();
    return {
      ...snapshot,
      // Both parts only increase, so the sum does too.
      revision: snapshot.revision + this.#revision,
      developer: {
        enabled: this.#developer,
        commandLine: this.#commandLine,
        linkedCount: settings.sources.length,
      },
      ...(settings.safeModeLock ? { safeModeLock: settings.safeModeLock } : {}),
      origins: Object.fromEntries(
        snapshot.plugins.map((plugin): [string, PluginOrigin] => [
          plugin.sourceKey,
          plugin.source === "builtin"
            ? "builtin"
            : linked.has(plugin.sourceKey)
              ? "linked"
              : "session",
        ]),
      ),
      python: {
        ...(current
          ? { current: { label: commandLabel(current.command), origin: current.origin } }
          : {}),
        pendingReload: [...this.#pendingReload],
      },
      inflight: [...this.#inflight.keys()],
    };
  }

  #changed(): void {
    this.#revision += 1;
    this.#emit({ type: "state", state: this.state() });
  }

  #emit(event: PluginsViewEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A listener must not interrupt plugin changes or other listeners.
      }
    }
  }
}

export interface StartPluginsOptions {
  userData: string;
  builtins: readonly PluginSource[];
  commandLine: PluginOptions;
  dialogs: PluginDialogs;
  locale: PluginLocale;
  /** Defaults to the Electron launcher. Receives the live Python choice and the log hook. */
  launcher?: (hooks: {
    python: () => PythonCommand | undefined;
    onOutput: (plugin: LaunchablePlugin, line: string) => void;
  }) => PluginLauncher;
  probe?(command: PythonCommand): Promise<PythonProbe>;
  realpath?(directory: string): Promise<string>;
  platform?: NodeJS.Platform;
  now?(): Date;
  supervisor?: PluginManagerOptions["supervisor"];
}

/**
 * Loads settings, checks how the previous session ended, then creates the manager with the
 * sources developer mode allows. A crash while third-party plugins ran, or a hung renderer,
 * locks safe mode until the user restores plugins.
 */
export async function startPlugins(options: StartPluginsOptions): Promise<PluginController> {
  const now = options.now ?? (() => new Date());
  const settings = filePluginStateStore(options.userData, { now });
  let loaded: PluginPersistedState & { problem?: string };
  try {
    loaded = await settings.load();
  } catch (error) {
    loaded = { disabled: new Set(), legacyDisabledIds: new Set(), problem: messageOf(error) };
  }
  const marker = new SessionMarkerFile(options.userData, now);
  const unclean = marker.begin();
  const resolve = options.realpath ?? ((directory: string) => realpath(directory));
  const document = settings.settings();
  const requestedDirectories = options.commandLine.developmentDirectories.map((directory) =>
    path.resolve(directory),
  );
  const developer = document.developerMode || requestedDirectories.length > 0;
  const hasDevelopmentSources =
    developer && (document.sources.length > 0 || requestedDirectories.length > 0);
  const relevantUnclean =
    hasDevelopmentSources || marker.previousThirdPartyStaticContributions ? unclean : undefined;
  const lock = document.safeModeLock;
  if (
    relevantUnclean &&
    (!lock || (relevantUnclean === "renderer-unresponsive" && lock.reason !== relevantUnclean))
  )
    await settings
      .update((current) => ({
        ...current,
        safeModeLock: { since: now().toISOString(), reason: relevantUnclean },
      }))
      .catch(() => undefined);
  const safeMode =
    options.commandLine.safeMode ||
    loaded.problem !== undefined ||
    relevantUnclean !== undefined ||
    settings.settings().safeModeLock !== undefined;
  // path.resolve is lexical only. Safe mode must not even realpath a development folder.
  const sessionDirectories = safeMode
    ? requestedDirectories
    : await Promise.all(
        requestedDirectories.map((directory) => resolve(directory).catch(() => directory)),
      );
  const directories = developer
    ? uniqueDirectories([
        ...document.sources.map((source) => source.directory),
        ...sessionDirectories,
      ])
    : [];
  const logs = new PluginLogs();
  const created: { controller?: PluginController } = {};
  const hooks = {
    python: () => created.controller?.python(),
    onOutput: (plugin: LaunchablePlugin, line: string) => {
      logs.append(plugin.sourceKey ?? `builtin:${plugin.id}`, line);
      console.error(`[plugin ${plugin.id}] ${line}`);
    },
  };
  const manager = await PluginManager.create({
    sources: [
      ...options.builtins,
      ...directories.map((directory) => ({ kind: "development" as const, directory })),
    ],
    // Already loaded above, so the manager sees the same result, including a corrupt file.
    store: { load: async () => loaded, save: (state) => settings.save(state) },
    safeMode,
    launcher: (options.launcher ?? createDesktopLauncher)(hooks),
    locale: options.locale,
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
  });
  const commandLinePython = options.commandLine.python;
  const controller = new PluginController({
    manager,
    settings,
    dialogs: options.dialogs,
    logs,
    notices: new PluginNotices(),
    marker,
    probe: options.probe ?? ((command) => probePython(command)),
    realpath: resolve,
    locale: options.locale,
    platform: options.platform ?? process.platform,
    session: {
      directories: sessionDirectories,
      ...(commandLinePython === undefined
        ? {}
        : { python: { executable: commandLinePython, args: [] } }),
      safeMode: options.commandLine.safeMode,
    },
  });
  created.controller = controller;
  return controller;
}
