import type { UpdateService } from "./service.js";

type Attempt = { work: Promise<void>; cancelled: boolean; installing: boolean };

/** One host-owned receipt shared by renderer IPC and native cancellation. */
export class UpdateInstallation {
  #attempt: Attempt | undefined;
  #recovery: Promise<void> | undefined;
  #installation: Promise<void> | undefined;
  constructor(
    private readonly updates: Pick<
      UpdateService,
      "preparing" | "prepareInstall" | "cancelInstall" | "install"
    >,
    private readonly prepareResources: () => Promise<void>,
    private readonly closeResources: () => Promise<void>,
    private readonly resumeResources: () => Promise<void> = async () => {},
    private readonly report: (error: unknown) => void = () => {},
  ) {}
  prepare(): Promise<void> {
    if (this.#recovery || this.#attempt?.cancelled || this.#attempt?.installing)
      return Promise.reject(new Error("Update preparation is busy."));
    if (this.#attempt) return this.#attempt.work;
    const attempt: Attempt = { work: Promise.resolve(), cancelled: false, installing: false };
    this.#attempt = attempt;
    this.#installation = undefined;
    attempt.work = Promise.resolve().then(async () => {
      if (attempt.cancelled) throw new Error("Update preparation cancelled.");
      this.updates.prepareInstall();
      await this.prepareResources();
      if (attempt.cancelled) throw new Error("Update preparation cancelled.");
    });
    void attempt.work.catch(() => {
      void this.failed().catch(this.report);
    });
    return attempt.work;
  }
  cancel(): Promise<void> {
    // A committed install owns its cleanup. Native navigation cannot reopen it.
    if (this.#attempt?.installing) return Promise.resolve();
    return this.failed();
  }
  failed(): Promise<void> {
    if (this.#recovery) return this.#recovery;
    const attempt = this.#attempt;
    if (!attempt) return Promise.resolve();
    attempt.cancelled = true;
    const recovery = Promise.resolve().then(async () => {
      await attempt.work.catch(() => undefined);
      await this.#installation?.catch(() => undefined);
      this.updates.cancelInstall();
      await this.resumeResources();
      if (this.#attempt === attempt) this.#attempt = undefined;
    });
    this.#recovery = recovery;
    void recovery.then(
      () => {
        if (this.#recovery === recovery) this.#recovery = undefined;
      },
      () => {
        if (this.#recovery === recovery) this.#recovery = undefined;
      },
    );
    return recovery;
  }
  install(): Promise<void> {
    const attempt = this.#attempt;
    if (!attempt || attempt.cancelled || attempt.installing || this.#recovery || this.#installation)
      return Promise.reject(new Error("No active prepared update."));
    const work = (async () => {
      await attempt.work;
      if (this.#attempt !== attempt || attempt.cancelled || !this.updates.preparing)
        throw new Error("No active prepared update.");
      attempt.installing = true;
      await this.closeResources();
      if (attempt.cancelled || !this.updates.preparing)
        throw new Error("No active prepared update.");
      this.updates.install();
    })();
    this.#installation = work;
    void work.catch(() => {
      void this.failed().catch(this.report);
    });
    return work;
  }
}
