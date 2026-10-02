import { randomUUID } from "node:crypto";

/** A failed or stale renderer acknowledgement can never close the window. */
export class CloseHandshake {
  private requestId: string | undefined;
  ready = false;
  constructor(
    private send: (id: string) => void,
    private close: () => void,
  ) {}
  request(): void {
    if (this.requestId || this.ready) return;
    this.requestId = randomUUID();
    this.send(this.requestId);
  }
  finish(id: string, ready: boolean): boolean {
    if (id !== this.requestId) return false;
    this.requestId = undefined;
    if (!ready) return true;
    this.ready = true;
    this.close();
    return true;
  }
  reset(): void {
    this.requestId = undefined;
    this.ready = false;
  }
}
