import {
  normalizeSettingsValues,
  validateSettingsValues,
} from "../../../../../../packages/plugin-protocol/src/settings.js";
import type {
  BoundSettingsService,
  CommonEventLedgerPort,
  SettingsFormBinding,
} from "@kobrixa/plugin-runtime";
import { ownerKey } from "./engine-port.js";
import { validateSettingsResource } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import type { PersistenceBackend } from "./engine-port.js";
import type { HostSettingsNamespace, PersistenceSourcePort } from "./host-port.js";

import { createHash, randomUUID } from "node:crypto";
import type {
  Handle,
  ResourceOwner,
  SettingsResourceV1,
  SettingsSnapshot,
  SettingsRequestMap,
  SettingsField,
  Values,
  SettingsScalar,
  PersistenceReason,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type {
  PersistenceEnginePort,
  PersistenceReadPort,
  PersistenceEvidencePort,
  PublicationTicket,
} from "./engine-port.js";

type Failure = Extract<SettingsRequestMap["settings/read"]["result"], { ok: false }>;
type Change = {
  revision: string;
  schemaVersion: number;
  changedKeys: string[];
  cause: "update" | "reset" | "migrate" | "import";
};
export type SettingsDependencies = {
  /** Additional write-only admission; never substitutes for owner/permission checks. */
  mutationAllowed?(owner: ResourceOwner): boolean;
  now(): number;
  allowed(principal: Principal, permission: "settings.read" | "settings.write"): boolean;
  readResource(owner: ResourceOwner): Promise<{
    resource: SettingsResourceV1;
    digest: string;
    validationDigest: string;
  }>;
  validateResource(resource: SettingsResourceV1): boolean;
  evidence: PersistenceEvidencePort;
  read: Pick<PersistenceReadPort, "settings">;
  engine: PersistenceEnginePort;
  watch: {
    register(owner: ResourceOwner): Handle;
    changed(owner: ResourceOwner, event: Change): void;
    invalidate(owner: ResourceOwner): void;
  };
};
export function settingsFailure(
  code: "PLUGIN_E_SETTINGS_SCHEMA" | "PLUGIN_E_SETTINGS_SAVE" | "PLUGIN_E_SETTINGS_CONFLICT",
  reason: PersistenceReason,
): Failure {
  return {
    ok: false,
    error: {
      code,
      message: "Settings request could not be completed.",
      detail: { kind: "persistence", reason },
    },
  };
}
function scalarValid(field: SettingsField, value: SettingsScalar): boolean {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (field.type === "number" || Number.isSafeInteger(value)) &&
        value >= field.minimum &&
        value <= field.maximum
      );
    case "enum":
      return field.options.some((option) => option.value === value);
    case "string":
      return (
        typeof value === "string" &&
        !value.includes("\0") &&
        !/[\uD800-\uDFFF]/u.test(value) &&
        [...value].length >= field.minLength &&
        [...value].length <= field.maxLength &&
        Buffer.byteLength(value) <= field.maxBytes
      );
  }
}
function valuesFor(
  resource: SettingsResourceV1,
  input: Values,
  complete: boolean,
): Values | Failure {
  if (input.length > 128 || new Set(input.map((x) => x.key)).size !== input.length)
    return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "duplicate-key");
  const fields = new Map(resource.fields.map((field) => [field.key, field]));
  for (const { key, value } of input) {
    const field = fields.get(key);
    if (!field) return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "unknown-key");
    if (!scalarValid(field, value))
      return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
  }
  if (complete && input.length !== fields.size)
    return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
  const sorted = [...input].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return Buffer.byteLength(JSON.stringify(sorted)) <= 65536
    ? sorted
    : settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "size-limit");
}
export function createSettingsService(deps: SettingsDependencies) {
  function assertMutationAllowed(owner: ResourceOwner): void {
    if (!(deps.mutationAllowed?.(owner) ?? true))
      throw {
        ok: false,
        error: { code: "PLUGIN_E_DISABLED", message: "Settings migration is not ready." },
      } satisfies Failure;
  }

  const tails = new Map<string, Promise<unknown>>();
  const pending = new Map<string, Promise<void>>();
  const unresolved = new Map<
    string,
    { ticket: PublicationTicket; change: Omit<Change, "revision"> }
  >();
  function committed(owner: ResourceOwner, change: Change) {
    try {
      deps.watch.changed(owner, change);
    } catch {
      try {
        deps.watch.invalidate(owner);
      } catch {
        /* Receipt remains authoritative. */
      }
    }
  }
  type Handlers = {
    [M in keyof SettingsRequestMap]: (
      owner: ResourceOwner,
      params: SettingsRequestMap[M]["params"],
      signal: AbortSignal,
      current: () => Promise<void>,
    ) => Promise<SettingsRequestMap[M]["result"]>;
  };
  async function read(
    owner: ResourceOwner,
    version?: number,
    migration = false,
    current: () => Promise<void> = async () => {},
  ) {
    await current();
    const loaded = await deps.readResource(owner);
    await current();
    if (!deps.validateResource(loaded.resource))
      throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-resource");
    if (version !== undefined && version !== loaded.resource.schemaVersion)
      throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    const ticket = unresolved.get(owner.sourceKey);
    if (ticket) {
      const result = await deps.engine.reconcile(ticket.ticket);
      if (
        result.disposition === "unknown" ||
        (result.disposition === "committed" && !result.receipt)
      )
        throw uncertain();
      unresolved.delete(owner.sourceKey);
      if (result.disposition === "committed" && result.receipt)
        committed(ticket.ticket.owner, { ...ticket.change, revision: result.receipt.revision });
    }
    let stored: SettingsSnapshot | null;
    try {
      stored = await deps.read.settings(owner);
    } catch (error) {
      throw isFailure(error) ? error : settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io");
    }
    await current();
    if (!migration && stored) {
      if (stored.schemaVersion !== loaded.resource.schemaVersion)
        throw settingsFailure(
          "PLUGIN_E_SETTINGS_SCHEMA",
          stored.schemaVersion > loaded.resource.schemaVersion ? "downgrade" : "migration-required",
        );
      if ((await deps.evidence.settingsDigest(owner))?.validationDigest !== loaded.validationDigest)
        throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "schema-changed-without-version");
      try {
        validateSettingsValues(loaded.resource, stored.values, true);
      } catch {
        throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "corrupt");
      }
    }
    await current();
    return {
      ...loaded,
      stored,
      snapshot: stored ?? {
        schemaVersion: loaded.resource.schemaVersion,
        revision: null,
        values: loaded.resource.fields
          .map(({ key, default: value }) => ({ key, value }))
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
      },
    };
  }
  function uncertain(): Failure {
    return {
      ok: false,
      error: {
        code: "PLUGIN_E_SETTINGS_SAVE",
        message: "Save outcome requires reconciliation.",
        detail: { kind: "persistence", reason: "publish-uncertain", disposition: "unknown" },
      },
    };
  }
  async function mutate(
    owner: ResourceOwner,
    version: number,
    expected: string | null,
    change: Values | string[],
    cause: "update" | "reset" | "migrate",
    signal: AbortSignal,
    from?: number,
    current: () => Promise<void> = async () => {},
  ): Promise<SettingsRequestMap["settings/update"]["result"]> {
    const state = await read(owner, version, cause === "migrate", current);
    if (state.snapshot.revision !== expected)
      return settingsFailure("PLUGIN_E_SETTINGS_CONFLICT", "revision-mismatch");
    if (
      cause === "migrate" &&
      (!state.stored || from !== state.stored.schemaVersion || from >= version)
    )
      return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    let changes: Values;
    if (cause === "reset") {
      const keys = change as string[];
      if (!keys.length || new Set(keys).size !== keys.length)
        return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "duplicate-key");
      const defaults = new Map(state.resource.fields.map((field) => [field.key, field.default]));
      if (keys.some((key) => !defaults.has(key)))
        return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "unknown-key");
      changes = keys.map((key) => ({ key, value: defaults.get(key)! }));
    } else changes = change as Values;
    const checked = valuesFor(state.resource, changes, cause === "migrate");
    if (!Array.isArray(checked)) return checked;
    if (!checked.length) return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    const map = new Map(
      (cause === "migrate" ? [] : state.snapshot.values).map((x) => [x.key, x.value]),
    );
    for (const { key, value } of checked) map.set(key, value);
    let values = valuesFor(
      state.resource,
      [...map].map(([key, value]) => ({ key, value })),
      true,
    );
    if (!Array.isArray(values)) return values;
    try {
      values = normalizeSettingsValues(state.resource, values);
    } catch {
      return settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    }
    const previous = new Map(state.snapshot.values.map(({ key, value }) => [key, value]));
    const changedKeys = [
      ...new Set([
        ...checked.map((x) => x.key),
        ...values.filter((x) => previous.get(x.key) !== x.value).map((x) => x.key),
      ]),
    ].sort();
    const ticket: PublicationTicket = Object.freeze({
      id: randomUUID(),
      owner: Object.freeze({ ...owner }),
      deadlineMonotonicMs: deps.now() + 10000,
      metadata: {
        kind: "settings" as const,
        schemaVersion: version,
        validationDigest: state.validationDigest,
      },
      target: { kind: "settings" as const, expectedRevision: expected },
    });
    const bytes = Buffer.from(
      JSON.stringify({
        formatVersion: 1,
        schemaVersion: version,
        validationDigest: state.validationDigest,
        values,
      }),
    );
    const check = () => {
      // No await between this host fence and reserve/append/publish.
      assertMutationAllowed(owner);
      if (signal.aborted)
        throw { ok: false, error: { code: "PLUGIN_E_CANCELLED", message: "Cancelled." } };
      if (deps.now() >= ticket.deadlineMonotonicMs)
        throw { ok: false, error: { code: "PLUGIN_E_TIMEOUT", message: "Timed out." } };
    };
    let settle!: () => void;
    pending.set(
      ticket.id,
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    try {
      await current();
      check();
      await deps.engine.reserve(ticket, bytes.length);
      await current();
      check();
      let offset = 0;
      while (offset < bytes.length) {
        const written = await deps.engine.append(ticket, offset, bytes.subarray(offset));
        if (written <= 0 || written > bytes.length - offset) throw new Error("short-write");
        offset += written;
        await current();
        check();
      }
      await deps.engine.seal(
        ticket,
        bytes.length,
        createHash("sha256").update(bytes).digest("hex"),
      );
      await current();
      check();
      const change = { schemaVersion: version, changedKeys, cause };
      unresolved.set(owner.sourceKey, { ticket, change });
      const result = await deps.engine.publish(ticket);
      if (result.disposition === "unknown") return uncertain();
      unresolved.delete(owner.sourceKey);
      if (result.disposition !== "committed" || !result.receipt)
        return settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io");
      const snapshot: SettingsSnapshot = {
        schemaVersion: version,
        revision: result.receipt.revision,
        values,
      };
      committed(owner, { ...change, revision: result.receipt.revision });
      return { ok: true, value: { snapshot, receipt: result.receipt } };
    } catch (error) {
      if (unresolved.has(owner.sourceKey)) return uncertain();
      await deps.engine.abort(ticket);
      if (isFailure(error)) return error;
      return settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io");
    } finally {
      pending.delete(ticket.id);
      settle();
    }
  }
  const handlers: Handlers = {
    "settings/read": async (owner, p, _s, current) => ({
      ok: true,
      value: (await read(owner, p.schemaVersion, false, current)).snapshot,
    }),
    "settings/watch": async (owner, p, _s, current) => {
      const state = await read(owner, p.schemaVersion, false, current);
      await current();
      const subscriptionId = deps.watch.register(owner);
      return { ok: true, value: { subscriptionId, sequence: 0, snapshot: state.snapshot } };
    },
    "settings/readMigration": async (owner, _p, _s, current) => {
      const state = await read(owner, undefined, true, current);
      return state.stored
        ? {
            ok: true,
            value: { stored: state.stored, declaredSchemaVersion: state.resource.schemaVersion },
          }
        : settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "invalid-value");
    },
    "settings/update": (owner, p, s, current) =>
      mutate(
        owner,
        p.schemaVersion,
        p.expectedRevision,
        p.changes,
        "update",
        s,
        undefined,
        current,
      ),
    "settings/reset": (owner, p, s, current) =>
      mutate(owner, p.schemaVersion, p.expectedRevision, p.keys, "reset", s, undefined, current),
    "settings/migrate": (owner, p, s, current) =>
      mutate(
        owner,
        p.schemaVersion,
        p.expectedRevision,
        p.values,
        "migrate",
        s,
        p.fromSchemaVersion,
        current,
      ),
  };
  async function requestOwner<M extends keyof SettingsRequestMap>(
    owner: ResourceOwner,
    method: M,
    params: SettingsRequestMap[M]["params"],
    signal: AbortSignal,
    current: () => Promise<void>,
  ): Promise<SettingsRequestMap[M]["result"]> {
    const mutation =
      method === "settings/update" || method === "settings/reset" || method === "settings/migrate";
    const continuation = async () => {
      await current();
      if (mutation) assertMutationAllowed(owner);
    };
    try {
      await continuation();
    } catch (error) {
      return (
        isFailure(error) ? error : settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io")
      ) as SettingsRequestMap[M]["result"];
    }
    const tail = tails.get(owner.sourceKey) ?? Promise.resolve();
    const next = tail
      .catch(() => {})
      .then(async () => {
        try {
          await continuation();
          if (signal.aborted)
            return {
              ok: false as const,
              error: { code: "PLUGIN_E_CANCELLED" as const, message: "Cancelled." },
            };
          return await handlers[method](owner, params, signal, continuation);
        } catch (error) {
          return isFailure(error) ? error : settingsFailure("PLUGIN_E_SETTINGS_SAVE", "io");
        }
      });
    tails.set(owner.sourceKey, next);
    void next.finally(() => {
      if (tails.get(owner.sourceKey) === next) tails.delete(owner.sourceKey);
    });
    // Every handler has the same failure union; the indexed Zod map hides that correlation.
    return next as Promise<SettingsRequestMap[M]["result"]>;
  }
  return {
    requestOwner,
    async settle(tickets: readonly string[]) {
      // Reconciliation can revoke a not-yet-dispatched publication. Join only
      // the captured attempts before the drain asks the engine for their outcome.
      await Promise.all(tickets.map((id) => pending.get(id)));
    },
    request<M extends keyof SettingsRequestMap>(
      principal: Principal,
      method: M,
      params: SettingsRequestMap[M]["params"],
      signal: AbortSignal,
    ): Promise<SettingsRequestMap[M]["result"]> {
      if (principal.kind !== "plugin")
        return Promise.resolve({
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "Source binding required.",
            detail: { kind: "permission", reason: "permission" },
          },
        } as SettingsRequestMap[M]["result"]);
      const write =
        method === "settings/update" ||
        method === "settings/reset" ||
        method === "settings/migrate";
      return requestOwner(principal.owner, method, params, signal, async () => {
        if (!deps.allowed(principal, write ? "settings.write" : "settings.read"))
          throw {
            ok: false,
            error: { code: "PLUGIN_E_DISABLED", message: "Settings unavailable." },
          };
      });
    },
    invalidate(owner: ResourceOwner) {
      deps.watch.invalidate(owner);
    },
    async idle() {
      await Promise.all(tails.values());
    },
  };
}

