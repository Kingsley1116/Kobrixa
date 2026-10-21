import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type {
  CoreActionReference,
  CoreActionTarget,
  SafetyFaultEntry,
} from "@kobrixa/plugin-runtime";
import { createDeviceRecovery, type RecoveryDriver } from "./recovery-port.js";
import { journalDocument } from "./journal.js";
import type { JournalPort } from "./journal-port.js";

function fixture() {
  const sessionId = randomUUID();
  const action: CoreActionReference = {
    actionToken: randomUUID(),
    scope: { hostEpoch: randomUUID(), workbenchInstance: randomUUID() },
  };
  const item: SafetyFaultEntry = {
    id: randomUUID(),
    revision: 1,
    owner: { kind: "core", adapter: "motor", ...action.scope },
    providerId: "kobrixa.device-ev3",
    providerGeneration: 1,
    physical: {
      providerId: "kobrixa.device-ev3",
      family: "ev3",
      basis: "serial",
      digest: "a".repeat(64),
      strength: "stable",
    },
    sessionId: randomUUID(),
    operationId: randomUUID(),
    operationClass: "finite-motion",
    createdAt: 1,
    updatedAt: 1,
    state: "unconfirmed",
    dispatch: "unknown",
    movement: "unknown",
    stopRequested: true,
    stopConfirmation: "unconfirmed",
    cause: "host-restarted",
    resolution: null,
  };
  let document = journalDocument(1, [item]);
  let allowed = true,
    claimed = false;
  const actions = {
    claim: vi.fn((candidate: CoreActionReference, _target: CoreActionTarget) => {
      if (!allowed || claimed || candidate !== action) return false;
      claimed = true;
      return true;
    }),
    isClaimed: vi.fn(() => claimed && allowed),
    complete: vi.fn(() => {
      claimed = false;
      allowed = false;
    }),
  };
  const journal: JournalPort = {
    load: async () => structuredClone(document),
    commit: vi.fn(async (next) => {
      document = next;
    }),
    snapshot: () => ({
      revision: document.revision,
      journalHealth: "ready",
      faults: structuredClone(document.entries),
      blockers: document.entries.filter((e) => e.state !== "resolved").map((e) => e.id),
    }),
    subscribe: () => () => {},
  };
  const observe = vi.fn(async () => ({
    value: {
      programStopped: true,
      observedAt: 2,
      outputs: Array.from({ length: 4 }, () => ({
        actuatorId: randomUUID(),
        known: true,
        busy: false,
        speed: 0,
      })),
    },
    dispatch: "sent" as const,
    stopConfirmation: "confirmed" as const,
    error: null,
  }));
  const stop = vi.fn(observe.getMockImplementation()!);
  const current = { sessionId, physical: item.physical, providerGeneration: 2 };
  const driver: RecoveryDriver = {
    wallNow: () => 1700000000000,
    describe: vi.fn(() => current),
    async occupy(id, work) {
      expect(id).toBe(sessionId);
      return work({ observe, stop });
    },
  };
  const recovery = createDeviceRecovery({ journal, actions, driver });
  return {
    item,
    action,
    sessionId,
    journal,
    actions,
    observe,
    stop,
    driver,
    current,
    recovery,
    deny: () => {
      allowed = false;
    },
  };
}
it.each([1700000000000, 1700000000500])(
  "F11 resolution uses injected epoch time with a nondecreasing floor %s",
  async (updatedAt) => {
    const f = fixture();
    const document = await f.journal.load();
    document.entries[0]!.updatedAt = updatedAt;
    await f.journal.commit(document);
    let monotonic = 0;
    f.driver.wallNow = () => 1700000000000;
    f.driver.occupy = async (_id, work) => {
      monotonic += 9000;
      return work({ observe: f.observe, stop: f.stop });
    };
    const result = await f.recovery.reconcile({
      faultId: f.item.id,
      sessionId: f.sessionId,
      action: f.action,
      identityEvidence: "serial-match",
    });
    expect(result.ok).toBe(true);
    expect(monotonic).toBe(9000);
    expect(f.journal.snapshot().faults[0]).toMatchObject({
      updatedAt,
      resolution: { at: updatedAt },
    });
  },
);
it("F11 serial reconciliation resolves present idleness without rewriting unknown movement", async () => {
  const f = fixture();
  const result = await f.recovery.reconcile({
    faultId: f.item.id,
    sessionId: f.sessionId,
    action: f.action,
    identityEvidence: "serial-match",
  });
  expect(result.ok).toBe(true);
  expect(f.journal.snapshot().faults[0]).toMatchObject({
    state: "resolved",
    movement: "unknown",
    dispatch: "unknown",
    resolution: { kind: "observed-idle", sessionId: f.sessionId },
  });
  expect(f.actions.complete).toHaveBeenCalledOnce();
  expect(f.observe).toHaveBeenCalledOnce();
  expect(f.stop).not.toHaveBeenCalled();
  expect(
    (
      await f.recovery.reconcile({
        faultId: f.item.id,
        sessionId: f.sessionId,
        action: f.action,
        identityEvidence: "serial-match",
      })
    ).ok,
  ).toBe(false);
});
it.each([
  "expired",
  "consumed",
  "wrong-window",
  "wrong-host",
  "wrong-target",
  "feature-action",
  "invocation-id",
])("F11 rejects %s through the sole core ledger", async () => {
  const f = fixture();
  f.deny();
  const result = await f.recovery.stopCurrent({
    faultId: f.item.id,
    sessionId: f.sessionId,
    action: f.action,
  });
  expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_E_PERMISSION_DENIED" } });
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.journal.commit).not.toHaveBeenCalled();
});
it.each(["different-serial", "same-endpoint", "unknown"])(
  "F11 %s is not serial evidence",
  async (kind) => {
    const f = fixture();
    f.current.physical =
      kind === "different-serial"
        ? { ...f.item.physical, digest: "b".repeat(64) }
        : {
            ...f.item.physical,
            basis: kind === "unknown" ? "unknown" : "endpoint",
            strength: "session-only",
            digest: kind === "unknown" ? null : f.item.physical.digest,
          };
    expect(
      (
        await f.recovery.reconcile({
          faultId: f.item.id,
          sessionId: f.sessionId,
          action: f.action,
          identityEvidence: "serial-match",
        })
      ).ok,
    ).toBe(false);
    expect(f.observe).not.toHaveBeenCalled();
  },
);
it.each(["program", "unknown", "busy", "speed", "missing-output"])(
  "F08 refuses incomplete idle evidence: %s",
  async (reason) => {
    const f = fixture(),
      value = (await f.observe()).value;
    if (reason === "program") value.programStopped = false;
    if (reason === "unknown") value.outputs[0]!.known = false;
    if (reason === "busy") value.outputs[0]!.busy = true;
    if (reason === "speed") value.outputs[0]!.speed = 1;
    if (reason === "missing-output") value.outputs.pop();
    f.observe.mockResolvedValue({
      value,
      dispatch: "sent",
      stopConfirmation: "confirmed",
      error: null,
    });
    expect(
      (
        await f.recovery.reconcile({
          faultId: f.item.id,
          sessionId: f.sessionId,
          action: f.action,
          identityEvidence: "serial-match",
        })
      ).ok,
    ).toBe(false);
    expect(f.journal.snapshot().blockers).toEqual([f.item.id]);
  },
);
it("F11 disabled provider leaves readable core evidence and never auto-enables", async () => {
  const f = fixture();
  vi.mocked(f.driver.describe).mockReturnValue(null);
  expect(f.recovery.snapshot().blockers).toEqual([f.item.id]);
  expect(
    (await f.recovery.stopCurrent({ faultId: f.item.id, sessionId: f.sessionId, action: f.action }))
      .ok,
  ).toBe(false);
  expect(f.observe).not.toHaveBeenCalled();
});
it("F10/A-RF2 confirmed readback with failed final publication retains the fault", async () => {
  const f = fixture();
  vi.mocked(f.journal.commit).mockRejectedValue(new Error("sync"));
  expect(
    (await f.recovery.stopCurrent({ faultId: f.item.id, sessionId: f.sessionId, action: f.action }))
      .ok,
  ).toBe(false);
  expect(f.journal.snapshot().blockers).toEqual([f.item.id]);
});
it("F05 invalidation while waiting for readback cannot clear the ledger", async () => {
  const f = fixture(),
    read = f.observe.getMockImplementation()!;
  f.observe.mockImplementation(async () => {
    const value = await read();
    f.deny();
    return value;
  });
  expect(
    (
      await f.recovery.reconcile({
        faultId: f.item.id,
        sessionId: f.sessionId,
        action: f.action,
        identityEvidence: "serial-match",
      })
    ).ok,
  ).toBe(false);
  expect(f.journal.commit).not.toHaveBeenCalled();
});
it("F11 clearResolved rejects an unresolved entry and duplicate IDs", async () => {
  for (const duplicate of [false, true]) {
    const f = fixture();
    expect(
      (
        await f.recovery.clearResolved({
          entryIds: duplicate ? [f.item.id, f.item.id] : [f.item.id],
          action: f.action,
        })
      ).ok,
    ).toBe(false);
    expect(f.journal.commit).not.toHaveBeenCalled();
  }
});

it("AM-04 actual stop readback retains occupancy until a failed final commit settles", async () => {
  const f = fixture();
  let occupied = false,
    release!: () => void,
    entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const commit = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.driver.occupy = async (sessionId, work) => {
    expect(sessionId).toBe(f.sessionId);
    if (occupied) throw new Error("foreground");
    occupied = true;
    try {
      return await work({ observe: f.observe, stop: f.stop });
    } finally {
      occupied = false;
    }
  };
  vi.mocked(f.journal.commit).mockImplementation(async () => {
    entered();
    await commit;
    throw new Error("sync");
  });
  const pending = f.recovery.stopCurrent({
    faultId: f.item.id,
    sessionId: f.sessionId,
    action: f.action,
  });
  expect(occupied).toBe(true);
  await waiting;
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.observe).not.toHaveBeenCalled();
  expect(occupied).toBe(true);
  await expect(f.driver.occupy(f.sessionId, async () => null)).rejects.toThrow("foreground");
  release();
  expect((await pending).ok).toBe(false);
  expect(occupied).toBe(false);
  expect(f.recovery.snapshot().blockers).toContain(f.item.id);
});
