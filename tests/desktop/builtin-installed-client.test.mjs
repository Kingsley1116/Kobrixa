import assert from "node:assert/strict";
import { test } from "node:test";
import {
  connect,
  descendants,
  until,
  signalProcess,
  observeBeforeStartup,
  releaseStartingWorkers,
  waitForRendererTarget,
} from "./builtin-installed-client.mjs";

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

test("startup handshake observes the pause before installing and resumes only on success", async () => {
  const { observeBeforeStartup } = await import("./builtin-installed-client.mjs");
  for (const fail of [false, true]) {
    const calls = [];
    let signalPause;
    const client = {
      event(method) {
        calls.push(method);
        return new Promise((resolve) => {
          signalPause = resolve;
        });
      },
      async send(method) {
        calls.push(method);
        if (method === "Runtime.runIfWaitingForDebugger")
          signalPause({ reason: "Break on start", callFrames: [{ callFrameId: "entry" }] });
      },
    };
    const work = observeBeforeStartup(client, async () => {
      calls.push("install and assert pre-ready");
      if (fail) throw Error("too late");
    });
    if (fail) await assert.rejects(work, /too late/);
    else await work;
    assert.deepEqual(calls, [
      "Debugger.enable",
      "Debugger.paused",
      "Runtime.runIfWaitingForDebugger",
      "install and assert pre-ready",
      ...(fail ? [] : ["Debugger.resume", "Debugger.disable"]),
    ]);
  }
});

test("deadline retains failure diagnostics without retrying or replacing probe errors", async () => {
  await assert.rejects(
    until(
      () => false,
      "real motor panel rendered",
      1,
      () => ({
        activation: "PLUGIN_E_ENTRY",
        resource: "unavailable",
        provider: "failed",
      }),
    ),
    /Deadline: real motor panel rendered: .*PLUGIN_E_ENTRY.*unavailable.*failed/,
  );
});

