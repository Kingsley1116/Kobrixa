import type {
  Permission as ImportedPermission,
  ResourceOwner as ImportedResourceOwner,
} from "@kobrixa/plugin-protocol";
import type { CoreWindowScope as ImportedCoreWindowScope } from "@kobrixa/plugin-runtime";
import type { DeviceEvent as ImportedDeviceEvent } from "../../shared/api.js";
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
  | "migrateSourceDisable"
  | "addSource"
  | "removeSource"
  | "reloadSource"
  | "leaveSafeMode"
  | "onEvent"
  | "active"
  | "thirdPartyActive"
  | "uiCatalogSources"
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
  marker: Pick<
    SessionMarkerFile,
    "update" | "finish" | "markThirdPartyStaticContributions" | "markThirdPartyUiContributions"
  >;
  probe(command: PythonCommand): Promise<PythonProbe>;
  realpath(directory: string): Promise<string>;
  locale: PluginLocale;
  platform: NodeJS.Platform;
  session: {
    /** Real paths from --plugin-dev-dir; unresolved until restoration in safe mode. */
    directories: readonly string[];
    /** --plugin-python, which overrides the saved choice for this session only. */
    python?: PythonCommand;
    /** --safe-mode, which lasts the whole session. */
    safeMode: boolean;
    /** A startup resolution or migration failure that kept the session in recovery. */
    problem?: PluginProblem;
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
  #preparingUpdate = false;
  #changes: Promise<unknown> = Promise.resolve();
  #restoring: Promise<PluginsResult> | undefined;
  #sessionProblem: PluginProblem | undefined;
  readonly #resolvedKeys = new Map<string, string>();
  readonly #inflight = new Map<string, Set<AbortController>>();
  #candidates = new Map<string, PythonCommand>();
  readonly #pendingReload = new Set<string>();
  readonly #listeners = new Set<(event: PluginsViewEvent) => void>();

  constructor(private readonly deps: PluginControllerDependencies) {
    this.#sessionProblem = deps.session.problem;
    const saved = deps.settings.settings().developerMode;
    this.#developer = saved || deps.session.directories.length > 0;
    this.#commandLine = !saved && deps.session.directories.length > 0;
    deps.manager.onEvent((event) => {
      if (event.type === "notice") {
        this.#emit({ type: "notice", notice: deps.notices.add(event.notice) });
        return;
      }
      deps.marker.update({
        thirdPartyRunning: deps.manager.thirdPartyActive,
      });
      for (const plugin of event.state.plugins)
        if (!plugin.running) this.#pendingReload.delete(plugin.sourceKey);
      this.#emit({ type: "state", state: this.#view(event.state) });
    });
  }

  uiCatalogSources(): readonly UiCatalogSource[] {
    return this.deps.manager.uiCatalogSources();
  }
  markThirdPartyUiContributions(sourceKey: string): void {
    const plugin = this.deps.manager.state().plugins.find((item) => item.sourceKey === sourceKey);
    if (!plugin || plugin.status !== "enabled")
      throw new PluginError("PLUGIN_E_DISABLED", "UI source is unavailable.");
    if (plugin.source === "development") this.deps.marker.markThirdPartyUiContributions();
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
    const refused = this.#refuse({});
    if (refused) return refused;
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
    return this.#enqueue(() => this.#setEnabled(this.#currentSourceKey(sourceKey), enabled));
  }

  async #setEnabled(sourceKey: string, enabled: boolean): Promise<PluginsResult> {
    const source = this.deps.manager.state().plugins.find((item) => item.sourceKey === sourceKey);
    const optionalBuiltin =
      source?.sourceKey.startsWith("builtin:") === true && source.canToggle && !source.required;
    const refused = this.#refuse({
      developer: enabled && !optionalBuiltin,
      outsideSafeMode: optionalBuiltin,
    });
    if (refused) return refused;
    return this.#result(await this.deps.manager.setEnabled(sourceKey, enabled));
  }

  async setDeveloperMode(enabled: boolean): Promise<PluginsResult> {
    return this.#enqueue(() => this.#setDeveloperMode(enabled));
  }

  async #setDeveloperMode(enabled: boolean): Promise<PluginsResult> {
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
    for (const plugin of this.deps.manager.state().plugins)
      if (plugin.source === "development")
        await this.deps.manager.removeSource(plugin.sourceKey, { forget: false });
    this.#developer = false;
    this.#commandLine = false;
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
    sourceKey = this.#currentSourceKey(sourceKey);
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
    return this.#enqueue(() => this.#unlink(this.#currentSourceKey(sourceKey)));
  }

  async #unlink(sourceKey: string): Promise<PluginsResult> {
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
    return this.#enqueue(() => this.#reload(this.#currentSourceKey(sourceKey)));
  }

  async #reload(sourceKey: string): Promise<PluginsResult> {
    const source = this.deps.manager.state().plugins.find((item) => item.sourceKey === sourceKey);
    const optionalBuiltin =
      source?.sourceKey.startsWith("builtin:") === true && source.canToggle && !source.required;
    const refused = this.#refuse({ developer: !optionalBuiltin, outsideSafeMode: true });
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
    return this.#enqueue(() => this.#setPython(id));
  }

  async #setPython(id: PythonChoiceId): Promise<PluginsResult> {
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
  clearSafeModeLock(): Promise<PluginsResult> {
    this.#restoring ??= this.#restore().finally(() => {
      this.#restoring = undefined;
    });
    return this.#restoring;
  }

  async #restore(): Promise<PluginsResult> {
    const prepared = await this.#enqueue(async () => {
      const refused = this.#refuse({});
      if (refused) return refused;
      if (!this.deps.session.safeMode && this.deps.manager.state().safeMode)
        return this.#resolveSessionDirectories();
      return undefined;
    });
    if (prepared) return prepared;
    const unlocked = await this.#enqueue(() => this.#clearSafeModeLock());
    if (unlocked) return unlocked;
    // User changes queued during resolution or the lock write must settle while sources
    // are still inert. In particular, an alias disable is redirected before activation.
    return this.#enqueue(async () => {
      const refused = this.#refuse({});
      if (refused) return refused;
      if (!this.deps.session.safeMode) {
        const left = await this.deps.manager.leaveSafeMode();
        if (!left.ok) return left;
      }
      this.#changed();
      return this.#ok();
    });
  }

  async #clearSafeModeLock(): Promise<Failure | undefined> {
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
    return undefined;
  }

  /** Resolve CLI aliases only on explicit restoration, before any third-party registration. */
  async #resolveSessionDirectories(): Promise<Failure | undefined> {
    const manager = this.deps.manager;
    for (const previous of this.deps.session.directories) {
      let directory: string;
      try {
        directory = await this.deps.realpath(previous);
      } catch (error) {
        const problem = failure(
          "PLUGIN_E_MANIFEST",
          `${previous} cannot be resolved: ${messageOf(error)}. Restore plugins again when the folder is available, or restart Kobrixa without --plugin-dev-dir for this folder.`,
        );
        this.#sessionProblem = { code: problem.code, message: problem.message };
        this.#changed();
        return problem;
      }
      const refused = this.#refuse({});
      if (refused) return refused;
      const oldKey = developmentSourceKey(previous);
      const sourceKey = developmentSourceKey(directory);
      if (sourceKey === oldKey) continue;
      // The runtime owns all disables, including choices retained after developer mode
      // was turned off and unsaved choices that do not appear in settings().
      const migrated = await manager.migrateSourceDisable(oldKey, sourceKey);
      if (!migrated.ok) return migrated;
      if (manager.state().plugins.some((plugin) => plugin.sourceKey === oldKey)) {
        // The manager is still in safe mode: both descriptors remain inert while their
        // identities and disables are reconciled. Saved canonical disables apply on add.
        const added = await manager.addSource({ kind: "development", directory });
        if (!added.ok && added.code !== "PLUGIN_E_SOURCE_EXISTS") return added;
        const removed = await manager.removeSource(oldKey, { forget: false });
        if (!removed.ok) return removed;
        this.#clear(oldKey);
      }
      this.#resolvedKeys.set(oldKey, sourceKey);
      this.deps.session.directories = uniqueDirectories(
        this.deps.session.directories.map((item) => (item === previous ? directory : item)),
      );
    }
    this.#sessionProblem = undefined;
    return undefined;
  }

  shutdown(deadlineMs?: number): Promise<void> {
    this.#closing = true;
    return this.deps.manager.shutdown(deadlineMs);
  }

  get acceptingUi(): boolean {
    return !this.#closing && !this.#preparingUpdate;
  }
  beginUpdatePreparation(): void {
    this.#preparingUpdate = true;
  }

  async resume(): Promise<void> {
    await this.#enqueue(async () => {
      await this.deps.manager.resume();
      this.#closing = false;
      this.#preparingUpdate = false;
      this.#changed();
    });
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const change = this.#changes.then(work);
    this.#changes = change.catch(() => undefined);
    return change;
  }

  #currentSourceKey(sourceKey: string): string {
    while (this.#resolvedKeys.has(sourceKey)) sourceKey = this.#resolvedKeys.get(sourceKey)!;
    return sourceKey;
  }

  markRendererUnresponsive(): void {
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
    // Dialogs may overlap, but their resulting mutations share the lifecycle queue.
    return this.#enqueue(async () => {
      const refused = this.#refuse({ developer: true, outsideSafeMode: true });
      if (refused) return refused;
      try {
        await this.deps.settings.update((current) => ({
          ...current,
          sources:
            replacing === undefined
              ? current.sources.some(
                  (source) => developmentSourceKey(source.directory) === sourceKey,
                )
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
    });
  }

  #refuse(needs: { developer?: boolean; outsideSafeMode?: boolean }): Failure | undefined {
    if (this.#closing || this.#preparingUpdate)
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
    let stateProblem = snapshot.stateProblem;
    if (this.#sessionProblem)
      stateProblem = stateProblem
        ? { ...stateProblem, message: `${stateProblem.message}\n${this.#sessionProblem.message}` }
        : this.#sessionProblem;
    return {
      ...snapshot,
      ...(stateProblem ? { stateProblem } : {}),
      // Keep Restore reachable through resolution and migration, until safe mode ends.
      // Unlike a saved lock, this cannot be lost to the settings write that failed startup.
      ...(snapshot.safeMode && this.deps.session.problem ? { sessionRecovery: true } : {}),
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
  stage3?: PluginManagerOptions["stage3"];
  stage3Host?: PluginManagerOptions["stage3Host"];
  onStage3Runtime?: (
    runtime: UiRuntimeAttachment,
    providers: Pick<PluginManager, "state" | "onEvent">,
  ) => void;
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
  if ((options.stage3 === undefined) !== (options.stage3Host === undefined))
    throw new Error("stage3 and stage3Host must be supplied together.");
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
    unclean === "renderer-unresponsive" ||
    hasDevelopmentSources ||
    marker.previousThirdPartyStaticContributions ||
    marker.previousThirdPartyUiContributions
      ? unclean
      : undefined;
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
  let safeMode =
    options.commandLine.safeMode ||
    loaded.problem !== undefined ||
    relevantUnclean !== undefined ||
    settings.settings().safeModeLock !== undefined;
  // path.resolve is lexical only. Safe mode must not even realpath a development folder.
  let sessionDirectories = requestedDirectories;
  let sessionProblem: PluginProblem | undefined;
  if (!safeMode) {
    const canonical: string[] = [];
    for (const directory of requestedDirectories) {
      try {
        canonical.push(await resolve(directory));
      } catch (error) {
        sessionProblem = {
          code: "PLUGIN_E_MANIFEST",
          message: `${directory} cannot be resolved: ${messageOf(error)}. Restore plugins again when the folder is available, or restart Kobrixa without --plugin-dev-dir for this folder.`,
        };
        break;
      }
    }
    if (!sessionProblem) {
      const disabled = new Set(loaded.disabled);
      // Compute from the original set so duplicate spellings do not undo a disable.
      requestedDirectories.forEach((directory) => {
        if (loaded.disabled.has(developmentSourceKey(directory)))
          disabled.delete(developmentSourceKey(directory));
      });
      requestedDirectories.forEach((directory, index) => {
        if (loaded.disabled.has(developmentSourceKey(directory)))
          disabled.add(developmentSourceKey(canonical[index]!));
      });
      const changed =
        disabled.size !== loaded.disabled.size ||
        [...disabled].some((key) => !loaded.disabled.has(key));
      try {
        if (changed) {
          await settings.save({ ...loaded, disabled });
          loaded = { ...loaded, disabled };
        }
        sessionDirectories = uniqueDirectories(canonical);
      } catch (error) {
        sessionProblem = {
          code: "PLUGIN_E_STATE_SAVE",
          message: `Could not save resolved development-source disables: ${messageOf(error)}. Restore plugins again when settings can be saved, or restart Kobrixa without --plugin-dev-dir for these folders.`,
        };
      }
    }
    // Keep the original descriptors and disabled set on failure so Restore can retry the
    // same migration. Never activate an unresolved alias that might have a canonical disable.
    if (sessionProblem) safeMode = true;
  }
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
  const grants = new Map<
    string,
    { owner: ImportedResourceOwner; permissions: ReadonlySet<ImportedPermission> }
  >();
  const launcher = (options.launcher ?? createDesktopLauncher)(hooks);
  const manager = await PluginManager.create({
    ...(options.stage3 && options.stage3Host
      ? { stage3: options.stage3, stage3Host: options.stage3Host }
      : {}),
    sources: [
      ...options.builtins,
      ...directories.map((directory) => ({ kind: "development" as const, directory })),
    ],
    // Already loaded above, so the manager sees the same result, including a corrupt file.
    store: { load: async () => loaded, save: (state) => settings.save(state) },
    safeMode,
    launcher: async (plugin) => {
      const owner = plugin.channelOwner;
      if (owner)
        grants.set(deviceOwnerKey(owner), { owner, permissions: new Set(plugin.permissions) });
      try {
        return await launcher(plugin);
      } catch (error) {
        if (owner) grants.delete(deviceOwnerKey(owner));
        throw error;
      }
    },
    locale: options.locale,
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
  });
  try {
    if (options.stage3 && options.stage3Host)
      options.onStage3Runtime?.(manager.stage3Runtime(), manager);
  } catch (error) {
    await manager.shutdown();
    throw error;
  }
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
      ...(sessionProblem ? { problem: sessionProblem } : {}),
    },
  });
  created.controller = controller;
  manager.onEvent(() => {
    for (const [key, grant] of grants)
      if (manager.requirements(grant.owner) === null) grants.delete(key);
  });
  deviceAccess.set(controller, {
    requirements: (owner) => manager.requirements(owner),
    hasPermission: (owner, permission) =>
      manager.requirements(owner) !== null &&
      grants.get(deviceOwnerKey(owner))?.permissions.has(permission) === true,
    async retire(owner) {
      if (manager.requirements(owner) === null) return;
      const result = await manager.reloadSource(owner.sourceKey);
      if (!result.ok) throw new Error(result.message);
      grants.delete(deviceOwnerKey(owner));
    },
  });
  return controller;
}

const deviceOwnerKey = (owner: ImportedResourceOwner) =>
  JSON.stringify([
    owner.sourceKey,
    owner.pluginId,
    owner.generation,
    owner.hostEpoch,
    owner.processEpoch,
  ]);
interface DesktopDeviceAccess {
  requirements: PluginManager["requirements"];
  hasPermission(owner: ImportedResourceOwner, permission: ImportedPermission): boolean;
  retire(owner: ImportedResourceOwner): Promise<void>;
}
const deviceAccess = new WeakMap<PluginController, DesktopDeviceAccess>();
/** Main-only registry access; no manager or renderer-selected grants escape. */
export function desktopDeviceAccess(controller: PluginController): DesktopDeviceAccess {
  const access = deviceAccess.get(controller);
  if (!access) throw new Error("Unknown desktop controller.");
  return access;
}

import type {
  Stage3RuntimePorts,
  Stage3HostAttachment,
  UiRuntimeAttachment,
} from "@kobrixa/plugin-runtime";
import { resourceFreePersistence150 } from "@kobrixa/plugin-runtime";
import { LifecycleCoordinator } from "../device-broker/lifecycle-coordinator.js";
import type {
  DesktopMainComposition,
  DesktopMainCompositionInput,
} from "../device-broker/lifecycle-coordinator.js";
import { attachDeviceRpc } from "../device-broker/rpc-router.js";
export type {
  DesktopFoundationOptions,
  DesktopFoundation,
  DesktopMainComposition,
  DesktopMainCompositionInput,
} from "../device-broker/lifecycle-coordinator.js";

const lifecycles = new WeakMap<DesktopMainComposition, LifecycleCoordinator>();
const windowRetirements = new WeakMap<
  DesktopMainComposition,
  (scope: ImportedCoreWindowScope, destroyed: boolean) => Promise<void>
>();
export function retireDesktopWindow(
  composition: DesktopMainComposition,
  scope: ImportedCoreWindowScope,
  destroyed: boolean,
): Promise<void> {
  const retire = windowRetirements.get(composition);
  if (!retire) throw new Error("Unknown desktop composition.");
  return retire(scope, destroyed);
}
export function desktopLifecycle(composition: DesktopMainComposition): LifecycleCoordinator {
  const coordinator = lifecycles.get(composition);
  if (!coordinator) throw new Error("Unknown desktop composition.");
  return coordinator;
}
import {
  createUiLifetimePort,
  currentStatusBindings,
  type UiCatalog,
  type UiStateRegistry,
  type UiSubscriptions,
  type PluginUiBridge,
  type UiCatalogSource,
  type UiBridgeEvent,
  type Stage3ChannelContext,
  type Stage3ChannelBinding,
  type DeviceChannelAttachment,
} from "@kobrixa/plugin-runtime";
import {
  handleSchema,
  resourceFailure,
  type CommandValue,
  type Result,
} from "@kobrixa/plugin-protocol";
import {
  observeUiSite,
  disposePluginUiBridge,
  createUiRegistry,
  createUiChannelBinding,
  createUiExecutionAdapter,
  createPluginUiBridge,
  UiBridgeEvents,
  type UiExecutionAdapter,
} from "./ui-bridge.js";
import { UiIntent } from "./ui-intent.js";
import { UserPersistenceActions } from "./user-persistence-actions.js";
import { ShutdownCoordinator } from "./shutdown-coordinator.js";

function bindDesktopChannel(
  context: Stage3ChannelContext,
  broker: DeviceBrokerPort,
  input: Omit<Parameters<typeof createUiChannelBinding>[1], "attachment">,
  originalChannels: Map<string, Stage3ChannelContext>,
): Stage3ChannelBinding {
  const principal = context.principal();
  const key = (owner: typeof context.owner) =>
    JSON.stringify([
      owner.sourceKey,
      owner.pluginId,
      owner.generation,
      owner.hostEpoch,
      owner.processEpoch,
    ]);
  if (principal.kind !== "plugin" || key(principal.owner) !== key(context.owner))
    throw new Error("Channel owner mismatch.");
  let attachment: DeviceChannelAttachment | undefined;
  const routedBroker = new Proxy(broker, {
    get(target, key, receiver) {
      if (key === "attachChannel")
        return (args: Parameters<DeviceBrokerPort["attachChannel"]>[0]) => {
          if (attachment) throw new Error("Second channel attachment.");
          attachment = target.attachChannel(args);
          return attachment;
        };
      return Reflect.get(target, key, receiver);
    },
  });
  const offDevice = attachDeviceRpc({
    peer: context.peer,
    principal: context.principal,
    broker: routedBroker,
  });
  if (!attachment) {
    offDevice();
    throw new Error("Device router did not attach the original channel.");
  }
  try {
    const ui = createUiChannelBinding(context, { ...input, attachment });
    originalChannels.set(key(context.owner), context);
    let disposed = false;
    return {
      initialized: (signal) => ui.initialized(signal),
      ready: (signal) => ui.ready(signal),
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          ui.dispose();
          offDevice();
        } finally {
          originalChannels.delete(key(context.owner));
        }
      },
    };
  } catch (error) {
    offDevice();
    throw error;
  }
}
type DesktopUi = {
  bridge: PluginUiBridge;
  catalog: UiCatalog;
  states: UiStateRegistry;
  subscriptions: UiSubscriptions;
  intent: UiIntent;
  actions: UserPersistenceActions;
  coordinator: ShutdownCoordinator;
  prepareUpdate(): Promise<void>;
  setRecoveryNavigation(navigate: () => void): void;
};
const desktopUis = new WeakMap<DesktopMainComposition, DesktopUi>();
export function desktopUi(composition: DesktopMainComposition): DesktopUi {
  const ui = desktopUis.get(composition);
  if (!ui) throw new Error("Unknown desktop UI composition.");
  return ui;
}
export async function composeDesktopMain(
  input: DesktopMainCompositionInput,
): Promise<DesktopMainComposition> {
  const { profile, now, coreActions } = input.foundationOptions;
  profile.assertHeld();
  const foundation = await input.createFoundation(input.foundationOptions);
  const broker = foundation.broker;
  let runtimeAttachment: UiRuntimeAttachment | undefined;
  const originalChannels = new Map<string, Stage3ChannelContext>();
  const ownerKey = (owner: ImportedResourceOwner) =>
    JSON.stringify([
      owner.sourceKey,
      owner.pluginId,
      owner.generation,
      owner.hostEpoch,
      owner.processEpoch,
    ]);
  let plugins: PluginController | undefined;
  const runtime = (): UiRuntimeAttachment => {
    if (!runtimeAttachment) throw new Error("Stage 3 runtime not attached.");
    return runtimeAttachment;
  };
  // The forwarding port is inert until the callback assigns the actual manager attachment.
  const runtimePort: UiRuntimeAttachment = {
    activateInitialized: (source, signal) => {
      if (!plugins?.acceptingUi) return Promise.reject(new Error("Plugin admission is paused."));
      return runtime().activateInitialized(source, signal);
    },
    ready: (owner, signal) => {
      if (!plugins?.acceptingUi) return Promise.reject(new Error("Plugin admission is paused."));
      return runtime().ready(owner, signal);
    },
    current: (owner) => runtime().current(owner),
    owners: () => runtime().owners(),
    context: (owner, scope) => (input.currentScope(scope) ? runtime().context(owner, scope) : null),
    commands: (source) => runtime().commands(source),
    invoke: (owner, invocation, signal) => {
      if (!plugins?.acceptingUi) return Promise.resolve(resourceFailure("stale"));
      return runtime().invoke(owner, invocation, signal);
    },
    dispatchDrain: (owner, request, signal) => runtime().dispatchDrain(owner, request, signal),
  };
  let catalogHint: Extract<UiBridgeEvent, { type: "catalog" }> = {
    type: "catalog",
    hostEpoch: profile.hostEpoch,
    revision: 0,
    owners: [],
  };
  const events = new UiBridgeEvents(() => {
    let statuses: UiBridgeEvent[] = [];
    try {
      statuses = currentStatusBindings(states, input.scope()).map(({ binding, revision }) => ({
        type: "state",
        binding,
        revision,
      }));
    } catch {
      /* Before the first admitted workbench there are no status bindings. */
    }
    return [catalogHint, ...statuses];
  });
  const intent = new UiIntent(broker.intent, now, events.publish, (event) =>
    observeUiSite(bridge, event),
  );
  const actions = new UserPersistenceActions(
    now,
    (owner, scope, uiResourceGeneration) =>
      input.currentScope(scope) &&
      runtime().current(owner) &&
      catalog.isCurrent({
        sourceKey: owner.sourceKey,
        pluginId: owner.pluginId,
        uiResourceGeneration,
      }),
  );
  const { catalog, states, subscriptions } = createUiRegistry({
    hostEpoch: profile.hostEpoch,
    broker,
    now,
    beforeDelivery(sourceKey) {
      if (!plugins) throw new Error("Plugin controller not attached.");
      plugins.markThirdPartyUiContributions(sourceKey);
    },
    revokeIntent(owner, binding) {
      if (binding) intent.forget(binding);
      else for (const current of states.instances(owner)) intent.forget(current);
    },
  });
  const stage3: Stage3RuntimePorts = {
    device: broker.resources,
    persistence: resourceFreePersistence150(),
    ui: createUiLifetimePort({
      catalog,
      states,
      subscriptions,
      revoke: (_owner, binding) => intent.forget(binding),
    }),
  };
  const lifecycle = new LifecycleCoordinator({
    ports: stage3,
    resources: broker.resources,
    sessions: broker.sessions,
    reservations: broker.reservations,
    persistence: stage3.persistence,
    now,
    alive: (owner) => {
      const channel = originalChannels.get(ownerKey(owner));
      return !!channel && !channel.peer.closed;
    },
    owners: () => runtime().owners(),
    dispatch: (owner, request, signal) => runtime().dispatchDrain(owner, request, signal),
    shutdown: async () => {
      if (plugins) await plugins.shutdown();
    },
    legacyFlush: input.legacyFlush,
    report: input.report,
  });
  const coordinator = new ShutdownCoordinator(lifecycle);
  let navigateRecovery: () => void = () => {
    throw new Error("Recovery navigation is not attached.");
  };
  const execution: UiExecutionAdapter = createUiExecutionAdapter({
    catalog,
    states,
    runtime: runtimePort,
    scope: input.scope,
    async core(resolved, nodeId): Promise<Result<CommandValue>> {
      const node =
        resolved.resource.kind === "panel"
          ? resolved.resource.nodes.find((value) => value.id === nodeId)
          : undefined;
      if (
        !node ||
        node.type !== "action" ||
        node.action.kind !== "core" ||
        !runtime().current(resolved.owner)
      )
        return resourceFailure("stale");
      const action = node.action;
      if (action.action === "openRecovery") {
        navigateRecovery();
        return { ok: true, value: { output: {}, fieldErrors: [] } };
      }
      if (action.action === "openPanel") {
        let cursor: string | undefined;
        do {
          const page = await catalog.catalog(cursor ? { cursor } : {});
          if (!page.ok) return page;
          const entry = page.value.entries.find(
            (value) => value.sourceKey === resolved.owner.sourceKey && value.id === action.panelId,
          );
          if (entry) {
            const result = await execution.open({
              sourceKey: entry.sourceKey,
              id: entry.id,
              uiResourceGeneration: entry.uiResourceGeneration,
            });
            return result.ok ? { ok: true, value: { output: {}, fieldErrors: [] } } : result;
          }
          cursor = page.value.nextCursor ?? undefined;
        } while (cursor);
        return resourceFailure("stale");
      }
      if (action.action === "stop") {
        const operationId = handleSchema.parse(resolved.state.data[action.operation.key]);
        const result = await broker.request(
          input.principal(resolved.owner),
          "devices/motion/stop",
          { operationId, stopMode: "brake" },
          new AbortController().signal,
        );
        return result.ok
          ? { ok: true, value: { output: {}, fieldErrors: [] } }
          : { ok: false, error: { code: result.error.code, message: result.error.message } };
      }
      const sessionId = handleSchema.parse(resolved.state.data[action.session.key]);
      const principal = input.principal(resolved.owner);
      if (!input.foundationOptions.hasPermission(principal, "devices.connect"))
        return resourceFailure("stale");
      const owned = await broker.request(
        principal,
        "devices/session",
        { sessionId },
        new AbortController().signal,
      );
      if (!owned.ok || !runtime().current(resolved.owner)) return resourceFailure("stale");
      const current = input.principal(resolved.owner);
      if (!current.authorityContext) return resourceFailure("stale");
      input.foundationOptions.authority.assertContinuation(current, current.authorityContext.ref);
      const scope = input.scope();
      if (!input.currentScope(scope)) return resourceFailure("stale");
      const token = coreActions.mint(scope, { kind: "device-disconnect", sessionId });
      try {
        await lifecycle.disconnect(sessionId, token);
        return { ok: true, value: { output: {}, fieldErrors: [] } };
      } finally {
        coreActions.complete(token);
      }
    },
  });
  const bridge = createPluginUiBridge({
    catalog,
    execution,
    intent,
    actions,
    events,
    scope: input.scope,
    coreActionCount: () => coreActions.count(),
  });
  const offCatalog = catalog.onEvent((event) => {
    if (event.type === "catalog") catalogHint = event;
    events.publish(event);
  });
  const offState = states.onEvent((owner, event) => {
    if (event.kind === "ui.revoked") {
      observeUiSite(bridge, {
        kind: "revoke",
        owner,
        binding: event.data.binding,
        time: performance.timeOrigin + performance.now(),
      });
      intent.forget(event.data.binding);
      events.publish({ type: "revoked", binding: event.data.binding, reason: event.data.reason });
    } else if (event.kind === "ui.state") {
      observeUiSite(bridge, {
        kind: "apply",
        owner,
        binding: event.data.binding,
        time: performance.timeOrigin + performance.now(),
      });
      events.publish({ type: "state", binding: event.data.binding, revision: event.data.revision });
    } else if (event.kind === "ui.visibility" && !event.data.visible)
      intent.revoke(event.data.binding, "hidden");
    else if (event.kind === "ui.form") intent.cancelHold(event.data.binding);
  });
  const stage3Host: Stage3HostAttachment = {
    hostEpoch: profile.hostEpoch,
    principal: input.principal,
    hasPermission: (owner, permission) =>
      input.foundationOptions.hasPermission(input.principal(owner), permission),
    requirements(owner) {
      const declarations = input.foundationOptions.requirements(owner);
      return declarations === null
        ? null
        : Object.freeze(declarations.map((value) => Object.freeze({ ...value })));
    },
    bindChannel: (context) =>
      bindDesktopChannel(
        context,
        broker,
        { catalog, states, subscriptions, runtime: runtimePort },
        originalChannels,
      ),
    retireResources: (owner, reason) => lifecycle.retire(owner, reason),
  };
  let offSources: (() => void) | undefined;
  let refresh = Promise.resolve();
  let inventory = "";
  const refreshCatalog = () => {
    refresh = refresh.catch(input.report).then(async () => {
      const sources = plugins!.uiCatalogSources();
      const key = JSON.stringify(sources);
      if (key === inventory) return;
      await catalog.replace(sources);
      inventory = key;
    });
    void refresh.catch(input.report);
    return refresh;
  };
  const disposeUi = () => {
    offSources?.();
    offState();
    offCatalog();
    disposePluginUiBridge(bridge);
    execution.dispose();
    intent.dispose();
    actions.dispose();
    subscriptions.dispose();
    events.dispose();
  };
  try {
    plugins = await startPlugins({
      ...input.plugins,
      stage3,
      stage3Host,
      onStage3Runtime(attachment, providers) {
        if (runtimeAttachment) throw new Error("Runtime already attached.");
        runtimeAttachment = attachment;
        foundation.attachProvider(providers);
        offSources = providers.onEvent((event) => {
          if (event.type === "state" && plugins) void refreshCatalog();
        });
      },
    });
    if (!runtimeAttachment) throw new Error("Missing runtime attachment.");
    await refreshCatalog();
    let disposed = false;
    const composition: DesktopMainComposition = {
      foundation,
      plugins,
      stage3,
      stage3Host,
      async dispose() {
        if (disposed) return;
        await lifecycle.close("close");
        await refresh.catch(input.report);
        disposeUi();
        await foundation.dispose();
        lifecycle.dispose();
        disposed = true;
      },
    };
    lifecycles.set(composition, lifecycle);
    desktopUis.set(composition, {
      bridge,
      catalog,
      states,
      subscriptions,
      intent,
      actions,
      coordinator,
      async prepareUpdate() {
        plugins!.beginUpdatePreparation();
        intent.dispose();
        actions.dispose();
        const owners = [...runtime().owners()];
        const dispositions = owners.map((owner) => lifecycle.retire(owner, "update"));
        // Preserve the reversible update gate. Global beginShutdown belongs to actual install.
        await Promise.all([input.legacyFlush("update"), ...dispositions]);
        await Promise.all(owners.map((owner) => desktopDeviceAccess(plugins!).retire(owner)));
        lifecycle.reconcileProcesses();
        if (lifecycle.reports().some((report) => report.blocker))
          throw new Error("Plugin retirement remains blocked.");
      },
      setRecoveryNavigation(navigate) {
        navigateRecovery = navigate;
      },
    });
    windowRetirements.set(composition, (scope, destroyed) => {
      actions.revokeWindow(scope);
      intent.dispose();
      const affected = [...originalChannels.values()].filter((channel) => {
        const principal = channel.principal();
        const binding = principal.authorityContext;
        const record = binding && input.foundationOptions.authority.current(principal, binding.ref);
        return (
          scope.hostEpoch === input.foundationOptions.profile.hostEpoch &&
          (record?.workbenchInstance === scope.workbenchInstance ||
            states.instances(channel.owner).length > 0)
        );
      });
      // Fence all affected owners in this turn, before the native caller invalidates the document.
      const retired = affected.map((channel) =>
        lifecycle.retire(channel.owner, destroyed ? "window-destroyed" : "renderer-crash"),
      );
      return Promise.all(retired).then(async () => {
        // Reload retires the old supervisor, then admits a lazy replacement generation.
        // It launches no process and replays no command.
        await Promise.all(
          affected.map((channel) => desktopDeviceAccess(composition.plugins).retire(channel.owner)),
        );
      });
    });
    return composition;
  } catch (error) {
    disposeUi();
    try {
      if (plugins) await plugins.shutdown();
      await foundation.dispose();
      lifecycle.dispose();
    } catch (cleanup) {
      input.report(cleanup);
      throw cleanup;
    }
    throw error;
  }
}

