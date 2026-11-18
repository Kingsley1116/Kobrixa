import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJournalFilesystem } from "./journal-filesystem.js";
import { createWin32JournalAdapter, invokeWin32JournalAddon } from "./journal-win32.js";
import {
  combineDispositions,
  journalDisposition,
  permitsUnavailableClose,
} from "./journal-disposition.js";
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
async function fixture(
  state: State,
  connected: boolean,
  options: {
    filesystem?: JournalFilesystem;
    configure?: (filesystem: JournalFilesystem) => void;
    beforeLoad?: (journal: ReturnType<typeof createJournal>) => void;
  } = {},
) {
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
  const filesystem: JournalFilesystem = options.filesystem ?? {
    assertIdle() {},
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
  options.configure?.(filesystem);
  const journal = createJournal(filesystem, h.dependencies.profile);
  options.beforeLoad?.(journal);
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
    filesystem,
    files,
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
            ...(state === "unwritable" ? { reason: "journal-unavailable-no-evidence" } : {}),
          };
          await expect(f.broker.resources.beginShutdown()).resolves.toEqual(disposition);
          if (state === "empty" || state === "resolved" || state === "unwritable") {
            await expect(requireCleanClose(f.coordinator, reason)).resolves.toBeUndefined();
            expect(f.shutdown).toHaveBeenCalledOnce();
            expect(f.lifecycle.closeDisposition()).toEqual(disposition);
          } else {
            await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
            expect(f.shutdown).not.toHaveBeenCalled();
            expect(f.report).toHaveBeenCalledWith(
              expect.objectContaining({
                device: disposition,
                ...(state === "corrupt" ? { reason: "journal-corrupt" } : {}),
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

async function expectRiskRefused(f: Awaited<ReturnType<typeof fixture>>, beforeClose = true) {
  const principal = pluginPrincipal();
  const sessionId = f.sessionId ?? ID;
  const motion = await f.broker.request(
    principal,
    "devices/motion/prepare",
    {
      sessionId,
      contextRef: ID,
      motionScopeRef: ID,
      motion: f.admission.motion,
    },
    new AbortController().signal,
  );
  expect(motion.ok).toBe(false);
  if (f.sessionId && beforeClose)
    expect(motion).toMatchObject({ error: { detail: { reason: "journal-unwritable" } } });
  await expect(
    f.broker.begin({
      principal,
      sessionId,
      operationClass: "program-launch",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow();
  expect(f.provider.calls).not.toContain("motion");
  expect(f.provider.calls).not.toContain("run");
}

for (const connected of [false, true]) {
  for (const reason of ["shutdown", "update"] as const) {
    it.each(["missing", "wrong-abi", "unsupported-volume", "unsupported-barrier"])(
      `F23 %s with absent inventory, connected=${connected}: ${reason} allowed, risk refused`,
      async (failure) => {
        const temp = await mkdtemp(path.join(tmpdir(), "F23-absent-"));
        const root = await realpath(temp);
        const adapter = createWin32JournalAdapter({
          location: async () => ({ packaged: true, resourcesPath: root, appPath: root }),
          execute: (_filename, operation, args) =>
            invokeWin32JournalAddon(
              () => {
                if (failure === "missing")
                  throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" });
                return {
                  apiVersion: failure === "wrong-abi" ? "0" : "1",
                  napiVersion: "8",
                  arch: "x64",
                  capabilities: () => ({ supported: false }),
                  initializeDirectory() {
                    throw Object.assign(new Error("unsupported volume"), { code: "ENOTSUP" });
                  },
                };
              },
              operation,
              args,
              "x64",
              8,
            ),
        });
        const filesystem =
          failure === "unsupported-barrier"
            ? createJournalFilesystem(root, async () => {
                throw Object.assign(new Error("unsupported barrier"), { code: "ENOTSUP" });
              })
            : createJournalFilesystem(root, undefined, adapter);
        const f = await fixture("unwritable", connected, { filesystem });
        try {
          expect(f.journal.history?.()).toEqual({
            initialized: false,
            inventory: "validated-empty",
            writeAttempted: false,
            publicationUncertain: false,
            riskWorkAdmitted: false,
            io: "idle",
            resourceLimited: false,
          });
          await expectRiskRefused(f);
          expect(f.journal.history?.().riskWorkAdmitted).toBe(false);
          await expect(requireCleanClose(f.coordinator, reason)).resolves.toBeUndefined();
          expect(f.lifecycle.closeDisposition()).toEqual({
            stopConfirmed: true,
            journalCommitted: false,
            faultIds: [],
            reason: "journal-unavailable-no-evidence",
          });
          expect(f.shutdown).toHaveBeenCalledOnce();
          await expectRiskRefused(f, false);
        } finally {
          f.lifecycle.dispose();
          adapter.dispose();
          await rm(temp, { recursive: true, force: true });
        }
      },
    );
  }
}

const exclusions = [
  "unreadable",
  "old-fault",
  "old-resolved",
  "corrupt",
  "orphan",
  "empty-document",
  "read-failure",
  "write-failure",
  "uncertain-publication",
  "prior-write-attempt",
  "prior-risk-admission",
  "unknown-idle",
  "in-flight-io",
  "expired-io",
  "resource-limit",
] as const;
for (const reason of ["shutdown", "update"] as const) {
  it.each(exclusions)(
    `F23 ${reason} remains blocked for %s independently of displayed fault count`,
    async (excluded) => {
      const state =
        excluded === "old-fault"
          ? "retained"
          : excluded === "old-resolved"
            ? "resolved"
            : excluded === "corrupt"
              ? "corrupt"
              : "unwritable";
      const f = await fixture(state, true, {
        configure(fs) {
          if (excluded !== "write-failure" && excluded !== "uncertain-publication") {
            fs.initialize = async () => {
              throw new Error("barrier unavailable");
            };
          } else fs.initialize = async () => {};
          if (excluded === "unreadable")
            fs.inventory = async () => {
              throw new Error("EACCES");
            };
          if (["orphan", "empty-document", "read-failure"].includes(excluded)) {
            fs.inventory = async () => [
              {
                name: excluded === "orphan" ? `faults.next-${ID}.json` : "faults.json",
                bytes: 100,
              },
            ];
            fs.read = async () => {
              if (excluded === "read-failure") throw new Error("read denied");
              return Buffer.from(JSON.stringify(journalDocument(1, [])));
            };
          }
          if (excluded === "unknown-idle") delete fs.assertIdle;
          if (excluded === "in-flight-io" || excluded === "expired-io")
            fs.assertIdle = () => {
              throw new Error("I/O fenced");
            };
          if (excluded === "expired-io")
            fs.initialize = async () => {
              throw Object.assign(new Error("deadline"), { code: "ETIMEDOUT" });
            };
          if (excluded === "resource-limit")
            fs.initialize = async () => {
              throw Object.assign(new Error("capacity"), { code: "ENOSPC" });
            };
        },
        beforeLoad(journal) {
          if (excluded === "prior-risk-admission") journal.noteRiskAdmission?.();
        },
      });
      try {
        if (excluded === "prior-write-attempt")
          await expect(f.journal.commit(journalDocument(1, []))).rejects.toThrow(
            "journal write blocked",
          );
        if (excluded === "write-failure" || excluded === "uncertain-publication") {
          if (excluded === "write-failure")
            f.filesystem.write = async () => {
              throw new Error("disk failed");
            };
          else
            f.filesystem.durableReplace = async () => {
              throw Object.assign(new Error("flush failed"), { publicationState: "uncertain" });
            };
          await expect(f.journal.commit(journalDocument(1, []))).rejects.toThrow();
          expect(f.journal.history?.()).toMatchObject({
            initialized: true,
            writeAttempted: true,
            publicationUncertain: excluded === "uncertain-publication",
          });
        }
        const disposition = await f.broker.resources.beginShutdown();
        expect(disposition.journalCommitted).toBe(false);
        expect(permitsUnavailableClose(disposition)).toBe(false);
        await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
        expect(f.shutdown).not.toHaveBeenCalled();
        expect(f.lifecycle.closeDisposition()).toBeUndefined();
      } finally {
        f.lifecycle.dispose();
      }
    },
  );
}

it.each(["shutdown", "update"] as const)(
  "F23 native initialization expiry blocks %s even after late settlement and empty read",
  async (reason) => {
    const temp = await mkdtemp(path.join(tmpdir(), "F23-late-"));
    const root = await realpath(temp);
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const adapter = createWin32JournalAdapter({
      location: async () => ({ packaged: true, resourcesPath: root, appPath: root }),
      execute: async () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          entered();
        }),
    });
    vi.useFakeTimers();
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const work = fixture("unwritable", true, {
        filesystem: createJournalFilesystem(root, undefined, adapter),
      });
      await started;
      await vi.advanceTimersByTimeAsync(5000);
      f = await work;
      expect(f.journal.history?.()).toMatchObject({
        initialized: false,
        inventory: "validated-empty",
        io: "expired",
      });
      await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
      finish();
      await vi.advanceTimersByTimeAsync(0);
      await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
      expect(f.shutdown).not.toHaveBeenCalled();
    } finally {
      f?.lifecycle.dispose();
      adapter.dispose();
      vi.useRealTimers();
      await rm(temp, { recursive: true, force: true });
    }
  },
);

it("F23 admitted Run history survives cancellation before dispatch and a later journal failure", async () => {
  const f = await fixture("empty", true);
  try {
    const operation = await f.broker.begin({
      principal: pluginPrincipal(),
      sessionId: f.sessionId!,
      operationClass: "program-launch",
      signal: new AbortController().signal,
    });
    expect(f.journal.history?.()).toMatchObject({ riskWorkAdmitted: true, writeAttempted: false });
    await operation.finish();
    f.filesystem.write = async () => {
      throw new Error("disk failed");
    };
    await expect(f.journal.commit(journalDocument(1, []))).rejects.toThrow();
    await expect(requireCleanClose(f.coordinator, "shutdown")).rejects.toThrow("not confirmed");
    await expect(requireCleanClose(f.coordinator, "update")).rejects.toThrow("not confirmed");
    expect(f.provider.calls).not.toContain("run");
  } finally {
    f.lifecycle.dispose();
  }
});

it("F23 a no-evidence receipt cannot mask an unrelated cleanup failure", () => {
  const permitted = {
    stopConfirmed: true,
    journalCommitted: false,
    faultIds: [],
    reason: "journal-unavailable-no-evidence" as const,
  };
  expect(
    permitsUnavailableClose(
      combineDispositions([
        permitted,
        { stopConfirmed: true, journalCommitted: false, faultIds: [] },
      ]),
    ),
  ).toBe(false);
  expect(
    permitsUnavailableClose(
      combineDispositions([
        permitted,
        { stopConfirmed: false, journalCommitted: true, faultIds: [] },
      ]),
    ),
  ).toBe(false);
});

it("F23 prior receipts lose close authorization if a write is attempted while storage drains", async () => {
  const f = await fixture("unwritable", true);
  try {
    const receipt = await f.broker.resources.beginShutdown();
    expect(permitsUnavailableClose(receipt)).toBe(true);
    expect(permitsUnavailableClose(structuredClone(receipt))).toBe(false);
    await expect(f.journal.commit(journalDocument(1, []))).rejects.toThrow("journal write blocked");
    expect(permitsUnavailableClose(receipt)).toBe(false);
    await expect(requireCleanClose(f.coordinator, "shutdown")).rejects.toThrow("not confirmed");
    expect(f.shutdown).not.toHaveBeenCalled();
  } finally {
    f.lifecycle.dispose();
  }
});

it("F23 pending initialization cannot publish ready health or a clean close receipt", async () => {
  let release!: () => void;
  const initialize = new Promise<void>((resolve) => {
    release = resolve;
  });
  let captured!: ReturnType<typeof createJournal>;
  const work = fixture("unwritable", false, {
    configure(fs) {
      fs.initialize = async () => initialize;
    },
    beforeLoad(journal) {
      captured = journal;
    },
  });
  expect(captured.snapshot().journalHealth).toBe("unwritable");
  expect(captured.history?.()).toMatchObject({
    initialized: false,
    inventory: "unknown",
    io: "pending",
  });
  expect(journalDisposition(captured)).toEqual({
    stopConfirmed: true,
    journalCommitted: false,
    faultIds: [],
  });
  release();
  const f = await work;
  try {
    expect(f.journal.history?.()).toMatchObject({
      initialized: true,
      inventory: "validated-empty",
      io: "idle",
    });
    await expect(requireCleanClose(f.coordinator, "shutdown")).resolves.toBeUndefined();
  } finally {
    f.lifecycle.dispose();
  }
});

it.each(["shutdown", "update"] as const)(
  "F23 an expired publication blocks %s before and after its late completion",
  async (reason) => {
    const f = await fixture("empty", true);
    let release!: () => void;
    const publication = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.filesystem.durableReplace = async () => {
      await publication;
      return { directoryFlushed: true };
    };
    vi.useFakeTimers();
    try {
      const commit = f.journal.commit(journalDocument(1, []));
      const rejected = expect(commit).rejects.toThrow("journal deadline");
      await vi.advanceTimersByTimeAsync(5000);
      await rejected;
      expect(f.journal.history?.()).toMatchObject({ writeAttempted: true, io: "expired" });
      await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.journal.snapshot()).toMatchObject({ revision: 0, journalHealth: "unwritable" });
      expect(f.journal.history?.().io).toBe("expired");
      await expect(requireCleanClose(f.coordinator, reason)).rejects.toThrow("not confirmed");
      expect(f.shutdown).not.toHaveBeenCalled();
    } finally {
      release();
      f.lifecycle.dispose();
      vi.useRealTimers();
    }
  },
);
