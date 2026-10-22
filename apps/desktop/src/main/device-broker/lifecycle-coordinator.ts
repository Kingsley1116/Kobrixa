import type { DrainReason } from "@kobrixa/plugin-protocol";
import { randomUUID } from "node:crypto";
import { resumeQuiescedSession } from "./broker.js";
import type { DeviceDrainGrant } from "@kobrixa/plugin-runtime";
import type { Permission, ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  PluginManager,
  Principal,
  ProfileWriterLock,
  DeviceRequirement,
  Stage3HostAttachment,
  Stage3RuntimePorts,
} from "@kobrixa/plugin-runtime";
import type { CoreWindowScope } from "@kobrixa/plugin-runtime";
import type { StartPluginsOptions, PluginController } from "../plugins/controller.js";
import type { CoreActionLedger } from "../plugins/core-recovery.js";
import type { AuthorityPort } from "./authority-port.js";
import type { JournalPort } from "./journal-port.js";
import type { DeviceBrokerPort, LegacyOperationPort, DeviceOperationGate } from "./broker-port.js";
import type {
  ProviderCatalogPort,
  BuiltinDeviceProvider,
  DeviceConnectionPolicy,
} from "./provider.js";
export interface DesktopFoundationOptions {
  profile: ProfileWriterLock;
  authority: AuthorityPort;
  journal: JournalPort;
  coreActions: CoreActionLedger;
  now: () => number;
  hasPermission: (principal: Principal, permission: Permission) => boolean;
  requirements: (owner: ResourceOwner) => readonly DeviceRequirement[] | null;
  connectionPolicy: () => DeviceConnectionPolicy;
  operationGate: DeviceOperationGate;
  providerFactory?: (catalog: ProviderCatalogPort) => BuiltinDeviceProvider;
}
export type DesktopFoundation = {
  broker: DeviceBrokerPort & LegacyOperationPort;
  attachProvider(manager: Pick<PluginManager, "state" | "onEvent">): void;
  dispose(): Promise<void>;
};

export interface DesktopMainCompositionInput {
  createFoundation: typeof createDesktopFoundation;
  foundationOptions: DesktopFoundationOptions;
  plugins: Omit<StartPluginsOptions, "stage3" | "stage3Host" | "onStage3Runtime">;
  principal: Stage3HostAttachment["principal"];
  scope(): CoreWindowScope;
  currentScope(scope: CoreWindowScope): boolean;
  legacyFlush(reason: "close" | "update" | "suspend"): Promise<void>;
  report(error: unknown): void;
}
export interface DesktopMainComposition {
  foundation: DesktopFoundation;
  plugins: PluginController;
  stage3: Stage3RuntimePorts;
  stage3Host: Stage3HostAttachment;
  dispose(): Promise<void>;
}

import type { Handle } from "@kobrixa/plugin-protocol";
import type {
  CoreActionReference,
  DeviceDisposition,
  DeviceResourceParticipant,
  DeviceSessionControlPort,
  ReservationBindingPort,
  ReservationEnded,
  SessionQuiescence,
  PersistenceParticipant,
  DrainDispatcher,
  DrainOffer,
  DrainReport,
} from "@kobrixa/plugin-runtime";

import { retireStage3Owner } from "@kobrixa/plugin-runtime";
import type { OwnerRetirement } from "@kobrixa/plugin-runtime";
const ownerKey = (o: ResourceOwner) =>
  JSON.stringify([o.sourceKey, o.pluginId, o.generation, o.hostEpoch, o.processEpoch]);
