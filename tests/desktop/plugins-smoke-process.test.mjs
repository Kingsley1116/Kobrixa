import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { recordSmokeQuit, waitForSmokeExit } from "./plugins-smoke-process.mjs";

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
      child.emit("exit", 0);
      assert.equal(await result, 0);
    }
    t.mock.timers.tick(90_000);
    assert.equal(child.kill.mock.callCount(), 0);
  }
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
    recordSmokeQuit(app, directory, 4_000);
    app.emit("before-quit");
    app.emit("will-quit", { defaultPrevented: true });
    const report = path.join(directory, "quit-result.json");
    assert.equal(existsSync(report), false);
    now = 3_600;
    app.emit("before-quit");
    app.emit("will-quit", { defaultPrevented: false });
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
      elapsedMs: 3_500,
      shutdownDeadlineMs: 4_000,
      stubbornAlive: alive,
    });
  });
}
