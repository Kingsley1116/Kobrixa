import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMatrix, assertParity, matrix, runOwnedMatrix } from "./device-broker-harness.mjs";

test("F01–F21: every owned negative case executes and none is skipped", async () => {
  const report = await runOwnedMatrix();
  assertMatrix(report);
});

test("matrix evidence cannot be replaced by an empty, skipped or failed suite", () => {
  assert.throws(() => assertMatrix({ cases: [] }));
  for (const status of ["pending", "skipped", "failed", "todo"]) {
    const cases = Object.keys(matrix).map((id) => ({ id, status: "passed", assertions: 1 }));
    cases[0].status = status;
    assert.throws(() => assertMatrix({ cases }));
  }
});

test("F16: parity requires actual MessagePort and Content-Length consumers", () => {
  const scenario = [
    "negotiate",
    "list",
    "session",
    "read",
    "subscribe",
    "mode-query",
    "mode-set",
    "reserve",
    "recording-read",
    "release",
    "prepare",
    "start",
    "stop",
    "query",
    "unsubscribe",
  ];
  const result = {
    transports: [
      { language: "js", transport: "electron-message-port", scenario, ok: true },
      { language: "python", transport: "content-length", scenario, ok: true },
    ],
  };
  assertParity(result);
  assert.throws(() => assertParity({ transports: result.transports.slice(0, 1) }));
  assert.throws(() =>
    assertParity({ transports: result.transports.map((x) => ({ ...x, transport: "memory" })) }),
  );
  assert.throws(() =>
    assertParity({
      transports: result.transports.map((x) => ({ ...x, scenario: scenario.slice(0, -1) })),
    }),
  );
});
