/** Closing a workbench retires its consumers, but does not shut down the host. */
export class WorkbenchLifecycle {
  #close: Promise<void> | undefined;
  #reopen: Promise<void> | undefined;
  #sessions: string[] = [];
  #captured = false;
  #failed = false;
  #reason: "window" | "update" = "window";
  #deadline: number | undefined;
  constructor(
    private readonly input: {
      sessions(): readonly string[] | Promise<readonly string[]>;
      suspend(session: string): Promise<void>;
      verify(session: string): Promise<void>;
      retire(reason: "window" | "update"): Promise<void>;
      resume(session: string): Promise<void>;
      readmit(): Promise<void>;
      now?(): number;
    },
  ) {}
  get closing(): boolean {
    return !!this.#close;
  }
  close(reason: "window" | "update" = "window"): Promise<void> {
    if (this.#close && !this.#failed) return this.#close;
    const retry = !!this.#close;
    if (!retry) this.#reason = reason;
    this.#failed = false;
    // Publish the admission fence before callbacks can reenter device admission.
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.#close = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const now = this.input.now ?? (() => performance.now());
    this.#deadline ??= now() + 25_000;
    let timedOut = false;
    const timer = setTimeout(
      () => {
        timedOut = true;
        reject(new Error("Workbench cleanup remains unconfirmed after its safety deadline."));
      },
      Math.max(0, this.#deadline - now()),
    );
    try {
      const retired = this.input.retire(this.#reason);
      const safety = Promise.resolve(this.#captured ? this.#sessions : this.input.sessions()).then(
        async (sessions) => {
          this.#sessions = [...new Set(sessions)];
          const recheck = this.#captured;
          this.#captured = true;
          await Promise.all(
            this.#sessions.map((session) =>
              recheck ? this.input.verify(session) : this.input.suspend(session),
            ),
          );
        },
      );
      void Promise.allSettled([retired, safety]).then((results) => {
        clearTimeout(timer);
        const failure = results.find((result) => result.status === "rejected");
        if (failure?.status === "rejected") {
          this.#failed = true;
          reject(failure.reason);
        } else {
          // Late completion never closes a cancelled window; a fresh explicit retry
          // may observe the original receipts, without dispatching another stop.
          this.#failed = timedOut;
          resolve();
        }
      });
    } catch (error) {
      clearTimeout(timer);
      this.#failed = true;
      reject(error);
    }
    return this.#close;
  }
  reopen(): Promise<void> {
    if (!this.#close) return Promise.resolve();
    if (this.#reopen) return this.#reopen;
    const work = this.close(this.#reason).then(async () => {
      await Promise.all(this.#sessions.map((session) => this.input.resume(session)));
      await this.input.readmit();
      this.#close = undefined;
      this.#sessions = [];
      this.#captured = false;
      this.#deadline = undefined;
    });
    this.#reopen = work;
    void work.then(
      () => {
        this.#reopen = undefined;
      },
      () => {
        this.#reopen = undefined;
      },
    );
    return work;
  }
}
