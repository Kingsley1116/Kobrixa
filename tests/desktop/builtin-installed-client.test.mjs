import assert from "node:assert/strict";
import { test } from "node:test";
import { descendants, until, signalProcess } from "./builtin-installed-client.mjs";

test("process accounting retains reparented descendants and detached group members", () => {
  const known = new Set();
  const initial = [
    { pid: 10, ppid: 1, pgid: 10 },
    { pid: 13, ppid: 12, pgid: 13 },
    { pid: 12, ppid: 10, pgid: 12 },
    { pid: 14, ppid: 1, pgid: 10 },
    { pid: 99, ppid: 1, pgid: 99 },
  ];
  assert.deepEqual(
    descendants(initial, 10, known).map((item) => item.pid),
    [10, 13, 12, 14],
  );
  const orphan = [{ pid: 13, ppid: 1, pgid: 13 }];
  assert.deepEqual(descendants(orphan, 10, known), orphan);
  assert.deepEqual(descendants([], 10, known), []);
});

test("bounded polling propagates original errors and rejects absent evidence", async () => {
  const original = new Error("actual probe failure");
  await assert.rejects(
    until(() => {
      throw original;
    }, "probe"),
    (error) => error === original,
  );
  await assert.rejects(
    until(() => false, "missing evidence", 1),
    /Deadline: missing evidence/,
  );
  assert.deepEqual(await until(() => ({ actual: true }), "present"), { actual: true });
});

test("CDP client correlates replies and rejects pending work on close (unit transport only)", async () => {
  const { connect } = await import("./builtin-installed-client.mjs");
  const original = globalThis.WebSocket;
  const transports = [];
  class UnitSocket extends EventTarget {
    constructor() {
      super();
      transports.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.method === "pending") return;
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              id: request.id,
              result: { result: { value: request.params.expression } },
            }),
          }),
        ),
      );
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = UnitSocket;
  let client;
  try {
    client = await connect("ws://unit-transport.invalid");
    assert.equal(await client.js("original expression"), "original expression");
    const paused = client.event("Debugger.paused");
    transports[0].dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ method: "Debugger.paused", params: { reason: "unit" } }),
      }),
    );
    assert.deepEqual(await paused, { reason: "unit" });
    const pending = assert.rejects(client.send("pending"), /Debug client disposed/);
    const event = assert.rejects(client.event("never"), /Debug client disposed/);
    client.close();
    await Promise.all([pending, event]);
  } finally {
    client?.close();
    globalThis.WebSocket = original;
  }
});

test("vanished process group does not prevent signaling retained descendants", () => {
  for (const code of ["ESRCH", "EPERM"]) {
    const errors = [],
      calls = [];
    const original = Object.assign(new Error("group disappeared"), { code });
    const kill = (pid, signal) => {
      calls.push([pid, signal]);
      if (pid < 0) throw original;
    };
    signalProcess(-10, "SIGTERM", errors, kill);
    signalProcess(13, "SIGKILL", errors, kill);
    assert.deepEqual(calls, [
      [-10, "SIGTERM"],
      [13, "SIGKILL"],
    ]);
    assert.deepEqual(errors, code === "ESRCH" ? [] : [original]);
  }
});
