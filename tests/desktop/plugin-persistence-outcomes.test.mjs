import assert from "node:assert/strict";
import test from "node:test";
import {
  FOUNDATION_CASES,
  FOUNDATION_CHECKS,
  assertFoundationOutcome,
} from "./plugin-persistence-outcomes.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
import { verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { readFile } from "node:fs/promises";

test("outside receipt validator applies outcomes before accepting process cleanup", () => {
  assert.throws(() => verifyRunReceipt({ case: "healthy-release" }), /Missing foundation evidence/);
  const evidence = outcomeOracleFixture("healthy-release");
  evidence.checks.processExits = 1;
  assert.throws(
    () => verifyRunReceipt({ case: "healthy-release", evidence }),
    /Unexpected processExits/,
  );
  assert.throws(
    () => verifyRunReceipt({ case: "contention", evidence: outcomeOracleFixture("contention") }),
    /Missing contention observations/,
  );
  assert.throws(
    () =>
      verifyRunReceipt({ case: "suspend-wake", evidence: outcomeOracleFixture("suspend-wake") }),
    /Missing suspend observations/,
  );
});

test("ordinary test commands retain the pure oracle gate independently of native acceptance", async () => {
  const { scripts } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const requiredPersistence = [
    "outcomes",
    "contention",
    "suspend",
    "disconnect",
    "unknown",
    "action-replay",
    "renderer-loss",
    "optional-off",
    "sealed-ttl",
  ].map((name) => `tests/desktop/plugin-persistence-${name}.test.mjs`);
  const oracleFiles = scripts["test:persistence:oracles"].split(" ");
  assert.deepEqual(oracleFiles.slice(0, 2), ["node", "--test"]);
  assert.deepEqual(
    oracleFiles.slice(2).sort(),
    requiredPersistence.sort(),
    "Exact pure B2 suite; no native/evidence runner or duplicate",
  );
  const feature = scripts["test:feature-oracles"];
  assert.ok(feature.startsWith("node -e "));
  assert.ok(feature.includes("process.env.KOBRIXA_TEST_PYTHON"));
  assert.ok(feature.includes("['--test', ...process.argv.slice(1)]"));
  const requiredFeatures = [
    "motor-test-public.test.mjs",
    "sensor-lab-public-test.mjs",
    "sensor-lab-stdio-test.mjs",
    "sensor-lab-installed-test.mjs",
    "device-ui-public-test.mjs",
    "device-ui-stdio-test.mjs",
    "device-ui-installed-test.mjs",
  ].map((name) => `tests/desktop/${name}`);
  assert.deepEqual(
    feature
      .split(" ")
      .filter((token) => token.startsWith("tests/"))
      .sort(),
    requiredFeatures.sort(),
    "Only reviewed pure C/D/E suites, excluding mixed native-evidence boundary suite",
  );
  for (const name of ["test", "test:desktop", "test:ci"]) {
    const commands = scripts[name].split(" && ");
    for (const gate of ["test:persistence:oracles", "test:feature-oracles"])
      assert.equal(
        commands.filter((command) => command === `pnpm ${gate}`).length,
        1,
        `${name}: ${gate}`,
      );
  }
});

for (const id of FOUNDATION_CASES) {
  test(`pure outcome oracle: ${id}`, () => {
    assertFoundationOutcome(id, outcomeOracleFixture(id));
    for (const family of ["checks", "samples"]) {
      for (const key of FOUNDATION_CHECKS[id][family]) {
        const missing = outcomeOracleFixture(id);
        delete missing[family][key];
        assert.throws(() => assertFoundationOutcome(id, missing), `${id}.${family}.${key}`);
        const renamed = outcomeOracleFixture(id);
        renamed[family][`wrong-${key}`] = renamed[family][key];
        delete renamed[family][key];
        assert.throws(() => assertFoundationOutcome(id, renamed));
      }
    }
    for (const kind of FOUNDATION_CHECKS[id].events) {
      const missing = outcomeOracleFixture(id);
      missing.events = missing.events.filter((event) => event.kind !== kind);
      assert.throws(() => assertFoundationOutcome(id, missing));
    }
    // Every semantic field must reject a wrong value, not merely have the right type.
    for (const [key, value] of Object.entries(outcomeOracleFixture(id).checks)) {
      const invalid = outcomeOracleFixture(id);
      invalid.checks[key] =
        typeof value === "boolean" ? !value : typeof value === "number" ? -1 : "incorrect";
      assert.throws(() => assertFoundationOutcome(id, invalid), `${id}.checks.${key}`);
    }
  });
}

test("retirement validates identity before serialization and contents after serialization", () => {
  const original = outcomeOracleFixture("retirement");
  const serialized = JSON.parse(JSON.stringify(original));
  assert.throws(() => assertFoundationOutcome("retirement", serialized));
  assertFoundationOutcome("retirement", serialized, { serialized: true });
  serialized.events[1].grant.lastSequence++;
  assert.throws(() => assertFoundationOutcome("retirement", serialized, { serialized: true }));
  for (const mutate of [
    (e) => e.events[1].turn++,
    (e) => (e.events[2].turn = e.events[0].turn),
    (e) => e.events[1].deadline++,
    (e) => e.events[0].grant.expiresMonotonicMs--,
  ]) {
    const invalid = structuredClone(original);
    mutate(invalid);
    assert.throws(() => assertFoundationOutcome("retirement", invalid));
  }
});

test("TTL retries, generation replacement and disconnect ordering cannot weaken the outcome", () => {
  for (const [id, mutate] of [
    ["sealed-ttl", (e) => e.checks.expiryAfterFailedRetry++],
    ["sealed-ttl", (e) => e.checks.observedExpiry++],
    ["sealed-ttl", (e) => (e.checks.createdAt = e.checks.lastProgressAt + 1)],
    ["healthy-release", (e) => e.checks.generationAfter++],
    ["renderer-loss", (e) => (e.checks.newGeneration = e.checks.previousGeneration)],
    ["disconnect-retry", (e) => e.events.reverse()],
    ["disconnect-retry", (e) => (e.events.at(-1).time = 1)],
    ["disconnect-retry", (e) => (e.events.at(-1).turn = 0)],
    ["registration-end", (e) => e.checks.lastDeadline++],
    ["compatibility", (e) => (e.checks.pythonExecuted = false)],
  ]) {
    const invalid = outcomeOracleFixture(id);
    mutate(invalid);
    assert.throws(() => assertFoundationOutcome(id, invalid));
  }
});

test("load oracle enforces sample count, p95, maximum, memory and duration budgets", () => {
  const id = "storage-ui-pressure";
  for (const name of FOUNDATION_CHECKS[id].samples) {
    for (const mutate of [
      (e) => e.samples[name].pop(),
      (e) => e.samples[name].fill(10001),
      (e) => (e.samples[name][0] = NaN),
      (e) => (e.samples[name][0] = -1),
      (e) => delete e.samples[name][0],
    ]) {
      const invalid = outcomeOracleFixture(id);
      mutate(invalid);
      assert.throws(() => assertFoundationOutcome(id, invalid), name);
    }
  }
  for (const name of ["commitMs", "uiApplyMs", "uiRevokeMs"]) {
    const invalid = outcomeOracleFixture(id);
    invalid.samples[name][0] = 10001;
    assert.throws(() => assertFoundationOutcome(id, invalid), `${name} maximum`);
  }
  for (const key of [
    "mainExtraRss",
    "workerExtraRss",
    "mainSyncMaxMs",
    "peakPendingJobs",
    "uiHeapBytes",
    "residualBytes",
  ]) {
    const invalid = outcomeOracleFixture(id);
    invalid.checks[key]++;
    assert.throws(() => assertFoundationOutcome(id, invalid), key);
  }
  for (const key of ["cycles", "uiWarmupMs", "uiSampleMs", "uiRepeats", "deviceWorkloadMs"]) {
    const invalid = outcomeOracleFixture(id);
    invalid.checks[key]--;
    assert.throws(() => assertFoundationOutcome(id, invalid), key);
  }
});

test("shared manifest rejects unknown IDs and undeclared evidence", () => {
  assert.deepEqual(Object.keys(FOUNDATION_CHECKS).sort(), [...FOUNDATION_CASES].sort());
  for (const id of ["missing", "constructor", "__proto__"])
    assert.throws(() => assertFoundationOutcome(id, outcomeOracleFixture("healthy-release")));
  const invalid = outcomeOracleFixture("healthy-release");
  invalid.checks.imaginary = true;
  assert.throws(() => assertFoundationOutcome("healthy-release", invalid));
});

test("unknown-publication summaries require outside raw proof", () => {
  assert.throws(
    () =>
      verifyRunReceipt({
        case: "unknown-publication",
        evidence: outcomeOracleFixture("unknown-publication"),
      }),
    /Missing unknown-publication observations/,
  );
});

test("compatibility requires original trace and derives current publication", () => {
  const fixture = outcomeOracleFixture("compatibility");
  assert.equal(fixture.checks.publicApi18Published, true);
  delete fixture.compatibility;
  assert.throws(() => assertFoundationOutcome("compatibility", fixture));
});

test("partial pressure receipt cannot enter the full historical RSS gate", () => {
  const evidence = outcomeOracleFixture("storage-ui-pressure");
  evidence.pressure = { status: "partial-memory-unavailable" };
  assert.throws(() => assertFoundationOutcome("storage-ui-pressure", evidence), /Partial pressure/);
});