const saved = (): DrainReport => ({
  state: "saved",
  blocker: false,
  pendingSettings: false,
  records: [],
  errors: [],
});
function uncertain(message: string): DrainReport {
  return {
    state: "uncertain",
    blocker: true,
    pendingSettings: false,
    records: [],
    errors: [{ code: "PLUGIN_E_TIMEOUT", message }],
  };
}
export class CleanupBlocked extends Error {
  constructor(
    readonly device: DeviceDisposition | null,
    readonly storage: readonly DrainReport[],
  ) {
    super("Device or persistence disposition is incomplete.");
  }
}
export interface CoordinatorInput {
  ports: Stage3RuntimePorts;
  resources: DeviceResourceParticipant;
  sessions: DeviceSessionControlPort;
  reservations: ReservationBindingPort;
  persistence: PersistenceParticipant;
  dispatch: DrainDispatcher;
  alive(owner: ResourceOwner): boolean;
  owners(): readonly ResourceOwner[];
  now(): number;
  shutdown(): Promise<void>;
  legacyFlush(reason: "close" | "update" | "suspend"): Promise<void>;
  report(error: unknown): void;
}
type EndWork = {
  event: ReservationEnded;
  offer: DrainOffer | null;
  promise: Promise<DrainReport>;
  resolve(report: DrainReport): void;
  terminal: boolean;
};
type RetirementWork = {
  device: Promise<DeviceDisposition>;
  storage: Promise<DrainReport>;
  done: Promise<void>;
};
type SuspendWork = {
  receipt: SessionQuiescence;
  deadline: number;
  work: Promise<void>;
  wake?: Promise<void>;
};
export class LifecycleCoordinator {
  readonly #ends = new Map<string, EndWork>();
  readonly #retiring = new Map<string, RetirementWork>();
  readonly #suspending = new Map<Handle, SuspendWork>();
  readonly #disconnecting = new Map<string, Promise<void>>();
  readonly #off: () => void;
  #close: Promise<void> | undefined;
  #closeStarted: number | undefined;
  #closed = false;
  constructor(private readonly input: CoordinatorInput) {
    if (input.ports.device !== input.resources || input.ports.persistence !== input.persistence)
      throw new Error("Coordinator must share the runtime participants.");
    this.#off = input.reservations.onEnded((event) => this.#ended(event));
  }
  #bounded<T>(work: Promise<T>, deadline: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(message)),
        Math.max(0, deadline - this.input.now()),
      );
      work.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }
  #observe(work: Promise<DrainReport>, deadline: number): Promise<DrainReport> {
    return this.#bounded(work, deadline, "Persistence final drain deadline expired.").catch(
      (error: unknown) => {
        this.input.report(error);
        return uncertain("Persistence final drain is unconfirmed.");
      },
    );
  }
  #ended(event: ReservationEnded): void {
    const key = `${ownerKey(event.owner)}:${event.reservationId}`;
    if (this.#ends.has(key)) return;
    const deadline = Math.min(
      event.endedMonotonicMs + 10_000,
      event.drain?.expiresMonotonicMs ?? event.endedMonotonicMs + 10_000,
      this.#closeStarted === undefined ? Infinity : this.#closeStarted + 10_000,
    );
    // This synchronous call fences pending registration before any dispatch or await.
    const offer = this.input.persistence.endReservation(event, deadline);
    let resolve!: (report: DrainReport) => void;
    const promise = new Promise<DrainReport>((done) => {
      resolve = done;
    });
    const work: EndWork = { event, offer, promise, resolve, terminal: false };
    this.#ends.set(key, work);
    queueMicrotask(() => {
      const retirement = this.#retiring.get(ownerKey(event.owner));
      const pending = retirement
        ? retirement.storage
        : !offer
          ? Promise.resolve(saved())
          : !event.drain || !this.input.alive(event.owner)
            ? this.input.persistence.ownerLost(event.owner)
            : this.input.persistence.drain(offer, this.input.dispatch);
      // R150/D170 handoff: split retireStage3Owner's persistence promise from its
      // joined receipt so storage alone can be bounded at the original <=10 s offer.
      // Until then this is the device+storage join (15 s stop + 5 s journal), not
      // permission to extend a persistence offer or the drain dispatch signal.
      void this.#observe(
        pending,
        retirement ? event.endedMonotonicMs + 20_000 : (offer?.deadlineMonotonicMs ?? deadline),
      ).then((report) => {
        work.terminal = report.state === "saved" && !report.blocker;
        resolve(report);
        // Unresolved evidence is never evicted; persistence enforces its 64-host recovery cap.
        // Only successful terminal receipts count toward this bounded dedupe cache.
        const terminal = [...this.#ends.entries()].filter(([, item]) => item.terminal);
        for (const [oldKey] of terminal.slice(0, Math.max(0, terminal.length - 256)))
          this.#ends.delete(oldKey);
      });
    });
  }
  retire(
    owner: ResourceOwner,
    reason: OwnerRetirement,
    deadlineMonotonicMs?: number,
  ): Promise<void> {
    const key = ownerKey(owner),
      existing = this.#retiring.get(key);
    if (existing) return existing.done;
    const t0 = this.input.now();
    const receipt = retireStage3Owner(
      this.input.ports,
      owner,
      this.input.alive(owner) ? reason : "crashed",
      this.input.now,
      this.input.dispatch,
      deadlineMonotonicMs,
    );
    const device = this.#bounded(
      receipt.then((value) => value.device),
      t0 + 20_000,
      "Device stop/journal deadline expired.",
    );
    const storage = receipt.then((value) => value.persistence);
    const done = Promise.all([device, storage]).then(([d, report]) => this.#assert(d, [report]));
    this.#retiring.set(key, { device, storage, done });
    void done.catch((error: unknown) => this.input.report(error));
    return done;
  }
  #assert(device: DeviceDisposition, storage: readonly DrainReport[]): void {
    if (
      !device.stopConfirmed ||
      !device.journalCommitted ||
      storage.some(
        (report) =>
          report.blocker ||
          report.state !== "saved" ||
          report.pendingSettings ||
          report.errors.length > 0 ||
          report.records.some((record) => !record.final || record.committedRevision === null),
      )
    )
      throw new CleanupBlocked(device, storage);
  }
  async #sessionReports(sessionId: Handle): Promise<DrainReport[]> {
    return Promise.all(
      [...this.#ends.values()]
        .filter((work) => work.event.sessionId === sessionId)
        .map((work) => work.promise),
    );
  }
  disconnect(sessionId: Handle, action: CoreActionReference): Promise<void> {
    const key = `${sessionId}:${action.scope.hostEpoch}:${action.scope.workbenchInstance}:${action.actionToken}`;
    const existing = this.#disconnecting.get(key);
    if (existing) return existing;
    if (this.#disconnecting.size >= 256)
      return Promise.reject(new Error("Disconnect receipt capacity reached."));
    const work = this.#disconnect(sessionId, action);
    this.#disconnecting.set(key, work);
    return work;
  }
  async #disconnect(sessionId: Handle, action: CoreActionReference): Promise<void> {
    const t0 = this.input.now();
    const quiescence = this.input.sessions.quiesce(sessionId, {
      reason: "core-disconnect",
      action,
    });
    // onEnded already saw these events; duplicate calls only reconcile the indexed evidence.
    for (const event of quiescence.ended) this.#ended(event);
    const [device, storage] = await Promise.all([
      this.#bounded(quiescence.settled, t0 + 20_000, "Disconnect stop/journal deadline expired."),
      this.#sessionReports(sessionId),
      this.input.legacyFlush("close"),
    ]);
    this.#assert(device, storage);
    const result = await this.input.sessions.disconnect(sessionId, action);
    if (!result.ok) throw new Error(result.error.message);
  }
  async suspend(sessionId: Handle): Promise<void> {
    const existing = this.#suspending.get(sessionId);
    if (existing) return existing.work;
    const t0 = this.input.now();
    const quiescence = this.input.sessions.quiesce(sessionId, { reason: "suspended" });
    for (const event of quiescence.ended) this.#ended(event);
    const work = Promise.all([
      this.#bounded(quiescence.settled, t0 + 20_000, "Suspend stop/journal deadline expired."),
      this.#sessionReports(sessionId),
      this.input.legacyFlush("suspend"),
    ]).then(([device, storage]) => this.#assert(device, storage));
    const row: SuspendWork = { receipt: quiescence, deadline: t0 + 20_000, work };
    this.#suspending.set(sessionId, row);
    void work.catch((error: unknown) => {
      if (this.#suspending.get(sessionId) === row) this.#suspending.delete(sessionId);
      this.input.report(error);
    });
    return work;
  }
  resume(sessionId: Handle): Promise<void> {
    const row = this.#suspending.get(sessionId);
    if (!row) return Promise.resolve();
    if (row.wake) return row.wake;
    const wake = this.#resume(row);
    row.wake = wake;
    void wake.then(
      () => {
        if (this.#suspending.get(sessionId) === row) this.#suspending.delete(sessionId);
      },
      () => {
        // Keep the original receipt retryable. Neither a blocked admission nor
        // an observation timeout is a successful wake or a new cleanup grant.
        if (row.wake === wake) delete row.wake;
      },
    );
    return wake;
  }
  async #resume(row: SuspendWork): Promise<void> {
    await row.work;
    for (;;) {
      const device = await this.#bounded(
        row.receipt.settled,
        row.deadline,
        "Wake stop/journal observation deadline expired.",
      );
      this.#assert(device, []);
      const state = resumeQuiescedSession(this.input.sessions, row.receipt);
      if (state === "resumed") return;
      if (state === "blocked") throw new Error("Session remains quiesced; wake is blocked.");
      if (this.input.now() >= row.deadline)
        throw new Error("Wake stop/journal observation deadline expired.");
      // Recovery raced the await above. Re-observe the same receipt and deadline,
      // without calling quiesce, replaying legacy flush or renewing provider work.
    }
  }
  close(reason: "close" | "update"): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#close) return this.#close;
    this.#closeStarted ??= this.input.now();
    const t0 = this.#closeStarted;
    // beginShutdown synchronously closes the host admission gate before returning its promise.
    const device = this.input.resources.beginShutdown();
    const owners = this.input
      .owners()
      .map((owner) => this.retire(owner, reason === "update" ? "update" : "shutdown", t0 + 10_000));
    const legacy = this.input.legacyFlush(reason);
    const attempt = Promise.all([
      this.#bounded(device, t0 + 20_000, "Host stop/journal deadline expired."),
      Promise.all(owners),
      this.#bounded(legacy, t0 + 10_000, "Legacy Lab save deadline expired."),
      Promise.all([...this.#ends.values()].map((work) => work.promise)),
    ]).then(async ([d, , , reports]) => {
      this.#assert(d, reports);
      await this.#bounded(
        this.input.shutdown(),
        Math.min(t0 + 24_000, this.input.now() + 4_000),
        "Plugin process exit is unconfirmed.",
      );
    });
    const bounded = this.#bounded(
      attempt,
      t0 + 25_000,
      "Close safety net expired; cleanup remains blocked.",
    );
    this.#close = bounded;
    void bounded.then(
      () => {
        this.#close = undefined;
        this.#closed = true;
      },
      (error: unknown) => {
        this.#close = undefined;
        this.input.report(error);
      },
    );
    return bounded;
  }
  dispose(): void {
    this.#off();
  }
}

