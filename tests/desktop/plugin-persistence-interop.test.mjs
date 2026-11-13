import { sealedTtlOracle } from "./fixtures/plugin-persistence/sealed-ttl-oracle.mjs";
import { sealedTtlSummary } from "./plugin-persistence-sealed-ttl.ts";
import { unknownOracle } from "./fixtures/plugin-persistence/unknown-oracle.mjs";
import { unknownSummary } from "./plugin-persistence-unknown.ts";
import { actionReplayOracle } from "./fixtures/plugin-persistence/action-replay-oracle.mjs";
import { actionSummary } from "./plugin-persistence-action-replay.ts";
import { optionalOffOracle } from "./fixtures/plugin-persistence/optional-off-oracle.mjs";
import { rendererLossOracle } from "./fixtures/plugin-persistence/renderer-loss-oracle.mjs";
import { rendererLossSummary } from "./plugin-persistence-renderer-loss.ts";
import test from "node:test";
import { contentionOracle } from "./fixtures/plugin-persistence/contention-oracle.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
import assert from "node:assert/strict";
import {
  diagnosticError,
  readEvidence,
  verifyMatrix,
  verifyInterop,
} from "./plugin-persistence-harness.mjs";

test("entry diagnostics retain bounded causes and aggregate construction failures", () => {
  const cause = new Error("missing settings payload");
  const error = new AggregateError(
    [new Error("activation failed"), new Error("settings unavailable", { cause })],
    "construction failed",
  );
  const result = diagnosticError(error);
  assert.equal(result.message, "construction failed");
  assert.equal(result.errors[0].message, "activation failed");
  assert.equal(result.errors[1].cause.message, "missing settings payload");
  cause.cause = cause;
  assert.doesNotThrow(() => JSON.stringify(diagnosticError(cause)));
  assert.equal(diagnosticError(new AggregateError(Array(40).fill(error))).errors.length, 16);
});

test("B2 §10: every negative row has real reopened state evidence", async () => {
  const report = await readEvidence();
  verifyMatrix(report);
});
test("B2 §12.1: JS MessagePort and Python stdio use the current public router", async () => {
  verifyInterop(await readEvidence());
});
test("evidence gates reject absent and mock-only acceptance", async () => {
  await assert.rejects(readEvidence(""), /PERSISTENCE_EVIDENCE/);
  assert.throws(() => verifyMatrix({ level: "unit", cases: [] }), /real-process/);
  assert.throws(() => verifyInterop({ consumers: [] }), /two consumers/);
});

import ts from "typescript";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function assertNoConstantProducerChecks(source) {
  const file = ts.createSourceFile(
    "plugin-persistence-main.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constants = new Map();
  const visitDeclarations = (node) => {
    if (ts.isVariableDeclarationList(node) && node.flags & ts.NodeFlags.Const)
      for (const declaration of node.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          // Ambiguous names are not resolved across lexical scopes.
          const name = declaration.name.text;
          constants.set(name, constants.has(name) ? null : declaration.initializer);
        }
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(file);
  function constant(node, seen = new Set()) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node)
    )
      return constant(node.expression, seen);
    if (
      ts.isLiteralExpression(node) ||
      [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(
        node.kind,
      )
    )
      return true;
    if (ts.isIdentifier(node)) {
      if (seen.has(node.text)) return false;
      const initializer = constants.get(node.text);
      return initializer ? constant(initializer, new Set([...seen, node.text])) : false;
    }
    if (ts.isPrefixUnaryExpression(node)) return constant(node.operand, seen);
    if (ts.isBinaryExpression(node)) return constant(node.left, seen) && constant(node.right, seen);
    if (ts.isConditionalExpression(node))
      return (
        constant(node.condition, seen) &&
        constant(node.whenTrue, seen) &&
        constant(node.whenFalse, seen)
      );
    if (ts.isArrayLiteralExpression(node))
      return node.elements.every((value) => constant(value, seen));
    return false;
  }
  const checks = [];
  const name = (node) =>
    ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined;
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      name(node.name) === "checks" &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        assert.ok(
          ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property),
          "Producer checks must have explicit keys; no spread/default evidence",
        );
        const expression = ts.isPropertyAssignment(property) ? property.initializer : property.name;
        assert.ok(!constant(expression), `Constant producer check: ${name(property.name)}`);
        checks.push({
          key: name(property.name),
          start: expression.getStart(file),
          end: expression.end,
          shorthand: ts.isShorthandPropertyAssignment(property),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(checks.length > 0, "Missing producer check expressions");
  return checks;
}

test("producer checks reject literal and constant-alias replacements", async () => {
  const source = (
    await Promise.all(
      ["plugin-persistence-main.ts", "plugin-persistence-contention.ts"].map((file) =>
        readFile(new URL(file, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  const checks = assertNoConstantProducerChecks(source);
  for (const check of checks) {
    for (const replacement of ["true", "false", "0", '"committed"', "[50, 50, 50]"]) {
      const value = check.shorthand ? `${check.key}: ${replacement}` : replacement;
      const changed = source.slice(0, check.start) + value + source.slice(check.end);
      assert.throws(
        () => assertNoConstantProducerChecks(changed),
        /Constant producer check/,
        `constant substitution for ${check.key}`,
      );
    }
  }
  assert.throws(
    () =>
      assertNoConstantProducerChecks(
        "const expected = true; function producer() { return {checks:{observed:expected}}; }",
      ),
    /Constant producer check/,
  );
});

import {
  verifyRunReceipt,
  verifyDiagnostics,
  verifyFoundationReports,
} from "./plugin-persistence-harness.mjs";
// Pure oracle fixtures below are never persisted or offered as acceptance evidence.
const receiptFixture = () => ({
  level: "real-process",
  status: "passed",
  runId: "unit-oracle",
  evidence: outcomeOracleFixture("retirement"),
  case: "retirement",
  commit: "a".repeat(40),
  bundleSha256: "b".repeat(64),
  artifactSha256: "c".repeat(64),
  pid: 123,
  hostEpoch: "00000000-0000-4000-8000-000000000001",
  profileId: "unit-profile",
  exitCode: 0,
  signal: null,
  closedAt: 10,
  exitedAt: 11,
  reportedAt: 12,
  cleanup: { workers: 0, listeners: 0, children: 0, errors: [] },
  workerTrace: [
    { kind: "start", count: 1, pid: 123 },
    { kind: "exit", count: 0, pid: 123 },
  ],
});
test("verifier negatives: reject stale, premature, absent, failed and leaked receipts", () => {
  const expected = { runId: "unit-oracle", case: "retirement", bundleSha256: "b".repeat(64) };
  verifyRunReceipt(receiptFixture(), expected);
  for (const mutate of [
    (r) => delete r.bundleSha256,
    (r) => (r.exitCode = 1),
    (r) => (r.reportedAt = 9),
    (r) => (r.exitedAt = 9),
    (r) => (r.runId = "old"),
    (r) => (r.level = "unit"),
    (r) => (r.workerTrace = []),
    (r) => (r.cleanup.workers = 1),
    (r) => (r.cleanup.errors = ["close failed"]),
    (r) => (r.cleanup.children = -1),
  ]) {
    const r = receiptFixture();
    mutate(r);
    assert.throws(() => verifyRunReceipt(r, expected));
  }
});
test("receipt gate rejects missing or failed case evidence after a clean exit", () => {
  for (const patch of [
    { evidence: undefined },
    { case: "healthy-release", evidence: { checks: { retireCalls: 1 }, events: [], samples: {} } },
    { case: "not-a-case", evidence: { checks: {}, events: [], samples: {} } },
  ])
    assert.throws(() => verifyRunReceipt({ ...receiptFixture(), ...patch }));
});

test("verifier negatives: reject missing and duplicate case receipts", () => {
  assert.throws(
    () => verifyFoundationReports([], ["retirement", "healthy-release"]),
    /case receipts/,
  );
  assert.throws(
    () =>
      verifyFoundationReports(
        [receiptFixture(), receiptFixture()],
        ["retirement", "healthy-release"],
      ),
    /case receipts/,
  );
});
test("verifier negatives: diagnostic owners cannot duplicate counters or omit modules", () => {
  assert.throws(() => verifyDiagnostics([]), /diagnostic modules/);
  assert.throws(
    () => verifyDiagnostics([{ module: "ui-state", instance: "x", snapshot: { owners: 1 } }]),
    /diagnostic/,
  );
});

import {
  preflight,
  runFoundationEvidence,
  selectFoundationCases,
} from "./plugin-persistence-run.mjs";
test("BM-20 reference cases execute through createFoundationFixture", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "w10-reference-evidence-"));
  const result = await runFoundationEvidence({
    referencesOnly: true,
    evidencePath: path.join(directory, "references.json"),
  });
  verifyFoundationReports(result.reports, ["retirement", "healthy-release"]);
});
test("verifier negatives: absent attachments fail closed before native allocation", async () => {
  await assert.rejects(preflight(""), /BLOCKED.*|missing|Missing/);
});

import { spawnSync } from "node:child_process";
import {
  foundationBuiltinRoles,
  FOUNDATION_CASES,
  FOUNDATION_CHECKS,
  assertFoundationEvidence,
} from "./plugin-persistence-main.ts";
test("verifier negatives: every declared foundation observation is required", () => {
  assert.equal(FOUNDATION_CASES.length, 15);
  assert.deepEqual(Object.keys(FOUNDATION_CHECKS).sort(), [...FOUNDATION_CASES].sort());
  for (const id of FOUNDATION_CASES) {
    const required = FOUNDATION_CHECKS[id];
    const evidence = id === "contention" ? contentionOracle() : outcomeOracleFixture(id);
    if (id === "registration-end") {
      const oracle = registrationOracle();
      Object.assign(evidence.checks, oracle.checks);
      evidence.registration = oracle.registration;
    }
    if (id === "renderer-loss") {
      const oracle = rendererLossOracle();
      Object.assign(evidence, { rendererLoss: oracle, checks: rendererLossSummary(oracle) });
    }
    if (id === "sealed-ttl") {
      const oracle = sealedTtlOracle();
      Object.assign(evidence, { sealedTtl: oracle, checks: sealedTtlSummary(oracle) });
    }
    if (id === "unknown-publication") {
      const oracle = unknownOracle();
      Object.assign(evidence, { unknown: oracle, checks: unknownSummary(oracle) });
    }
    if (id === "action-replay") {
      const oracle = actionReplayOracle();
      Object.assign(evidence, { actionReplay: oracle, checks: actionSummary(oracle) });
    }
    if (id === "all-optional-off") Object.assign(evidence, optionalOffOracle().evidence);
    assertFoundationEvidence(id, evidence);
    for (const key of required.checks) {
      const altered = structuredClone(evidence);
      delete altered.checks[key];
      assert.throws(() => assertFoundationEvidence(id, altered), /missing check/);
    }
    for (const kind of required.events) {
      const altered = structuredClone(evidence);
      altered.events = altered.events.filter((e) => e.kind !== kind);
      assert.throws(() => assertFoundationEvidence(id, altered), /missing event/);
    }
    for (const key of required.samples) {
      const altered = structuredClone(evidence);
      delete altered.samples[key];
      assert.throws(() => assertFoundationEvidence(id, altered), /missing sample/);
    }
  }
});
test("verifier negatives: inert import and second factory rejection precede allocation", () => {
  const moduleUrl = new URL("./plugin-persistence-main.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      ...process.execArgv,
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const before=process.getActiveResourcesInfo();
    const m=await import(${JSON.stringify(moduleUrl)});
    assert.deepEqual(process.getActiveResourcesInfo().filter(x=>!x.includes('FSReq')),before.filter(x=>!x.includes('FSReq')));
    await assert.rejects(m.createFoundationFixture(),/missing controller artifact/);
    await assert.rejects(m.createFoundationFixture(),/second factory forbidden/);
  `,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

import { missingCompositionExports } from "./plugin-persistence-run.mjs";
test("T7fix I1: implemented exports are recognized, absent and near names rejected", () => {
  const names = [
    "composeDesktopMain",
    "desktopFoundationTestHandles",
    "desktopUi",
    "desktopLifecycle",
  ];
  for (const asyncKeyword of ["", "async "]) {
    const source = names.map((name) => `export ${asyncKeyword}function ${name}() {}`).join("\n");
    assert.deepEqual(missingCompositionExports(source), []);
    for (const name of names) {
      for (const replacement of [
        `function ${name}() {}`,
        `export function ${name}Extra() {}`,
        `export declare function ${name}(): void;`,
        `// export function ${name}() {}`,
      ]) {
        const changed = source.replace(`export ${asyncKeyword}function ${name}() {}`, replacement);
        assert.deepEqual(missingCompositionExports(changed), [name]);
      }
    }
  }
});

