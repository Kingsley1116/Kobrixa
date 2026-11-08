import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertRendererLossObservation,
  assertRendererLossEvidence,
  rendererLossSummary,
} from "./plugin-persistence-renderer-loss.ts";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
import { verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
import { rendererLossOracle as specimen } from "./fixtures/plugin-persistence/renderer-loss-oracle.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
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
