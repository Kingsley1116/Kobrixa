/** A crashed/loading renderer cannot acknowledge saves owned by the main process. */
export class MainProcessCloseGuard {
  private pending: Promise<void> | undefined;
  ready = false;

  constructor(
    private flush: () => Promise<void>,
    private close: () => void,
    private retry: (error: unknown) => Promise<boolean>,
    private cancel: () => void,
  ) {}

  request(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.pending) return this.pending;
    const work = this.attempt().finally(() => {
      if (this.pending === work) this.pending = undefined;
    });
    this.pending = work;
    return work;
  }

  private async attempt(): Promise<void> {
    for (;;) {
      try {
        await this.flush();
      } catch (error) {
        // Failure to display a dialog must never turn a failed save into approval.
        if (await this.retry(error).catch(() => false)) continue;
        this.cancel();
        return;
      }
      this.ready = true;
      this.close();
      return;
    }
  }
}
