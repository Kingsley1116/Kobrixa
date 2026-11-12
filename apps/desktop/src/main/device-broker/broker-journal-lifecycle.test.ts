import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { unavailableUi150, type SafetyFaultEntry } from "@kobrixa/plugin-runtime";
import { createDeviceBroker } from "./broker-port.js";
import { operationHarness, pluginPrincipal, ID } from "./fake-provider.js";
import { createJournal, journalDocument } from "./journal.js";
import type { JournalFilesystem } from "./journal-filesystem.js";
import { LifecycleCoordinator, createResourceFreePersistence } from "./lifecycle-coordinator.js";
import { createCoreActionLedger } from "../plugins/core-recovery.js";
import { requireCleanClose, ShutdownCoordinator } from "../plugins/shutdown-coordinator.js";

type State = "empty" | "retained" | "unwritable" | "corrupt" | "resolved";
async function fixture(state: State, connected: boolean) {
  const h = operationHarness();
  const oldSession = randomUUID();
  const fault: SafetyFaultEntry = {
    id: randomUUID(),
    revision: 1,
    owner: { kind: "core", adapter: "motor", hostEpoch: ID, workbenchInstance: ID },
    providerId: h.provider.id,
    providerGeneration: 1,
    physical: h.provider.physical,
    sessionId: oldSession,
    operationId: randomUUID(),
    operationClass: "finite-motion",
    createdAt: 1,
    updatedAt: 1,
    state: state === "resolved" ? "resolved" : "pending",
    dispatch: "sent",
    movement: "unknown",
    stopRequested: false,
    stopConfirmation: state === "resolved" ? "confirmed" : "pending",
    cause: "none",
    resolution:
      state === "resolved"
        ? { kind: "observed-idle", at: 1, sessionId: oldSession, identityEvidence: "serial-match" }
        : null,
  };
  const files = new Map<string, Uint8Array>();
  if (state === "retained" || state === "resolved")
    files.set("faults.json", Buffer.from(JSON.stringify(journalDocument(1, [fault]))));
  if (state === "corrupt") files.set("faults.json", Buffer.from("{"));
  const filesystem: JournalFilesystem = {
    initialize: async () => {
      if (state === "unwritable") throw new Error("barrier unavailable");
    },
    inventory: async () => [...files].map(([name, bytes]) => ({ name, bytes: bytes.length })),
    read: async (name) => files.get(name)?.slice() ?? null,
    write: async (name, bytes) => {
      files.set(name, bytes.slice());
    },
    sync: async () => {},
    replace: async (from, to) => {
      const bytes = files.get(from);
      if (!bytes) throw new Error("missing temporary");
      files.set(to, bytes);
      files.delete(from);
    },
    syncDirectory: async () => {},
    remove: async (name) => {
      files.delete(name);
    },
  };
  const journal = createJournal(filesystem, h.dependencies.profile);
  await journal.load();
  const scope = { hostEpoch: ID, workbenchInstance: ID };
  const actions = createCoreActionLedger({ now: h.dependencies.now, current: () => true });
  const broker = createDeviceBroker({
    journal,
    profile: h.dependencies.profile,
    now: h.dependencies.now,
    authority: {
      current: () => ({
        ref: ID,
        epoch: ID,
        workbenchInstance: ID,
        state: "local",
        roomBinding: null,
        connected: false,
        synced: true,
        role: null,
        isHolder: true,
      }),
      assertContinuation() {},
      subscribe: () => () => {},
    },
    coreActions: actions,
    hasPermission: () => true,
    requirements: () => [],
    operationGate: () => ({ ok: true, value: null }),
    connectionPolicy: () => ({
      wifiConnectTimeoutMs: 5000,
      wifiHandshakeTimeoutMs: 3000,
      usbAutoReconnect: false,
      usbRetryInterval: "backoff",
      usbRetryLimit: 3,
    }),
  });
  let sessionId: string | undefined;
  if (connected) {
    broker.registerProvider(h.provider);
    const result = await broker.request(
      pluginPrincipal(),
      "devices/connect",
      {
        target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" },
      },
      new AbortController().signal,
    );
    if (!result.ok) throw new Error("connect failed");
    sessionId = result.value.session.sessionId;
    expect(sessionId).not.toBe(oldSession);
  }
  const persistence = createResourceFreePersistence(() => true);
  const shutdown = vi.fn(async () => {});
  const report = vi.fn();
  const lifecycle = new LifecycleCoordinator({
    ports: { device: broker.resources, persistence, ui: unavailableUi150() },
    resources: broker.resources,
    sessions: broker.sessions,
    reservations: broker.reservations,
    recovery: broker.recovery,
    persistence,
    dispatch: async () => ({ ok: true, value: { status: "submitted", writes: [] } }),
    alive: () => true,
    owners: () => [],
    now: h.dependencies.now,
    shutdown,
    legacyFlush: async () => {},
    report,
  });
  return {
    ...h,
    journal,
    broker,
    sessionId,
    fault,
    actions,
    scope,
    lifecycle,
    shutdown,
    report,
    coordinator: new ShutdownCoordinator(lifecycle),
  };
}

