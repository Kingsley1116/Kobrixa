import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertSmokeQuit, recordSmokeQuit, waitForSmokeExit } from "./plugins-smoke-process.mjs";

for (const phase of [
  "Plugin smoke",
  "Plugin GUI smoke (first)",
  "Plugin GUI smoke (second)",
  "Plugin GUI smoke (third)",
]) {
  test(`${phase} is killed and fails after 90 seconds`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new EventEmitter();
    child.kill = t.mock.fn();
    const result = waitForSmokeExit(child, phase);
    t.mock.timers.tick(89_999);
    assert.equal(child.kill.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.deepEqual(
      child.kill.mock.calls.map((call) => call.arguments),
      [["SIGKILL"]],
    );
    await assert.rejects(result, {
      message: `${phase} timed out after 90000 ms; Electron was killed with SIGKILL.`,
    });
  });
}

test("clears the timeout after an exit or spawn error", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failed of [false, true]) {
    const child = new EventEmitter();
    child.kill = t.mock.fn();
    const result = waitForSmokeExit(child, "Plugin smoke");
    if (failed) {
      child.emit("error", new Error("spawn failed"));
      await assert.rejects(result, /spawn failed/);
    } else {
      child.emit("exit", 0, null);
      assert.deepEqual(await result, { code: 0, signal: null });
    }
    t.mock.timers.tick(90_000);
    assert.equal(child.kill.mock.callCount(), 0);
  }
});

test("preserves the signal when Electron exits without an exit code", async () => {
  const child = new EventEmitter();
  const result = waitForSmokeExit(child, "Plugin GUI smoke (second)");
  child.emit("exit", null, "SIGKILL");
  assert.deepEqual(await result, { code: null, signal: "SIGKILL" });
});

for (const alive of [false, true]) {
  test(`records elapsed time and stubborn liveness (${alive}) before allowing quit`, (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), "kobrixa-quit-probe-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(path.join(directory, "stubborn-ts"));
    writeFileSync(path.join(directory, "stubborn-ts/pid.txt"), "123");
    let now = 100;
    t.mock.method(performance, "now", () => now);
    t.mock.method(process, "kill", (pid, signal) => {
      assert.equal(pid, 123);
      assert.equal(signal, 0);
      if (!alive) throw Object.assign(new Error("exited"), { code: "ESRCH" });
      return true;
    });
    const app = new EventEmitter();
    const recordForceKill = recordSmokeQuit(app, directory, 4_000, 1_000);
    app.emit("before-quit");
    app.emit("will-quit", { defaultPrevented: true });
    const report = path.join(directory, "quit-result.json");
    assert.equal(existsSync(report), false);
    now = 3_100;
    recordForceKill();
    now = 3_200;
    app.emit("before-quit");
    app.emit("will-quit", { defaultPrevented: false });
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
      elapsedMs: 3_100,
      shutdownDeadlineMs: 4_000,
      forceAtMs: 3_000,
      forceKillMs: 3_000,
      stubbornAlive: alive,
    });
  });
}

const successfulQuit = {
  elapsedMs: 3_100,
  shutdownDeadlineMs: 4_000,
  forceAtMs: 3_000,
  forceKillMs: 3_000,
  stubbornAlive: false,
};

test("accepts manager force-kill and quit within their time limits", () => {
  assertSmokeQuit(successfulQuit);
});

test("accepts timely manager force-kill with quit reporting delayed to 3700 ms", () => {
  assertSmokeQuit({ ...successfulQuit, elapsedMs: 3_700 });
});

for (const [description, overrides, error] of [
  ["supervisor escalation without manager forceKill", { forceKillMs: null }, /Manager did not/],
  ["manager forceKill delayed by a blocking kill", { forceKillMs: 4_000 }, /Manager did not/],
  ["manager forceKill at the strict time limit", { forceKillMs: 3_500 }, /Manager did not/],
  ["the previously passing 4010 ms quit", { elapsedMs: 4_010 }, /Plugin quit took/],
  ["quit at the strict time limit", { elapsedMs: 3_800 }, /Plugin quit took/],
  ["a process still alive before Electron exits", { stubbornAlive: true }, /still alive/],
]) {
  test(`rejects ${description}`, () => {
    assert.throws(() => assertSmokeQuit({ ...successfulQuit, ...overrides }), error);
  });
}
