export const PLUGIN_QUIT_TIMEOUT_MS = 25_000;
interface QuitHost {
  on(event: "will-quit", listener: (event: { preventDefault(): void }) => void): unknown;
  quit(): void;
}
export function installPluginQuitCleanup(
  app: QuitHost,
  cleanup: () => Promise<void>,
  blocked: (error: unknown) => void,
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
      state = "idle";
      blocked(new Error("Cleanup disposition is still unknown after 25 seconds."));
      // Only a fresh user request can retry; this attempt can never quit later.
    }, PLUGIN_QUIT_TIMEOUT_MS);
    void Promise.resolve()
      .then(cleanup)
      .then(
        () => {
          clearTimeout(timer);
          if (timedOut) return;
          state = "done";
          app.quit();
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (timedOut) return;
          state = "idle";
          blocked(error);
        },
      );
  });
}

/** Keep blocked cleanup visible while retaining the primary profile lock. */
export function createQuitRecovery(input: {
  focus(): boolean;
  open(): void;
  retry(error: unknown): Promise<boolean>;
  quit(): void;
}) {
  const focus = () => {
    if (input.focus()) return true;
    input.open();
    return input.focus();
  };
  return {
    focus,
    async blocked(error: unknown): Promise<void> {
      focus();
      if (await input.retry(error)) input.quit();
    },
  };
}
