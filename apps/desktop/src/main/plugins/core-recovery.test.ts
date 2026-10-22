import { describe, expect, it, vi } from "vitest";
import { createCoreActionLedger } from "./core-recovery.js";
const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
const scope = { hostEpoch: id(1), workbenchInstance: id(2) };
const target = { kind: "device-disconnect" as const, sessionId: id(3) };
it("claims only the original target/scope once within five seconds", () => {
  let now = 0;
  const ledger = createCoreActionLedger({ now: () => now, current: () => true });
  const action = ledger.mint(scope, target);
  expect(ledger.claim({ ...action, scope: { ...scope, workbenchInstance: id(4) } }, target)).toBe(
    false,
  );
  expect(ledger.claim(action, { ...target, sessionId: id(5) })).toBe(false);
  expect(ledger.claim(action, { kind: "device-current-stop", sessionId: id(3) })).toBe(false);
  now = 4_999;
  expect(ledger.claim(action, target)).toBe(true);
  expect(ledger.claim(action, target)).toBe(false);
  now = 5_001;
  expect(ledger.isClaimed(action, target)).toBe(true);
  ledger.complete(action);
  expect(ledger.isClaimed(action, target)).toBe(false);
  const expired = ledger.mint(scope, target);
  now += 5_000;
  expect(ledger.claim(expired, target)).toBe(false);
});
it("retires claimed actions with the window and uses fresh actions for retry", () => {
  let current = true;
  const ledger = createCoreActionLedger({ now: () => 0, current: () => current });
  const failed = ledger.mint(scope, target);
  expect(ledger.claim(failed, target)).toBe(true);
  ledger.complete(failed);
  const retry = ledger.mint(scope, target);
  expect(retry.actionToken).not.toBe(failed.actionToken);
  expect(ledger.claim(failed, target)).toBe(false);
  expect(ledger.claim(retry, target)).toBe(true);
  ledger.retire(scope);
  expect(ledger.isClaimed(retry, target)).toBe(false);
  current = false;
  expect(() => ledger.mint(scope, target)).toThrow("Retired");
});

import type { CoreActionTarget, CoreRecoveryItem } from "@kobrixa/plugin-runtime";
import { CoreRecovery, type RecoveryEntry } from "./core-recovery.js";
import { createRecoveryEntries } from "./core-recovery.js";
import type { DeviceRecoveryPort, SafetyFaultEntry } from "@kobrixa/plugin-runtime";
import type { DeviceSessionSnapshot } from "@kobrixa/plugin-protocol";

