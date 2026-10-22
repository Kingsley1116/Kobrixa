import type { OwnerRetirement as ImportedOwnerRetirement } from "@kobrixa/plugin-runtime";
import { afterEach, expect, it, vi } from "vitest";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  DeviceDisposition,
  DeviceRecoveryPort,
  DeviceRecoverySnapshot,
  SafetyFaultEntry,
  DeviceDrainGrant,
  ReservationEnded,
  PersistenceParticipant,
  DrainOffer,
  DrainReport,
  CoreActionReference,
} from "@kobrixa/plugin-runtime";
import { unavailableUi150 } from "@kobrixa/plugin-runtime";
import {
  LifecycleCoordinator,
  createResourceFreePersistence,
  createDesktopFoundation,
  type CoordinatorInput,
} from "./lifecycle-coordinator.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const owner: ResourceOwner = {
  sourceKey: "dev:0123456789abcdef",
  pluginId: "test.consumer",
  generation: 1,
  hostEpoch: id(1),
  processEpoch: id(2),
};
const clean: DeviceDisposition = { stopConfirmed: true, journalCommitted: true, faultIds: [] };
const saved: DrainReport = {
  state: "saved",
  blocker: false,
  pendingSettings: false,
  records: [],
  errors: [],
};
const action: CoreActionReference = {
  actionToken: id(9),
  scope: { hostEpoch: id(1), workbenchInstance: id(10) },
};
const grant: DeviceDrainGrant = {
  owner,
  reservationId: id(4),
  lastSequence: 8,
  expiresMonotonicMs: 10_000,
};
const ended: ReservationEnded = {
  owner,
  reservationId: id(4),
  sessionId: id(3),
  providerGeneration: 1,
  reason: "released",
  lastSequence: 8,
  endedMonotonicMs: 0,
  drain: grant,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(recovery?: DeviceRecoveryPort) {
  const trace: string[] = [];
  let onEnded: (event: ReservationEnded) => void = () => {};
  let now = 0;
  const offer: DrainOffer = {
    owner,
    reason: "reservation-ended",
    deadlineMonotonicMs: 10_000,
    token: id(5),
    checkpoints: [],
    writes: [],
    acceptedTickets: [],
  };
  const storage = deferred<DrainReport>(),
    device = deferred<DeviceDisposition>();
  const persistence = {
    endReservation: vi.fn(() => {
      trace.push("end");
      return offer;
    }),
    freeze: vi.fn(() => {
      trace.push("freeze");
      return { ...offer, reason: "disable" as const };
    }),
    drain: vi.fn(async () => {
      trace.push("drain");
      return storage.promise;
    }),
    ownerLost: vi.fn(async () => ({ ...saved, state: "checkpoint-only" as const, blocker: true })),
  } as unknown as PersistenceParticipant;
  const resources = {
    retire: vi.fn<CoordinatorInput["resources"]["retire"]>(() => {
      trace.push("retire");
      onEnded(ended);
      return { drain: grant, settled: device.promise };
    }),
    retireProvider: vi.fn(async () => clean),
    beginShutdown: vi.fn(() => {
      trace.push("shutdown-device");
      return device.promise;
    }),
  };
  const sessions = {
    quiesce: vi.fn(() => {
      trace.push("quiesce");
      onEnded(ended);
      return { sessionId: id(3), ended: [ended], settled: device.promise };
    }),
    disconnect: vi.fn(async () => {
      trace.push("disconnect");
      return { ok: true as const, value: { sessionId: id(3), disconnected: true as const } };
    }),
    resume: vi.fn(),
  };
  const shutdown = vi.fn(async () => {
    trace.push("manager");
  });
  const legacyFlush = vi.fn(async () => {
    trace.push("legacy");
  });
  const alive = vi.fn(() => true);
  const input: CoordinatorInput = {
    ...(recovery ? { recovery } : {}),
    ports: { device: resources, persistence, ui: unavailableUi150() },
    resources,
    sessions,
    reservations: {
      validate: () => null,
      onEnded: vi.fn((listener) => {
        onEnded = listener;
        return vi.fn();
      }),
    },
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive,
    owners: () => [owner],
    now: () => now,
    shutdown,
    legacyFlush,
    report: vi.fn(),
  };
  const coordinator = new LifecycleCoordinator(input);
  return {
    coordinator,
    persistence,
    resources,
    sessions,
    storage,
    device,
    trace,
    shutdown,
    legacyFlush,
    alive,
    input,
    emit: (event = ended) => onEnded(event),
    time: (value: number) => {
      now = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
it("a closed channel cannot substitute for actual exit while the owner is still retained", async () => {
  const f = fixture();
  const retiring = f.coordinator.retire(owner, "update");
  f.device.resolve(clean);
  f.storage.resolve(saved);
  await retiring;
  f.alive.mockReturnValue(false);
  f.coordinator.reconcileProcesses();
  expect(f.coordinator.reports()[0]).toMatchObject({ processStopped: false, blocker: true });
  f.input.owners = () => [];
  f.coordinator.reconcileProcesses();
  expect(f.coordinator.reports()[0]).toMatchObject({ processStopped: true, blocker: false });
  expect(f.resources.retire).toHaveBeenCalledOnce();
  f.coordinator.dispose();
});
it("D160 wake rechecks reconciled storage on the original suspension without another drain", async () => {
  const f = fixture();
  const suspension = f.coordinator.suspend(id(3));
  const blocked = expect(suspension).rejects.toThrow("disposition");
  f.device.resolve(clean);
  f.storage.resolve({ ...saved, recovery: id(55), state: "retryable", blocker: true });
  await blocked;
  await expect(f.coordinator.resume(id(3))).rejects.toThrow("disposition");
  expect(f.sessions.resume).not.toHaveBeenCalled();
  f.coordinator.reconcileRecovery(id(55), saved);
  await f.coordinator.resume(id(3));
  expect(f.sessions.resume).toHaveBeenCalledOnce();
  expect(f.sessions.quiesce).toHaveBeenCalledOnce();
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  expect(f.legacyFlush).toHaveBeenCalledOnce();
  f.coordinator.dispose();
});
it("A-RF5/F19 installs one listener, fences synchronously, and merges same-turn retire/freeze", async () => {
  const f = fixture();
  expect(f.input.reservations.onEnded).toHaveBeenCalledOnce();
  const retiring = f.coordinator.retire(owner, "disable");
  expect(f.trace).toEqual(["retire", "end", "freeze"]);
  expect(f.persistence.freeze).toHaveBeenCalledWith(owner, "disable", 10_000, grant);
  await Promise.resolve();
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  f.emit();
  f.time(4_000);
  expect(f.coordinator.retire({ ...owner }, "disable")).toBe(retiring);
  expect(f.persistence.freeze).toHaveBeenCalledTimes(1);
  expect(f.persistence.endReservation).toHaveBeenCalledTimes(1);
  f.storage.resolve(saved);
  f.device.resolve(clean);
  await retiring;
  expect(f.persistence.drain).toHaveBeenCalledTimes(1);
});
it("F19 omits freeze's fourth argument for a null grant", async () => {
  const f = fixture();
  f.resources.retire.mockImplementation(() => ({ drain: null, settled: Promise.resolve(clean) }));
  const work = f.coordinator.retire(owner, "reload");
  expect(vi.mocked(f.persistence.freeze).mock.calls[0]).toEqual([owner, "reload", 10_000]);
  f.storage.resolve(saved);
  await work;
});
it.each([
  "released",
  "source-changed",
  "limit",
  "overflow",
  "disconnected",
  "suspended",
  "core-disconnect",
] as const)("F19 %s ends only the recording, retaining its healthy process", async (reason) => {
  const f = fixture();
  f.emit({ ...ended, reason });
  await Promise.resolve();
  expect(f.persistence.endReservation).toHaveBeenCalledWith({ ...ended, reason }, 10_000);
  expect(f.resources.retire).not.toHaveBeenCalled();
  expect(f.persistence.freeze).not.toHaveBeenCalled();
  f.storage.resolve(saved);
  await Promise.resolve();
  expect(f.shutdown).not.toHaveBeenCalled();
});
it("A-RF5 Disconnect waits for a previously ended pending registration and the stop journal", async () => {
  const f = fixture();
  f.emit();
  await Promise.resolve();
  f.sessions.quiesce.mockImplementation(() => ({
    sessionId: id(3),
    ended: [],
    settled: f.device.promise,
  }));
  const work = f.coordinator.disconnect(id(3), action);
  f.device.resolve(clean);
  await Promise.resolve();
  expect(f.sessions.disconnect).not.toHaveBeenCalled();
  f.storage.resolve(saved);
  await work;
  expect(f.sessions.disconnect).toHaveBeenCalledExactlyOnceWith(id(3), action);
  expect(f.resources.retire).not.toHaveBeenCalled();
  expect(f.shutdown).not.toHaveBeenCalled();
});
it.each([
  { ...saved, state: "retryable" as const, blocker: true },
  { ...saved, state: "checkpoint-only" as const, blocker: true },
  { ...saved, state: "uncertain" as const, blocker: true },
  { ...saved, pendingSettings: true },
])("F19 failed/unknown saving blocks disconnect: %j", async (report) => {
  const f = fixture();
  const work = f.coordinator.disconnect(id(3), action);
  f.storage.resolve(report);
  f.device.resolve(clean);
  await expect(work).rejects.toThrow("disposition");
  expect(f.sessions.disconnect).not.toHaveBeenCalled();
});
it("F19 suspend keeps generation/process alive, and wake does not replay work", async () => {
  const f = fixture();
  const work = f.coordinator.suspend(id(3));
  expect(f.sessions.quiesce).toHaveBeenCalledWith(id(3), { reason: "suspended" });
  f.storage.resolve(saved);
  f.device.resolve(clean);
  await work;
  await f.coordinator.resume(id(3));
  expect(f.sessions.resume).toHaveBeenCalledOnce();
  expect(f.resources.retire).not.toHaveBeenCalled();
  expect(f.shutdown).not.toHaveBeenCalled();
});
it("F17 dead owner and null grant reconcile host tickets without dispatching the process", async () => {
  const f = fixture();
  f.alive.mockReturnValue(false);
  f.emit({ ...ended, drain: null });
  await Promise.resolve();
  await Promise.resolve();
  expect(f.persistence.ownerLost).toHaveBeenCalledWith(owner);
  expect(f.persistence.drain).not.toHaveBeenCalled();
});
it("F17 stop and storage run in parallel, and process teardown waits for final journal", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const work = f.coordinator.close("close");
  expect(f.resources.beginShutdown).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  f.storage.resolve(saved);
  f.time(15_000);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.shutdown).not.toHaveBeenCalled();
  f.time(19_999);
  await vi.advanceTimersByTimeAsync(4_999);
  f.device.resolve(clean);
  await work;
  expect(f.shutdown).toHaveBeenCalledOnce();
  expect(f.trace.indexOf("manager")).toBeGreaterThan(f.trace.indexOf("drain"));
});
it("F17 unconfirmed stop, failed journal and unavailable legacy storage never become clean", async () => {
  for (const disposition of [
    { ...clean, stopConfirmed: false },
    { ...clean, journalCommitted: false },
  ]) {
    const f = fixture();
    const work = f.coordinator.close("close");
    f.storage.resolve(saved);
    f.device.resolve(disposition);
    await expect(work).rejects.toThrow("disposition");
    expect(f.shutdown).not.toHaveBeenCalled();
  }
  const f = fixture();
  f.legacyFlush.mockRejectedValue(new Error("legacy Lab disk full"));
  const work = f.coordinator.close("update");
  f.storage.resolve(saved);
  f.device.resolve(clean);
  await expect(work).rejects.toThrow("legacy Lab disk full");
  expect(f.shutdown).not.toHaveBeenCalled();
});
it("F17 all owners share t0; timeout does not kill, renew storage or release the profile", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const work = f.coordinator.close("close");
  const rejected = expect(work).rejects.toThrow();
  f.time(25_000);
  await vi.advanceTimersByTimeAsync(25_000);
  await rejected;
  expect(f.shutdown).not.toHaveBeenCalled();
  expect(vi.mocked(f.persistence.freeze).mock.calls[0]![2]).toBe(10_000);
  expect(f.resources.retire).toHaveBeenCalledTimes(1);
});

it("F17 empty participant requires positive resource-free proof and never fakes a recording save", async () => {
  const persistence = createResourceFreePersistence(() => true);
  const empty = persistence.freeze(owner, "disable", 10_000);
  const dispatch = vi.fn(async () => ({
    ok: true as const,
    value: { status: "submitted" as const, writes: [] },
  }));
  await expect(persistence.drain(empty, dispatch)).resolves.toMatchObject({
    state: "saved",
    blocker: false,
  });
  const recording = persistence.endReservation(ended, 10_000)!;
  await expect(persistence.drain(recording, dispatch)).resolves.toMatchObject({
    state: "checkpoint-only",
    blocker: true,
  });
  expect(dispatch).not.toHaveBeenCalled();
  expect(persistence.recoverySnapshot().items).toHaveLength(1);
  await expect(persistence.ownerLost(owner)).resolves.toMatchObject({ blocker: true });
});
it("F19 an empty-adapter retry cannot grant another final window or hide a supplied drain", async () => {
  const persistence = createResourceFreePersistence(() => true);
  const first = persistence.freeze(owner, "disable", 10_000, grant);
  const again = persistence.freeze(owner, "reload", 20_000, {
    ...grant,
    expiresMonotonicMs: 20_000,
  });
  expect(again).toBe(first);
  expect(again.deadlineMonotonicMs).toBe(10_000);
  await expect(
    persistence.drain(first, async () => {
      throw new Error("must not dispatch");
    }),
  ).resolves.toMatchObject({ state: "checkpoint-only", blocker: true });
});
it.each([
  ["disable", "disabled", "disable"],
  ["reload", "reload", "reload"],
  ["remove", "disabled", "remove"],
  ["renderer-crash", "renderer-lost", "renderer-crash"],
  ["window-destroyed", "renderer-lost", "window-destroyed"],
  ["shutdown", "shutdown", "shutdown"],
  ["update", "shutdown", "update"],
  ["safe-mode", "safe-mode", "safe-mode"],
] as const)(
  "F17 maps %s exactly without creating sibling enum variants",
  async (event, deviceReason, storageReason) => {
    const f = fixture();
    const task = f.coordinator.retire(owner, event);
    expect(f.resources.retire).toHaveBeenCalledWith(owner, deviceReason);
    expect(f.persistence.freeze).toHaveBeenCalledWith(owner, storageReason, 10_000, grant);
    f.device.resolve(clean);
    f.storage.resolve(saved);
    await task;
  },
);
it("F17 crash uses ownerLost and does not issue an impossible drain callback", async () => {
  const f = fixture();
  const task = f.coordinator.retire(owner, "crashed");
  const assertion = expect(task).resolves.toBeUndefined();
  f.device.resolve(clean);
  await assertion;
  expect(f.coordinator.reports()[0]).toMatchObject({ blocker: true, processStopped: false });
  expect(f.resources.retire).toHaveBeenCalledWith(owner, "crashed");
  expect(f.persistence.freeze).not.toHaveBeenCalled();
  expect(f.persistence.drain).not.toHaveBeenCalled();
  expect(f.persistence.ownerLost).toHaveBeenCalledWith(owner);
});

it.each([false, true])(
  "F17/F19 live supervisor retirement uses the coordinator helper, null grant=%s",
  async (nullGrant) => {
    const { PluginSupervisor } = await import("@kobrixa/plugin-runtime");
    const { memoryPlugin } =
      await import("../../../../../packages/plugin-runtime/src/test-process.js");
    const f = fixture();
    const uiRetire = vi.spyOn(f.input.ports.ui, "retire");
    if (nullGrant)
      f.resources.retire.mockImplementation(() => ({ drain: null, settled: f.device.promise }));
    const child = memoryPlugin((peer, control) => {
      peer.handle("initialize", () => ({
        apiVersion: "1.5.0",
        sdk: { name: "fixture", version: "1" },
      }));
      peer.handle("command/execute", () => null);
      peer.handle("shutdown", () => {
        f.trace.push("process-shutdown");
        return null;
      });
      peer.onNotification("exit", () => control.exit());
    });
    const attachment = {
      retireResources: (original: ResourceOwner, reason: ImportedOwnerRetirement) =>
        f.coordinator.retire(original, reason, 8000),
    };
    const supervisor = new PluginSupervisor(
      {
        id: owner.pluginId,
        sourceKey: owner.sourceKey,
        directory: "/fixture",
        entry: "/fixture/main.cjs",
        runtime: "node",
        permissions: [],
        commands: ["test.consumer.run"],
      },
      async () => child.process,
      {
        locale: "en",
        onNotice() {},
        hostEpoch: owner.hostEpoch,
        resourceOwner: () => ({ ...owner }),
        bindChannel: () => ({
          async initialized(signal) {
            signal.throwIfAborted();
          },
          async ready(signal) {
            signal.throwIfAborted();
          },
          dispose() {},
        }),
        retireResources: attachment.retireResources,
      },
    );
    // The real participant must preserve the earlier outer deadline in its returned offer.
    vi.mocked(f.persistence.freeze).mockImplementation((original, reason, deadline) => ({
      owner: original,
      reason,
      deadlineMonotonicMs: deadline,
      token: id(5),
      checkpoints: [],
      writes: [],
      acceptedTickets: [],
    }));
    await supervisor.executeCommand("test.consumer.run");
    const stopping = supervisor.stop();
    expect(f.input.reservations.onEnded).toHaveBeenCalledOnce();
    expect(f.resources.retire).toHaveBeenCalledOnce();
    expect(uiRetire).toHaveBeenCalledOnce();
    const args = vi.mocked(f.persistence.freeze).mock.calls[0]!;
    expect(args).toEqual(nullGrant ? [owner, "disable", 8000] : [owner, "disable", 8000, grant]);
    if (!nullGrant) expect(args[3]).toBe(grant);
    const joined = f.coordinator.retire({ ...owner }, "reload", 20000);
    await Promise.resolve();
    f.storage.resolve(saved);
    await Promise.resolve();
    expect(child.killed()).toBe(false);
    expect(f.trace).not.toContain("process-shutdown");
    f.device.resolve(clean);
    await stopping;
    await joined;
    expect(f.persistence.freeze).toHaveBeenCalledOnce();
    expect(f.persistence.drain).toHaveBeenCalledOnce();
    expect(f.trace.filter((value) => value === "process-shutdown")).toHaveLength(1);
    f.coordinator.dispose();
  },
);
it("F17 crashed original peer reconciles without a drain callback or a second fence", async () => {
  const f = fixture();
  f.alive.mockReturnValue(false);
  const retired = f.coordinator.retire(owner, "reload");
  expect(f.resources.retire).toHaveBeenCalledWith(owner, "crashed");
  expect(f.persistence.freeze).not.toHaveBeenCalled();
  f.device.resolve(clean);
  await expect(retired).resolves.toBeUndefined();
  expect(f.coordinator.reports()[0]).toMatchObject({ blocker: true, processStopped: false });
  expect(f.persistence.ownerLost).toHaveBeenCalledOnce();
  expect(f.persistence.drain).not.toHaveBeenCalled();
  expect(f.coordinator.retire({ ...owner }, "crashed")).toBe(retired);
  f.coordinator.dispose();
});
it("F19 coalesces repeated Disconnect without another quiesce, grant or final handler", async () => {
  const f = fixture();
  const first = f.coordinator.disconnect(id(3), action);
  expect(f.coordinator.disconnect(id(3), action)).toBe(first);
  expect(f.sessions.quiesce).toHaveBeenCalledOnce();
  f.storage.resolve(saved);
  f.device.resolve(clean);
  await first;
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  expect(f.legacyFlush).toHaveBeenCalledExactlyOnceWith("close");
  expect(f.sessions.disconnect).toHaveBeenCalledOnce();
});
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "./journal.js";
import { createJournalFilesystem } from "./journal-filesystem.js";
import { AuthorityContexts } from "./authority-context.js";
import { createCoreActionLedger } from "../plugins/core-recovery.js";

import { PluginManager } from "@kobrixa/plugin-runtime";
import { BUILTIN_PLUGIN_SOURCES } from "../plugins/builtin.js";
import type { ProviderCatalogPort } from "./provider.js";
async function providerComposition(safeMode = false, disabled = false, wrongId = false) {
  const root = await mkdtemp(join(tmpdir(), "kobrixa-d150-"));
  const now = () => performance.now();
  const profile = { hostEpoch: id(1), assertHeld: vi.fn() };
  const authority = new AuthorityContexts(profile.hostEpoch);
  const journal = createJournal(createJournalFilesystem(root), profile);
  const coreActions = createCoreActionLedger({ now, current: () => false });
  const catalogs: ProviderCatalogPort[] = [];
  const controls: FakeProviderControl[] = [];
  const foundation = await createDesktopFoundation({
    profile,
    authority,
    journal,
    coreActions,
    now,
    hasPermission: () => false,
    requirements: () => null,
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 10000,
      wifiHandshakeTimeoutMs: 5000,
      usbAutoReconnect: false,
      usbRetryInterval: 2000,
      usbRetryLimit: 3,
    }),
    providerFactory(catalog) {
      catalogs.push(catalog);
      const fake = createFakeDeviceProvider({ catalog, now });
      controls.push(fake.control);
      if (wrongId) Object.defineProperty(fake.provider, "id", { value: "wrong.provider" });
      return fake.provider;
    },
  });
  const register = foundation.broker.registerProvider.bind(foundation.broker);
  const removals: Array<ReturnType<typeof vi.fn<() => void>>> = [];
  const registration = vi
    .spyOn(foundation.broker, "registerProvider")
    .mockImplementation((provider) => {
      const remove = vi.fn(register(provider));
      removals.push(remove);
      return remove;
    });
  const manager = await PluginManager.create({
    sources: BUILTIN_PLUGIN_SOURCES,
    store: {
      load: async () => ({
        disabled: new Set(disabled ? ["builtin:kobrixa.device-ev3"] : []),
        legacyDisabledIds: new Set(),
      }),
      save: async () => {},
    },
    safeMode,
    locale: "en",
    launcher: async () => {
      throw new Error("Provider-only source must not launch");
    },
  });
  return {
    foundation,
    manager,
    catalogs,
    controls,
    registration,
    removals,
    profile,
    async cleanup() {
      await manager.shutdown();
      await foundation.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}
it.each([
  [true, false],
  [false, true],
])("BM-03 safe=%s disabled=%s constructs no optional provider", async (safeMode, disabled) => {
  const f = await providerComposition(safeMode, disabled);
  try {
    expect(f.catalogs).toHaveLength(0);
    f.foundation.attachProvider(f.manager);
    expect(f.catalogs).toHaveLength(0);
    expect(f.registration).not.toHaveBeenCalled();
    expect(
      f.manager
        .state()
        .plugins.filter((row) => row.required)
        .every((row) => row.status === "enabled"),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});
it("BM-03 override obeys one registration per enable and fresh allocators after reload", async () => {
  const f = await providerComposition(false, true);
  try {
    f.foundation.attachProvider(f.manager);
    await f.manager.setEnabled("builtin:kobrixa.device-ev3", true);
    expect(f.registration).toHaveBeenCalledTimes(1);
    expect(() => f.foundation.attachProvider(f.manager)).toThrow("one-shot");
    await f.manager.setEnabled("builtin:kobrixa.device-ev3", false);
    await f.manager.setEnabled("builtin:kobrixa.device-ev3", true);
    expect(f.registration).toHaveBeenCalledTimes(2);
    expect(f.catalogs[1]).not.toBe(f.catalogs[0]);
    await f.manager.reloadSource("builtin:kobrixa.device-ev3");
    expect(f.registration).toHaveBeenCalledTimes(3);
    expect(new Set(f.catalogs).size).toBe(3);
    expect(f.controls.every((control) => control.trace().length === 0)).toBe(true);
  } finally {
    await f.cleanup();
  }
  expect(() => f.foundation.attachProvider(f.manager)).toThrow("disposal");
});
it("BM-03 wrong provider ID is refused before registration", async () => {
  const f = await providerComposition(false, false, true);
  try {
    expect(() => f.foundation.attachProvider(f.manager)).toThrow("wrong provider");
    expect(f.registration).not.toHaveBeenCalled();
  } finally {
    await f.cleanup();
  }
});
it("BM-03 blocked disposition retains registration until a successful retry", async () => {
  const f = await providerComposition();
  try {
    f.foundation.attachProvider(f.manager);
    const detach = vi
      .spyOn(f.foundation.broker.resources, "beginShutdown")
      .mockResolvedValueOnce({ stopConfirmed: true, journalCommitted: false, faultIds: [id(99)] });
    await expect(f.foundation.dispose()).rejects.toThrow("disposition");
    expect(f.registration).toHaveBeenCalledTimes(1);
    expect(f.removals[0]).not.toHaveBeenCalled();
    expect(() => f.profile.assertHeld()).not.toThrow();
    detach.mockRestore();
    await f.foundation.dispose();
    await f.foundation.dispose();
    expect(f.removals[0]).toHaveBeenCalledOnce();
    expect(() => f.foundation.attachProvider(f.manager)).toThrow("disposal");
  } finally {
    await f.cleanup();
  }
});

import { createFakeDeviceProvider, type FakeProviderControl } from "./fake-provider.js";
it("stale suspend rejects asynchronously so other sessions can still be suspended", async () => {
  const f = fixture();
  f.sessions.quiesce.mockImplementationOnce(() => {
    throw new Error("stale");
  });
  let pending!: Promise<void>;
  expect(() => {
    pending = f.coordinator.suspend(id(3));
  }).not.toThrow();
  await expect(pending).rejects.toThrow("stale");
});

it("U12 reconciliation preserves pending promises and the original deadline", async () => {
  const f = fixture();
  const first = f.coordinator.retire(owner, "disable", 8_000);
  expect(f.coordinator.reconcile(owner, clean, saved)).toBe(false);
  expect(f.coordinator.retire({ ...owner }, "shutdown", 50_000)).toBe(first);
  expect(vi.mocked(f.persistence.freeze).mock.calls[0]![2]).toBe(8_000);
  f.storage.resolve({ ...saved, state: "retryable", blocker: true });
  f.device.resolve(clean);
  await first; // Disposition is observed; its report still blocks close.
  expect(f.coordinator.reconcile(owner, clean, saved)).toBe(true);
  expect(await f.coordinator.pendingSession(ended.sessionId)).toEqual([saved]);
  expect(f.coordinator.retire(owner, "shutdown", 99_000)).toBe(first);
  expect(f.coordinator.reports()[0]).toMatchObject({ blocker: true, processStopped: false });
  await f.coordinator.close("close");
  expect(f.coordinator.reports()[0]).toMatchObject({ blocker: false, processStopped: true });
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  expect(f.resources.retire).toHaveBeenCalledOnce();
  expect(f.input.reservations.onEnded).toHaveBeenCalledOnce();
});
it("U12 clear waits for the actual supervisor shutdown receipt", async () => {
  const f = fixture();
  let exit!: () => void;
  f.shutdown.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        exit = resolve;
      }),
  );
  const work = f.coordinator.retire(owner, "disable");
  f.device.resolve(clean);
  f.storage.resolve(saved);
  await work;
  const closing = f.coordinator.close("close");
  for (let i = 0; i < 20 && !exit; i++) await Promise.resolve();
  expect(f.shutdown).toHaveBeenCalledOnce();
  expect(f.coordinator.reports()[0]!.processStopped).toBe(false);
  f.coordinator.allowCloseRetry();
  expect(f.coordinator.close("update")).toBe(closing);
  exit();
  await closing;
  expect(f.coordinator.reports()[0]!.blocker).toBe(false);
});
it("U12 reservation recovery updates settled evidence without redispatch", async () => {
  const f = fixture();
  f.emit();
  const failed = { ...saved, recovery: id(44), state: "retryable" as const, blocker: true };
  f.storage.resolve(failed);
  f.device.resolve(clean);
  await f.coordinator.pendingSession(id(3));
  f.coordinator.reconcileRecovery(id(44), saved);
  expect(await f.coordinator.pendingSession(id(3))).toEqual([saved]);
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  expect(f.resources.retire).not.toHaveBeenCalled();
});
it("U12 crashed original owner uses ownerLost with no replacement dispatch", async () => {
  const f = fixture();
  f.alive.mockReturnValue(false);
  const work = f.coordinator.retire(owner, "disable");
  f.storage.resolve(saved);
  f.device.resolve(clean);
  await work;
  expect(f.persistence.ownerLost).toHaveBeenCalledExactlyOnceWith(owner);
  expect(f.persistence.drain).not.toHaveBeenCalled();
  expect(f.persistence.freeze).not.toHaveBeenCalled();
});

