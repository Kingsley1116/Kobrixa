import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  verifyInstalledReceipt,
  auditPayload,
  labInstalledOptions,
} from "./sensor-lab-installed-run.mjs";
import { verifyLeaf, digest, copyInstalledLeaf } from "./sensor-lab-installed-artifacts.mjs";
// Synthetic oracle UNIT data only; never emitted by the native producer.
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
function installedFixture() {
  const r = oracleFixture();
  r.scenario = "healthy";
  r.hostKind = "installed-payload-acceptance-host";
  const first = r.launches[0].owner,
    second = { ...first, generation: 2, processEpoch: "second" };
  r.launches.push({ owner: second, at: 62 });
  r.exits.push({ owner: second, at: 70 });
  r.checkpoints.isolation = { sourceDenied: true, networkDenied: true, noPathNode: true };
  r.checkpoints.chromiumSandbox = true;
  r.checkpoints.management = { at: 65, disabled: { ok: true }, enabled: { ok: true } };
  const bytes = Buffer.from("raw csv\n42\n");
  r.checkpoints.export = { bytes: bytes.toString("base64") };
  r.checkpoints.copy = { text: "actual code", displayed: "actual code" };
  let sequence = Math.max(...r.wire.map((w) => w.sequence));
  for (const [method, params, value] of [
    ["ui/copyText", { text: "actual code", actionRef: "copy-ref" }, { copied: true }],
    [
      "storage/exportBegin",
      { actionRef: "export-ref", sha256: digest(bytes), byteLength: bytes.length },
      { export: "export" },
    ],
    [
      "storage/exportChunk",
      { export: "export", offset: 0, data: bytes.toString("base64") },
      { receivedBytes: bytes.length },
    ],
    ["storage/exportCommit", { export: "export" }, { exported: true }],
  ]) {
    const id = ++sequence;
    r.wire.push(
      {
        owner: first,
        direction: "plugin-host",
        at: 51,
        sequence: id,
        message: { id, method, params },
      },
      {
        owner: first,
        direction: "host-plugin",
        at: 52,
        sequence: ++sequence,
        message: { id, result: { ok: true, value } },
      },
    );
  }
  for (const [action, node, actionRef] of [
    ["copy-code", "code", "copy-ref"],
    ["export", "export", "export-ref"],
  ]) {
    const id = ++sequence;
    r.wire.push(
      {
        owner: first,
        direction: "host-plugin",
        at: 50.5,
        sequence: id,
        message: {
          id,
          method: "command/invoke",
          params: {
            command: `kobrixa.sensor-lab.${action}`,
            context: { origin: "panel", binding: { kind: "panel" }, actionRef },
          },
        },
      },
      {
        owner: first,
        direction: "plugin-host",
        at: 52,
        sequence: ++sequence,
        message: { id, result: { ok: true, value: { fieldErrors: [] } } },
      },
    );
    r.native.push({ type: "pointerdown", isTrusted: true, node, at: 50.4 });
  }
  r.ipc.push(
    ...[false, true].map((enabled) => ({
      channel: "plugins:set-enabled",
      args: ["builtin:kobrixa.sensor-lab", enabled],
      result: { ok: true },
    })),
  );
  return r;
}
test("coherent UNIT installed receipt passes without native execution", () => {
  assert.equal(verifyInstalledReceipt(installedFixture()).finalWrite, "final-write");
});
for (const [name, mutate] of [
  [
    "Chromium sandbox disabled",
    (r) => {
      r.checkpoints.chromiumSandbox = false;
    },
  ],
  [
    "isolation not established",
    (r) => {
      r.checkpoints.isolation.sourceDenied = false;
    },
  ],
  [
    "submitted cannot replace saved",
    (r) => {
      r.drains[0].report.state = "uncertain";
    },
  ],
  [
    "export byte corruption",
    (r) => {
      r.checkpoints.export.bytes = Buffer.from("wrong").toString("base64");
    },
  ],
  [
    "displayed code mismatch",
    (r) => {
      r.checkpoints.copy.displayed = "old";
    },
  ],
  [
    "foreign native action claim",
    (r) => {
      r.wire.find((w) => w.message.method === "ui/copyText").message.params.actionRef = "foreign";
    },
  ],
  [
    "missing native export input",
    (r) => {
      r.native = r.native.filter((e) => e.node !== "export");
    },
  ],
  [
    "missing export payload chunks",
    (r) => {
      r.wire = r.wire.filter((w) => w.message.method !== "storage/exportChunk");
    },
  ],
  [
    "management bypass",
    (r) => {
      r.ipc = r.ipc.filter((w) => w.channel !== "plugins:set-enabled");
    },
  ],
  [
    "clipboard unrelated",
    (r) => {
      r.checkpoints.copy.text = "wrong";
    },
  ],
  [
    "failed persistence of disable",
    (r) => {
      r.checkpoints.management.disabled.persisted = false;
    },
  ],
  [
    "generation reuse",
    (r) => {
      r.launches[1].owner = r.launches[0].owner;
    },
  ],
  [
    "missing original exit",
    (r) => {
      r.exits.shift();
    },
  ],
  [
    "replacement reserve replay",
    (r) => {
      const w = structuredClone(
        r.wire.find((w) => w.message.method === "devices/recording/reserve"),
      );
      w.owner = r.launches[1].owner;
      r.wire.push(w);
    },
  ],
  [
    "foreign export job",
    (r) => {
      r.wire.find((w) => w.message.method === "storage/exportCommit").message.params.export =
        "other";
    },
  ],
])
  test(name, () => {
    const r = installedFixture();
    mutate(r);
    assert.throws(() => verifyInstalledReceipt(r));
  });
