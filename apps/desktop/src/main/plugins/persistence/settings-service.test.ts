import { expect, it, vi } from "vitest";
import type { SettingsResourceV1, SettingsSnapshot, ResourceOwner } from "@kobrixa/plugin-protocol";
import {
  createSettingsService,
  settingsFailure,
  type SettingsDependencies,
} from "./settings-service.js";

const owner: ResourceOwner = {
  sourceKey: "builtin:test.settings",
  pluginId: "test.settings",
  generation: 1,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  processEpoch: "00000000-0000-4000-8000-000000000002",
};
const principal = { kind: "plugin" as const, owner, authorityContext: null };
const resource: SettingsResourceV1 = {
  schemaVersion: 1,
  title: { en: "Settings" },
  fields: [
    {
      key: "connection.mode",
      type: "enum",
      label: { en: "Mode" },
      default: 1,
      options: [
        { value: 1, label: { en: "Numeric" } },
        { value: "1", label: { en: "Text" } },
      ],
    },
    { key: "enabled", type: "boolean", label: { en: "Enabled" }, default: true },
  ],
};
function fixture() {
  let stored: SettingsSnapshot | null = null;
  let revision = 0;
  let live = true;
  const pending = new Map<string, { values: SettingsSnapshot["values"]; version: number }>();
  const publish = vi.fn<SettingsDependencies["engine"]["publish"]>(async (ticket) => {
    const data = pending.get(ticket.id)!;
    if (ticket.target.kind !== "settings") throw new Error("wrong target");
    if (ticket.target.expectedRevision !== (stored?.revision ?? null))
      throw new Error("revision-mismatch");
    revision++;
    const receipt = {
      revision: `r_${revision.toString(16).padStart(32, "0")}`,
      commitId: ticket.id,
      durability: "file-and-directory-sync" as const,
    };
    stored = { schemaVersion: data.version, revision: receipt.revision, values: data.values };
    return { disposition: "committed", receipt };
  });
  const changed = vi.fn();
  const subscribe = vi.fn(() => "00000000-0000-4000-8000-000000000003");
  const deps: SettingsDependencies = {
    now: () => 0,
    allowed: () => live,
    validateResource: () => true,
    readResource: async () => ({
      resource,
      digest: "a".repeat(64),
      validationDigest: "b".repeat(64),
    }),
    evidence: evidenceDouble({
      settingsDigest: async () =>
        stored
          ? {
              schemaVersion: stored.schemaVersion,
              revision: stored.revision!,
              validationDigest: "b".repeat(64),
            }
          : null,
    }),
    read: { settings: async () => structuredClone(stored) },
    engine: {
      reserve: async (ticket) => {
        if (ticket.metadata.kind !== "settings") throw new Error("wrong metadata");
        pending.set(ticket.id, { values: [], version: ticket.metadata.schemaVersion });
      },
      append: async (ticket, _offset, bytes) => {
        pending.get(ticket.id)!.values = JSON.parse(new TextDecoder().decode(bytes));
        return bytes.length;
      },
      seal: async () => {},
      publish,
      fence: () => [],
      fenceTarget: () => [],
      reconcile: publish,
      abort: async () => "aborted",
    },
    watch: { register: subscribe, changed, invalidate: vi.fn() },
  };
  return {
    deps,
    service: createSettingsService(deps),
    publish,
    changed,
    subscribe,
    setLive: (value: boolean) => {
      live = value;
    },
    setStored: (value: SettingsSnapshot | null) => {
      stored = value;
    },
  };
}
const signal = () => new AbortController().signal;
it("B2-12.1-1: defaults/null do not publish; simultaneous CAS commits once", async () => {
  const f = fixture();
  const initial = await f.service.request(
    principal,
    "settings/read",
    { schemaVersion: 1 },
    signal(),
  );
  expect(initial).toMatchObject({ ok: true, value: { revision: null } });
  expect(f.publish).not.toHaveBeenCalled();
  const result = await Promise.all(
    [false, true].map((value) =>
      f.service.request(
        principal,
        "settings/update",
        { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value }] },
        signal(),
      ),
    ),
  );
  expect(result.filter((x) => x.ok)).toHaveLength(1);
  expect(result.find((x) => !x.ok)).toMatchObject({
    error: { code: "PLUGIN_E_SETTINGS_CONFLICT" },
  });
  expect(f.publish).toHaveBeenCalledOnce();
  expect(f.changed).toHaveBeenCalledOnce();
});
it("B2-12.1-1: mixed enum types, duplicates, unknown keys and invalid values", async () => {
  const f = fixture();
  for (const changes of [
    [{ key: "enabled", value: 1 }],
    [{ key: "unknown", value: true }],
    [
      { key: "enabled", value: true },
      { key: "enabled", value: false },
    ],
    [{ key: "connection.mode", value: 2 }],
  ]) {
    expect(
      await f.service.request(
        principal,
        "settings/update",
        { schemaVersion: 1, expectedRevision: null, changes },
        signal(),
      ),
    ).toMatchObject({ ok: false });
  }
  const result = await f.service.request(
    principal,
    "settings/update",
    { schemaVersion: 1, expectedRevision: null, changes: [{ key: "connection.mode", value: "1" }] },
    signal(),
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      snapshot: {
        values: [
          { key: "connection.mode", value: "1" },
          { key: "enabled", value: true },
        ],
      },
    },
  });
});
it("B2-12.1-4: watch and commit share the namespace queue, with baseline sequence zero", async () => {
  const f = fixture();
  const watched = await f.service.request(
    principal,
    "settings/watch",
    { schemaVersion: 1 },
    signal(),
  );
  expect(watched).toMatchObject({ ok: true, value: { sequence: 0, snapshot: { revision: null } } });
  await f.service.request(
    principal,
    "settings/update",
    { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value: false }] },
    signal(),
  );
  expect(f.subscribe).toHaveBeenCalledBefore(f.changed);
  expect(f.changed.mock.calls[0]![1]).not.toHaveProperty("values");
});
it("B2-10 schema: disabled catalog never reads a resource; corrupt reads are not defaults", async () => {
  const f = fixture();
  const read = vi.spyOn(f.deps, "readResource");
  f.setLive(false);
  expect(
    await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal()),
  ).toMatchObject({ error: { code: "PLUGIN_E_DISABLED" } });
  expect(read).not.toHaveBeenCalled();
  f.setLive(true);
  f.deps.read.settings = async () => {
    throw settingsFailure("PLUGIN_E_SETTINGS_SCHEMA", "corrupt");
  };
  const result = await f.service.request(
    principal,
    "settings/read",
    { schemaVersion: 1 },
    signal(),
  );
  expect(result).toMatchObject({ error: { detail: { reason: "corrupt" } } });
  expect(JSON.stringify(result)).not.toContain("/private");
});
it("B2-10 unknown: reconcile the original ticket without publishing twice", async () => {
  const f = fixture();
  f.deps.engine.publish = vi.fn(async () => ({ disposition: "unknown" as const }));
  const first = await f.service.request(
    principal,
    "settings/update",
    { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value: false }] },
    signal(),
  );
  expect(first).toMatchObject({ error: { detail: { disposition: "unknown" } } });
  await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal());
  expect(f.deps.engine.publish).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledOnce();
  expect(f.changed).toHaveBeenCalledOnce();
});
it("B2-12.1-1: reset cannot overwrite a newer schema and migration is explicit", async () => {
  const f = fixture();
  f.setStored({ schemaVersion: 2, revision: `r_${"1".repeat(32)}`, values: [] });
  expect(
    await f.service.request(
      principal,
      "settings/reset",
      { schemaVersion: 1, expectedRevision: `r_${"1".repeat(32)}`, keys: ["enabled"] },
      signal(),
    ),
  ).toMatchObject({ error: { detail: { reason: "downgrade" } } });
  expect(f.publish).not.toHaveBeenCalled();
  f.setStored(null);
  expect(await f.service.request(principal, "settings/readMigration", {}, signal())).toMatchObject({
    error: { detail: { reason: "invalid-value" } },
  });
});
it("B2-12.1-1: validation digest drift blocks writes but display-only edits keep the digest", async () => {
  const f = fixture();
  const saved = await f.service.request(
    principal,
    "settings/update",
    { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value: false }] },
    signal(),
  );
  if (!saved.ok) throw new Error("save failed");
  f.deps.readResource = async () => ({
    resource: { ...resource, title: { en: "New title" } },
    digest: "c".repeat(64),
    validationDigest: "b".repeat(64),
  });
  expect(
    await f.service.request(principal, "settings/read", { schemaVersion: 1 }, signal()),
  ).toMatchObject({ ok: true });
  f.deps.readResource = async () => ({
    resource,
    digest: "d".repeat(64),
    validationDigest: "d".repeat(64),
  });
  expect(
    await f.service.request(
      principal,
      "settings/reset",
      { schemaVersion: 1, expectedRevision: saved.value.snapshot.revision, keys: ["enabled"] },
      signal(),
    ),
  ).toMatchObject({ error: { detail: { reason: "schema-changed-without-version" } } });
  expect(f.publish).toHaveBeenCalledOnce();
});
it("B2-12.1-4: a failed watch enqueue does not turn a committed receipt into save failure", async () => {
  const f = fixture();
  f.deps.watch.changed = () => {
    throw new Error("queue full");
  };
  expect(
    await f.service.request(
      principal,
      "settings/update",
      { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value: false }] },
      signal(),
    ),
  ).toMatchObject({ ok: true });
  expect(f.deps.watch.invalidate).toHaveBeenCalledWith(owner);
  expect(f.publish).toHaveBeenCalledOnce();
});

