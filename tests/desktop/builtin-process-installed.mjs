import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { tmpdir, networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { extractFile, statFile } from "@electron/asar";
import {
  command,
  connect,
  descendants,
  processTable,
  signalProcess,
  until,
} from "./builtin-installed-client.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const motorKey = "builtin:kobrixa.motor-test";
const motorId = "kobrixa.motor-test";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const errorRecord = (error) => ({
  name: error.name,
  message: error.message,
  stack: error.stack,
  code: error.code,
  stdout: error.stdout,
  stderr: error.stderr,
});
async function boundedFile(rootReal, relative, limit) {
  let current = rootReal;
  for (const segment of relative.split("/")) {
    assert.ok(segment && segment !== "." && segment !== "..");
    current = path.join(current, segment);
    assert.equal((await lstat(current)).isSymbolicLink(), false);
  }
  const resolved = await realpath(current);
  assert.equal(resolved, current);
  const handle = await open(
    current,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    assert.ok(stat.isFile() && stat.size <= limit);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (read.bytesRead === 0) break;
      size += read.bytesRead;
    }
    assert.ok(size <= limit);
    return buffer.subarray(0, size);
  } finally {
    await handle.close();
  }
}
export async function verifyLeaf(directory, pluginId) {
  const rootReal = await realpath(directory);
  const raw = await boundedFile(rootReal, "resource-index.json", 16 * 1024);
  const index = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(Object.keys(index).sort(), ["files", "pluginId", "version"]);
  assert.equal(index.version, 1);
  assert.equal(index.pluginId, pluginId);
  assert.ok(index.files.length >= 2 && index.files.length <= 32);
  const paths = index.files.map((file) => file.path);
  assert.deepEqual(paths, [...new Set(paths)].sort());
  assert.ok(paths.includes("main.cjs") && paths.includes("kobrixa-plugin.json"));
  assert.equal(paths.includes("resource-index.json"), false);
  for (const file of index.files) {
    assert.deepEqual(Object.keys(file).sort(), ["bytes", "path", "sha256"]);
    assert.ok(
      file.path === "main.cjs" ||
        /^(?:[a-z0-9][a-z0-9-]*\/)*[a-z0-9][a-z0-9-]*\.json$/.test(file.path),
    );
    assert.match(file.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
    const limit =
      file.path === "main.cjs"
        ? 16 * 1024 * 1024
        : file.path === "kobrixa-plugin.json"
          ? 64 * 1024
          : 1024 * 1024;
    assert.ok(file.bytes <= limit);
    const contents = await boundedFile(rootReal, file.path, limit);
    assert.equal(contents.length, file.bytes);
    assert.equal(createHash("sha256").update(contents).digest("hex"), file.sha256);
  }
  const manifest = JSON.parse(
    (await boundedFile(rootReal, "kobrixa-plugin.json", 64 * 1024)).toString("utf8"),
  );
  assert.equal(manifest.id, pluginId);
  assert.deepEqual(manifest.runtime, { kind: "node", entry: "main.cjs" });
  const resources = [
    ...(manifest.contributes.panels ?? []),
    ...(manifest.contributes.status ?? []),
  ].map((item) => {
    assert.equal(item.resource.version, 1);
    return item.resource.path;
  });
  assert.deepEqual(paths, [...new Set(["main.cjs", "kobrixa-plugin.json", ...resources])].sort());
  return index;
}

// Serialized into the main inspector before app readiness; no product code changes.
export function observeInstalledWorkers(threads, emit, clock) {
  const original = threads.Worker;
  const timeline = [];
  let ordinal = 0;
  const describe = (value, seen = new Set()) => {
    if (value === undefined) return { type: "undefined" };
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
    if (typeof value !== "object") return { type: typeof value };
    if (seen.has(value)) return { type: "reference" };
    seen.add(value);
    if (value instanceof URL) return { type: "URL", href: value.href };
    if (
      ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      value instanceof SharedArrayBuffer
    )
      return { type: value.constructor.name, byteLength: value.byteLength };
    if (Array.isArray(value)) return value.map((item) => describe(item, seen));
    const result = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      result[key] = Object.hasOwn(descriptor, "value")
        ? describe(descriptor.value, seen)
        : { type: "accessor" };
    }
    return result;
  };
  const record = (worker, event, detail = {}) => {
    // Diagnostics must never replace a constructor/event error or break delivery.
    try {
      const row = { sequence: timeline.length, worker, event, ...clock(), ...detail };
      timeline.push(row);
      emit(row);
    } catch {
      /* Keep the original Worker behavior. */
    }
  };
  const observed = new Proxy(original, {
    construct(target, args, newTarget) {
      const worker = ordinal++;
      record(worker, "construct", { arguments: describe(args) });
      let child;
      try {
        child = Reflect.construct(target, args, newTarget === observed ? target : newTarget);
      } catch (error) {
        record(worker, "constructor-error", { error: describe(error) });
        throw error;
      }
      record(worker, "constructed", { threadId: child.threadId });
      const originalEmit = child.emit;
      const ownEmit = Object.getOwnPropertyDescriptor(child, "emit");
      function observedEmit(event, ...values) {
        if (event === "online") record(worker, "online", { threadId: child.threadId });
        if (event === "error") record(worker, "error", { error: describe(values[0]) });
        if (event === "exit") record(worker, "exit", { code: values[0] });
        if (event === "message" && values[0]?.kind === "ready")
          record(worker, "message", { message: describe(values[0]) });
        try {
          return Reflect.apply(originalEmit, this, [event, ...values]);
        } finally {
          if (event === "exit" && child.emit === observedEmit) {
            if (ownEmit) Object.defineProperty(child, "emit", ownEmit);
            else delete child.emit;
          }
        }
      }
      // No event listeners, refs, timers, or ports are added to the worker.
      child.emit = observedEmit;
      return child;
    },
  });
  threads.Worker = observed;
  if (threads.Worker !== observed) throw Error("Cannot observe original Worker");
  return {
    timeline,
    restore() {
      if (threads.Worker !== observed) throw Error("Worker observer was replaced");
      threads.Worker = original;
      return threads.Worker === original;
    },
  };
}

export function collectWorkerTimeline(output, prior = []) {
  const rows = new Map(prior.map((row) => [row.sequence, row]));
  for (const line of output.split("\n")) {
    if (!line.startsWith("KOBRIXA_INSTALLED_WORKER ")) continue;
    const row = JSON.parse(line.slice("KOBRIXA_INSTALLED_WORKER ".length));
    assert.ok(Number.isSafeInteger(row.sequence) && row.sequence >= 0);
    if (rows.has(row.sequence)) assert.deepEqual(rows.get(row.sequence), row);
    rows.set(row.sequence, row);
  }
  return [...rows.values()].sort((a, b) => a.sequence - b.sequence);
}