function isFailure(value: unknown): value is Failure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

export function createBoundSettingsService(input: {
  backend: PersistenceBackend;
  sources: PersistenceSourcePort;
  events: CommonEventLedgerPort;
  now: () => number;
}): BoundSettingsService {
  const service = settingsComposition(input);
  if (service.bound) return service.bound;
  type Form = {
    binding: SettingsFormBinding;
    owner: ResourceOwner;
    resource: SettingsResourceV1;
    callbacks: Set<() => void>;
    cleanups: Set<() => void>;
    subscription?: Handle;
  };
  // One replaceable slot per admitted native window, including opens in flight.
  // coreOwner restricts admission to the registered windows/source catalog.
  const slots = new Map<string, { sourceKey: string; form?: Form }>();
  let disposed = false;
  const scopeKey = (scope: SettingsFormBinding["scope"]) =>
    JSON.stringify([scope.hostEpoch, scope.workbenchInstance]);
  const currentForm = (binding: SettingsFormBinding) => slots.get(scopeKey(binding.scope))?.form;
  const isCurrent = (form: Form) => currentForm(form.binding) === form;
  const identity = (binding: SettingsFormBinding) =>
    JSON.stringify([
      binding.owner.sourceKey,
      binding.owner.pluginId,
      binding.owner.uiResourceGeneration,
      binding.scope.hostEpoch,
      binding.scope.workbenchInstance,
      binding.resourceDigest,
    ]);
  async function resolve(binding: SettingsFormBinding, form = currentForm(binding)) {
    if (!form || !isCurrent(form) || identity(binding) !== identity(form.binding))
      throw new Error("Stale settings binding.");
    const resolved = await input.sources.settings({
      sourceKey: binding.owner.sourceKey,
      resourceDigest: binding.resourceDigest,
    });
    const owner = input.sources.coreOwner({
      sourceKey: binding.owner.sourceKey,
      scope: binding.scope,
    });
    if (
      !isCurrent(form) ||
      !resolved ||
      !owner ||
      resolved.owner.sourceKey !== binding.owner.sourceKey ||
      ownerKey(owner) !== ownerKey(form.owner) ||
      resolved.owner.uiResourceGeneration !== binding.owner.uiResourceGeneration ||
      resolved.owner.pluginId !== binding.owner.pluginId
    )
      throw new Error("Stale settings binding.");
    service.admit(owner, binding.resourceDigest, resolved);
    return form;
  }
  function close(form: Form) {
    if (isCurrent(form)) slots.delete(scopeKey(form.binding.scope));
    if (form.subscription) {
      input.events.unsubscribe(form.owner, form.subscription);
      delete form.subscription;
    }
    for (const off of form.cleanups) off();
    form.cleanups.clear();
    form.callbacks.clear();
  }
  function dispose(binding: SettingsFormBinding) {
    const form = currentForm(binding);
    if (form && identity(binding) === identity(form.binding)) close(form);
  }
  const bound: BoundSettingsService = {
    async open({ sourceKey, scope, resourceDigest }) {
      scope = structuredClone(scope);
      const admittedOwner = input.sources.coreOwner({ sourceKey, scope });
      if (disposed || !admittedOwner || admittedOwner.sourceKey !== sourceKey)
        throw new Error("Settings source is not admitted.");
      const key = scopeKey(scope);
      const previous = slots.get(key)?.form;
      if (previous) close(previous);
      const slot: { sourceKey: string; form?: Form } = { sourceKey };
      slots.set(key, slot);
      try {
        const resolved = await input.sources.settings({ sourceKey, resourceDigest });
        const owner = input.sources.coreOwner({ sourceKey, scope });
        if (
          slots.get(key) !== slot ||
          !resolved ||
          !owner ||
          ownerKey(owner) !== ownerKey(admittedOwner) ||
          resolved.owner.sourceKey !== sourceKey ||
          owner.pluginId !== resolved.owner.pluginId
        )
          throw new Error("Stale settings binding.");
        const binding = { owner: resolved.owner, scope, resourceDigest };
        const form: Form = {
          binding: structuredClone(binding),
          owner: structuredClone(owner),
          resource: structuredClone(resolved.resource),
          callbacks: new Set(),
          cleanups: new Set(),
        };
        slot.form = form;
        service.admit(owner, resourceDigest, resolved);
        const result = await bound.read(binding);
        if (!isCurrent(form)) throw new Error("Stale settings binding.");
        if (!result.ok) throw result.error;
        return { binding, resource: resolved.resource, snapshot: result.value };
      } catch (error) {
        if (slots.get(key) === slot) {
          if (slot.form) close(slot.form);
          else slots.delete(key);
        }
        throw error;
      }
    },
    async read(binding) {
      const form = await resolve(binding);
      return service.requestOwner(
        form.owner,
        "settings/read",
        { schemaVersion: form.resource.schemaVersion },
        new AbortController().signal,
        async () => {
          await resolve(binding, form);
        },
      );
    },
    async update(binding, params) {
      const form = await resolve(binding);
      return service.requestOwner(
        form.owner,
        "settings/update",
        params,
        new AbortController().signal,
        async () => {
          await resolve(binding, form);
        },
      );
    },
    async reset(binding, params) {
      const form = await resolve(binding);
      return service.requestOwner(
        form.owner,
        "settings/reset",
        params,
        new AbortController().signal,
        async () => {
          await resolve(binding, form);
        },
      );
    },
    watch(binding, changed) {
      const form = currentForm(binding);
      if (!form || identity(form.binding) !== identity(binding))
        throw new Error("Stale settings binding.");
      form.callbacks.add(changed);
      const invalidateForm = () => {
        if (!isCurrent(form)) return;
        const callbacks = [...form.callbacks];
        dispose(binding);
        for (const callback of callbacks) {
          try {
            callback();
          } catch {
            /* One observer cannot silence the others. */
          }
        }
      };
      void resolve(binding, form)
        .then(() => {
          if (!isCurrent(form) || !form.callbacks.has(changed) || form.subscription) return;
          const result = input.events.create(form.owner);
          if (!result.ok) throw result.error;
          form.subscription = result.value.subscriptionId;
          const offRemoved = input.events.onRemoved((id) => {
            if (form.subscription !== id) return;
            delete form.subscription;
            offRemoved();
            form.cleanups.delete(offRemoved);
          });
          form.cleanups.add(offRemoved);
          input.events.activate(form.owner, form.subscription);
        })
        .catch(invalidateForm);
      const off = service.onCommitted(form.owner, () => {
        void resolve(binding, form)
          .then(() => {
            if (isCurrent(form) && form.callbacks.has(changed)) {
              try {
                changed();
              } catch {
                /* Observer failure does not invalidate the service. */
              }
            }
          })
          .catch(invalidateForm);
      });
      form.cleanups.add(off);
      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        off();
        form.cleanups.delete(off);
        form.callbacks.delete(changed);
        if (!form.callbacks.size && form.subscription) {
          input.events.unsubscribe(form.owner, form.subscription);
          delete form.subscription;
        }
      };
    },
    dispose,
  };
  service.bind(bound, (sourceKey) => {
    if (sourceKey === undefined) disposed = true;
    for (const [key, slot] of slots) {
      if (sourceKey !== undefined && slot.sourceKey !== sourceKey) continue;
      if (slot.form) close(slot.form);
      else slots.delete(key);
    }
  });
  return bound;
}

