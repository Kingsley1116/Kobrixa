import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { PluginController } from "../../apps/desktop/src/main/plugins/controller.js";
import type { Stage3BuiltinSource } from "@kobrixa/plugin-runtime";
import type { LifecycleCaseInput, CaseEvidence } from "./plugin-persistence-main.js";
import type { NativeActionControl } from "./plugin-persistence-action-replay.js";
import type { UserPersistenceActions } from "../../apps/desktop/src/main/plugins/user-persistence-actions.js";

// Heterogeneous, serialized observations of real ports, never substitute receipts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export const optionalKeys = [
  "builtin:acceptance.ui-recording",
  "builtin:acceptance.ui-settings",
  "builtin:kobrixa.device-ev3",
];
export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const clone = (v: unknown): Wire =>
  JSON.parse(
    JSON.stringify(v, (_k, x) =>
      x instanceof Uint8Array ? { base64: Buffer.from(x).toString("base64") } : x,
    ) ?? "null",
  );
const ok = (r: Wire) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.value;
};
const one = (rows: Wire[], label: string): Wire => {
  assert.equal(rows.length, 1, label);
  return rows[0]!;
};
const wait = async (condition: () => boolean | Promise<boolean>, label: string) => {
  const end = Date.now() + 15000;
  while (!(await condition())) {
    assert.ok(Date.now() < end, `Timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
export function optionalStartup(config: Wire, prototype: UserPersistenceActions) {
  assert.ok(["seed", "cold", "settings"].includes(config.optionalPhase));
  const started = Date.now();
  const events: Wire[] = [];
  const event = (kind: string, data: Wire = {}) =>
    events.push({ kind, wall: Date.now(), ...clone(data) });
  const mint = prototype.mint;
  prototype.mint = function (...args) {
    event("feature-mint", { args });
    return mint.apply(this, args);
  };
  return {
    started,
    events,
    event,
    restore() {
      prototype.mint = mint;
    },
    source(buildRoot: string, role: string): Stage3BuiltinSource {
      const root = path.join(buildRoot, "plugins", `acceptance-builtin-${role}`);
      const manifest = JSON.parse(readFileSync(path.join(root, "kobrixa-plugin.json"), "utf8"));
      const index = JSON.parse(readFileSync(path.join(root, "resource-index.json"), "utf8"));
      const sourceKey = `builtin:${manifest.id}`;
      event("metadata", {
        sourceKey,
        manifestSha256: sha(JSON.stringify(manifest)),
        indexSha256: sha(JSON.stringify(index)),
      });
      const resources: Record<string, string> = {};
      for (const file of index.files) {
        assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes(".."));
        if (!file.path.endsWith(".json")) continue;
        Object.defineProperty(resources, file.path, {
          enumerable: true,
          get() {
            event("resource", { sourceKey, file: file.path });
            const bytes = readFileSync(path.join(root, file.path));
            assert.equal(bytes.length, file.bytes);
            assert.equal(sha(bytes), file.sha256);
            return bytes.toString("utf8");
          },
        });
      }
      return {
        kind: "builtin",
        policy: "optional",
        manifest,
        resources,
        launch: {
          sourceKey,
          pluginId: manifest.id,
          policy: "optional",
          runtime: "node",
          packageRoot: root,
          entry: "main.cjs",
          manifest: "kobrixa-plugin.json",
          resourceIndex: "resource-index.json",
        },
      };
    },
    async finish(config: Wire) {
      const mapper = (await readFile(config.mapperLog, "utf8"))
        .trim()
        .split("\n")
        .map((s) => JSON.parse(s));
      return {
        started,
        ended: Date.now(),
        installed: [
          "resource",
          "launch",
          "connect",
          "reconnect",
          "provider",
          "feature-mint",
          "mapper",
        ],
        events: clone(events),
        mapper,
      };
    },
  };
}
export type OptionalStartup = ReturnType<typeof optionalStartup>;

type OptionalInput = {
  config: Wire;
  plugins: PluginController;
  input: LifecycleCaseInput;
  activateRecording(): Promise<void>;
  monitor: OptionalStartup;
  policy: Wire;
  scope(): Wire;
  browser(expression: string): Promise<unknown>;
  native: NativeActionControl;
  channels(): readonly { context: Wire; process: Wire }[];
  coreActions: object;
  runtime: object;
};
export async function produceOptionalOff(i: OptionalInput): Promise<CaseEvidence> {
  const { config, input, monitor } = i;
  const phase = config.optionalPhase;
  const p: Wire = {
    phase,
    runId: config.runId,
    profileId: config.profileId,
    profile: config.profile,
    hostEpoch: i.scope().hostEpoch,
    pid: process.pid,
    scope: i.scope(),
    policy: i.policy,
    started: monitor.started,
    calls: [],
    bridgeCalls: [],
    exits: [],
    disables: [],
    before: clone(i.plugins.state().plugins),
  };
  const bridgeCall = async (method: "snapshot" | "act", params: Wire): Promise<Wire> => {
    const start = Date.now();
    const result = await i.browser(
      `window.kobrixa.plugins.persistenceRecovery.${method}(${JSON.stringify(params)})`,
    );
    p.bridgeCalls.push({
      method,
      params: clone(params),
      result: clone(result),
      start,
      end: Date.now(),
    });
    return result as Wire;
  };
  const restores: (() => void)[] = [];
  const destinationIds = new WeakMap<object, number>();
  let nextDestination = 0;
  // Bound observers are installed before the first case action and forward exactly once.
  const observe = (target: object, key: string, kind: string) => {
    const object = target as Wire,
      original = object[key];
    assert.equal(typeof original, "function", `${kind}.${key}`);
    object[key] = function (...args: unknown[]) {
      const row: Wire = { kind, method: key, args: clone(args), start: Date.now() };
      if (kind === "output" && key === "begin")
        row.destination = destinationIds.get(args[2] as object);
      if (kind === "destination" && key === "release")
        row.destination = destinationIds.get(args[0] as object);
      p.calls.push(row);
      try {
        const result = original.apply(this, args);
        const done = (v: unknown) => {
          if (kind === "destination" && key === "register") {
            assert.ok(v && typeof v === "object");
            row.destination = ++nextDestination;
            destinationIds.set(v, row.destination);
          }
          row.result = clone(v);
          row.end = Date.now();
          return v;
        };
        const failed = (e: unknown) => {
          row.error = String(e);
          row.end = Date.now();
          throw e;
        };
        return result && typeof result.then === "function"
          ? result.then(done, failed)
          : done(result);
      } catch (e) {
        row.error = String(e);
        row.end = Date.now();
        throw e;
      }
    };
    restores.push(() => {
      object[key] = original;
    });
  };
  for (const key of ["begin", "append", "commit", "reconcile"])
    observe(input.backend.output, key, "output");
  for (const key of ["register", "release"])
    observe(input.backend.destinations, key, "destination");
  for (const key of ["stat", "open", "read", "close"]) observe(input.backend.reads, key, "reads");
  for (const key of ["mint", "claim", "complete"]) observe(i.coreActions, key, "core-action");
  observe(input.host.recovery, "export", "recovery");
  const original = input.host.request;
  input.host.request = async function (this: typeof input.host, ...args) {
    const [principal, method, params] = args;
    const row: Wire = { kind: "sdk", method, args: clone(args.slice(0, 3)), start: Date.now() };
    p.calls.push(row);
    if (method === "storage/commitWrite" && (params as Wire).drainToken)
      input.fault.arm("before-publish", "fail");
    const result = await original.apply(this, args);
    row.result = clone(result);
    row.end = Date.now();
    if (method === "storage/beginWrite" && principal.kind === "plugin" && result.ok) {
      const barrier = input.backend.evidence.capture(
        { kind: "namespace", owner: principal.owner },
        input.now() + 10000,
      );
      row.ticket = clone(
        one(
          [...input.backend.evidence.tickets(barrier)].filter(
            (t) => t.id === (result.value as Wire).write,
          ),
          "admitted original ticket",
        ),
      );
    }
    return result;
  } as typeof original;
  restores.push(() => {
    input.host.request = original;
  });
  observe(input.backend.evidence, "retainSealed", "evidence");
  observe(input.host.participant, "drain", "lifecycle");
  observe(i.runtime, "dispatchDrain", "runtime");
  try {
    if (phase === "settings") {
      const sourceKey = "builtin:acceptance.ui-settings";
      const resource = path.join(
        config.buildRoot,
        "plugins/acceptance-builtin-settings/settings.json",
      );
      // This separate admitted phase is allowed to read its schema; cold is not.
      monitor.event("resource", {
        sourceKey,
        file: "settings.json",
        purpose: "settings-open-digest",
      });
      const schemaData = await readFile(resource, "utf8");
      const opened = await input.host.settings.open({
        sourceKey,
        resourceDigest: sha(schemaData),
        scope: i.scope() as Parameters<typeof input.host.settings.open>[0]["scope"],
      });
      const before = await input.host.settings.read(opened.binding);
      const snapshot = ok(before);
      const enabled = one(
        snapshot.values.filter((v: Wire) => v.key === "fixture.enabled"),
        "admitted setting",
      );
      const changes = [{ key: "fixture.enabled", value: !enabled.value }];
      const update = await input.host.settings.update(opened.binding, {
        schemaVersion: 1,
        expectedRevision: snapshot.revision,
        changes,
      });
      ok(update);
      const after = await input.host.settings.read(opened.binding);
      p.settings = clone({
        schema: { path: resource, data: schemaData, sha256: sha(schemaData) },
        opened,
        before,
        changes,
        update,
        after,
      });
      input.host.settings.dispose(opened.binding);
    } else {
      if (phase === "seed") {
        await i.activateRecording();
        const result = await i.plugins.execute("acceptance.ui-recording.optional-off-seed");
        assert.equal(result.ok, true, JSON.stringify(result));
        const channel = one(
          [...i.channels()].filter((c) => c.context.owner.sourceKey === optionalKeys[0]),
          "original seed channel",
        );
        p.owner = clone(channel.context.owner);
        channel.process.onExit((exit: unknown) =>
          p.exits.push({ owner: clone(p.owner), exit: clone(exit), wall: Date.now() }),
        );
        observe(channel.context.peer, "request", "peer");
        for (const sourceKey of optionalKeys) {
          const start = Date.now();
          const result = await i.plugins.setEnabled(sourceKey, false);
          p.disables.push({ sourceKey, start, end: Date.now(), result: clone(result) });
        }
        await wait(
          () => p.exits.length === 1 && i.channels().length === 0,
          "original consumer retirement",
        );
        p.disabledAt = Date.now();
        p.persisted = JSON.parse(
          await readFile(path.join(config.profile, "plugins/state.json"), "utf8"),
        );
      }
      p.recovered = clone(await input.backend.evidence.recoveryPage());
      p.items = clone(input.host.recovery.snapshot().items);
      const item = one(
        p.items.filter((item: Wire) => item.sourceKey === optionalKeys[0]),
        "actual durable recovery item",
      );
      const facets = i.plugins.persistence170!;
      const entry = one([...facets.detail.entries()], "core recovery entry");
      facets.detail.openDetail(
        { itemId: entry.item.id },
        i.scope() as Parameters<typeof facets.detail.openDetail>[1],
      );
      let rendered: { text: string; visible: boolean } | null = null;
      await wait(async () => {
        rendered = (await i.browser(`(() => {
        const el = document.querySelector('.core-persistence-detail');
        if (!el) return null;
        el.scrollIntoView({block:'center'});
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        return {text: el.textContent, visible: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden'};
        })()`)) as { text: string; visible: boolean } | null;
        return !!rendered?.visible && rendered.text.includes("acceptance.ui-recording");
      }, "actual recovery UI");
      assert.ok(rendered);
      const dom = (rendered as { text: string }).text;
      const snapshot = await bridgeCall("snapshot", { itemId: entry.item.id });
      p.visible = clone({ entry, snapshot, dom, rendered });
      const actions = ok(snapshot).items.flatMap((item: Wire) => item.actions);
      const action = one(
        actions.filter((a: Wire) => a.kind === "export"),
        "trusted export option",
      );
      const file = path.join(config.profile, `optional-off-${phase}.bin`);
      i.native.phase = phase;
      const start = Date.now();
      const exporting = bridgeCall("act", { itemId: entry.item.id, optionId: action.id });
      await Promise.race([
        i.native.opened(),
        exporting.then((r) => {
          throw new Error(`Export did not open native destination: ${JSON.stringify(r)}`);
        }),
      ]);
      i.native.select(file);
      const result = await exporting;
      ok(result);
      const bytes = await readFile(file),
        stat = await lstat(file);
      p.export = {
        start,
        end: Date.now(),
        itemId: item.id,
        action,
        result: clone(result),
        dialogs: clone(i.native.dialogs),
        file: {
          path: file,
          data: bytes.toString("base64"),
          sha256: sha(bytes),
          identity: `${stat.dev}:${stat.ino}`,
          bytes: stat.size,
        },
      };
      p.trace = clone(input.fault.trace());
      if (phase === "cold") {
        const latest = ok(await bridgeCall("snapshot", { itemId: entry.item.id }));
        const discard = one(
          latest.items.flatMap((r: Wire) => r.actions).filter((a: Wire) => a.kind === "discard"),
          "cold cleanup discard",
        );
        p.discard = clone(await bridgeCall("act", { itemId: entry.item.id, optionId: discard.id }));
        ok(p.discard);
        p.remaining = clone(input.host.recovery.snapshot().items);
      }
    }
    p.after = clone(i.plugins.state().plugins);
    p.channels = clone(i.channels().map((c) => c.context.owner));
    p.observation = await monitor.finish(config);
    p.ended = Date.now();
    assertOptionalPhase(p);
    if (phase !== "cold")
      return { checks: {}, events: [], samples: {}, optionalPhase: p } as CaseEvidence;
    const seed = JSON.parse(await readFile(config.seedReceipt, "utf8"));
    const settings = JSON.parse(await readFile(config.settingsReceipt, "utf8"));
    const optionalOff = { seed, settings, cold: p };
    const evidence = { checks: optionalSummary(optionalOff), events: [], samples: {}, optionalOff };
    assertOptionalEvidence(evidence, p.hostEpoch);
    return evidence;
  } catch (error) {
    p.failure =
      error instanceof Error
        ? { name: error.name, message: error.message, stack: error.stack }
        : { message: String(error) };
    p.observedEvents = clone(monitor.events);
    p.trace = clone(input.fault.trace());
    throw new Error(`Optional-off ${phase} failed: ${p.failure.message}`, { cause: p });
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

const rows = (p: Wire, kind: string, method: string) =>
  p.calls.filter((r: Wire) => r.kind === kind && r.method === method);
const committed = (p: Wire) =>
  one(
    rows(p, "sdk", "storage/commitWrite").filter((r: Wire) => r.result.ok),
    "original SDK commit",
  ).result.value.record;
const recoveryRow = (p: Wire) => one(p.recovered.items ?? p.recovered, "stored recovery");
function inventory(p: Wire, field: string, admitted?: string) {
  const optional = p[field].filter((r: Wire) => !r.required);
  assert.deepEqual(optional.map((r: Wire) => r.sourceKey).sort(), [...optionalKeys].sort());
  for (const row of optional)
    assert.equal(row.status, row.sourceKey === admitted ? "enabled" : "disabled");
}
export function assertOptionalPhase(p: Wire) {
  assert.ok(
    p && ["seed", "cold", "settings"].includes(p.phase),
    "Missing actual optional-off phase",
  );
  assert.match(p.hostEpoch, /^[0-9a-f-]{36}$/);
  assert.ok(p.pid > 0);
  assert.ok(
    p.started <= p.policy.at &&
      p.policy.at <= p.policy.beforeCompose &&
      p.policy.beforeCompose <= p.ended,
  );
  assert.ok(path.isAbsolute(p.profile));
  assert.deepEqual(
    p.policy.disabled,
    p.phase === "seed"
      ? [optionalKeys[1]]
      : p.phase === "settings"
        ? [optionalKeys[0], optionalKeys[2]]
        : optionalKeys,
  );
  assert.equal(p.policy.path, path.join(p.profile, "plugins/state.json"));
  assert.equal(p.policy.sha256, sha(p.policy.data));
  assert.deepEqual(JSON.parse(p.policy.data).disabled.sort(), p.policy.disabled);
  assert.deepEqual(p.channels, []);
  const o = p.observation;
  assert.deepEqual(o.installed, [
    "resource",
    "launch",
    "connect",
    "reconnect",
    "provider",
    "feature-mint",
    "mapper",
  ]);
  const metadata = o.events.filter((e: Wire) => e.kind === "metadata");
  assert.deepEqual(metadata.map((e: Wire) => e.sourceKey).sort(), optionalKeys.slice(0, 2));
  for (const m of metadata) {
    assert.match(m.manifestSha256, /^[0-9a-f]{64}$/);
    assert.match(m.indexSha256, /^[0-9a-f]{64}$/);
    assert.ok(m.wall >= p.policy.at && m.wall <= p.policy.beforeCompose);
  }
  assert.equal(o.started, p.started);
  assert.ok(o.ended <= p.ended && o.ended >= p.policy.beforeCompose);
  assert.equal(o.mapper.length, 1, "Optional mapper executed or observation missing");
  assert.equal(o.mapper[0].kind, "installed");
  assert.equal(o.mapper[0].runId, p.runId);
  assert.equal(o.mapper[0].pid, p.pid);
  assert.ok(o.mapper[0].threadId > 0);
  assert.ok(o.mapper[0].wall >= p.started && o.mapper[0].wall <= o.ended);
  for (const e of o.events) assert.ok(e.wall >= p.started && e.wall <= o.ended);
  assert.equal(
    o.events.filter((e: Wire) => e.kind === "feature-mint" || e.kind === "failure").length,
    0,
  );
  if (p.phase !== "seed")
    for (const kind of ["launch", "connect", "reconnect", "provider"])
      assert.equal(o.events.filter((e: Wire) => e.kind === kind).length, 0, kind);
  inventory(p, "after", p.phase === "settings" ? optionalKeys[1] : undefined);
  if (p.phase === "settings") {
    inventory(p, "before", optionalKeys[1]);
    const s = p.settings,
      before = ok(s.before),
      after = ok(s.after);
    assert.equal(s.opened.binding.owner.sourceKey, optionalKeys[1]);
    assert.equal(s.opened.binding.scope.hostEpoch, p.hostEpoch);
    const changed = ok(s.update);
    assert.notEqual(before.revision, after.revision);
    assert.deepEqual(changed.snapshot, after);
    assert.equal(changed.receipt.revision, after.revision);
    assert.match(changed.receipt.commitId, /^[0-9a-f-]{36}$/);
    assert.ok(["file-and-directory-sync", "file-sync-only"].includes(changed.receipt.durability));
    assert.deepEqual(s.opened.snapshot, before);
    assert.deepEqual(s.opened.binding.scope, p.scope);
    assert.equal(s.schema.sha256, sha(s.schema.data));
    assert.equal(s.opened.binding.resourceDigest, s.schema.sha256);
    assert.equal(s.opened.resource.schemaVersion, before.schemaVersion);
    assert.ok(path.isAbsolute(s.schema.path));
    assert.deepEqual(s.changes, [
      {
        key: "fixture.enabled",
        value: !one(
          before.values.filter((r: Wire) => r.key === "fixture.enabled"),
          "before setting",
        ).value,
      },
    ]);
    assert.equal(
      one(
        after.values.filter((r: Wire) => r.key === "fixture.enabled"),
        "after setting",
      ).value,
      s.changes[0].value,
    );
    assert.ok(o.events.some((e: Wire) => e.kind === "resource" && e.sourceKey === optionalKeys[1]));
    return;
  }
  if (p.phase === "cold") {
    inventory(p, "before");
    assert.equal(o.events.filter((e: Wire) => e.kind === "resource").length, 0);
    assert.deepEqual(p.remaining, []);
    ok(p.discard);
  } else {
    const initial = p.before.filter((r: Wire) => !r.required);
    assert.deepEqual(initial.map((r: Wire) => r.sourceKey).sort(), optionalKeys);
    for (const r of initial)
      assert.equal(r.status, r.sourceKey === optionalKeys[1] ? "disabled" : "enabled");
    assert.equal(p.owner.hostEpoch, p.hostEpoch);
    assert.equal(p.owner.sourceKey, optionalKeys[0]);
    assert.equal(p.exits.length, 1);
    assert.deepEqual(p.exits[0].owner, p.owner);
    assert.ok(p.exits[0].wall <= p.disabledAt);
    assert.deepEqual(p.persisted.disabled.sort(), [...optionalKeys].sort());
    assert.deepEqual(
      p.disables.map((r: Wire) => r.sourceKey),
      optionalKeys,
    );
    for (const d of p.disables) {
      assert.equal(d.result.ok, true);
      assert.notEqual(d.result.persisted, false);
    }
    assert.equal(o.events.filter((e: Wire) => e.kind === "launch").length, 1);
    assert.deepEqual(o.events.find((e: Wire) => e.kind === "launch").owner, p.owner);
    assert.ok(Number.isInteger(p.exits[0].exit.code) || p.exits[0].exit.code === null);
    assert.ok(p.exits[0].exit.code !== null || typeof p.exits[0].exit.reason === "string");
    assert.ok(p.disables.every((r: Wire) => r.end <= p.disabledAt));
    assert.equal(
      o.events.filter(
        (e: Wire) =>
          ["launch", "resource", "connect", "reconnect", "feature-mint"].includes(e.kind) &&
          e.wall > p.disabledAt,
      ).length,
      0,
    );
    const original = committed(p);
    const creations = rows(p, "sdk", "storage/beginWrite");
    assert.equal(creations.length, 2);
    for (const begin of creations) {
      const t = begin.ticket;
      assert.equal(t.metadata.kind, "record");
      assert.equal(t.target.kind, "record");
      assert.deepEqual(t.owner, p.owner);
      assert.equal(ok(begin.result).write, t.id);
      assert.equal(t.target.id, t.metadata.record.id);
      for (const key of ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"])
        assert.equal(begin.args[2][key], t.metadata.record[key]);
      const chunk = one(
        rows(p, "sdk", "storage/writeChunk").filter((r: Wire) => r.args[2].write === t.id),
        "original whole chunk",
      );
      const bytes = Buffer.from(chunk.args[2].data, "base64");
      assert.equal(chunk.args[2].offset, 0);
      assert.equal(bytes.toString("base64"), chunk.args[2].data);
      assert.equal(ok(chunk.result).receivedBytes, bytes.length);
      assert.equal(bytes.length, t.metadata.record.byteLength);
      assert.equal(sha(bytes), t.metadata.record.sha256);
      const seal = one(
        rows(p, "sdk", "storage/sealWrite").filter((r: Wire) => r.args[2].write === t.id),
        "original seal",
      );
      assert.equal(ok(seal.result).state, "sealed");
      assert.ok(begin.end <= chunk.start && chunk.end <= seal.start);
    }
    for (const call of p.calls.filter((r: Wire) => r.kind === "sdk"))
      assert.deepEqual(call.args[0].owner, p.owner);
    const creation = one(
      creations.filter((r: Wire) => r.args[2].target.mode === "create"),
      "original creation",
    );
    assert.deepEqual(creation.ticket.metadata.record, original);
    const saved = one(
      rows(p, "sdk", "storage/commitWrite").filter((r: Wire) => r.result.ok),
      "original receipt",
    );
    assert.equal(saved.args[2].write, creation.ticket.id);
    assert.equal(saved.result.value.receipt.revision, original.revision);
    assert.match(saved.result.value.receipt.commitId, /^[0-9a-f-]{36}$/);
    assert.ok(
      ["file-and-directory-sync", "file-sync-only"].includes(saved.result.value.receipt.durability),
    );
    const finals = rows(p, "sdk", "storage/beginWrite").filter(
      (r: Wire) => r.args[2].target.mode === "replace",
    );
    const final = one(finals, "one actual final");
    assert.deepEqual(final.ticket.owner, p.owner);
    assert.notEqual(final.ticket.metadata.record.revision, original.revision);
    const registration = one(
      rows(p, "sdk", "storage/registerCheckpoint"),
      "actual checkpoint registration",
    );
    assert.equal(registration.args[2].id, original.id);
    assert.equal(registration.args[2].expectedRevision, original.revision);
    assert.equal(final.args[2].checkpoint.handle, ok(registration.result).checkpoint);
    assert.equal(final.args[2].checkpoint.phase, "final");
    assert.equal(final.args[2].target.id, original.id);
    assert.equal(final.args[2].target.expectedRevision, original.revision);
    assert.equal(final.ticket.target.expectedRevision, original.revision);
    const drain = one(
      rows(p, "peer", "request").filter((r: Wire) => r.args[0] === "storage/drain"),
      "original SDK drain",
    );
    assert.equal(final.args[2].drainToken, drain.args[1].token);
    assert.equal(drain.result.ok, true);
    assert.equal(drain.result.value.status, "submitted");
    assert.deepEqual(drain.result.value.writes, [final.ticket.id]);
    const lifecycle = one(
      rows(p, "lifecycle", "drain").filter(
        (r: Wire) => r.args[0].owner.sourceKey === optionalKeys[0],
      ),
      "real retirement drain",
    );
    assert.deepEqual(lifecycle.args[0].owner, p.owner);
    assert.equal(lifecycle.args[0].token, drain.args[1].token);
    assert.ok(lifecycle.result.blocker);
    assert.ok(
      lifecycle.result.records.some(
        (r: Wire) => r.id === original.id && r.payload === "complete-staging",
      ),
    );
    const failure = one(
      rows(p, "sdk", "storage/commitWrite").filter((r: Wire) => !r.result.ok),
      "failed final commit",
    );
    assert.equal(failure.args[2].write, final.ticket.id);
    assert.equal(failure.args[2].drainToken, drain.args[1].token);
    assert.equal(failure.result.error.code, "PLUGIN_E_STORAGE_IO");
    const retained = one(
      rows(p, "evidence", "retainSealed").filter((r: Wire) => r.args[0].id === final.ticket.id),
      "original retained pin",
    );
    assert.deepEqual(retained.args[0], final.ticket);
    const stored = recoveryRow(p);
    assert.equal(stored.ticket.id, final.ticket.id);
    assert.equal(stored.sealedPin, retained.result.pin);
    assert.deepEqual(stored.owner, p.owner);
    const originalSeal = one(
      rows(p, "sdk", "storage/sealWrite").filter((r: Wire) => r.args[2].write === final.ticket.id),
      "original final seal",
    );
    assert.ok(stored.expiresAt <= originalSeal.result.value.expiresAt + 5);
    assert.ok(
      p.export.end < stored.expiresAt && p.export.end < originalSeal.result.value.expiresAt,
      "Original sealed TTL must not expire or be renewed",
    );
    assert.ok(p.export.start >= p.disabledAt);
    assert.equal(
      p.trace.filter((t: Wire) => t.ticket === final.ticket.id && t.point === "before-publish")
        .length,
      1,
    );
    assert.equal(
      p.trace.filter((t: Wire) => t.ticket === final.ticket.id && t.point === "after-publish")
        .length,
      0,
    );
    assert.equal(
      p.trace.filter(
        (t: Wire) =>
          t.point === "after-publish" &&
          t.ticket ===
            one(
              rows(p, "sdk", "storage/beginWrite").filter(
                (r: Wire) => r.args[2].target.mode === "create",
              ),
              "checkpoint ticket",
            ).ticket.id,
      ).length,
      1,
    );
  }
  assert.equal(p.recovered.nextCursor, null);
  const stored = recoveryRow(p),
    item = one(p.items, "core item");
  assert.equal(item.id, stored.id);
  assert.equal(item.sourceKey, optionalKeys[0]);
  const record = one(stored.report.records, "recovery record");
  assert.equal(item.recordId, record.id);
  assert.equal(item.committedRevision, record.committedRevision);
  assert.equal(item.payload, p.phase === "seed" ? "complete-staging" : "checkpoint-only");
  if (p.phase === "cold") {
    assert.equal(stored.sealedPin, null);
    assert.equal(stored.ticket, null);
  }
  const detail = ok(p.visible.snapshot);
  assert.ok(detail.items.some((r: Wire) => r.pluginId === "acceptance.ui-recording"));
  assert.ok(p.visible.dom.includes("acceptance.ui-recording"));
  assert.equal(p.visible.rendered.visible, true);
  assert.equal(p.visible.rendered.text, p.visible.dom);
  const ex = p.export,
    file = ex.file;
  const bridgeExport = one(
    p.bridgeCalls.filter((r: Wire) => r.method === "act" && r.params.optionId === ex.action.id),
    "current renderer IPC export",
  );
  assert.deepEqual(bridgeExport.params, {
    itemId: p.visible.entry.item.id,
    optionId: ex.action.id,
  });
  assert.deepEqual(bridgeExport.result, ex.result);
  assert.ok(
    p.bridgeCalls.some(
      (r: Wire) => r.method === "snapshot" && r.params.itemId === p.visible.entry.item.id,
    ),
  );
  assert.equal(ex.itemId, stored.id);
  assert.equal(ex.action.kind, "export");
  assert.ok(path.isAbsolute(file.path));
  assert.match(file.identity, /^\d+:\d+$/);
  assert.equal(file.bytes, Buffer.from(file.data, "base64").length);
  assert.equal(file.sha256, sha(Buffer.from(file.data, "base64")));
  assert.equal(one(ex.dialogs, "native dialog").selected, file.path);
  const begin = one(rows(p, "output", "begin"), "native output begin"),
    commit = one(rows(p, "output", "commit"), "native output commit");
  assert.equal(begin.args[1].hostEpoch, p.hostEpoch);
  assert.equal(begin.args[1].sourceKey, optionalKeys[0]);
  assert.equal(begin.args[1].pluginId, stored.owner.pluginId);
  assert.match(begin.args[1].processEpoch, /^[0-9a-f-]{36}$/);
  assert.notEqual(begin.args[1].processEpoch, stored.owner.processEpoch);
  assert.ok(Number.isSafeInteger(begin.args[1].generation) && begin.args[1].generation >= 0);
  assert.equal(begin.args[3], file.bytes);
  assert.equal(begin.args[4], file.sha256);
  assert.equal(begin.args[0], commit.args[0]);
  assert.equal(commit.result.disposition, "committed");
  const append = one(rows(p, "output", "append"), "native output bytes");
  assert.equal(append.args[0], begin.args[0]);
  assert.equal(append.args[1], 0);
  assert.equal(append.args[2].base64, file.data);
  const exported = one(rows(p, "recovery", "export"), "actual core export");
  assert.equal(exported.args[0].recovery, stored.id);
  assert.equal(ok(exported.result).disposition, "committed");
  const action = exported.args[0].action;
  assert.deepEqual(action.scope, p.scope);
  const mint = one(
    rows(p, "core-action", "mint").filter((r: Wire) => r.result.actionToken === action.actionToken),
    "trusted core mint",
  );
  assert.deepEqual(mint.args, [p.scope, { kind: "persistence-export", recovery: stored.id }]);
  const claim = one(
    rows(p, "core-action", "claim").filter(
      (r: Wire) => r.args[0].actionToken === action.actionToken,
    ),
    "trusted core claim",
  );
  assert.equal(claim.result, true);
  assert.deepEqual(claim.args[1], mint.args[1]);
  assert.ok(
    rows(p, "core-action", "complete").some(
      (r: Wire) => r.args[0].actionToken === action.actionToken,
    ),
  );
  const destination = one(rows(p, "destination", "register"), "actual native registration");
  assert.equal(destination.args[0].action, action.actionToken);
  assert.deepEqual(destination.args[0].scope, p.scope);
  assert.equal(destination.args[0].nativePath, file.path);
  const released = one(rows(p, "destination", "release"), "native destination release");
  assert.ok(Number.isInteger(destination.destination) && destination.destination > 0);
  assert.equal(begin.destination, destination.destination);
  assert.equal(released.destination, destination.destination);
  const read = one(
    rows(p, "reads", "read").filter(
      (r: Wire) => r.start >= exported.start && r.end <= exported.end,
    ),
    "core payload read",
  );
  assert.equal(read.result.base64, file.data);
  if (p.phase === "seed") {
    assert.deepEqual(read.args[0], stored.owner);
    assert.equal(read.args[1], stored.sealedPin);
  } else {
    const opened = one(rows(p, "reads", "open"), "fresh committed pin");
    assert.deepEqual(opened.args, [begin.args[1], record.id, record.committedRevision]);
    assert.equal(read.args[1], opened.result);
    assert.deepEqual(read.args[0], begin.args[1]);
    const stat = one(rows(p, "reads", "stat"), "real committed metadata");
    assert.equal(stat.result.sha256, file.sha256);
    assert.equal(stat.result.revision, record.committedRevision);
  }
  assert.ok(ex.start <= exported.start && exported.end <= ex.end);
  assert.ok(begin.end <= append.start && append.end <= commit.start && commit.end <= exported.end);
  assert.match(commit.result.commitId, /^[0-9a-f-]{36}$/);
  assert.ok(["file-and-directory-sync", "file-sync-only"].includes(commit.result.durability));
}
export function optionalSummary(o: Wire) {
  const p = o.cold,
    s = o.seed.evidence.optionalPhase,
    settings = o.settings.evidence.optionalPhase;
  const events = p.observation.events;
  return {
    optionalProcesses: events.filter((r: Wire) => r.kind === "launch").length,
    optionalSchemaReads: events.filter((r: Wire) => r.kind === "resource").length,
    mapperCalls: p.observation.mapper.filter((r: Wire) => r.kind === "map").length,
    autoConnects: events.filter((r: Wire) => r.kind === "connect" || r.kind === "reconnect").length,
    featureActionRefsMinted: events.filter((r: Wire) => r.kind === "feature-mint").length,
    coreRecoveryVisible:
      p.visible.dom.includes("acceptance.ui-recording") &&
      s.visible.dom.includes("acceptance.ui-recording"),
    coreExportSucceeded: [p, s].every(
      (x) => rows(x, "output", "commit")[0]?.result.disposition === "committed",
    ),
    noProcessSettings:
      settings.observation.events.filter((e: Wire) => e.kind === "launch").length === 0 &&
      settings.settings.update.ok,
    durableRecoveryRestored: recoveryRow(s).id === recoveryRow(p).id,
    committedExportHash: p.export.file.sha256 === committed(s).sha256,
    sealedExportHash: s.export.file.sha256 === recoveryRow(s).ticket.metadata.record.sha256,
  };
}
export function assertOptionalPhaseReceipt(r: Wire, expected: Wire = {}) {
  const p = r.evidence?.optionalPhase;
  assertOptionalPhase(p);
  assert.ok(["seed", "settings"].includes(p.phase));
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(r[key], value, `stale phase: ${key}`);
  for (const key of ["hostEpoch", "pid", "runId", "profileId"]) assert.equal(r[key], p[key]);
  assert.equal(r.case, "all-optional-off");
  assert.equal(r.level, "real-process");
  assert.equal(r.status, p.phase === "seed" ? "retained-exit" : "passed-phase");
  assert.equal(r.exitCode, 0);
  assert.equal(r.signal, null);
  const settledAt = p.phase === "seed" ? r.retainedAt : r.closedAt;
  if (p.phase === "seed") assert.equal(r.closedAt, undefined, "Retained seed is not a clean close");
  assert.ok(settledAt >= p.ended && settledAt <= r.exitedAt && r.exitedAt <= r.reportedAt);
  assert.equal(r.cleanup.children, 0);
  assert.deepEqual(r.cleanup.errors, []);
  assert.deepEqual(
    r.workerTrace,
    p.phase === "seed"
      ? [{ kind: "start", count: 1, pid: r.pid }]
      : [
          { kind: "start", count: 1, pid: r.pid },
          { kind: "exit", count: 0, pid: r.pid },
        ],
  );
  assert.equal(r.cleanup.workers, p.phase === "seed" ? 1 : 0);
  assert.equal(r.cleanup.listeners, p.phase === "seed" ? 1 : 0);
}
export function assertOptionalEvidence(e: Wire, hostEpoch: string) {
  const o = e.optionalOff;
  assert.ok(o, "Missing optional-off raw phases");
  assertOptionalPhaseReceipt(o.seed);
  assertOptionalPhaseReceipt(o.settings);
  assertOptionalPhase(o.cold);
  const seed = o.seed.evidence.optionalPhase,
    settings = o.settings.evidence.optionalPhase,
    cold = o.cold;
  assert.equal(seed.phase, "seed");
  assert.equal(settings.phase, "settings");
  assert.equal(cold.phase, "cold");
  assert.equal(cold.hostEpoch, hostEpoch);
  assert.equal(new Set([seed.hostEpoch, settings.hostEpoch, cold.hostEpoch]).size, 3);
  assert.equal(new Set([seed.pid, settings.pid, cold.pid]).size, 3);
  const manifests = (p: Wire) =>
    p.observation.events
      .filter((e: Wire) => e.kind === "metadata")
      .map((e: Wire) => [e.sourceKey, e.manifestSha256, e.indexSha256]);
  assert.deepEqual(manifests(seed), manifests(cold));
  assert.deepEqual(manifests(seed), manifests(settings));
  assert.equal(new Set([seed.runId, settings.runId, cold.runId]).size, 3);
  assert.equal(seed.profile, cold.profile);
  assert.equal(seed.profileId, cold.profileId);
  assert.notEqual(settings.profile, cold.profile);
  assert.notEqual(settings.profileId, cold.profileId);
  assert.ok(o.seed.exitedAt <= cold.started && o.settings.exitedAt <= seed.started);
  assert.equal(recoveryRow(seed).id, recoveryRow(cold).id);
  assert.deepEqual(recoveryRow(seed).owner, recoveryRow(cold).owner);
  const record = committed(seed),
    restored = one(recoveryRow(cold).report.records, "restored predecessor");
  assert.equal(restored.id, record.id);
  assert.equal(restored.committedRevision, record.revision);
  assert.equal(cold.export.file.sha256, record.sha256);
  assert.equal(seed.export.file.sha256, recoveryRow(seed).ticket.metadata.record.sha256);
  assert.notEqual(seed.export.file.sha256, cold.export.file.sha256);
  assert.deepEqual(e.checks, optionalSummary(o));
  assert.deepEqual(e.events, []);
  assert.deepEqual(e.samples, {});
}
