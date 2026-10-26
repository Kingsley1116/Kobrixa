import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { PersistenceBackend, PublicationTicket } from "./engine-port.js";
import { createLegacyWriterBarrier, importIdFor, type LegacyWriterPort } from "./import-sources.js";
import { createLegacyImportCoordinator } from "./import-coordinator.js";
import { sensorLabImportDescriptors } from "./sensor-lab-import.js";
const SOURCE = "builtin:kobrixa.sensor-lab";
const identity = (owner: ResourceOwner) =>
  JSON.stringify([
    owner.sourceKey,
    owner.pluginId,
    owner.generation,
    owner.hostEpoch,
    owner.processEpoch,
  ]);
type Attempt = {
  key: string;
  control: AbortController;
  work: Promise<void>;
  callers: number;
  waits: number;
  done: boolean;
};
type Mapped = { plan: string; item: string; ticket?: PublicationTicket };
/** Host-only admission gate: neither half-imported history nor a second legacy
 * writer may become active before both durable descriptor markers are complete. */
export class SensorLabMigrationGate {
  #pending: Attempt | undefined;
  #ready: string | undefined;
  #callers = 0;
  // The coordinator's private retained pins must not be orphaned when an attempt
  // or owner ends. This bounded ledger owns only original cleanup, never grants.
  #mapped = new Map<string, Mapped>();
  #backend: PersistenceBackend;
  constructor(
    private readonly input: {
      backend: PersistenceBackend;
      writers: readonly LegacyWriterPort[];
      active(): boolean;
      owner(): ResourceOwner;
      currentScope(scope: CoreWindowScope): boolean;
    },
  ) {
    const original = input.backend;
    this.#backend = {
      ...original,
      sources: {
        ...original.sources,
        map: async (descriptor, item) => {
          if (this.#mapped.size >= 4) throw new Error("Sensor Lab mapped evidence limit");
          const result = await original.sources.map(descriptor, item);
          this.#mapped.set(result.mapped, { plan: importIdFor(descriptor, SOURCE), item });
          return result;
        },
        releaseMapped: async (handle) => {
          await original.sources.releaseMapped(handle);
          this.#mapped.delete(handle);
        },
      },
      imports: {
        ...original.imports,
        admit: async (owner, plan, item) => {
          const ticket = await original.imports.admit(owner, plan, item);
          for (const mapped of this.#mapped.values())
            if (mapped.plan === plan && mapped.item === item)
              mapped.ticket = structuredClone(ticket);
          return ticket;
        },
      },
    };
  }
  #owner(): ResourceOwner {
    if (!this.input.active()) throw new Error("Sensor Lab migration is not admitted");
    const owner = { ...this.input.owner() };
    if (owner.sourceKey !== SOURCE || owner.pluginId !== "kobrixa.sensor-lab")
      throw new Error("Sensor Lab migration owner mismatch");
    return owner;
  }
  #assertOwner(key: string): void {
    if (identity(this.#owner()) !== key) throw new Error("Sensor Lab migration owner retired");
  }
  /** Synchronous post-await activation fence. No data reads or queued work. */
  assertReady(): void {
    if (identity(this.#owner()) !== this.#ready)
      throw new Error("Sensor Lab migration is not ready for current owner");
  }
  async prepare(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const owner = this.#owner(),
      key = identity(owner);
    if (this.#ready === key) return;
    if (this.#callers >= 32) throw new Error("Sensor Lab migration caller limit");
    this.#callers++;
    try {
      const prior = this.#pending;
      if (prior && (prior.key !== key || prior.control.signal.aborted)) {
        // At most one wait for an ending attempt, then one fresh attempt. An
        // ordinary blocked result for this caller's own attempt never auto-retries.
        try {
          await this.#wait(prior, signal, false);
        } catch {
          signal.throwIfAborted();
          this.#assertOwner(key);
        }
      }
      signal.throwIfAborted();
      this.#assertOwner(key);
      if (this.#ready === key) return;
      const attempt = this.#pending ?? this.#start(owner);
      if (attempt.key !== key || attempt.control.signal.aborted)
        throw new Error("Sensor Lab migration prior attempt is settling");
      await this.#wait(attempt, signal, true);
      signal.throwIfAborted();
      this.#assertOwner(key);
      this.assertReady();
    } finally {
      this.#callers--;
    }
  }
  #wait(attempt: Attempt, signal: AbortSignal, participates: boolean): Promise<void> {
    if (signal.aborted) {
      if (participates && attempt.callers === 0 && !attempt.done) attempt.control.abort();
      return Promise.reject(signal.reason);
    }
    // Even aborted callers leave a promise reaction until shared work settles.
    // Bound total attachments, not just currently live callers.
    if (attempt.waits >= 32) return Promise.reject(new Error("Sensor Lab migration caller limit"));
    attempt.waits++;
    if (participates) attempt.callers++;
    return new Promise((resolve, reject) => {
      let ended = false;
      const finish = (failed: boolean, error?: unknown) => {
        if (ended) return;
        ended = true;
        signal.removeEventListener("abort", abort);
        if (participates && --attempt.callers === 0 && !attempt.done) attempt.control.abort();
        if (failed) reject(error);
        else resolve();
      };
      const abort = () => finish(true, signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      attempt.work.then(
        () => finish(false),
        (error) => finish(true, error),
      );
    });
  }
  async #cleanup(): Promise<void> {
    for (const [handle, mapped] of this.#mapped) {
      if (mapped.ticket) {
        const result = await this.input.backend.imports.reconcile(mapped.ticket);
        if (result.disposition === "unknown")
          throw new Error("Sensor Lab migration blocked; original publication unknown");
      }
      // With no admit ticket this map was never used for a publication attempt.
      // The worker independently refuses release of an unresolved original ticket.
      await this.input.backend.sources.releaseMapped(handle);
      this.#mapped.delete(handle);
    }
  }
  #start(owner: ResourceOwner): Attempt {
    const key = identity(owner),
      control = new AbortController();
    const attempt: Attempt = {
      key,
      control,
      work: Promise.resolve(),
      callers: 0,
      waits: 0,
      done: false,
    };
    this.#pending = attempt;
    const signal = control.signal;
    const original = () => {
      this.#assertOwner(key);
      return { ...owner };
    };
    attempt.work = (async () => {
      // Freeze synchronously before cleanup/resource I/O; ordinary old writes
      // still settle through the original durable barrier below.
      for (const writer of this.input.writers) {
        if (writer.sourceKey !== SOURCE) throw new Error("Foreign legacy writer");
        writer.freezeAdmission();
      }
      await this.#cleanup();
      signal.throwIfAborted();
      original();
      const barrier = createLegacyWriterBarrier({
        backend: this.#backend,
        descriptors: sensorLabImportDescriptors,
        writers: this.input.writers,
        importOwner: original,
      });
      const coordinator = createLegacyImportCoordinator({
        backend: this.#backend,
        sources: this.#backend.sources,
        barrier,
        descriptors: sensorLabImportDescriptors,
        currentScope: this.input.currentScope,
        currentSource: (source) =>
          source === SOURCE && this.input.active() && identity(this.input.owner()) === key,
        importOwner: original,
      });
      for (const descriptor of sensorLabImportDescriptors) {
        signal.throwIfAborted();
        original();
        const result = await coordinator.run(descriptor, signal);
        if (result.state !== "complete" && result.state !== "complete-empty")
          throw new Error("Sensor Lab migration blocked; original data retained");
      }
      signal.throwIfAborted();
      original();
      this.#ready = key;
    })().finally(() => {
      attempt.done = true;
      if (this.#pending === attempt) this.#pending = undefined;
    });
    // A synchronous legacy freeze callback can cancel the first caller before
    // it attaches. Keep the shared rejection observed even with no waiters.
    void attempt.work.catch(() => {});
    return attempt;
  }
}
