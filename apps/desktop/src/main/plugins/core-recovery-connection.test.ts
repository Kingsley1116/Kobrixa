import { expect, it, vi } from "vitest";
import type { ConnectionRecoverySnapshot, ResourceOwner } from "@kobrixa/plugin-protocol";
import type {
  CoreActionTarget,
  DeviceConnectionRecoveryPort,
  Principal,
} from "@kobrixa/plugin-runtime";
import { cancelUiConnectionRecovery, createCoreActionLedger } from "./core-recovery.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { hostEpoch: id(1), workbenchInstance: id(2) };
const owner: ResourceOwner = {
  sourceKey: "builtin:test.recovery",
  pluginId: "test.recovery",
  generation: 1,
  hostEpoch: id(1),
  processEpoch: id(3),
};
const ref = {
  recoveryId: id(4),
  providerId: "test.usb",
  providerGeneration: 7,
  previousSessionId: id(5),
};
const target: CoreActionTarget = { kind: "device-connection-recovery-cancel", ...ref };
function fixture() {
  let now = 0,
    visible = true,
    granted = true;
  let principal: Principal = { kind: "plugin", owner, authorityContext: null };
  const ledger = createCoreActionLedger({ now: () => now, current: () => true });
  let projection: ConnectionRecoverySnapshot = {
    hostEpoch: scope.hostEpoch,
    revision: 2,
    recovery: {
      ...ref,
      name: "USB",
      attemptsStarted: 1,
      retryLimit: 3,
      phase: "waiting",
      retryAfterMs: 1000,
    },
  };
  const cancelled = (): ConnectionRecoverySnapshot => ({
    hostEpoch: scope.hostEpoch,
    revision: 3,
    recovery: {
      ...ref,
      name: "USB",
      attemptsStarted: 1,
      retryLimit: 3,
      phase: "cancelled",
      reason: "user",
    },
  });
  const cancel = vi.fn<DeviceConnectionRecoveryPort["cancel"]>(
    async ({ target: current, action }) => {
      if (!ledger.claim(action, { kind: "device-connection-recovery-cancel", ...current }))
        throw Error("missing claim");
      return { ok: true, value: cancelled() };
    },
  );
  const snapshot = vi.fn(() => structuredClone(projection));
  const permission = vi.fn<Parameters<typeof cancelUiConnectionRecovery>[0]["hasPermission"]>(
    () => granted,
  );
  const input: Parameters<typeof cancelUiConnectionRecovery>[0] = {
    owner,
    recoveryId: ref.recoveryId,
    recovery: { snapshot, cancel },
    principal: () => principal,
    hasPermission: permission,
    current: () => visible,
    scope: () => scope,
    currentScope: () => true,
    actions: ledger,
  };
  return {
    input,
    ledger,
    cancel,
    snapshot,
    permission,
    cancelled,
    call: () => cancelUiConnectionRecovery(input),
    hide: () => {
      visible = false;
    },
    deny: () => {
      granted = false;
    },
    foreign: () => {
      principal = {
        kind: "plugin",
        owner: { ...owner, processEpoch: id(8) },
        authorityContext: null,
      };
    },
    projection: (v: ConnectionRecoverySnapshot) => {
      projection = v;
    },
    advance: () => {
      now += 5000;
    },
  };
}
it("trusted cancellation uses the observed full target and original devices.read principal, completing the token", async () => {
  const f = fixture();
  expect(await f.call()).toEqual({ ok: true, value: { output: {}, fieldErrors: [] } });
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.cancel.mock.calls[0]![0].target).toEqual(ref);
  expect(f.permission.mock.calls.every((c) => c[1] === "devices.read")).toBe(true);
  expect(f.ledger.count()).toBe(0);
  const old = f.cancel.mock.calls[0]![0].action;
  expect(f.ledger.claim(old, target)).toBe(false);
});
it.each(["null", "invalid", "foreign", "hidden", "permission", "absent"])(
  "denies %s before snapshot or mint",
  async (mode) => {
    const f = fixture();
    if (mode === "null") f.input.recoveryId = null;
    if (mode === "invalid") f.input.recoveryId = "forged";
    if (mode === "foreign") f.foreign();
    if (mode === "hidden") f.hide();
    if (mode === "permission") f.deny();
    if (mode === "absent") f.input.recovery = undefined;
    expect((await f.call()).ok).toBe(false);
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.ledger.count()).toBe(0);
  },
);
it("terminal and unrelated episodes cannot mint cancellation; late hidden outcomes remain unaccepted", async () => {
  const f = fixture();
  f.projection(f.cancelled());
  expect((await f.call()).ok).toBe(false);
  f.projection({
    hostEpoch: id(1),
    revision: 4,
    recovery: {
      ...ref,
      recoveryId: id(9),
      name: "Other",
      attemptsStarted: 0,
      retryLimit: 3,
      phase: "waiting",
      retryAfterMs: 1,
    },
  });
  expect((await f.call()).ok).toBe(false);
  expect(f.cancel).not.toHaveBeenCalled();
  const g = fixture();
  g.cancel.mockImplementation(async ({ target: current, action }) => {
    expect(g.ledger.claim(action, { kind: "device-connection-recovery-cancel", ...current })).toBe(
      true,
    );
    g.hide();
    return { ok: true, value: g.cancelled() };
  });
  expect((await g.call()).ok).toBe(false);
  expect(g.ledger.count()).toBe(0);
});
it("failed, mismatched and still-running cleanup never returns control accepted and always completes tokens", async () => {
  for (const mode of ["throw", "pending", "other-generation"]) {
    const f = fixture();
    f.cancel.mockImplementation(async () => {
      if (mode === "throw") throw Error("cleanup");
      const v = f.cancelled();
      if (!v.recovery) throw Error("fixture");
      return {
        ok: true,
        value: {
          ...v,
          recovery:
            mode === "pending"
              ? { ...ref, name: "USB", retryLimit: 3, attemptsStarted: 1, phase: "cancelling" }
              : { ...v.recovery, providerGeneration: 8 },
        },
      };
    });
    expect((await f.call()).ok).toBe(false);
    expect(f.ledger.count()).toBe(0);
  }
});
it("the existing ledger fences full episode identity, foreign scope, expiry and replay", () => {
  const f = fixture();
  const token = f.ledger.mint(scope, target);
  for (const changes of [
    { recoveryId: id(8) },
    { providerId: "other.usb" },
    { providerGeneration: 8 },
    { previousSessionId: id(8) },
  ])
    expect(f.ledger.claim(token, { ...target, ...changes })).toBe(false);
  expect(f.ledger.claim({ ...token, scope: { ...scope, workbenchInstance: id(9) } }, target)).toBe(
    false,
  );
  expect(f.ledger.claim(token, target)).toBe(true);
  expect(f.ledger.claim(token, target)).toBe(false);
  f.ledger.complete(token);
  const expired = f.ledger.mint(scope, target);
  f.advance();
  expect(f.ledger.claim(expired, target)).toBe(false);
  expect(f.ledger.count()).toBe(0);
});
