import { PLUGIN_SHUTDOWN_DEADLINE_MS, type PluginManager } from "@kobrixa/plugin-runtime";

/** Safety net only: longer than shutdown()'s own deadline, which already force-kills leftovers. */
export const PLUGIN_QUIT_TIMEOUT_MS = PLUGIN_SHUTDOWN_DEADLINE_MS + 1_000;
export interface QuitHost {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}

/**
 * `void shutdown()` in will-quit would not keep Electron alive, so shutdown handshakes and forced
 * kills could be cut short. Hold the first quit, wait for shutdown(), then quit again.
 */
export function installPluginQuitCleanup(
  app: QuitHost,
  plugins: Pick<PluginManager, "active" | "shutdown">,
  options: { timeoutMs?: number } = {},
): void {
  let state: "idle" | "cleaning" | "done" = "idle";
  app.on("will-quit", (event) => {
    if (state === "done") return;
    if (state === "cleaning") return event.preventDefault();
    if (!plugins.active) return;
    event.preventDefault();
    state = "cleaning";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const safetyNet = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(options.timeoutMs ?? 0, PLUGIN_QUIT_TIMEOUT_MS));
    });
    void Promise.race([plugins.shutdown().catch(() => undefined), safetyNet]).then(() => {
      clearTimeout(timer);
      state = "done";
      app.quit();
    });
  });
}
