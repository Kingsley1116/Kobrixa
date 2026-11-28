import test from "node:test";
import assert from "node:assert/strict";
import { verifyCurrentLoad } from "./b2-process-rss-verify.mjs";
import { readEvidence, statistics } from "./plugin-persistence-harness.mjs";
test("B2-RF5: 50 maximum records, four jobs, bounded RSS and stop dispatch", async () => {
  await verifyCurrentLoad(await readEvidence(), process.env.PERSISTENCE_EVIDENCE);
});
test("percentiles require thirty finite samples and retain the maximum", () => {
  assert.throws(() => statistics(Array(29).fill(1)), /30 samples/);
  assert.throws(() => statistics([...Array(29).fill(1), Infinity]), /finite/);
  assert.deepEqual(statistics(Array.from({ length: 30 }, (_, i) => i + 1)), {
    count: 30,
    p50: 15,
    p95: 29,
    max: 30,
  });
});

test("verifier negatives: statistics reject sparse, negative and nonnumeric measurements", () => {
  for (const samples of [Array(30), Array(30).fill(-1), Array(30).fill("1"), Array(31).fill(1)])
    assert.throws(() => statistics(samples));
});

test("pressure pure selector preserves RF5 and partial evidence cannot join full reports", async () => {
  const { selectFoundationCases } = await import("./plugin-persistence-run.mjs");
  const { verifyFoundationReports } = await import("./plugin-persistence-harness.mjs");
  assert.deepEqual(selectFoundationCases({ caseId: "storage-ui-pressure" }), [
    "storage-ui-pressure",
  ]);
  assert.deepEqual(selectFoundationCases({ caseId: "import-restart" }), ["import-restart"]);
  assert.throws(
    () =>
      verifyFoundationReports(
        [{ case: "storage-ui-pressure", evidence: { pressure: {} } }],
        ["storage-ui-pressure"],
      ),
    /partial/,
  );
});

test("cycle focus recovery activates the load window and propagates renderer focus failures", async () => {
  const { withLoadForeground } = await import("./b2-process-rss-pressure.ts");
  const { EventEmitter } = await import("node:events");
  const calls = [];
  const window = Object.assign(new EventEmitter(), {
    webContents: { focus: () => calls.push("contents") },
    isDestroyed: () => false,
    isMinimized: () => false,
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  });
  await assert.rejects(
    withLoadForeground(
      window,
      () => calls.push("activate"),
      async () => {
        window.emit("blur");
        await new Promise((resolve) => setImmediate(resolve));
        throw Error("focused, visible load renderer");
      },
    ),
    /focused, visible/,
  );
  assert.deepEqual(
    calls,
    [...Array(2)].flatMap(() => ["show", "activate", "focus", "contents"]),
  );
  assert.deepEqual(window.eventNames(), []);
});