type CompositionInput = Parameters<typeof createBoundSettingsService>[0];
type ResolvedSettings = NonNullable<Awaited<ReturnType<PersistenceSourcePort["settings"]>>>;
const compositions = new WeakMap<PersistenceBackend, ReturnType<typeof makeSettingsComposition>>();
function settingsComposition(input: CompositionInput) {
  const existing = compositions.get(input.backend);
  if (existing) {
    if (existing.sources !== input.sources || existing.events !== input.events)
      throw new Error("Settings backend already composed with different dependencies.");
    return existing;
  }
  const service = makeSettingsComposition(input);
  compositions.set(input.backend, service);
  return service;
}
/** Host-only catalog admission and request/disposal facet for T5. */
export function settingsRequests(backend: PersistenceBackend) {
  const service = compositions.get(backend);
  if (!service) throw new Error("Settings service has not been constructed.");
  return service;
}
function makeSettingsComposition(input: CompositionInput) {
  const admitted = new Map<string, { digest: string; resolved: ResolvedSettings }>();
  const subscriptions = new Map<Handle, ResourceOwner>();
  const listeners = new Map<string, Set<(reason: "committed" | "retired") => void>>();
  function notify(sourceKey: string, reason: "committed" | "retired") {
    for (const listener of [...(listeners.get(sourceKey) ?? [])]) {
      try {
        listener(reason);
      } catch {
        /* Observer failure never changes a receipt. */
      }
    }
  }
  let disposed = false;
  let bound: BoundSettingsService | undefined;
  let closeForm = (_sourceKey?: string) => {};
  const offRemoved = input.events.onRemoved((id) => subscriptions.delete(id));
  const requireLive = () => {
    if (disposed) throw new Error("Settings service disposed.");
  };
  function hostCurrent(namespace: HostSettingsNamespace, importReady: () => boolean): boolean {
    try {
      if (disposed || !importReady()) return false;
      const value = input.sources.settingsNamespace?.(namespace.owner.sourceKey);
      return (
        !!value &&
        ownerKey(value.owner) === ownerKey(namespace.owner) &&
        value.resourceDigest === namespace.resourceDigest &&
        value.uiResourceGeneration === namespace.uiResourceGeneration
      );
    } catch {
      return false;
    }
  }
  const service = createSettingsService({
    now: input.now,
    mutationAllowed: (owner) => input.sources.settingsWriteAllowed?.(owner.sourceKey) ?? true,
    allowed: (principal) =>
      !disposed && principal.kind === "plugin" && input.sources.current(principal.owner),
    async readResource(owner) {
      requireLive();
      const entry = admitted.get(owner.sourceKey);
      if (!entry) throw new Error("Settings catalog admission required.");
      const resolved = await input.sources.settings({
        sourceKey: owner.sourceKey,
        resourceDigest: entry.digest,
      });
      requireLive();
      if (
        !resolved ||
        resolved.owner.sourceKey !== owner.sourceKey ||
        resolved.owner.pluginId !== owner.pluginId ||
        resolved.owner.uiResourceGeneration !== entry.resolved.owner.uiResourceGeneration
      )
        throw new Error("Stale settings catalog.");
      return {
        resource: resolved.resource,
        digest: entry.digest,
        validationDigest: resolved.validationDigest,
      };
    },
    validateResource(resource) {
      try {
        validateSettingsResource(resource, Buffer.byteLength(JSON.stringify(resource)));
        return true;
      } catch {
        return false;
      }
    },
    evidence: input.backend.evidence,
    read: input.backend.reads,
    engine: input.backend.engine,
    watch: {
      register(owner) {
        const result = input.events.create(owner);
        if (!result.ok) throw result;
        subscriptions.set(result.value.subscriptionId, owner);
        return result.value.subscriptionId;
      },
      changed(owner, event) {
        notify(owner.sourceKey, "committed");
        for (const [id, subscriber] of subscriptions) {
          if (subscriber.sourceKey !== owner.sourceKey) continue;
          const result = input.events.publish(
            subscriber,
            id,
            { kind: "settings.changed", data: event },
            "control",
          );
          if (!result.ok) input.events.unsubscribe(subscriber, id);
        }
      },
      invalidate(owner) {
        for (const [id, subscriber] of subscriptions)
          if (subscriber.sourceKey === owner.sourceKey) {
            input.events.unsubscribe(subscriber, id);
            subscriptions.delete(id);
          }
      },
    },
  });
  return {
    sources: input.sources,
    events: input.events,
    get bound() {
      return bound;
    },
    bind(value: BoundSettingsService, close: (sourceKey?: string) => void) {
      bound = value;
      closeForm = close;
    },
    admit(owner: ResourceOwner, digest: string, resolved: ResolvedSettings) {
      requireLive();
      if (
        resolved.owner.sourceKey !== owner.sourceKey ||
        resolved.owner.pluginId !== owner.pluginId
      )
        throw new Error("Wrong catalog owner.");
      admitted.set(owner.sourceKey, { digest, resolved: structuredClone(resolved) });
    },
    retire(sourceKey: string) {
      closeForm(sourceKey);
      admitted.delete(sourceKey);
      notify(sourceKey, "retired");
      for (const [id, owner] of subscriptions) {
        if (owner.sourceKey !== sourceKey) continue;
        input.events.unsubscribe(owner, id);
        subscriptions.delete(id);
      }
    },
    request<M extends keyof SettingsRequestMap>(
      principal: Principal,
      method: M,
      params: SettingsRequestMap[M]["params"],
      signal: AbortSignal,
    ): Promise<SettingsRequestMap[M]["result"]> {
      if (principal.kind !== "plugin") return service.request(principal, method, params, signal);
      const owner = principal.owner;
      const entry = admitted.get(owner.sourceKey);
      return service.requestOwner(owner, method, params, signal, async () => {
        requireLive();
        if (!input.sources.current(owner))
          throw {
            ok: false,
            error: { code: "PLUGIN_E_DISABLED", message: "Settings unavailable." },
          };
        if (!entry) throw new Error("Settings catalog admission required.");
        const resolved = await input.sources.settings({
          sourceKey: owner.sourceKey,
          resourceDigest: entry.digest,
        });
        requireLive();
        if (
          !input.sources.current(owner) ||
          !resolved ||
          resolved.owner.sourceKey !== owner.sourceKey ||
          resolved.owner.pluginId !== owner.pluginId ||
          resolved.owner.uiResourceGeneration !== entry.resolved.owner.uiResourceGeneration ||
          resolved.validationDigest !== entry.resolved.validationDigest
        )
          throw new Error("Stale settings catalog.");
      });
    },
    /** No window/process admission and no write authority. Import readiness is a
     * synchronous fence supplied by the host's completed migration gate. */
    hostCurrent,
    async hostSnapshot(sourceKey: string, importReady: () => boolean) {
      requireLive();
      if (!importReady()) throw new Error("Settings import is not ready.");
      const initial = input.sources.settingsNamespace?.(sourceKey);
      if (!initial || initial.owner.sourceKey !== sourceKey)
        throw new Error("Settings namespace is not admitted.");
      const namespace = structuredClone(initial);
      const current = async () => {
        requireLive();
        if (!hostCurrent(namespace, importReady)) throw new Error("Stale settings namespace.");
      };
      await current();
      const resolved = await input.sources.settings({
        sourceKey,
        resourceDigest: namespace.resourceDigest,
      });
      await current();
      if (
        !resolved ||
        resolved.owner.sourceKey !== sourceKey ||
        resolved.owner.pluginId !== namespace.owner.pluginId ||
        resolved.owner.uiResourceGeneration !== namespace.uiResourceGeneration
      )
        throw new Error("Stale settings resource.");
      // Shared service queue, validation and unresolved-publication reconciliation.
      admitted.set(sourceKey, {
        digest: namespace.resourceDigest,
        resolved: structuredClone(resolved),
      });
      const result = await service.requestOwner(
        namespace.owner,
        "settings/read",
        { schemaVersion: resolved.resource.schemaVersion },
        new AbortController().signal,
        current,
      );
      await current();
      if (!result.ok) throw result.error;
      if (!hostCurrent(namespace, importReady)) throw new Error("Stale settings namespace.");
      return structuredClone({
        namespace,
        resource: resolved.resource,
        validationDigest: resolved.validationDigest,
        snapshot: result.value,
      });
    },
    requestOwner: service.requestOwner,
    settle: service.settle,
    onCommitted(
      owner: Pick<ResourceOwner, "sourceKey">,
      listener: (reason: "committed" | "retired") => void,
    ) {
      requireLive();
      const set =
        listeners.get(owner.sourceKey) ?? new Set<(reason: "committed" | "retired") => void>();
      if (set.size >= 32) throw new Error("Settings observer limit.");
      set.add(listener);
      listeners.set(owner.sourceKey, set);
      return () => {
        set.delete(listener);
        if (!set.size && listeners.get(owner.sourceKey) === set) listeners.delete(owner.sourceKey);
      };
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      closeForm();
      offRemoved();
      for (const [id, owner] of subscriptions) input.events.unsubscribe(owner, id);
      subscriptions.clear();
      for (const key of listeners.keys()) notify(key, "retired");
      listeners.clear();
      admitted.clear();
      await service.idle();
      compositions.delete(input.backend);
    },
  };
}
