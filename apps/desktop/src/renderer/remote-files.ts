import type {
  DeviceEvent,
  KobrixaApi,
  RemoteEntry,
  RemoteFileRequest,
  FileBatchSnapshot,
  FileBatchAction,
} from "../shared/api.js";
import type { Locale } from "./copy.js";
import type { ExecutionController } from "./execution.js";
export const PROJECT_ROOT = "/home/root/lms2012/prjs";
export const protectedRemotePath = (path: string): boolean =>
  [PROJECT_ROOT, `${PROJECT_ROOT}/SD_Card`, `${PROJECT_ROOT}/USB_Stick`].includes(path);
type FileError = { category: string; message: string };
export interface RemoteFilesState {
  sessionId?: string | undefined;
  path: string;
  entries: RemoteEntry[];
  busy: boolean;
  loaded: boolean;
  action?: RemoteFileRequest["action"] | "checking" | "refreshing" | undefined;
  error?: FileError | undefined;
  refreshError?: FileError | undefined;
  progress?: { transferred: number; total: number } | undefined;
  batch?: FileBatchSnapshot | undefined;
}
const asError = (error: unknown): FileError => ({
  category: (error as { category?: string }).category ?? "internal",
  message: error instanceof Error ? error.message : String(error),
});
export class RemoteFilesController {
  private state: RemoteFilesState = { path: PROJECT_ROOT, entries: [], busy: false, loaded: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private requestId: string | undefined;
  private decide: ((policy: "skip" | "replace" | undefined) => void) | undefined;
  constructor(
    private api: KobrixaApi,
    private execution: ExecutionController,
  ) {}
  getSnapshot = (): RemoteFilesState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(patch: Partial<RemoteFilesState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  setSession(sessionId: string | undefined, deployedPath?: string): void {
    if (this.state.sessionId === sessionId) return;
    const disconnected = !sessionId && this.state.busy;
    const batch = this.state.batch;
    this.decide?.(undefined);
    this.decide = undefined;
    if (batch && this.state.busy) void this.api.device.stopFiles(batch).catch(() => {});
    this.generation++;
    this.requestId = undefined;
    const initial = deployedPath?.slice(0, deployedPath.lastIndexOf("/"));
    this.update({
      sessionId,
      path: initial?.startsWith(`${PROJECT_ROOT}/`) ? initial : PROJECT_ROOT,
      entries: [],
      busy: false,
      loaded: false,
      action: undefined,
      refreshError: undefined,
      batch:
        !sessionId && batch
          ? {
              ...batch,
              phase: ["checking", "ready", "running"].includes(batch.phase)
                ? "failed"
                : batch.phase,
              items: batch.items.map((item) =>
                item.status === "running"
                  ? {
                      ...item,
                      status: "failed",
                      message: "EV3 disconnected during file operation.",
                    }
                  : item,
              ),
            }
          : undefined,
      error: disconnected
        ? (this.state.error ?? {
            category: "connection",
            message: "EV3 disconnected during file operation.",
          })
        : undefined,
      progress: undefined,
    });
  }
  onEvent = (event: DeviceEvent): void => {
    if (event.type === "file-batch") {
      const batch = event.snapshot;
      if (batch.sessionId === this.state.sessionId && batch.requestId === this.requestId)
        this.update({ batch });
    } else if (
      event.type === "state" &&
      event.state === "disconnected" &&
      event.sessionId === this.state.sessionId &&
      this.state.busy
    )
      this.update({
        error: {
          category: "connection",
          message: event.message ?? "EV3 disconnected during file operation.",
        },
      });
    else if (
      event.type === "file-progress" &&
      event.sessionId === this.state.sessionId &&
      event.requestId === this.requestId
    )
      this.update({ progress: { transferred: event.transferred, total: event.total } });
  };
  async perform(
    action: RemoteFileRequest["action"],
    path: string,
    locale: Locale,
    name?: string,
  ): Promise<boolean> {
    const sessionId = this.state.sessionId;
    if (!sessionId || this.state.busy || this.execution.locked) return false;
    const generation = ++this.generation;
    const initial = !this.state.loaded;
    this.update({
      busy: true,
      action,
      error: undefined,
      refreshError: undefined,
      progress: undefined,
    });
    const current = () => generation === this.generation && sessionId === this.state.sessionId;
    const request = async (action: RemoteFileRequest["action"], path: string, name?: string) => {
      const requestId = crypto.randomUUID();
      this.requestId = requestId;
      const result = await this.api.device.files({
        action,
        path,
        sessionId,
        requestId,
        locale,
        ...(name === undefined ? {} : { name }),
      });
      if (!current() || result.sessionId !== sessionId || result.requestId !== requestId)
        return undefined;
      if (!result.ok) throw Object.assign(new Error(result.message), { category: result.category });
      return result;
    };
    let succeeded = false;
    try {
      await this.execution.withFiles(async () => {
        let result;
        try {
          result = await request(action, path, name);
        } catch (error) {
          if (
            current() &&
            initial &&
            action === "list" &&
            path !== PROJECT_ROOT &&
            (error as { category?: string }).category === "not-found"
          ) {
            path = PROJECT_ROOT;
            result = await request("list", path);
          } else throw error;
        }
        if (!current() || !result || result.cancelled) return;
        succeeded = true;
        if (action === "list") this.update({ path, entries: result.entries ?? [], loaded: true });
        else if (action !== "download") {
          this.update({ action: "refreshing" });
          try {
            const refreshed = await request("list", this.state.path);
            if (current() && refreshed)
              this.update({ entries: refreshed.entries ?? [], loaded: true });
          } catch (error) {
            if (current()) this.update({ refreshError: asError(error) });
          }
        }
      }, `${action} · ${path}`);
    } catch (error) {
      if (current()) this.update({ error: asError(error), loaded: true });
    } finally {
      if (current()) {
        this.requestId = undefined;
        this.update({ busy: false, action: undefined, progress: undefined });
      }
    }
    return succeeded;
  }
  async prepareBatch(
    action: FileBatchAction,
    paths: string[],
    source: "files" | "folders",
    locale: Locale,
  ): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId || this.state.busy || this.execution.locked) return;
    const generation = ++this.generation,
      requestId = crypto.randomUUID(),
      path = this.state.path;
    this.requestId = requestId;
    this.update({
      busy: true,
      action: "checking",
      batch: undefined,
      error: undefined,
      refreshError: undefined,
    });
    const current = () => generation === this.generation && sessionId === this.state.sessionId;
    const choice = new Promise<"skip" | "replace" | undefined>((resolve) => {
      this.decide = resolve;
    });
    try {
      await this.execution.withFiles(async () => {
        let batch = await this.api.device.prepareFiles({
          sessionId,
          requestId,
          action,
          path,
          paths,
          source,
          locale,
        });
        if (!current() || batch.sessionId !== sessionId || batch.requestId !== requestId) return;
        if (this.state.batch?.planId !== batch.planId || this.state.batch.phase !== "running")
          this.update({ batch });
        if (batch.phase === "ready") {
          const policy = await choice;
          if (!current()) return;
          if (!policy) {
            await this.api.device.stopFiles(batch);
            if (current())
              this.update({ batch: { ...batch, phase: "cancelled", stopRequested: true } });
            return;
          }
          this.update({ action });
          batch = await this.api.device.executeFiles(batch, policy);
          if (!current() || batch.sessionId !== sessionId || batch.requestId !== requestId) return;
          this.update({ batch });
        }
        if (action === "delete") {
          const removed = new Set(
            batch.items
              .filter((item) => item.status === "succeeded")
              .map((item) => `${path}/${item.label}`),
          );
          this.update({ entries: this.state.entries.filter((entry) => !removed.has(entry.path)) });
        }
        if (batch.items.some((item) => item.status === "succeeded" || item.status === "failed")) {
          this.update({ action: "refreshing" });
          const refreshId = crypto.randomUUID();
          try {
            const result = await this.api.device.files({
              sessionId,
              requestId: refreshId,
              action: "list",
              path,
              locale,
            });
            if (!current() || result.sessionId !== sessionId || result.requestId !== refreshId)
              return;
            if (!result.ok)
              throw Object.assign(new Error(result.message), { category: result.category });
            this.update({ entries: result.entries ?? [], loaded: true });
          } catch (error) {
            if (current()) this.update({ refreshError: asError(error) });
          }
        }
      }, `${action} · ${path}`);
    } catch (error) {
      if (current()) {
        const batch = this.state.batch;
        if (batch && ["checking", "ready", "running"].includes(batch.phase)) {
          await this.api.device.stopFiles(batch).catch(() => {});
          if (current())
            this.update({
              batch: {
                ...this.state.batch!,
                phase: "failed",
                issues: [...(this.state.batch?.issues ?? []), asError(error).message],
              },
            });
        }
        if (current()) this.update({ error: asError(error) });
      }
    } finally {
      if (current()) {
        this.requestId = undefined;
        this.decide = undefined;
        this.update({ busy: false, action: undefined });
      }
    }
  }
  executeBatch(policy: "skip" | "replace"): void {
    if (this.state.batch?.phase !== "ready") return;
    this.update({ batch: { ...this.state.batch, phase: "running" } });
    this.decide?.(policy);
  }
  async stopBatch(): Promise<void> {
    const batch = this.state.batch;
    if (!batch || !this.state.busy || batch.stopRequested) return;
    this.update({ batch: { ...batch, stopRequested: true } });
    if (batch.phase === "ready") this.decide?.(undefined);
    else
      try {
        await this.api.device.stopFiles(batch);
      } catch (error) {
        if (batch.sessionId === this.state.sessionId && this.state.busy)
          this.update({ error: asError(error) });
      }
  }
  clearBatch(): void {
    if (!this.state.busy) this.update({ batch: undefined });
  }
}
