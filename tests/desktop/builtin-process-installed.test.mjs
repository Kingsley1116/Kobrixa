import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { JOURNAL_PRODUCTION_EXPORTS } from "../../tools/release/journal-win32.mjs";
import { runInNewContext, runInThisContext } from "node:vm";
import { Session } from "node:inspector/promises";
import { format, inspect } from "node:util";
import { terminateProcess } from "./builtin-installed-client.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  devicePreferencesExpression,
  installProbe,
  closeRefusalBlocks,
  closeRefusalSite,
  observeCloseRefusal,
  waitForInstalledQuit,
  withCloseRefusal,
  observeInstalledWorkers,
  installedJournalExpression,
  assertWindowsJournalReady,
  installedLayout,
  installedEnvironment,
  installedPlatformPolicy,
  installedLaunchCommand,
  observeInstalledCase,
  installedFailureDiagnostics,
} from "./builtin-process-installed.mjs";
import { requireInstalledReceipt } from "./stage-3-closeout-run.mjs";

test("early product failure diagnostics retain the exit and final stderr without inventing a cause", () => {
  const receipt = {
    name: "healthy",
    exit: { code: null, signal: "SIGTRAP" },
    error: { message: "Product exited before evidence" },
    cleanupErrors: [{ message: "cleanup failed" }],
  };
  const output = "x".repeat(20_000) + "\nFATAL: actual stderr after exit\n";
  assert.deepEqual(installedFailureDiagnostics(receipt, output), {
    ...receipt,
    outputTail: output.slice(-16_384),
  });
  assert.equal(installedFailureDiagnostics(receipt, output).outputTail.length, 16_384);
  assert.match(
    installedFailureDiagnostics(receipt, output).outputTail,
    /FATAL: actual stderr after exit/,
  );
  assert.equal(installedFailureDiagnostics(receipt, "").outputTail, "");
});

test("first failure retains both close errors and full nested text outside the final output tail", () => {
  const storage = [
    "Device cleanup blocked. Error: Device or persistence disposition is incomplete.",
    "    at retire (main.cjs:1:2) {",
    "  storage: [",
    "    { blocker: true, errors: [",
    "      { code: 'PLUGIN_E_STORAGE_IO', message: 'fixture detail' }",
    "    ] }",
    "  ]",
    "}",
  ].join("\n");
  const header = "Error occurred in handler for 'workspace:finish-close': Error: close refused";
  const first = [
    header,
    "    at close (main.cjs:2:3) {",
    "",
    "  owner: { pluginId: 'fixture.plugin' }",
    "}",
  ].join("\n");
  const second = header + "\n    at Session.<anonymous> (node:electron/js2c/browser_init:1:2)";
  const other = "Error occurred in handler for 'workspace:open': Error: unrelated";
  const log = [other, storage, first, "[42:ERROR] network", second, other, "x".repeat(20000)]
    .join("\n")
    .replaceAll("\n", "\r\n");
  assert.deepEqual(closeRefusalBlocks(log), [storage, first, second]);
  assert.deepEqual(closeRefusalBlocks(other), []);
  const deadline = new Error("Deadline: graceful application quit");
  const failure = withCloseRefusal(deadline, log);
  assert.equal(failure.cause, deadline);
  assert.equal(failure.message, [deadline.message, storage, first, second].join("\n"));
  assert.equal(withCloseRefusal(deadline, other), deadline);
});

test("refusal logpoint reads original owner reports only when close actually refuses", async () => {
  const source =
    "(async function XF(e,t){if((await e.close(t)).blocker)throw Error(`Device stop, journal, saved data or process exit is not confirmed.`)})";
  const file = "/installed-unit/app.asar/.vite/build/main.cjs";
  const gate = runInThisContext(source, { filename: file });
  const session = new Session();
  session.connect();
  const pauses = [];
  session.on("Debugger.paused", (event) => pauses.push(event.params.reason));
  const probe = (globalThis.__installedProbe = {});
  try {
    assert.equal(closeRefusalSite(source + source), null);
    assert.equal(closeRefusalSite(source.replace(".blocker", ".saved")), null);
    await observeCloseRefusal(
      { send: (method, params) => session.post(method, params) },
      closeRefusalSite(source),
    );
    const owners = [
      {
        owner: { pluginId: "fixture.owner" },
        storage: { blocker: true, errors: [{ message: "fixture storage error" }] },
      },
    ];
    let requests = 0,
      reads = 0;
    const coordinator = {
      close: async () => ({ blocker: ++requests === 2 }),
      lifecycle: {
        reports: () => {
          reads++;
          return structuredClone(owners);
        },
      },
    };
    await gate(coordinator, "shutdown");
    assert.equal(probe.closeRefusal, undefined);
    await assert.rejects(
      gate(coordinator, "shutdown"),
      /Device stop, journal, saved data or process exit is not confirmed/,
    );
    assert.deepEqual(probe.closeRefusal.owners, owners);
    assert.ok(Number.isSafeInteger(probe.closeRefusal.at));
    assert.equal(reads, 1);
    assert.equal(requests, 2);
    assert.deepEqual(pauses, []);
  } finally {
    session.disconnect();
    delete globalThis.__installedProbe;
  }
});