import { PluginSupervisor, type Stage3HostAttachment } from "@kobrixa/plugin-runtime";
import { memoryPlugin } from "../../../../../packages/plugin-runtime/src/test-process.js";
it("F17/F19 U12 uses one host fence and waits for actual original supervisor exit", async () => {
  const f = fixture();
  let exit!: () => void;
  let exitRequested = false,
    didExit = false;
  const child = memoryPlugin((peer, control) => {
    exit = () => control.exit(0);
    peer.handle("initialize", () => ({
      apiVersion: "1.6.0",
      sdk: { name: "fixture", version: "1" },
    }));
    peer.handle("command/execute", () => null);
    peer.handle("shutdown", () => null);
    peer.onNotification("exit", () => {
      exitRequested = true;
    });
  });
  child.process.onExit(() => {
    didExit = true;
  });
  const host: Stage3HostAttachment = {
    hostEpoch: owner.hostEpoch,
    principal: (value) => ({ kind: "plugin", owner: value, authorityContext: null }),
    requirements: () => [],
    hasPermission: () => false,
    bindChannel: () => ({
      initialized: async (signal) => signal.throwIfAborted(),
      ready: async (signal) => signal.throwIfAborted(),
      dispose() {},
    }),
    retireResources: (value, reason) => f.coordinator.retire(value, reason),
  };
  const supervisor = new PluginSupervisor(
    {
      id: owner.pluginId,
      sourceKey: owner.sourceKey,
      directory: "/fixture",
      entry: "/fixture/main.js",
      runtime: "node",
      permissions: [],
      commands: ["test.run"],
    },
    async () => child.process,
    {
      locale: "en",
      onNotice() {},
      resourceOwner: () => owner,
      hostEpoch: host.hostEpoch,
      bindChannel: host.bindChannel,
      retireResources: host.retireResources,
    },
  );
  f.shutdown.mockImplementation(() => supervisor.stop());
  await supervisor.executeCommand("test.run");
  const closing = f.coordinator.close("close");
  f.device.resolve(clean);
  f.storage.resolve(saved);
  for (let turn = 0; turn < 100 && !exitRequested; turn++) await Promise.resolve();
  expect(exitRequested).toBe(true);
  expect(didExit).toBe(false);
  expect(f.coordinator.reports()[0]!.processStopped).toBe(false);
  expect(f.resources.retire).toHaveBeenCalledOnce();
  expect(f.persistence.freeze).toHaveBeenCalledOnce();
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  expect(f.input.reservations.onEnded).toHaveBeenCalledOnce();
  exit();
  await closing;
  expect(didExit).toBe(true);
  expect(f.coordinator.reports()[0]!.blocker).toBe(false);
});

