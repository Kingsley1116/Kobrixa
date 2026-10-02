import type { UpdatePreferences, UpdateState } from "../../shared/updates.js";
import semver from "semver";
import { RELEASES_URL } from "../../shared/updates.js";
import { selectRelease, type PublishedRelease, type ReleaseSelection } from "./catalog.js";

export interface UpdateBackend {
  download(
    release: ReleaseSelection,
    progress: (percent: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  install(): void;
}
export interface UpdateDependencies {
  version: string;
  platform: string;
  arch: string;
  reason?: UpdateState["reason"];
  preferences: UpdatePreferences;
  list(signal: AbortSignal): Promise<PublishedRelease[]>;
  backend: UpdateBackend;
  persist(preferences: UpdatePreferences): Promise<void>;
  publish(state: UpdateState): void;
  open(url: string): Promise<void>;
  busy(): boolean;
}
export class UpdateService {
  private state: UpdateState;
  private generation = 0;
  private flight: Promise<void> | undefined;
  private abort: AbortController | undefined;
  private selected: ReleaseSelection | undefined;
  private preferenceWrites = 0;
  private preferenceWrite: Promise<void> = Promise.resolve();
  private startup: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly dependencies: UpdateDependencies) {
    this.state = {
      revision: 0,
      currentVersion: dependencies.version,
      preferences: dependencies.preferences,
      supported: !dependencies.reason,
      reason: dependencies.reason,
      phase: "idle",
    };
  }
  getState = (): UpdateState => structuredClone(this.state);
  get preparing(): boolean {
    return this.state.phase === "preparing";
  }
  get installing(): boolean {
    return this.state.phase === "installing";
  }
  start(): void {
    if (this.dependencies.reason === "development" || this.startup || this.interval) return;
    const check = () => {
      if (this.state.preferences.enabled) void this.check();
    };
    this.startup = setTimeout(check, 30_000);
    this.interval = setInterval(check, 6 * 60 * 60 * 1000);
    this.startup.unref?.();
    this.interval.unref?.();
  }
  dispose(): void {
    clearTimeout(this.startup);
    clearInterval(this.interval);
    this.generation++;
    this.abort?.abort();
  }
  private patch(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    this.dependencies.publish(this.getState());
  }
  setPreferences(preferences: UpdatePreferences): Promise<UpdateState> {
    this.preferenceWrites++;
    const write = this.preferenceWrite
      .catch(() => undefined)
      .then(async () => {
        if (this.preparing || this.installing) throw new Error("busy");
        await this.dependencies.persist(preferences);
        const channelChanged = preferences.channel !== this.state.preferences.channel;
        this.generation++;
        this.abort?.abort();
        this.selected = undefined;
        this.patch({
          preferences,
          phase: "idle",
          version: undefined,
          progress: undefined,
          error: undefined,
        });
        if ((channelChanged || preferences.enabled) && this.dependencies.reason !== "development") {
          // Drain the old updater before changing its feed. Its late events are ignored.
          void (this.flight ?? Promise.resolve()).then(() => {
            if (this.state.preferences.enabled) void this.check();
          });
        }
      });
    this.preferenceWrite = write.finally(() => {
      this.preferenceWrites--;
    });
    return this.preferenceWrite.then(this.getState);
  }
  check(): Promise<void> {
    if (this.flight) return this.flight;
    if (
      this.preparing ||
      this.installing ||
      this.state.phase === "ready" ||
      this.dependencies.reason === "development"
    )
      return Promise.resolve();
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const current = () => generation === this.generation && !abort.signal.aborted;
    this.selected = undefined;
    this.patch({ phase: "checking", error: undefined, version: undefined, progress: undefined });
    const run = async () => {
      try {
        const releases = await this.dependencies.list(abort.signal);
        if (!current()) return;
        const selected = selectRelease(
          releases,
          this.dependencies.version,
          this.state.preferences,
          this.dependencies.platform,
          this.dependencies.arch,
        );
        this.selected = selected;
        if (!selected) {
          const hasStable = releases.some(
            (item) =>
              !item.draft &&
              !item.prerelease &&
              semver.valid(item.tag_name) &&
              !semver.prerelease(item.tag_name),
          );
          this.patch({
            phase:
              this.state.preferences.channel === "stable" && !hasStable ? "no-release" : "current",
          });
          return;
        }
        this.patch({ version: selected.version });
        if (!this.state.supported || !selected.automatic) {
          this.patch({ phase: "manual" });
          return;
        }
        this.patch({ phase: "downloading", progress: 0 });
        await this.dependencies.backend.download(
          selected,
          (progress) => {
            if (current()) this.patch({ progress });
          },
          abort.signal,
        );
        if (current()) this.patch({ phase: "ready", progress: 100 });
      } catch (error) {
        if (current())
          this.patch({
            phase: "error",
            error:
              error instanceof TypeError
                ? "network"
                : error instanceof Error
                  ? error.message
                  : "network",
            progress: undefined,
          });
      }
    };
    this.flight = run().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  prepareInstall(): void {
    if (
      this.preferenceWrites ||
      this.state.phase !== "ready" ||
      !this.selected ||
      this.dependencies.busy()
    )
      throw new Error("busy");
    this.patch({ phase: "preparing", error: undefined });
  }
  cancelInstall(): void {
    if (this.preparing) this.patch({ phase: "ready" });
  }
  install(): void {
    if (!this.preparing || this.dependencies.busy()) throw new Error("busy");
    this.patch({ phase: "installing" });
    try {
      this.dependencies.backend.install();
    } catch (error) {
      this.patch({ phase: "ready" });
      throw error;
    }
  }
  installationFailed(error: string): void {
    this.patch({ phase: "error", error });
  }
  openRelease(): Promise<void> {
    return this.dependencies.open(this.selected?.url ?? RELEASES_URL);
  }
}

/** Serializes installation against main-process operations, including IPC callers. */
export class UpdateOperationGate {
  private active = 0;
  constructor(private service: () => UpdateService | undefined) {}
  get busy(): boolean {
    return this.active > 0;
  }
  async run<T>(channel: string, work: () => T | Promise<T>): Promise<T> {
    const service = this.service();
    if (
      service?.installing ||
      (service?.preparing &&
        !["workspace:write", "workspace:save-draft", "workspace:save-session"].includes(channel))
    )
      throw new Error("busy");
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
}