import type { StoredRecovery } from "./engine-port.js";
import type { PersistenceEvidencePort } from "./engine-port.js";
function evidenceDouble(overrides: Partial<PersistenceEvidencePort> = {}): PersistenceEvidencePort {
  let sequence = 0;
  const recovery = new Map<string, StoredRecovery>();
  return {
    capture: (scope, deadlineMonotonicMs) => ({
      id: crypto.randomUUID(),
      scope,
      through: sequence++,
      deadlineMonotonicMs,
    }),
    flush: async () => ({ state: "saved", accepted: [], incomplete: [], unknown: [] }),
    tickets: () => [],
    settingsDigest: async () => null,
    quota: async () => {
      throw new Error("Quota not exercised by this unit.");
    },
    auxiliary: async () => null,
    auxiliaryKeys: async () => ({ keys: [], nextCursor: null }),
    recoveryPage: async () => ({ items: [...recovery.values()], nextCursor: null }),
    loadRecovery: async (id) => recovery.get(id) ?? null,
    saveRecovery: async (value) => {
      recovery.set(value.id, structuredClone(value));
    },
    removeRecovery: async (id) => {
      recovery.delete(id);
    },
    ...overrides,
  };
}

import { createBoundSettingsService, settingsRequests } from "./settings-service.js";
import type { PersistenceBackend } from "./engine-port.js";
import type { PersistenceSourcePort } from "./host-port.js";
import type { CommonEventLedgerPort } from "@kobrixa/plugin-runtime";
function boundFixture() {
  const f = fixture();
  const scope = { hostEpoch: owner.hostEpoch, workbenchInstance: owner.processEpoch };
  let generation = 1,
    digest = "a".repeat(64);
  const sources: PersistenceSourcePort = {
    current: (candidate) =>
      candidate.generation === generation && candidate.processEpoch === owner.processEpoch,
    settings: vi.fn(async (input) =>
      input.resourceDigest === digest
        ? {
            owner: {
              sourceKey: owner.sourceKey,
              pluginId: owner.pluginId,
              uiResourceGeneration: generation,
            },
            resource,
            validationDigest: "b".repeat(64),
          }
        : null,
    ),
    coreOwner: (input) =>
      JSON.stringify(input.scope) === JSON.stringify(scope)
        ? { ...owner, generation, processEpoch: "00000000-0000-4000-8000-000000000099" }
        : null,
  };
  const subscriptions = new Set<string>();
  const events = {
    create: vi.fn(() => {
      const subscriptionId = crypto.randomUUID();
      subscriptions.add(subscriptionId);
      return { ok: true, value: { subscriptionId, sequence: 0 } };
    }),
    activate: vi.fn(),
    publish: vi.fn(() => ({ ok: true, value: { accepted: true } })),
    unsubscribe: vi.fn((_owner, id) => {
      subscriptions.delete(id);
      return { ok: true, value: { removed: true } };
    }),
    onRemoved: () => () => {},
    owns: (_owner: ResourceOwner, id: string) => subscriptions.has(id),
  } as unknown as CommonEventLedgerPort;
  const reads = { settings: vi.fn(f.deps.read.settings) } as unknown as PersistenceBackend["reads"];
  // Unused backend facets deliberately throw if a settings test crosses its boundary.
  const backend = {
    engine: f.deps.engine,
    evidence: f.deps.evidence,
    reads,
    get imports(): never {
      throw new Error("unused imports");
    },
    get output(): never {
      throw new Error("unused output");
    },
    get destinations(): never {
      throw new Error("unused destinations");
    },
    get sources(): never {
      throw new Error("unused sources");
    },
    dispose: vi.fn(async () => {}),
  } satisfies PersistenceBackend;
  const bound = createBoundSettingsService({ backend, sources, events, now: () => 0 });
  return {
    ...f,
    bound,
    backend,
    sources,
    events,
    scope,
    subscriptions,
    open: () => bound.open({ sourceKey: owner.sourceKey, scope, resourceDigest: digest }),
    changeGeneration: () => {
      generation++;
    },
    changeDigest: () => {
      digest = "c".repeat(64);
    },
  };
}
it("bound: no process needed; admission precedes disk read and public/core CAS is shared", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  expect(f.sources.settings).toHaveBeenCalledBefore(vi.mocked(f.backend.reads.settings));
  const results = await Promise.all([
    f.bound.update(binding, {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "enabled", value: false }],
    }),
    settingsRequests(f.backend).request(
      principal,
      "settings/update",
      { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value: true }] },
      signal(),
    ),
  ]);
  expect(results.filter((x) => x.ok)).toHaveLength(1);
  expect(f.publish).toHaveBeenCalledOnce();
  expect(await f.bound.read(binding)).toMatchObject({ ok: true });
});
it("bound: rejects forged scope, stale digest, and old-form disposal", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  await expect(
    f.bound.read({ ...binding, scope: { ...f.scope, workbenchInstance: crypto.randomUUID() } }),
  ).rejects.toThrow();
  f.changeDigest();
  await expect(f.bound.read(binding)).rejects.toThrow();
  const next = await f.open();
  f.bound.dispose(binding);
  expect(await f.bound.read(next.binding)).toMatchObject({ ok: true });
});
it("bound: queued and publishing writes recheck catalog generations", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  let release!: () => void;
  f.deps.engine.seal = vi.fn(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const first = f.bound.update(binding, {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "enabled", value: false }],
  });
  await vi.waitFor(() => expect(f.deps.engine.seal).toHaveBeenCalled());
  const second = f.bound.reset(binding, {
    schemaVersion: 1,
    expectedRevision: null,
    keys: ["enabled"],
  });
  f.changeGeneration();
  release();
  const results = await Promise.allSettled([first, second]);
  expect(results.every((x) => x.status === "rejected" || !x.value.ok)).toBe(true);
  expect(f.publish).not.toHaveBeenCalled();
});
it("bound: committed validation digest mismatch is rejected", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  await f.bound.update(binding, {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "enabled", value: false }],
  });
  f.backend.evidence.settingsDigest = async () => ({
    schemaVersion: 1,
    revision: `r_${"1".repeat(32)}`,
    validationDigest: "c".repeat(64),
  });
  expect(await f.bound.read(binding)).toMatchObject({
    error: { detail: { reason: "schema-changed-without-version" } },
  });
});
it("bound: shared ledger watches close with host disposal and cache access is guarded", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  const changed = vi.fn();
  const off = f.bound.watch(binding, changed);
  const off2 = f.bound.watch(binding, vi.fn());
  await f.bound.update(binding, {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "enabled", value: false }],
  });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(f.events.create).toHaveBeenCalledOnce();
  off();
  off();
  expect(f.subscriptions.size).toBe(1);
  off2();
  expect(f.subscriptions.size).toBe(0);
  await settingsRequests(f.backend).dispose();
  expect(() => settingsRequests(f.backend)).toThrow();
});
it("bound: public requests require catalog admission and recheck its digest before publish", async () => {
  const f = boundFixture();
  expect(
    await settingsRequests(f.backend).request(
      principal,
      "settings/read",
      { schemaVersion: 1 },
      signal(),
    ),
  ).toMatchObject({ ok: false });
  expect(f.backend.reads.settings).not.toHaveBeenCalled();
  await f.open();
  let release!: () => void;
  f.deps.engine.seal = vi.fn(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const write = settingsRequests(f.backend).request(
    principal,
    "settings/update",
    { schemaVersion: 1, expectedRevision: null, changes: [{ key: "enabled", value: false }] },
    signal(),
  );
  await vi.waitFor(() => expect(f.deps.engine.seal).toHaveBeenCalled());
  f.changeDigest();
  release();
  expect(await write).toMatchObject({ ok: false });
  expect(f.publish).not.toHaveBeenCalled();
});

import { validateSettingsResource } from "../../../../../../packages/plugin-protocol/src/persistence-validation.js";
import {
  validateSettingsValues,
  settingsValidationText,
} from "../../../../../../packages/plugin-protocol/src/settings.js";
it("T1 semantic fixtures: actual UTF-8 resource/value/string limits and forbidden segments", () => {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const validate = (value: SettingsResourceV1) => validateSettingsResource(value, bytes(value));
  const large: SettingsResourceV1 = {
    ...resource,
    fields: Array.from({ length: 128 }, (_, n) => ({
      key: `k${n}`,
      type: "boolean",
      label: { en: "Field" },
      default: false,
    })),
  };
  expect(validate(large).fields).toHaveLength(128);
  expect(() =>
    validate({ ...large, fields: [...large.fields, { ...large.fields[0]!, key: "extra" }] }),
  ).toThrow();
  for (const key of ["constructor.x", "x.prototype", "x.__proto__"])
    expect(() => validate({ ...resource, fields: [{ ...resource.fields[1]!, key }] })).toThrow();
  const padded = structuredClone(large);
  for (const field of padded.fields) field.help = { en: "" };
  let remaining = 65536 - bytes(padded);
  for (const field of padded.fields) {
    const count = Math.min(remaining, 2000);
    field.help!.en = "x".repeat(count);
    remaining -= count;
  }
  expect(bytes(padded)).toBe(65536);
  expect(validate(padded)).toBeDefined();
  padded.fields[127]!.help!.en += "x";
  expect(bytes(padded)).toBe(65537);
  expect(() => validate(padded)).toThrow();
  const strings: SettingsResourceV1 = {
    ...resource,
    fields: Array.from({ length: 16 }, (_, n) => ({
      key: `k${n}`,
      type: "string",
      label: { en: "Text" },
      default: "",
      minLength: 0,
      maxLength: 4000,
      maxBytes: 4096,
    })),
  };
  const values = strings.fields.map((f) => ({ key: f.key, value: "é".repeat(2048) }));
  const excess = bytes(values) - 65536;
  values[15]!.value = "a".repeat(4096 - excess);
  expect(bytes(values)).toBe(65536);
  expect(validateSettingsValues(strings, values, true)).toHaveLength(16);
  values[15]!.value += "a";
  expect(bytes(values)).toBe(65537);
  expect(() => validateSettingsValues(strings, values, true)).toThrow();
  expect(
    validateSettingsValues(strings, [{ key: "k0", value: "😀".repeat(1024) }], false),
  ).toHaveLength(1);
  expect(() =>
    validateSettingsValues(strings, [{ key: "k0", value: "😀".repeat(1024) + "a" }], false),
  ).toThrow();
  expect(settingsValidationText({ ...resource, title: { en: "Display only" } })).toBe(
    settingsValidationText(resource),
  );
  expect(
    settingsValidationText({
      ...resource,
      fields: [{ key: "enabled", type: "boolean", label: { en: "Enabled" }, default: false }],
    }),
  ).not.toBe(settingsValidationText(resource));
});

it("bound: watch validates a stale catalog before allocating a ledger slot", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  f.changeDigest();
  const off = f.bound.watch(binding, vi.fn());
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(f.events.create).not.toHaveBeenCalled();
  off();
});
it("settings scalar validation rejects NUL and accepts complete Unicode code points", async () => {
  const f = fixture();
  const text: SettingsResourceV1 = {
    schemaVersion: 1,
    title: { en: "Text" },
    fields: [
      {
        key: "text",
        type: "string",
        label: { en: "Text" },
        default: "",
        minLength: 0,
        maxLength: 4000,
        maxBytes: 4096,
      },
    ],
  };
  f.deps.readResource = async () => ({
    resource: text,
    digest: "a".repeat(64),
    validationDigest: "b".repeat(64),
  });
  expect(
    await f.service.request(
      principal,
      "settings/update",
      { schemaVersion: 1, expectedRevision: null, changes: [{ key: "text", value: "\0" }] },
      signal(),
    ),
  ).toMatchObject({ ok: false });
  expect(
    await f.service.request(
      principal,
      "settings/update",
      { schemaVersion: 1, expectedRevision: null, changes: [{ key: "text", value: "😀" }] },
      signal(),
    ),
  ).toMatchObject({ ok: true });
});

