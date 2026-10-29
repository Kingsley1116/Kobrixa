import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  assertRendererLossObservation,
  assertRendererLossEvidence,
  rendererLossSummary,
} from "./plugin-persistence-renderer-loss.ts";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
import { verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Pure oracle specimen only: none of these synthetic observations claim native execution.
function specimen() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    hostEpoch: id(1),
    processEpoch: id(2),
    generation: 1,
  };
  const nextOwner = { ...owner, processEpoch: id(3), generation: 2 };
  const principal = { kind: "plugin", owner, authorityContext: { ref: id(4) } };
  const scope = { hostEpoch: id(1), workbenchInstance: id(5) };
  const binding = {
    hostEpoch: id(1),
    processEpoch: id(2),
    generation: 1,
    kind: "panel",
    contributionId: "acceptance.ui-recording.panel",
    panelInstance: id(6),
    uiResourceGeneration: 1,
  };
  const bytes = Buffer.from("Renderer loss unfinished write sentinel\n");
  const rows = [];
  const row = (name, start, end, args, result) => rows.push({ name, start, end, args, result });
  const ok = (value) => ({ ok: true, value });
  const denied = { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } };
  row(
    "storage/beginWrite",
    20,
    21,
    {
      principal,
      params: {
        target: { mode: "create" },
        byteLength: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    },
    ok({ write: id(7), id: id(8), expiresAt: 30020 }),
  );
  row(
    "storage/writeChunk",
    22,
    23,
    { principal, params: { write: id(7), offset: 0, data: bytes.toString("base64") } },
    ok({ receivedBytes: bytes.length, expiresAt: 30022 }),
  );
  const params = {
    sessionId: id(9),
    contextRef: id(4),
    motionScopeRef: id(10),
    gestureRef: id(11),
    motion: { actuatorId: "motor", mode: "jog", power: 1, direction: 1, brake: true },
  };
  row(
    "prepare",
    24,
    25,
    { principal, params },
    ok({
      operation: { operationId: id(12), sessionId: id(9), stage: "prepared", startAccepted: false },
    }),
  );
  row(
    "invoke",
    26,
    28,
    { binding, nodeId: "run", formRevision: 1, form: { speed: -90, mode: "coast" } },
    ok({ output: { "action-ref": id(13) } }),
  );
  row(
    "old-action",
    42,
    43,
    { principal, params: { actionRef: id(13), text: "renderer-loss sentinel" } },
    denied,
  );
  row("old-gesture", 42, 44, { principal, params }, denied);
  row("old-epoch", 42, 45, { principal, params: { schemaVersion: 1 } }, denied);
  row("old-commit", 42, 46, { principal, params: { write: id(7) } }, denied);
  return {
    owner,
    nextOwner,
    nextPrincipal: { kind: "plugin", owner: nextOwner, authorityContext: { ref: id(14) } },
    principal,
    scope,
    rows,
    launches: [
      { owner, at: 1 },
      { owner: nextOwner, at: 205 },
    ],
    subscribedAt: 10,
    exit: { owner, at: 60, event: { code: 0 } },
    loss: {
      start: 30,
      end: 70,
      renderer: {
        pid: 123,
        at: 40,
        reason: "crashed",
        exitCode: 139,
        osExit: { at: 65, code: "ESRCH" },
      },
    },
    intent: {
      scope: id(10),
      gesture: id(11),
      binding: {
        owner,
        contextRef: id(4),
        panelInstance: id(6),
        uiResourceGeneration: 1,
        workbenchInstance: id(5),
      },
      lastPulse: 29,
    },
    mint: { owner, scope, generation: 1, action: id(13), at: 27 },
    retired: [{ owner, reason: "renderer-lost", at: 41 }],
    drains: [
      {
        owner,
        reason: "renderer-crash",
        start: 47,
        end: 59,
        offer: {
          owner,
          reason: "renderer-crash",
          deadlineMonotonicMs: 10040,
          writes: [{ write: id(7), id: id(8), state: "receiving" }],
        },
        report: {
          state: "checkpoint-only",
          records: [{ id: id(8), final: false, committedRevision: null, payload: "none" }],
        },
      },
    ],
    idle: { start: 71, end: 196, owners: [] },
    restart: {
      start: 200,
      end: 210,
      command: "acceptance.ui-recording.legacy",
      result: { ok: true },
    },
    trace: [],
  };
}
const row = (o, n) => o.rows.find((r) => r.name === n);
test("renderer-loss pure specimen satisfies correlated raw and derived outcome oracles", () => {
  const o = specimen();
  assertRendererLossObservation(o);
  assertRendererLossEvidence(
    { rendererLoss: o, checks: rendererLossSummary(o) },
    o.owner.hostEpoch,
  );
  assert.deepEqual(selectFoundationCases({ caseId: "renderer-loss" }), ["renderer-loss"]);
});
const mutations = {
  "drain omits original record": (o) => {
    o.drains[0].report.records = [];
  },
  "drain invents committed record": (o) => {
    o.drains[0].report.records[0].committedRevision = 1;
  },
  "wrong replacement principal": (o) => {
    o.nextPrincipal.owner = o.owner;
  },
  "old document reused": (o) => {
    o.nextPrincipal.authorityContext = o.principal.authorityContext;
  },
  "uncorrelated drain write": (o) => {
    o.drains[0].offer.writes[0].write = id(50);
  },
  "different drain record": (o) => {
    o.drains[0].offer.writes[0].id = id(50);
  },
  "sealed before loss": (o) => {
    o.drains[0].offer.writes[0].state = "sealed";
  },
  "different prepared session": (o) => {
    row(o, "prepare").result.value.operation.sessionId = id(50);
  },
  "motion already started": (o) => {
    row(o, "prepare").result.value.operation.startAccepted = true;
  },
  "invalid panel identity": (o) => {
    row(o, "invoke").args.binding.panelInstance = "panel";
  },
  "missing original child exit": (o) => {
    delete o.exit;
  },
  "other child exit": (o) => {
    o.exit.owner = o.nextOwner;
  },
  "late exit subscription": (o) => {
    o.subscribedAt = 50;
  },
  "exit before crash": (o) => {
    o.exit.at = 29;
  },
  "renderer still alive": (o) => {
    o.loss.renderer.osExit.code = "EPERM";
  },
  "fabricated pending loss": (o) => {
    o.loss.renderer.reason = "pending";
  },
  "missing native PID": (o) => {
    o.loss.renderer.pid = 0;
  },
  "wrong retirement": (o) => {
    o.retired[0].reason = "disabled";
  },
  "missing drain": (o) => {
    o.drains = [];
  },
  "wrong drain owner": (o) => {
    o.drains[0].owner = o.nextOwner;
  },
  "new owner probe": (o) => {
    row(o, "old-epoch").args.principal = { ...o.principal, owner: o.nextOwner };
  },
  "unrelated write": (o) => {
    row(o, "old-commit").args.params.write = id(50);
  },
  "wrong chunk bytes": (o) => {
    row(o, "storage/writeChunk").args.params.data = "eA==";
  },
  "wrong old action": (o) => {
    row(o, "old-action").args.params.actionRef = id(50);
  },
  "wrong gesture": (o) => {
    row(o, "old-gesture").args.params = structuredClone(row(o, "prepare").args.params);
    row(o, "old-gesture").args.params.gestureRef = id(50);
  },
  "baseline gesture denied": (o) => {
    row(o, "prepare").result = { ok: false };
  },
  "action mint failed": (o) => {
    row(o, "invoke").result = { ok: false };
  },
  "other mint owner": (o) => {
    o.mint.owner = o.nextOwner;
  },
  "wrong mint scope": (o) => {
    o.mint.scope = { ...o.scope, workbenchInstance: id(50) };
  },
  "wrong mint UI generation": (o) => {
    o.mint.generation = 2;
  },
  "wrong binding epoch": (o) => {
    row(o, "invoke").args.binding.processEpoch = id(50);
  },
  "pre-retirement probe": (o) => {
    row(o, "old-gesture").start = 30;
  },
  "expired action": (o) => {
    row(o, "old-action").end = 5027;
  },
  "expired gesture": (o) => {
    row(o, "old-gesture").end = 379;
    o.loss.end = 400;
    o.idle = { start: 401, end: 526, owners: [] };
    o.restart.start = 530;
    o.restart.end = 540;
    o.launches[1].at = 535;
  },
  "expired write": (o) => {
    row(o, "old-commit").end = 30020;
  },
  "automatic relaunch": (o) => {
    o.launches[1].at = 100;
  },
  "extra launch": (o) => {
    o.launches.push(o.launches[1]);
  },
  "live owner before explicit restart": (o) => {
    o.idle.owners = [o.nextOwner];
  },
  "no idle observation": (o) => {
    o.idle.end = o.idle.start;
  },
  "old generation reused": (o) => {
    o.nextOwner = { ...o.nextOwner, generation: 1 };
  },
  "old process reused": (o) => {
    o.nextOwner = { ...o.nextOwner, processEpoch: o.owner.processEpoch };
  },
  "failed explicit command": (o) => {
    o.restart.result.ok = false;
  },
  "stale commit published": (o) => {
    o.trace.push({ ticket: id(7), point: "before-publish", time: 50 });
  },
  "missing probe": (o) => {
    o.rows = o.rows.filter((r) => r.name !== "old-action");
  },
  "duplicate probe": (o) => {
    o.rows.push(row(o, "old-action"));
  },
};
for (const name of ["old-action", "old-gesture", "old-epoch", "old-commit"])
  mutations[`${name} accepted`] = (o) => {
    row(o, name).result = { ok: true, value: {} };
  };
