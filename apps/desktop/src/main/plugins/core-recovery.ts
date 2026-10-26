import type { DeviceSessionSnapshot } from "@kobrixa/plugin-protocol";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  DeviceRecoveryPort,
  CoreRecoveryItem,
  CoreRecoveryPort,
  CoreRecoverySnapshot,
  CoreActionReference,
  CoreActionTarget,
  CoreActionValidationPort,
  CoreWindowScope,
} from "@kobrixa/plugin-runtime";

export interface CoreActionLedger extends CoreActionValidationPort {
  mint(scope: CoreWindowScope, target: CoreActionTarget): CoreActionReference;
  retire(scope: CoreWindowScope): void;
  count(): number;
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
    count: () =>
      [...entries.values()].filter(
        (entry) =>
          input.current(entry.action.scope) && (entry.claimed || input.now() < entry.expires),
      ).length,
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

const scopeKey = (scope: CoreWindowScope) =>
  JSON.stringify([scope.hostEpoch, scope.workbenchInstance]);
export type RecoveryEntry = {
  item: CoreRecoveryItem;
  options: ReadonlyMap<
    string,
    {
      target?: CoreActionTarget;
      confirm?(): Promise<boolean>;
      execute(action: CoreActionReference): Promise<void>;
    }
  >;
};
const stale = () => ({
  ok: false as const,
  error: {
    code: "PLUGIN_E_STALE_RESOURCE" as const,
    message: "Recovery selection is no longer current.",
    detail: { kind: "resource" as const, reason: "stale" as const, resource: "rpc" as const },
  },
});
export class CoreRecovery implements CoreRecoveryPort {
  readonly #listeners = new Set<() => void>();
  readonly #cursors = new Map<
    string,
    { offset: number; revision: number; scope: string; expires: number }
  >();
  #persistenceDetail170: ReturnType<typeof createPersistenceRecoveryBridge170> | undefined;
  private async entries170(): Promise<readonly RecoveryEntry[]> {
    return [...(await this.input.entries()), ...(this.#persistenceDetail170?.entries() ?? [])];
  }
  attachPersistence170(detail: ReturnType<typeof createPersistenceRecoveryBridge170>): () => void {
    if (this.#persistenceDetail170) throw new Error("Core persistence detail already attached");
    this.#persistenceDetail170 = detail;
    const off = detail.bridge.onChanged(() => this.changed());
    this.changed();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      off();
      if (this.#persistenceDetail170 === detail) this.#persistenceDetail170 = undefined;
      this.changed();
    };
  }
  #revision = 0;
  constructor(
    private readonly input: {
      scope(): CoreWindowScope;
      entries(): readonly RecoveryEntry[] | Promise<readonly RecoveryEntry[]>;
      actions: CoreActionLedger;
      now(): number;
      openDetail(input: { itemId: string }, scope: CoreWindowScope): void;
    },
  ) {}
  changed(): void {
    this.#revision++;
    this.#cursors.clear();
    for (const listener of this.#listeners) listener();
  }
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async snapshot(input: { cursor?: string }): ReturnType<CoreRecoveryPort["snapshot"]> {
    const scope = this.input.scope();
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = this.#cursors.get(input.cursor);
      if (
        !cursor ||
        cursor.revision !== this.#revision ||
        cursor.scope !== scopeKey(scope) ||
        cursor.expires <= this.input.now()
      )
        return stale();
      offset = cursor.offset;
    }
    const priority = (item: CoreRecoveryItem) =>
      ["stopping", "unconfirmed"].includes(item.state)
        ? 0
        : item.kind === "storage"
          ? 1
          : item.kind === "process"
            ? 2
            : 3;
    const revision = this.#revision;
    const entries = [...(await this.entries170())].sort(
      (a, b) =>
        priority(a.item) - priority(b.item) ||
        a.item.id.localeCompare(b.item.id, "en", { numeric: true }),
    );
    if (revision !== this.#revision || scopeKey(scope) !== scopeKey(this.input.scope()))
      return stale();
    const snapshot: CoreRecoverySnapshot = {
      hostEpoch: scope.hostEpoch,
      revision: this.#revision,
      items: [],
      nextCursor: null,
    };
    let next = offset;
    while (next < entries.length && snapshot.items.length < 16) {
      const item = entries[next]!.item;
      const trial = { ...snapshot, items: [...snapshot.items, item], nextCursor: "0".repeat(36) };
      if (Buffer.byteLength(JSON.stringify(trial), "utf8") > 256 * 1024) {
        if (snapshot.items.length === 0) return stale();
        break;
      }
      snapshot.items.push(structuredClone(item));
      next++;
    }
    if (next < entries.length) {
      for (const [key, cursor] of this.#cursors)
        if (cursor.expires <= this.input.now()) this.#cursors.delete(key);
      if (this.#cursors.size >= 64) this.#cursors.delete(this.#cursors.keys().next().value!);
      const cursor = randomUUID();
      this.#cursors.set(cursor, {
        offset: next,
        revision: this.#revision,
        scope: scopeKey(scope),
        expires: this.input.now() + 30_000,
      });
      snapshot.nextCursor = cursor;
    }
    return { ok: true, value: snapshot };
  }
  async act(input: { itemId: string; actionId: string }): ReturnType<CoreRecoveryPort["act"]> {
    const scope = this.input.scope();
    const entry = (await this.entries170()).find((candidate) => candidate.item.id === input.itemId);
    const option = entry?.options.get(input.actionId);
    if (
      !entry ||
      !option ||
      scopeKey(scope) !== scopeKey(this.input.scope()) ||
      !entry.item.actions.some((item) => item.id === input.actionId)
    )
      return stale();
    if (entry.item.actions.find((item) => item.id === input.actionId)?.kind === "manage") {
      try {
        const detail = this.#persistenceDetail170;
        if (detail?.entries().some((value) => value.item.id === entry.item.id))
          detail.openDetail({ itemId: entry.item.id }, scope);
        else this.input.openDetail({ itemId: entry.item.id }, scope);
        return this.snapshot({});
      } catch {
        return stale();
      }
    }
    if (!option.target) return stale();
    if (option.confirm) {
      if (!(await option.confirm()) || scopeKey(scope) !== scopeKey(this.input.scope()))
        return stale();
      const current = (await this.entries170())
        .find((candidate) => candidate.item.id === input.itemId)
        ?.options.get(input.actionId);
      if (!current || !isDeepStrictEqual(current.target, option.target)) return stale();
    }
    let action: CoreActionReference;
    try {
      action = this.input.actions.mint(scope, option.target);
    } catch {
      return stale();
    }
    try {
      await option.execute(action);
    } catch {
      return stale();
    } finally {
      this.input.actions.complete(action);
    }
    this.changed();
    return this.snapshot({});
  }
}

/** Main-owned projection. Physical identity, native paths and executable callbacks never cross IPC. */
export function createRecoveryEntries(input: {
  device: DeviceRecoveryPort;
  sessions(): Promise<readonly DeviceSessionSnapshot[]>;
  processes(): readonly { sourceKey: string; status: string }[];
  confirmDevice(session: DeviceSessionSnapshot): Promise<boolean>;
}): () => Promise<readonly RecoveryEntry[]> {
  const references = new Map<string, string>();
  return async () => {
    const sessions = await input.sessions();
    const retained = new Set<string>();
    const reference = (key: string) => {
      retained.add(key);
      let value = references.get(key);
      if (!value) {
        value = randomUUID();
        references.set(key, value);
      }
      return value;
    };
    const entries: RecoveryEntry[] = [];
    const snapshot = input.device.snapshot();
    const requireSuccess = (result: { ok: boolean }) => {
      if (!result.ok) throw new Error("Recovery remains blocked.");
    };
    for (const fault of snapshot.faults) {
      const options = new Map<
        string,
        RecoveryEntry["options"] extends ReadonlyMap<string, infer V> ? V : never
      >();
      const actions: CoreRecoveryItem["actions"] = [];
      const add = (
        kind: CoreRecoveryItem["actions"][number]["kind"],
        key: string,
        option: NonNullable<ReturnType<typeof options.get>>,
      ) => {
        const id = reference(key);
        actions.push({ kind, id });
        options.set(id, option);
      };
      if (fault.state === "resolved") {
        add("clear-resolved", `${fault.id}:${fault.revision}:clear`, {
          target: { kind: "device-clear", entryIds: [fault.id] },
          execute: async (action) =>
            requireSuccess(await input.device.clearResolved({ entryIds: [fault.id], action })),
        });
      } else {
        const original = sessions.find(
          (session) =>
            session.sessionId === fault.sessionId &&
            session.providerId === fault.providerId &&
            session.providerGeneration === fault.providerGeneration &&
            ["connected", "quarantined"].includes(session.state),
        );
        if (original)
          add(
            "stop",
            `${fault.id}:${fault.revision}:${original.sessionId}:${original.providerGeneration}:stop`,
            {
              target: { kind: "device-stop", faultId: fault.id, sessionId: original.sessionId },
              execute: async (action) =>
                requireSuccess(
                  await input.device.stopCurrent({
                    faultId: fault.id,
                    sessionId: original.sessionId,
                    action,
                  }),
                ),
            },
          );
        const current = sessions.filter(
          (session) =>
            session.providerId === fault.providerId &&
            ["connected", "quarantined"].includes(session.state),
        );
        // A host dialog supplies identity evidence; matching provider/type alone is insufficient.
        if (current.length === 1) {
          const session = current[0]!;
          add(
            "reconcile",
            `${fault.id}:${fault.revision}:${session.sessionId}:${session.providerGeneration}:reconcile`,
            {
              target: {
                kind: "device-reconcile",
                faultId: fault.id,
                sessionId: session.sessionId,
                identityEvidence: "user-confirmed-device",
              },
              confirm: () => input.confirmDevice(session),
              execute: async (action) =>
                requireSuccess(
                  await input.device.reconcile({
                    faultId: fault.id,
                    sessionId: session.sessionId,
                    identityEvidence: "user-confirmed-device",
                    action,
                  }),
                ),
            },
          );
        }
      }
      entries.push({
        item: {
          id: fault.id,
          sourceKey:
            fault.owner.kind === "plugin" ? fault.owner.owner.sourceKey : "builtin:kobrixa.core",
          kind: "device",
          state:
            fault.state === "resolved"
              ? "resolved"
              : fault.state === "active-program"
                ? "running"
                : "unconfirmed",
          title: { en: "Device safety recovery", "zh-TW": "設備安全恢復" },
          detail:
            fault.state === "resolved"
              ? { en: "The stop result is confirmed and saved.", "zh-TW": "已確認停止結果並保存。" }
              : {
                  en: "Confirm the device is stopped. Reconnect explicitly if needed, then reconcile the saved record.",
                  "zh-TW": "請確認設備已停止；需要時先重新連線，再核對已保存的紀錄。",
                },
          operation: fault.operationId,
          actions,
        },
        options,
      });
    }
    if (snapshot.journalHealth !== "ready")
      entries.push({
        item: {
          id: reference(`journal:${snapshot.journalHealth}`),
          sourceKey: "builtin:kobrixa.core",
          kind: "device",
          state: "save-failed",
          title: { en: "Device safety record unavailable", "zh-TW": "設備安全紀錄無法使用" },
          detail: {
            en: "The safety journal could not be read or saved. Device work remains blocked.",
            "zh-TW": "安全紀錄無法讀取或保存，設備操作仍受阻擋。",
          },
          actions: [],
        },
        options: new Map(),
      });
    for (const process of input.processes().filter((value) => value.status === "failed")) {
      const id = reference(`process:${process.sourceKey}`),
        actionId = reference(`process:${process.sourceKey}:manage`);
      entries.push({
        item: {
          id,
          sourceKey: process.sourceKey,
          kind: "process",
          state: "process-failed",
          title: { en: "Plugin process failed", "zh-TW": "插件程序失敗" },
          detail: {
            en: "Review this source in plugin settings before explicitly trying again.",
            "zh-TW": "請先在插件設定檢查此來源，再明確重試。",
          },
          actions: [{ id: actionId, kind: "manage" }],
        },
        options: new Map([
          [
            actionId,
            {
              execute: async () => {
                throw new Error("Management does not mint an action.");
              },
            },
          ],
        ]),
      });
    }
    for (const key of references.keys()) if (!retained.has(key)) references.delete(key);
    return entries;
  };
}

import type { PersistenceRecoveryBridge } from "../../shared/plugin-persistence.js";
import type { PersistenceHost } from "./persistence/host-port.js";
import type { PersistenceRecoverySnapshot } from "@kobrixa/plugin-runtime";

export function createPersistenceRecoveryBridge170(input: {
  host: PersistenceHost;
  actions: CoreActionLedger;
  scope: () => CoreWindowScope;
  currentScope: (scope: CoreWindowScope) => boolean;
}) {
  type Row = {
    itemId: string;
    recoveryId: string;
    scope: CoreWindowScope;
    revision: number;
    item: PersistenceRecoverySnapshot["items"][number];
    manage: string;
    options: Map<string, "retry" | "export" | "discard">;
  };
  let disposed = false;
  let revision = -1;
  let scope = "";
  const rows = new Map<string, Row>();
  const opens = new Set<(value: { itemId: string }) => void>();
  const changes = new Set<() => void>();
  const refresh = () => {
    if (disposed) return;
    const snapshot = input.host.recovery.snapshot();
    let current: CoreWindowScope;
    try {
      current = input.scope();
    } catch {
      rows.clear();
      revision = -1;
      scope = "";
      return;
    }
    const next = scopeKey(current);
    if (revision === snapshot.revision && scope === next) return;
    const previous =
      scope === next
        ? new Map([...rows.values()].map((row) => [row.recoveryId, row.itemId]))
        : new Map<string, string>();
    rows.clear();
    revision = snapshot.revision;
    scope = next;
    if (!input.currentScope(current)) return;
    for (const item of snapshot.items) {
      const itemId = previous.get(item.id) ?? randomUUID();
      const options = new Map<string, "retry" | "export" | "discard">();
      for (const action of item.actions) options.set(randomUUID(), action.kind);
      rows.set(itemId, {
        itemId,
        recoveryId: item.id,
        scope: structuredClone(current),
        revision,
        item: structuredClone(item),
        manage: randomUUID(),
        options,
      });
    }
  };
  const resolve = (itemId: string) => {
    refresh();
    const row = rows.get(itemId);
    try {
      return row &&
        row.revision === revision &&
        input.currentScope(row.scope) &&
        scopeKey(row.scope) === scopeKey(input.scope())
        ? row
        : null;
    } catch {
      return null;
    }
  };
  const detail = (row: Row): PersistenceRecoverySnapshot => ({
    revision,
    items: [
      {
        ...structuredClone(row.item),
        actions: [...row.options].map(([id, kind]) => ({ id, kind })),
      },
    ],
  });
  const failure = () => ({
    ok: false as const,
    error: {
      code: "PLUGIN_E_STALE_RESOURCE" as const,
      message: "Recovery selection is no longer current.",
    },
  });
  const bridge: PersistenceRecoveryBridge = {
    async snapshot({ itemId }) {
      const row = resolve(itemId);
      return row ? { ok: true, value: detail(row) } : failure();
    },
    async act({ itemId, optionId }) {
      const row = resolve(itemId);
      const kind = row?.options.get(optionId);
      if (!row || !kind) return failure();
      // Consume before any await, including mint failure; repeated click never replays.
      row.options.delete(optionId);
      const target: CoreActionTarget = {
        kind:
          kind === "retry"
            ? "persistence-retry"
            : kind === "discard"
              ? "persistence-discard"
              : "persistence-export",
        recovery: row.recoveryId,
      };
      let action: CoreActionReference;
      try {
        action = input.actions.mint(row.scope, target);
      } catch {
        return failure();
      }
      try {
        if (kind === "retry") await input.host.participant.retry(row.recoveryId, action);
        else if (kind === "discard") await input.host.participant.discard(row.recoveryId, action);
        else {
          const result = await input.host.recovery.export({ recovery: row.recoveryId, action });
          if (!result.ok) return result;
        }
        refresh();
        // Find only the original durable recovery; an empty list means it resolved.
        const next = [...rows.values()].find((value) => value.recoveryId === row.recoveryId);
        return { ok: true, value: next ? detail(next) : { revision, items: [] } };
      } catch {
        return failure();
      } finally {
        input.actions.complete(action);
        for (const changed of changes) changed();
      }
    },
    onOpen(listener) {
      opens.add(listener);
      return () => {
        opens.delete(listener);
      };
    },
    onChanged(listener) {
      changes.add(listener);
      return () => {
        changes.delete(listener);
      };
    },
  };
  const off = input.host.recovery.subscribe(() => {
    refresh();
    for (const changed of changes) changed();
  });
  return {
    bridge,
    entries(): readonly RecoveryEntry[] {
      refresh();
      return [...rows.values()].map((row) => ({
        item: {
          id: row.itemId,
          sourceKey: row.item.sourceKey,
          kind: "storage",
          state: row.item.state === "saved" ? "resolved" : "save-failed",
          title: { en: "Saved data recovery" },
          detail: { en: "Review retained data and available recovery actions." },
          actions: [{ id: row.manage, kind: "manage" }],
        },
        options: new Map([
          [
            row.manage,
            {
              execute: async () => {
                throw new Error("Management does not mint an action");
              },
            },
          ],
        ]),
      }));
    },
    openDetail(value: { itemId: string }, original: CoreWindowScope): void {
      const row = resolve(value.itemId);
      if (!row || scopeKey(original) !== scopeKey(row.scope))
        throw new Error("Stale recovery window");
      for (const listener of opens) listener({ itemId: row.itemId });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      off();
      rows.clear();
      opens.clear();
      changes.clear();
    },
  };
}
