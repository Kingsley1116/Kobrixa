import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as producer from "./device-ui-stdio-run.mjs";
import { documents, hash, ownerId, verifyDeviceStdio } from "./device-ui-stdio-run.mjs";
// UNIT ONLY. These fabricated receipts test rejection rules, never produce native evidence.
function fixture() {
  let n = 0;
  const owners = Object.fromEntries(
    ["owner", "denied"].map((role, i) => [
      role,
      {
        pluginId: ownerId + (i ? "-denied" : ""),
        sourceKey: "dev:" + String(i).repeat(16),
        generation: 0,
        hostEpoch: "host",
        processEpoch: "process" + i,
      },
    ]),
  );
  const binding = { sourceKey: "dev:" + "0".repeat(16), kind: "panel", panelInstance: "panel" };
  const r = {
    claim: "synthetic-device-python-stdio",
    stage: "complete",
    failures: [],
    wire: [],
    launches: Object.entries(owners).map(([role, owner], i) => ({
      role,
      owner,
      pid: 100 + i,
      parentPid: 50,
    })),
    exits: Object.values(owners).map((owner) => ({ owner, exit: { code: 0 } })),
    checkpoints: {
      binding,
      deniedBefore: [{ step: "connect" }],
      deniedAfter: [{ step: "connect" }],
      processes: {
        parentPid: 50,
        rows: [
          { pid: 100, ppid: 50 },
          { pid: 101, ppid: 50 },
        ],
      },
      providerTrace: [
        { step: "connect", operationId: "connect-1", dispatch: "not-sent", time: 1 },
        { step: "connect", operationId: "connect-1", dispatch: "sent", time: 2 },
        { step: "read" },
        { step: "mode-write" },
      ],
    },
    cleanup: { bridge: { pending: 0 }, worker: { jobs: 0 }, workers: 0 },
  };
  function pair(role, method, params, result, raw = false, direction = "plugin-host") {
    const id = ++n,
      owner = owners[role];
    const q = { owner, direction, sequence: n, message: { jsonrpc: "2.0", id, method, params } };
    r.wire.push(q);
    r.wire.push({
      owner,
      direction: direction === "plugin-host" ? "host-plugin" : "plugin-host",
      sequence: ++n,
      message: { jsonrpc: "2.0", id, result: raw ? result : { ok: true, value: result } },
    });
    return q;
  }
  const ok = (m, p, v) => pair("owner", m, p, v),
    bad = (role, m, p, code) => pair(role, m, p, { ok: false, error: { code } }, true);
  for (const role of ["owner", "denied"])
    pair(role, "initialize", {}, { apiVersion: "1.8.0" }, true, "host-plugin");
  pair("owner", "ui/negotiate", {}, { uiResourceVersions: [1, 2] }, false, "host-plugin");
  ok(
    "devices/discover",
    { providerId: "kobrixa.device-ev3" },
    { candidates: [{ candidateId: "candidate" }] },
  );
  ok(
    "devices/connect",
    { target: { kind: "candidate", candidateId: "candidate" } },
    { session: { sessionId: "session", state: "connected" } },
  );
  ok(
    "devices/session",
    { sessionId: "session" },
    {
      sources: {
        sessionId: "session",
        sourceRevision: 1,
        channels: [{ channelId: "channel", portId: "1" }],
      },
    },
  );
  ok(
    "devices/read",
    { sessionId: "session", channelIds: ["channel"], freshness: "fresh" },
    { status: "fresh", frame: { values: [{ value: 42 }] } },
  );
  ok(
    "devices/inputModes/query",
    { expectedSourceRevision: 1 },
    { portId: "1", modes: [{ modeId: "0", name: "Reflect" }] },
  );
  bad(
    "owner",
    "devices/inputModes/query",
    { expectedSourceRevision: 2 },
    "PLUGIN_E_STALE_RESOURCE",
  );
  bad("owner", "devices/session", {}, "PLUGIN_E_STALE_RESOURCE");
  ok("devices/context", {}, { contextRef: "context" });
  ok(
    "devices/inputModes/set",
    {
      sessionId: "session",
      portId: "1",
      expectedSourceRevision: 1,
      modeId: "0",
      contextRef: "context",
    },
    { sources: { sessionId: "session", sourceRevision: 2 } },
  );

  bad("denied", "devices/connect", {}, "PLUGIN_E_PERMISSION_DENIED");
  bad("denied", "settings/update", {}, "PLUGIN_E_PERMISSION_DENIED");
  const snap = (revision, value) => ({
      schemaVersion: 1,
      revision,
      values: [{ key: "enabled", value }],
    }),
    initial = snap(null, false);
  const mutation = (revision, value) => ({
    snapshot: snap(revision, value),
    receipt: { revision, commitId: "commit-" + revision, durability: "file-and-directory-sync" },
  });
  ok("settings/read", { schemaVersion: 1 }, initial);
  ok("settings/watch", { schemaVersion: 1 }, { subscriptionId: "watch", snapshot: initial });
  ok("settings/update", { expectedRevision: null }, mutation("one", true));
  bad("owner", "settings/update", { expectedRevision: null }, "PLUGIN_E_SETTINGS_CONFLICT");
  const event = (revision) => {
    r.wire.push({
      owner: owners.owner,
      direction: "host-plugin",
      sequence: ++n,
      message: {
        method: "events/deliver",
        params: {
          subscriptionId: "watch",
          sequence: n,
          kind: "settings.changed",
          data: { revision },
        },
      },
    });
    ok("events/ack", { subscriptionId: "watch", sequence: n }, {});
  };
  event("one");
  ok("settings/reset", { expectedRevision: "one", keys: ["enabled"] }, mutation("two", false));
  event("two");
  ok("events/unsubscribe", { subscriptionId: "watch" }, { removed: true });
  ok("settings/update", { expectedRevision: "two" }, mutation("three", true));
  ok("settings/read", { schemaVersion: 1 }, snap("three", true));
  for (let i = 1; i <= 2; i++) {
    const rows = [
        { key: "candidate", version: String(i), cells: ["candidate"] },
        { key: "mode:0", version: String(i), cells: ["Reflect"] },
      ],
      header = { kind: "table" },
      bytes = Buffer.from(JSON.stringify([header, rows])),
      sha256 = hash(bytes),
      address = { binding, dataset: "rows" },
      transfer = "transfer" + i;
    ok(
      "ui/dataBegin",
      {
        ...address,
        header,
        baseRevision: i - 1,
        presentation: i,
        entryCount: 2,
        byteLength: bytes.length,
        sha256,
      },
      { transfer },
    );
    ok(
      "ui/dataChunk",
      { ...address, transfer, offset: 0, chunk: { kind: "table", entries: rows } },
      { nextOffset: 2 },
    );
    ok("ui/dataCommit", { ...address, transfer }, { revision: i, sha256 });
    ok(
      "ui/dataRead",
      { ...address, revision: i },
      { chunk: { entries: rows }, sha256, nextOffset: 2, done: true },
    );
  }
  bad("owner", "ui/dataRead", { revision: 1 }, "PLUGIN_E_STALE_RESOURCE");
  const id = ++n;
  r.wire.push({
    owner: owners.owner,
    direction: "plugin-host",
    sequence: n,
    message: { id, method: "devices/read", params: { sessionId: "session" } },
  });
  r.checkpoints.cancel = { owner: owners.owner, requestId: id, reachedAt: n + 0.5 };
  r.wire.push({
    owner: owners.owner,
    direction: "plugin-host",
    sequence: ++n,
    message: { method: "$/cancelRequest", params: { id } },
  });
  r.wire.push({
    owner: owners.owner,
    direction: "host-plugin",
    sequence: ++n,
    message: { id, error: { code: -32800 } },
  });
  for (const row of r.wire) row.at = row.sequence;
  return r;
}
const req = (r, m, index = 0) => r.wire.filter((w) => w.message.method === m)[index];
const reply = (r, m, index = 0) => {
  const q = req(r, m, index);
  return r.wire.find(
    (w) => w.sequence > q.sequence && w.message.id === q.message.id && !w.message.method,
  );
};
test("own synthetic namespace/resources, no builtin provider impersonation", () => {
  for (const role of ["owner", "denied"]) {
    const d = documents(role);
    assert.match(d.manifest.id, /^acceptance\.device-stdio/);
    assert.equal(d.manifest.runtime.kind, "python");
    assert.equal(d.manifest.contributes.deviceProviders, undefined);
    assert.deepEqual(d.settings.fields, [
      { key: "enabled", type: "boolean", default: false, label: { en: "Enabled" } },
    ]);
  }
});
test("coherent UNIT-only receipt passes", () =>
  assert.equal(verifyDeviceStdio(fixture()).datasetRevision, 2));