// Inspector-only observation: call and return the original fork without changing
// arguments, services, channels, or product policy. Exit records survive app quit.
export const installProbe = `(() => {
  const require = process.getBuiltinModule('module').createRequire(process.execPath);
  const electron = require('electron');
  if (!electron.utilityProcess?.fork || !electron.app) throw Error('Main Electron probe unavailable');
  const workers = (${observeInstalledWorkers.toString()})(require('node:worker_threads'),
    row => process.stderr.write('\\nKOBRIXA_INSTALLED_WORKER ' + JSON.stringify(row) + '\\n'),
    () => ({ at: Date.now(), monotonicMs: performance.now(), execArgv: [...process.execArgv], resourcesPath: process.resourcesPath }));
  const original = electron.utilityProcess.fork;
  const records = [];
  const emit = record => process.stderr.write('\\nKOBRIXA_INSTALLED_PROBE ' + JSON.stringify(record) + '\\n');
  function observed(...args) {
    const child = Reflect.apply(original, this, args);
    const record = { ordinal: records.length, entry: args[0], cwd: args[2]?.cwd, serviceName: args[2]?.serviceName, pid: child.pid ?? null, exited: false };
    records.push(record);
    child.once('spawn', () => { record.pid = child.pid; emit(record); });
    child.once('exit', code => { record.exited = true; record.exitCode = code; emit(record); });
    return child;
  }
  electron.utilityProcess.fork = observed;
  if (electron.utilityProcess.fork !== observed) throw Error('Cannot observe original utilityProcess.fork');
  globalThis.__installedProbe = { electron, require, records, workers, restore() {
    if (electron.utilityProcess.fork !== observed) throw Error('fork observer was replaced');
    electron.utilityProcess.fork = original;
    return workers.restore() && electron.utilityProcess.fork === original;
  }};
  return true;
})()`;

function requiredCompilers(state) {
  for (const id of ["kobrixa.basic-plus", "kobrixa.ev3"]) {
    const plugin = state.plugins.find((item) => item.id === id);
    assert.ok(
      plugin?.required && plugin.status === "enabled",
      `Required compiler ${id}: ${JSON.stringify(plugin)}`,
    );
  }
}

