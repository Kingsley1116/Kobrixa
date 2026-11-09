import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  CoreWindowScope,
  CoreActionReference,
  OwnerRetirement,
  DrainReport,
} from "@kobrixa/plugin-runtime";
import type { LifecycleCoordinator, CloseReport } from "../device-broker/lifecycle-coordinator.js";
export type { CloseReport } from "../device-broker/lifecycle-coordinator.js";
export class ShutdownCoordinator {
  constructor(private readonly lifecycle: LifecycleCoordinator) {}
  retire(owner: ResourceOwner, reason: OwnerRetirement, deadline?: number) {
    return this.lifecycle.retire(owner, reason, deadline);
  }
  disconnect(session: string, action: CoreActionReference) {
    return this.lifecycle.disconnect(session, action);
  }
  suspend(session: string) {
    return this.lifecycle.suspend(session);
  }
  resume(session: string) {
    return this.lifecycle.resume(session);
  }
  pendingSession(session: string) {
    return this.lifecycle.pendingSession(session);
  }
  reconcileRecovery(recovery: string, report: DrainReport) {
    this.lifecycle.reconcileRecovery(recovery, report);
  }
  allowCloseRetry() {
    this.lifecycle.allowCloseRetry();
  }
  async close(reason: "shutdown" | "update"): Promise<CloseReport> {
    try {
      await this.lifecycle.close(reason === "shutdown" ? "close" : "update");
      return {
        blocker: false,
        timedOut: false,
        legacySaved: true,
        device: { stopConfirmed: true, journalCommitted: true, faultIds: [] },
        owners: this.lifecycle.reports(),
      };
    } catch {
      return {
        blocker: true,
        timedOut: false,
        legacySaved: false,
        device: { stopConfirmed: false, journalCommitted: false, faultIds: [] },
        owners: this.lifecycle.reports(),
      };
    }
  }
  dispose(): void {
    /* Lifetime belongs to composeDesktopMain. */
  }
}
export async function requireCleanClose(
  coordinator: ShutdownCoordinator,
  reason: "shutdown" | "update",
): Promise<void> {
  const report = await coordinator.close(reason);
  if (report.blocker)
    throw new Error("Device stop, journal, saved data or process exit is not confirmed.");
}

export interface NativeLifecycleEmitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}
export function attachNativeLifecycle(input: {
  window: NativeLifecycleEmitter;
  contents: NativeLifecycleEmitter;
  power?: NativeLifecycleEmitter;
  windowLost?(scope: CoreWindowScope, destroyed: boolean): Promise<void>;
  scope(): CoreWindowScope;
  owners(): readonly ResourceOwner[];
  sessions(): readonly string[];
  revokeIntent(): void;
  revokeActions(scope: CoreWindowScope): void;
  replaceWorkbench(): void;
  markUnresponsive(): void;
  retire(owner: ResourceOwner, reason: "renderer-crash" | "window-destroyed"): Promise<unknown>;
  suspend(sessionId: string): Promise<unknown>;
  resume(sessionId: string): Promise<unknown>;
  failed(error: unknown): void;
}): () => void {
  const disposers: Array<() => void> = [];
  const on = (
    target: NativeLifecycleEmitter,
    event: string,
    listener: (...args: unknown[]) => void,
  ) => {
    target.on(event, listener);
    disposers.push(() => {
      target.off(event, listener);
    });
  };
  for (const event of ["blur", "hide", "minimize"]) on(input.window, event, input.revokeIntent);
  let lastLostScope: string | undefined;
  const lose = (reason: "renderer-crash" | "window-destroyed") => {
    let scope: CoreWindowScope;
    try {
      scope = input.scope();
    } catch {
      return;
    }
    const scopeKey = JSON.stringify([scope.hostEpoch, scope.workbenchInstance]);
    if (scopeKey === lastLostScope) return;
    lastLostScope = scopeKey;
    const owners = [...input.owners()];
    input.revokeIntent();
    input.revokeActions(scope);
    if (input.windowLost)
      void input.windowLost(scope, reason === "window-destroyed").catch(input.failed);
    else for (const owner of owners) void input.retire(owner, reason).catch(input.failed);
    input.replaceWorkbench();
  };
  on(input.window, "unresponsive", () => {
    input.markUnresponsive();
    lose("renderer-crash");
  });
  on(input.contents, "render-process-gone", (_event, value) => {
    if (
      typeof value === "object" &&
      value !== null &&
      "reason" in value &&
      value.reason === "clean-exit"
    )
      return;
    lose("renderer-crash");
  });
  on(input.contents, "destroyed", () => lose("window-destroyed"));
  on(input.contents, "did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame === true && _inPlace !== true) lose("renderer-crash");
  });
  if (input.power)
    on(input.power, "suspend", () => {
      input.revokeIntent();
      for (const session of input.sessions()) void input.suspend(session).catch(input.failed);
    });
  if (input.power)
    on(input.power, "resume", () => {
      for (const session of input.sessions()) void input.resume(session).catch(input.failed);
    });
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
}