export function createResourceFreePersistence(
  isResourceFree: (owner: ResourceOwner) => boolean,
): PersistenceParticipant {
  const offers = new Map<string, DrainOffer>();
  const known = new WeakSet<DrainOffer>();
  const blocked = new Map<string, { owner: ResourceOwner; recovery: Handle }>();
  let revision = 0;
  const report = (owner: ResourceOwner): DrainReport => {
    const item = blocked.get(ownerKey(owner));
    if (!item && isResourceFree(owner)) return saved();
    return {
      state: "checkpoint-only",
      blocker: true,
      pendingSettings: false,
      records: [],
      ...(item ? { recovery: item.recovery } : {}),
      errors: [
        {
          code: "PLUGIN_E_DEVICE_UNAVAILABLE",
          message: "Persistence adapter is unavailable for this resource owner.",
        },
      ],
    };
  };
  const block = (owner: ResourceOwner): void => {
    const key = ownerKey(owner);
    if (blocked.has(key)) return;
    if (blocked.size >= 64) throw new Error("Persistence recovery capacity reached.");
    blocked.set(key, { owner: { ...owner }, recovery: randomUUID() });
    revision++;
  };
  const offer = (
    owner: ResourceOwner,
    reason: DrainReason,
    deadline: number,
    key: string,
  ): DrainOffer => {
    const previous = offers.get(key);
    if (previous) return previous;
    if (offers.size >= 256) throw new Error("Resource-free participant receipt capacity reached.");
    const value: DrainOffer = Object.freeze({
      owner: Object.freeze({ ...owner }),
      reason,
      deadlineMonotonicMs: deadline,
      token: randomUUID(),
      checkpoints: [],
      writes: [],
      acceptedTickets: [],
    });
    offers.set(key, value);
    known.add(value);
    return value;
  };
  return {
    endReservation(event, deadline) {
      // Seeing a reservation means this owner is outside this adapter's resource-free allowance.
      block(event.owner);
      return offer(
        event.owner,
        "reservation-ended",
        Math.min(
          deadline,
          event.endedMonotonicMs + 10_000,
          event.drain?.expiresMonotonicMs ?? Infinity,
        ),
        `${ownerKey(event.owner)}:${event.reservationId}`,
      );
    },
    freeze(owner, reason, deadline, deviceDrain?: DeviceDrainGrant) {
      if (reason === "reservation-ended")
        throw new Error("Reservation end is not owner retirement.");
      if (deviceDrain || !isResourceFree(owner)) block(owner);
      return offer(
        owner,
        reason,
        Math.min(deadline, deviceDrain?.expiresMonotonicMs ?? Infinity),
        ownerKey(owner),
      );
    },
    async drain(value) {
      if (!known.has(value)) throw new Error("Foreign drain offer.");
      return report(value.owner);
    },
    async ownerLost(owner) {
      if (!isResourceFree(owner)) block(owner);
      return report(owner);
    },
    recoverySnapshot() {
      return {
        revision,
        items: [...blocked.values()].map(({ owner, recovery }) => ({
          id: recovery,
          sourceKey: owner.sourceKey,
          pluginId: owner.pluginId,
          recordId: null,
          committedRevision: null,
          state: "checkpoint-only" as const,
          payload: "none" as const,
          actions: [],
        })),
      };
    },
    async retry() {
      throw new Error("Persistence recovery adapter is unavailable.");
    },
    async discard() {
      throw new Error("Persistence recovery adapter is unavailable.");
    },
  };
}

