import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMovement } from "./support/movement.mjs";
import { compileRobotFixture } from "./support/robot-project.mjs";

test("Movement: steering grid, repeated calls, turns and timed moves", async () => {
  const { decoded, names, global } = await compileRobotFixture();
  const result = checkMovement(decoded, names, global);
  assert.equal(result.gridCases, 5460);
  assert.equal(result.repeatedCalls, 9);
  assert.equal(result.turns, 2);
  assert.equal(result.timedMoves, 4);
  assert.deepEqual(result.failures, []);
});
