import test from "node:test";
import assert from "node:assert/strict";
import { readEvidence, verifyMatrix, verifyInterop } from "./plugin-persistence-harness.mjs";

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
