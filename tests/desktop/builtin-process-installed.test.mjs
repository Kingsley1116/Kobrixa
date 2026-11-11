import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  installedLayout,
  installedEnvironment,
  installedPlatformPolicy,
  installedLaunchCommand,
  observeInstalledCase,
} from "./builtin-process-installed.mjs";
import { requireInstalledReceipt } from "./stage-3-closeout-run.mjs";

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
  assert.equal(policy.blockers[0].status, "blocked-by-W02b");
  assert.deepEqual(policy.blockers[0].checks, ["motion admission", "Run admission"]);
  assert.equal(policy.blockers[1].id, "W17-isolation");
  assert.equal(installedPlatformPolicy("win32", false).blockers.length, 1);
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
  for (const outcome of ["success", "missing", "wrong-executable", "already-ready"]) {
    const calls = [],
      known = new Map();
    let paused;
    const client = {
      event: () =>
        new Promise((resolve) => {
          paused = resolve;
        }),
      send: async (method) => {
        calls.push(method);
        if (method === "Runtime.runIfWaitingForDebugger")
          paused({ callFrames: [{ callFrameId: "entry" }] });
        if (method === "Debugger.evaluateOnCallFrame")
          return {
            result: {
              value: {
                pid: 10,
                executable:
                  outcome === "wrong-executable" ? "C:\\wrong.exe" : "C:\\app\\kobrixa.exe",
                ready: outcome === "already-ready",
              },
            },
          };
      },
    };
    const work = observeSecondaryStartup(client, 10, "C:\\app\\kobrixa.exe", known, async () => {
      calls.push("OS creation identity");
      return outcome === "missing" ? [] : [{ pid: 10, ppid: 1, created: "observed-creation" }];
    });
    if (outcome === "success") {
      assert.equal((await work).pid, 10);
      assert.equal(known.get(10), "observed-creation");
      assert.ok(calls.indexOf("OS creation identity") < calls.indexOf("Debugger.resume"));
    } else {
      await assert.rejects(work);
      assert.equal(calls.includes("Debugger.resume"), false);
    }
  }
});
