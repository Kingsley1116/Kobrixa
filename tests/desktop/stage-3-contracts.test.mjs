import assert from "node:assert/strict";
import test from "node:test";
import { publication, validateNative } from "./stage-3-contracts-run.mjs";
import { approvedHost, verifyCompatibility } from "./plugin-persistence-compatibility.ts";
import { compatibilityOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";

// Synthetic receipts below test the validator, never count as process acceptance.
test("current source publishes 1.8 and preserves intentional manifest ranges", async () => {
  const result = await publication();
  assert.equal(result.apiVersion, "1.8.0");
  assert.equal(typeof result.jsDistribution, "string");
  assert.equal(typeof result.pythonDistribution, "string");
});
test("publication ruling rejects every unapproved host version", () => {
  for (const version of [
    "1.4.0",
    "1.5.0",
    "1.6.0",
    "1.8.1",
    "1.9.0",
    "2.0.0",
    "1.8.0-preview",
    "garbage",
    undefined,
  ])
    assert.throws(() => approvedHost(version));
  assert.equal(approvedHost("1.8.0"), true);
});
test("current-stage join refuses missing real process observations", async () => {
  await assert.rejects(validateNative({ level: "fixture", reports: [] }));
  await assert.rejects(validateNative({ level: "real-process", reports: [] }));
});
test("historical SDK matrix retains 1.4–1.7 against 1.8", () => {
  const result = verifyCompatibility(compatibilityOracleFixture("1.8.0"));
  assert.equal(result.publicApi18Published, true);
  assert.deepEqual(result.apiVersions, ["1.4.0", "1.5.0", "1.6.0", "1.7.0"]);
});
for (const language of ["js", "py"]) {
  for (const sdk of ["1.4.0", "1.5.0", "1.6.0"]) {
    test(`reject unsolicited drain to ${language} ${sdk}`, () => {
      const fixture = compatibilityOracleFixture("1.8.0");
      const entry = fixture.cases.find((entry) => entry.language === language && entry.sdk === sdk);
      const row = fixture.rows.find((row) => row.caseId === entry.id);
      const index = row.wire.findIndex((wire) => wire.message.method === "shutdown");
      row.wire.splice(index, 0, {
        direction: "host",
        sequence: (row.wire[index - 1].sequence + row.wire[index].sequence) / 2,
        message: { jsonrpc: "2.0", id: "unsolicited", method: "storage/drain", params: {} },
      });
      assert.throws(() => verifyCompatibility(fixture));
    });
  }
}
for (const version of ["1.8.1", "1.9.0", "2.0.0", "unknown"]) {
  test(`reject unknown negotiated peer ${version}`, () => {
    for (const language of ["js", "py"]) {
      const fixture = compatibilityOracleFixture("1.8.0");
      const entry = fixture.cases.find(
        (entry) => entry.language === language && entry.sdk === "1.8.0",
      );
      const row = fixture.rows.find((row) => row.caseId === entry.id);
      row.wire.find((wire) => wire.message.result?.apiVersion).message.result.apiVersion = version;
      assert.throws(() => verifyCompatibility(fixture));
    }
  });
}
