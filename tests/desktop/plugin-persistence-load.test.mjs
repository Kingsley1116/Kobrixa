import test from "node:test";
import assert from "node:assert/strict";
import { readEvidence, verifyLoad, statistics } from "./plugin-persistence-harness.mjs";
test("B2-RF5: 50 maximum records, four jobs, bounded RSS and stop dispatch", async () => {
  verifyLoad(await readEvidence());
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