test("startup does not install on the runIfWaiting reply alone", async () => {
  const { observeBeforeStartup } = await import("./builtin-installed-client.mjs");
  let signalPause,
    installed = false;
  const work = observeBeforeStartup(
    {
      send: async () => {},
      event: () =>
        new Promise((resolve) => {
          signalPause = resolve;
        }),
    },
    async () => {
      installed = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installed, false);
  signalPause({ reason: "Break on start", callFrames: [{ callFrameId: "entry" }] });
  await work;
  assert.equal(installed, true);
});

test("inspect-brk gates evaluation on release and uses synchronous paused-frame evaluation", async () => {
  const { observeBeforeStartup } = await import("./builtin-installed-client.mjs");
  for (const outcome of ["success", "exception", "ready", "missing-frame"]) {
    const calls = [];
    let enabled = false,
      released = false,
      paused = false,
      signalPause;
    const blocked = [];
    const client = {
      event(method) {
        assert.equal(method, "Debugger.paused");
        assert.equal(enabled, true);
        return new Promise((resolve) => {
          signalPause = resolve;
        });
      },
      async send(method, params = {}) {
        calls.push(method);
        if (method === "Debugger.enable") enabled = true;
        if (method === "Runtime.evaluate") {
          // Model both deadlocks: pre-release evaluation and promise evaluation
          // while stopped. Deliberately do not reply until the gate is released.
          if (!released || (paused && params.awaitPromise))
            return new Promise((resolve) => blocked.push(resolve));
          throw Error("Startup must evaluate in the paused module scope");
        }
        if (method === "Runtime.runIfWaitingForDebugger") {
          assert.equal(enabled, true);
          released = true;
          for (const resolve of blocked.splice(0)) resolve({ result: { value: true } });
          paused = true;
          signalPause({
            callFrames: outcome === "missing-frame" ? [] : [{ callFrameId: "module-frame" }],
          });
        }
        if (method === "Debugger.evaluateOnCallFrame") {
          assert.equal(released && paused, true);
          assert.equal(params.callFrameId, "module-frame");
          assert.equal(Object.hasOwn(params, "awaitPromise"), false);
          assert.equal(params.returnByValue, true);
          if (outcome === "exception") return { exceptionDetails: { text: "probe failed" } };
          return { result: { value: outcome !== "ready" } };
        }
        if (method === "Debugger.resume") paused = false;
      },
    };
    // Verify the fake really withholds a pre-release Runtime.evaluate reply.
    let answered = false;
    const gated = client.send("Runtime.evaluate").then(() => {
      answered = true;
    });
    await Promise.resolve();
    assert.equal(answered, false);
    calls.length = 0;
    const work = observeBeforeStartup(client, async (evaluate) => {
      assert.equal(await evaluate("install probe"), true, "pre-ready required");
      assert.equal(await evaluate("!app.isReady()"), true, "pre-ready required");
    });
    if (outcome === "success") await work;
    else await assert.rejects(work, /probe failed|pre-ready required|Startup pause/);
    await gated;
    assert.deepEqual(calls, [
      "Debugger.enable",
      "Runtime.runIfWaitingForDebugger",
      ...(outcome === "missing-frame" ? [] : ["Debugger.evaluateOnCallFrame"]),
      ...(outcome === "success"
        ? ["Debugger.evaluateOnCallFrame", "Debugger.resume", "Debugger.disable"]
        : []),
    ]);
  }
});

async function fakeInspector(run) {
  const original = globalThis.WebSocket;
  const sockets = [];
  let client;
  class InspectorSocket extends EventTarget {
    requests = [];
    handler = (request) => this.reply(request.id, {});
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    message(message) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
    reply(id, result) {
      this.message({ id, result });
    }
    event(method, params) {
      this.message({ method, params });
    }
    send(raw) {
      const request = JSON.parse(raw);
      this.requests.push(request);
      this.handler(request);
    }
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = InspectorSocket;
  try {
    client = await connect("ws://fake-inspector.invalid");
    await run(client, sockets[0]);
  } finally {
    client?.close();
    globalThis.WebSocket = original;
  }
}

const attachWorker = (socket, sessionId, waitingForDebugger = true) =>
  socket.event("NodeWorker.attachedToWorker", {
    sessionId,
    waitingForDebugger,
    workerInfo: {
      workerId: sessionId,
      type: "worker",
      title: sessionId,
      url: "file:///installed/persistence-worker.cjs",
    },
  });
const workerReply = (socket, sessionId, reply = { id: 1, result: {} }) =>
  socket.event("NodeWorker.receivedMessageFromWorker", {
    sessionId,
    message: JSON.stringify(reply),
  });

test("fake inspector releases inherited worker waits across main resume and detaches after worker replies", async () => {
  await fakeInspector(async (client, socket) => {
    const evidence = {},
      routed = [];
    let enabled = false,
      installed = false;
    socket.handler = ({ id, method, params }) => {
      if (method === "NodeWorker.enable") {
        assert.deepEqual(params, { waitForDebuggerOnStart: false });
        enabled = true;
      } else if (method === "Runtime.runIfWaitingForDebugger") {
        assert.equal(enabled, true);
        socket.event("Debugger.paused", {
          reason: "Break on start",
          callFrames: [{ callFrameId: "entry" }],
        });
      } else if (method === "Debugger.evaluateOnCallFrame") {
        assert.equal(params.callFrameId, "entry");
        assert.equal(Object.hasOwn(params, "awaitPromise"), false);
        socket.reply(id, { result: { value: true } });
        return;
      } else if (method === "Debugger.resume") {
        assert.equal(installed, true);
        // Worker events can arrive before the main resume response.
        attachWorker(socket, "persistence");
        attachWorker(socket, "language", false);
      } else if (method === "NodeWorker.sendMessageToWorker") {
        assert.deepEqual(JSON.parse(params.message), {
          id: 1,
          method: "Runtime.runIfWaitingForDebugger",
          params: {},
        });
        routed.push(params.sessionId);
      } else if (method === "NodeWorker.detach") {
        socket.event("NodeWorker.detachedFromWorker", { sessionId: params.sessionId });
      }
      socket.reply(id, {});
    };
    const workers = await releaseStartingWorkers(client, evidence);
    try {
      await observeBeforeStartup(client, async (evaluate) => {
        assert.equal(await evaluate("install probe before ready"), true);
        installed = true;
      });
      assert.deepEqual(routed, ["persistence", "language"]);
      assert.ok(evidence.targets.every((row) => row.releasedAt === undefined)); // Envelope ACK alone is insufficient.
      workerReply(socket, "unknown");
      workerReply(socket, "persistence", { id: 9, result: {} });
      assert.equal(evidence.targets[0].releasedAt, undefined);
      workerReply(socket, "language"); // Same inner ID, different session; out of order.
      workerReply(socket, "persistence");
      await workers.settled();
      assert.ok(evidence.targets.every((row) => row.detachedAt >= row.releasedAt && !row.error));
      // Keep handling future workers after the main Debugger domain is disabled.
      attachWorker(socket, "later");
      workerReply(socket, "later");
      await workers.settled();
      assert.equal(evidence.targets.length, 3);
      assert.equal(socket.requests.filter((r) => r.method === "Debugger.enable").length, 1);
      workers.dispose();
      attachWorker(socket, "after-dispose");
      assert.equal(evidence.targets.length, 3);
    } finally {
      workers.dispose();
    }
  });
});

test("worker protocol failures are bounded and retained without unhandled event-task rejections", async () => {
  for (const outcome of [
    "inner-error",
    "outer-error",
    "detached",
    "closed",
    "timeout",
    "ack-timeout",
    "malformed",
  ]) {
    await fakeInspector(async (client, socket) => {
      const evidence = {};
      socket.handler = ({ id, method }) => {
        if (method === "NodeWorker.sendMessageToWorker" && outcome === "ack-timeout") return;
        if (method === "NodeWorker.sendMessageToWorker" && outcome === "outer-error")
          socket.message({ id, error: { message: "forward failed" } });
        else socket.reply(id, {});
      };
      const workers = await releaseStartingWorkers(client, evidence, 10);
      try {
        attachWorker(socket, "worker");
        if (outcome === "ack-timeout") workerReply(socket, "worker");
        if (outcome === "inner-error")
          workerReply(socket, "worker", { id: 1, error: { message: "release failed" } });
        if (outcome === "detached")
          socket.event("NodeWorker.detachedFromWorker", { sessionId: "worker" });
        if (outcome === "closed") socket.close();
        if (outcome === "malformed")
          socket.event("NodeWorker.receivedMessageFromWorker", {
            sessionId: "worker",
            message: "{",
          });
        await assert.rejects(workers.settled(), /Worker startup inspector: worker:/);
        assert.throws(() => workers.check(), /Worker startup inspector/);
        assert.equal(typeof evidence.targets[0].error.message, "string");
        assert.equal(evidence.targets[0].releasedAt, undefined);
        assert.equal(
          socket.requests.some((r) => r.method === "NodeWorker.detach"),
          false,
        );
      } finally {
        workers.dispose();
      }
    });
  }
});

test("worker attachment and nested reply may precede their parent command acknowledgments", async () => {
  await fakeInspector(async (client, socket) => {
    const evidence = {};
    socket.handler = ({ id, method, params }) => {
      if (method === "NodeWorker.enable") attachWorker(socket, "early", false);
      if (method === "NodeWorker.sendMessageToWorker") workerReply(socket, params.sessionId);
      socket.reply(id, {});
    };
    const workers = await releaseStartingWorkers(client, evidence);
    try {
      await workers.settled();
      assert.equal(evidence.targets.length, 1);
      assert.ok(evidence.targets[0].detachedAt);
    } finally {
      workers.dispose();
    }
  });
});

test("unsupported NodeWorker protocol fails before releasing the main startup wait", async () => {
  await fakeInspector(async (client, socket) => {
    socket.handler = ({ id }) => socket.message({ id, error: { message: "Method not found" } });
    const evidence = {};
    await assert.rejects(releaseStartingWorkers(client, evidence), /Method not found/);
    assert.equal(evidence.enabled, false);
    assert.deepEqual(
      socket.requests.map((r) => r.method),
      ["NodeWorker.enable"],
    );
    attachWorker(socket, "after-failure");
    assert.deepEqual(evidence.targets, []);
  });
});

test("renderer discovery retries transport timeout then accepts only an installed page target", async () => {
  const evidence = {};
  const target = {
    type: "page",
    url: "file:///installed/index.html",
    webSocketDebuggerUrl: "ws://renderer",
  };
  let calls = 0;
  const result = await waitForRendererTarget("ws://127.0.0.1:1234/devtools/browser/id", {
    evidence,
    timeoutMs: 1000,
    fetchImpl: async (url, { signal }) => {
      assert.equal(url, "http://127.0.0.1:1234/json/list");
      assert.ok(signal instanceof AbortSignal);
      if (++calls === 1) throw new DOMException("request timed out", "TimeoutError");
      return {
        ok: true,
        json: async () => (calls === 2 ? [{ type: "page", url: "about:blank" }] : [target]),
      };
    },
  });
  assert.equal(result, target);
  assert.equal(evidence.attempts, 3);
  assert.equal(evidence.lastTransportError.name, "TimeoutError");
});

test("renderer discovery bounds body reads and retains startup, worker, and timeout diagnostics", async () => {
  const evidence = {};
  // Keep the test alive while AbortSignal's unref'ed deadline fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(
      waitForRendererTarget("ws://localhost:1234", {
        evidence,
        timeoutMs: 25,
        requestTimeoutMs: 5,
        diagnostics: () => ({
          outputTail: "Primary startup failed. Error: worker-before-ready",
          workerInspector: { targets: [{ sessionId: "persistence" }] },
        }),
        fetchImpl: async (_url, { signal }) => ({
          ok: true,
          json: () =>
            new Promise((resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
        }),
      }),
      /Deadline: renderer \/json\/list target.*worker-before-ready.*persistence.*TimeoutError/,
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(evidence.attempts >= 1);
});

test("renderer discovery does not retry invalid responses or product failures", async () => {
  for (const outcome of ["json", "http", "shape", "exit", "startup"]) {
    const evidence = {};
    let calls = 0;
    await assert.rejects(
      waitForRendererTarget("ws://localhost:1234", {
        evidence,
        check: () => {
          if (outcome === "exit") throw Error("Product exited before evidence");
          if (outcome === "startup") throw Error("Primary startup failed: worker-before-ready");
        },
        fetchImpl: async () => {
          calls++;
          return {
            ok: outcome !== "http",
            status: 503,
            json: async () => {
              if (outcome === "json") throw new SyntaxError("bad JSON");
              return {};
            },
          };
        },
      }),
      /bad JSON|HTTP 503|target array|Product exited|worker-before-ready/,
    );
    assert.equal(calls, ["exit", "startup"].includes(outcome) ? 0 : 1);
  }
});

test("an inspector listener with sandbox failures and no page cannot pass renderer discovery", async () => {
  const evidence = {};
  const diagnostics = {
    workerInspector: { enabled: true, waitForDebuggerOnStart: false, targets: [] },
    workerTimeline: [],
    outputTail:
      "DevTools listening on ws://127.0.0.1:49186/devtools/browser/unit\n" +
      "sandbox initialization failed: Operation not permitted\n" +
      "GPU process exited unexpectedly: exit_code=6\n" +
      "Network service crashed or was terminated, restarting service.",
  };
  await assert.rejects(
    waitForRendererTarget("ws://127.0.0.1:49186/devtools/browser/unit", {
      evidence,
      timeoutMs: 10,
      diagnostics: () => diagnostics,
      fetchImpl: async () => ({ ok: true, json: async () => [] }),
    }),
    (error) => {
      assert.match(error.message, /Deadline: renderer \/json\/list target/);
      assert.ok(error.message.includes(JSON.stringify(diagnostics.outputTail)));
      assert.ok(error.message.includes(JSON.stringify(diagnostics.workerInspector)));
      assert.deepEqual(evidence.targets, []);
      return true;
    },
  );
});

test("Windows CIM process observation records creation identity without localized text parsing", async () => {
  const { processTable, parseWindowsProcessTable } = await import("./builtin-installed-client.mjs");
  const rows = [
    {
      pid: 10,
      ppid: 1,
      created: "2026-11-11T01:00:00Z",
      executable: "C:\\app\\kobrixa.exe",
      commandLine: "kobrixa.exe --inspect-brk",
    },
    { pid: 12, ppid: 10, created: "2026-11-11T01:00:01Z", executable: null, commandLine: null },
  ];
  const actual = await processTable({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    run: async (file, args, options) => {
      assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.ok(args.includes("-NoProfile") && args.includes("-NonInteractive"));
      assert.equal(args.at(-2), "-EncodedCommand");
      assert.ok(!args.includes("-Command"));
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /Get-CimInstance Win32_Process/);
      assert.match(script, /CreationDate.*ToUniversalTime/);
      assert.match(script, /pid = \[uint32\]\$_\.ProcessId/);
      assert.match(script, /ppid = \[uint32\]\$_\.ParentProcessId/);
      assert.match(script, /ConvertTo-Json -InputObject \$rows -Compress/);
      assert.match(script, /\[Console\]::Error.WriteLine\(\$_\.ToString\(\)\)/);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 20_000);
      assert.equal(options.maxBuffer, 16 * 1024 * 1024);
      return { stdout: "\uFEFF" + JSON.stringify(rows) };
    },
  });
  assert.deepEqual(actual, rows);
  assert.deepEqual(parseWindowsProcessTable(JSON.stringify(rows[0])), [rows[0]]);
  assert.throws(() => parseWindowsProcessTable('{"pid":"10","ppid":1}'), /Malformed/);
  assert.throws(() => parseWindowsProcessTable("not json"));
  assert.throws(() => parseWindowsProcessTable('{"pid":10,"ppid":1,"created":0}'));
  assert.deepEqual(parseWindowsProcessTable("[]"), []);
  for (const id of [-1, 1.5, 0x1_0000_0000])
    assert.throws(
      () => parseWindowsProcessTable(JSON.stringify({ ...rows[0], pid: id })),
      /Malformed/,
    );
});

test("Windows process table accepts uint32 IDs and output larger than the former buffer", async () => {
  const { processTable } = await import("./builtin-installed-client.mjs");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  // A real child exercises execFile's buffer, without requiring PowerShell.
  const rows = await processTable({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    run: (_file, _args, options) =>
      execute(
        process.execPath,
        [
          "-e",
          `process.stdout.write(JSON.stringify(Array.from({length: 256}, (_, i) => ({
            pid: 4294967295 - i, ppid: 2147483648, created: '2026-11-11T01:00:00Z',
            commandLine: 'x'.repeat(20 * 1024)
          }))))`,
        ],
        options,
      ),
  });
  assert.equal(rows.length, 256);
  assert.equal(rows[0].pid, 0xffff_ffff);
  assert.equal(rows[0].ppid, 0x8000_0000);
  assert.equal(rows.at(-1).commandLine.length, 20 * 1024);
});

test("Windows process-table failures retain stderr and termination details in string-only monitors", async () => {
  const { processTable } = await import("./builtin-installed-client.mjs");
  for (const details of [
    { code: 1, stderr: "CreationDate conversion failed", stdout: "partial" },
    { code: null, signal: "SIGTERM", killed: true, stderr: "" },
    { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", stderr: "buffer exhausted", stdout: "partial" },
  ]) {
    const original = Object.assign(new Error("Command failed"), details);
    await assert.rejects(
      processTable({
        platform: "win32",
        env: { SystemRoot: "C:\\Windows" },
        run: async () => {
          throw original;
        },
      }),
      (error) => {
        assert.equal(error.cause, original);
        assert.match(String(error), /Windows process-table query failed/);
        for (const [key, value] of Object.entries(details)) {
          assert.equal(error[key], value);
          assert.ok(String(error).includes(`${JSON.stringify(key)}:${JSON.stringify(value)}`));
        }
        return true;
      },
    );
  }
  await assert.rejects(
    processTable({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      run: async () => ({ stdout: "" }),
    }),
    SyntaxError,
  );
});

test("installed ASAR lookups use host separators and keep the copied archive identity", async (t) => {
  const { openInstalledArchive } = await import("./builtin-process-installed.mjs");
  const path = (await import("node:path")).default;
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createPackageWithOptions } = await import("@electron/asar");
  const directory = await mkdtemp(path.join(tmpdir(), "installed-asar-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stage = path.join(directory, "stage");
  const manifest = ".vite/build/plugins/motor-test/kobrixa-plugin.json";
  const main = ".vite/build/main.cjs";
  await mkdir(path.dirname(path.join(stage, manifest)), { recursive: true });
  await writeFile(path.join(stage, manifest), '{"id":"kobrixa.motor-test"}');
  await writeFile(path.join(stage, main), "installed main fixture");
  const archive = path.join(directory, "app.asar");
  await createPackageWithOptions(stage, archive, { unpack: "kobrixa-plugin.json" });
  const actual = openInstalledArchive(archive);
  assert.equal(actual.stat(manifest).unpacked, true);
  assert.equal(JSON.parse(actual.extract(manifest)).id, "kobrixa.motor-test");
  assert.equal(actual.extract(main).toString(), "installed main fixture");
  assert.throws(() => actual.stat("missing.json"), /not found/);

  // Exercise Windows lookup semantics even on a POSIX unit-test host.
  const windowsArchive = "C:\\copied app\\resources\\app.asar";
  const windows = openInstalledArchive(windowsArchive, {
    hostPath: path.win32,
    stat: (file, member) => {
      assert.equal(file, windowsArchive);
      assert.equal(member, ".vite\\build\\plugins\\motor-test\\kobrixa-plugin.json");
      return actual.stat(member.replaceAll("\\", "/"));
    },
    extract: (file, member) => {
      assert.equal(file, windowsArchive);
      assert.equal(member, ".vite\\build\\main.cjs");
      return actual.extract(member.replaceAll("\\", "/"));
    },
  });
  assert.equal(windows.stat(manifest).unpacked, true);
  assert.equal(windows.extract(main).toString(), "installed main fixture");
});

test("Windows ancestry retains orphan identity and excludes reused PIDs and their children", () => {
  const known = new Map();
  const rows = [
    { pid: 10, ppid: 1, created: "original-root" },
    { pid: 13, ppid: 12, created: "original-grandchild" },
    { pid: 12, ppid: 10, created: "original-child" },
  ];
  assert.deepEqual(descendants(rows, 10, known), rows);
  const orphan = { pid: 13, ppid: 1, created: "original-grandchild" };
  const later = [
    { pid: 10, ppid: 1, created: "reused-root" },
    { pid: 12, ppid: 10, created: "reused-child" },
    { pid: 14, ppid: 12, created: "unrelated-grandchild" },
    orphan,
  ];
  assert.deepEqual(descendants(later, 10, known), [orphan]);
  assert.equal(known.get(10), "original-root");
  assert.deepEqual(descendants([], 10, known), []);
  assert.throws(
    () => descendants([{ pid: 99, ppid: 1, created: null }], 99, new Map()),
    /Missing creation identity/,
  );
});

test("Windows cleanup uses taskkill for trees, preserves errors and refuses reused PIDs", async () => {
  const { terminateProcess } = await import("./builtin-installed-client.mjs");
  for (const outcome of ["success", "absent", "access-denied", "exit-race", "reused"]) {
    const errors = [],
      calls = [];
    const failure = new Error("taskkill localized failure");
    let reads = 0;
    await terminateProcess(-10, "SIGTERM", errors, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      known: new Map([[10, "original"]]),
      kill: () => assert.fail("Windows must not send POSIX signals"),
      table: async () => {
        reads++;
        if (outcome === "absent" || (outcome === "exit-race" && reads > 1)) return [];
        return [{ pid: 10, ppid: 1, created: outcome === "reused" ? "new" : "original" }];
      },
      run: async (file, args) => {
        calls.push([file, args]);
        if (["access-denied", "exit-race"].includes(outcome)) throw failure;
      },
    });
    assert.deepEqual(
      calls,
      ["absent", "reused"].includes(outcome)
        ? []
        : [["C:\\Windows\\System32\\taskkill.exe", ["/PID", "10", "/T", "/F"]]],
    );
    if (outcome === "access-denied") assert.deepEqual(errors, [failure]);
    else if (outcome === "reused") assert.match(errors[0].message, /reused PID/);
    else assert.deepEqual(errors, []);
  }
});

test("portable termination retains POSIX process group semantics", async () => {
  const { terminateProcess } = await import("./builtin-installed-client.mjs");
  const calls = [],
    errors = [];
  await terminateProcess(-10, "SIGKILL", errors, {
    platform: "linux",
    kill: (...args) => calls.push(args),
    run: () => assert.fail("no Windows command"),
  });
  assert.deepEqual(calls, [[-10, "SIGKILL"]]);
  assert.deepEqual(errors, []);
});

test("POSIX ancestry still accounts for children when the original parent already exited", () => {
  const known = new Map();
  const rows = [{ pid: 12, ppid: 10, pgid: 12 }];
  assert.deepEqual(descendants(rows, 10, known), rows);
  assert.ok(known.has(10));
  assert.deepEqual(descendants([{ pid: 13, ppid: 12, pgid: 13 }], 10, known), [
    { pid: 13, ppid: 12, pgid: 13 },
  ]);
});

test("Windows ancestry retains a late-sampled child of an already exited observed process", () => {
  const known = new Map([
    [10, "root"],
    [12, "child"],
  ]);
  const remaining = [{ pid: 13, ppid: 12, created: "grandchild" }];
  assert.deepEqual(descendants(remaining, 10, known), remaining);
  assert.equal(known.get(13), "grandchild");
});

test("secondary entry observer records original mutations and requires a terminal receipt", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { collectSecondaryObservation } = await import("./builtin-process-installed.mjs");
  for (const mutate of [false, true]) {
    const { stderr } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      `
      import { createRequire } from 'node:module';
      import { installSecondaryObservation } from ${JSON.stringify(new URL("./builtin-process-installed.mjs", import.meta.url).href)};
      const realRequire = createRequire(import.meta.url);
      const fs = realRequire('node:fs'), write = fs.writeSync;
      const electron = {app:{isReady:()=>false, requestSingleInstanceLock:()=>false}, utilityProcess:{fork:()=>({original:true})}};
      const require = name => name === 'electron' ? electron : realRequire(name);
      installSecondaryObservation(require, process, row => write(2, '\\nKOBRIXA_SECONDARY '+JSON.stringify(row)+'\\n'));
      if (electron.app.requestSingleInstanceLock() !== false) throw Error('Lock changed');
      if (${mutate}) {
        if (!electron.utilityProcess.fork('provider.cjs').original) throw Error('Fork changed');
        try { fs.writeFileSync('/nonexistent-w17-parent/profile', 'x'); } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    `,
    ]);
    const observed = collectSecondaryObservation(stderr);
    assert.deepEqual(observed.locks, [{ acquired: false }]);
    assert.deepEqual(observed.workers, []);
    assert.deepEqual(observed.children, []);
    assert.equal(observed.utilities.length, mutate ? 1 : 0);
    assert.equal(observed.writes.length > 0, mutate);
    assert.throws(() => collectSecondaryObservation(stderr.split("\n").slice(0, 2).join("\n")));
    assert.throws(() => collectSecondaryObservation(stderr + stderr));
  }
});

