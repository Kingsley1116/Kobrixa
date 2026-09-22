import type { DeviceEvent, KobrixaApi, RemoteEntry, RemoteFileRequest } from "../shared/api.js";
import type { Locale } from "./copy.js";
import type { ExecutionController } from "./execution.js";
// Kept renderer-safe: @kobrixa/device also exports native USB transports.
export const PROJECT_ROOT = "/home/root/lms2012/prjs";
export const protectedRemotePath = (path: string): boolean =>
  [PROJECT_ROOT, `${PROJECT_ROOT}/SD_Card`, `${PROJECT_ROOT}/USB_Stick`].includes(path);
export interface RemoteFilesState {
  sessionId?: string | undefined;
  path: string;
  entries: RemoteEntry[];
  busy: boolean;
  loaded: boolean;
  error?: { category: string; message: string } | undefined;
  progress?: { transferred: number; total: number } | undefined;
}
export class RemoteFilesController {
  private state: RemoteFilesState = { path: PROJECT_ROOT, entries: [], busy: false, loaded: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private requestId: string | undefined;
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
    this.generation++;
    this.requestId = undefined;
    const initial = deployedPath?.slice(0, deployedPath.lastIndexOf("/"));
    this.update({
      sessionId,
      path: initial?.startsWith(`${PROJECT_ROOT}/`) ? initial : PROJECT_ROOT,
      entries: [],
      busy: false,
      loaded: false,
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
    if (
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
    if (
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
  ): Promise<void> {
    const sessionId = this.state.sessionId;
    if (!sessionId || this.state.busy || this.execution.locked) return;
    const generation = ++this.generation;
    const initial = !this.state.loaded;
    this.update({
      busy: true,
      error: undefined,
      progress: undefined,
      ...(action === "list" ? { path, entries: [] } : {}),
    });
    const current = (): boolean =>
      generation === this.generation && sessionId === this.state.sessionId;
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
            this.update({ path: PROJECT_ROOT });
            result = await request("list", PROJECT_ROOT);
          } else throw error;
        }
        if (!current() || !result) return;
        if (action === "list") this.update({ entries: result.entries ?? [], loaded: true });
        else if (!result.cancelled && action !== "download") {
          const refreshed = await request("list", this.state.path);
          if (current() && refreshed)
            this.update({ entries: refreshed.entries ?? [], loaded: true });
        }
      }, `${action} · ${path}`);
    } catch (error) {
      if (current())
        this.update({
          error: {
            category: (error as { category?: string }).category ?? "internal",
            message: error instanceof Error ? error.message : String(error),
          },
          loaded: true,
        });
    } finally {
      if (current()) {
        this.requestId = undefined;
        this.update({ busy: false, progress: undefined });
      }
    }
  }
}