function recoveryFixture() {
  let snapshot: DeviceRecoverySnapshot = {
    revision: 1,
    journalHealth: "ready",
    faults: [],
    blockers: [],
  };
  const listeners = new Set<(value: DeviceRecoverySnapshot) => void>();
  const port: DeviceRecoveryPort = {
    snapshot: () => structuredClone(snapshot),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stopCurrent: vi.fn(),
    reconcile: vi.fn(),
    clearResolved: vi.fn(),
  };
  return {
    port,
    listeners,
    publish(
      faults: SafetyFaultEntry[],
      journalHealth: DeviceRecoverySnapshot["journalHealth"] = "ready",
    ) {
      snapshot = {
        revision: snapshot.revision + 1,
        journalHealth,
        faults,
        blockers: faults.filter((fault) => fault.state !== "resolved").map((fault) => fault.id),
      };
      for (const listener of listeners) listener(port.snapshot());
    },
  };
}
function recoveredFault(n: number, original = owner): SafetyFaultEntry {
  return {
    id: id(n),
    revision: 2,
    owner: { kind: "plugin", owner: { ...original } },
    providerId: "test.provider",
    providerGeneration: 1,
    physical: {
      providerId: "test.provider",
      family: "ev3",
      basis: "serial",
      digest: "a".repeat(64),
      strength: "stable",
    },
    sessionId: id(3),
    operationId: id(n + 100),
    operationClass: "safety-stop",
    createdAt: 1,
    updatedAt: 2,
    state: "resolved",
    dispatch: "unknown",
    movement: "interrupted",
    stopRequested: true,
    stopConfirmation: "confirmed",
    cause: "none",
    resolution: {
      kind: "observed-idle",
      at: 2,
      sessionId: id(30),
      identityEvidence: "serial-match",
    },
  };
}
it("I2 reconciles all original faults, preserving owner, storage and actual process exit", async () => {
  const recovery = recoveryFixture(),
    f = fixture(recovery.port);
  const failedStorage = { ...saved, recovery: id(55), state: "retryable" as const, blocker: true };
  const original = { stopConfirmed: false, journalCommitted: false, faultIds: [id(70), id(71)] };
  const retiring = f.coordinator.retire(owner, "update", 8000);
  f.device.resolve(original);
  f.storage.resolve(failedStorage);
  await retiring;
  recovery.publish([recoveredFault(70)]);
  expect(f.coordinator.reports()[0]!.device).toEqual(original);
  // A later clear cannot erase proof already observed for the first original fault.
  recovery.publish([recoveredFault(71)]);
  expect(f.coordinator.reports()[0]).toMatchObject({
    owner,
    device: { ...original, stopConfirmed: true, journalCommitted: true },
    storage: failedStorage,
    processStopped: false,
    blocker: true,
  });
  f.coordinator.reconcileRecovery(id(55), saved);
  expect(f.coordinator.reports()[0]!.blocker).toBe(true);
  f.alive.mockReturnValue(false);
  f.input.owners = () => [];
  f.coordinator.reconcileProcesses();
  expect(f.coordinator.reports()[0]!.blocker).toBe(false);
  expect(await f.coordinator.pendingSession(id(3))).toEqual([saved]);
  expect(f.coordinator.retire(owner, "update", 99000)).toBe(retiring);
  expect(f.resources.retire).toHaveBeenCalledOnce();
  expect(f.persistence.drain).toHaveBeenCalledOnce();
  expect(vi.mocked(f.persistence.freeze).mock.calls[0]![2]).toBe(8000);
  expect(recovery.port.stopCurrent).not.toHaveBeenCalled();
  expect(recovery.port.reconcile).not.toHaveBeenCalled();
  f.coordinator.dispose();
  expect(recovery.listeners.size).toBe(0);
});
it("I2 captures proven recovery cleared before the retirement receipt settles", async () => {
  const recovery = recoveryFixture(),
    f = fixture(recovery.port);
  const retiring = f.coordinator.retire(owner, "update");
  recovery.publish([recoveredFault(70)]);
  recovery.publish([]);
  f.device.resolve({ stopConfirmed: false, journalCommitted: false, faultIds: [id(70)] });
  f.storage.resolve(saved);
  await retiring;
  expect(f.coordinator.reports()[0]!.device).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [id(70)],
  });
  expect(f.coordinator.reports()[0]!.processStopped).toBe(false);
  f.coordinator.dispose();
});
it.each([
  "missing",
  "wrong-owner",
  "unconfirmed",
  "no-resolution",
  "unwritable",
  "corrupt",
  "full",
  "mixed",
  "no-fault",
])("I2 fails closed for %s recovery evidence", async (kind) => {
  const recovery = recoveryFixture(),
    f = fixture(recovery.port);
  const original = {
    stopConfirmed: false,
    journalCommitted: false,
    faultIds: kind === "no-fault" ? [] : kind === "mixed" ? [id(70), id(71)] : [id(70)],
  };
  const retiring = f.coordinator.retire(owner, "update");
  f.device.resolve(original);
  f.storage.resolve(saved);
  await retiring;
  const fault = recoveredFault(
    70,
    kind === "wrong-owner" ? { ...owner, processEpoch: id(99) } : owner,
  );
  if (kind === "unconfirmed") fault.stopConfirmation = "unconfirmed";
  if (kind === "no-resolution") fault.resolution = null;
  const health = kind === "unwritable" || kind === "corrupt" || kind === "full" ? kind : "ready";
  recovery.publish(kind === "missing" ? [] : [fault], health);
  f.alive.mockReturnValue(false);
  f.input.owners = () => [];
  f.coordinator.reconcileProcesses();
  expect(f.coordinator.reports()[0]).toMatchObject({ device: original, blocker: true });
  f.coordinator.dispose();
});

