import test from "node:test";
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
test("B2 §12.1: JS MessagePort and Python stdio use the public 1.7 router", async () => {
  verifyInterop(await readEvidence());
});
test("evidence gates reject absent and mock-only acceptance", async () => {
  await assert.rejects(readEvidence(""), /PERSISTENCE_EVIDENCE/);
  assert.throws(() => verifyMatrix({ level: "unit", cases: [] }), /real-process/);
  assert.throws(() => verifyInterop({ consumers: [] }), /two consumers/);
});

import ts from "typescript";
import { readFile } from "node:fs/promises";

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
  const source = await readFile(new URL("./plugin-persistence-main.ts", import.meta.url), "utf8");
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

import { preflight, runFoundationEvidence } from "./plugin-persistence-run.mjs";
test("BM-20 reference cases execute through createFoundationFixture", async () => {
  const result = await runFoundationEvidence({ referencesOnly: true });
  verifyFoundationReports(result.reports, ["retirement", "healthy-release"]);
});
test("verifier negatives: absent attachments fail closed before native allocation", async () => {
  await assert.rejects(preflight(""), /BLOCKED.*|missing|Missing/);
});

import { spawnSync } from "node:child_process";
import {
  FOUNDATION_CASES,
  FOUNDATION_CHECKS,
  assertFoundationEvidence,
} from "./plugin-persistence-main.ts";
test("verifier negatives: every declared foundation observation is required", () => {
  assert.equal(FOUNDATION_CASES.length, 15);
  assert.deepEqual(Object.keys(FOUNDATION_CHECKS).sort(), [...FOUNDATION_CASES].sort());
  for (const id of FOUNDATION_CASES) {
    const required = FOUNDATION_CHECKS[id];
    // Oracle-only shape example, never returned by a live producer.
    const evidence = {
      checks: Object.fromEntries(required.checks.map((k) => [k, 1])),
      events: required.events.map((kind, i) => ({ kind, turn: 0, time: i })),
      samples: Object.fromEntries(required.samples.map((k) => [k, Array(30).fill(1)])),
    };
    if (id === "retirement") {
      const grant = {};
      evidence.events[0].grant = grant;
      evidence.events[1].grant = grant;
      evidence.events[1].deadline = 1;
      evidence.events[2].deadline = 1;
    }
    if (id === "healthy-release")
      Object.assign(evidence.checks, {
        retireCalls: 0,
        freezeCalls: 0,
        processExits: 0,
        unrelatedSettingsCommitted: true,
      });
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
  const receipt = await superviseCase({}, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 });
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
    superviseCase({}, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
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
    superviseCase({}, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
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
    superviseCase({}, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
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
      superviseCase({}, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
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
    superviseCase({}, model.io, { timeoutMs: 10, pollMs: 1, settleMs: 2 }),
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
    superviseCase({}, model.io, { timeoutMs: 200, pollMs: 100, settleMs: 100 }),
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