import { createContributedSettingsForm } from "../../../renderer/settings/contributed-settings-form.js";
it("same-binding remount keeps the newly opened real service alive", async () => {
  const f = boundFixture();
  const controls = { render: vi.fn(), dispose: vi.fn(), onChange: () => () => {} };
  const form = createContributedSettingsForm(controls, f.bound);
  const first = await f.open();
  form.open(first.binding, first.resource, first.snapshot);
  const next = await f.open();
  expect(() => form.open(next.binding, next.resource, next.snapshot)).not.toThrow();
  expect(await f.bound.read(next.binding)).toMatchObject({ ok: true });
  form.dispose(next.binding);
  await expect(f.bound.read(next.binding)).rejects.toThrow();
});
it("stale watch notifies a pristine form before disposing its service", async () => {
  const f = boundFixture();
  const opened = await f.open();
  const render = vi.fn();
  const form = createContributedSettingsForm(
    { render, dispose: vi.fn(), onChange: () => () => {} },
    f.bound,
  );
  f.changeDigest();
  form.open(opened.binding, opened.resource, opened.snapshot);
  await vi.waitFor(() => expect(render.mock.calls.at(-1)![2].errors.length).toBeGreaterThan(0));
  form.dispose(opened.binding);
});
it("local commit notifications survive public publication failure", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  const changed = vi.fn();
  f.bound.watch(binding, changed);
  await settingsRequests(f.backend).request(
    principal,
    "settings/watch",
    { schemaVersion: 1 },
    signal(),
  );
  vi.mocked(f.events.publish).mockImplementation(() => {
    throw new Error("queue failed");
  });
  expect(
    await f.bound.update(binding, {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "enabled", value: false }],
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  f.bound.dispose(binding);
});