async function launchProduct(config, receipt, check) {
  const {
    directory,
    executable,
    cwd,
    env,
    profile,
    isolationProfile,
    isolated,
    probes,
    deniedRoots,
  } = config;
  const clients = [];
  const known = new Set();
  let child,
    exit,
    closed,
    main,
    renderer,
    monitor,
    monitoring = false,
    monitorError;
  let output = "";
  let ended = false,
    failure,
    launchError;
  receipt.profile = profile;
  receipt.forcedCleanup = false;
  receipt.forks = [];
  receipt.workerTimeline = [];
  const sample = async () => {
    if (!child?.pid) return [];
    return descendants(await processTable(), child.pid, known);
  };
  try {
    child = spawn(
      isolated
        ? process.platform === "darwin"
          ? "/usr/bin/sandbox-exec"
          : "/usr/bin/python3"
        : executable,
      [
        ...(isolated
          ? process.platform === "darwin"
            ? ["-f", isolationProfile, executable]
            : [
                fileURLToPath(new URL("./builtin-installed-landlock.py", import.meta.url)),
                ...deniedRoots,
                "--",
                executable,
              ]
          : []),
        "--inspect=127.0.0.1:0",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
      ],
      { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    receipt.pid = child.pid;
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    exit = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        launchError = error;
        receipt.spawnError = errorRecord(error);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        ended = true;
        receipt.exit = { code, signal };
        resolve();
      });
    });
    closed = new Promise((resolve) => child.once("close", resolve));
    // Attach a rejection handler immediately, including startup failures.
    exit.catch(() => {});
    monitoring = true;
    monitor = (async () => {
      while (monitoring) {
        await sample();
        await pause(100);
      }
    })().catch((error) => {
      monitorError = error;
    });
    const alive = (read) =>
      until(
        async () => {
          if (launchError) throw launchError;
          if (monitorError) throw monitorError;
          assert.equal(
            ended,
            false,
            `Product exited before evidence: ${JSON.stringify(receipt.exit)}`,
          );
          return read();
        },
        "product debug readiness",
        30_000,
      );
    const mainUrl = await alive(() => output.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]);
    main = await connect(mainUrl);
    clients.push(main);
    const installed = await main.send("Runtime.evaluate", {
      expression: installProbe,
      returnByValue: true,
    });
    if (installed.exceptionDetails) throw Error(JSON.stringify(installed.exceptionDetails));
    assert.equal(installed.result.value, true);
    receipt.originalForkObserved = true;
    receipt.probeBeforeReady = await main.js("!__installedProbe.electron.app.isReady()");
    assert.equal(receipt.probeBeforeReady, true, "Observe startup before application readiness");
    const browserUrl = await alive(
      () => output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    );
    const target = await alive(async () => {
      const response = await fetch(`http://${new URL(browserUrl).host}/json/list`, {
        signal: AbortSignal.timeout(2000),
      });
      assert.ok(response.ok);
      return (await response.json()).find(
        (page) => page.type === "page" && page.url.startsWith("file:"),
      );
    });
    renderer = await connect(target.webSocketDebuggerUrl);
    clients.push(renderer);
    await alive(() =>
      renderer.js(
        'Boolean(window.kobrixa?.plugins?.ui && document.querySelector(".plugin-tools-toggle"))',
      ),
    );
    await renderer.send("Page.bringToFront");
    receipt.identity = await main.js(`(() => { const {app} = __installedProbe.electron; return {
      name: app.getName(), version: app.getVersion(), packaged: app.isPackaged,
      appPath: app.getAppPath(), executable: app.getPath('exe'), userData: app.getPath('userData'),
      cwd: process.cwd(), path: process.env.PATH,
      removedEnvironment: ['NODE_PATH','NODE_OPTIONS','ELECTRON_RUN_AS_NODE','PYTHONPATH'].every(k => process.env[k] === undefined)
    }; })()`);
    assert.ok(
      ["Kobrixa", "@kobrixa/desktop"].includes(receipt.identity.name),
      `Unexpected product: ${receipt.identity.name}`,
    );
    assert.equal(receipt.identity.packaged, true);
    assert.equal(receipt.identity.appPath, config.archive);
    assert.equal(receipt.identity.userData, profile);
    assert.equal(receipt.identity.cwd, cwd);
    assert.equal(receipt.identity.path, env.PATH);
    assert.equal(receipt.identity.removedEnvironment, true);
    receipt.chromiumSandbox = await main.js(`(() => ({
      disabledByArgument: process.argv.includes('--no-sandbox') || process.argv.includes('--disable-setuid-sandbox'),
      windows: __installedProbe.electron.BrowserWindow.getAllWindows().map(window => {
        const preferences = window.webContents.getLastWebPreferences();
        return { sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation };
      })
    }))()`);
    assert.equal(receipt.chromiumSandbox.disabledByArgument, false);
    assert.ok(receipt.chromiumSandbox.windows.length > 0);
    for (const preferences of receipt.chromiumSandbox.windows)
      assert.deepEqual(preferences, {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
      });
    receipt.pendingPreferenceReads = 0;
    receipt.preferences = await alive(async () => {
      const result = await renderer.js(`window.kobrixa.device.getPreferences().then(
        preferences => ({ preferences }), error => {
          if (String(error).includes("Device settings are not admitted.")) return { pending: true };
          throw error;
        })`);
      if (result.pending) {
        receipt.pendingPreferenceReads++;
        return null;
      }
      return result.preferences;
    });
    assert.equal(receipt.preferences.usbAutoReconnect, false);
    if (isolated) {
      receipt.isolation = await main.js(`(async () => {
        const require = __installedProbe.require;
        const denied = async file => { try { await require('node:fs/promises').readFile(file); return 'READABLE'; } catch(e) { return e.code; } };
        const result = {};
        for (const [key, file] of Object.entries(${JSON.stringify(probes.files)})) result[key] = await denied(file);
        result.network = await new Promise(resolve => {
          const socket = require('node:net').connect({host:'127.0.0.1',port:${probes.port}});
          socket.setTimeout(2000);
          socket.once('connect', () => { socket.destroy(); resolve('CONNECTED'); });
          socket.once('error', error => { socket.destroy(); resolve(error.code); });
          socket.once('timeout', () => { socket.destroy(); resolve('TIMEOUT'); });
        });
        return result;
      })()`);
      for (const [key, code] of Object.entries(receipt.isolation))
        assert.ok(["EPERM", "EACCES"].includes(code), `${key} must be OS denied: ${code}`);
    }
    const state = () => renderer.js("window.kobrixa.plugins.state()");
    const forks = () => main.js("__installedProbe.records");
    await check({ renderer, main, state, forks });
    receipt.beforeQuit = await state();
    requiredCompilers(receipt.beforeQuit);
    receipt.forks = await forks();
    receipt.workerTimeline = await main.js("__installedProbe.workers.timeline");
    receipt.probeRestored = await main.js("__installedProbe.restore()");
    assert.equal(receipt.probeRestored, true);
    // Dispatch quit synchronously and let the official shutdown coordination run.
    await main.js("setTimeout(() => __installedProbe.electron.app.quit(), 0); true");
    main.close(); // Node inspector must detach for Electron/Node to finish quitting.
    await until(() => ended, "graceful application quit", 12_000);
    await exit;
    assert.equal(receipt.exit.code, 0, JSON.stringify(receipt.exit));
    receipt.gracefulQuit = true;
  } catch (error) {
    receipt.error = errorRecord(error);
    failure = error;
  } finally {
    const cleanupErrors = [];
    // Restore even after an assertion failure, while the main probe is reachable.
    if (!receipt.probeRestored && main && receipt.originalForkObserved) {
      try {
        receipt.forks = await main.js("__installedProbe.records");
        receipt.workerTimeline = await main.js("__installedProbe.workers.timeline");
        receipt.probeRestored = await main.js("__installedProbe.restore()");
      } catch (error) {
        cleanupErrors.push(errorRecord(error));
      }
    }
    for (const client of clients) client.close();
    try {
      if (!ended && child?.pid) {
        receipt.forcedCleanup = true;
        const signalingErrors = [];
        signalProcess(-child.pid, "SIGTERM", signalingErrors);
        cleanupErrors.push(...signalingErrors.map(errorRecord));
        try {
          await until(() => ended, "termination", 3000);
        } catch {
          /* Escalate below. */
        }
      }
      for (const fork of receipt.forks) if (Number.isSafeInteger(fork.pid)) known.add(fork.pid);
      let remaining = await sample();
      if (ended && remaining.length) {
        try {
          await until(
            async () => {
              remaining = await sample();
              return remaining.length === 0;
            },
            "natural descendant exit",
            5000,
          );
        } catch {
          /* Preserve observed survivors for forced cleanup. */
        }
      }
      if (remaining.length) {
        receipt.forcedCleanup = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") cleanupErrors.push(errorRecord(error));
        }
        // Account for observed descendants which changed process group/reparented.
        for (const { pid } of remaining) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") cleanupErrors.push(errorRecord(error));
          }
        }
      }
      if (config.singleInstance && ended) {
        const startedAt = Date.now();
        await pause(5000);
        remaining = await sample();
        receipt.fiveSecondCleanup = {
          startedAt,
          endedAt: Date.now(),
          remainingPids: remaining.map((row) => row.pid),
        };
      }
      await until(
        async () => {
          remaining = await sample();
          receipt.remainingPids = remaining.map(({ pid }) => pid);
          return remaining.length === 0;
        },
        "OS process tree cleanup",
        10_000,
      );
      if (exit)
        await Promise.race([
          exit,
          pause(1000).then(() => {
            if (!ended) throw Error("Child exit not reaped");
          }),
        ]);
    } catch (error) {
      cleanupErrors.push(errorRecord(error));
    }
    if (closed) {
      try {
        await Promise.race([
          closed,
          pause(3000).then(() => {
            throw Error("Child streams did not close");
          }),
        ]);
      } catch (error) {
        cleanupErrors.push(errorRecord(error));
      }
    }
    monitoring = false;
    await monitor;
    if (monitorError) cleanupErrors.push(errorRecord(monitorError));
    receipt.observedPids = [...known];
    for (const line of output.split("\n"))
      if (line.startsWith("KOBRIXA_INSTALLED_PROBE ")) {
        try {
          const record = JSON.parse(line.slice("KOBRIXA_INSTALLED_PROBE ".length));
          receipt.forks[record.ordinal] = record;
        } catch (error) {
          cleanupErrors.push(errorRecord(error));
        }
      }
    try {
      receipt.workerTimeline = collectWorkerTimeline(output, receipt.workerTimeline);
    } catch (error) {
      cleanupErrors.push(errorRecord(error));
    }
    try {
      await writeFile(path.join(directory, `${receipt.name}.log`), output);
    } catch (error) {
      cleanupErrors.push(errorRecord(error));
    }
    if (cleanupErrors.length) {
      receipt.cleanupErrors = cleanupErrors;
      failure ??= new AggregateError(
        cleanupErrors.map((error) => new Error(error.message)),
        "Installed cleanup failed",
      );
    }
  }
  if (failure) throw failure;
}

