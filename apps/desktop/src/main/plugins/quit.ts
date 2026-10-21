export const PLUGIN_QUIT_TIMEOUT_MS = 25_000;
interface QuitHost {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}
export function installPluginQuitCleanup(
  app: QuitHost, cleanup: () => Promise<void>, blocked: (error: unknown) => void,
): void {
  let state: "idle" | "cleaning" | "done" = "idle";
  app.on("will-quit", (event) => {
    if (state === "done") return;
    event.preventDefault();
    if (state === "cleaning") return;
    state = "cleaning";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      blocked(new Error("Cleanup disposition is still unknown after 25 seconds."));
      // Keep state cleaning: late callbacks cannot turn this attempt into automatic quit.
    }, PLUGIN_QUIT_TIMEOUT_MS);
    void Promise.resolve().then(cleanup).then(() => {
      clearTimeout(timer);
      if (timedOut) { state = "idle"; return; }
      state = "done"; app.quit();
    }, (error: unknown) => {
      clearTimeout(timer); state = "idle"; blocked(error);
    });
  });
}
