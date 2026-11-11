import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
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
  observeBeforeStartup,
  releaseStartingWorkers,
  terminateProcess,
  until,
  waitForRendererTarget,
} from "./builtin-installed-client.mjs";

import { copyDesktopBundle, verifyMacBundle } from "../../tools/release/macos-test-bundle.mjs";

export function openInstalledArchive(
  archive,
  { hostPath = path, stat = statFile, extract = extractFile } = {},
) {
  // ASAR traversal splits on the host separator, while manifest/main entries
  // and our receipt inventory use forward slashes. Normalize only at lookup.
  return {
    stat: (member) => stat(archive, hostPath.normalize(member)),
    extract: (member) => extract(archive, hostPath.normalize(member)),
  };
}

export function installedLayout(platform, names) {
  assert.ok(["darwin", "linux", "win32"].includes(platform), "Unsupported installed platform");
  const apps = names.filter((name) => name.endsWith(".app"));
  if (platform === "darwin") assert.equal(apps.length, 1, "Expected exactly one packaged app");
  const appName = platform === "darwin" ? apps[0] : null;
  return {
    appName,
    resourceRelative: appName ? `${appName}/Contents/Resources` : "resources",
    executableRelative: appName
      ? `${appName}/Contents/MacOS/kobrixa`
      : platform === "win32"
        ? "kobrixa.exe"
        : "kobrixa",
  };
}

export function installedEnvironment(original, emptyPath) {
  const env = { ...original };
  for (const key of Object.keys(env))
    if (
      ["PATH", "NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "PYTHONPATH"].includes(
        key.toUpperCase(),
      )
    )
      delete env[key];
  return { ...env, PATH: emptyPath };
}

export function installedPlatformPolicy(platform, requestedIsolation) {
  const blockers =
    platform === "win32"
      ? [
          {
            id: "W02b",
            status: "blocked-by-W02b",
            checks: ["motion admission", "Run admission"],
            reason:
              "3A safety journal fails closed with ENOTSUP until the native Windows adapter is integrated; no admission pass is claimed",
          },
        ]
      : [];
  if (platform === "win32" && requestedIsolation)
    blockers.push({
      id: "W17-isolation",
      status: "blocked",
      checks: ["source and dependency read denial", "outbound network denial"],
      reason:
        "Windows source/network isolation adapter is not implemented; copied-app observations run without claiming isolation",
    });
  return { isolated: requestedIsolation && platform !== "win32", blockers };
}

export function installedLaunchCommand(config, args, platform = process.platform) {
  if (!config.isolated) return { file: config.executable, args };
  assert.ok(["darwin", "linux"].includes(platform), "Windows isolation adapter is not implemented");
  if (platform === "darwin")
    return {
      file: "/usr/bin/sandbox-exec",
      args: ["-f", config.isolationProfile, config.executable, ...args],
    };
  return {
    file: "/usr/bin/python3",
    args: [
      fileURLToPath(new URL("./builtin-installed-landlock.py", import.meta.url)),
      ...config.deniedRoots,
      "--",
      config.executable,
      ...args,
    ],
  };
}

// Continue independent Windows cases, retaining every failure for a non-zero
// final result. A blocked prerequisite never converts an assertion into success.
export async function observeInstalledCase(observe, platform, failures) {
  try {
    return await observe();
  } catch (error) {
    if (platform !== "win32") throw error;
    failures.push(error);
  }
}