for (const connected of [true, false]) {
  for (const reason of ["shutdown", "update"] as const) {
    it.each<State>(["empty", "retained", "unwritable", "corrupt", "resolved"])(
      `F19 ${reason} with connected=${connected}: %s journal controls clean close`,
      async (state) => {
        const f = await fixture(state, connected);
        try {
          const health = state === "unwritable" || state === "corrupt" ? state : "ready";
          const blockers = state === "retained" ? [f.fault.id] : [];
          expect(f.journal.snapshot()).toMatchObject({ journalHealth: health, blockers });
          const disposition = {
            stopConfirmed: state !== "retained",
            journalCommitted: health === "ready",
            faultIds: blockers,
          };
          await expect(f.broker.resources.beginShutdown()).resolves.toEqual(disposition);
          if (state === "empty" || state === "resolved") {
            await expect(requireCleanClose(f.coordinator, reason)).resolves.toBeUndefined();
            expect(f.shutdown).toHaveBeenCalledOnce();
          } else {
            await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
            expect(f.shutdown).not.toHaveBeenCalled();
            expect(f.report).toHaveBeenCalledWith(
              expect.objectContaining({
                device: disposition,
                ...(state === "corrupt"
                  ? { reason: "journal-corrupt" }
                  : state === "unwritable"
                    ? { reason: "journal-unwritable" }
                    : {}),
              }),
            );
          }
          expect(f.provider.calls).not.toContain("stop");
          expect(f.provider.calls).not.toContain("motion");
          expect(f.provider.calls).not.toContain("run");
        } finally {
          f.lifecycle.dispose();
        }
      },
    );
  }
}

it.each(["shutdown", "update"] as const)(
  "F19 retained fault blocks %s until explicit reconciliation durably resolves it",
  async (reason) => {
    const f = await fixture("retained", true);
    try {
      await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
      expect(f.shutdown).not.toHaveBeenCalled();
      const target = {
        kind: "device-reconcile" as const,
        faultId: f.fault.id,
        sessionId: f.sessionId!,
        identityEvidence: "serial-match" as const,
      };
      const action = f.actions.mint(f.scope, target);
      expect(await f.broker.recovery.reconcile({ ...target, action })).toMatchObject({ ok: true });
      expect(f.journal.snapshot()).toMatchObject({
        journalHealth: "ready",
        blockers: [],
        faults: [{ id: f.fault.id, state: "resolved", movement: "unknown" }],
      });
      await expect(requireCleanClose(f.coordinator, reason)).resolves.toBeUndefined();
      expect(f.shutdown).toHaveBeenCalledOnce();
      expect(f.provider.calls).not.toContain("stop");
      expect(f.provider.calls).not.toContain("motion");
    } finally {
      f.lifecycle.dispose();
    }
  },
);
