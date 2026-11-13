import { createRequire } from "node:module";
import { JOURNAL_PRODUCTION_EXPORTS } from "../../tools/release/journal-win32.mjs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  devicePreferencesExpression,
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
    window: { kobrixa: { plugins: { settings } } },
  });
  assert.equal(result.usbAutoReconnect, false);
  assert.equal(disposed, binding);
});

test("public settings observation retries only admission and propagates other failures", async () => {
  for (const message of [
    "Settings source is not admitted.",
    "Stale settings binding.",
    "disk failure",
  ]) {
    const read = () =>
      runInNewContext(devicePreferencesExpression("a".repeat(64)), {
        window: {
          kobrixa: {
            plugins: {
              settings: {
                async open() {
                  throw new Error(message);
                },
              },
            },
          },
        },
      });
    if (message === "Settings source is not admitted.") assert.equal(await read(), null);
    else await assert.rejects(read, { message });
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