// Partial B2 gate: no secondary pre-lock/provider or active-recording claim.
export const SINGLE_INSTANCE_UNRUN = Object.freeze([
  "secondaryWorkers",
  "secondaryProviders",
  "secondaryPlugins",
  "primaryRecordingInterrupted",
]);
export function assertSingleInstanceReceipt(report) {
  assert.equal(report.kind, "installed-single-instance-partial");
  assert.equal(report.status, "partial");
  assert.equal(report.syntheticHost, false);
  assert.equal(report.isolated, true);
  assert.equal(report.error, undefined);
  assert.equal(report.finalizationError, undefined);
  assert.deepEqual(report.unrun, SINGLE_INSTANCE_UNRUN);
  for (const key of [
    "originalPayloadIntact",
    "originalAppAsarIntact",
    "copiedAppAsarIntact",
    "originalExecutableIntact",
    "noPathNode",
    "noNodePath",
    "arbitraryCwd",
  ])
    assert.equal(report[key], true, key);
  for (const key of ["appAsarSha256", "originalExecutableSha256", "payloadIndexSha256"])
    assert.match(report.artifact[key], /^[a-f0-9]{64}$/);
  assert.equal(report.runs.length, 1);
  const run = report.runs[0],
    observation = run.singleInstance,
    secondary = observation.secondary;
  assert.equal(run.name, "single-instance");
  assert.equal(run.error, undefined);
  assert.equal(run.cleanupErrors, undefined);
  assert.equal(run.forcedCleanup, false);
  assert.equal(run.gracefulQuit, true);
  assert.equal(run.exit.code, 0);
  assert.equal(run.probeRestored, true);
  assert.deepEqual(run.remainingPids, []);
  assert.ok(run.fiveSecondCleanup.endedAt - run.fiveSecondCleanup.startedAt >= 5000);
  assert.deepEqual(run.fiveSecondCleanup.remainingPids, []);
  assert.equal(observation.listenersRemoved, true);
  assert.equal(observation.before.focused, true);
  assert.equal(observation.defocused.focused, false);
  assert.equal(observation.after.focused, true);
  assert.equal(observation.before.pid, run.pid);
  assert.equal(observation.after.pid, run.pid);
  assert.equal(observation.before.windowId, observation.after.windowId);
  assert.equal(observation.before.profile, run.profile);
  assert.equal(observation.after.profile, run.profile);
  assert.equal(secondary.requestedProfile, run.profile);
  assert.ok(Number.isSafeInteger(secondary.pid) && secondary.pid > 0 && secondary.pid !== run.pid);
  assert.ok(secondary.argv.includes(`--user-data-dir=${run.profile}`));
  assert.match(secondary.marker, /^--b2-secondary=[a-f0-9-]{36}$/);
  assert.ok(secondary.argv.includes(secondary.marker));
  assert.equal(secondary.error, undefined);
  assert.match(secondary.logSha256, /^[a-f0-9]{64}$/);
  assert.equal(secondary.exit.code, 0);
  assert.equal(secondary.exit.signal, null);
  assert.equal(secondary.forcedCleanup, false);
  assert.equal(secondary.cleanupErrors, undefined);
  assert.deepEqual(secondary.remainingPids, []);
  assert.ok(secondary.cleanupObservedAt - secondary.exit.at >= 5000);
  const events = observation.events;
  const second = events.filter((event) => event.kind === "second-instance");
  assert.equal(second.length, 1);
  assert.ok(second[0].argv.includes(secondary.marker));
  assert.ok(second[0].argv.includes(`--user-data-dir=${run.profile}`));
  assert.equal(second[0].cwd, run.identity.cwd);
  assert.ok(second[0].at >= observation.defocused.at);
  assert.ok(
    events.some(
      (event) =>
        event.kind === "focus" &&
        event.windowId === observation.before.windowId &&
        event.at >= observation.defocused.at,
    ),
  );
  assert.ok(observation.after.at >= second[0].at);
  assert.deepEqual(observation.before.forks, observation.after.forks);
  assert.ok(
    observation.before.forks.some(
      (fork) =>
        fork.serviceName === "Kobrixa plugin kobrixa.motor-test" && fork.pid > 0 && !fork.exited,
    ),
  );
  assert.deepEqual(observation.before.binding, observation.after.binding);
  assert.deepEqual(observation.before.workerStarts, observation.after.workerStarts);
  const workers = observation.before.workerStarts.filter(
    (row) =>
      typeof row.arguments?.[0] === "string" && row.arguments[0].includes("persistence-worker"),
  );
  assert.equal(workers.length, 1);
  assert.equal(
    run.workerTimeline.filter((row) => row.worker === workers[0].worker && row.event === "exit")
      .length,
    1,
  );
  assert.equal(run.identity.packaged, true);
  assert.equal(run.identity.userData, run.profile);
  assert.equal(run.probeBeforeReady, true);
  assert.ok(run.observedPids.includes(run.pid));
  assert.ok(secondary.observedPids.includes(secondary.pid));
  assert.ok(
    run.forks.some(
      (fork) =>
        fork.pid ===
          observation.before.forks.find(
            (f) => f.serviceName === "Kobrixa plugin kobrixa.motor-test",
          ).pid && fork.exited,
    ),
  );
  for (const state of [observation.before.state, observation.after.state]) {
    requiredCompilers(state);
    assert.equal(state.plugins.find((plugin) => plugin.id === motorId)?.running, true);
  }
  for (const phase of ["before", "after"]) {
    assert.equal(observation.hashes[phase].asar, report.artifact.appAsarSha256);
    assert.match(observation.hashes[phase].executable, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(observation.hashes.before, observation.hashes.after);
  for (const code of Object.values(run.isolation)) assert.ok(["EPERM", "EACCES"].includes(code));
  assert.ok(Object.keys(run.isolation).length >= 3);
}

async function observeSingleInstance(client, config, run, binding) {
  const { main, renderer, state, forks } = client;
  const observation = (run.singleInstance = { secondary: { forcedCleanup: false }, hashes: {} });
  const snapshot = async () => ({
    ...(await main.js(
      `(() => { const p=__singleInstanceProbe; return {pid:process.pid, profile:p.app.getPath('userData'), windowId:p.window.id, focused:p.window.isFocused(), at:performance.now(), workerStarts:__installedProbe.workers.timeline.filter(row=>row.event==='construct')}; })()`,
    )),
    state: await state(),
    forks: await forks(),
    binding: (
      await renderer.js(
        `window.kobrixa.plugins.ui.snapshot({binding:${JSON.stringify(binding)}}).then(r=>{if(!r.ok) throw Error(JSON.stringify(r)); return r.value;})`,
      )
    ).binding,
  });
  const hashes = async () => ({
    asar: sha256(await readFile(config.archive)),
    executable: sha256(await readFile(config.executable)),
  });
  let child,
    exit,
    closed,
    ended = false,
    failure;
  const known = new Set();
  let output = "";
  const secondary = observation.secondary;
  await main.js(`(() => {
    const {app,BrowserWindow}=__installedProbe.electron, window=BrowserWindow.getAllWindows()[0];
    if(!window) throw Error('Missing original window');
    const events=[];
    const second=(_event,argv,cwd)=>events.push({kind:'second-instance',argv,cwd,at:performance.now()});
    const focus=()=>events.push({kind:'focus',windowId:window.id,at:performance.now()});
    app.on('second-instance',second);window.on('focus',focus);
    globalThis.__singleInstanceProbe={app,window,events,remove(){app.removeListener('second-instance',second);window.removeListener('focus',focus);return !app.listeners('second-instance').includes(second)&&!window.listeners('focus').includes(focus);}};
    return true;
  })()`);
  try {
    observation.before = await snapshot();
    observation.hashes.before = await hashes();
    assert.equal(observation.before.focused, true, "Original primary must initially be focused");
    await main.js("__singleInstanceProbe.window.blur(); true");
    await until(
      () => main.js("!__singleInstanceProbe.window.isFocused()"),
      "actual primary defocus",
    );
    observation.defocused = await main.js(
      `({focused:__singleInstanceProbe.window.isFocused(),at:performance.now()})`,
    );
    assert.equal(observation.defocused.focused, false);
    secondary.marker = `--b2-secondary=${randomUUID()}`;
    secondary.requestedProfile = config.profile;
    secondary.argv = [`--user-data-dir=${config.profile}`, secondary.marker];
    const args = config.isolated
      ? process.platform === "darwin"
        ? ["-f", config.isolationProfile, config.executable, ...secondary.argv]
        : [
            fileURLToPath(new URL("./builtin-installed-landlock.py", import.meta.url)),
            ...config.deniedRoots,
            "--",
            config.executable,
            ...secondary.argv,
          ]
      : secondary.argv;
    child = spawn(
      config.isolated
        ? process.platform === "darwin"
          ? "/usr/bin/sandbox-exec"
          : "/usr/bin/python3"
        : config.executable,
      args,
      { cwd: config.cwd, env: config.env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    secondary.pid = child.pid;
    secondary.startedAt = Date.now();
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    let launchError;
    exit = new Promise((resolve, reject) => {
      child.once("error", (error) => {
        launchError = error;
        reject(error);
      });
      child.once("exit", (code, signal) => {
        ended = true;
        secondary.exit = { code, signal, at: Date.now() };
        resolve();
      });
    });
    exit.catch(() => {});
    closed = new Promise((resolve) => child.once("close", resolve));
    await until(
      async () => {
        if (launchError) throw launchError;
        descendants(await processTable(), child.pid, known);
        return ended;
      },
      "secondary normal exit",
      15000,
    );
    await exit;
    assert.equal(secondary.exit.code, 0);
    assert.equal(secondary.exit.signal, null);
    await until(
      async () =>
        main.js(
          `__singleInstanceProbe.events.some(e=>e.kind==='second-instance'&&e.argv.includes(${JSON.stringify(secondary.marker)}))&&__singleInstanceProbe.window.isFocused()`,
        ),
      "original second-instance and focus",
    );
    observation.events = await main.js("__singleInstanceProbe.events");
    observation.after = await snapshot();
    observation.hashes.after = await hashes();
  } catch (error) {
    failure = error;
    secondary.error = errorRecord(error);
  } finally {
    try {
      observation.listenersRemoved = await main.js(
        "(() => {const removed=__singleInstanceProbe.remove();delete globalThis.__singleInstanceProbe;return removed;})()",
      );
    } catch (error) {
      failure ??= error;
    }
    const errors = [];
    if (child?.pid) {
      if (!ended) {
        secondary.forcedCleanup = true;
        signalProcess(-child.pid, "SIGTERM", errors);
      }
      try {
        await until(() => ended, "secondary reap", 3000);
        await pause(Math.max(0, secondary.exit.at + 5000 - Date.now()));
        let remaining = descendants(await processTable(), child.pid, known);
        if (remaining.length) {
          secondary.forcedCleanup = true;
          signalProcess(-child.pid, "SIGKILL", errors);
          for (const row of remaining) signalProcess(row.pid, "SIGKILL", errors);
          await until(
            async () => {
              remaining = descendants(await processTable(), child.pid, known);
              return !remaining.length;
            },
            "secondary descendants cleanup",
            5000,
          );
        }
        secondary.remainingPids = remaining.map((row) => row.pid);
        secondary.cleanupObservedAt = Date.now();
      } catch (error) {
        errors.push(error);
        secondary.forcedCleanup = true;
        signalProcess(-child.pid, "SIGKILL", errors);
        for (const row of descendants(await processTable(), child.pid, known))
          signalProcess(row.pid, "SIGKILL", errors);
      }
      if (closed)
        try {
          await Promise.race([
            closed,
            pause(3000).then(() => {
              throw Error("Secondary streams did not close");
            }),
          ]);
        } catch (error) {
          errors.push(error);
        }
    }
    secondary.observedPids = [...known];
    secondary.log = path.join(config.directory, "single-instance-secondary.log");
    await writeFile(secondary.log, output);
    secondary.logSha256 = sha256(output);
    if (errors.length) {
      secondary.cleanupErrors = errors.map(errorRecord);
      failure ??= new AggregateError(errors, "Secondary cleanup failed");
    }
  }
  if (failure) throw failure;
}

async function openMotor(client, manifest, receipt) {
  const { renderer, state } = client;
  await renderer.js(`(() => {
    globalThis.__installedUiEvents = [];
    globalThis.__installedUiOff = window.kobrixa.plugins.ui.onEvent(event => {
      if (__installedUiEvents.length < 256) __installedUiEvents.push(event);
    });
    const toggle = document.querySelector('.plugin-tools-toggle');
    if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
    return true;
  })()`);
  const panel = manifest.contributes.panels[0];
  await until(
    () =>
      renderer.js(`(() => {
    const tab = [...document.querySelectorAll('.plugin-tools-pane [role="tab"]')].find(el => ${JSON.stringify(Object.values(panel.title))}.includes(el.textContent.trim()));
    if (!tab) return false;
    tab.click(); return true;
  })()`),
    "real motor tab",
  );
  await until(
    () =>
      renderer.js(`(() => {
    if (document.querySelector('.plugin-tools-pane .plugin-ui')) return true;
    const open = document.querySelector('.plugin-tools-pane [role="tabpanel"] > button:not([data-close-contribution])');
    if (!open) return false;
    open.click(); return true;
  })()`),
    "generic panel Open button",
  );
  await until(
    () =>
      renderer.js(
        "Boolean(document.querySelector('.plugin-tools-pane .plugin-ui [data-ui-node=\"summary\"]'))",
      ),
    "real motor panel rendered",
  );
  const snapshot = await until(async () => {
    const value = await renderer.js(`(async () => {
      const event = [...__installedUiEvents].reverse().find(item => item.type === 'state' && item.binding?.kind === 'panel' && item.binding.contributionId === ${JSON.stringify(panel.id)});
      if (!event) return null;
      const result = await window.kobrixa.plugins.ui.snapshot({binding:event.binding});
      if (!result.ok) throw Error(JSON.stringify(result));
      return result.value;
    })()`);
    return value?.data?.summary && value;
  }, "official preload motor snapshot");
  assert.equal(snapshot.data.available, false);
  assert.equal(snapshot.data["can-start"], false);
  assert.match(snapshot.data.summary, /Unavailable|無法使用/);
  receipt.snapshots ??= [];
  receipt.snapshots.push(snapshot);
  const dom = await renderer.js(`(() => ({
    summary: document.querySelector('.plugin-tools-pane [data-ui-node="summary"]').textContent,
    actions: [...document.querySelectorAll('.plugin-tools-pane [data-ui-node]')]
      .filter(node => /^(?:[abcd]-(?:forward|reverse|start))$/.test(node.dataset.uiNode))
      .flatMap(node => [...node.querySelectorAll('button')].map(button => ({node:node.dataset.uiNode, disabled:button.disabled})))
  }))()`);
  assert.match(dom.summary, /Unavailable|無法使用/);
  assert.ok(
    dom.actions.length > 0 && dom.actions.every((item) => item.disabled),
    JSON.stringify(dom),
  );
  receipt.rendered ??= [];
  receipt.rendered.push(dom);
  await until(
    async () => (await state()).plugins.find((item) => item.id === motorId)?.running,
    "motor running",
  );
  await renderer.js("__installedUiOff(); delete globalThis.__installedUiOff; true");
  return snapshot;
}

async function freshProfile(directory, name) {
  const profile = path.join(directory, name);
  await mkdir(profile);
  await writeFile(
    path.join(profile, "device-settings.json"),
    JSON.stringify({ usbAutoReconnect: false }),
  );
  await writeFile(
    path.join(profile, "updates.json"),
    JSON.stringify({ enabled: false, channel: "stable" }),
  );
  return profile;
}

export async function main() {
  const isolated = process.argv.includes("--isolated");
  const singleInstance = process.argv.includes("--single-instance");
  assert.ok(!singleInstance || isolated, "Single-instance partial evidence requires --isolated");
  assert.ok(
    ["darwin", "linux"].includes(process.platform),
    "OS process-tree evidence currently supports macOS/Linux only; Windows remains unrun",
  );
  assert.ok(
    !isolated || process.platform === "darwin" || ["arm64", "x64"].includes(process.arch),
    "Linux isolation requires arm64 or x64 with Landlock ABI >= 4",
  );
  const externalAddresses = Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && !entry.internal);
  if (isolated && process.platform === "linux")
    assert.equal(
      externalAddresses.length,
      0,
      "Linux isolated proof requires a networkless namespace in addition to Landlock TCP denial",
    );
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "kobrixa-installed-product-")),
  );
  console.log(`Real product evidence workspace (always retained): ${directory}`);
  const output = path.join(directory, "installed.json");
  const report = {
    kind: singleInstance ? "installed-single-instance-partial" : "installed-builtin-product",
    ...(singleInstance ? { unrun: [...SINGLE_INSTANCE_UNRUN] } : {}),
    syntheticHost: false,
    status: "running",
    runs: [],
    isolated,
    sourceRootDenial: "unrun",
    ...(isolated && process.platform === "linux" ? { externalAddresses } : {}),
    limitations: [
      "Physical EV3 USB/Wi-Fi and motion parity UNRUN",
      "Clean-machine installation, other platforms, locale/theme/layout/keyboard acceptance UNRUN",
      "Stage 3 completion is not asserted",
    ],
  };
  let server, archive, originalArchive, sourceArchive, originalExecutable, executable, failure;
  const save = () => writeFile(output, JSON.stringify(report, null, 2));
  try {
    const source = path.join(root, `apps/desktop/out/Kobrixa-${process.platform}-${process.arch}`);
    const installed = path.join(directory, "installed");
    await cp(source, installed, { recursive: true, verbatimSymlinks: true });
    const appName =
      process.platform === "darwin"
        ? (await readdir(installed)).find((name) => name.endsWith(".app"))
        : null;
    assert.ok(process.platform !== "darwin" || appName);
    const resourceRelative =
      process.platform === "darwin" ? `${appName}/Contents/Resources` : "resources";
    const executableRelative =
      process.platform === "darwin" ? `${appName}/Contents/MacOS/kobrixa` : "kobrixa";
    const resources = path.join(installed, resourceRelative);
    executable = path.join(installed, executableRelative);
    archive = path.join(resources, "app.asar");
    sourceArchive = path.join(source, resourceRelative, "app.asar");
    originalArchive = sha256(await readFile(sourceArchive));
    originalExecutable = sha256(await readFile(path.join(source, executableRelative)));
    assert.equal(sha256(await readFile(archive)), originalArchive);
    const leaf = path.join(`${archive}.unpacked`, ".vite/build/plugins/motor-test");
    assert.equal(await realpath(leaf), leaf, "Installed motor leaf must not escape the copied app");
    const index = await verifyLeaf(leaf, motorId);
    const manifest = JSON.parse(await readFile(path.join(leaf, "kobrixa-plugin.json"), "utf8"));
    assert.deepEqual(manifest.activationEvents, ["onPanel:kobrixa.motor-test.panel"]);
    assert.deepEqual(
      index.files.map((item) => item.path),
      ["kobrixa-plugin.json", "main.cjs", "panel.json", "status.json"],
    );
    for (const name of [...index.files.map((item) => item.path), "resource-index.json"])
      assert.equal(statFile(archive, `.vite/build/plugins/motor-test/${name}`).unpacked, true);
    const packageJson = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
    assert.equal(packageJson.name, "@kobrixa/desktop");
    assert.equal(packageJson.main, ".vite/build/main.cjs");
    const entries = (await import("@electron/asar"))
      .listPackage(archive)
      .map((name) => name.replace(/^\//, ""));
    const shipped = entries.filter((name) =>
      /(?:^|\/)(?:preload[^/]*\.(?:js|cjs)|index\.html)$/.test(name),
    );
    assert.ok(
      shipped.some((name) => /preload/.test(name)),
      "Actual preload must be identified",
    );
    assert.ok(
      shipped.some((name) => /index\.html$/.test(name)),
      "Actual renderer must be identified",
    );
    report.artifact = {
      commit: (await command("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim(),
      dirty: Boolean(
        (await command("/usr/bin/git", ["status", "--porcelain"], { cwd: root })).stdout.trim(),
      ),
      platform: process.platform,
      arch: process.arch,
      source,
      sourceRoot: root,
      commitScope:
        "Source checkout observed at run time; build provenance is not independently attested",
      syntheticHost: false,
      package: packageJson,
      appAsarSha256: originalArchive,
      originalExecutableSha256: originalExecutable,
      shippedFiles: Object.fromEntries(
        [packageJson.main, ...shipped].map((name) => [name, sha256(extractFile(archive, name))]),
      ),
      payloadIndexSha256: sha256(await readFile(path.join(leaf, "resource-index.json"))),
      releasePayloadIndex: index,
      manifest,
    };
    const cwd = path.join(directory, "unrelated-cwd"),
      emptyPath = path.join(directory, "empty-path");
    await mkdir(cwd);
    await mkdir(emptyPath);
    const env = { ...process.env, PATH: emptyPath };
    for (const key of Object.keys(env))
      if (
        ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PYTHONPATH"].includes(
          key.toUpperCase(),
        )
      )
        delete env[key];
    const common = (
      await command("/usr/bin/git", ["rev-parse", "--git-common-dir"], { cwd: root })
    ).stdout.trim();
    const checkout = path.dirname(await realpath(path.resolve(root, common)));
    const dependencyFile = await realpath(
      createRequire(path.join(root, "apps/desktop/package.json")).resolve("zod/package.json"),
    );
    const dependencyRoot =
      dependencyFile.slice(0, dependencyFile.indexOf(`${path.sep}node_modules${path.sep}`)) +
      `${path.sep}node_modules`;
    assert.ok(dependencyFile.includes(`${path.sep}node_modules${path.sep}`));
    const deniedRoots = [...new Set([checkout, await realpath(root), dependencyRoot])];
    for (const denied of deniedRoots)
      assert.ok(!directory.startsWith(`${denied}/`), "Sandbox must allow only the copied artifact");
    const probes = {
      files: {
        checkout: path.join(checkout, "package.json"),
        worktree: path.join(root, "package.json"),
        dependency: dependencyFile,
      },
    };
    const isolationProfile = path.join(directory, "isolation.sb");
    if (isolated) {
      for (const file of Object.values(probes.files)) await readFile(file); // Establish that EPERM isn't a missing file.
      server = createServer((socket) => socket.end());
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      probes.port = server.address().port;
      report.isolationProfile = `(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:*"))\n(allow network-bind (local ip "localhost:*"))\n${deniedRoots.map((denied) => `(deny file-read* (subpath ${JSON.stringify(denied)}))`).join("\n")}\n`;
      if (process.platform === "darwin") await writeFile(isolationProfile, report.isolationProfile);
      else {
        report.isolationProfile =
          "Landlock ABI >= 4: deny source subtree filesystem access and all outbound TCP; inherited across exec/children";
        report.isolationLauncherSha256 = sha256(
          await readFile(new URL("./builtin-installed-landlock.py", import.meta.url)),
        );
      }
    }
    report.deniedRoots = deniedRoots;
    report.probeFiles = probes.files;
    const entry = path.join(leaf, "main.cjs");
    report.entry = entry;
    const execute = async (name, profile, check) => {
      if (process.platform === "darwin") {
        await command(
          "/usr/bin/codesign",
          [
            "--force",
            "--sign",
            "-",
            "--timestamp=none",
            "--preserve-metadata=entitlements,requirements,flags",
            path.join(installed, appName),
          ],
          { cwd: directory },
        );
        await command(
          "/usr/bin/codesign",
          ["--verify", "--deep", "--strict", path.join(installed, appName)],
          { cwd: directory },
        );
      }
      assert.equal(
        sha256(await readFile(archive)),
        originalArchive,
        "Copied production archive changed",
      );
      const receipt = { name };
      report.runs.push(receipt);
      try {
        await launchProduct(
          {
            directory,
            executable,
            archive,
            cwd,
            env,
            profile,
            isolationProfile,
            isolated,
            probes,
            deniedRoots,
            singleInstance,
          },
          receipt,
          (client) => check(client, receipt),
        );
      } finally {
        await save();
      }
      assert.equal(
        receipt.forcedCleanup,
        false,
        "Forced cleanup cannot count as graceful acceptance",
      );
      assert.deepEqual(receipt.remainingPids, []);
      for (const fork of receipt.forks.filter(
        (item) => item.serviceName === "Kobrixa plugin kobrixa.motor-test",
      )) {
        assert.equal(fork.entry, entry);
        assert.equal(fork.cwd, leaf);
      }
      for (const fork of receipt.forks.filter((item) => item.entry === entry)) {
        assert.ok(Number.isSafeInteger(fork.pid) && fork.pid > 0);
        assert.equal(fork.exited, true, "Observed original utility process must report exit");
      }
      return receipt;
    };
    const enabled = async (client, value) => {
      const result = await client.renderer.js(
        `window.kobrixa.plugins.setEnabled(${JSON.stringify(motorKey)}, ${value})`,
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.notEqual(result.persisted, false, "Toggle must persist");
      await until(
        async () =>
          (await client.state()).plugins.find((item) => item.id === motorId)?.status ===
          (value ? "enabled" : "disabled"),
        "toggle committed",
      );
    };
    const lazy = async (client, receipt) => {
      const state = await client.state();
      requiredCompilers(state);
      const motor = state.plugins.find((item) => item.id === motorId);
      assert.ok(
        motor &&
          motor.sourceKey === motorKey &&
          motor.runtime === "node" &&
          motor.canToggle &&
          !motor.required,
      );
      assert.equal(motor.status, "enabled");
      assert.equal(motor.running, false);
      assert.equal((await client.forks()).filter((item) => item.entry === entry).length, 0);
      receipt.lazyState = state;
    };
    if (singleInstance) {
      await execute(
        "single-instance",
        await freshProfile(directory, "single-instance-profile"),
        async (client, receipt) => {
          await lazy(client, receipt);
          const snapshot = await openMotor(client, manifest, receipt);
          await observeSingleInstance(
            client,
            {
              directory,
              executable,
              archive,
              cwd,
              env,
              profile: receipt.profile,
              isolationProfile,
              isolated,
              deniedRoots,
            },
            receipt,
            snapshot.binding,
          );
        },
      );
    } else {
      const profile = await freshProfile(directory, "healthy-profile");
      await execute("healthy", profile, async (client, receipt) => {
        await lazy(client, receipt);
        const first = await openMotor(client, manifest, receipt);
        const initial = (await client.forks()).filter((item) => item.entry === entry);
        assert.equal(initial.length, 1);
        await enabled(client, false);
        await until(
          async () => (await client.forks()).find((item) => item.entry === entry)?.exited,
          "disable utility exit",
        );
        await enabled(client, true);
        assert.equal(
          (await client.state()).plugins.find((item) => item.id === motorId).running,
          false,
        );
        const second = await openMotor(client, manifest, receipt);
        const processes = (await client.forks()).filter((item) => item.entry === entry);
        assert.equal(processes.length, 2);
        assert.notEqual(processes[0].pid, processes[1].pid);
        assert.notEqual(first.binding.processEpoch, second.binding.processEpoch);
        receipt.freshProcessIdentity = true;
        await enabled(client, false); // Persist disabled across the following real restart.
        await until(
          async () =>
            (await client.forks())
              .filter((item) => item.entry === entry)
              .every((item) => item.exited),
          "second disable exit",
        );
      });
      await execute("restart", profile, async (client, receipt) => {
        const state = await client.state();
        requiredCompilers(state);
        const motor = state.plugins.find((item) => item.id === motorId);
        assert.equal(motor.status, "disabled");
        assert.equal(motor.disabledBy, "user");
        assert.equal(motor.running, false);
        assert.equal((await client.forks()).filter((item) => item.entry === entry).length, 0);
        receipt.persistedDisable = state;
        await enabled(client, true);
        await lazy(client, receipt);
        await openMotor(client, manifest, receipt); // Quit with an active real utility process.
        assert.equal((await client.forks()).filter((item) => item.entry === entry).length, 1);
      });
      // Only this copied resource is mutated. The archive/main/preload/renderer and
      // original release leaf are never rewritten, rebuilt, or replaced.
      const resource = path.join(leaf, "panel.json"),
        originalResource = await readFile(resource);
      try {
        for (const name of ["missing", "tampered"]) {
          if (name === "missing") await rm(resource);
          else await writeFile(resource, Buffer.concat([originalResource, Buffer.from("\n ")]));
          await execute(
            name,
            await freshProfile(directory, `${name}-profile`),
            async (client, receipt) => {
              const state = await client.state();
              requiredCompilers(state);
              const motor = state.plugins.find((item) => item.id === motorId);
              assert.equal(motor.status, "invalid");
              assert.equal(motor.running, false);
              assert.ok(
                motor.problems.some((problem) => problem.code === "PLUGIN_E_ENTRY"),
                JSON.stringify(motor),
              );
              assert.equal((await client.forks()).filter((item) => item.entry === entry).length, 0);
              const catalog = await client.renderer.js(`(async () => {
            const entries = []; let cursor;
            for (let page = 0; page < 32; page++) {
              const result = await window.kobrixa.plugins.ui.catalog(cursor ? {cursor} : {});
              if (!result.ok) throw Error(JSON.stringify(result));
              entries.push(...result.value.entries);
              cursor = result.value.nextCursor;
              if (cursor === null) return {ok:true, value:{entries}};
            }
            throw Error('Catalog page bound exceeded');
          })()`);
              assert.equal(catalog.ok, true, JSON.stringify(catalog));
              assert.ok(!catalog.value.entries.some((item) => item.pluginId === motorId));
              Object.assign(receipt, {
                phase: "resolve-before-launch",
                launched: false,
                rejected: true,
                state,
                catalog,
                mutatedResource: resource,
              });
            },
          );
        }
      } finally {
        await writeFile(resource, originalResource);
      }
    }
    await verifyLeaf(leaf, motorId);
    const sourceLeaf = path.join(`${sourceArchive}.unpacked`, ".vite/build/plugins/motor-test");
    assert.deepEqual(await verifyLeaf(sourceLeaf, motorId), index);
    report.originalPayloadIntact = true;
    report.sourceRootDenial = isolated
      ? singleInstance
        ? "verified-in-primary; secondary-launch-inherits-isolation-unobserved"
        : "verified-in-all-four-product-processes"
      : "unrun";
    report.noPathNode = env.PATH === emptyPath;
    report.noNodePath = !env.NODE_PATH;
    report.arbitraryCwd = cwd !== root;
    assert.equal(sha256(await readFile(archive)), originalArchive);
    assert.equal(sha256(await readFile(sourceArchive)), originalArchive);
    report.status = singleInstance ? "partial" : "passed";
  } catch (error) {
    report.status = "failed";
    report.error = errorRecord(error);
    failure = error;
  } finally {
    try {
      if (server)
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      if (archive && originalArchive) {
        report.originalAppAsarIntact = sha256(await readFile(sourceArchive)) === originalArchive;
        report.copiedAppAsarIntact = sha256(await readFile(archive)) === originalArchive;
        report.copiedExecutableSha256 = executable ? sha256(await readFile(executable)) : null;
        // codesign may change the copied Mach-O signature. Original binary must remain byte-identical.
        if (report.artifact)
          report.originalExecutableIntact =
            sha256(
              await readFile(
                path.join(
                  report.artifact.source,
                  path.relative(path.join(directory, "installed"), executable),
                ),
              ),
            ) === originalExecutable;
      }
    } catch (error) {
      report.finalizationError = errorRecord(error);
      report.status = "failed";
      failure ??= error;
    }
    await save();
    console.log(`Real installed product receipt: ${output}`);
  }
  if (failure) throw failure;
  try {
    if (singleInstance) {
      assertSingleInstanceReceipt(report);
      const secondary = report.runs[0].singleInstance.secondary;
      assert.equal(sha256(await readFile(secondary.log)), secondary.logSha256);
    }
    const result = await command(
      process.execPath,
      [
        "--test",
        path.join(
          root,
          singleInstance
            ? "tests/desktop/plugin-persistence-installed.test.mjs"
            : "tests/desktop/builtin-process-packaging.test.mjs",
        ),
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          ...(singleInstance
            ? { KOBRIXA_SINGLE_INSTANCE_REPORT: output }
            : { KOBRIXA_BUILTIN_REPORT: output }),
        },
      },
    );
    report.receiptValidation = { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
    await save();
    console.log(result.stdout);
  } catch (error) {
    report.status = "failed";
    report.receiptValidation = errorRecord(error);
    await save();
    throw error;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main();