for (const [name, mutate] of [
  [
    "orphan response",
    (r) =>
      r.wire.push({
        owner: r.launches[0].owner,
        direction: "host-plugin",
        sequence: 10000,
        message: { id: 9999, result: { ok: true, value: {} } },
      }),
  ],
  [
    "duplicate response",
    (r) => {
      const copy = structuredClone(reply(r, "devices/read"));
      copy.sequence = 10000;
      r.wire.push(copy);
    },
  ],
  ["no Python PID", (r) => delete r.launches[0].pid],
  ["PID not an OS child", (r) => (r.checkpoints.processes.rows[0].ppid = 99)],
  ["reused PID", (r) => (r.launches[1].pid = 100)],
  ["builtin impersonation", (r) => (r.launches[0].owner.sourceKey = "builtin:kobrixa.device-ev3")],
  ["nonzero Python exit", (r) => (r.exits[0].exit.code = 1)],
  ["missing owner exit", (r) => r.exits.pop()],
  ["foreign correlated response", (r) => (reply(r, "devices/connect").owner = r.launches[1].owner)],
  ["missing read response", (r) => r.wire.splice(r.wire.indexOf(reply(r, "devices/read")), 1)],
  [
    "wrong candidate",
    (r) => (req(r, "devices/connect").message.params.target.candidateId = "other"),
  ],
  [
    "fabricated sample",
    (r) => (reply(r, "devices/read").message.result.value.frame.values[0].value = 0),
  ],
  [
    "stale mode revision actually current",
    (r) => (req(r, "devices/inputModes/query", 1).message.params.expectedSourceRevision = 1),
  ],
  ["permission allowed", (r) => (reply(r, "devices/connect", 1).message.result.ok = true)],
  ["missing conflict", (r) => (reply(r, "settings/update", 2).message.result.ok = true)],
  [
    "CAS did not use original revision",
    (r) => (req(r, "settings/reset").message.params.expectedRevision = "other"),
  ],
  [
    "wrong receipt revision",
    (r) => (reply(r, "settings/reset").message.result.value.receipt.revision = "other"),
  ],
  [
    "missing settings event",
    (r) => (r.wire = r.wire.filter((w) => w.message.method !== "events/deliver")),
  ],
  [
    "unwatch not removed",
    (r) => (reply(r, "events/unsubscribe").message.result.value.removed = false),
  ],
  ["dataset hash mismatch", (r) => (req(r, "ui/dataBegin").message.params.sha256 = "0".repeat(64))],
  [
    "row identity changed",
    (r) => (req(r, "ui/dataChunk", 1).message.params.chunk.entries[0].key = "other"),
  ],
  ["stale dataset accepted", (r) => (reply(r, "ui/dataRead", 2).message.result.ok = true)],
  [
    "missing cancellation",
    (r) => (r.wire = r.wire.filter((w) => w.message.method !== "$/cancelRequest")),
  ],
  [
    "cancelled read succeeded",
    (r) => {
      const p = reply(r, "devices/read", 1);
      delete p.message.error;
      p.message.result = { ok: true, value: {} };
    },
  ],
  ["missing provider dispatch evidence", (r) => (r.checkpoints.providerTrace = [])],
  [
    "mode write forged context",
    (r) => (req(r, "devices/inputModes/set").message.params.contextRef = "other"),
  ],
  [
    "mode write did not advance sources",
    (r) => (reply(r, "devices/inputModes/set").message.result.value.sources.sourceRevision = 1),
  ],
  ["denied consumer dispatched", (r) => r.checkpoints.deniedAfter.push({ step: "connect" })],
  ["worker leak", (r) => (r.cleanup.workers = 1)],
  ["reported failure", (r) => r.failures.push("broken")],
])
  test(name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => verifyDeviceStdio(r));
  });