describe("actual core recovery source projection", () => {
  function setup() {
    let currentScope = scope;
    const fault: SafetyFaultEntry = {
      id: id(10),
      revision: 1,
      owner: { kind: "core", adapter: "motor", ...scope },
      providerId: "kobrixa.ev3",
      providerGeneration: 1,
      physical: {
        providerId: "kobrixa.ev3",
        family: "ev3",
        basis: "serial",
        strength: "stable",
        digest: "a".repeat(64),
      },
      sessionId: id(11),
      operationId: id(12),
      operationClass: "finite-motion",
      createdAt: 0,
      updatedAt: 0,
      state: "unconfirmed",
      dispatch: "unknown",
      movement: "unknown",
      stopRequested: true,
      stopConfirmation: "unconfirmed",
      cause: "host-restarted",
      resolution: null,
    };
    const session: DeviceSessionSnapshot = {
      sessionId: id(11),
      providerId: "kobrixa.ev3",
      providerGeneration: 1,
      revision: 1,
      name: "device",
      transport: "mock",
      capabilities: [],
      state: "quarantined",
      foreground: "none",
      recording: false,
      sourceRevision: 0,
    };
    const snapshot = {
      revision: 1,
      journalHealth: "ready" as const,
      faults: [fault],
      blockers: [fault.id],
    };
    const actions = createCoreActionLedger({
      now: () => 0,
      current: (value) => value.workbenchInstance === currentScope.workbenchInstance,
    });
    const device: DeviceRecoveryPort = {
      snapshot: () => snapshot,
      subscribe: () => () => {},
      stopCurrent: vi.fn<DeviceRecoveryPort["stopCurrent"]>(async (value) => {
        expect(
          actions.claim(value.action, {
            kind: "device-stop",
            faultId: value.faultId,
            sessionId: value.sessionId,
          }),
        ).toBe(true);
        return { ok: true, value: snapshot };
      }),
      reconcile: vi.fn<DeviceRecoveryPort["reconcile"]>(async (value) => {
        expect(
          actions.claim(value.action, {
            kind: "device-reconcile",
            faultId: value.faultId,
            sessionId: value.sessionId,
            identityEvidence: value.identityEvidence,
          }),
        ).toBe(true);
        return { ok: true, value: snapshot };
      }),
      clearResolved: vi.fn<DeviceRecoveryPort["clearResolved"]>(async () => ({
        ok: true,
        value: snapshot,
      })),
    };
    const confirm = vi.fn(async () => true);
    const entries = createRecoveryEntries({
      device,
      sessions: async () => [session],
      processes: () => [],
      confirmDevice: confirm,
    });
    const recovery = new CoreRecovery({
      entries,
      scope: () => currentScope,
      actions,
      now: () => 0,
      openDetail: vi.fn(),
    });
    return {
      fault,
      session,
      device,
      confirm,
      entries,
      recovery,
      actions,
      replace: () => {
        currentScope = { ...scope, workbenchInstance: id(99) };
      },
    };
  }
  it("projects bounded public fields with stable action IDs and binds the original stop target", async () => {
    const h = setup();
    const first = await h.entries();
    const second = await h.entries();
    expect(first.map((value) => value.item)).toEqual(second.map((value) => value.item));
    expect(JSON.stringify(first[0]!.item)).not.toContain(h.fault.physical.digest);
    expect(first[0]!.item).not.toHaveProperty("physical");
    const action = first[0]!.item.actions.find((value) => value.kind === "stop")!;
    expect((await h.recovery.act({ itemId: h.fault.id, actionId: action.id })).ok).toBe(true);
    expect(h.device.stopCurrent).toHaveBeenCalledOnce();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.actions.count()).toBe(0);
  });
  it("cannot treat a reused session handle with a newer provider generation as an original stop", async () => {
    const h = setup();
    const old = (await h.entries())[0]!.item.actions.find((value) => value.kind === "stop")!;
    h.session.providerGeneration++;
    expect((await h.entries())[0]!.item.actions.map((value) => value.kind)).toEqual(["reconcile"]);
    expect((await h.recovery.act({ itemId: h.fault.id, actionId: old.id })).ok).toBe(false);
    expect(h.device.stopCurrent).not.toHaveBeenCalled();
  });
  it("requires fresh main confirmation for reconciliation and rejects window replacement during the dialog", async () => {
    const h = setup();
    const action = (await h.entries())[0]!.item.actions.find(
      (value) => value.kind === "reconcile",
    )!;
    h.confirm.mockImplementation(async () => {
      h.replace();
      return true;
    });
    expect((await h.recovery.act({ itemId: h.fault.id, actionId: action.id })).ok).toBe(false);
    expect(h.device.reconcile).not.toHaveBeenCalled();
    expect(h.actions.count()).toBe(0);
  });
  it("revokes old action IDs when the original journal revision changes during confirmation", async () => {
    const h = setup();
    const action = (await h.entries())[0]!.item.actions.find(
      (value) => value.kind === "reconcile",
    )!;
    h.confirm.mockImplementation(async () => {
      h.fault.revision++;
      return true;
    });
    expect((await h.recovery.act({ itemId: h.fault.id, actionId: action.id })).ok).toBe(false);
    expect(h.device.reconcile).not.toHaveBeenCalled();
  });
  it("does not report a denied broker operation as recovered", async () => {
    const h = setup();
    const action = (await h.entries())[0]!.item.actions.find((value) => value.kind === "stop")!;
    vi.mocked(h.device.stopCurrent).mockResolvedValue({
      ok: false,
      error: {
        code: "PLUGIN_E_STALE_RESOURCE",
        message: "gone",
        detail: { kind: "resource", reason: "stale", resource: "journal" },
      },
    });
    expect((await h.recovery.act({ itemId: h.fault.id, actionId: action.id })).ok).toBe(false);
    expect(h.actions.count()).toBe(0);
  });
});
describe("D160 recovery projection", () => {
  const scope = { hostEpoch: "host", workbenchInstance: "window" };
  const target: CoreActionTarget = { kind: "device-disconnect", sessionId: "session" };
  it("claims exactly once, validates all scope/target fields, and allows a claimed continuation past 5s", () => {
    let now = 0;
    let current = true;
    const ledger = createCoreActionLedger({
      now: () => now,
      current: (value) =>
        current && value.hostEpoch === "host" && value.workbenchInstance === "window",
    });
    const ref = ledger.mint(scope, target);
    expect(ledger.claim({ ...ref, scope: { ...scope, workbenchInstance: "old" } }, target)).toBe(
      false,
    );
    expect(ledger.claim(ref, { ...target, sessionId: "foreign" })).toBe(false);
    expect(ledger.claim({ ...ref, actionToken: "feature-action-ref" }, target)).toBe(false);
    expect(ledger.claim(ref, target)).toBe(true);
    expect(ledger.claim(ref, target)).toBe(false);
    now = 20_000;
    expect(ledger.isClaimed(ref, target)).toBe(true);
    current = false;
    expect(ledger.isClaimed(ref, target)).toBe(false);
    ledger.complete(ref);
    current = true;
    expect(ledger.isClaimed(ref, target)).toBe(false);
  });
  it("denies an unclaimed token exactly at expiry and cannot revive it with a new host epoch", () => {
    let now = 0;
    const ledger = createCoreActionLedger({ now: () => now, current: () => true });
    const ref = ledger.mint(scope, target);
    now = 5_000;
    expect(ledger.claim(ref, target)).toBe(false);
    expect(ledger.claim({ ...ref, scope: { ...scope, hostEpoch: "next" } }, target)).toBe(false);
  });
  function fixture(count = 1) {
    let now = 0;
    const ledger = createCoreActionLedger({ now: () => now, current: () => true });
    const execute = vi.fn(async (ref) => {
      expect(ledger.claim(ref, target)).toBe(true);
    });
    const entries: RecoveryEntry[] = Array.from({ length: count }, (_, i) => {
      const item: CoreRecoveryItem = {
        id: `item-${i}`,
        sourceKey: "builtin:kobrixa.fixture",
        kind: "device",
        state: "unconfirmed",
        title: { en: "Stop not confirmed" },
        detail: { en: "Reconnect explicitly to reconcile." },
        actions: [{ id: `option-${i}`, kind: "stop" }],
      };
      return { item, options: new Map([[`option-${i}`, { target, execute }]]) };
    });
    const openDetail = vi.fn();
    const recovery = new CoreRecovery({
      scope: () => scope,
      entries: () => entries,
      actions: ledger,
      now: () => now,
      openDetail,
    });
    return {
      recovery,
      execute,
      entries,
      openDetail,
      time: (value: number) => {
        now = value;
      },
    };
  }
  it("snapshot option ids do not authorize action; main mints only after resolving item+option", async () => {
    const h = fixture();
    expect((await h.recovery.act({ itemId: "unknown", actionId: "option-0" })).ok).toBe(false);
    expect((await h.recovery.act({ itemId: "item-0", actionId: "unknown" })).ok).toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    expect((await h.recovery.act({ itemId: "item-0", actionId: "option-0" })).ok).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.execute.mock.calls[0]![0].actionToken).not.toBe("option-0");
  });
  it("pages 16 items, binds cursor revision/window and expires it after 30s", async () => {
    const h = fixture(17);
    const first = await h.recovery.snapshot({});
    if (!first.ok) throw new Error("snapshot failed");
    expect(first.value.items).toHaveLength(16);
    expect(first.value.nextCursor).toBeTypeOf("string");
    const rest = await h.recovery.snapshot({ cursor: first.value.nextCursor! });
    expect(rest).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ id: "item-16" })], nextCursor: null },
    });
    h.time(30_000);
    expect((await h.recovery.snapshot({ cursor: first.value.nextCursor! })).ok).toBe(false);
    h.time(31_000);
    const next = await h.recovery.snapshot({});
    if (!next.ok) throw new Error("snapshot failed");
    h.recovery.changed();
    expect((await h.recovery.snapshot({ cursor: next.value.nextCursor! })).ok).toBe(false);
  });
  it("keeps core recovery usable without optional plugins and never invokes a feature handler", async () => {
    const h = fixture();
    const snapshot = await h.recovery.snapshot({});
    expect(snapshot).toMatchObject({
      ok: true,
      value: { items: [expect.objectContaining({ state: "unconfirmed" })] },
    });
    expect(h.execute).not.toHaveBeenCalled();
  });
});