it("I2 failed journal publication followed by clear is not recovery proof", async () => {
  const recovery = recoveryFixture(),
    f = fixture(recovery.port);
  const retiring = f.coordinator.retire(owner, "update");
  recovery.publish([recoveredFault(70)], "unwritable");
  recovery.publish([]);
  const original = { stopConfirmed: true, journalCommitted: false, faultIds: [id(70)] };
  f.device.resolve(original);
  f.storage.resolve(saved);
  await retiring;
  expect(f.coordinator.reports()[0]!.device).toEqual(original);
  recovery.publish([recoveredFault(70)]);
  expect(f.coordinator.reports()[0]!.device.journalCommitted).toBe(true);
  f.coordinator.dispose();
});
it("I2 a later unresolved original fault invalidates proof before receipt settlement", async () => {
  const recovery = recoveryFixture(),
    f = fixture(recovery.port);
  const retiring = f.coordinator.retire(owner, "update");
  recovery.publish([recoveredFault(70), recoveredFault(71)]);
  recovery.publish([
    { ...recoveredFault(71), revision: 3, state: "unconfirmed", resolution: null },
  ]);
  const original = { stopConfirmed: false, journalCommitted: false, faultIds: [id(70), id(71)] };
  f.device.resolve(original);
  f.storage.resolve(saved);
  await retiring;
  expect(f.coordinator.reports()[0]!.device).toEqual(original);
  recovery.publish([{ ...recoveredFault(71), revision: 4 }]);
  expect(f.coordinator.reports()[0]!.device).toEqual({
    ...original,
    stopConfirmed: true,
    journalCommitted: true,
  });
  f.coordinator.dispose();
});
it("I2 reads authoritative existing proof at retirement admission", async () => {
  const recovery = recoveryFixture();
  recovery.publish([recoveredFault(70)]);
  const f = fixture(recovery.port);
  const retiring = f.coordinator.retire(owner, "update");
  recovery.publish([]);
  f.device.resolve({ stopConfirmed: false, journalCommitted: false, faultIds: [id(70)] });
  f.storage.resolve(saved);
  await retiring;
  expect(f.coordinator.reports()[0]!.device).toEqual({
    stopConfirmed: true,
    journalCommitted: true,
    faultIds: [id(70)],
  });
  f.coordinator.dispose();
});

it("workbench retry observes the original suspended receipt without wake, another quiesce or a new deadline", async () => {
  const f = fixture();
  let observed: DeviceDisposition = {
    stopConfirmed: false,
    journalCommitted: true,
    faultIds: [id(91)],
  };
  f.sessions.quiesce.mockImplementation(() => ({
    sessionId: id(3),
    ended: [],
    get settled() {
      return Promise.resolve(observed);
    },
  }));
  await expect(f.coordinator.suspend(id(3))).rejects.toThrow();
  await expect(f.coordinator.confirmSuspended(id(3))).rejects.toThrow();
  observed = { ...observed, stopConfirmed: true };
  await f.coordinator.confirmSuspended(id(3));
  expect(f.sessions.quiesce).toHaveBeenCalledOnce();
  expect(f.sessions.resume).not.toHaveBeenCalled();
  expect(f.legacyFlush).toHaveBeenCalledOnce();
  await expect(f.coordinator.confirmSuspended(id(99))).rejects.toThrow("original suspension");
  f.coordinator.dispose();
});