it("throwing local observers neither silence peers nor invalidate public subscriptions", async () => {
  const f = boundFixture();
  const { binding } = await f.open();
  f.bound.watch(binding, () => {
    throw new Error("observer failed");
  });
  const changed = vi.fn();
  f.bound.watch(binding, changed);
  await settingsRequests(f.backend).request(
    principal,
    "settings/watch",
    { schemaVersion: 1 },
    signal(),
  );
  await f.bound.update(binding, {
    schemaVersion: 1,
    expectedRevision: null,
    changes: [{ key: "enabled", value: false }],
  });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(f.events.unsubscribe).not.toHaveBeenCalled();
  f.bound.dispose(binding);
});

it("bound: source retirement removes watches immediately and rejects stale calls before backend work", async () => {
  const f = boundFixture();
  const stale = (await f.open()).binding;
  f.bound.watch(stale, vi.fn());
  await vi.waitFor(() => expect(f.subscriptions.size).toBe(1));
  expect(
    await f.bound.update(stale, {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "enabled", value: false }],
    }),
  ).toMatchObject({ ok: true });
  settingsRequests(f.backend).retire(owner.sourceKey);
  expect(f.subscriptions.size).toBe(0);
  f.changeGeneration();
  const fresh = await f.open();
  expect(fresh.snapshot.values).toContainEqual({ key: "enabled", value: false });
  const reads = vi.mocked(f.backend.reads.settings);
  reads.mockClear();
  const reserve = vi.spyOn(f.backend.engine, "reserve");
  await expect(f.bound.read(stale)).rejects.toThrow("Stale");
  await expect(
    f.bound.update(stale, {
      schemaVersion: 1,
      expectedRevision: null,
      changes: [{ key: "enabled", value: false }],
    }),
  ).rejects.toThrow("Stale");
  expect(() => f.bound.watch(stale, vi.fn())).toThrow("Stale");
  expect(reads).not.toHaveBeenCalled();
  expect(reserve).not.toHaveBeenCalled();
  expect(await f.bound.read(fresh.binding)).toMatchObject({ ok: true });
  await settingsRequests(f.backend).dispose();
});