test("native process observer retains this process birth identity", async () => {
  const { processTable } = await import("./builtin-installed-client.mjs");
  const first = (await processTable()).find((row) => row.pid === process.pid);
  const second = (await processTable()).find((row) => row.pid === process.pid);
  assert.ok(first?.created);
  assert.equal(second?.created, first.created);
});

test("POSIX process identities are parsed with the C locale", async () => {
  const { processTable } = await import("./builtin-installed-client.mjs");
  const rows = await processTable({
    platform: "darwin",
    run: async (file, args, options) => {
      assert.equal(file, "/bin/ps");
      assert.deepEqual(args, ["-axo", "pid=,ppid=,pgid=,lstart="]);
      assert.equal(options.env.LC_ALL, "C");
      return { stdout: " 12 10 12 Thu Nov 12 10:00:00 2026\n" };
    },
  });
  assert.deepEqual(rows, [{ pid: 12, ppid: 10, pgid: 12, created: "Thu Nov 12 10:00:00 2026" }]);
  const known = new Map([[12, rows[0].created]]);
  assert.deepEqual(
    descendants(
      [
        { ...rows[0], created: "new" },
        { pid: 13, ppid: 12, pgid: 12, created: "foreign child" },
      ],
      12,
      known,
    ),
    [],
  );
});