for (const [name, mutate] of [
  [
    "extra connect operation",
    (r) =>
      r.checkpoints.providerTrace.push({
        step: "connect",
        operationId: "extra",
        dispatch: "sent",
        time: 3,
      }),
  ],
  ["unpaired connect", (r) => r.checkpoints.providerTrace.shift()],
  ["different connect operation", (r) => (r.checkpoints.providerTrace[1].operationId = "other")],
  ["reversed connect dispatch", (r) => r.checkpoints.providerTrace.reverse()],
  ["negative barrier time", (r) => (r.checkpoints.cancel.reachedAt = -1)],
  [
    "barrier before request",
    (r) => (r.checkpoints.cancel.reachedAt = req(r, "devices/read", 1).at - 1),
  ],
  [
    "barrier after cancel",
    (r) => (r.checkpoints.cancel.reachedAt = req(r, "$/cancelRequest").at + 1),
  ],
  [
    "reply before cancel",
    (r) => (reply(r, "devices/read", 1).at = req(r, "$/cancelRequest").at - 1),
  ],
  ["foreign cancel owner", (r) => (req(r, "$/cancelRequest").owner = r.launches[1].owner)],
])
  test("rejects " + name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => verifyDeviceStdio(r));
  });
test("monitor skips overlapping ticks and stops without queued polls", async () => {
  let calls = 0,
    resolvePoll;
  const seen = [],
    errors = [];
  const m = producer.createProcessMonitor({
    poll: () => {
      calls++;
      return new Promise((r) => (resolvePoll = r));
    },
    observe: (r) => seen.push(r),
    onError: (e) => errors.push(e),
    intervalMs: 100000,
    timeoutMs: 1000,
  });
  m.tick();
  for (let i = 0; i < 100; i++) m.tick();
  await Promise.resolve();
  assert.equal(calls, 1);
  resolvePoll([1]);
  await m.stop();
  m.tick();
  assert.equal(calls, 1);
  assert.deepEqual(seen, [[1]]);
  assert.deepEqual(errors, []);
});
test("hung monitor stop is bounded and late result is ignored", async () => {
  let resolvePoll;
  const seen = [],
    errors = [];
  const m = producer.createProcessMonitor({
    poll: () => new Promise((r) => (resolvePoll = r)),
    observe: (r) => seen.push(r),
    onError: (e) => errors.push(e),
    intervalMs: 100000,
    timeoutMs: 10,
  });
  m.tick();
  await m.stop();
  assert.equal(errors.length, 1);
  resolvePoll([1]);
  await Promise.resolve();
  assert.deepEqual(seen, []);
});
test("rejected monitor and final observation reach real cleanup helper", async () => {
  const errors = [],
    killed = [];
  const m = producer.createProcessMonitor({
    poll: () => Promise.reject(new Error("ps failed")),
    observe: () => assert.fail(),
    onError: (e) => errors.push(e),
    intervalMs: 100000,
    timeoutMs: 10,
  });
  m.tick();
  await m.stop();
  assert.equal(errors.length, 1);
  const survivors = await producer.finishProcessObservation({
    poll: () => Promise.reject(new Error("final failed")),
    parent: 50,
    known: new Set([50, 100]),
    onError: (e) => errors.push(e),
    kill: (pid, signal) => killed.push([pid, signal]),
    timeoutMs: 10,
  });
  assert.deepEqual(killed, [
    [50, "SIGKILL"],
    [100, "SIGKILL"],
  ]);
  assert.deepEqual(survivors, [{ pid: 50 }, { pid: 100 }]);
  assert.equal(errors.length, 2);
});
test("hung final observation is bounded and still cleans owned PIDs", async () => {
  const errors = [],
    killed = [];
  await producer.finishProcessObservation({
    poll: () => new Promise(() => {}),
    parent: 50,
    known: new Set([50, 100]),
    onError: (e) => errors.push(e),
    kill: (pid) => killed.push(pid),
    timeoutMs: 10,
  });
  assert.deepEqual(killed, [50, 100]);
  assert.equal(errors.length, 1);
});
test("final observation cleans only surviving observed children and retains kill errors", async () => {
  const errors = [],
    killed = [];
  const survivors = await producer.finishProcessObservation({
    poll: async () => [
      { pid: 100, ppid: 50, pgid: 50 },
      { pid: 999, ppid: 1, pgid: 999 },
    ],
    parent: 50,
    known: new Set([50, 100, 101]),
    onError: (e) => errors.push(e),
    kill: (pid) => {
      killed.push(pid);
      throw new Error("denied");
    },
  });
  assert.deepEqual(killed, [100]);
  assert.equal(survivors.length, 1);
  assert.equal(errors.length, 1);
});

