import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import {
  observeInstalledWorkers,
  collectWorkerTimeline,
  installProbe,
  verifyLeaf,
} from "./builtin-process-installed.mjs";

async function makeLeaf(directory) {
  const manifest = {
    id: "acceptance.ui",
    runtime: { kind: "node", entry: "main.cjs" },
    contributes: { panels: [{ resource: { version: 1, path: "panel.json" } }] },
  };
  const files = {
    "main.cjs": "process.exit(0);",
    "kobrixa-plugin.json": JSON.stringify(manifest),
    "panel.json": '{"kind":"panel"}',
  };
  await mkdir(directory, { recursive: true });
  const index = { version: 1, pluginId: manifest.id, files: [] };
  for (const name of Object.keys(files).sort()) {
    const contents = files[name];
    await writeFile(path.join(directory, name), contents);
    index.files.push({
      path: name,
      bytes: Buffer.byteLength(contents),
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  await writeFile(path.join(directory, "resource-index.json"), JSON.stringify(index));
  return index;
}
test("U14/B1-RF5: missing/corrupt/foreign/traversing payloads fail closed", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "ui-payload-audit-"));
  try {
    const leaf = path.join(temporary, "leaf");
    let index = await makeLeaf(leaf);
    assert.deepEqual(await verifyLeaf(leaf, "acceptance.ui"), index);
    await rm(path.join(leaf, "main.cjs"));
    await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    index = await makeLeaf(leaf);
    await writeFile(path.join(leaf, "main.cjs"), "corruption");
    await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    await makeLeaf(leaf);
    await assert.rejects(verifyLeaf(leaf, "another.plugin"));
    for (const change of [
      (i) => {
        i.files.push(i.files[0]);
      },
      (i) => {
        i.files[0].path = "../escape.json";
      },
      (i) => {
        i.files[0].sha256 = i.files[0].sha256.toUpperCase();
      },
      (i) => {
        i.files.reverse();
      },
      (i) => {
        i.files.push({ path: "resource-index.json", bytes: 1, sha256: "a".repeat(64) });
      },
      (i) => {
        i.files[0].bytes++;
      },
      (i) => {
        i.extra = true;
      },
      (i) => {
        i.files[0].extra = true;
      },
    ]) {
      index = await makeLeaf(leaf);
      change(index);
      await writeFile(path.join(leaf, "resource-index.json"), JSON.stringify(index));
      await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    }
    await makeLeaf(leaf);
    await writeFile(path.join(leaf, "resource-index.json"), " ".repeat(16385));
    await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    if (process.platform !== "win32") {
      await makeLeaf(leaf);
      const outside = path.join(temporary, "outside.cjs");
      await writeFile(outside, "process.exit(0);");
      await rm(path.join(leaf, "main.cjs"));
      await symlink(outside, path.join(leaf, "main.cjs"));
      await assert.rejects(verifyLeaf(leaf, "acceptance.ui"));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// Receipt validation is a pure audit. Only the controller can supply actual
// installed evidence; unit data below is never written as an installed receipt.
export function assertProductReceipt(report) {
  assert.equal(report.kind, "installed-builtin-product");
  assert.equal(report.status, "passed");
  assert.equal(report.error, undefined);
  assert.equal(report.finalizationError, undefined);
  assert.equal(report.syntheticHost, false);
  assert.equal(report.artifact.syntheticHost, false);
  assert.match(report.artifact.commit, /^[0-9a-f]{40}$/);
  assert.equal(typeof report.artifact.dirty, "boolean");
  for (const key of ["appAsarSha256", "originalExecutableSha256", "payloadIndexSha256"])
    assert.match(report.artifact[key], /^[0-9a-f]{64}$/);
  assert.ok(Object.keys(report.artifact.shippedFiles).length >= 3);
  for (const hash of Object.values(report.artifact.shippedFiles))
    assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(report.artifact.package.name, "@kobrixa/desktop");
  assert.equal(report.artifact.package.main, ".vite/build/main.cjs");
  assert.equal(report.artifact.manifest.id, "kobrixa.motor-test");
  assert.equal(report.artifact.releasePayloadIndex.pluginId, "kobrixa.motor-test");
  assert.deepEqual(
    report.artifact.releasePayloadIndex.files.map((item) => item.path),
    ["kobrixa-plugin.json", "main.cjs", "panel.json", "status.json"],
  );
  for (const field of [
    "noPathNode",
    "noNodePath",
    "arbitraryCwd",
    "originalAppAsarIntact",
    "copiedAppAsarIntact",
    "originalExecutableIntact",
    "originalPayloadIntact",
  ])
    assert.equal(report[field], true, field);
  assert.deepEqual(
    report.runs.map((run) => run.name),
    ["healthy", "restart", "missing", "tampered"],
  );
  for (const run of report.runs) {
    assert.equal(run.error, undefined);
    assert.equal(run.cleanupErrors, undefined);
    assert.equal(run.originalForkObserved, true);
    assert.equal(run.probeRestored, true);
    assert.equal(run.gracefulQuit, true);
    assert.equal(run.forcedCleanup, false);
    assert.deepEqual(run.exit, { code: 0, signal: null });
    assert.ok(Number.isSafeInteger(run.pid) && run.pid > 0);
    assert.ok(run.observedPids.includes(run.pid));
    assert.deepEqual(run.remainingPids, []);
    assert.ok(["Kobrixa", "@kobrixa/desktop"].includes(run.identity.name));
    assert.equal(run.identity.version, report.artifact.package.version);
    assert.equal(run.identity.packaged, true);
    assert.equal(run.identity.removedEnvironment, true);
    assert.ok(run.identity.appPath.endsWith("app.asar"));
    assert.ok(report.entry.startsWith(`${run.identity.appPath}.unpacked/`));
    assert.equal(run.identity.userData, run.profile);
    for (const id of ["kobrixa.basic-plus", "kobrixa.ev3"]) {
      const plugin = run.beforeQuit.plugins.find((item) => item.id === id);
      assert.equal(plugin?.required, true);
      assert.equal(plugin.status, "enabled");
    }
    for (const fork of run.forks.filter(
      (item) => item.serviceName === "Kobrixa plugin kobrixa.motor-test",
    )) {
      assert.equal(fork.entry, report.entry);
      assert.equal(fork.cwd, path.dirname(report.entry));
    }
    const motors = run.forks.filter((item) => item.entry === report.entry);
    assert.equal(motors.length, run.name === "healthy" ? 2 : run.name === "restart" ? 1 : 0);
    for (const fork of motors) {
      assert.ok(Number.isSafeInteger(fork.pid) && fork.pid > 0);
      assert.equal(fork.exited, true);
      assert.equal(typeof fork.exitCode, "number");
    }
    if (report.isolated) {
      assert.equal(report.sourceRootDenial, "verified-in-all-four-product-processes");
      if (report.artifact.platform === "darwin") {
        assert.match(report.isolationProfile, /\(deny network\*\)/);
        assert.match(report.isolationProfile, /allow network-inbound/);
        for (const denied of report.deniedRoots)
          assert.ok(
            report.isolationProfile.includes(
              `(deny file-read* (subpath ${JSON.stringify(denied)}))`,
            ),
          );
      } else {
        assert.equal(report.artifact.platform, "linux");
        assert.deepEqual(report.externalAddresses, []);
        assert.match(report.isolationProfile, /Landlock ABI >= 4/);
        assert.match(report.isolationLauncherSha256, /^[a-f0-9]{64}$/);
        assert.equal(run.chromiumSandbox.disabledByArgument, false);
        assert.ok(run.chromiumSandbox.windows.length > 0);
        for (const preferences of run.chromiumSandbox.windows)
          assert.deepEqual(preferences, {
            sandbox: true,
            nodeIntegration: false,
            contextIsolation: true,
          });
      }
      assert.ok(report.deniedRoots.includes(report.artifact.sourceRoot));
      for (const field of ["checkout", "worktree", "dependency", "network"])
        assert.ok(["EPERM", "EACCES"].includes(run.isolation[field]), field);
    }
  }
  const [healthy, restart, missing, tampered] = report.runs;
  assert.equal(healthy.freshProcessIdentity, true);
  const motors = healthy.forks.filter((item) => item.entry === report.entry);
  assert.notEqual(motors[0].pid, motors[1].pid);
  for (const run of [healthy, restart]) {
    const lazy = run.lazyState.plugins.find((item) => item.id === "kobrixa.motor-test");
    assert.equal(lazy.status, "enabled");
    assert.equal(lazy.running, false);
    assert.equal(run.snapshots.length, run.name === "healthy" ? 2 : 1);
    for (const snapshot of run.snapshots) {
      assert.equal(snapshot.binding.kind, "panel");
      assert.equal(snapshot.binding.contributionId, "kobrixa.motor-test.panel");
      assert.equal(snapshot.data["can-start"], false);
      assert.equal(snapshot.data.available, false);
      assert.match(snapshot.data.summary, /Unavailable|無法使用/);
    }
    assertRenderedEvidence(run);
  }
  assert.notEqual(
    healthy.snapshots[0].binding.processEpoch,
    healthy.snapshots[1].binding.processEpoch,
  );
  const persisted = restart.persistedDisable.plugins.find(
    (item) => item.id === "kobrixa.motor-test",
  );
  assert.equal(persisted.status, "disabled");
  assert.equal(persisted.disabledBy, "user");
  assert.equal(persisted.running, false);
  assert.equal(healthy.profile, restart.profile);
  for (const run of [missing, tampered]) {
    assert.equal(run.phase, "resolve-before-launch");
    assert.equal(run.launched, false);
    assert.equal(run.rejected, true);
    const motor = run.state.plugins.find((item) => item.id === "kobrixa.motor-test");
    assert.equal(motor.status, "invalid");
    assert.equal(motor.running, false);
    assert.ok(motor.problems.some((item) => item.code === "PLUGIN_E_ENTRY"));
    assert.equal(run.catalog.ok, true);
    assert.ok(!run.catalog.value.entries.some((item) => item.pluginId === "kobrixa.motor-test"));
  }
}

function assertRenderedEvidence(run) {
  assert.equal(run.rendered.length, run.name === "healthy" ? 2 : 1);
  for (const dom of run.rendered) {
    assert.match(dom.summary, /Unavailable|無法使用/);
    assert.ok(dom.actions.length > 0 && dom.actions.every((item) => item.disabled));
  }
}

test("U14: rendered evidence requires every healthy and restarted panel observation", () => {
  const observation = { summary: "Unavailable", actions: [{ disabled: true }] };
  for (const [name, count] of [
    ["healthy", 2],
    ["restart", 1],
  ]) {
    const run = {
      name,
      rendered: Array.from({ length: count }, () => structuredClone(observation)),
    };
    assertRenderedEvidence(run);
    for (let length = 0; length < count; length++)
      assert.throws(() =>
        assertRenderedEvidence({ ...run, rendered: run.rendered.slice(0, length) }),
      );
    assert.throws(() =>
      assertRenderedEvidence({ ...run, rendered: [...run.rendered, observation] }),
    );
  }
});

test("U14: synthetic or partial receipts cannot pass product acceptance", () => {
  for (const report of [
    {},
    { kind: "installed-builtin", syntheticHost: true },
    { kind: "installed-builtin-product", status: "failed", syntheticHost: false },
    { kind: "installed-builtin-product", status: "passed", syntheticHost: true },
    {
      kind: "installed-builtin-product",
      status: "passed",
      syntheticHost: false,
      artifact: { syntheticHost: true },
    },
  ])
    assert.throws(() => assertProductReceipt(report));
});

test(
  "U14/T6: controller receipt contains real installed product evidence",
  {
    skip: process.env.KOBRIXA_BUILTIN_REPORT
      ? false
      : "controller-installed product run required; pure Node audit is not installed evidence",
  },
  async () =>
    assertProductReceipt(JSON.parse(await readFile(process.env.KOBRIXA_BUILTIN_REPORT, "utf8"))),
);

test("installed Worker observer preserves constructor arguments, prototype, and event delivery", () => {
  const calls = [],
    emitted = [];
  class Worker extends EventEmitter {
    constructor(...args) {
      super();
      calls.push({ args, instance: this, newTarget: new.target });
      this.threadId = 17;
    }
  }
  const threads = { Worker };
  const probe = observeInstalledWorkers(
    threads,
    (row) => emitted.push(row),
    () => ({ at: 10, monotonicMs: 2 }),
  );
  const options = { workerData: { held: new SharedArrayBuffer(16) }, transferList: [] };
  const child = new threads.Worker("/installed/persistence-worker.cjs", options);
  assert.equal(calls[0].args[1], options);
  assert.equal(calls[0].instance, child);
  assert.equal(calls[0].newTarget, Worker);
  assert.equal(Object.getPrototypeOf(child), Worker.prototype);
  assert.equal(threads.Worker.prototype, Worker.prototype);
  assert.deepEqual(child.eventNames(), []);
  const ready = { version: 1, kind: "ready", recovery: "ready" };
  let received;
  child.on("message", (value) => {
    received = value;
  });
  child.emit("online");
  assert.equal(child.emit("message", ready), true);
  assert.equal(received, ready);
  const error = Object.assign(new Error("startup failure"), { code: "EACCES" });
  assert.throws(
    () => child.emit("error", error),
    (value) => value === error,
  );
  assert.equal(child.emit("exit", 1), false);
  assert.equal(Object.hasOwn(child, "emit"), false);
  assert.deepEqual(
    emitted.map((row) => row.event),
    ["construct", "constructed", "online", "message", "error", "exit"],
  );
  assert.equal(emitted[0].arguments[0], "/installed/persistence-worker.cjs");
  assert.deepEqual(emitted[0].arguments[1], {
    workerData: { held: { type: "SharedArrayBuffer", byteLength: 16 } },
    transferList: [],
  });
  assert.deepEqual(emitted[3].message, ready);
  assert.equal(emitted[4].error.code, "EACCES");
  assert.equal(emitted[5].code, 1);
  assert.equal(probe.restore(), true);
  assert.equal(threads.Worker, Worker);
});

test("installed Worker observer preserves subclasses and original constructor failures", () => {
  const originalError = new Error("bad entry");
  class Worker extends EventEmitter {
    constructor(entry) {
      super();
      if (entry === "bad") throw originalError;
    }
  }
  const threads = { Worker };
  const probe = observeInstalledWorkers(
    threads,
    () => {
      throw Error("diagnostic sink failed");
    },
    () => ({ at: 1 }),
  );
  class Derived extends threads.Worker {}
  const child = new Derived("ok");
  assert.equal(Object.getPrototypeOf(child), Derived.prototype);
  assert.throws(
    () => new threads.Worker("bad"),
    (value) => value === originalError,
  );
  assert.equal(probe.timeline.at(-1).event, "constructor-error");
  probe.restore();
});

test("serialized inspector probe persists early exit even when main cannot be queried", () => {
  class Worker extends EventEmitter {
    constructor() {
      super();
      this.threadId = 9;
    }
  }
  const threads = { Worker };
  const originalFork = () => new EventEmitter();
  const electron = { app: {}, utilityProcess: { fork: originalFork } };
  let output = "";
  const context = {
    URL,
    performance,
    SharedArrayBuffer,
    process: {
      execPath: "/installed/kobrixa",
      execArgv: ["--inspect-brk=127.0.0.1:0"],
      resourcesPath: "/installed/resources",
      getBuiltinModule: () => ({
        createRequire: () => (name) => (name === "electron" ? electron : threads),
      }),
      stderr: {
        write: (text) => {
          output += text;
        },
      },
    },
  };
  assert.equal(runInNewContext(installProbe, context), true);
  const child = new threads.Worker("/installed/worker.cjs", { workerData: {} });
  child.emit("online");
  child.emit("exit", 0);
  // No inspector snapshot available: reconstruct solely from emitted diagnostics.
  const rows = collectWorkerTimeline(output);
  assert.deepEqual(
    rows.map((row) => row.event),
    ["construct", "constructed", "online", "exit"],
  );
  assert.equal(rows.at(-1).code, 0);
  assert.deepEqual(rows[0].execArgv, ["--inspect-brk=127.0.0.1:0"]);
  assert.equal(rows[0].resourcesPath, "/installed/resources");
  assert.deepEqual(collectWorkerTimeline(output, rows.slice(0, 2)), rows);
  assert.equal(context.__installedProbe.restore(), true);
  assert.equal(threads.Worker, Worker);
  assert.equal(electron.utilityProcess.fork, originalFork);
  assert.throws(() => collectWorkerTimeline("KOBRIXA_INSTALLED_WORKER {bad}"));
  assert.throws(() => collectWorkerTimeline(output, [{ ...rows[0], worker: 999 }]));
});