import type { Principal } from "@kobrixa/plugin-runtime";
import type { DeviceBrokerPort } from "../device-broker/broker-port.js";
import type { CoreActionLedger } from "./core-recovery.js";
export function trustedDeviceActions(
  broker: Pick<DeviceBrokerPort, "stopCurrentDevice">,
  coordinator: Pick<LifecycleCoordinator, "disconnect">,
  coreActions: CoreActionLedger,
) {
  return {
    async trustedCoreDisconnect(sessionId: string, principal: Principal): Promise<void> {
      if (principal.kind !== "core") throw new Error("Core workbench required.");
      const action = coreActions.mint(
        { hostEpoch: principal.hostEpoch, workbenchInstance: principal.workbenchInstance },
        { kind: "device-disconnect", sessionId },
      );
      try {
        await coordinator.disconnect(sessionId, action);
      } finally {
        coreActions.complete(action);
      }
    },
    async trustedCoreStop(sessionId: string, principal: Principal): Promise<void> {
      if (principal.kind !== "core") throw new Error("Core workbench required.");
      const action = coreActions.mint(
        { hostEpoch: principal.hostEpoch, workbenchInstance: principal.workbenchInstance },
        { kind: "device-current-stop", sessionId },
      );
      try {
        const result = await broker.stopCurrentDevice({ sessionId, action });
        if (!result.ok) throw new Error(result.error.message);
      } finally {
        coreActions.complete(action);
      }
    },
  };
}
import type { LegacyDevice } from "../device-broker/legacy-device.js";
export function createLegacyActionAdmission(actions: ReturnType<typeof trustedDeviceActions>) {
  type Kind = "stop" | "disconnect";
  let permit: { kind: Kind; sessionId: string; principal: Principal } | undefined;
  const consume = (kind: Kind, sessionId: string): Promise<void> => {
    const captured = permit;
    permit = undefined;
    if (!captured || captured.kind !== kind || captured.sessionId !== sessionId)
      return Promise.reject(new Error("Validated device IPC required."));
    return kind === "stop"
      ? actions.trustedCoreStop(sessionId, captured.principal)
      : actions.trustedCoreDisconnect(sessionId, captured.principal);
  };
  return {
    stop: (sessionId: string) => consume("stop", sessionId),
    disconnect: (sessionId: string) => consume("disconnect", sessionId),
    bind(device: Pick<LegacyDevice, "stop" | "disconnect">) {
      const invoke = (kind: Kind, sessionId: string, principal: Principal) => {
        if (permit) throw new Error("Nested device IPC admission.");
        permit = { kind, sessionId, principal };
        try {
          return device[kind](sessionId);
        } finally {
          permit = undefined;
        }
      };
      return {
        stop: (sessionId: string, principal: Principal) => invoke("stop", sessionId, principal),
        disconnect: (sessionId: string, principal: Principal) =>
          invoke("disconnect", sessionId, principal),
      };
    },
  };
}

