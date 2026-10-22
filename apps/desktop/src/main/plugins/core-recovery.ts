import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  CoreActionReference,
  CoreActionTarget,
  CoreActionValidationPort,
  CoreWindowScope,
} from "@kobrixa/plugin-runtime";

export interface CoreActionLedger extends CoreActionValidationPort {
  mint(scope: CoreWindowScope, target: CoreActionTarget): CoreActionReference;
  retire(scope: CoreWindowScope): void;
}
export function createCoreActionLedger(input: {
  now: () => number;
  current: (scope: CoreWindowScope) => boolean;
}): CoreActionLedger {
  type Entry = {
    action: CoreActionReference;
    target: CoreActionTarget;
    expires: number;
    claimed: boolean;
  };
  const entries = new Map<string, Entry>();
  const sameScope = (a: CoreWindowScope, b: CoreWindowScope) =>
    a.hostEpoch === b.hostEpoch && a.workbenchInstance === b.workbenchInstance;
  const lookup = (action: CoreActionReference, target?: CoreActionTarget) => {
    const entry = entries.get(action.actionToken);
    if (!entry || !sameScope(entry.action.scope, action.scope)) return undefined;
    if (!input.current(entry.action.scope) || (!entry.claimed && input.now() >= entry.expires)) {
      entries.delete(action.actionToken);
      return undefined;
    }
    return target && !isDeepStrictEqual(entry.target, target) ? undefined : entry;
  };
  return {
    mint(scope, target) {
      if (!input.current(scope)) throw new Error("Retired workbench scope.");
      for (const [token, entry] of entries)
        if (!input.current(entry.action.scope) || (!entry.claimed && input.now() >= entry.expires))
          entries.delete(token);
      const action = Object.freeze({
        actionToken: randomUUID(),
        scope: Object.freeze({ ...scope }),
      });
      entries.set(action.actionToken, {
        action,
        target: structuredClone(target),
        expires: input.now() + 5_000,
        claimed: false,
      });
      return action;
    },
    claim(action, target) {
      const entry = lookup(action, target);
      if (!entry || entry.claimed) return false;
      entry.claimed = true;
      return true;
    },
    isClaimed(action, target) {
      return lookup(action, target)?.claimed === true;
    },
    complete(action) {
      const entry = entries.get(action.actionToken);
      if (entry && sameScope(entry.action.scope, action.scope)) entries.delete(action.actionToken);
    },
    retire(scope) {
      for (const [token, entry] of entries)
        if (sameScope(entry.action.scope, scope)) entries.delete(token);
    },
  };
}
