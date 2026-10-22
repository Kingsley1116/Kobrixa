import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { CoreRecoveryPort, CoreRecoverySnapshot } from "@kobrixa/plugin-runtime";
import { translated, registerRecoveryDiagnostics, type UiLabels } from "./recovery-support.js";
type RecoveryView = {
  hostEpoch: string | null;
  revision: number;
  items: CoreRecoverySnapshot["items"];
  nextCursor: string | null;
  problem: boolean;
  busy: string[];
};
export class CoreRecoveryStore {
  private view: RecoveryView = {
    hostEpoch: null,
    revision: -1,
    items: [],
    nextCursor: null,
    problem: false,
    busy: [],
  };
  private listeners = new Set<() => void>();
  private off: (() => void) | undefined;
  private serial = 0;
  private flight: Promise<void> | undefined;
  private again = false;
  private cursor: string | undefined;
  private deadlines = new Set<() => void>();
  constructor(private port: CoreRecoveryPort) {
    registerRecoveryDiagnostics(this, () => this.deadlines.size);
  }
  private wait<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.deadlines.delete(cancel);
      };
      const cancel = () => {
        finish();
        reject(new Error("Recovery deadline/disposal"));
      };
      const timer = setTimeout(cancel, 5000);
      this.deadlines.add(cancel);
      work.then(
        (value) => {
          finish();
          resolve(value);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  }
  getSnapshot = (): RecoveryView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(update: Partial<RecoveryView>) {
    this.view = { ...this.view, ...update };
    this.listeners.forEach((listener) => listener());
  }
  start(): Promise<void> {
    if (!this.off)
      this.off = this.port.onChanged(() => {
        void this.refresh();
      });
    return this.refresh();
  }
  refresh(): Promise<void> {
    this.cursor = undefined;
    this.serial++;
    return this.load();
  }
  next(): Promise<void> {
    if (!this.view.nextCursor) return Promise.resolve();
    this.cursor = this.view.nextCursor;
    this.serial++;
    return this.load();
  }
  private load(): Promise<void> {
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    this.flight = (async () => {
      do {
        this.again = false;
        const serial = this.serial;
        const cursor = this.cursor;
        const expected = { epoch: this.view.hostEpoch, revision: this.view.revision };
        try {
          const result = await this.wait(this.port.snapshot(cursor ? { cursor } : {}));
          if (serial !== this.serial) continue;
          if (!result.ok) throw new Error("Recovery unavailable");
          const page = result.value;
          if (
            page.items.length > 16 ||
            new TextEncoder().encode(JSON.stringify(page)).length > 262144 ||
            new Set(page.items.map((item) => item.id)).size !== page.items.length ||
            (cursor &&
              (page.hostEpoch !== expected.epoch ||
                page.revision !== expected.revision ||
                page.nextCursor === cursor)) ||
            (!cursor && page.hostEpoch === expected.epoch && page.revision < expected.revision)
          )
            throw new Error("Stale recovery page");
          this.publish({
            hostEpoch: page.hostEpoch,
            revision: page.revision,
            items: page.items,
            nextCursor: page.nextCursor,
            problem: false,
          });
        } catch {
          if (serial === this.serial) this.publish({ problem: true });
        }
      } while (this.again);
    })().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  async act(itemId: string, actionId: string): Promise<boolean> {
    if (
      this.view.busy.includes(itemId) ||
      !this.view.items
        .find((item) => item.id === itemId)
        ?.actions.some((action) => action.id === actionId)
    )
      return false;
    this.publish({ busy: [...this.view.busy, itemId] });
    try {
      const result = await this.port.act({ itemId, actionId });
      if (!result.ok) {
        this.publish({ problem: true });
        return false;
      }
      this.serial++;
      await this.refresh();
      return true;
    } catch {
      this.publish({ problem: true });
      return false;
    } finally {
      this.publish({ busy: this.view.busy.filter((id) => id !== itemId) });
    }
  }
  stop(): void {
    this.serial++;
    this.off?.();
    this.off = undefined;
    this.again = false;
    for (const cancel of [...this.deadlines]) cancel();
    this.listeners.clear();
  }
}
export function CoreRecoveryView({
  port,
  locale,
  labels,
  request = 0,
}: {
  port: CoreRecoveryPort;
  locale: "en" | "zh-TW";
  labels: UiLabels;
  request?: number;
}) {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (request > 0 && details.current) {
      details.current.open = true;
      details.current.querySelector("summary")?.focus();
    }
  }, [request]);
  const store = useMemo(() => new CoreRecoveryStore(port), [port]);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  useEffect(() => {
    void store.start();
    return () => store.stop();
  }, [store]);
  return (
    <section className="core-recovery" aria-label={labels.recovery} data-core-recovery="true">
      <details
        ref={details}
        open={view.items.some((item) =>
          ["unconfirmed", "save-failed", "interrupted", "process-failed"].includes(item.state),
        )}
      >
        <summary>
          {labels.recovery} ({view.items.length})
        </summary>
        {view.problem && <p role="alert">{labels.unavailable}</p>}
        <button onClick={() => void store.refresh()}>{labels.refresh}</button>
        {view.nextCursor && <button onClick={() => void store.next()}>{labels.next}</button>}
        {view.items.map((item) => (
          <article
            key={item.id}
            data-state={item.state}
            role={
              ["unconfirmed", "save-failed", "interrupted", "process-failed"].includes(item.state)
                ? "alert"
                : undefined
            }
          >
            <h3>{translated(item.title, locale)}</h3>
            <p>{translated(item.detail, locale)}</p>
            {item.actions.map((action) => (
              <button
                key={action.id}
                disabled={view.busy.includes(item.id)}
                onClick={() => {
                  void store.act(item.id, action.id);
                }}
              >
                {labels.actions[action.kind]}
              </button>
            ))}
          </article>
        ))}
      </details>
    </section>
  );
}