for (const [name, mutate] of Object.entries(mutations))
  test(`renderer-loss rejects ${name}`, () => {
    const o = specimen();
    mutate(o);
    assert.throws(() => assertRendererLossObservation(o));
  });
test("renderer-loss rejects summary-only receipts and mismatched host/checks", () => {
  assert.throws(
    () =>
      verifyRunReceipt({ case: "renderer-loss", evidence: outcomeOracleFixture("renderer-loss") }),
    /raw proof/,
  );
  const o = specimen(),
    evidence = { rendererLoss: o, checks: rendererLossSummary(o) };
  assert.throws(() => assertRendererLossEvidence(evidence, id(80)));
  evidence.checks.oldActionDenied = false;
  assert.throws(() => assertRendererLossEvidence(evidence));
});
test("renderer-loss producer modules import inertly and wiring uses actual shared crash/launcher", async () => {
  const source = await readFile(new URL("./plugin-persistence-main.ts", import.meta.url), "utf8");
  assert.match(source, /const retirement = retireActionRenderer\(false\)/);
  assert.match(source, /win.webContents.forcefullyCrashRenderer\(\)/);
  assert.match(source, /const launch = createDesktopLauncher\(\{\s*\.\.\.hooks,/);
  assert.match(source, /crash: crashRenderer/);
  assert.match(source, /destroyRenderer: \(\) => crashRenderer\(\)/);
});
