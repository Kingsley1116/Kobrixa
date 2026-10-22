import { expect, it } from "vitest";
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