// Installed before the original entry executes. Only observe original calls;
// synchronous exit output survives app.quit() and inspector detachment.
export function installSecondaryObservation(require, process, emit) {
  const electron = require("electron");
  if (electron.app.isReady()) throw Error("Secondary observer installed after readiness");
  const evidence = {
    pid: process.pid,
    beforeReady: true,
    workers: [],
    utilities: [],
    children: [],
    writes: [],
    locks: [],
  };
  const wrap = (target, key, rows, describe = (args) => args.map((value) => String(value))) => {
    const original = target[key];
    if (typeof original !== "function") throw Error(`Missing observation API: ${key}`);
    target[key] = new Proxy(original, {
      apply(fn, receiver, args) {
        const detail = describe(args);
        if (detail !== null) rows.push({ api: key, arguments: detail });
        return Reflect.apply(fn, receiver, args);
      },
      construct(fn, args, newTarget) {
        rows.push({ api: key, arguments: describe(args) });
        return Reflect.construct(fn, args, newTarget === target[key] ? fn : newTarget);
      },
    });
    if (target[key] === original) throw Error(`Cannot observe ${key}`);
  };
  wrap(require("node:worker_threads"), "Worker", evidence.workers);
  wrap(electron.utilityProcess, "fork", evidence.utilities);
  const children = require("node:child_process");
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
    wrap(children, key, evidence.children);
  const fs = require("node:fs");
  const mutators = [
    "writeFile",
    "appendFile",
    "truncate",
    "rename",
    "unlink",
    "rm",
    "rmdir",
    "mkdir",
    "copyFile",
    "cp",
    "link",
    "symlink",
    "chmod",
    "chown",
    "utimes",
    "mkdtemp",
  ];
  for (const key of mutators) {
    wrap(fs, key, evidence.writes);
    wrap(fs, key + "Sync", evidence.writes);
    wrap(fs.promises, key, evidence.writes);
  }
  for (const key of ["open", "openSync"])
    wrap(fs, key, evidence.writes, (args) => {
      const flags = args[1] ?? "r";
      const writable =
        typeof flags === "number"
          ? Boolean(
              flags &
              (fs.constants.O_WRONLY |
                fs.constants.O_RDWR |
                fs.constants.O_CREAT |
                fs.constants.O_TRUNC |
                fs.constants.O_APPEND),
            )
          : flags !== "r" && flags !== "rs";
      return writable ? [String(args[0]), flags] : null;
    });
  wrap(fs.promises, "open", evidence.writes, (args) => {
    const flags = args[1] ?? "r";
    const writable =
      typeof flags === "number"
        ? Boolean(
            flags &
            (fs.constants.O_WRONLY |
              fs.constants.O_RDWR |
              fs.constants.O_CREAT |
              fs.constants.O_TRUNC |
              fs.constants.O_APPEND),
          )
        : flags !== "r" && flags !== "rs";
    return writable ? [String(args[0]), flags] : null;
  });
  wrap(fs, "createWriteStream", evidence.writes);
  for (const key of ["write", "writeSync", "writev", "writevSync", "ftruncate", "ftruncateSync"])
    wrap(fs, key, evidence.writes, (args) => ([1, 2].includes(args[0]) ? null : [String(args[0])]));
  const originalLock = electron.app.requestSingleInstanceLock;
  electron.app.requestSingleInstanceLock = function (...args) {
    const acquired = Reflect.apply(originalLock, this, args);
    evidence.locks.push({ acquired });
    return acquired;
  };
  require("node:module").syncBuiltinESMExports();
  emit({ phase: "installed", pid: process.pid, beforeReady: true });
  process.once("exit", (code) => emit({ phase: "exit", code, ...evidence }));
  return true;
}

export function collectSecondaryObservation(output) {
  const rows = output
    .split("\n")
    .filter((line) => line.startsWith("KOBRIXA_SECONDARY "))
    .map((line) => JSON.parse(line.slice("KOBRIXA_SECONDARY ".length)));
  assert.equal(rows.length, 2, "Secondary observation must include installation and exit");
  assert.equal(rows[0].phase, "installed");
  assert.equal(rows[1].phase, "exit");
  assert.equal(rows[0].pid, rows[1].pid);
  assert.equal(rows[0].beforeReady, true);
  return rows[1];
}

