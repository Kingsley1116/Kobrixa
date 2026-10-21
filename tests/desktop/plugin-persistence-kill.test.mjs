import test from "node:test";
import { readEvidence, verifyKills } from "./plugin-persistence-harness.mjs";
test("B2-RF1: actual process death at every publication frontier", async () => {
  verifyKills(await readEvidence());
});

import assert from "node:assert/strict";
test("verifier negatives: mock kill and missing OS exit cannot pass", () => {
  assert.throws(() => verifyKills({ level: "unit", kills: [] }), /real-process/);
  assert.throws(() => verifyKills({ level: "real-process", kills: [] }), /./);
});
