import assert from "node:assert/strict";
import { test } from "node:test";
import { documents, hash, ownerId, verifyStdio } from "./sensor-lab-stdio-run.mjs";
import {
  pluginManifestSchema,
  validateUiResourceV2,
} from "../../packages/plugin-protocol/dist/index.js";

// UNIT-only synthetic receipt. The producer never imports this module.
function fixture() {
  let sequence = 0;
  const owners = Object.fromEntries(
    ["owner", "foreign", "denied"].map((role, i) => [
      role,
      {
        pluginId: ownerId + (role === "owner" ? "" : "-" + role),
        sourceKey: "development:" + role,
        generation: 1,
        hostEpoch: "host",
        processEpoch: "process" + i,
      },
    ]),
  );
  const binding = {
    contributionId: ownerId + ".panel",
    kind: "panel",
    panelInstance: "panel",
    uiResourceGeneration: 1,
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process0",
  };
  const r = {
    claim: "synthetic-python-stdio-parity",
    stage: "complete",
    failures: [],
    wire: [],
    launches: Object.entries(owners).map(([role, owner]) => ({ role, owner })),
    exits: Object.values(owners).map((owner) => ({ owner, exit: { code: 0 } })),
    drains: [],
    checkpoints: { binding, copy: { text: "Python copy" } },
    logs: ['STDIO_RESULT:{"missing_action_ref_local":2}'],
    cleanup: { bridge: { pending: 0 }, worker: { jobs: 0 }, workers: 0 },
  };
  function pair(role, method, params, result, direction = "plugin-host", raw = false) {
    const id = ++sequence,
      owner = owners[role];
    r.wire.push({
      owner,
      direction,
      sequence: id,
      at: id,
      message: { jsonrpc: "2.0", id, method, params },
    });
    r.wire.push({
      owner,
      direction: direction === "plugin-host" ? "host-plugin" : "plugin-host",
      sequence: ++sequence,
      at: sequence,
      message: { jsonrpc: "2.0", id, result: raw ? result : { ok: true, value: result } },
    });
  }
  const own = (m, p, v) => pair("owner", m, p, v),
    denied = (role, m, p, code) =>
      pair(role, m, p, { ok: false, error: { code } }, "plugin-host", true);
  for (const role of Object.keys(owners)) {
    pair(role, "initialize", { apiVersion: "1.8.0" }, { apiVersion: "1.8.0" }, "host-plugin", true);
    pair(
      role,
      "ui/negotiate",
      { commandEnvelopeVersions: [1], uiResourceVersions: [1, 2] },
      { commandEnvelopeVersions: [1], uiResourceVersions: [1, 2] },
      "host-plugin",
    );
  }
  own(
    "ui/formPatch",
    { binding, baseFormRevision: 0, set: { draft: "Python" } },
    { formRevision: 1, form: { draft: "Python" } },
  );
  denied(
    "owner",
    "ui/formPatch",
    { binding, baseFormRevision: 0, set: { draft: "stale" } },
    "PLUGIN_E_STALE_RESOURCE",
  );
  const header = { kind: "code" },
    entries = ["Python\n", "42\n"],
    canonical = Buffer.from(JSON.stringify([header, entries]));
  const address = { binding, dataset: "code" },
    begin = {
      ...address,
      baseRevision: 0,
      presentation: 1,
      header,
      entryCount: 2,
      byteLength: canonical.length,
      sha256: hash(canonical),
    };
  own("ui/dataBegin", begin, { transfer: "transfer", nextOffset: 0 });
  for (let i = 0; i < 2; i++)
    own(
      "ui/dataChunk",
      { ...address, transfer: "transfer", offset: 0, chunk: { kind: "code", entries } },
      { nextOffset: 2 },
    );
  const metadata = {
    revision: 1,
    presentation: 1,
    byteLength: canonical.length,
    sha256: hash(canonical),
  };
  own("ui/dataCommit", { ...address, transfer: "transfer" }, metadata);
  for (let offset = 0; offset < 3; offset++)
    own(
      "ui/dataRead",
      { ...address, revision: 1, offset, limit: 1 },
      {
        ...metadata,
        header,
        chunk: { kind: "code", entries: entries.slice(offset, offset + 1) },
        nextOffset: Math.min(offset + 1, 2),
        done: offset >= 1,
      },
    );
  denied(
    "owner",
    "ui/dataRead",
    { ...address, revision: 2, offset: 0, limit: 1 },
    "PLUGIN_E_STALE_RESOURCE",
  );
  own("ui/dataSnapshot", { binding }, { datasets: [{ dataset: "code", ...metadata }] });
  own("ui/dataBegin", { ...begin, baseRevision: 1, presentation: 2 }, { transfer: "aborted" });
  own("ui/dataAbort", { ...address, transfer: "aborted" }, { aborted: true });
  denied("owner", "ui/dataCommit", { ...address, transfer: "aborted" }, "PLUGIN_E_STALE_RESOURCE");
  own("ui/subscribe", { binding, topics: ["data"] }, { subscriptionId: "subscription" });
  r.wire.push({
    owner: owners.owner,
    direction: "host-plugin",
    sequence: ++sequence,
    message: {
      method: "events/deliver",
      params: { subscriptionId: "subscription", kind: "ui.data" },
    },
  });
  own("events/ack", { subscriptionId: "subscription", sequence: 1 }, {});
  own("ui/snapshot", { subscriptionId: "subscription" }, {});
  own("events/unsubscribe", { subscriptionId: "subscription" }, { removed: true });
  denied("foreign", "ui/dataSnapshot", { binding }, "PLUGIN_E_STALE_RESOURCE");
  denied("foreign", "storage/readChunk", { read: "pin" }, "PLUGIN_E_STALE_RESOURCE");
  denied(
    "foreign",
    "devices/recording/query",
    { reservationId: "reservation" },
    "PLUGIN_E_DEVICE_UNAVAILABLE",
  );
  denied("denied", "ui/dataSnapshot", { binding }, "PLUGIN_E_STALE_RESOURCE");
  denied("denied", "storage/beginWrite", {}, "PLUGIN_E_PERMISSION_DENIED");
  own(
    "devices/recording/reserve",
    { sessionId: "session", channelIds: ["channel"], expectedSourceRevision: 1 },
    { reservation: { reservationId: "reservation" } },
  );
  own(
    "storage/registerCheckpoint",
    { id: "record", expectedRevision: "old", reservation: "reservation" },
    { checkpoint: "checkpoint" },
  );
  own("devices/recording/release", { reservationId: "reservation" }, {});
  const bytes = Buffer.from("synthetic final payload"),
    meta = {
      id: "record",
      revision: "new",
      checkpoint: "final",
      byteLength: bytes.length,
      sha256: hash(bytes),
    };
  r.drains.push({
    offer: { owner: owners.owner, token: "drain", checkpoints: [{ checkpoint: "checkpoint" }] },
    report: {
      state: "saved",
      blocker: false,
      errors: [],
      records: [{ id: "record", committedRevision: "new", final: true }],
    },
  });
  const final = {
    target: { mode: "replace", id: "record", expectedRevision: "old" },
    checkpoint: { handle: "checkpoint", phase: "final" },
    byteLength: bytes.length,
    sha256: hash(bytes),
  };
  denied(
    "owner",
    "storage/beginWrite",
    { ...final, drainToken: "stale-token" },
    "PLUGIN_E_STALE_RESOURCE",
  );
  own(
    "storage/beginWrite",
    { target: { mode: "create" } },
    { write: "initial-write", id: "record" },
  );
  own(
    "storage/commitWrite",
    { write: "initial-write" },
    { record: { ...meta, revision: "old", checkpoint: "none" } },
  );
  own("storage/openRead", { id: "record", expectedRevision: "old" }, { read: "pin" });
  own("storage/beginWrite", { ...final, drainToken: "drain" }, { write: "final-write" });
  own(
    "storage/writeChunk",
    { write: "final-write", offset: 0, data: bytes.toString("base64") },
    { receivedBytes: bytes.length },
  );
  own("storage/commitWrite", { write: "final-write", drainToken: "drain" }, { record: meta });
  pair(
    "owner",
    "storage/drain",
    { token: "drain" },
    { status: "submitted", writes: ["final-write"] },
    "host-plugin",
  );
  own("storage/stat", { id: "record" }, { record: meta });
  own(
    "storage/openRead",
    { id: "record", expectedRevision: "new" },
    { read: "final-read", record: meta },
  );
  own(
    "storage/readChunk",
    { read: "final-read", offset: 0 },
    { eof: true, data: bytes.toString("base64") },
  );
  denied(
    "owner",
    "ui/copyText",
    { actionRef: "invalid", text: "Python copy" },
    "PLUGIN_E_PERMISSION_DENIED",
  );
  pair(
    "owner",
    "command/invoke",
    { command: ownerId + ".copy", context: { actionRef: "real-claim", origin: "panel", binding } },
    { output: { copied: true }, fieldErrors: [] },
    "host-plugin",
  );
  own("ui/copyText", { actionRef: "real-claim", text: "Python copy" }, { copied: true });
  denied(
    "owner",
    "ui/copyText",
    { actionRef: "real-claim", text: "Python copy" },
    "PLUGIN_E_PERMISSION_DENIED",
  );
  denied("owner", "storage/exportBegin", { actionRef: "invalid" }, "PLUGIN_E_PERMISSION_DENIED");
  return r;
}
const request = (r, m, n = 0) => r.wire.filter((w) => w.message.method === m)[n];
const reply = (r, m, n = 0) => {
  const q = request(r, m, n);
  return r.wire.find(
    (w) =>
      w.owner.pluginId === q.owner.pluginId && w.message.id === q.message.id && !w.message.method,
  ).message.result;
};
test("generated manifests and actual v2 resource semantics validate", () => {
  for (const role of ["owner", "foreign", "denied"]) {
    const d = documents(role);
    pluginManifestSchema.parse(d.manifest);
    if (role === "owner") {
      const result = validateUiResourceV2(
        d.panel,
        {
          pluginId: ownerId,
          commands: d.manifest.contributes.commands.filter((c) => c.invocation === "context-v1"),
          panels: d.manifest.contributes.panels,
        },
        Buffer.byteLength(JSON.stringify(d.panel)),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
    } else {
      assert.equal(
        validateUiResourceV2(
          d.status,
          { pluginId: d.manifest.id, commands: [], panels: [] },
          Buffer.byteLength(JSON.stringify(d.status)),
        ).ok,
        true,
      );
    }
  }
});
test("coherent UNIT receipt passes; not native evidence", () => {
  assert.equal(verifyStdio(fixture()).finalWrite, "final-write");
});
for (const [name, mutate] of [
  [
    "foreign correlated response cannot satisfy owner",
    (r) => {
      request(r, "ui/dataCommit").owner = r.launches[1].owner;
    },
  ],
  [
    "stale form unexpectedly accepted",
    (r) => {
      reply(r, "ui/formPatch", 1).ok = true;
    },
  ],
  [
    "wrong dataset digest",
    (r) => {
      request(r, "ui/dataBegin").message.params.sha256 = "0".repeat(64);
    },
  ],
  [
    "wrong entry page offset",
    (r) => {
      reply(r, "ui/dataRead").value.nextOffset = 2;
    },
  ],
  [
    "lost shared ui.data event",
    (r) => {
      r.wire = r.wire.filter((w) => w.message.method !== "events/deliver");
    },
  ],
  [
    "foreign dataset access accepted",
    (r) => {
      reply(r, "ui/dataSnapshot", 1).ok = true;
    },
  ],
  [
    "random handle cannot substitute for cross-owner pinned handle",
    (r) => {
      request(r, "storage/readChunk").message.params.read = "not-the-owner-pin";
    },
  ],
  [
    "random reservation is not cross-owner evidence",
    (r) => {
      request(r, "devices/recording/query").message.params.reservationId = "other";
    },
  ],
  [
    "random binding is not cross-owner evidence",
    (r) => {
      request(r, "ui/dataSnapshot", 1).message.params.binding = {
        ...r.checkpoints.binding,
        panelInstance: "other",
      };
    },
  ],
  [
    "permission unexpectedly admitted",
    (r) => {
      reply(r, "storage/beginWrite").ok = true;
    },
  ],
  [
    "submitted alone is not saved",
    (r) => {
      r.drains[0].report.state = "uncertain";
    },
  ],
  [
    "different drain token",
    (r) => {
      r.wire.find(
        (w) => w.message.method === "storage/beginWrite" && w.message.params.drainToken === "drain",
      ).message.params.drainToken = "new-token";
    },
  ],
  [
    "wrong submitted handle",
    (r) => {
      reply(r, "storage/drain").value.writes = ["old-write"];
    },
  ],
  [
    "wrong host saved revision",
    (r) => {
      r.drains[0].report.records[0].committedRevision = "old";
    },
  ],
  [
    "pinned bytes altered",
    (r) => {
      reply(r, "storage/readChunk", 1).value.data = Buffer.from("bad").toString("base64");
    },
  ],
  [
    "copy forged claim",
    (r) => {
      request(r, "command/invoke").message.params.context.actionRef = "invented";
    },
  ],
  [
    "copy replay accepted",
    (r) => {
      reply(r, "ui/copyText", 2).ok = true;
    },
  ],
  [
    "clipboard mismatch",
    (r) => {
      r.checkpoints.copy.text = "wrong";
    },
  ],
  [
    "worker leak",
    (r) => {
      r.cleanup.workers = 1;
    },
  ],
  [
    "old v1 negotiation",
    (r) => {
      reply(r, "ui/negotiate").value.uiResourceVersions = [1];
    },
  ],
])
  test(name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => verifyStdio(r));
  });