export function assertSecondaryObservation(secondary) {
  const observed = secondary.observation;
  assert.equal(secondary.startup.pid, secondary.pid);
  assert.equal(secondary.startup.ready, false);
  assert.ok(secondary.observedIdentities.some((row) => row.pid === secondary.pid && row.created));
  assert.equal(observed.pid, secondary.pid);
  assert.equal(observed.beforeReady, true);
  assert.equal(observed.code, 0);
  assert.deepEqual(observed.locks, [{ acquired: false }]);
  for (const key of ["workers", "utilities", "children", "writes"])
    assert.deepEqual(
      observed[key],
      [],
      `Secondary ${key} must remain absent from entry through exit`,
    );
}

export async function observeSecondaryStartup(
  client,
  pid,
  executable,
  known,
  table = processTable,
) {
  let startup;
  await observeBeforeStartup(client, async (evaluate) => {
    startup = await evaluate(
      "({pid:process.pid, executable:process.execPath, ready:require('electron').app.isReady()})",
    );
    assert.equal(startup.pid, pid);
    assert.equal(startup.executable, executable);
    assert.equal(startup.ready, false);
    assert.equal(
      await evaluate(`(() => {
      const write = require('node:fs').writeSync;
      return (${installSecondaryObservation.toString()})(require, process,
        row => write(2, '\\nKOBRIXA_SECONDARY ' + JSON.stringify(row) + '\\n'));
    })()`),
      true,
    );
    descendants(await table(), pid, known);
    assert.ok(known.get(pid), "Secondary creation identity must be observed before resume");
  });
  return startup;
}

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
  ...(error instanceof AggregateError ? { errors: error.errors.map(errorRecord) } : {}),
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
export const installProbe = `((require) => {
  if (typeof require !== 'function') throw Error('Paused entry module require unavailable');
  const electron = require('electron');
  if (!electron.utilityProcess?.fork || !electron.app) throw Error('Main Electron probe unavailable');
  if (electron.app.isReady()) throw Error('Observe startup before application readiness');
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
})(require)`;

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
  const { directory, cwd, env, profile, isolated, probes } = config;
  const clients = [];
  const known = new Map();
  let child,
    exit,
    closed,
    main,
    renderer,
    workerStartup,
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
  receipt.workerInspector = {};
  receipt.rendererTargetWait = {};
  const sample = async () => {
    if (!child?.pid) return [];
    const rows = descendants(await processTable(), child.pid, known);
    receipt.observedProcesses ??= [];
    for (const row of rows)
      if (
        !receipt.observedProcesses.some(
          (prior) => prior.pid === row.pid && prior.created === row.created,
        )
      )
        receipt.observedProcesses.push(row);
    return rows;
  };
  try {
    const launch = installedLaunchCommand(config, [
      "--inspect-brk=127.0.0.1:0",
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
    ]);
    child = spawn(launch.file, launch.args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const startupDiagnostics = () => ({
      exit: receipt.exit,
      workerInspector: receipt.workerInspector,
      workerTimeline: collectWorkerTimeline(output),
      outputTail: output.slice(-16_384),
    });
    const checkAlive = () => {
      if (launchError) throw launchError;
      if (monitorError) throw monitorError;
      workerStartup?.check();
      assert.equal(ended, false, `Product exited before evidence: ${JSON.stringify(receipt.exit)}`);
      assert.ok(
        !output.includes("Primary startup failed."),
        "Product reported Primary startup failed",
      );
    };
    const alive = (read) =>
      until(
        async () => {
          checkAlive();
          return read();
        },
        "product debug readiness",
        30_000,
        startupDiagnostics,
      );
    const mainUrl = await alive(() => output.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1]);
    main = await connect(mainUrl);
    clients.push(main);
    workerStartup = await releaseStartingWorkers(main, receipt.workerInspector);
    await observeBeforeStartup(main, async (evaluate) => {
      assert.equal(await evaluate(installProbe), true);
      receipt.originalForkObserved = true;
      receipt.probeBeforeReady = await evaluate("!__installedProbe.electron.app.isReady()");
      assert.equal(receipt.probeBeforeReady, true, "Observe startup before application readiness");
    });
    const browserUrl = await alive(
      () => output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1],
    );
    const target = await waitForRendererTarget(browserUrl, {
      evidence: receipt.rendererTargetWait,
      check: checkAlive,
      diagnostics: startupDiagnostics,
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
    assert.equal(receipt.identity.executable, config.executable);
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
    if (process.platform === "win32") {
      receipt.deviceRecovery = await renderer.js("window.kobrixa.plugins.recovery.snapshot({})");
      // Keep the actual public recovery result beside the source-based W02b
      // prerequisite. Do not synthesize ENOTSUP as an observed product error.
    }
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
    await workerStartup.settled();
    // Dispatch quit synchronously and let the official shutdown coordination run.
    await main.js("setTimeout(() => __installedProbe.electron.app.quit(), 0); true");
    workerStartup.dispose();
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
    workerStartup?.dispose();
    for (const client of clients) client.close();
    try {
      if (!ended && child?.pid) {
        receipt.forcedCleanup = true;
        const signalingErrors = [];
        await terminateProcess(-child.pid, "SIGTERM", signalingErrors, { known });
        cleanupErrors.push(...signalingErrors.map(errorRecord));
        try {
          await until(() => ended, "termination", 3000);
        } catch {
          /* Escalate below. */
        }
      }
      // On POSIX keep utility PIDs even when reparented between samples. Windows
      // requires the creation identity captured by the OS observer.
      if (process.platform !== "win32")
        for (const fork of receipt.forks)
          if (Number.isSafeInteger(fork.pid)) known.set(fork.pid, undefined);
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
        const errors = [];
        await terminateProcess(-child.pid, "SIGKILL", errors, { known });
        // Account for observed descendants which changed process group/reparented.
        for (const { pid } of remaining) await terminateProcess(pid, "SIGKILL", errors, { known });
        cleanupErrors.push(...errors.map(errorRecord));
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
    receipt.observedPids = [...known.keys()];
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

// Recording remains an explicit gate until the original primary is observed recording.
export const SINGLE_INSTANCE_UNRUN = Object.freeze(["primaryRecordingInterrupted"]);
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
  assertSecondaryObservation(secondary);
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
    secondaryInspector,
    ended = false,
    failure;
  const known = new Map();
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
    secondary.argv = [
      "--inspect-brk=127.0.0.1:0",
      `--user-data-dir=${config.profile}`,
      secondary.marker,
    ];
    const launch = installedLaunchCommand(config, secondary.argv);
    child = spawn(launch.file, launch.args, {
      cwd: config.cwd,
      env: config.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    {
      // A short-lived secondary can exit between CIM samples. Hold its actual
      // entry until the OS creation identity has been recorded, then resume it.
      const url = await until(() => {
        if (launchError) throw launchError;
        assert.equal(ended, false, "Secondary exited before startup observation");
        return output.match(/Debugger listening on (ws:\/\/[^\s]+)/)?.[1];
      }, "secondary inspector readiness");
      secondaryInspector = await connect(url);
      secondary.startup = await observeSecondaryStartup(
        secondaryInspector,
        child.pid,
        config.executable,
        known,
      );
      secondaryInspector.close();
    }
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
    secondaryInspector?.close();
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
        await terminateProcess(-child.pid, "SIGTERM", errors, { known });
      }
      try {
        await until(() => ended, "secondary reap", 3000);
        await pause(Math.max(0, secondary.exit.at + 5000 - Date.now()));
        let remaining = descendants(await processTable(), child.pid, known);
        if (remaining.length) {
          secondary.forcedCleanup = true;
          await terminateProcess(-child.pid, "SIGKILL", errors, { known });
          for (const row of remaining)
            await terminateProcess(row.pid, "SIGKILL", errors, { known });
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
        await terminateProcess(-child.pid, "SIGKILL", errors, { known });
        for (const row of descendants(await processTable(), child.pid, known))
          await terminateProcess(row.pid, "SIGKILL", errors, { known });
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
    secondary.observedPids = [...known.keys()];
    secondary.observedIdentities = [...known].map(([pid, created]) => ({ pid, created }));
    secondary.log = path.join(config.directory, "single-instance-secondary.log");
    await writeFile(secondary.log, output);
    secondary.logSha256 = sha256(output);
    try {
      secondary.observation = collectSecondaryObservation(output);
      assertSecondaryObservation(secondary);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      secondary.cleanupErrors = errors.map(errorRecord);
      failure ??= new AggregateError(errors, "Secondary cleanup failed");
    }
  }
  if (failure) throw failure;
}

// Runs in the renderer; use only public preload evidence and the selected DOM.
export async function observeMotorPanel(selection) {
  const tab = document.getElementById(selection.tabId);
  const pane = document.getElementById(selection.panelId);
  const selected =
    tab?.getAttribute("aria-selected") === "true" &&
    tab.getAttribute("aria-controls") === selection.panelId &&
    pane?.getAttribute("aria-labelledby") === selection.tabId;
  const events = globalThis.__installedUiEvents.filter(
    (event) =>
      event.binding?.kind === "panel" && event.binding.contributionId === selection.entry.id,
  );
  const event = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "state" &&
        event.binding.uiResourceGeneration === selection.entry.uiResourceGeneration,
    );
  const result = event
    ? await window.kobrixa.plugins.ui.snapshot({ binding: event.binding })
    : null;
  const snapshot = result?.ok ? result.value : null;
  const bindingMatches =
    snapshot &&
    Object.keys(event.binding).every((key) => snapshot.binding[key] === event.binding[key]);
  const summary = selected && pane.querySelector('.plugin-ui [data-ui-node="summary"]');
  // Rendered controls carry the host-issued panelInstance in their IDs.
  const boundDom =
    bindingMatches &&
    selected &&
    [...pane.querySelectorAll(".plugin-ui [id]")].some((node) =>
      node.id.startsWith(`ui-${snapshot.binding.panelInstance}-`),
    );
  const alerts = selected ? [...pane.querySelectorAll('[role="alert"]')] : [];
  const checks = {
    resourceAvailable: selection.entry.availability === "available",
    selected: Boolean(selected),
    // Panel-content alerts (including no connected device) are valid product UI.
    noHostAlerts: !alerts.some((node) => !node.closest(".plugin-ui")),
    snapshotPresent: Boolean(snapshot),
    bindingMatches: Boolean(bindingMatches),
    boundDom: Boolean(boundDom),
    // bootstrap.environment gates snapshot.visible on window focus as well as
    // selection. It is interaction eligibility, not proof of a rendered panel.
    summaryRendered: Boolean(
      summary && !summary.closest("[hidden]") && summary.getClientRects().length,
    ),
    summaryPresent: Boolean(snapshot?.data.summary),
    // The motor summary is a data ref: displayText does not translate it.
    summaryMatches: Boolean(snapshot && summary?.textContent === snapshot.data.summary),
  };
  return {
    selected: Boolean(selected),
    open: Boolean(selected && pane.querySelector(":scope > button:not([data-close-contribution])")),
    alerts: alerts.map((node) => node.textContent),
    text: selected ? pane.textContent : null,
    events,
    result,
    snapshot,
    checks,
    snapshotVisible: Boolean(snapshot?.visible),
    documentVisible: document.visibilityState === "visible",
    documentFocused: document.hasFocus(),
    summaryText: summary?.textContent ?? null,
    ready: Object.values(checks).every(Boolean),
  };
}

async function openMotor(client, manifest, receipt) {
  const { renderer, state } = client;
  await renderer.js(`(() => {
    globalThis.__installedUiEvents = [];
    globalThis.__installedUiOff = window.kobrixa.plugins.ui.onEvent(event => {
      __installedUiEvents.push(event);
      if (__installedUiEvents.length > 256) __installedUiEvents.shift();
    });
    const toggle = document.querySelector('.plugin-tools-toggle');
    if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click();
    return true;
  })()`);
  const panel = manifest.contributes.panels[0];
  const selection = await renderer.js(`(async () => {
    const entries = [];
    let cursor;
    do {
      const result = await window.kobrixa.plugins.ui.catalog(cursor ? {cursor} : {});
      if (!result.ok) throw Error(JSON.stringify(result));
      entries.push(...result.value.entries);
      cursor = result.value.nextCursor;
    } while (cursor);
    const panels = entries.filter(e => e.kind === 'panel').sort((a,b) => {
      const left = a.pluginId + '\\0' + a.id, right = b.pluginId + '\\0' + b.id;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const index = panels.findIndex(e => e.pluginId === ${JSON.stringify(motorId)} && e.id === ${JSON.stringify(panel.id)});
    if (index < 0) throw Error('Motor contribution missing: ' + JSON.stringify(entries));
    return { entry: panels[index], tabId: 'plugin-tab-' + index, panelId: 'plugin-panel-' + index };
  })()`);
  await until(
    () =>
      renderer.js(`(() => {
    const tab = document.getElementById(${JSON.stringify(selection.tabId)});
    if (!tab) return false;
    tab.click(); return true;
  })()`),
    "real motor tab",
  );
  let observation;
  let requestedOpen = false;
  const snapshot = await until(
    async () => {
      observation = await renderer.js(
        `(${observeMotorPanel.toString()})(${JSON.stringify(selection)})`,
      );
      if (observation.selected && observation.open && !requestedOpen) {
        // Selection commits asynchronously; never click the previous panel's Open.
        requestedOpen = true;
        await renderer.js(`(() => {
        const tab = document.getElementById(${JSON.stringify(selection.tabId)});
        const pane = document.getElementById(${JSON.stringify(selection.panelId)});
        if (tab?.getAttribute('aria-selected') !== 'true') throw Error('Motor selection changed');
        pane?.querySelector(':scope > button:not([data-close-contribution])')?.click();
      })()`);
      }
      return observation.ready && observation.snapshot;
    },
    "real motor panel rendered",
    15_000,
    async () => ({
      selection,
      observation,
      plugins: await state(),
      resources: await renderer.js(`(async () => {
      const entry = ${JSON.stringify(selection.entry)};
      const catalog = await window.kobrixa.plugins.ui.catalog({});
      const resource = await window.kobrixa.plugins.ui.resource({sourceKey: entry.sourceKey,
        id: entry.id, uiResourceGeneration: entry.uiResourceGeneration, resourceDigest: entry.resourceDigest});
      return {catalog, resource: resource.ok ? {ok: true} : resource};
    })()`),
    }),
  );
  assert.equal(snapshot.data.available, false);
  assert.equal(snapshot.data["can-start"], false);
  assert.match(snapshot.data.summary, /Unavailable|無法使用/);
  receipt.snapshots ??= [];
  receipt.snapshots.push(snapshot);
  const dom = await renderer.js(`(() => ({
    summary: document.getElementById(${JSON.stringify(selection.panelId)}).querySelector('[data-ui-node="summary"]').textContent,
    actions: [...document.getElementById(${JSON.stringify(selection.panelId)}).querySelectorAll('[data-ui-node]')]
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
  const requestedIsolation = process.argv.includes("--isolated");
  const { isolated, blockers } = installedPlatformPolicy(process.platform, requestedIsolation);
  const singleInstance = process.argv.includes("--single-instance");
  assert.ok(
    !singleInstance || requestedIsolation,
    "Single-instance partial evidence requires --isolated",
  );
  assert.ok(
    ["darwin", "linux", "win32"].includes(process.platform),
    "Unsupported installed platform",
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
    requestedIsolation,
    isolated,
    blockers,
    sourceRootDenial: "unrun",
    ...(isolated && process.platform === "linux" ? { externalAddresses } : {}),
    limitations: [
      "Physical EV3 USB/Wi-Fi and motion parity UNRUN",
      "Clean-machine installation, other platforms, locale/theme/layout/keyboard acceptance UNRUN",
      "Stage 3 completion is not asserted",
    ],
  };
  for (const blocker of blockers)
    console.error(`${blocker.status}: ${blocker.checks.join(", ")}: ${blocker.reason}`);
  const runFailures = [];
  let server, archive, originalArchive, sourceArchive, originalExecutable, executable, failure;
  const save = () => writeFile(output, JSON.stringify(report, null, 2));
  try {
    const source = path.join(root, `apps/desktop/out/Kobrixa-${process.platform}-${process.arch}`);
    const installed = path.join(directory, "installed");
    const { appName, resourceRelative, executableRelative } = installedLayout(
      process.platform,
      await readdir(source),
    );
    if (appName) await verifyMacBundle(path.join(source, appName));
    await copyDesktopBundle(source, installed, process.platform);
    if (appName) await verifyMacBundle(path.join(installed, appName));
    const resources = path.join(installed, resourceRelative);
    executable = path.join(installed, executableRelative);
    archive = path.join(resources, "app.asar");
    const installedArchive = openInstalledArchive(archive);
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
      assert.equal(installedArchive.stat(`.vite/build/plugins/motor-test/${name}`).unpacked, true);
    const packageJson = JSON.parse(installedArchive.extract("package.json").toString("utf8"));
    assert.equal(packageJson.name, "@kobrixa/desktop");
    assert.equal(packageJson.main, ".vite/build/main.cjs");
    const entries = (await import("@electron/asar"))
      .listPackage(archive)
      .map((name) => name.replaceAll("\\", "/").replace(/^\//, ""));
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
      commit: (
        await command(
          process.platform === "win32" ? "git.exe" : "/usr/bin/git",
          ["rev-parse", "HEAD"],
          { cwd: root },
        )
      ).stdout.trim(),
      dirty: Boolean(
        (
          await command(
            process.platform === "win32" ? "git.exe" : "/usr/bin/git",
            ["status", "--porcelain"],
            { cwd: root },
          )
        ).stdout.trim(),
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
        [packageJson.main, ...shipped].map((name) => [
          name,
          sha256(installedArchive.extract(name)),
        ]),
      ),
      payloadIndexSha256: sha256(await readFile(path.join(leaf, "resource-index.json"))),
      releasePayloadIndex: index,
      manifest,
    };
    const cwd = path.join(directory, "unrelated-cwd"),
      emptyPath = path.join(directory, "empty-path");
    await mkdir(cwd);
    await mkdir(emptyPath);
    const env = installedEnvironment(process.env, emptyPath);
    const common = (
      await command(
        process.platform === "win32" ? "git.exe" : "/usr/bin/git",
        ["rev-parse", "--git-common-dir"],
        { cwd: root },
      )
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
      assert.ok(
        !directory.startsWith(`${denied}${path.sep}`),
        "Sandbox must allow only the copied artifact",
      );
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
    const executeOne = async (name, profile, check) => {
      if (process.platform === "darwin") {
        // Only the resource-negative copies need resealing. Nested code was
        // already signed and verified during packaging and after the copy.
        if (["missing", "tampered"].includes(name))
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
    const execute = (name, profile, check) =>
      observeInstalledCase(
        async () => {
          try {
            return await executeOne(name, profile, check);
          } catch (error) {
            const receipt = report.runs.find((run) => run.name === name);
            if (receipt) receipt.error ??= errorRecord(error);
            await save();
            throw error;
          }
        },
        process.platform,
        runFailures,
      );
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
    if (runFailures.length)
      throw new AggregateError(
        runFailures,
        "Installed Windows observations failed; see individual run errors",
      );
    report.status = blockers.length ? "blocked" : singleInstance ? "partial" : "passed";
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
  if (blockers.length)
    throw new Error(
      blockers
        .map((blocker) => `${blocker.status}: ${blocker.id}: ${blocker.checks.join(", ")}`)
        .join("; "),
    );
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
  await main().catch((error) => {
    console.error(`Installed product run failed: ${error.message}`);
    process.exitCode = 1;
  });