import {
  superviseCase,
  createOwnedProcessTracker,
  parseProcessTable,
  readEntryFailure,
} from "./plugin-persistence-run.mjs";
import { runReferenceEntry } from "./plugin-persistence-harness.mjs";
// Pure controller-flow model: no OS calls, child processes, SDKs or acceptance reports.
function controllerModel(mode) {
  let time = 0,
    exit,
    rows = [],
    failure,
    candidate = receiptFixture();
  const actions = [];
  const parent = { pid: 100, ppid: 1, pgid: 100, start: "parent-birth" };
  const descendant = { pid: 101, ppid: 100, pgid: 100, start: "child-birth" };
  const io = {
    now: () => time,
    async start() {
      rows = [parent, descendant];
      return { pid: 100, exit: () => exit };
    },
    async processes() {
      actions.push("observe");
      return structuredClone(rows);
    },
    async sleep(ms) {
      time += ms;
      if (mode !== "timeout" && !exit) {
        exit = { code: mode === "nonzero" ? 7 : 0, signal: null };
        rows = mode === "success" ? [] : [{ ...descendant, ppid: 1 }];
      }
    },
    async killGroup(pgid) {
      actions.push(`kill-group:${pgid}`);
      rows = rows.filter((r) => r.pgid !== pgid);
      exit ??= { code: null, signal: "SIGKILL" };
    },
    async killProcess(row) {
      actions.push(`kill:${row.pid}`);
      rows = rows.filter((r) => r.pid !== row.pid);
    },
    async readCandidate() {
      actions.push("candidate");
      if (mode === "nonzero")
        return {
          entryFailure: {
            originalError: { name: "Error", message: "fixture failed" },
            cleanupErrors: [],
          },
        };
      return {
        candidate: {
          ...candidate,
          pid: 100,
          workerTrace: candidate.workerTrace.map((row) => ({ ...row, pid: 100 })),
          status: "closed-reference",
        },
      };
    },
    async writeFailure(receipt) {
      actions.push("failure");
      failure = receipt;
    },
    reportFailure() {
      actions.push("fallback");
    },
  };
  return {
    io,
    actions,
    get failure() {
      return failure;
    },
    setRows(value) {
      rows = value;
    },
    setCandidate(value) {
      candidate = value;
    },
  };
}
for (const mode of ["timeout", "nonzero"])
  test(`T7fix I3: ${mode} finalizes descendants and retains failure`, async () => {
    const model = controllerModel(mode);
    await assert.rejects(
      superviseCase({ runId: "flow", profile: "retained-profile" }, model.io, {
        timeoutMs: 200,
        pollMs: 100,
        settleMs: 100,
      }),
      /timeout|fixture failed|exited/i,
    );
    assert.ok(model.actions.includes("kill-group:100"));
    assert.equal(model.failure.status, "failed");
    assert.equal(model.failure.parentExit.observed, true);
    assert.deepEqual(model.failure.remainingChildren, []);
    assert.deepEqual(model.failure.cleanupErrors, []);
    assert.ok(
      model.failure.originalError.message.includes(
        mode === "timeout" ? "timeout" : "fixture failed",
      ),
    );
    assert.equal(model.actions.at(-1), "failure");
  });