import { createDeviceBroker } from "./broker-port.js";
import { attachBuiltinDeviceProvider } from "../plugins/builtin.js";
export async function createDesktopFoundation(
  input: DesktopFoundationOptions,
): Promise<DesktopFoundation> {
  input.profile.assertHeld();
  await input.journal.load();
  input.profile.assertHeld();
  const broker = createDeviceBroker({
    profile: input.profile,
    authority: input.authority,
    journal: input.journal,
    coreActions: input.coreActions,
    now: input.now,
    hasPermission: input.hasPermission,
    requirements: input.requirements,
    connectionPolicy: input.connectionPolicy,
    operationGate: input.operationGate,
  });
  let attached = false,
    disposed = false;
  let detach: (() => void) | undefined;
  let disposal: Promise<void> | undefined;
  return {
    broker,
    attachProvider(manager) {
      if (disposed || disposal) throw new Error("Foundation disposal has started.");
      if (attached) throw new Error("Provider attachment is one-shot.");
      attached = true;
      detach = attachBuiltinDeviceProvider(
        manager,
        broker,
        broker.providerCatalog("kobrixa.device-ev3"),
        input.providerFactory,
      );
    },
    dispose() {
      if (disposed) return Promise.resolve();
      if (disposal) return disposal;
      const attempt = (async () => {
        input.profile.assertHeld();
        const disposition = await broker.resources.beginShutdown();
        if (!disposition.stopConfirmed || !disposition.journalCommitted)
          throw new CleanupBlocked(disposition, []);
        detach?.();
        disposed = true;
      })();
      disposal = attempt;
      void attempt.catch(() => {
        disposal = undefined;
      });
      return attempt;
    },
  };
}