test("secondary probe and creation identity are installed before entry resumes", async () => {
  const { observeSecondaryStartup } = await import("./builtin-process-installed.mjs");
  const order = [];
  let evaluation = 0;
  const client = {
    event: async () => ({ callFrames: [{ callFrameId: "entry" }] }),
    async send(method, params) {
      order.push(method);
      if (method === "Debugger.evaluateOnCallFrame") {
        assert.equal(params.callFrameId, "entry");
        // Parse the exact serialized native expression, including stderr newlines.
        new Function("require", "process", `return ${params.expression}`);
        return {
          result: {
            value:
              evaluation++ === 0
                ? { pid: 10, executable: "C:\\app\\kobrixa.exe", ready: false }
                : true,
          },
        };
      }
      return {};
    },
  };
  const known = new Map();
  await observeSecondaryStartup(client, 10, "C:\\app\\kobrixa.exe", known, async () => {
    order.push("identity");
    return [{ pid: 10, ppid: 1, created: "original" }];
  });
  assert.equal(evaluation, 2);
  assert.equal(known.get(10), "original");
  assert.ok(order.indexOf("identity") < order.indexOf("Debugger.resume"));
});

test("Windows persistence ownership retains orphan identities and refuses missing/reused births", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const loader = new URL("./persistence-source-loader.mjs", import.meta.url).href;
  await promisify(execFile)(process.execPath, [
    "--experimental-transform-types",
    "--import",
    loader,
    "--input-type=module",
    "-e",
    `
    import assert from 'node:assert/strict';
    import { createOwnedProcessTracker } from ${JSON.stringify(new URL("./plugin-persistence-run.mjs", import.meta.url).href)};
    const tracker = createOwnedProcessTracker(10);
    const root = {pid:10, ppid:1, pgid:0, start:'root'};
    const child = {pid:12, ppid:10, pgid:0, start:'child'};
    assert.deepEqual(tracker.observe([root,child]), [root,child]);
    const orphan = {...child,ppid:1};
    assert.deepEqual(tracker.observe([orphan]), [orphan]);
    const late = {pid:13,ppid:12,pgid:0,start:'late'};
    assert.deepEqual(tracker.observe([late]), [late]);
    assert.deepEqual(tracker.observe([{...root,start:'reused'}, {pid:14,ppid:10,pgid:0,start:'foreign'}]), []);
    assert.throws(() => createOwnedProcessTracker(10).observe([{...root,start:null}]), /Missing creation identity/);
  `,
  ]);
});