export function createDeviceLossHandler(
  lost: (sessionId: string) => void,
  restored: (sessionId: string) => void,
): (event: ImportedDeviceEvent) => void {
  const ended = new Set<string>();
  return (event) => {
    if (event.type === "state" && event.state === "connected" && event.sessionId) {
      ended.delete(event.sessionId);
      restored(event.sessionId);
    }
    if (event.type === "usb-recovery" && event.state === "restored") {
      ended.delete(event.previousSessionId);
      ended.delete(event.sessionId);
      restored(event.sessionId);
    }
    const sessionId =
      event.type === "state" && event.state === "disconnected"
        ? event.sessionId
        : event.type === "usb-recovery" &&
            (event.state === "waiting" || event.state === "unavailable")
          ? event.previousSessionId
          : undefined;
    if (!sessionId || ended.has(sessionId)) return;
    ended.add(sessionId);
    if (ended.size > 64) ended.delete(ended.values().next().value!);
    lost(sessionId);
  };
}

/** Native navigation captures and retires the old scope before invalidating its authority. */
export function createWindowRetirementHandler(input: {
  composition: DesktopMainComposition;
  scope(): ImportedCoreWindowScope;
  coreActions: CoreActionLedger;
  invalidate(): void;
  flush(): Promise<void>;
  pause(): Promise<void>;
}): (destroyed: boolean) => Promise<void> {
  return (destroyed) => {
    let scope: ImportedCoreWindowScope | undefined;
    try {
      scope = input.scope();
    } catch {
      /* No admitted document. */
    }
    let retired: Promise<void> = Promise.resolve();
    try {
      if (scope) {
        input.coreActions.retire(scope);
        retired = retireDesktopWindow(input.composition, scope, destroyed);
      }
    } catch (error) {
      retired = Promise.reject(error);
    } finally {
      input.invalidate();
    }
    return Promise.all([retired, input.flush()]).then(() => input.pause());
  };
}
