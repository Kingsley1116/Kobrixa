import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  restartOriginals,
  seedLabRestart,
  snapshotLabRestart,
  verifyLabRestart,
  verifyLabReceipt,
  verifyLabParity,
} from "./sensor-lab-public-run.mjs";

// Oracle UNIT fixture only. Never used by the native producer or emitted as native evidence.
function oracleFixture() {
  const owner = {
    pluginId: "kobrixa.sensor-lab",
    sourceKey: "builtin:kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const form = {
    "two-point": true,
    "source-a": "42",
    "source-b": "100",
    "target-b": "200",
    unit: "raw",
  };
  const payload = {
    schemaVersion: 2,
    id: "00000000-0000-4000-8000-000000000001",
    name: "D7 actual Lab",
    frameCount: 1,
    frames: [{ values: [42], status: "ok" }],
    channels: [
      {
        source: { origin: "public", provenance: { sessionId: "session", sourceRevision: 1 } },
        calibration: {
          twoPoint: true,
          sourceA: 42,
          sourceB: 100,
          targetA: 0,
          targetB: 200,
          zeroOffset: 0,
          unit: "raw",
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const meta = {
    id: "record",
    revision: "revision-final",
    checkpoint: "final",
    interrupted: false,
    byteLength: bytes.length,
    sha256,
  };
  let sequence = 0;
  const wire = [];
  const pair = (method, params, value, at, direction = "plugin-host") => {
    const id = ++sequence;
    wire.push({ owner, direction, at, sequence: id, message: { method, id, params } });
    wire.push({
      owner,
      direction: direction === "plugin-host" ? "host-plugin" : "plugin-host",
      at: at + 0.1,
      sequence: ++sequence,
      message: { id, result: { ok: true, value } },
    });
  };
  for (const [i, command] of [
    "select-current",
    "select-channel",
    "capture-a",
    "apply",
    "start",
    "refresh",
    "view-record",
  ].entries())
    pair(
      "command/invoke",
      {
        command: `kobrixa.sensor-lab.${command}`,
        context: { origin: "panel", binding: { kind: "panel" } },
      },
      { output: {}, fieldErrors: [] },
      i < 5 ? 5 + i : 40 + i,
      "host-plugin",
    );
  pair("ui/formPatch", { set: { "source-a": "42" } }, {}, 8);
  pair(
    "devices/recording/reserve",
    { sessionId: "session", expectedSourceRevision: 1 },
    { reservation: { reservationId: "reservation" } },
    10,
  );
  pair(
    "storage/registerCheckpoint",
    { id: "record", reservation: "reservation" },
    { checkpoint: "checkpoint" },
    11,
  );
  pair(
    "devices/recording/read",
    { reservationId: "reservation" },
    { frames: [{ values: [42] }] },
    21,
  );
  pair(
    "storage/drain",
    { token: "drain" },
    { status: "submitted", writes: ["final-write"] },
    31,
    "host-plugin",
  );
  pair(
    "storage/beginWrite",
    {
      target: { mode: "replace", id: "record" },
      drainToken: "drain",
      checkpoint: { handle: "checkpoint", phase: "final" },
      byteLength: bytes.length,
      sha256,
    },
    { write: "final-write" },
    32,
  );
  pair(
    "storage/beginWrite",
    { target: { mode: "create" }, byteLength: bytes.length, sha256 },
    { write: "initial-write", id: "record" },
    10.5,
  );
  pair(
    "storage/writeChunk",
    { write: "initial-write", offset: 0, data: bytes.toString("base64") },
    { nextOffset: bytes.length },
    10.6,
  );
  pair("storage/commitWrite", { write: "final-write", drainToken: "drain" }, { record: meta }, 33);
  pair("storage/stat", { id: "record" }, { record: meta }, 41);
  pair(
    "storage/openRead",
    { id: "record", expectedRevision: meta.revision },
    { record: meta, read: "read" },
    42,
  );
  pair(
    "storage/readChunk",
    { read: "read", offset: 0 },
    { offset: 0, data: bytes.toString("base64"), nextOffset: bytes.length, eof: true },
    43,
  );
  return {
    schema: 1,
    stage: "complete",
    failures: [],
    launches: [{ owner, at: 4 }],
    exits: [{ owner, at: 60 }],
    gate: [
      { phase: "gate-freeze", at: 1 },
      { phase: "gate-settled", at: 3 },
    ],
    wire,
    ipc: [
      {
        channel: "plugins:ui:data-read",
        at: 49,
        args: [{ dataset: "chart0" }],
        result: { ok: true, value: { header: { view: "full" } } },
      },
      { channel: "plugins:ui:form-sync", result: { ok: true } },
      { channel: "plugins:ui:close", at: 20, result: { ok: true } },
      {
        channel: "plugins:ui:interact",
        at: 30,
        args: [{ kind: "core", actionId: "stop", binding: { kind: "status" } }],
        result: { ok: true },
      },
    ],
    brokerCalls: [
      {
        method: "devices/recording/release",
        principal: { kind: "plugin", owner },
        params: { reservationId: "reservation" },
        at: 30,
        result: { ok: true, value: {} },
      },
    ],
    drains: [
      {
        at: 30,
        finishedAt: 35,
        offer: { owner, token: "drain", checkpoints: [{ checkpoint: "checkpoint" }] },
        report: {
          state: "saved",
          blocker: false,
          errors: [],
          records: [{ id: "record", committedRevision: meta.revision, final: true }],
        },
      },
    ],
    checkpoints: {
      open: { state: { binding: { instance: "first" } } },
      applied: { state: { form } },
      background: { at: 25, launchCount: 1, exitCount: 0, owner },
      reopened: { state: { binding: { instance: "second" } } },
      history: { at: 50 },
    },
    native: [
      { type: "pointerdown", isTrusted: true, status: true, at: 29 },
      { type: "pointerdown", isTrusted: true, close: true },
      { type: "input", isTrusted: true, node: "target-b" },
    ],
    cleanup: { bridge: { owners: 0 }, worker: { workerJobs: 0 }, workers: 0 },
  };
}
function request(report, method) {
  return report.wire.find((r) => r.message.method === method);
}
function value(report, method) {
  const id = request(report, method).message.id;
  return report.wire.find((r) => r.message.id === id && r.message.result).message.result.value;
}

test("unit-only coherent receipt passes pure oracle; does not run Electron", () => {
  const result = verifyLabReceipt(oracleFixture());
  assert.equal(result.finalWrite, "final-write");
  assert.equal(result.frames, 1);
});
for (const [name, mutate] of [
  [
    "submitted is not host saved",
    (r) => {
      r.drains[0].report.state = "uncertain";
    },
  ],
  [
    "old unrelated committed write cannot stand in for final",
    (r) => {
      value(r, "storage/drain").writes = ["old-write"];
    },
  ],
  [
    "final must use original drain token",
    (r) => {
      request(r, "storage/commitWrite").message.params.drainToken = "foreign";
    },
  ],
  [
    "final must reference original registered checkpoint",
    (r) => {
      request(r, "storage/beginWrite").message.params.checkpoint.handle = "foreign";
    },
  ],
  [
    "real host report revision must match final commit",
    (r) => {
      r.drains[0].report.records[0].committedRevision = "old";
    },
  ],
  [
    "history hash mutation fails",
    (r) => {
      value(r, "storage/readChunk").data = Buffer.from("tampered").toString("base64");
    },
  ],
  [
    "history read must pin exact final revision",
    (r) => {
      request(r, "storage/openRead").message.params.expectedRevision = "old";
    },
  ],
  [
    "close must retain recording progress",
    (r) => {
      request(r, "devices/recording/read").at = 19;
    },
  ],
  [
    "status stop cannot impersonate panel origin",
    (r) => {
      r.ipc[3].args[0].binding.kind = "panel";
    },
  ],
  [
    "new owner cannot replace original process",
    (r) => {
      r.wire[0].owner = { ...r.wire[0].owner, processEpoch: "replacement" };
    },
  ],
  [
    "untrusted synthetic UI input fails",
    (r) => {
      for (const n of r.native) n.isTrusted = false;
    },
  ],
  [
    "late migration barrier fails",
    (r) => {
      r.gate[1].at = 5;
    },
  ],
  [
    "leaked persistence worker fails",
    (r) => {
      r.cleanup.workers = 1;
    },
  ],
  [
    "core Stop cannot borrow core authority",
    (r) => {
      r.brokerCalls[0].principal.kind = "core";
    },
  ],
  [
    "release must target original reservation",
    (r) => {
      r.brokerCalls[0].params.reservationId = "foreign";
    },
  ],
  [
    "renderer must consume saved full-domain presentation",
    (r) => {
      r.ipc[0].result.value.header.view = "recent60s";
    },
  ],
  [
    "native run cannot claim completion while partial",
    (r) => {
      r.stage = "status-core-stop";
    },
  ],
])
  test(name, () => {
    const report = structuredClone(oracleFixture());
    mutate(report);
    assert.throws(() => verifyLabReceipt(report));
  });

test("rejects a substituted model UUID even when final storage metadata is internally consistent", () => {
  const report = oracleFixture();
  const chunk = request(report, "storage/writeChunk");
  const model = JSON.parse(Buffer.from(chunk.message.params.data, "base64").toString("utf8"));
  model.id = "00000000-0000-4000-8000-000000000002";
  const bytes = Buffer.from(JSON.stringify(model));
  chunk.message.params.data = bytes.toString("base64");
  const created = report.wire.find(
    (r) => r.message.method === "storage/beginWrite" && r.message.params.target.mode === "create",
  );
  created.message.params.byteLength = bytes.length;
  created.message.params.sha256 = createHash("sha256").update(bytes).digest("hex");
  assert.throws(() => verifyLabReceipt(report), /Original model identity/);
});

// Synthetic oracle-only evidence. Never emitted by the native producer.
function parityFixture() {
  const owner = {
    sourceKey: "builtin:kobrixa.sensor-lab",
    pluginId: "kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const r = {
    launches: [{ owner }],
    exits: [{ owner, at: 3000 }],
    wire: [],
    ipc: [],
    native: [],
    brokerCalls: [],
    drains: [],
    checkpoints: { history: { at: 10 } },
    cleanup: { bridge: {}, worker: {}, workers: 0 },
  };
  const names = [
    "live-profile",
    "save-profile",
    "list-profile",
    "reset-profile",
    "apply-profile",
    "delete-profile",
    "live-second",
    "start-second",
    "stop-second",
    "list-two",
    "view-first",
    "compare-second",
    "raw",
    "calibrated",
    "live-delete",
    "fresh-history",
    "delete-first",
    "list-after-delete",
  ];
  const p = {
    steps: names.map((name, i) => ({ name, at: 100 + i * 100, finishedAt: 195 + i * 100 })),
    finishedAt: 1900,
    applied: { form: { "source-a": "42", "target-b": "200" } },
  };
  r.checkpoints.parity = p;
  const step = (name) => p.steps.find((s) => s.name === name);
  let id = 0;
  const pair = (method, params, value, at, direction = "plugin-host", end = at + 0.1) => {
    const request = { direction, owner, at, sequence: 0, message: { id: ++id, method, params } };
    const response = {
      direction: direction === "plugin-host" ? "host-plugin" : "plugin-host",
      owner,
      at: end,
      sequence: 0,
      message: { id, result: { ok: true, value } },
    };
    r.wire.push(request, response);
    return { request, response };
  };
  const calibration = {
    twoPoint: true,
    sourceA: 42,
    sourceB: 100,
    targetA: 0,
    targetB: 200,
    zeroOffset: 0,
    unit: "raw",
  };
  const payload = (id, name) => ({
    id,
    name,
    channels: [{ calibration }],
    frames: [{ values: [42] }],
  });
  const models = {
    first: payload("model-first", "D7 actual Lab"),
    second: payload("model-second", "D7 comparison Lab"),
    profile: { id: "model-profile", name: "D7 saved calibration", calibration },
  };
  for (const name of ["first", "profile", "second"]) {
    const bytes = Buffer.from(JSON.stringify(models[name])),
      sha256 = createHash("sha256").update(bytes).digest("hex");
    const meta = {
      id: name,
      revision: `${name}-revision`,
      kind: name === "profile" ? "sensor-lab.calibration" : "sensor-lab.recording",
      byteLength: bytes.length,
      sha256,
      checkpoint: name === "profile" ? null : "final",
    };
    p[name] = meta;
    const at =
      name === "first" ? 1 : step(name === "profile" ? "save-profile" : "stop-second").at + 30;
    pair(
      "storage/beginWrite",
      {
        target: { mode: "create" },
        sha256,
        byteLength: bytes.length,
        ...(name === "second"
          ? { checkpoint: { handle: "checkpoint-second", phase: "final" } }
          : {}),
      },
      { write: `write-${name}`, id: name },
      at,
    );
    pair(
      "storage/writeChunk",
      { write: `write-${name}`, offset: 0, data: bytes.toString("base64") },
      {},
      at + 1,
    );
    pair(
      "storage/commitWrite",
      { write: `write-${name}`, ...(name === "second" ? { drainToken: "drain-second" } : {}) },
      { record: meta },
      at + 2,
    );
  }
  const binding = { panelInstance: "panel" };
  let targetId = 0;
  function input(name, node, at, dialog = false, status = false) {
    const target = ++targetId;
    r.checkpoints[`input-${target}`] = { stage: `parity-${name}`, at: at - 3, targetId: target };
    r.native.push(
      { type: "pointerdown", isTrusted: true, at: at - 2, node, dialog, status, targetId: target },
      { type: "pointerup", isTrusted: true, at: at - 1, node, dialog, status, targetId: target },
    );
  }
  function command(name, cmd, node, args = {}, dialog = false) {
    const at = step(name).at,
      invocationId = `invoke-${name}`;
    pair(
      "command/invoke",
      {
        command: `kobrixa.sensor-lab.${cmd}`,
        arguments: args,
        invocationId,
        context: { origin: "panel", binding },
      },
      { fieldErrors: [] },
      at + 15,
      "host-plugin",
      at + 80,
    );
    const action = { kind: dialog ? "dialogConfirm" : "action", nodeId: node, binding };
    const ipc = {
      channel: "plugins:ui:interact",
      args: [action],
      at: at + 14,
      finishedAt: at + 81,
      result: { ok: true, value: { invocationId } },
    };
    r.ipc.push(ipc);
    input(name, node, at + 14, dialog);
    return ipc;
  }
  function page(dataset, metas, at, revision = 1) {
    const ipc = {
      channel: "plugins:ui:data-read",
      args: [{ dataset, binding, revision }],
      at,
      finishedAt: at + 0.1,
      result: {
        ok: true,
        value: {
          revision,
          chunk: { entries: metas.map((m) => ({ key: m.id, version: String(m.revision) })) },
        },
      },
    };
    r.ipc.push(ipc);
    return ipc;
  }
  for (const [name, cmd] of [
    ["live-profile", "live"],
    ["save-profile", "save-profile"],
    ["list-profile", "refresh"],
    ["reset-profile", "reset"],
    ["live-second", "live"],
    ["start-second", "start"],
    ["list-two", "refresh"],
    ["live-delete", "live"],
    ["fresh-history", "refresh"],
    ["list-after-delete", "refresh"],
  ])
    command(name, cmd, cmd);
  for (const [name, cmd, dataset, meta, deleting] of [
    ["apply-profile", "apply-profile", "profiles", p.profile, false],
    ["delete-profile", "delete-profiles", "profiles", p.profile, true],
    ["view-first", "view-record", "history", p.first, false],
    ["compare-second", "compare-record", "history", p.second, false],
    ["delete-first", "delete-history", "history", p.first, true],
  ]) {
    const at = step(name).at;
    page(dataset, [meta], at + 1);
    const ipc = command(
      name,
      cmd,
      deleting ? `delete-${dataset}-confirm` : dataset,
      { key: meta.id, revision: String(meta.revision), dataset: 1 },
      deleting,
    );
    const selected = {
      kind: "list",
      nodeId: dataset,
      dataset,
      key: meta.id,
      revision: 1,
      actionId: cmd,
      binding,
    };
    if (deleting) {
      r.ipc.push({
        channel: "plugins:ui:interact",
        at: at + 6,
        finishedAt: at + 7,
        args: [selected],
        result: { ok: true, value: { kind: "view" } },
      });
      input(name, dataset, at + 6);
      pair(
        "storage/delete",
        { id: meta.id, expectedRevision: meta.revision },
        { deleted: true },
        at + 30,
      );
      pair(
        "storage/list",
        { kind: meta.kind },
        { entries: dataset === "history" ? [p.second] : [], nextCursor: null },
        at + 35,
      );
    } else {
      ipc.args[0] = selected;
      const model = models[meta.id],
        bytes = Buffer.from(JSON.stringify(model));
      pair(
        "storage/openRead",
        { id: meta.id, expectedRevision: meta.revision },
        { record: meta, read: `read-${name}` },
        at + 30,
      );
      pair(
        "storage/readChunk",
        { read: `read-${name}`, offset: 0 },
        { offset: 0, nextOffset: bytes.length, eof: true, data: bytes.toString("base64") },
        at + 31,
      );
    }
  }
  pair(
    "storage/list",
    { kind: "sensor-lab.calibration" },
    { entries: [p.profile], nextCursor: null },
    step("list-profile").at + 30,
  );
  pair(
    "devices/recording/reserve",
    {},
    { reservation: { reservationId: "reservation-second" } },
    step("start-second").at + 30,
  );
  pair(
    "storage/registerCheckpoint",
    { reservation: "reservation-second", id: p.second.id },
    { checkpoint: "checkpoint-second" },
    step("start-second").at + 31,
  );
  r.drains.push({
    at: step("stop-second").at + 20,
    offer: { owner, token: "drain-second", checkpoints: [{ checkpoint: "checkpoint-second" }] },
    report: {
      state: "saved",
      blocker: false,
      records: [{ id: p.second.id, committedRevision: p.second.revision, final: true }],
    },
  });
  pair(
    "storage/drain",
    { token: "drain-second" },
    { status: "submitted", writes: ["write-second"] },
    step("stop-second").at + 21,
    "host-plugin",
    step("stop-second").at + 70,
  );
  const stopAt = step("stop-second").at + 14;
  r.ipc.push({
    channel: "plugins:ui:interact",
    at: stopAt,
    finishedAt: stopAt + 70,
    args: [{ kind: "core", actionId: "stop" }],
    result: { ok: true, value: {} },
  });
  input("stop-second", undefined, stopAt, false, true);
  r.brokerCalls.push({
    method: "devices/recording/release",
    params: { reservationId: "reservation-second" },
    at: stopAt + 1,
    principal: { kind: "plugin", owner },
    result: { ok: true, value: {} },
  });
  for (const [name, calibrated, value, revision] of [
    ["raw", false, 42, 10],
    ["calibrated", true, 0, 11],
  ]) {
    const at = step(name).at;
    const chart = {
      channel: "plugins:ui:data-read",
      args: [{ dataset: "chart0", binding }],
      at: at + 20,
      finishedAt: at + 21,
      result: {
        ok: true,
        value: {
          revision,
          header: { view: "full" },
          chunk: {
            entries: [
              [0, 0, 0, value],
              [1, 0, 0, value],
            ],
          },
        },
      },
    };
    r.ipc.push(chart);
    p[name] = { page: chart, form: { calibrated } };
    r.native.push({ type: "input", isTrusted: true, node: "calibrated", at: at + 10 });
  }
  page("history", [p.second], step("list-after-delete").at + 20, 2);
  r.wire.sort((a, b) => a.at - b.at).forEach((row, index) => (row.sequence = index + 1));
  for (const s of p.steps) {
    s.before = Math.max(0, ...r.wire.filter((row) => row.at < s.at).map((row) => row.sequence));
    s.after = Math.max(
      ...r.wire.filter((row) => row.at <= s.finishedAt).map((row) => row.sequence),
    );
  }
  return r;
}
test("D7 oracle accepts correlated synthetic extension (not native evidence)", () =>
  assert.deepEqual(verifyLabParity(parityFixture()), {
    profile: "profile",
    first: "first",
    second: "second",
  }));
test("extended public runner requires parity; historical base stays independently verifiable", () =>
  assert.throws(
    () => verifyLabReceipt(oracleFixture(), { requireParity: true }),
    /extension required/,
  ));
for (const [name, mutate] of [
  ["missing step", (r) => r.checkpoints.parity.steps.pop()],
  ["foreign owner", (r) => (r.wire[0].owner = { ...r.wire[0].owner, processEpoch: "foreign" })],
  ["same recording identity", (r) => (r.checkpoints.parity.second = r.checkpoints.parity.first)],
  [
    "substituted profile bytes",
    (r) =>
      (r.wire.find(
        (x) =>
          x.message.method === "storage/writeChunk" && x.message.params.write === "write-profile",
      ).message.params.data = "e30="),
  ],
  [
    "wrong pinned read",
    (r) =>
      (r.wire.find((x) => x.message.method === "storage/openRead").message.params.expectedRevision =
        "other"),
  ],
  ["missing confirmation click", (r) => (r.native = r.native.filter((e) => !e.dialog))],
  [
    "wrong delete ID",
    (r) => (r.wire.find((x) => x.message.method === "storage/delete").message.params.id = "other"),
  ],
  [
    "stale row dataset",
    (r) =>
      (r.wire.find(
        (x) =>
          x.message.method === "command/invoke" &&
          x.message.params.command.endsWith("delete-history"),
      ).message.params.arguments.dataset = 99),
  ],
  [
    "raw shown as calibrated",
    (r) => (r.checkpoints.parity.calibrated.page.result.value.chunk.entries[1][3] = 42),
  ],
  ["missing second series", (r) => r.checkpoints.parity.raw.page.result.value.chunk.entries.pop()],
  ["wrong original checkpoint", (r) => (r.drains[0].offer.checkpoints[0].checkpoint = "other")],
  [
    "original still listed",
    (r) => {
      const q = r.wire.find(
        (x) =>
          x.message.method === "storage/list" && x.message.params.kind === "sensor-lab.recording",
      );
      r.wire
        .find((x) => !x.message.method && x.message.id === q.message.id)
        .message.result.value.entries.push(r.checkpoints.parity.first);
    },
  ],
  ["missing original response", (r) => r.wire.splice(1, 1)],
  ["orphan worker", (r) => (r.cleanup.workers = 1)],
])
  test(`D7 rejects ${name}`, () => {
    const r = parityFixture();
    mutate(r);
    assert.throws(() => verifyLabParity(r));
  });

// Exercise the actual native row-action driver body with controlled observations.
// These are sequencing regressions, not native receipts or host endpoint substitutes.
async function rowActionDriver() {
  const source = await readFile(new URL("./sensor-lab-public-main.ts", import.meta.url), "utf8");
  const body = source.match(
    /const rowAction = async \(dataset: string, id: string, label: string, name: string\) => \{([\s\S]*?)\n {8}\};\n {8}const finalRecords/,
  );
  assert.ok(body, "actual row-action driver remains identifiable");
  return new (Object.getPrototypeOf(async function () {}).constructor)(
    "click",
    "until",
    "exchanges",
    "success",
    "sequence",
    "dataset",
    "id",
    "label",
    "name",
    "js",
    "const object = value => value;\n" + body[1],
  );
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("D7 deletion waits for command success, trusted Close, and actual modal removal", async () => {
  const drive = await rowActionDriver();
  const command = deferred(),
    closure = deferred(),
    waiting = deferred();
  const calls = [];
  let successful = false,
    open = true,
    finished = false;
  const run = drive(
    async (selector, label) => {
      calls.push([selector, label]);
    },
    async (observe, label) => {
      if (label === "delete-profiles") await command.promise;
      else {
        waiting.resolve();
        await closure.promise;
      }
      assert.equal(await observe(), true, label);
    },
    () =>
      successful
        ? [
            {
              request: {
                sequence: 11,
                message: { params: { command: "kobrixa.sensor-lab.delete-profiles" } },
              },
            },
          ]
        : [],
    () => true,
    10,
    "profiles",
    "record",
    "Delete",
    "delete-profiles",
    async (source) => {
      assert.equal(source, `!document.querySelector('[role="dialog"]')`);
      return !open;
    },
  ).then(() => {
    finished = true;
    waiting.resolve();
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(
    calls.some(([, label]) => label === "Close"),
    false,
  );
  successful = true;
  command.resolve();
  await waiting.promise;
  assert.deepEqual(calls.at(-1), ['[role="dialog"] button', "Close"]);
  assert.equal(finished, false, "RPC success and Close submission do not prove DOM removal");
  open = false;
  closure.resolve();
  await run;
  assert.equal(finished, true);
});
test("D7 deletion cannot continue when the modal remains after Close", async () => {
  const drive = await rowActionDriver();
  await assert.rejects(
    drive(
      async () => {},
      async (observe, label) => {
        assert.equal(await observe(), true, label);
      },
      () => [
        {
          request: {
            sequence: 11,
            message: { params: { command: "kobrixa.sensor-lab.delete-profiles" } },
          },
        },
      ],
      () => true,
      10,
      "profiles",
      "record",
      "Delete",
      "delete-profiles",
      async () => false,
    ),
    /dialog closed/,
  );
});

// Synthetic oracle inputs only; never emitted as native producer evidence.
function restartFixture() {
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, frameCount: 2 }));
  const saved = {
    id: "saved",
    revision: "r_saved",
    checkpoint: "final",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
  const deleted = { id: "imported", revision: "r_import" };
  const phase = (n) => ({
    stage: "complete",
    failures: [],
    launches: [{}],
    exits: [{}],
    cleanup: { workers: 0, bridge: {}, worker: {} },
    wire: [],
    drains: [],
    restart: {
      phase: String(n),
      mainPid: n,
      profile: "/same-profile",
      scope: { hostEpoch: `h${n}`, workbenchInstance: `w${n}` },
      profiles: [{ id: "calibration", revision: "r_calibration" }],
    },
  });
  const first = phase(1),
    second = phase(2);
  Object.assign(first.restart, { saved, deleted });
  second.restart.history = [saved];
  const pair = (p, method, request, value) => {
    const id = p.wire.length + 1;
    const owner = { sourceKey: "builtin:kobrixa.sensor-lab", hostEpoch: p.restart.scope.hostEpoch };
    p.wire.push(
      { sequence: id, direction: "plugin-host", owner, message: { id, method, params: request } },
      {
        sequence: id + 1,
        direction: "host-plugin",
        owner,
        message: { id, result: { ok: true, value } },
      },
    );
  };
  pair(
    first,
    "storage/delete",
    { id: deleted.id, expectedRevision: deleted.revision },
    { deleted: true },
  );
  pair(first, "storage/commitWrite", {}, { record: saved });
  pair(second, "storage/list", { kind: "sensor-lab.recording" }, { entries: [saved] });
  pair(
    second,
    "storage/openRead",
    { id: saved.id, expectedRevision: saved.revision },
    { read: "token", record: saved },
  );
  pair(
    second,
    "storage/readChunk",
    { read: "token" },
    { offset: 0, eof: true, data: bytes.toString("base64") },
  );
  const before = {
    originals: Object.fromEntries(
      Object.entries(restartOriginals).map(([key, value]) => [
        key,
        createHash("sha256").update(value).digest("hex"),
      ]),
    ),
    hashes: { head: "hash" },
    imports: ["recordings", "calibrations"].flatMap((suffix) => {
      const descriptorId = `kobrixa.sensor-lab.${suffix}-import`;
      return [
        {
          document: {
            plan: { descriptorId },
            complete: true,
            items: [{ state: "committed", receipt: { revision: "r_import" } }],
          },
        },
        { document: { kind: "barrier", descriptorId, state: "complete" } },
      ];
    }),
    records: [
      { head: { target: { id: deleted.id }, metadata: { deleted: true } }, document: null },
      {
        head: {
          target: { id: saved.id },
          receipt: { revision: saved.revision },
          sha256: saved.sha256,
        },
        document: JSON.parse(bytes),
      },
    ],
  };
  return {
    first,
    second,
    before,
    after: structuredClone(before),
    outside: [1, 2].map((pid) => ({ pid, code: 0, signal: null, timedOut: false, survivors: [] })),
  };
}
test("D7 restart oracle accepts distinct processes, durable bytes and deletion without re-import", () => {
  assert.deepEqual(verifyLabRestart(restartFixture()).mainPids, [1, 2]);
});
for (const [name, mutate] of [
  [
    "same process",
    (r) => {
      r.second.restart.mainPid = 1;
      r.outside[1].pid = 1;
    },
  ],
  [
    "different profile",
    (r) => {
      r.second.restart.profile = "/other";
    },
  ],
  [
    "stale authority",
    (r) => {
      r.second.restart.scope = r.first.restart.scope;
    },
  ],
  [
    "new durable publication",
    (r) => {
      r.after.hashes.head = "changed";
    },
  ],
  [
    "original rewrite",
    (r) => {
      r.before.originals = r.after.originals = {};
    },
  ],
  [
    "empty import",
    (r) => {
      r.before.imports[0].document.items = [];
      r.after = structuredClone(r.before);
    },
  ],
  [
    "lost tombstone",
    (r) => {
      r.before.records[0].head.metadata.deleted = false;
      r.after = structuredClone(r.before);
    },
  ],
  [
    "resurrected import",
    (r) => {
      r.second.restart.history.push(r.first.restart.deleted);
    },
  ],
  [
    "orphan",
    (r) => {
      r.outside[1].survivors = [9];
    },
  ],
  [
    "missing read reply",
    (r) => {
      r.second.wire.pop();
    },
  ],
  [
    "foreign reply",
    (r) => {
      r.second.wire.at(-1).owner = { hostEpoch: "foreign" };
    },
  ],
  [
    "changed read bytes",
    (r) => {
      r.second.wire.at(-1).message.result.value.data = "e30=";
    },
  ],
  [
    "uncertain delete",
    (r) => {
      r.first.wire[1].message.result = { ok: false, error: { code: "PLUGIN_E_STORAGE_IO" } };
    },
  ],
  [
    "automatic recording",
    (r) => {
      r.second.wire.push({ message: { method: "devices/recording/reserve" } });
    },
  ],
])
  test(`D7 restart rejects ${name}`, () => {
    const r = restartFixture();
    mutate(r);
    assert.throws(() => verifyLabRestart(r));
  });

test("D7 restart seeds exact original envelopes once, refuses consumed source, and detects rewrite", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "d7-restart-"));
  try {
    await seedLabRestart(dir);
    for (const [file, expected] of Object.entries(restartOriginals))
      assert.equal(await readFile(path.join(dir, "sensor-lab", file), "utf8"), expected);
    await assert.rejects(seedLabRestart(dir), /EEXIST/);
    await writeFile(path.join(dir, "sensor-lab", Object.keys(restartOriginals)[0]), "{}");
    await assert.rejects(snapshotLabRestart(dir), /Original rewritten/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("D7 snapshot reads real record .bin, import .json and deleted heads with strict bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "d7-heads-"));
  const namespace = path.join(dir, "plugins/persistence-v1/namespaces/lab");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const write = async (relative, data) => {
    const file = path.join(namespace, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  };
  const headFor = (kind, object, bytes, target) => ({
    metadata: { kind },
    target,
    object,
    byteLength: Buffer.byteLength(bytes),
    sha256: hash(bytes),
    receipt: { revision: "r_one" },
  });
  try {
    await seedLabRestart(dir);
    await write("identity.json", JSON.stringify({ sourceKey: "builtin:kobrixa.sensor-lab" }));
    const documents = ["recordings", "calibrations"].flatMap((suffix) => [
      { plan: { descriptorId: `kobrixa.sensor-lab.${suffix}-import` }, complete: true, items: [] },
      { kind: "barrier", descriptorId: `kobrixa.sensor-lab.${suffix}-import`, state: "complete" },
    ]);
    const importHeads = [];
    for (const [i, document] of documents.entries()) {
      const bytes = JSON.stringify(document),
        object = `r_import${i}.json`;
      const head = headFor("import", object, bytes, { kind: "import", key: `import/${i}` });
      importHeads.push(head);
      await write(`imports/${i}.json`, JSON.stringify(head));
      await write(`imports/objects/${object}`, bytes);
    }
    const payload = JSON.stringify({
      schemaVersion: 2,
      id: "model",
      frameCount: 1,
      frames: [{ values: [42] }],
    });
    const head = headFor("record", "r_saved.bin", payload, { kind: "record", id: "saved" });
    await write("records/saved/head.json", JSON.stringify(head));
    await write("records/saved/objects/r_saved.bin", payload);
    await write(
      "records/deleted/head.json",
      JSON.stringify({
        metadata: { kind: "record", deleted: true },
        target: { kind: "record", id: "deleted" },
        object: null,
        byteLength: 0,
        sha256: hash(""),
      }),
    );
    const snapshot = await snapshotLabRestart(dir);
    assert.equal(snapshot.imports.length, 4);
    assert.equal(
      snapshot.records.find((row) => row.head.target.id === "saved").document.frames[0].values[0],
      42,
    );
    assert.equal(snapshot.records.find((row) => row.head.target.id === "deleted").document, null);
    assert.equal(snapshot.hashes["records/saved/objects/r_saved.bin"], hash(payload));
    for (const object of ["r_saved.json", "../r_saved.bin", "/r_saved.bin"]) {
      await write("records/saved/head.json", JSON.stringify({ ...head, object }));
      await assert.rejects(snapshotLabRestart(dir));
    }
    await write("records/saved/head.json", JSON.stringify(head));
    await write("imports/0.json", JSON.stringify({ ...importHeads[0], object: "r_import0.bin" }));
    await assert.rejects(snapshotLabRestart(dir));
    await write("imports/0.json", JSON.stringify(importHeads[0]));
    await write("records/saved/objects/r_saved.bin", payload.replace("42", "43"));
    await assert.rejects(snapshotLabRestart(dir), /Expected values to be strictly equal/);
    await write("records/saved/objects/r_saved.bin", "not json");
    await write(
      "records/saved/head.json",
      JSON.stringify(headFor("record", "r_saved.bin", "not json", head.target)),
    );
    await assert.rejects(snapshotLabRestart(dir), SyntaxError);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