test("T7fix I3: normal completion uses the same final observations without cleanup kills", async () => {
  const model = controllerModel("success");
  const receipt = await superviseCase({ case: "retirement" }, model.io, {
    timeoutMs: 200,
    pollMs: 100,
    settleMs: 100,
  });
  assert.equal(receipt.status, "passed");
  assert.equal(model.failure, undefined);
  assert.ok(!model.actions.some((a) => a.startsWith("kill")));
});
test("T7fix I3: cleanup/observation/write errors are retained and never mask original failure", async () => {
  const model = controllerModel("nonzero");
  let reads = 0;
  model.io.processes = async () => {
    if (++reads > 1) throw new Error("ps unavailable");
    return [{ pid: 100, ppid: 1, pgid: 100, start: "parent-birth" }];
  };
  model.io.writeFailure = async (receipt) => {
    model.actions.push(receipt);
    throw new Error("report disk full");
  };
  await assert.rejects(
    superviseCase({ case: "retirement" }, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
    /fixture failed|exited/i,
  );
  const failure = model.actions.find((a) => typeof a === "object");
  assert.equal(failure.status, "failed");
  assert.equal(failure.remainingChildren, null);
  assert.ok(failure.cleanupErrors.some((e) => e.message === "ps unavailable"));
  assert.ok(failure.cleanupErrors.some((e) => e.message === "report disk full"));
  assert.ok(model.actions.includes("fallback"));
});
test("T7fix I3: reused PIDs never become owned parents or cleanup targets", () => {
  const tracker = createOwnedProcessTracker(100);
  tracker.observe([
    { pid: 100, ppid: 1, pgid: 100, start: "original" },
    { pid: 101, ppid: 100, pgid: 100, start: "child" },
  ]);
  const remaining = tracker.observe([
    { pid: 100, ppid: 1, pgid: 900, start: "reused" },
    { pid: 101, ppid: 1, pgid: 100, start: "child" },
    { pid: 102, ppid: 100, pgid: 900, start: "foreign-child" },
  ]);
  assert.deepEqual(
    remaining.map((r) => r.pid),
    [101],
  );
  assert.deepEqual(
    tracker
      .observed()
      .map((r) => r.pid)
      .sort(),
    [100, 101],
  );
});
test("T7fix I3: process table keeps birth identities and permits unrelated system rows", () => {
  const rows = parseProcessTable(
    " 0 0 0 Wed Oct 21 01:00:00 2026\n100 1 100 Wed Oct 21 02:00:00 2026\n",
  );
  const tracker = createOwnedProcessTracker(100);
  assert.deepEqual(tracker.observe(rows), [rows[1]]);
  assert.equal(rows[1].start, "Wed Oct 21 02:00:00 2026");
  assert.throws(() => parseProcessTable("bad process row"));
  assert.throws(() => tracker.observe([rows[1], rows[1]]), /Duplicate/);
});
test("T7fix I3: generated entry retains original and close errors on a distinct failure path", async () => {
  const written = [];
  let closes = 0;
  const code = await runReferenceEntry(
    async () => ({
      composition: { workerCount: 1 },
      runCase: async () => {
        throw new Error("original case error");
      },
      close: async () => {
        closes++;
        throw new Error("close error");
      },
    }),
    { case: "retirement", report: "candidate.json" },
    {
      write: async (file, value) => written.push({ file, value: JSON.parse(value) }),
      now: () => 1,
      pid: 100,
    },
  );
  assert.equal(code, 1);
  assert.equal(closes, 1);
  assert.equal(written.length, 2);
  assert.equal(written[0].file, "candidate.json.entry-failure-pending.json");
  assert.equal(written[0].value.originalError.message, "original case error");
  assert.equal(written[0].value.cleanupState, "pending");
  assert.deepEqual(written[0].value.cleanupErrors, []);
  assert.equal(written[1].file, "candidate.json.entry-failure.json");
  assert.equal(written[1].value.originalError.message, "original case error");
  assert.equal(written[1].value.cleanupState, "failed");
  assert.equal(written[1].value.cleanupErrors[0].message, "close error");
});

test("T7fix I3: failed cleanup records remaining identities and original nonzero exit", async () => {
  const model = controllerModel("nonzero");
  model.io.killGroup = async () => {
    throw new Error("kill denied");
  };
  await assert.rejects(
    superviseCase({ case: "retirement" }, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
    /fixture failed/,
  );
  assert.equal(model.failure.parentExit.code, 7);
  assert.deepEqual(
    model.failure.remainingChildren.map((row) => row.pid),
    [101],
  );
  assert.ok(model.failure.cleanupErrors.some((error) => error.message === "kill denied"));
});
test("T7fix I3: signal exit cleans an owned descendant that changed process groups", async () => {
  const model = controllerModel("nonzero");
  let exit;
  model.io.start = async () => {
    model.setRows([
      { pid: 100, ppid: 1, pgid: 100, start: "parent-birth" },
      { pid: 101, ppid: 100, pgid: 101, start: "child-birth" },
    ]);
    return { pid: 100, exit: () => exit };
  };
  const sleep = model.io.sleep;
  model.io.sleep = async (ms) => {
    await sleep(ms);
    if (!exit) {
      exit = { code: null, signal: "SIGTERM" };
      model.setRows([{ pid: 101, ppid: 1, pgid: 101, start: "child-birth" }]);
    }
  };
  await assert.rejects(
    superviseCase({ case: "retirement" }, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
    /fixture failed/,
  );
  assert.ok(model.actions.includes("kill:101"));
  assert.equal(model.failure.parentExit.signal, "SIGTERM");
  assert.deepEqual(model.failure.remainingChildren, []);
});
test("T7fix I3: PID reuse in the original group cannot revive group ownership", () => {
  const tracker = createOwnedProcessTracker(100);
  tracker.observe([{ pid: 100, ppid: 1, pgid: 100, start: "old" }]);
  assert.deepEqual(
    tracker.observe([
      { pid: 100, ppid: 1, pgid: 100, start: "new" },
      { pid: 102, ppid: 100, pgid: 100, start: "foreign" },
    ]),
    [],
  );
});
test("T7fix I3: entry construction failure writes a diagnostic; cleanup success cannot erase a case failure", async () => {
  for (const construction of [true, false]) {
    const written = [];
    const code = await runReferenceEntry(
      async () => {
        if (construction) throw new Error("construction failed");
        return {
          composition: { workerCount: 1 },
          runCase: async () => {
            throw new Error("case failed");
          },
          close: async () => {},
        };
      },
      { case: "retirement", report: "candidate.json" },
      {
        write: async (file, value) => written.push({ file, value: JSON.parse(value) }),
        now: () => 1,
        pid: 100,
      },
    );
    assert.equal(code, 1);
    assert.equal(written.length, construction ? 1 : 2);
    const final = written.at(-1);
    assert.equal(final.file, "candidate.json.entry-failure.json");
    assert.equal(final.value.status, "failed");
    assert.equal(final.value.cleanupState, "settled");
    assert.deepEqual(final.value.cleanupErrors, []);
    assert.equal(
      final.value.originalError.message,
      construction ? "construction failed" : "case failed",
    );
  }
});

test("T7fix I3: spawn failure and malformed candidate still write failure receipts", async () => {
  for (const mode of ["spawn", "candidate"]) {
    const model = controllerModel("success");
    if (mode === "spawn")
      model.io.start = async () => {
        throw new Error("spawn failed");
      };
    else model.setCandidate({ ...receiptFixture(), bundleSha256: "bad" });
    await assert.rejects(
      superviseCase({ case: "retirement" }, model.io, {
        timeoutMs: 200,
        pollMs: 100,
        settleMs: 100,
      }),
      /spawn failed|match/,
    );
    assert.equal(model.failure.status, "failed");
    assert.equal(model.failure.parentExit.observed, mode !== "spawn");
    assert.deepEqual(model.failure.remainingChildren, []);
  }
});
test("T7fix I3: entry success and failure-write fallback have distinct dispositions", async () => {
  const written = [];
  let live = 1,
    closes = 0;
  const fixture = {
    composition: {
      get workerCount() {
        return live;
      },
      reservationListenerCount: 0,
      profile: { hostEpoch: "observed-epoch" },
    },
    runCase: async () => ({ observed: "oracle-only" }),
    close: async () => {
      closes++;
      live = 0;
    },
    environment: {},
  };
  const code = await runReferenceEntry(
    async () => fixture,
    { report: "candidate.json", case: "retirement" },
    {
      write: async (file, value) => written.push({ file, value: JSON.parse(value) }),
      now: () => 1,
      pid: 100,
    },
  );
  assert.equal(code, 0);
  assert.equal(closes, 2);
  assert.equal(written[0].file, "candidate.json");
  assert.equal(written[0].value.status, "closed-reference");
  assert.deepEqual(
    written[0].value.workerTrace.map((row) => row.count),
    [1, 0],
  );
  let fallback;
  const failed = await runReferenceEntry(
    async () => {
      throw new Error("construction failed");
    },
    { report: "candidate.json" },
    {
      write: async () => {
        throw new Error("disk full");
      },
      now: () => 1,
      pid: 100,
      reportFailure: (r) => {
        fallback = r;
      },
    },
  );
  assert.equal(failed, 1);
  assert.equal(fallback.originalError.message, "construction failed");
  assert.equal(fallback.cleanupErrors[0].message, "disk full");
});

test("T7fix2: current ownership admits a new child identity reusing an old PID", () => {
  const parent = { pid: 100, ppid: 1, pgid: 100, start: "parent" };
  const oldChild = { pid: 101, ppid: 100, pgid: 100, start: "old-child" };
  const replacement = { ...oldChild, start: "new-child" };
  const tracker = createOwnedProcessTracker(100);
  tracker.observe([parent, oldChild]);
  tracker.observe([parent]);
  assert.deepEqual(tracker.observe([parent, replacement]), [parent, replacement]);
  assert.deepEqual(tracker.observe([{ ...replacement, ppid: 1 }]), [{ ...replacement, ppid: 1 }]);
  assert.equal(tracker.observed().filter((row) => row.pid === 101).length, 2);
  const escaped = { ...replacement, pid: 102, ppid: 101, pgid: 102, start: "escaped-child" };
  assert.deepEqual(tracker.observe([{ ...replacement, ppid: 1 }, escaped]), [
    { ...replacement, ppid: 1 },
    escaped,
  ]);
});

test("T7fix2: uncertain recycled group identity cannot report empty cleanup", () => {
  const tracker = createOwnedProcessTracker(100);
  tracker.observe([{ pid: 100, ppid: 1, pgid: 100, start: "parent" }]);
  assert.throws(
    () => tracker.observe([{ pid: 101, ppid: 1, pgid: 100, start: "unknown" }]),
    /identity/i,
  );
});

test("T7fix2: supervisor cleans an owned replacement child instead of passing", async () => {
  const model = controllerModel("success");
  const parent = { pid: 100, ppid: 1, pgid: 100, start: "parent" };
  const oldChild = { pid: 101, ppid: 100, pgid: 100, start: "old-child" };
  const replacement = { ...oldChild, start: "new-child" };
  let time = 0,
    exit;
  model.io.now = () => time;
  model.io.start = async () => {
    model.setRows([parent, oldChild]);
    return { pid: 100, exit: () => exit };
  };
  model.io.sleep = async (ms) => {
    time += ms;
    if (time === 1) model.setRows([parent]);
    if (time === 2) model.setRows([parent, replacement]);
    if (time === 3) {
      model.setRows([{ ...replacement, ppid: 1 }]);
      exit = { code: 0, signal: null, at: time };
    }
  };
  await assert.rejects(
    superviseCase({ case: "retirement" }, model.io, { timeoutMs: 10, pollMs: 1, settleMs: 2 }),
    /Owned processes remain/,
  );
  assert.ok(model.actions.includes("kill-group:100"));
  assert.equal(model.failure.status, "failed");
  assert.deepEqual(model.failure.remainingChildren, []);
  assert.ok(model.failure.observedProcesses.some((row) => row.start === "new-child"));
});

test("T7fix2: original error is externally recorded while close is still pending", async () => {
  for (const diskFailure of [false, true]) {
    const writes = [],
      fallbacks = [];
    let release, reachedClose;
    const closeEntered = new Promise((resolve) => {
      reachedClose = resolve;
    });
    const close = new Promise((resolve) => {
      release = resolve;
    });
    const running = runReferenceEntry(
      async () => ({
        composition: { workerCount: 1 },
        runCase: async () => {
          throw new Error("original before hung close");
        },
        close: async () => {
          reachedClose();
          await close;
        },
      }),
      { report: "candidate.json", runId: "flow", case: "retirement" },
      {
        pid: 100,
        now: () => 1,
        write: async (file, value) => {
          if (diskFailure) throw new Error("disk full");
          writes.push({ file, value: JSON.parse(value) });
        },
        reportFailure: (value) => fallbacks.push(structuredClone(value)),
      },
    );
    await closeEntered;
    try {
      const preliminary = diskFailure ? fallbacks[0] : writes[0]?.value;
      assert.equal(preliminary?.originalError.message, "original before hung close");
      assert.equal(preliminary.cleanupState, "pending");
      assert.equal(preliminary.status, "failed");
      if (diskFailure)
        assert.ok(preliminary.cleanupErrors.some((row) => row.message === "disk full"));
      else assert.equal(writes[0].file, "candidate.json.entry-failure-pending.json");
    } finally {
      release();
      await running;
    }
    assert.equal(await running, 1);
    if (!diskFailure) {
      assert.equal(writes.at(-1).file, "candidate.json.entry-failure.json");
      assert.equal(writes.at(-1).value.cleanupState, "settled");
    }
  }
});

test("T7fix2: supervisor timeout preserves the preliminary case failure", async () => {
  const model = controllerModel("timeout");
  const preliminary = {
    status: "failed",
    originalError: { name: "Error", message: "original before hung close" },
    cleanupState: "pending",
    cleanupErrors: [],
  };
  model.io.readCandidate = async () => ({ entryFailure: preliminary });
  await assert.rejects(
    superviseCase({ case: "retirement" }, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
    /original before hung close/,
  );
  assert.match(model.failure.controllerError.message, /timeout/);
  assert.equal(model.failure.entryFailure.cleanupState, "pending");
  assert.deepEqual(model.failure.remainingChildren, []);
});

test("T7fix2: entry reader preserves preliminary evidence when the final write is absent or torn", async () => {
  for (const torn of [false, true]) {
    const pending = {
      status: "failed",
      cleanupState: "pending",
      cleanupErrors: [],
      originalError: { message: "original case failure" },
    };
    const reads = [];
    const result = await readEntryFailure("candidate.json", async (file) => {
      reads.push(file);
      if (file.endsWith(".entry-failure.json")) {
        if (torn) throw new SyntaxError("torn final JSON");
        return undefined;
      }
      return structuredClone(pending);
    });
    assert.deepEqual(reads, [
      "candidate.json.entry-failure.json",
      "candidate.json.entry-failure-pending.json",
    ]);
    assert.equal(result.originalError.message, "original case failure");
    assert.equal(result.cleanupState, "pending");
    assert.equal(result.cleanupErrors.length, torn ? 1 : 0);
    if (torn) assert.equal(result.cleanupErrors[0].message, "torn final JSON");
  }
});

test("T7fix2: entry reader prefers the final diagnostic and never hides an unreadable final without fallback", async () => {
  const final = {
    status: "failed",
    cleanupState: "settled",
    cleanupErrors: [],
    originalError: { message: "original" },
  };
  const reads = [];
  assert.deepEqual(
    await readEntryFailure("candidate.json", async (file) => {
      reads.push(file);
      return final;
    }),
    final,
  );
  assert.deepEqual(reads, ["candidate.json.entry-failure.json"]);
  const error = new Error("unreadable final");
  await assert.rejects(
    readEntryFailure("candidate.json", async (file) => {
      if (file.endsWith(".entry-failure.json")) throw error;
    }),
    (value) => value === error,
  );
  assert.equal(await readEntryFailure("candidate.json", async () => undefined), undefined);
});

// Pure verifier oracle; never written as a native receipt or supplied to a producer.
function registrationOracle() {
  const id = "target",
    handle = "checkpoint",
    token = "drain";
  const sha256 = createHash("sha256").update(`Synthetic final checkpoint ${id}\n`).digest("hex");
  const record = { id, revision: "seed", kind: "test.registration-end" };
  const checkpoint = { checkpoint: handle, record };
  const firstOffer = { token, deadlineMonotonicMs: 100, checkpoints: [checkpoint], writes: [] };
  const registrationTicket = {
    id: "registration-ticket",
    target: { kind: "recovery", key: handle },
  };
  const finalRecord = { ...record, revision: "final", checkpoint: "final", sha256 };
  const ticket = {
    id: "final-ticket",
    target: { kind: "record", id, expectedRevision: record.revision },
    metadata: { record: finalRecord },
  };
  const endTrace = [{ point: "before-publish", ticket: registrationTicket.id }];
  return {
    checks: {
      finalTargets: 1,
      finalPublications: 1,
      pendingRegistrationIncluded: true,
      firstDeadline: 100,
      lastDeadline: 100,
    },
    events: [],
    samples: {},
    registration: {
      firstOffer,
      offers: [firstOffer],
      requests: [{ token, reason: "reservation-ended", checkpoints: [checkpoint], writes: [] }],
      submissions: [{ ok: true, value: { status: "submitted", writes: ["sdk-write"] } }],
      registrationTicket,
      finalTickets: [ticket],
      endTrace,
      trace: [
        ...endTrace,
        { point: "after-publish", ticket: registrationTicket.id },
        { point: "after-publish", ticket: ticket.id },
      ],
      finalRecord,
      payloadSha256: sha256,
    },
  };
}
import { createHash } from "node:crypto";
test("registration-end rejects missing and mismatched actual observations", () => {
  const oracle = registrationOracle();
  assertFoundationEvidence("registration-end", oracle);
  for (const key of Object.keys(oracle.registration)) {
    const changed = structuredClone(oracle);
    delete changed.registration[key];
    assert.throws(() => assertFoundationEvidence("registration-end", changed));
  }
  for (const mutate of [
    (o) => o.registration.requests[0].checkpoints.push(o.registration.requests[0].checkpoints[0]),
    (o) => o.registration.requests[0].writes.push({ id: "target", write: "fabricated-checkpoint" }),
    (o) => o.registration.trace.push(o.registration.trace.at(-1)),
    (o) => o.registration.endTrace.push({ point: "after-publish", ticket: "registration-ticket" }),
    (o) => (o.registration.finalTickets[0].target.id = "other-target"),
    (o) => (o.registration.submissions = []),
    (o) => (o.registration.payloadSha256 = "0".repeat(64)),
    (o) => o.registration.offers[0].deadlineMonotonicMs++,
  ]) {
    const changed = structuredClone(oracle);
    mutate(changed);
    assert.throws(() => assertFoundationEvidence("registration-end", changed));
  }
});
test("registration-end selector is bounded and full matrix remains fail-closed", () => {
  assert.deepEqual(selectFoundationCases({ caseId: "registration-end" }), ["registration-end"]);
  assert.deepEqual(selectFoundationCases({ referencesOnly: true }), [
    "retirement",
    "healthy-release",
  ]);
  assert.throws(() => selectFoundationCases(), /remaining observation-table producers/);
  assert.deepEqual(selectFoundationCases({ caseId: "sealed-ttl" }), ["sealed-ttl"]);
  assert.deepEqual(selectFoundationCases({ caseId: "all-optional-off" }), ["all-optional-off"]);
  assert.throws(() => selectFoundationCases({ caseId: "installed" }), /unsupported case/);
  assert.throws(
    () => selectFoundationCases({ referencesOnly: true, caseId: "registration-end" }),
    /mutually exclusive/,
  );
});

test("registration-end source provenance retains original ports and SDK callback", async () => {
  const source = await readFile(new URL("./plugin-persistence-main.ts", import.meta.url), "utf8");
  const consumer = await readFile(
    new URL("./fixtures/plugin-persistence/consumer.ts", import.meta.url),
    "utf8",
  );
  const file = ts.createSourceFile("producer.ts", source, ts.ScriptTarget.Latest, true);
  const producer = file.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "produceRegistrationEnd",
  );
  assert.ok(producer, "missing live producer");
  const normalize = (text) => text.replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".");
  const body = normalize(producer.getText(file));
  const required = [
    'input.host.request(\n        principal,\n        "storage/registerCheckpoint"',
    'input.fault.arm("before-publish", "pause")',
    'input.fault.release("before-publish")',
    "endReservation.call(this, event, deadline)",
    "drain.call(this, offer,",
    "reserve.call(this, ticket, size)",
    "input.backend.evidence.capture(",
    "input.backend.evidence.tickets(barrier)",
    "input.backend.evidence.flush(barrier)",
    "dispatch(target, request, ...rest)",
    "input.fault.trace()",
    '"devices/recording/release"',
    '"storage/readChunk"',
    "participant.endReservation = endReservation",
    "participant.drain = drain",
    "engine.reserve = reserve",
  ];
  const observations = required.map(normalize);
  const verify = (text) => {
    for (const observation of observations)
      assert.ok(text.includes(observation), `missing source provenance: ${observation}`);
    assert.ok(text.includes("finally"));
  };
  verify(body);
  for (const observation of observations)
    assert.throws(
      () => verify(body.replaceAll(observation, "removed-observation")),
      /missing source provenance/,
    );
  assert.ok(source.includes('"registration-end": () => produceRegistrationEnd(input)'));
  assert.ok(consumer.includes('from "@kobrixa/plugin-sdk"'));
  for (const operation of ["beginWrite", "writeChunk", "sealWrite", "commitWrite", "flush"])
    assert.ok(consumer.includes(`storage.${operation}(`), `missing SDK operation ${operation}`);
  assert.ok(consumer.includes('phase: "final"'));
  assert.ok(consumer.includes("drainToken: request.token"));
});

test("pressure builtin roles exclude reference panels while other fixture cases retain them", async () => {
  const { foundationBuiltinRoles } = await import("./plugin-persistence-main.ts");
  assert.deepEqual(foundationBuiltinRoles("storage-ui-pressure"), ["pressure-a", "pressure-b"]);
  assert.deepEqual(foundationBuiltinRoles("import-restart"), ["recording", "settings", "import"]);
  for (const id of [
    "all-optional-off",
    "compatibility",
    "action-replay",
    "renderer-loss",
    "sealed-ttl",
  ])
    assert.deepEqual(foundationBuiltinRoles(id), ["recording", "settings"]);
});

// These synthetic traces exercise only the outside oracle; they are never native receipts.
import {
  INTEROP_IDS,
  COMPATIBILITY_REFERENCE,
  readInteropIdentity,
  verifyPublicInterop,
  publicInteropObserver,
  interopPairs,
  runPublicInterop,
} from "./plugin-persistence-public-interop.ts";

const interopHash = (data) => createHash("sha256").update(data).digest("hex");
function publicInteropUnitTrace() {
  let sequence = 0,
    nextId = 0;
  const ok = (value) => ({ ok: true, value });
  const denied = (code) => ({ ok: false, error: { code } });
  const consumers = INTEROP_IDS.map((pluginId, i) => ({
    owner: {
      pluginId,
      sourceKey: `dev:source-${i}`,
      generation: 0,
      hostEpoch: "host",
      processEpoch: `process-${i}`,
    },
    transport: i ? "stdio" : "message-port",
    launch: ++sequence,
    wire: [],
    output: [],
    actions: [],
  }));
  const output = (r, phase, data = {}) =>
    r.output.push({
      sequence: ++sequence,
      line:
        "PUBLIC_INTEROP:" +
        JSON.stringify({
          phase,
          pluginId: r.owner.pluginId,
          pid: consumers.indexOf(r) + 100,
          data,
        }),
    });
  const start = (r, method, params, direction = "plugin") => {
    const id = ++nextId;
    r.wire.push({
      sequence: ++sequence,
      direction,
      message: { jsonrpc: "2.0", id, method, params },
    });
    return (result) =>
      r.wire.push({
        sequence: ++sequence,
        direction: direction === "host" ? "plugin" : "host",
        message: { jsonrpc: "2.0", id, result },
      });
  };
  const rpc = (r, m, p, result, d) => start(r, m, p, d)(result);
  const action = (r, kind, ref, data) =>
    r.actions.push({ sequence: ++sequence, kind, actionRef: ref, data });
  const records = consumers.map((_, owner) =>
    [0, 1].map((i) => ({
      id: `${owner}-record-${i}`,
      revision: `${owner}-revision-${i}`,
      byteLength: 262181,
      sha256: interopHash(Buffer.alloc(262181, 97 + i)),
      checkpoint: "none",
    })),
  );
  const quota = (owners) => ({
    committedBytes: 524362,
    reservedBytes: 0,
    recordCount: 2,
    reservedCreates: 0,
    pinnedBytes: 0,
    temporaryBytes: 0,
    sourceLimitBytes: 536870912,
    sourceLimitRecords: 256,
    hostAvailableBytes: 1073741824 - owners * 524362,
    writeSlotsAvailable: 2,
    exportSlotsAvailable: 1,
  });
  const readRecord = (r, record, index, label) => {
    const handle = `${r.owner.pluginId}-read-${label}-${index}`;
    rpc(
      r,
      "storage/openRead",
      { id: record.id, expectedRevision: record.revision, schemaVersion: 1 },
      ok({ read: handle, record }),
    );
    // Positive short reads, including a chunk-boundary crossing.
    let offset = 0;
    for (const count of [200000, 62170, 11]) {
      const bytes = Buffer.alloc(count, 97 + index);
      rpc(
        r,
        "storage/readChunk",
        { read: handle, offset, maxBytes: Math.min(262144, 262181 - offset) },
        ok({
          data: bytes.toString("base64"),
          nextOffset: offset + count,
          eof: offset + count === 262181,
        }),
      );
      offset += count;
    }
    rpc(r, "storage/closeRead", { read: handle }, ok({}));
  };
  for (const [i, r] of consumers.entries()) {
    output(r, "boot");
    rpc(
      r,
      "initialize",
      { pluginId: r.owner.pluginId, apiVersion: "1.8.0" },
      { apiVersion: "1.8.0", sdk: { name: i ? "kobrixa-plugin-sdk" : "@kobrixa/plugin-sdk" } },
      "host",
    );
    rpc(r, "settings/read", {}, ok({ revision: null }));
    rpc(r, "settings/watch", { schemaVersion: 1 }, ok({ subscriptionId: `sub-${i}`, sequence: 0 }));
    rpc(
      r,
      "settings/update",
      { expectedRevision: null },
      ok({ snapshot: { revision: "settings-new" } }),
    );
    const event = {
      kind: "settings.changed",
      subscriptionId: `sub-${i}`,
      sequence: 1,
      data: { revision: "settings-new" },
    };
    r.wire.push({
      sequence: ++sequence,
      direction: "host",
      message: { jsonrpc: "2.0", method: "events/deliver", params: event },
    });
    output(r, "callback-enter", event);
    rpc(r, "events/ack", { subscriptionId: `sub-${i}`, sequence: 1 }, ok({ acknowledged: 1 }));
    output(r, "callback-release");
    output(r, "callback-complete", event);
    rpc(r, "settings/update", { expectedRevision: null }, denied("PLUGIN_E_SETTINGS_CONFLICT"));
    rpc(r, "settings/read", {}, ok({ revision: "settings-new" }));
    for (const [index, record] of records[i].entries()) {
      const handle = `write-${i}-${index}`,
        bytes = Buffer.alloc(262181, 97 + index);
      rpc(
        r,
        "storage/beginWrite",
        { target: { mode: "create" } },
        ok({ id: record.id, write: handle }),
      );
      for (const offset of [0, 0, 262144])
        rpc(
          r,
          "storage/writeChunk",
          {
            write: handle,
            offset,
            data: bytes.subarray(offset, offset + 262144).toString("base64"),
          },
          ok({ receivedBytes: Math.min(offset + 262144, bytes.length) }),
        );
      rpc(r, "storage/sealWrite", { write: handle }, ok({}));
      for (let copy = 0; copy < 2; copy++)
        rpc(
          r,
          "storage/commitWrite",
          { write: handle },
          ok({ record, receipt: { revision: record.revision, commitId: handle } }),
        );
      readRecord(r, record, index, "before");
    }
    rpc(r, "storage/list", { limit: 1 }, ok({ entries: [records[i][0]], nextCursor: "page2" }));
    rpc(r, "storage/list", { limit: 1, cursor: "page2" }, ok({ entries: [records[i][1]] }));
    rpc(r, "storage/openRead", { id: records[i][0].id }, ok({ read: `held-${i}` }));
    rpc(r, "storage/quota", {}, ok(quota(i + 1)));
    output(r, "records", { records: records[i], read: `held-${i}`, quota: quota(i + 1) });
  }
  for (const [i, r] of consumers.entries()) {
    const foreign = 1 - i;
    rpc(r, "storage/openRead", { id: records[foreign][0].id }, denied("PLUGIN_E_STALE_RESOURCE"));
    rpc(
      r,
      "storage/readChunk",
      { read: `held-${foreign}`, offset: 0, maxBytes: 1 },
      denied("PLUGIN_E_STALE_RESOURCE"),
    );
    for (const [index, record] of records[i].entries()) readRecord(r, record, index, "after");
    rpc(r, "storage/quota", {}, ok(quota(2)));
    output(r, "verified", { records: records[i], quota: quota(2) });
    rpc(r, "storage/closeRead", { read: `held-${i}` }, ok({}));
    for (const removed of [true, false])
      rpc(r, "events/unsubscribe", { subscriptionId: `sub-${i}` }, ok({ removed }));
    rpc(r, "storage/flush", {}, ok({ barrier: "settled" }));
    for (const kind of ["export", "copy"]) {
      const ref = `${i}-${kind}`,
        invocationId = `${ref}-invoke`;
      action(r, "mint", ref, { owner: r.owner });
      const finish = start(
        r,
        "command/invoke",
        {
          command: `${r.owner.pluginId}.interop-${kind}`,
          invocationId,
          context: { actionRef: ref },
        },
        "host",
      );
      const claimed = () =>
        action(r, "claim", ref, {
          owner: r.owner,
          ok: true,
          capability: kind === "export" ? "storage.export" : "ui.clipboard",
        });
      if (kind === "copy") {
        const done = start(r, "ui/copyText", {
          actionRef: ref,
          text: "Synthetic persistence fixture",
        });
        claimed();
        action(r, "clipboard-write", ref, { text: "Synthetic persistence fixture" });
        done(ok({ copied: true }));
      } else {
        const done = start(r, "storage/exportBegin", { actionRef: ref });
        claimed();
        done(ok({ export: "job" }));
        rpc(
          r,
          "storage/exportChunk",
          {
            export: "job",
            offset: 0,
            data: Buffer.from("Synthetic persistence export\n").toString("base64"),
          },
          ok({}),
        );
        rpc(r, "storage/exportCommit", { export: "job" }, ok({}));
        action(r, "export-file", ref, {
          byteLength: 29,
          sha256: interopHash("Synthetic persistence export\n"),
        });
      }
      output(r, kind, { invocationId, actionRef: ref });
      finish(ok({ output: { done: true }, fieldErrors: [] }));
    }
    rpc(
      r,
      "ui/copyText",
      { actionRef: `${i}-copy`, text: "forbidden replay" },
      denied("PLUGIN_E_PERMISSION_DENIED"),
    );
    const token = `token-${i}`,
      checkpoint = `checkpoint-${i}`,
      target = records[i][0];
    rpc(
      r,
      "storage/registerCheckpoint",
      { id: target.id, expectedRevision: target.revision },
      ok({ checkpoint }),
    );
    const finishDrain = start(
      r,
      "storage/drain",
      { token, checkpoints: [{ checkpoint, record: target }] },
      "host",
    );
    const write = `final-${i}`;
    rpc(
      r,
      "storage/beginWrite",
      {
        target: { mode: "replace", id: target.id },
        checkpoint: { handle: checkpoint, phase: "final" },
        drainToken: token,
      },
      ok({ write }),
    );
    rpc(
      r,
      "storage/commitWrite",
      { write, drainToken: token },
      ok({ record: { ...target, checkpoint: "final" } }),
    );
    rpc(r, "storage/flush", {}, ok({ barrier: "final" }));
    finishDrain(ok({ status: "submitted", writes: [write] }));
    r.drain = {
      sequence: ++sequence,
      offer: { token, owner: r.owner },
      report: {
        state: "saved",
        blocker: false,
        pendingSettings: false,
        errors: [],
        records: [{ id: target.id, final: true }],
      },
    };
    r.exit = { sequence: ++sequence, code: 0 };
  }
  return {
    consumers,
    identity: {
      hostVersion: "1.8.0",
      publicApi18Published: true,
      compatibility: COMPATIBILITY_REFERENCE,
    },
  };
}

test("public interop phase1: paired raw operations accept short reads and omitted final cursor", () => {
  const f = publicInteropUnitTrace();
  assert.equal(verifyPublicInterop(f.consumers, f.identity).fullStage3Pass, false);
});
const interopCorruptions = {
  "flattened business envelope": (f) => {
    const p = interopPairs(f.consumers[0], "storage/list")[0];
    p.response.message.result = p.result.value;
  },
  "missing callback": (f) => {
    f.consumers[0].output = f.consumers[0].output.filter(
      (r) => !r.line.includes('"callback-enter"'),
    );
  },
  "wrong subscription ACK": (f) => {
    interopPairs(f.consumers[0], "events/ack")[0].params.subscriptionId = "foreign";
  },
  "ACK after callback release": (f) => {
    const r = f.consumers[0];
    interopPairs(r, "events/ack")[0].response.sequence = r.exit.sequence - 1;
  },
  "CAS false positive": (f) => {
    interopPairs(f.consumers[0], "settings/update")[1].result.error.code = "PLUGIN_E_STORAGE_IO";
  },
  "missing continuation page": (f) => {
    const r = f.consumers[0],
      p = interopPairs(r, "storage/list")[1];
    r.wire = r.wire.filter((w) => w !== p.request && w !== p.response);
  },
  "corrupt full read hash": (f) => {
    interopPairs(f.consumers[0], "storage/readChunk")[0].result.value.data = Buffer.alloc(
      200000,
      99,
    ).toString("base64");
  },
  "foreign owner admitted": (f) => {
    const p = interopPairs(f.consumers[0], "storage/openRead").find((p) => !p.result.ok);
    p.response.message.result = { ok: true, value: { read: "bad" } };
  },
  "invented ledger mint": (f) => {
    f.consumers[0].actions = f.consumers[0].actions.filter((r) => r.kind !== "mint");
  },
  "foreign ledger owner": (f) => {
    f.consumers[0].actions[0].data.owner = f.consumers[1].owner;
  },
  "replayed action reuse": (f) => {
    interopPairs(f.consumers[0], "command/invoke", "host")[1].params.context.actionRef = "0-export";
  },
  "export bytes corrupted": (f) => {
    f.consumers[0].actions.find((r) => r.kind === "export-file").data.sha256 = "0".repeat(64);
  },
  "clipboard extra write": (f) => {
    f.consumers[0].actions.push(
      structuredClone(f.consumers[0].actions.find((r) => r.kind === "clipboard-write")),
    );
  },
  "callback claims saved": (f) => {
    interopPairs(f.consumers[0], "storage/drain", "host")[0].result.value.status = "saved";
  },
  "host not saved": (f) => {
    f.consumers[0].drain.report.state = "checkpoint-only";
  },
  "foreign drain token": (f) => {
    f.consumers[0].drain.offer.token = "foreign";
  },
  "missing response": (f) => {
    f.consumers[0].wire.splice(1, 1);
  },
  "future host": (f) => {
    f.identity.hostVersion = "1.9.0";
  },
  "negotiation mismatch": (f) => {
    interopPairs(f.consumers[0], "initialize", "host")[0].result.apiVersion = "1.7.0";
  },
  "false 1.8 publication": (f) => {
    f.identity.publicApi18Published = false;
  },
  "failed process": (f) => {
    f.consumers[0].exit.code = 1;
  },
};
for (const [name, corrupt] of Object.entries(interopCorruptions))
  test(`public interop phase1: reject ${name}`, () => {
    const f = publicInteropUnitTrace();
    corrupt(f);
    assert.throws(() => verifyPublicInterop(f.consumers, f.identity));
  });
test("public interop phase1: archived twenty-run reference is checked against actual current source bytes", async () => {
  const identity = await readInteropIdentity(new URL("../../", import.meta.url).pathname);
  assert.equal(identity.compatibility.commit, COMPATIBILITY_REFERENCE.commit);
  assert.equal(identity.compatibility.sha256, COMPATIBILITY_REFERENCE.sha256);
  assert.ok(Object.keys(identity.runtimeHashes).length > 10);
  assert.equal(identity.publicApi18Published, identity.hostVersion === "1.8.0");
  assert.equal(
    identity.compatibility.applicability,
    identity.compatibility.changed.length ? "historical-only" : "same-runtime",
  );
});
test("public interop phase1: observer forwards original process and cleanup retains failure", async () => {
  const o = publicInteropObserver(),
    owner = {
      pluginId: INTEROP_IDS[0],
      sourceKey: "dev:x",
      generation: 0,
      hostEpoch: "h",
      processEpoch: "p",
    };
  const row = o.begin(owner, "message-port");
  let receive,
    exit,
    removed = 0;
  const sent = [];
  const child = {
    send: (text) => sent.push(text),
    kill() {},
    forceKill() {},
    onMessage(fn) {
      receive = fn;
      return () => removed++;
    },
    onExit(fn) {
      exit = fn;
      return () => {};
    },
  };
  const wrapped = o.attach(row, child);
  wrapped.send('{"id":1,"method":"initialize"}');
  receive('{"id":1,"result":{}}');
  exit({ code: 0 });
  assert.equal(sent.length, 1);
  assert.equal(removed, 1);
  assert.equal(row.wire.length, 2);
  assert.equal(wrapped.kill, child.kill);
  const cause = new Error("real command failure"),
    cleanup = new Error("retirement incomplete"),
    retired = [];
  await assert.rejects(
    runPublicInterop({
      consumers: [{ ...row }, { ...row, owner: { ...owner, pluginId: INTEROP_IDS[1] } }],
      execute: async () => {
        throw cause;
      },
      invoke: async () => {
        throw Error("must not invoke");
      },
      retire: async (id) => {
        retired.push(id);
        if (id === INTEROP_IDS[0]) throw cleanup;
      },
    }),
    (error) => {
      assert.equal(error.cause, error.errors[0]);
      assert.equal(error.errors[0], cause);
      return true;
    },
  );
  assert.deepEqual(retired, [...INTEROP_IDS]);
});

// Isolated mode metadata is validated against the actual public schemas, not copied expectations.
import { selectInteropMode, interopManifest, interopPanel } from "./plugin-persistence-run.mjs";
import {
  pluginManifestSchema,
  panelResourceV1Schema,
  validateUiResource,
  uiBytes,
} from "@kobrixa/plugin-protocol";
test("public interop phase2: isolated selector preserves defaults and rejects mixed modes", () => {
  assert.equal(selectInteropMode({}), null);
  assert.deepEqual(selectInteropMode({ interop: true }), ["public-interop"]);
  for (const extra of [
    { referencesOnly: true },
    { caseId: "compatibility" },
    { importTrial: "publication-six" },
  ])
    assert.throws(() => selectInteropMode({ interop: true, ...extra }), /exclusive/);
});
test("public interop phase2: generated two-language manifests and panels use exact public command schemas", () => {
  for (const id of ["acceptance.interop-js", "acceptance.interop-python"]) {
    const manifest = pluginManifestSchema.parse(interopManifest(id, "1.8.0"));
    const panel = panelResourceV1Schema.parse(interopPanel(manifest));
    const validated = validateUiResource(
      panel,
      {
        pluginId: id,
        commands: manifest.contributes.commands,
        panels: manifest.contributes.panels,
      },
      uiBytes(panel),
    );
    assert.equal(validated.ok, true, JSON.stringify(validated));
    assert.equal(manifest.runtime.kind, id.endsWith("python") ? "python" : "node");
    assert.equal(manifest.contributes.commands.length, 12);
    assert.deepEqual(
      manifest.contributes.commands.filter((c) => c.id.includes(".negative-")).map((c) => c.id),
      ["prepare", "probe", "reopen"].map((phase) => `${id}.negative-${phase}`),
    );
    assert.equal(panel.nodes.length, 9);
    assert.equal(manifest.contributes.settings.path, "settings.json");
    for (const command of manifest.contributes.commands.filter(
      (c) => c.invocation === "context-v1",
    )) {
      const node = panel.nodes.find((n) => n.id === command.id.split(".").at(-1));
      assert.equal(node.action.command, command.id);
      for (const key of Object.keys(command.arguments)) {
        assert.deepEqual(node.action.arguments[key], { ref: { scope: "form", key } });
        assert.deepEqual(panel.fields[key].schema, command.arguments[key]);
        assert.equal(command.arguments[key].maxLength, 128);
        assert.deepEqual(command.arguments[key], {
          type: "string",
          maxLength: 128,
          nullable: false,
        });
      }
    }
  }
  assert.throws(() => interopManifest("builtin:kobrixa.sensor-lab", "1.8.0"));
  assert.throws(() => interopManifest("acceptance.interop-js", "1.9.0"));
});
test("public interop phase2: current raw envelope cannot bypass receipt or legacy version gates", () => {
  const f = publicInteropUnitTrace();
  assert.throws(() =>
    verifyInterop({
      mode: "public-interop",
      level: "unit",
      status: "public-interop-subset",
      fullStage3Pass: false,
      reports: [],
    }),
  );
  assert.throws(() =>
    verifyInterop({
      mode: "public-interop",
      level: "real-process",
      status: "public-interop-subset",
      fullStage3Pass: false,
      reports: [
        {
          case: "public-interop",
          hostEpoch: f.consumers[0].owner.hostEpoch,
          evidence: { publicInterop: f },
        },
      ],
    }),
  );
  f.identity.hostVersion = "1.7.0";
  f.identity.publicApi18Published = false;
  assert.throws(
    () => verifyPublicInterop(f.consumers, f.identity),
    "Actual 1.8 wire cannot be relabeled historical 1.7",
  );
});

test("public interop phase2: full two-owner quotas account for only intervening foreign creates", () => {
  const f = publicInteropUnitTrace();
  const js = interopPairs(f.consumers[0], "storage/quota").map((p) => p.result.value);
  const py = interopPairs(f.consumers[1], "storage/quota").map((p) => p.result.value);
  assert.equal(js[0].hostAvailableBytes - js[1].hostAvailableBytes, 524362);
  assert.deepEqual(py[0], py[1]);
  assert.equal(verifyPublicInterop(f.consumers, f.identity).fullStage3Pass, false);
});
function changeVerifiedQuota(f, field, delta) {
  const row = f.consumers[0];
  interopPairs(row, "storage/quota")[1].result.value[field] += delta;
  const output = row.output.find((r) => r.line.includes('"phase":"verified"'));
  const parsed = JSON.parse(output.line.slice("PUBLIC_INTEROP:".length));
  parsed.data.quota[field] += delta;
  output.line = "PUBLIC_INTEROP:" + JSON.stringify(parsed);
}
for (const [field, delta] of [
  ["committedBytes", 1],
  ["reservedBytes", 1],
  ["recordCount", 1],
  ["hostAvailableBytes", -1],
])
  test(`public interop phase2: rejects unexpected quota movement ${field}`, () => {
    const f = publicInteropUnitTrace();
    changeVerifiedQuota(f, field, delta);
    assert.throws(() => verifyPublicInterop(f.consumers, f.identity));
  });
test("public interop phase2: quota summary requires original public quota response", () => {
  const f = publicInteropUnitTrace(),
    row = f.consumers[0];
  const pair = interopPairs(row, "storage/quota")[1];
  row.wire = row.wire.filter((w) => w !== pair.request && w !== pair.response);
  assert.throws(() => verifyPublicInterop(f.consumers, f.identity));
});

import {
  PUBLIC_NEGATIVE_PROBES,
  verifyPublicNegative,
  producePublicNegative,
} from "./plugin-persistence-public-interop.ts";
import {
  negativeCoverage,
  verifyNegativeReport,
  verifyB2Aggregate,
  readNegativeAttachments,
  B2_GROUP_REQUIREMENTS,
} from "./plugin-persistence-harness.mjs";

// Pure oracle model, never written as a native observation or acceptance receipt.
function negativeUnitEvidence(phase = "exercise") {
  let sequence = 0;
  const bytes = Buffer.from("W10 retained record\n");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const evidence = {
    phase,
    identity: { hostVersion: "1.8.0", publicApi18Published: true },
    consumers: [],
    captures: [],
  };
  for (const [index, pluginId] of [
    "acceptance.interop-js",
    "acceptance.interop-python",
  ].entries()) {
    const row = {
      owner: {
        pluginId,
        sourceKey: `dev:${pluginId}`,
        hostEpoch: `00000000-0000-4000-8000-00000000000${phase === "exercise" ? 1 : 2}`,
        processEpoch: `00000000-0000-4000-8000-00000000000${index + (phase === "exercise" ? 3 : 5)}`,
        generation: 1,
      },
      transport: index ? "stdio" : "message-port",
      launch: ++sequence,
      wire: [],
      output: [],
      actions: [],
    };
    evidence.consumers.push(row);
    let requestId = 0;
    const pair = (method, params, result, direction = "plugin") => {
      const id = ++requestId;
      row.wire.push({
        sequence: ++sequence,
        direction,
        message: { jsonrpc: "2.0", id, method, params },
      });
      row.wire.push({
        sequence: ++sequence,
        direction: direction === "plugin" ? "host" : "plugin",
        message: { jsonrpc: "2.0", id, result },
      });
    };
    const emit = (phase, data) =>
      row.output.push({
        sequence: ++sequence,
        line: "PUBLIC_INTEROP:" + JSON.stringify({ phase, pluginId, pid: 100 + index, data }),
      });
    pair(
      "initialize",
      { pluginId, apiVersion: "1.8.0" },
      { apiVersion: "1.8.0", sdk: { name: index ? "kobrixa-plugin-sdk" : "@kobrixa/plugin-sdk" } },
      "host",
    );
    emit("boot", {});
    const snapshot = {
      record: {
        id: `record-${index}`,
        revision: "revision",
        byteLength: bytes.length,
        sha256: hash,
      },
      settings: { revision: null, values: [] },
      quota: {
        recordCount: 1,
        committedBytes: bytes.length,
        reservedBytes: 0,
        reservedCreates: 0,
        pinnedBytes: 0,
      },
    };
    const capture = (phase) => {
      pair("settings/read", { schemaVersion: 1 }, { ok: true, value: snapshot.settings });
      pair("storage/quota", {}, { ok: true, value: snapshot.quota });
      pair(
        "storage/openRead",
        { id: snapshot.record.id, expectedRevision: snapshot.record.revision },
        { ok: true, value: { read: `read-${sequence}` } },
      );
      const read = row.wire.at(-1).message.result.value.read;
      pair(
        "storage/readChunk",
        { read },
        { ok: true, value: { data: bytes.toString("base64"), eof: true } },
      );
      emit(`negative-${phase}`, snapshot);
      evidence.captures.push({
        pluginId,
        phase,
        state: {
          hostEpoch: row.owner.hostEpoch,
          disk: { "head.json": { bytes: bytes.length, sha256: hash } },
          quota: snapshot.quota,
          core: { items: [] },
          diagnostics: [{}],
          native: { dialogs: [], writes: [], textSha256: hash },
        },
      });
    };
    if (phase === "exercise") {
      capture("before");
      for (const [scenario, [, method, code]] of Object.entries(PUBLIC_NEGATIVE_PROBES)) {
        emit("negative-start", { scenario });
        const result = { ok: false, error: { code } };
        const params =
          scenario === "unknown-setting" || scenario === "setting-type"
            ? {
                schemaVersion: 1,
                expectedRevision: snapshot.settings.revision,
                changes: [
                  {
                    key: scenario === "unknown-setting" ? "unknown" : "fixture.enabled",
                    value: scenario === "unknown-setting" ? true : "true",
                  },
                ],
              }
            : scenario === "replacement-busy"
              ? {
                  target: {
                    mode: "replace",
                    id: snapshot.record.id,
                    expectedRevision: snapshot.record.revision,
                  },
                }
              : scenario === "delete-busy"
                ? { id: snapshot.record.id, expectedRevision: snapshot.record.revision }
                : scenario === "staging-quota"
                  ? { target: { mode: "create" } }
                  : scenario === "chunk-offset"
                    ? { offset: bytes.length + 1, data: "Yg==" }
                    : scenario === "chunk-retry-mismatch"
                      ? { offset: 0, data: Buffer.alloc(bytes.length, 98).toString("base64") }
                      : scenario.endsWith("without-action")
                        ? { actionRef: "00000000-0000-4000-8000-000000000001" }
                        : {};
        pair(method, params, result);
        emit("negative-result", { scenario, result });
      }
      capture("after");
    } else capture("reopened");
    row.exit = { sequence: ++sequence, code: 0 };
  }
  return evidence;
}

test("W10: failure subset links all 13 probes to both original transports", () => {
  const evidence = negativeUnitEvidence();
  const links = verifyPublicNegative(evidence);
  assert.equal(links.length, 26);
  for (const transport of ["message-port", "stdio"])
    assert.deepEqual(
      links.filter((l) => l.transport === transport).map((l) => l.scenario),
      Object.keys(PUBLIC_NEGATIVE_PROBES),
    );
  const rows = negativeCoverage([{ runId: "pure-oracle", evidence: { negative: evidence } }]);
  assert.equal(rows.length, 29);
  assert.ok(rows.every((r) => r.status === "incomplete" && r.missing.length > 0));
  assert.equal(rows.find((r) => r.id === "B2-N05").links.length, 2);
  assert.ok(rows.find((r) => r.id === "B2-N05").missing.some((s) => s.includes("W17")));
  assert.equal(rows.find((r) => r.id === "B2-N20").links.length, 0);
});
for (const [name, mutate] of Object.entries({
  "missing Python": (e) => e.consumers.pop(),
  "missing wire response": (e) => e.consumers[0].wire.splice(7, 1),
  "wrong failure code": (e) => {
    const p = interopPairs(e.consumers[0], "settings/update")[0];
    p.result.error.code = "PLUGIN_E_STORAGE_IO";
  },
  "invented SDK summary": (e) => {
    const r = e.consumers[0].output.find((r) => r.line.includes('"negative-result"'));
    r.line = r.line.replace("PLUGIN_E_SETTINGS_SCHEMA", "PLUGIN_E_STORAGE_IO");
  },
  "changed retained disk": (e) => (e.captures[1].state.disk["head.json"].sha256 = "f".repeat(64)),
  "changed core recovery": (e) => e.captures[1].state.core.items.push("invented"),
  "changed quota": (e) => (e.captures[1].state.quota = { recordCount: 2 }),
  "wrong epoch": (e) => (e.captures[0].state.hostEpoch = "foreign"),
  "failed process": (e) => (e.consumers[1].exit.code = 1),
  "wrong failed request": (e) => {
    interopPairs(e.consumers[0], "settings/update")[0].params.changes[0].key = "fixture.enabled";
  },
  "native chooser reached": (e) =>
    e.captures[1].state.native.dialogs.push({ name: "forbidden.txt" }),
  "native clipboard changed": (e) => (e.captures[1].state.native.textSha256 = "f".repeat(64)),
  "copy actually invoked": (e) => e.consumers[0].actions.push({ kind: "clipboard-write" }),
}))
  test(`W10: rejects ${name}`, () => {
    const e = structuredClone(negativeUnitEvidence());
    mutate(e);
    assert.throws(() => verifyPublicNegative(e));
  });

test("W10: reopen observes readback and rejects reseeding", () => {
  const e = negativeUnitEvidence("reopen");
  assert.deepEqual(verifyPublicNegative(e), []);
  const row = e.consumers[0];
  const p = interopPairs(row, "settings/read")[0];
  p.request.message.method = "settings/update";
  assert.throws(() => verifyPublicNegative(e));
});
test("W10: selector uses sole foundation and rejects mixed modes", () => {
  assert.deepEqual(selectFoundationCases({ caseId: "negative-matrix" }), ["negative-matrix"]);
  assert.throws(() => selectInteropMode({ interop: true, caseId: "negative-matrix" }));
  assert.deepEqual(foundationBuiltinRoles("negative-matrix"), []);
});
test("W10: incomplete inputs cannot become aggregate acceptance", async () => {
  assert.equal(Object.keys(B2_GROUP_REQUIREMENTS).length, 8);
  assert.equal(
    B2_GROUP_REQUIREMENTS["G05-negatives"].filter((s) => s.startsWith("B2-N")).length,
    29,
  );
  for (const input of [
    {},
    { format: 1, mode: "b2-aggregate", status: "complete", pending: ["W17"] },
    {
      format: 1,
      mode: "b2-aggregate",
      status: "complete",
      pending: [],
      level: "real-process",
      cases: [],
    },
  ])
    assert.throws(() => verifyB2Aggregate(input));
  assert.throws(() =>
    verifyNegativeReport({ level: "real-process", mode: "negative-matrix", status: "passed" }),
  );
  assert.deepEqual(await readNegativeAttachments(), []);
  await assert.rejects(readNegativeAttachments("relative.json"), /absolute/);
});
test("W10: native driver preserves original failure and cleanup failures", async () => {
  const failure = new Error("original failure"),
    cleanup = new Error("cleanup failure");
  await assert.rejects(
    producePublicNegative({
      observer: { consumers: [] },
      phase: "exercise",
      capture: async () => assert.fail("unexpected capture"),
      plugins: {
        state: () => ({ plugins: [{ id: "acceptance.interop-js", sourceKey: "source" }] }),
        setEnabled: async (_key, enabled) => {
          if (!enabled) throw cleanup;
          return { ok: true };
        },
        execute: async () => {
          throw failure;
        },
      },
    }),
    (error) =>
      error instanceof AggregateError && error.errors[0] === failure && error.errors[1] === cleanup,
  );
});

function negativeUnitReport() {
  const sourceHashes = { "pure-oracle.ts": "e".repeat(64) };
  const sourceIdentity = createHash("sha256")
    .update(JSON.stringify(Object.entries(sourceHashes)))
    .digest("hex");
  const reports = ["exercise", "reopen"].map((phase) => {
    const negative = negativeUnitEvidence(phase);
    return {
      ...receiptFixture(),
      sourceIdentity,
      case: "negative-matrix",
      runId: phase,
      hostEpoch: negative.consumers[0].owner.hostEpoch,
      evidence: { negative },
    };
  });
  return {
    format: 1,
    sourceIdentity,
    sourceHashes,
    level: "real-process",
    mode: "negative-matrix",
    status: "partial-negative-matrix",
    fullPass: false,
    reports,
    bundleSha256: reports[0].bundleSha256,
    artifactSha256: reports[0].artifactSha256,
    attachments: [],
    coverage: negativeCoverage(reports),
  };
}
test("W10: negative receipt binds cleanup, artifacts and same-profile new-epoch reopen", () => {
  verifyNegativeReport(negativeUnitReport());
  for (const mutate of [
    (r) => (r.reports[1].profileId = "other-profile"),
    (r) => (r.reports[1].hostEpoch = r.reports[0].hostEpoch),
    (r) => (r.reports[1].artifactSha256 = "f".repeat(64)),
    (r) => (r.reports[1].cleanup.workers = 1),
    (r) => (r.coverage[0].status = "passed"),
    (r) => (r.fullPass = true),
    (r) => (r.sourceHashes["pure-oracle.ts"] = "f".repeat(64)),
    (r) => r.reports.pop(),
  ]) {
    const report = negativeUnitReport();
    mutate(report);
    assert.throws(() => verifyNegativeReport(report));
  }
});
test("W10: W09 attachments retain immutable bytes and incomplete row scope", async () => {
  const { produceNegativeLifecycle } = await import("./plugin-persistence-negative-lifecycle.ts");
  const directory = await mkdtemp(path.join(tmpdir(), "w10-attachment-oracle-"));
  try {
    const observation = await produceNegativeLifecycle({});
    const raw = JSON.stringify(observation),
      receipt = path.join(directory, "unit-only.json"),
      manifest = path.join(directory, "manifest.json");
    await writeFile(receipt, raw);
    const reference = {
      kind: "lifecycle",
      path: receipt,
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
    await writeFile(manifest, JSON.stringify([reference]));
    const attachments = await readNegativeAttachments(manifest);
    const coverage = negativeCoverage([], attachments);
    assert.equal(coverage.length, 29);
    assert.equal(coverage.filter((r) => r.attachments.length).length, 13);
    assert.ok(coverage.every((r) => r.status === "incomplete"));
    attachments[0].observation.rows[0].status = "passed";
    assert.throws(() => negativeCoverage([], attachments), /Changed embedded/);
    await writeFile(manifest, JSON.stringify([reference, reference]));
    await assert.rejects(readNegativeAttachments(manifest), /Duplicate/);
    await writeFile(manifest, JSON.stringify([reference]));
    await writeFile(receipt, raw + " ");
    await assert.rejects(readNegativeAttachments(manifest), /Changed W09 receipt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("W10: native join cannot promote worker-only or missing lifecycle adapters", async () => {
  const { verifyNativeNegativeAttachments } = await import("./plugin-persistence-harness.mjs");
  const { produceNegativeLifecycle } = await import("./plugin-persistence-negative-lifecycle.ts");
  assert.throws(() => verifyNativeNegativeAttachments([], []), /Missing W09 native/);
  const observation = await produceNegativeLifecycle({}),
    raw = JSON.stringify(observation);
  const attachment = {
    kind: "lifecycle",
    path: path.join(tmpdir(), "unit-only-never-written.json"),
    raw,
    observation,
    sha256: createHash("sha256").update(raw).digest("hex"),
    transport: "message-port",
    runIds: ["exercise", "reopen"],
  };
  const report = negativeUnitReport();
  assert.throws(
    () => verifyNativeNegativeAttachments([attachment], report.reports),
    /missing native lifecycle scenarios/,
  );
  assert.throws(
    () => verifyNativeNegativeAttachments([{ ...attachment, transport: "fake" }], report.reports),
    /transport identity/,
  );
  assert.throws(
    () =>
      verifyNativeNegativeAttachments(
        [{ ...attachment, runIds: ["exercise", "missing"] }],
        report.reports,
      ),
    /absent native run/,
  );
});

test("W10: compiled source inventory resolves raw resources and rejects drift", async () => {
  const { recordBundleSources } = await import("./plugin-persistence-run.mjs");
  const source = "tests/desktop/fixtures/plugin-persistence/settings.json",
    hashes = {};
  await recordBundleSources(
    [
      `kobrixa-raw-resource:${path.resolve(source)}`,
      "/tmp/w10-generated-entry.ts",
      "node_modules/w10-not-read.js",
    ],
    hashes,
  );
  assert.deepEqual(hashes, {
    [source]: createHash("sha256")
      .update(await readFile(source))
      .digest("hex"),
  });
  await recordBundleSources([source], hashes);
  hashes[source] = "f".repeat(64);
  await assert.rejects(recordBundleSources([source], hashes), /Source changed across bundles/);
});
