import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
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
