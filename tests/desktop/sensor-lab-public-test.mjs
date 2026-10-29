import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { verifyLabReceipt } from "./sensor-lab-public-run.mjs";

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