test("quit deadline persists the still-attached snapshot before timestamped group and PID cleanup", async (t) => {
  const stderr = new EventEmitter(),
    app = new EventEmitter();
  const cleanup = { signals: [] };
  const refusal = {
    at: 102,
    owners: [{ owner: { pluginId: "fixture.owner" }, storage: { blocker: true } }],
  };
  let now = 100,
    log = "",
    saved,
    quits = 0;
  t.mock.method(Date, "now", () => now);
  const write = (value) => {
    log += value;
    stderr.emit("data", value);
  };
  const probe = {
    electron: { app },
    records: [],
    require: () => assert.fail("refused quit must stay attached"),
  };
  app.quit = () => {
    quits++;
    probe.closeRefusal = refusal;
    write("Error occurred in handler for 'workspace:finish-close': Error: fixture refusal\n");
  };
  const context = {
    __installedProbe: probe,
    Date,
    process: { stderr: { write } },
    setTimeout(fn) {
      now = 101;
      fn();
    },
  };
  const main = {
    js: (expression) => runInNewContext(expression, context),
    close: () => assert.fail("early detach"),
  };
  await assert.rejects(
    waitForInstalledQuit({
      main,
      stderr,
      cleanup,
      output: () => log,
      ended: () => false,
      persist: () => {
        saved = JSON.parse(JSON.stringify(cleanup));
      },
      wait: async (ended, label, budget, diagnostics) => {
        assert.equal(label, "graceful application quit");
        assert.equal(budget, 12000);
        assert.equal(ended(), false);
        now = 12101;
        await diagnostics();
        throw new Error("Deadline: " + label);
      },
    }),
    /Deadline: graceful application quit/,
  );
  assert.equal(quits, 1);
  assert.equal(stderr.listenerCount("data"), 0);
  assert.deepEqual(saved, {
    signals: [],
    quitRequestSentAt: 100,
    quitRequestedAt: 101,
    deadlineAt: 12101,
    snapshot: {
      outputTail: log,
      refusalBlocks: [
        "Error occurred in handler for 'workspace:finish-close': Error: fixture refusal",
      ],
      main: { quitRequestedAt: 101, refusal, forks: [] },
    },
  });
  const errors = [];
  const kill = (pid) => {
    assert.equal(cleanup.signals.at(-1).at, now);
    if (pid === 8) throw Object.assign(new Error("already exited"), { code: "ESRCH" });
    write("output from forced cleanup\n");
  };
  for (const [pid, signal] of [
    [-7, "SIGTERM"],
    [-7, "SIGKILL"],
    [8, "SIGKILL"],
  ]) {
    now++;
    await terminateProcess(pid, signal, errors, {
      platform: "linux",
      attempts: cleanup.signals,
      kill,
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(cleanup.signals, [
    { at: 12102, pid: -7, signal: "SIGTERM", sent: true },
    { at: 12103, pid: -7, signal: "SIGKILL", sent: true },
    { at: 12104, pid: 8, signal: "SIGKILL", sent: false, error: "ESRCH" },
  ]);
  assert.equal(saved.signals.length, 0);
  assert.equal(cleanup.snapshot.outputTail, saved.snapshot.outputTail);
  assert.match(withCloseRefusal(new Error("Deadline"), log, refusal).message, /fixture\.owner/);
  assert.equal(installedFailureDiagnostics({ closeCleanup: cleanup }, log).closeCleanup, cleanup);
});

test("terminal quit before the inspector reply detaches after acknowledgment and still needs OS exit", async () => {
  const stderr = new EventEmitter();
  let log = "",
    ended = false,
    detached = 0;
  await waitForInstalledQuit({
    main: {
      js() {
        log += "\nKOBRIXA_INSTALLED_QUIT";
        stderr.emit("data");
        log += "TING\n";
        stderr.emit("data");
        assert.equal(detached, 0);
        return true;
      },
      close: () => detached++,
    },
    stderr,
    output: () => log,
    ended: () => ended,
    cleanup: {},
    persist: () => assert.fail("no deadline"),
    wait: (read) => {
      assert.equal(detached, 1);
      assert.equal(read(), false);
      ended = true;
      assert.equal(read(), true);
    },
  });
  assert.equal(stderr.listenerCount("data"), 0);
});

test("unavailable inspector still retains the deadline and pre-signal output", async () => {
  const cleanup = { signals: [] };
  let calls = 0;
  const log = "Device cleanup blocked. Error: original\n    at close (main.cjs:1:2)";
  await assert.rejects(
    waitForInstalledQuit({
      main: {
        js() {
          if (calls++) throw new Error("inspector disconnected");
        },
      },
      stderr: new EventEmitter(),
      ended: () => false,
      output: () => log,
      cleanup,
      wait: async (_read, label, _budget, diagnostics) => {
        await diagnostics();
        throw new Error("Deadline: " + label);
      },
      persist() {
        throw new Error("write failed");
      },
    }),
    /Deadline: graceful application quit/,
  );
  assert.equal(cleanup.snapshot.outputTail, log);
  assert.deepEqual(cleanup.snapshot.refusalBlocks, [log]);
  assert.equal(cleanup.snapshot.inspectorError.message, "inspector disconnected");
  assert.equal(cleanup.snapshotWriteError.message, "write failed");
  assert.equal(cleanup.snapshot.main, undefined);
});

test("installed platform layouts select the actual packaged executable and resources", () => {
  assert.deepEqual(installedLayout("win32", ["kobrixa.exe", "resources"]), {
    appName: null,
    executableRelative: "kobrixa.exe",
    resourceRelative: "resources",
  });
  assert.deepEqual(installedLayout("darwin", ["kobrixa.app"]), {
    appName: "kobrixa.app",
    executableRelative: "kobrixa.app/Contents/MacOS/kobrixa",
    resourceRelative: "kobrixa.app/Contents/Resources",
  });
  assert.equal(installedLayout("linux", ["kobrixa"]).executableRelative, "kobrixa");
  assert.throws(() => installedLayout("darwin", []), /exactly one/);
  assert.throws(() => installedLayout("darwin", ["one.app", "two.app"]), /exactly one/);
});

test("Windows PATH casing cannot leak a development Node or environment overrides", () => {
  const original = {
    Path: "C:\\development\\node",
    PATH: "C:\\other",
    Node_Options: "--require=dev",
    node_path: "dev",
    Electron_Run_As_Node: "1",
    PythonPath: "dev",
    SystemRoot: "C:\\Windows",
  };
  assert.deepEqual(installedEnvironment(original, "C:\\empty path"), {
    SystemRoot: "C:\\Windows",
    PATH: "C:\\empty path",
  });
  assert.equal(original.Path, "C:\\development\\node");
});

test("Windows launches the exe directly with unchanged inspector/profile arguments", () => {
  const config = { executable: "C:\\installed app\\kobrixa.exe", isolated: false };
  const args = [
    "--inspect-brk=127.0.0.1:0",
    "--remote-debugging-port=0",
    "--user-data-dir=C:\\profile space",
  ];
  assert.deepEqual(installedLaunchCommand(config, args, "win32"), {
    file: config.executable,
    args,
  });
  const secondary = ["--user-data-dir=C:\\profile space", "--b2-secondary=marker"];
  assert.deepEqual(installedLaunchCommand(config, secondary, "win32"), {
    file: config.executable,
    args: secondary,
  });
  assert.throws(
    () => installedLaunchCommand({ ...config, isolated: true }, args, "win32"),
    /isolation adapter/,
  );
  assert.equal(
    installedLaunchCommand(
      { ...config, isolated: true, isolationProfile: "policy" },
      args,
      "darwin",
    ).file,
    "/usr/bin/sandbox-exec",
  );
  assert.equal(
    installedLaunchCommand({ ...config, isolated: true, deniedRoots: ["/source"] }, args, "linux")
      .file,
    "/usr/bin/python3",
  );
});

test("Windows prerequisite blocks cannot become isolated acceptance", async () => {
  const policy = installedPlatformPolicy("win32", true);
  assert.equal(policy.isolated, false);
  assert.equal(policy.blockers.length, 1);
  assert.equal(policy.blockers[0].id, "W17-isolation");
  assert.equal(installedPlatformPolicy("win32", false).blockers.length, 0);
  assert.deepEqual(installedPlatformPolicy("darwin", true), { isolated: true, blockers: [] });
  assert.deepEqual(installedPlatformPolicy("linux", true), { isolated: true, blockers: [] });
  const directory = await mkdtemp(path.join(tmpdir(), "installed-blocked-unit-"));
  try {
    const file = path.join(directory, "unit.json");
    await writeFile(file, JSON.stringify({ ...policy, status: "blocked" }));
    await assert.rejects(
      requireInstalledReceipt(`Real installed product receipt: ${file}`, false),
      /cannot pass full acceptance/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent Windows observations continue after failures without changing their results", async () => {
  const failures = [],
    seen = [];
  const original = new Error("actual failed assertion");
  for (const name of ["healthy", "restart", "missing", "tampered"]) {
    await observeInstalledCase(
      async () => {
        seen.push(name);
        if (name === "healthy") throw original;
      },
      "win32",
      failures,
    );
  }
  assert.deepEqual(seen, ["healthy", "restart", "missing", "tampered"]);
  assert.deepEqual(failures, [original]);
  await assert.rejects(
    observeInstalledCase(
      () => {
        throw original;
      },
      "darwin",
      failures,
    ),
    (error) => error === original,
  );
});

test("Windows secondary resumes only after its paused entry and OS creation identity agree", async () => {
  const { observeSecondaryStartup } = await import("./builtin-process-installed.mjs");
  for (const outcome of [
    "success",
    "missing",
    "wrong-os-pid",
    "missing-creation",
    "wrong-entry-pid",
    "wrong-executable",
    "already-ready",
    "observer-failed",
  ]) {
    const calls = [],
      known = new Map();
    let paused;
    let evaluations = 0;
    const client = {
      event: () =>
        new Promise((resolve) => {
          paused = resolve;
        }),
      send: async (method, params) => {
        calls.push(method);
        if (method === "Runtime.runIfWaitingForDebugger")
          paused({ callFrames: [{ callFrameId: "entry" }] });
        if (method === "Debugger.evaluateOnCallFrame") {
          assert.equal(params.callFrameId, "entry");
          evaluations++;
          if (evaluations === 2) {
            assert.match(params.expression, /installSecondaryObservation/);
            calls.push("observer installation");
            return { result: { value: outcome !== "observer-failed" } };
          }
          assert.equal(evaluations, 1);
          return {
            result: {
              value: {
                pid: outcome === "wrong-entry-pid" ? 11 : 10,
                executable:
                  outcome === "wrong-executable" ? "C:\\wrong.exe" : "C:\\app\\kobrixa.exe",
                ready: outcome === "already-ready",
              },
            },
          };
        }
        if (method === "Debugger.resume") {
          assert.equal(known.get(10), "observed-creation");
          assert.equal(evaluations, 2);
        }
      },
    };
    const work = observeSecondaryStartup(client, 10, "C:\\app\\kobrixa.exe", known, async () => {
      calls.push("OS creation identity");
      return outcome === "missing"
        ? []
        : [
            {
              pid: outcome === "wrong-os-pid" ? 11 : 10,
              ppid: 1,
              created: outcome === "missing-creation" ? "" : "observed-creation",
            },
          ];
    });
    if (outcome === "success") {
      assert.deepEqual(await work, {
        pid: 10,
        executable: "C:\\app\\kobrixa.exe",
        ready: false,
      });
      assert.equal(evaluations, 2);
      assert.ok(calls.indexOf("observer installation") < calls.indexOf("OS creation identity"));
      assert.equal(known.get(10), "observed-creation");
      assert.ok(calls.indexOf("OS creation identity") < calls.indexOf("Debugger.resume"));
    } else {
      await assert.rejects(work);
      assert.equal(calls.includes("Debugger.resume"), false);
    }
  }
});

test("Windows installed journal requires native receipts and every healthy public recovery page", () => {
  const native = { capabilities: { supported: true }, barrier: { supported: true, flushed: true } };
  const page = {
    ok: true,
    value: { hostEpoch: "epoch", revision: 1, items: [], nextCursor: null },
  };
  assertWindowsJournalReady([page], native);
  for (const pages of [
    undefined,
    [],
    [{ ok: false }],
    [{ ...page, value: { ...page.value, nextCursor: "more" } }],
  ])
    assert.throws(() => assertWindowsJournalReady(pages, native));
  for (const bad of [undefined, {}, { ...native, barrier: { supported: true, flushed: false } }])
    assert.throws(() => assertWindowsJournalReady([page], bad));
  const failure = { sourceKey: "builtin:kobrixa.core", kind: "device", state: "save-failed" };
  assert.throws(
    () =>
      assertWindowsJournalReady(
        [
          { ...page, value: { ...page.value, nextCursor: "page-2" } },
          { ...page, value: { ...page.value, items: [failure] } },
        ],
        native,
      ),
    /production journal unavailable/,
  );
});

const deviceEntry = {
  sourceKey: "builtin:kobrixa.device-ev3",
  pluginId: "kobrixa.device-ev3",
  availability: "available",
};
const catalogPage = (entries, nextCursor = null) => ({
  ok: true,
  value: { entries, nextCursor },
});
const admittedDeviceCatalog = () => ({ catalog: async () => catalogPage([deviceEntry]) });

test("settings waits for public device catalog admission before opening, including later pages", async () => {
  let admitted = false,
    opens = 0;
  const cursors = [];
  const plugins = {
    ui: {
      async catalog(input) {
        cursors.push(input.cursor);
        if (!admitted) return catalogPage([{ ...deviceEntry, sourceKey: "builtin:other" }]);
        return input.cursor ? catalogPage([deviceEntry]) : catalogPage([], "page-2");
      },
    },
    settings: {
      async open() {
        opens++;
        return {
          binding: {},
          snapshot: { revision: "committed", values: [{ key: "usbAutoReconnect", value: false }] },
        };
      },
      dispose() {},
    },
  };
  const read = () =>
    runInNewContext(devicePreferencesExpression("a".repeat(64)), {
      window: { kobrixa: { plugins } },
    });
  assert.equal(await read(), null);
  assert.equal(opens, 0, "Absent catalog admission must not probe settings.open");
  admitted = true;
  assert.equal((await read()).usbAutoReconnect, false);
  assert.equal(opens, 1);
  assert.deepEqual(cursors, [undefined, undefined, "page-2"]);
});

test("catalog failure, unavailable device and broken pagination fail before settings.open", async () => {
  for (const catalog of [
    async () => ({ ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } }),
    async () => catalogPage([{ ...deviceEntry, availability: "unavailable" }]),
    async () => catalogPage([], "repeated"),
    async () => ({ ok: true, value: { entries: [], nextCursor: undefined } }),
    (() => {
      let page = 0;
      return async () => catalogPage([], `page-${++page}`);
    })(),
  ]) {
    let opens = 0;
    await assert.rejects(
      runInNewContext(devicePreferencesExpression("a".repeat(64)), {
        window: {
          kobrixa: {
            plugins: {
              ui: { catalog },
              settings: {
                open() {
                  opens++;
                  throw new Error("must not open");
                },
              },
            },
          },
        },
      }),
    );
    assert.equal(opens, 0);
  }
});

test("worker failure diagnostics are bounded and preserve original message delivery", () => {
  class Worker extends EventEmitter {
    threadId = 1;
  }
  const threads = { Worker },
    emitted = [];
  const probe = observeInstalledWorkers(
    threads,
    (row) => emitted.push(row),
    () => ({}),
  );
  const child = new threads.Worker();
  let received;
  child.on("message", (message) => {
    received = message;
  });
  for (let id = 1; id <= 40; id++) {
    const message = { version: 1, id, ok: false, error: { code: "io", message: "permission" } };
    assert.equal(child.emit("message", message), true);
    assert.equal(received, message);
  }
  assert.equal(emitted.filter((row) => row.event === "request-error").length, 32);
  assert.equal(emitted.filter((row) => row.event === "request-errors-truncated").length, 1);
  assert.deepEqual(emitted.find((row) => row.event === "request-error").message.error, {
    code: "io",
    message: "permission",
  });
  const count = emitted.length;
  child.emit("message", { version: 1, id: 41, ok: true, value: "private settings" });
  assert.equal(emitted.length, count, "Successful payloads are not logged");
  child.emit("exit", 0);
  assert.equal(Object.hasOwn(child, "emit"), false);
  assert.equal(probe.restore(), true);
});

test("public settings observation retains false, uses packaged digest and disposes the binding", async () => {
  const binding = { owner: "unit" };
  let disposed;
  const settings = {
    async open(input) {
      assert.equal(input.sourceKey, "builtin:kobrixa.device-ev3");
      assert.equal(input.resourceDigest, "a".repeat(64));
      return {
        binding,
        snapshot: { revision: "committed", values: [{ key: "usbAutoReconnect", value: false }] },
      };
    },
    dispose(value) {
      disposed = value;
    },
  };
  const result = await runInNewContext(devicePreferencesExpression("a".repeat(64)), {
    window: { kobrixa: { plugins: { settings, ui: admittedDeviceCatalog() } } },
  });
  assert.equal(result.usbAutoReconnect, false);
  assert.equal(disposed, binding);
});

test("public settings observation retries only the public disabled code and serializes failures", async () => {
  const disabled = { code: "PLUGIN_E_DISABLED", message: "Settings migration is not ready." };
  const conflict = {
    code: "PLUGIN_E_SETTINGS_CONFLICT",
    message: "revision mismatch",
    detail: { reason: "digest" },
  };
  for (const [error, pending] of [
    [disabled, true],
    [{ ok: false, error: disabled }, true],
    [
      new Error(
        `Error invoking remote method 'plugins:settings:open': Error: ${JSON.stringify(disabled)}`,
      ),
      true,
    ],
    [conflict, false],
    [{ ok: false, error: conflict }, false],
    [new Error(JSON.stringify(conflict)), false],
    [new Error("Settings source is not admitted."), false],
    [new Error("[object Object]"), false],
    [{ code: "PLUGIN_E_SETTINGS_SAVE", message: "Settings migration is not ready." }, false],
    [
      {
        code: "PLUGIN_E_SETTINGS_SAVE",
        message: "Settings request could not be completed.",
        detail: { kind: "persistence", reason: "io" },
      },
      false,
    ],
    ["disk failure", false],
  ]) {
    const read = () =>
      runInNewContext(devicePreferencesExpression("a".repeat(64)), {
        window: {
          kobrixa: {
            plugins: {
              ui: admittedDeviceCatalog(),
              settings: {
                async open() {
                  throw error;
                },
              },
            },
          },
        },
      });
    if (pending) assert.equal(await read(), null);
    else
      await assert.rejects(read, (failure) => {
        assert.match(failure.message, /Device settings open rejected:/);
        const serialized = JSON.parse(
          failure.message.slice("Device settings open rejected: ".length),
        );
        if (error instanceof Error) {
          assert.equal(serialized.message, error.message);
          assert.equal(serialized.stack, error.stack);
        } else assert.deepEqual(serialized, error);
        return true;
      });
  }
});

test("settings open IPC preserves structured rejections across Electron's message-only boundary", async (t) => {
  const { build } = await import("esbuild");
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-settings-ipc-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "ipc.cjs");
  await build({
    entryPoints: ["apps/desktop/src/main/plugins/ipc.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const { registerSettingsIpc170 } = createRequire(import.meta.url)(outfile);
  for (const rejection of [
    { code: "PLUGIN_E_DISABLED", message: "Settings migration is not ready." },
    { ok: false, error: { code: "PLUGIN_E_SETTINGS_SCHEMA", message: "invalid-resource" } },
    { code: "PLUGIN_E_SETTINGS_SAVE", message: "io", reason: "journal-unwritable" },
  ]) {
    const handlers = new Map();
    registerSettingsIpc170({
      handle: (name, fn) => handlers.set(name, fn),
      service: {
        async open() {
          throw rejection;
        },
      },
      scope: () => ({ hostEpoch: "host", workbenchInstance: "window" }),
      publish() {},
    });
    await assert.rejects(
      handlers.get("plugins:settings:open")(
        {},
        {
          sourceKey: "builtin:kobrixa.device-ev3",
          resourceDigest: "a".repeat(64),
        },
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.deepEqual(JSON.parse(error.message), rejection);
        return true;
      },
    );
  }
});

test("public settings waits for publication, not for the expected preference value", async () => {
  let disposed = 0;
  const snapshots = [
    { revision: null, value: true },
    { revision: null, value: false },
    { revision: "imported", value: false },
    { revision: "wrong-import", value: true },
  ];
  for (const { revision, value } of snapshots) {
    const result = await runInNewContext(devicePreferencesExpression("a".repeat(64)), {
      window: {
        kobrixa: {
          plugins: {
            ui: admittedDeviceCatalog(),
            settings: {
              async open() {
                return {
                  binding: revision,
                  snapshot: {
                    revision,
                    values: [{ key: "usbAutoReconnect", value }],
                  },
                };
              },
              dispose(binding) {
                assert.equal(binding, revision);
                disposed++;
              },
            },
          },
        },
      },
    });
    if (revision === null) assert.equal(result, null);
    else if (value === false) assert.equal(result.usbAutoReconnect, false);
    else {
      assert.notEqual(result, null, "A committed wrong value must not be retried");
      assert.throws(() => assert.equal(result.usbAutoReconnect, false));
    }
  }
  assert.equal(disposed, snapshots.length);
});

test("malformed settings revisions fail instead of silently retrying or accepting defaults", async () => {
  for (const revision of [undefined, "", 0]) {
    let disposed = false;
    await assert.rejects(
      runInNewContext(devicePreferencesExpression("a".repeat(64)), {
        window: {
          kobrixa: {
            plugins: {
              ui: admittedDeviceCatalog(),
              settings: {
                async open() {
                  return { binding: {}, snapshot: { revision, values: [] } };
                },
                dispose() {
                  disposed = true;
                },
              },
            },
          },
        },
      }),
      /Invalid device settings revision/,
    );
    assert.equal(disposed, true);
  }
});

test("installed Windows exact-export check uses the release production set", () => {
  const require = createRequire(import.meta.url);
  assert.ok(JOURNAL_PRODUCTION_EXPORTS.includes("initializeDirectory"));
  for (const defect of [null, "missing-initialize", "test-export"]) {
    const addon = Object.fromEntries(JOURNAL_PRODUCTION_EXPORTS.map((key) => [key, "metadata"]));
    addon.capabilities = () => ({ supported: true });
    addon.syncDirectory = () => ({ supported: true, flushed: true });
    if (defect === "missing-initialize") delete addon.initializeDirectory;
    if (defect === "test-export") addon.inspect = () => {};
    const run = () =>
      runInNewContext(installedJournalExpression(), {
        process: { resourcesPath: "/packaged" },
        __installedProbe: {
          require(name) {
            if (name.endsWith("journal_win32.node")) return addon;
            if (name === "node:fs") return { readFileSync: () => Buffer.from("unit addon") };
            return require(name);
          },
          electron: { app: { getPath: () => "/profile" } },
        },
      });
    if (defect) assert.throws(run);
    else assert.equal(run().barrier.flushed, true);
  }
});

test("both installed CI paths use the shared scoped AppArmor lifecycle", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  for (const file of ["ci.yml", "stage-3-acceptance.yml"]) {
    const workflow = parse(
      await readFile(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"),
    );
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const load = steps.find(
      (step) => step.name === "Allow installed Chromium user namespaces on AppArmor hosts",
    );
    const unload = steps.find(
      (step) =>
        step.name === "Retain installed Linux kernel denials and remove test AppArmor profile",
    );
    assert.equal(load.uses, "./.github/actions/installed-apparmor");
    assert.equal(load.with.operation, "load");
    assert.match(load.if, /runner.os == 'Linux'/);
    assert.equal(unload.uses, load.uses);
    assert.equal(unload.with.operation, "unload");
    assert.match(unload.if, /always\(\)/);
    assert.ok(steps.indexOf(load) < steps.indexOf(unload));
  }
  const action = parse(
    await readFile(
      new URL("../../.github/actions/installed-apparmor/action.yml", import.meta.url),
      "utf8",
    ),
  );
  const script = action.runs.steps[0].run;
  assert.match(script, /apparmor_restrict_unprivileged_userns/);
  assert.match(script, /require\("node:os"\).tmpdir\(\)/);
  assert.match(script, /--apparmor-profile "\$installed_temp"/);
  assert.match(script, /apparmor_parser -r/);
  assert.match(script, /apparmor_parser -R/);
  assert.doesNotMatch(script, /--no-sandbox|--disable-setuid-sandbox|sysctl -w/);
});

test("installed release logpoint captures the original host reply without pausing or reissuing it", async () => {
  const { Session } = await import("node:inspector/promises");
  const { runInThisContext } = await import("node:vm");
  const { releaseSite, observeRelease } = await import("./ev3-uhid-observe.mjs");
  const source =
    "(async function(e,t,i,r){let a=await e.request(i,`devices/recording/release`,{reservationId:t.data},r);return e.current()?a.ok:false})";
  const session = new Session();
  session.connect();
  globalThis.__installedProbe = { releases: [] };
  const pauses = [];
  session.on("Debugger.paused", (event) => pauses.push(event.params.reason));
  const client = {
    send: (name, params) => session.post(name, params),
    on(name, listener) {
      const forward = (event) => listener(event.params);
      session.on(name, forward);
      return () => session.off(name, forward);
    },
  };
  let remove;
  try {
    const fn = runInThisContext(source, { filename: "/p4-test-release/.vite/build/main.cjs" });
    remove = await observeRelease(client, "/p4-test-release", source);
    let calls = 0;
    const result = { ok: true, value: { reservation: { reason: "released" } } };
    assert.equal(
      await fn(
        {
          request: async () => {
            calls++;
            return result;
          },
          current: () => true,
        },
        { data: "original" },
        { owner: { processEpoch: "epoch" } },
        null,
      ),
      true,
    );
    assert.deepEqual(pauses, []);
    assert.equal(calls, 1);
    assert.equal(globalThis.__installedProbe.releases.length, 1);
    const [observed] = globalThis.__installedProbe.releases;
    assert.deepEqual(observed.result, result);
    assert.equal(observed.reservationId, "original");
    assert.equal(observed.owner.processEpoch, "epoch");
    assert.throws(() => releaseSite(source.replace("e.current()", "e.other()")));
  } finally {
    try {
      await remove?.();
    } finally {
      session.disconnect();
    }
    delete globalThis.__installedProbe;
  }
});

test("Lab port observer preserves original handoff, payloads and owner", async () => {
  const { EventEmitter } = await import("node:events");
  const { observeLabFork } = await import("./ev3-uhid-observe.mjs");
  let duringSend;
  class Port extends EventEmitter {
    start() {
      return this;
    }
    postMessage(text) {
      if (text === "fail") throw new Error("send failed");
      duringSend = Number(process.hrtime.bigint()) / 1e6;
      return text;
    }
  }
  const incoming = new Port(),
    outgoing = new Port(),
    rows = [];
  const owner = { processEpoch: "only-this-child" };
  const child = {
    pid: 123,
    postMessage: (message, ports) => {
      assert.deepEqual(ports, [outgoing]);
      return message.type;
    },
  };
  const start = Port.prototype.start;
  const restore = observeLabFork(child, JSON.stringify(owner), rows);
  assert.equal(
    child.postMessage({ type: "kobrixa-plugin-port" }, [outgoing]),
    "kobrixa-plugin-port",
  );
  assert.equal(incoming.start(), incoming);
  assert.equal(Port.prototype.start, start);
  assert.equal(incoming.postMessage('{"id":1}'), '{"id":1}');
  assert.ok(rows[0].sendStartedAt <= duringSend && duringSend <= rows[0].at);
  assert.throws(() => incoming.postMessage("fail"), /send failed/);
  incoming.emit("message", { data: '{"result":42}' });
  assert.deepEqual(
    rows.map((r) => [r.owner, r.utility, r.direction, r.message]),
    [
      [owner, 123, "host-plugin", { id: 1 }],
      [owner, 123, "plugin-host", { result: 42 }],
    ],
  );
  restore();
  assert.equal(incoming.postMessage, Port.prototype.postMessage);
  assert.equal(incoming.listenerCount("message"), 0);
  assert.equal(incoming.listenerCount("close"), 0);
});

test("publication wrapper restores a live worker before graceful exit", () => {
  class Worker extends EventEmitter {
    postMessage() {}
  }
  const threads = { Worker };
  const rows = [];
  const probe = observeInstalledWorkers(
    threads,
    (row) => rows.push(row),
    () => ({}),
    true,
  );
  const child = new threads.Worker("persistence-worker");
  assert.notEqual(child.postMessage, Worker.prototype.postMessage);
  assert.equal(probe.restore(), true);
  assert.equal(child.postMessage, Worker.prototype.postMessage);
  assert.equal(child.emit, Worker.prototype.emit);
  assert.deepEqual(child.eventNames(), []);
  const beforeExit = rows.length;
  assert.equal(child.emit("exit", 0), false);
  assert.equal(rows.length, beforeExit);
});

test("relocated release logpoint is removed and debugger disabled", async () => {
  const { observeRelease } = await import("./ev3-uhid-observe.mjs");
  const source =
    "async function f(e,t,i,r){let a=await e.request(i,`devices/recording/release`,{reservationId:t.data},r);return e.current()?a.ok:false}";
  const calls = [];
  const listeners = new Map();
  const client = {
    on(name, fn) {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
    async send(name, params) {
      calls.push(name);
      if (name === "Debugger.enable")
        listeners.get("Debugger.scriptParsed")({
          url: "/test/.vite/build/main.cjs",
          scriptId: "1",
        });
      if (name === "Debugger.getScriptSource") return { scriptSource: source };
      if (name === "Debugger.setBreakpoint")
        return {
          breakpointId: "original",
          actualLocation: { ...params.location, lineNumber: 999 },
        };
      if (name === "Debugger.removeBreakpoint") assert.equal(params.breakpointId, "original");
    },
  };
  await assert.rejects(observeRelease(client, "/test", source), /999/);
  assert.deepEqual(calls.slice(-2), ["Debugger.removeBreakpoint", "Debugger.disable"]);
  assert.equal(listeners.size, 0);
});

test("serialized main probe acknowledges restoration after observing worker shutdown", (t) => {
  class Worker extends EventEmitter {
    postMessage() {}
  }
  const threads = { Worker };
  const fork = () => new EventEmitter();
  const electron = {
    app: Object.assign(new EventEmitter(), { isReady: () => false }),
    utilityProcess: { fork },
  };
  const main = Object.assign(new EventEmitter(), { execArgv: [], stderr: { write: () => {} } });
  const writes = [];
  const defaults = inspect.defaultOptions;
  const originalOptions = { ...defaults };
  t.after(() => Object.assign(defaults, originalOptions));
  const modules = {
    "node:util": { inspect },
    electron,
    "node:worker_threads": threads,
    "node:fs": { writeSync: (fd, text) => writes.push([fd, text]) },
  };
  const context = {
    require: (key) => modules[key],
    process: main,
    URL,
    performance,
    __recordingCapture: true,
  };
  assert.equal(runInNewContext(installProbe, context), true);
  assert.deepEqual(
    { ...defaults },
    {
      ...originalOptions,
      depth: 12,
      maxArrayLength: 200,
      maxStringLength: 4000,
    },
  );
  const nested = Object.assign(new Error("fixture"), {
    storage: [{ blocker: true, errors: [{ detail: { owner: "fixture.owner" } }] }],
  });
  assert.match(format("Device cleanup blocked.", nested), /fixture\.owner/);
  const probe = context.__installedProbe;
  assert.equal(probe.observeExit(), true);
  const worker = new threads.Worker("persistence-worker");
  worker.emit("exit", 0);
  electron.app.emit("before-quit");
  electron.app.emit("will-quit");
  assert.deepEqual(writes, []);
  electron.app.emit("quit");
  main.emit("exit", 0);
  assert.deepEqual({ ...defaults }, originalOptions);
  assert.deepEqual(writes, [
    [2, "\nKOBRIXA_INSTALLED_QUITTING\n"],
    [2, "\nKOBRIXA_INSTALLED_RESTORED\n"],
  ]);
  assert.equal(electron.app.listenerCount("quit"), 0);
  assert.equal(probe.workers.timeline.at(-1).event, "exit");
  assert.equal(main.listenerCount("exit"), 0);
  assert.equal(threads.Worker, Worker);
  assert.equal(electron.utilityProcess.fork, fork);
  assert.equal(worker.postMessage, Worker.prototype.postMessage);
});