test("command-only denied fixture completes without UI ready; owner still waits", () => {
  // UNIT ONLY: exercise fixture handlers with deterministic client doubles, no native host proof.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const script = `
import asyncio, runpy, sys
from types import SimpleNamespace
from kobrixa import Plugin
Plugin.run = lambda self: None
consumer = sys.argv[1]
async def check():
    calls=[]
    async def connect(params):
        calls.append('connect')
        return {'ok':False,'error':{'code':'PLUGIN_E_PERMISSION_DENIED'}}
    async def read(params):
        calls.append('read')
        return {'ok':True,'value':{'revision':None}}
    async def update(params):
        calls.append('update')
        return {'ok':False,'error':{'code':'PLUGIN_E_PERMISSION_DENIED'}}
    ctx=SimpleNamespace(devices=SimpleNamespace(connect=connect),settings=SimpleNamespace(read=read,update=update))
    sys.argv=[consumer,'denied']
    denied=runpy.run_path(consumer)
    assert not denied['ready_event'].is_set()
    await asyncio.wait_for(denied['run'](ctx),0.1)
    assert calls==['connect','read','update']
    sys.argv=[consumer,'owner']
    owner=runpy.run_path(consumer)
    task=asyncio.create_task(owner['run'](ctx))
    await asyncio.sleep(0.01)
    assert not task.done() and calls==['connect','read','update']
    task.cancel()
    await asyncio.gather(task,return_exceptions=True)
asyncio.run(check())
`;
  const result = spawnSync(
    process.env.DEVICE_STDIO_TEST_PYTHON ??
      "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
    ["-B", "-c", script, root + "tests/desktop/fixtures/device-ui-public/consumer.py"],
    {
      env: { ...process.env, PYTHONPATH: root + "sdks/python", PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.match(result.stderr, /"role": "denied", "stage": "done"/);
});

for (const sourceKey of [
  "development:owner",
  "dev:",
  "dev:123",
  "dev:" + "A".repeat(16),
  "dev:" + "0".repeat(17),
])
  test("rejects noncontract source key " + sourceKey, () => {
    const r = fixture();
    r.launches[0].owner.sourceKey = sourceKey;
    assert.throws(() => verifyDeviceStdio(r));
  });
for (const generation of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "0"])
  test("rejects invalid generation " + generation, () => {
    const r = fixture();
    r.launches[0].owner.generation = generation;
    assert.throws(() => verifyDeviceStdio(r));
  });
