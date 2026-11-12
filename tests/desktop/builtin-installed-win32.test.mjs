import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { createWindowsProcessObserver } from "./builtin-installed-win32.mjs";
import { descendants } from "./builtin-installed-client.mjs";

function runner() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let writes = 0,
    starts = 0,
    kills = 0;
  child.kill = () => {
    kills++;
  };
  child.stdin = new Writable({
    write(chunk, encoding, done) {
      assert.equal(String(chunk), "snapshot\n");
      writes++;
      done();
    },
  });
  return {
    child,
    reply: (rows) => child.stdout.write(JSON.stringify(rows) + "\r\n"),
    counts: () => ({ writes, starts, kills }),
    start(file, args, options) {
      starts++;
      assert.match(file, /powershell.exe$/);
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /while .*ReadLine/);
      assert.match(script, /Get-CimInstance Win32_Process/);
      assert.match(script, /\[Console\]::WriteLine/);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      return child;
    },
  };
}
const env = { SystemRoot: "C:\\Windows" };
async function ready(fake, options = {}) {
  const opening = createWindowsProcessObserver({ start: fake.start, env, ...options });
  fake.reply([]);
  return opening;
}

test("one warmed helper serializes polls and freshly observes orphans after parent exit", async () => {
  const fake = runner();
  const observer = await ready(fake);
  const known = new Map();
  const first = observer.poll();
  assert.equal(observer.poll(), first);
  fake.reply([
    { pid: 10, ppid: 1, created: "parent" },
    { pid: 11, ppid: 10, created: "child" },
  ]);
  descendants(await first, 10, known);
  const final = observer.poll();
  fake.reply([{ pid: 11, ppid: 1, created: "child" }]);
  assert.deepEqual(
    descendants(await final, 10, known).map((row) => row.pid),
    [11],
  );
  const clean = observer.poll();
  fake.reply([]);
  assert.deepEqual(await clean, []);
  assert.deepEqual(fake.counts(), { starts: 1, writes: 4, kills: 0 });
  observer.close();
  await assert.rejects(observer.poll(), /disposed/);
});

test("timed-out helper is killed and cannot queue more work or accept late evidence", async () => {
  const fake = runner();
  const observer = await ready(fake, { timeoutMs: 10 });
  await assert.rejects(observer.poll(), /request timed out/);
  fake.reply([]);
  await assert.rejects(observer.poll(), /request timed out/);
  assert.equal(fake.counts().writes, 2);
  assert.ok(fake.counts().kills > 0);
});

test("helper startup remains bounded", async () => {
  const fake = runner();
  await assert.rejects(
    createWindowsProcessObserver({ start: fake.start, env, startupTimeoutMs: 10 }),
    /timed out/,
  );
  assert.equal(fake.counts().writes, 1);
  assert.ok(fake.counts().kills > 0);
});

for (const mode of ["exit", "eof", "invalid", "spawn", "stdin"]) {
  test(`helper ${mode} fails observation and all subsequent polls`, async () => {
    const fake = runner();
    const observer = await ready(fake);
    const pending = observer.poll();
    fake.child.stderr.write("query diagnostics");
    if (mode === "exit") fake.child.emit("exit", 1, null);
    if (mode === "eof") fake.child.stdout.emit("end");
    if (mode === "invalid") fake.child.stdout.write("not-json\n");
    if (mode === "spawn") fake.child.emit("error", new Error("spawn failure"));
    if (mode === "stdin") fake.child.stdin.emit("error", new Error("pipe failure"));
    await assert.rejects(pending, /query diagnostics/);
    await assert.rejects(observer.poll(), /query diagnostics/);
    assert.equal(fake.counts().writes, 2);
  });
}

test("partial replies wait for the entire newline-delimited snapshot", async () => {
  const fake = runner();
  const observer = await ready(fake);
  const pending = observer.poll();
  fake.child.stdout.write('[{"pid":12,"ppid":1,');
  fake.child.stdout.write('"created":"identity"}]\r\n');
  assert.deepEqual(await pending, [{ pid: 12, ppid: 1, created: "identity" }]);
  observer.close();
});

test("public gate monitor retains helper failure and final cleanup cannot report success", async () => {
  const { createProcessMonitor, finishProcessObservation } =
    await import("./device-ui-stdio-run.mjs");
  const fake = runner();
  const observer = await ready(fake, { timeoutMs: 10 });
  const errors = [];
  const known = new Set([10, 11]);
  const monitor = createProcessMonitor({
    poll: observer.poll,
    observe: () => assert.fail("Failed observation must not produce evidence"),
    onError: (error) => errors.push(String(error)),
  });
  monitor.tick();
  await monitor.stop();
  const killed = [];
  const survivors = await finishProcessObservation({
    poll: observer.poll,
    parent: 10,
    known,
    onError: (error) => errors.push(String(error)),
    kill: (pid) => killed.push(pid),
  });
  assert.equal(errors.length, 2);
  assert.ok(errors.every((error) => error.includes("request timed out")));
  assert.deepEqual(survivors, [{ pid: 10 }, { pid: 11 }]);
  assert.deepEqual(killed, [10, 11]);
  assert.equal(fake.counts().writes, 2);
  observer.close();
});