test("negative receipt needs actual product invalid state and no child", () => {
  const r = installedFixture();
  r.scenario = "tampered";
  r.launches = [];
  r.exits = [];
  r.wire = [];
  r.drains = [];
  r.checkpoints.negative = {
    row: { status: "invalid", problems: [{ code: "PLUGIN_E_ENTRY" }] },
    catalog: { ok: true, value: { entries: [] } },
  };
  assert.deepEqual(verifyInstalledReceipt(r), { scenario: "tampered" });
  r.checkpoints.negative.row.status = "disabled";
  assert.throws(() => verifyInstalledReceipt(r));
});
async function artifact(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "lab-installed-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "ui"));
  // Deliberately not product bytes. Pure artifact-verifier fixture only.
  const manifest = {
    id: "kobrixa.sensor-lab",
    runtime: { kind: "node", entry: "main.cjs" },
    contributes: {
      panels: [{ resource: { version: 2, path: "ui/panel.json" } }],
      status: [{ resource: { version: 2, path: "ui/status.json" } }],
    },
  };
  for (const [name, content] of [
    ["main.cjs", "// UNIT ONLY"],
    ["kobrixa-plugin.json", JSON.stringify(manifest)],
    ["ui/panel.json", '{"version":2}'],
    ["ui/status.json", '{"version":2}'],
  ])
    await writeFile(path.join(directory, name), content);
  const files = [];
  for (const name of ["kobrixa-plugin.json", "main.cjs", "ui/panel.json", "ui/status.json"]) {
    const bytes = await readFile(path.join(directory, name));
    files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  await writeFile(
    path.join(directory, "resource-index.json"),
    JSON.stringify({ version: 1, pluginId: "kobrixa.sensor-lab", files }),
  );
  return { directory: await import("node:fs/promises").then((m) => m.realpath(directory)), files };
}
test("bounded v2 artifact bytes/index match", async (t) => {
  const { directory } = await artifact(t);
  assert.equal((await verifyLeaf(directory)).files.length, 4);
});
test("missing entry rejects", async (t) => {
  const { directory } = await artifact(t);
  await rm(path.join(directory, "main.cjs"));
  await assert.rejects(verifyLeaf(directory));
});
test("tampered resource rejects", async (t) => {
  const { directory } = await artifact(t);
  await writeFile(path.join(directory, "ui/panel.json"), "{}");
  await assert.rejects(verifyLeaf(directory));
});
test("symlink payload rejected even with identical bytes", async (t) => {
  const { directory } = await artifact(t);
  await writeFile(
    path.join(directory, "copy.cjs"),
    await readFile(path.join(directory, "main.cjs")),
  );
  await rm(path.join(directory, "main.cjs"));
  await symlink("copy.cjs", path.join(directory, "main.cjs"));
  await assert.rejects(verifyLeaf(directory));
});
test("duplicate/outside index paths reject", async (t) => {
  const { directory, files } = await artifact(t);
  files[3] = { ...files[0] };
  await writeFile(
    path.join(directory, "resource-index.json"),
    JSON.stringify({ version: 1, pluginId: "kobrixa.sensor-lab", files }),
  );
  await assert.rejects(verifyLeaf(directory));
});

test("audit rejects a checkout/unbundled SDK import without resolving it", async (t) => {
  const { directory } = await artifact(t);
  await writeFile(path.join(directory, "main.cjs"), 'require("@kobrixa/plugin-sdk");');
  await assert.rejects(auditPayload(directory));
});
test("audit allows only standalone Node builtin imports", async (t) => {
  const { directory } = await artifact(t);
  await writeFile(path.join(directory, "main.cjs"), 'require("node:crypto");');
  const result = await auditPayload(directory);
  assert.equal(Object.keys(result.metafile.inputs).length, 1);
});

test("declared settings v1 participates in exact indexed leaf", async (t) => {
  const { directory, files } = await artifact(t);
  const manifest = JSON.parse(await readFile(path.join(directory, "kobrixa-plugin.json"), "utf8"));
  manifest.contributes.settings = { path: "settings/preferences.json", version: 1 };
  await mkdir(path.join(directory, "settings"));
  await writeFile(path.join(directory, "settings/preferences.json"), "{}");
  await writeFile(path.join(directory, "kobrixa-plugin.json"), JSON.stringify(manifest));
  for (const name of ["kobrixa-plugin.json", "settings/preferences.json"]) {
    const b = await readFile(path.join(directory, name));
    const row = { path: name, bytes: b.length, sha256: digest(b) };
    const old = files.findIndex((f) => f.path === name);
    if (old < 0) files.push(row);
    else files[old] = row;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(
    path.join(directory, "resource-index.json"),
    JSON.stringify({ version: 1, pluginId: "kobrixa.sensor-lab", files }),
  );
  assert.equal((await verifyLeaf(directory)).files.length, 5);
  await rm(path.join(directory, "settings/preferences.json"));
  await assert.rejects(verifyLeaf(directory));
});

test("shared defaults still select original Lab scenarios", () => {
  assert.equal(labInstalledOptions.slug, "sensor-lab");
  assert.equal(labInstalledOptions.pluginId, "kobrixa.sensor-lab");
  assert.equal(labInstalledOptions.switchPrefix, "lab");
  assert.equal(labInstalledOptions.missingResource, "ui/panel.json");
  assert.equal(labInstalledOptions.verify, verifyInstalledReceipt);
});
test("copy preserves every indexed byte and refuses replay or tampering", async (t) => {
  const { directory, files } = await artifact(t);
  const output = await realpath(await mkdtemp(path.join(tmpdir(), "installed-copy-unit-")));
  t.after(() => rm(output, { recursive: true, force: true }));
  await copyInstalledLeaf(directory, output, "kobrixa.sensor-lab");
  for (const name of [...files.map((f) => f.path), "resource-index.json"])
    assert.deepEqual(
      await readFile(path.join(output, name)),
      await readFile(path.join(directory, name)),
    );
  await assert.rejects(copyInstalledLeaf(directory, output, "kobrixa.sensor-lab"));
  await writeFile(path.join(directory, "main.cjs"), "tampered");
  await assert.rejects(
    copyInstalledLeaf(directory, path.join(output, "next"), "kobrixa.sensor-lab"),
  );
});
