import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { processTable, descendants } from "./builtin-installed-client.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const ownerId = "acceptance.device-stdio";
export function documents(role) {
  assert.ok(["owner", "denied"].includes(role));
  const manifest = JSON.parse(
    readFileSync(
      new URL("./fixtures/device-ui-public/kobrixa-plugin.json", import.meta.url),
      "utf8",
    ),
  );
  if (role === "denied") {
    manifest.id += "-denied";
    manifest.permissions = ["settings.read"];
    delete manifest.requires;
    manifest.activationEvents = ["onCommand:" + manifest.id + ".run"];
    manifest.contributes.commands = [
      { id: manifest.id + ".run", title: { en: "Run denied checks" } },
    ];
    delete manifest.contributes.panels;
  }
  return {
    manifest,
    settings: {
      schemaVersion: 1,
      title: { en: "Synthetic acceptance preferences" },
      fields: [{ key: "enabled", type: "boolean", default: false, label: { en: "Enabled" } }],
    },
    panel: {
      kind: "panel",
      formSync: true,
      root: "root",
      presentationKey: "presentation",
      datasets: {
        rows: { kind: "table", columns: [{ id: "name", label: { en: "Name" }, value: "string" }] },
      },
      fields: {},
      data: {
        presentation: {
          schema: {
            type: "number",
            min: 0,
            max: Number.MAX_SAFE_INTEGER,
            integer: true,
            nullable: false,
          },
          initial: 0,
        },
      },
      nodes: [
        { id: "root", type: "group", layout: "stack", children: ["rows"] },
        {
          id: "rows",
          type: "table",
          dataset: "rows",
          label: { en: "Synthetic candidate and mode" },
        },
      ],
    },
  };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Independently correlate original owner + direction + ID, never accept consumer success notes as operation proof. */
export function verifyDeviceStdio(r) {
  assert.equal(r.claim, "synthetic-device-python-stdio");
  assert.equal(r.stage, "complete");
  assert.deepEqual(r.failures, []);
  assert.equal(r.launches.length, 2);
  assert.equal(r.exits.length, 2);
  const owners = {};
  for (const role of ["owner", "denied"]) {
    const launch = r.launches.find((x) => x.role === role);
    assert.ok(launch);
    const id = ownerId + (role === "denied" ? "-denied" : "");
    assert.equal(launch.owner.pluginId, id);
    assert.match(launch.owner.sourceKey, /^dev:[0-9a-f]{16}$/);
    for (const key of ["hostEpoch", "processEpoch"]) assert.ok(launch.owner[key]);
    assert.ok(Number.isSafeInteger(launch.pid) && launch.pid > 0);
    assert.ok(Number.isSafeInteger(launch.owner.generation) && launch.owner.generation >= 0);
    assert.equal(launch.parentPid, r.checkpoints.processes.parentPid);
    assert.ok(
      r.checkpoints.processes.rows.some((x) => x.pid === launch.pid && x.ppid === launch.parentPid),
    );
    const exits = r.exits.filter((x) => same(x.owner, launch.owner));
    assert.equal(exits.length, 1);
    assert.equal(exits[0].exit.code, 0);
    assert.ok(!exits[0].exit.reason);
    owners[role] = launch.owner;
  }
  assert.notEqual(r.launches[0].pid, r.launches[1].pid);
  let sequence = 0;
  for (const w of r.wire) {
    assert.ok(w.sequence > sequence);
    sequence = w.sequence;
    assert.ok(Object.values(owners).some((o) => same(o, w.owner)));
  }
  const pairs = (role, method, direction = "plugin-host") =>
    r.wire
      .filter(
        (w) =>
          same(w.owner, owners[role]) && w.direction === direction && w.message.method === method,
      )
      .map((q) => {
        const replies = r.wire.filter(
          (w) =>
            same(w.owner, q.owner) &&
            w.direction !== q.direction &&
            w.sequence > q.sequence &&
            !w.message.method &&
            w.message.id === q.message.id,
        );
        assert.equal(replies.length, 1, `Missing/duplicate ${role} ${method} response`);
        return {
          q,
          s: replies[0],
          result: replies[0].message.result,
          error: replies[0].message.error,
        };
      });
  // Every response must have exactly one earlier request on this original channel,
  // including initialize, shutdown and SDK negotiation outside the assertions below.
  for (const response of r.wire.filter((w) => !w.message.method && w.message.id !== undefined)) {
    const requests = r.wire.filter(
      (w) =>
        w.message.method &&
        w.message.id === response.message.id &&
        w.direction !== response.direction &&
        same(w.owner, response.owner) &&
        w.sequence < response.sequence,
    );
    assert.equal(requests.length, 1, "Uncorrelated RPC response");
  }
  for (const role of ["owner", "denied"])
    for (const direction of ["plugin-host", "host-plugin"])
      for (const method of new Set(
        r.wire
          .filter(
            (w) =>
              same(w.owner, owners[role]) &&
              w.direction === direction &&
              w.message.id !== undefined &&
              w.message.method,
          )
          .map((w) => w.message.method),
      ))
        pairs(role, method, direction);
  const ok = (p) => {
    assert.ok(p);
    assert.equal(p.result?.ok, true, JSON.stringify(p));
    return p.result.value;
  };
  const good = (role, method) => pairs(role, method).filter((p) => p.result?.ok === true);
  const denied = (role, method, code) => {
    const p = pairs(role, method).find(
      (p) => p.result?.ok === false && p.result.error.code === code,
    );
    assert.ok(p, `${method} must reject ${code}`);
    return p;
  };
  for (const role of ["owner", "denied"]) {
    const init = pairs(role, "initialize", "host-plugin");
    assert.equal(init.length, 1);
    assert.equal(init[0].result.apiVersion, "1.8.0");
  }
  const negotiation = pairs("owner", "ui/negotiate", "host-plugin");
  assert.ok(ok(negotiation[0]).uiResourceVersions.includes(2));
  const candidates = ok(good("owner", "devices/discover")[0]).candidates;
  assert.ok(candidates.length);
  const connect = good("owner", "devices/connect");
  assert.equal(connect.length, 1);
  assert.deepEqual(connect[0].q.message.params.target, {
    kind: "candidate",
    candidateId: candidates[0].candidateId,
  });
  const session = ok(connect[0]).session;
  assert.equal(session.state, "connected");
  const source = ok(good("owner", "devices/session")[0]).sources;
  assert.equal(source.sessionId, session.sessionId);
  const read = good("owner", "devices/read")[0];
  assert.equal(read.q.message.params.sessionId, session.sessionId);
  assert.deepEqual(read.q.message.params.channelIds, [source.channels[0].channelId]);
  assert.equal(ok(read).status, "fresh");
  assert.equal(ok(read).frame.values[0].value, 42);
  const modesPair = good("owner", "devices/inputModes/query")[0],
    modes = ok(modesPair);
  assert.equal(modesPair.q.message.params.expectedSourceRevision, source.sourceRevision);
  assert.equal(modes.portId, source.channels[0].portId);
  assert.equal(modes.modes[0].name, "Reflect");
  const stale = denied("owner", "devices/inputModes/query", "PLUGIN_E_STALE_RESOURCE");
  assert.equal(stale.q.message.params.expectedSourceRevision, source.sourceRevision + 1);
  denied("owner", "devices/session", "PLUGIN_E_STALE_RESOURCE");
  const context = ok(good("owner", "devices/context")[0]);
  const modeWrite = good("owner", "devices/inputModes/set")[0];
  assert.deepEqual(modeWrite.q.message.params, {
    sessionId: session.sessionId,
    portId: modes.portId,
    expectedSourceRevision: source.sourceRevision,
    modeId: modes.modes[0].modeId,
    contextRef: context.contextRef,
  });
  assert.equal(ok(modeWrite).sources.sourceRevision, source.sourceRevision + 1);
  assert.equal(ok(modeWrite).sources.sessionId, session.sessionId);
  assert.ok(r.checkpoints.providerTrace.some((t) => t.step === "mode-write"));

  denied("denied", "devices/connect", "PLUGIN_E_PERMISSION_DENIED");
  denied("denied", "settings/update", "PLUGIN_E_PERMISSION_DENIED");
  const initial = ok(good("owner", "settings/read")[0]);
  assert.equal(initial.revision, null);
  assert.deepEqual(initial.values, [{ key: "enabled", value: false }]);
  const watch = ok(good("owner", "settings/watch")[0]);
  assert.deepEqual(watch.snapshot, initial);
  const updates = good("owner", "settings/update");
  assert.equal(updates.length, 2);
  const update = ok(updates[0]),
    resetPair = good("owner", "settings/reset")[0],
    reset = ok(resetPair),
    final = ok(updates[1]);
  assert.equal(updates[0].q.message.params.expectedRevision, null);
  assert.deepEqual(update.snapshot.values, [{ key: "enabled", value: true }]);
  const conflict = denied("owner", "settings/update", "PLUGIN_E_SETTINGS_CONFLICT");
  assert.equal(conflict.q.message.params.expectedRevision, null);
  assert.ok(conflict.q.sequence > updates[0].s.sequence);
  assert.equal(resetPair.q.message.params.expectedRevision, update.snapshot.revision);
  assert.deepEqual(resetPair.q.message.params.keys, ["enabled"]);
  assert.deepEqual(reset.snapshot.values, initial.values);
  assert.equal(updates[1].q.message.params.expectedRevision, reset.snapshot.revision);
  assert.deepEqual(final.snapshot.values, update.snapshot.values);
  assert.equal(
    new Set([update.snapshot.revision, reset.snapshot.revision, final.snapshot.revision]).size,
    3,
  );
  for (const mutation of [update, reset, final]) {
    assert.ok(mutation.receipt.commitId);
    assert.equal(mutation.receipt.revision, mutation.snapshot.revision);
    assert.ok(["file-and-directory-sync", "file-sync-only"].includes(mutation.receipt.durability));
  }
  assert.deepEqual(ok(good("owner", "settings/read").at(-1)), final.snapshot);
  const unsub = good("owner", "events/unsubscribe").find(
    (p) => p.q.message.params.subscriptionId === watch.subscriptionId,
  );
  assert.equal(ok(unsub).removed, true);
  assert.ok(updates[1].q.sequence > unsub.s.sequence);
  const events = r.wire.filter(
    (w) =>
      same(w.owner, owners.owner) &&
      w.direction === "host-plugin" &&
      w.message.method === "events/deliver" &&
      w.message.params.subscriptionId === watch.subscriptionId,
  );
  for (const mutation of [update, reset])
    assert.ok(
      events.some(
        (e) =>
          e.message.params.kind === "settings.changed" &&
          e.message.params.data.revision === mutation.snapshot.revision,
      ),
    );
  assert.ok(events.every((e) => e.sequence < unsub.s.sequence));
  for (const event of events)
    assert.ok(
      good("owner", "events/ack").some(
        (p) =>
          p.q.message.params.subscriptionId === watch.subscriptionId &&
          p.q.message.params.sequence === event.message.params.sequence,
      ),
    );
  const begin = good("owner", "ui/dataBegin"),
    chunks = good("owner", "ui/dataChunk"),
    commits = good("owner", "ui/dataCommit"),
    pages = good("owner", "ui/dataRead");
  assert.equal(begin.length, 2);
  assert.equal(chunks.length, 2);
  assert.equal(commits.length, 2);
  assert.equal(pages.length, 2);
  for (let i = 0; i < 2; i++) {
    const b = begin[i].q.message.params,
      rows = [
        { key: candidates[0].candidateId, version: String(i + 1), cells: ["candidate"] },
        { key: "mode:" + modes.modes[0].modeId, version: String(i + 1), cells: ["Reflect"] },
      ],
      bytes = Buffer.from(JSON.stringify([{ kind: "table" }, rows]));
    assert.deepEqual(b.binding, r.checkpoints.binding);
    assert.equal(b.dataset, "rows");
    assert.equal(b.baseRevision, i);
    assert.equal(b.presentation, i + 1);
    assert.equal(b.sha256, hash(bytes));
    assert.equal(b.byteLength, bytes.length);
    assert.equal(b.entryCount, 2);
    assert.equal(chunks[i].q.message.params.transfer, ok(begin[i]).transfer);
    assert.equal(chunks[i].q.message.params.offset, 0);
    assert.deepEqual(chunks[i].q.message.params.chunk, { kind: "table", entries: rows });
    assert.equal(ok(chunks[i]).nextOffset, 2);
    assert.equal(commits[i].q.message.params.transfer, ok(begin[i]).transfer);
    assert.equal(ok(commits[i]).revision, i + 1);
    assert.equal(ok(commits[i]).sha256, b.sha256);
    assert.equal(pages[i].q.message.params.revision, i + 1);
    assert.deepEqual(ok(pages[i]).chunk.entries, rows);
    assert.equal(ok(pages[i]).sha256, b.sha256);
    assert.equal(ok(pages[i]).nextOffset, 2);
    assert.equal(ok(pages[i]).done, true);
  }
  const old = denied("owner", "ui/dataRead", "PLUGIN_E_STALE_RESOURCE");
  assert.equal(old.q.message.params.revision, 1);
  assert.ok(old.q.sequence > commits[1].s.sequence);
  const c = r.checkpoints.cancel;
  assert.ok(same(c.owner, owners.owner));
  assert.ok(Number.isFinite(c.reachedAt));
  const cancelRequest = r.wire.find(
    (w) =>
      same(w.owner, owners.owner) &&
      w.direction === "plugin-host" &&
      w.message.method === "devices/read" &&
      w.message.id === c.requestId,
  );
  assert.ok(cancelRequest);
  const cancel = r.wire.find(
    (w) =>
      same(w.owner, owners.owner) &&
      w.direction === "plugin-host" &&
      w.message.method === "$/cancelRequest" &&
      w.message.params.id === c.requestId,
  );
  assert.ok(cancel && cancel.sequence > cancelRequest.sequence);
  const cancelled = pairs("owner", "devices/read").find((p) => p.q.message.id === c.requestId);
  assert.equal(cancelled.error?.code, -32800);
  assert.ok(cancelled.s.sequence > cancel.sequence);
  assert.ok([cancelRequest.at, c.reachedAt, cancel.at, cancelled.s.at].every(Number.isFinite));
  assert.ok(
    cancelRequest.at >= 0 &&
      cancelRequest.at <= c.reachedAt &&
      c.reachedAt <= cancel.at &&
      cancel.at <= cancelled.s.at,
    "Cancellation barrier order",
  );
  assert.deepEqual(
    r.checkpoints.deniedAfter,
    r.checkpoints.deniedBefore,
    "Denied consumer dispatched provider work",
  );
  assert.ok(Array.isArray(r.checkpoints.deniedBefore));
  const connects = r.checkpoints.providerTrace.filter((t) => t.step === "connect");
  assert.equal(connects.length, 2);
  const [before, sent] = connects;
  assert.equal(before.dispatch, "not-sent");
  assert.equal(sent.dispatch, "sent");
  assert.ok(typeof before.operationId === "string" && before.operationId.length > 0);
  assert.equal(sent.operationId, before.operationId);
  assert.ok(Number.isFinite(before.time) && Number.isFinite(sent.time) && before.time <= sent.time);
  assert.ok(r.checkpoints.providerTrace.some((t) => t.step === "read"));
  for (const counters of [r.cleanup.bridge, r.cleanup.worker]) {
    assert.ok(Object.keys(counters).length);
    for (const n of Object.values(counters)) assert.equal(n, 0);
  }
  assert.equal(r.cleanup.workers, 0);
  return {
    claim: r.claim,
    pythonPids: r.launches.map((l) => l.pid),
    sessionId: session.sessionId,
    settingsRevision: final.snapshot.revision,
    datasetRevision: 2,
    cancelledRequest: c.requestId,
    hardware: false,
    installed: false,
  };
}

export async function buildDeviceStdio(directory, python, dependencyRoot) {
  const pythonVersion = JSON.parse(
    execFileSync(python, ["-c", "import sys,json;print(json.dumps(list(sys.version_info[:3])))"], {
      encoding: "utf8",
    }),
  );
  assert.ok(pythonVersion[0] === 3 && pythonVersion[1] >= 10, "Python SDK requires Python >= 3.10");
  const require = createRequire(
      dependencyRoot ? path.join(dependencyRoot, "package.json") : import.meta.url,
    ),
    { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([key, [file]]) => [
      key,
      path.join(root, file),
    ]),
  );
  const sources = new Set(
    [
      "tests/desktop/device-ui-stdio-run.mjs",
      "tests/desktop/device-ui-stdio-test.mjs",
      "tests/desktop/builtin-installed-client.mjs",
      "tests/desktop/raw-resource-plugin.mjs",
      "tests/desktop/fixtures/device-ui-public/consumer.py",
      "tests/desktop/fixtures/device-ui-public/kobrixa-plugin.json",
    ].map((p) => path.join(root, p)),
  );
  const artifactHashes = {};
  for (const [name, contents] of [
    [
      "main.cjs",
      `import {runDeviceStdio} from ${JSON.stringify(path.join(root, "tests/desktop/device-ui-stdio-main.ts"))};runDeviceStdio();`,
    ],
    [
      "worker.cjs",
      `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))};runShippedPersistenceWorker();`,
    ],
  ]) {
    const result = await build({
      stdin: { contents, loader: "ts", resolveDir: root },
      outfile: path.join(directory, name),
      bundle: true,
      platform: "node",
      format: "cjs",
      alias,
      nodePaths: dependencyRoot ? [path.join(dependencyRoot, "node_modules")] : [],
      external: ["electron", "node-hid", "usb"],
      plugins: [rawResourcePlugin()],
      metafile: true,
    });
    for (const input of Object.keys(result.metafile.inputs))
      if (input !== "<stdin>")
        sources.add(
          input.startsWith("kobrixa-raw-resource:") ? input.slice(21) : path.resolve(root, input),
        );
    await writeFile(
      path.join(directory, name + ".meta.json"),
      JSON.stringify(result.metafile, null, 2),
    );
    artifactHashes[name] = hash(await readFile(path.join(directory, name)));
    artifactHashes[name + ".meta.json"] = hash(
      await readFile(path.join(directory, name + ".meta.json")),
    );
  }
  await mkdir(path.join(directory, "profile"));
  await mkdir(path.join(directory, "python"));
  await cp(path.join(root, "sdks/python/kobrixa"), path.join(directory, "python/kobrixa"), {
    recursive: true,
    filter: (p) => !p.includes("__pycache__"),
  });
  for (const file of await readdir(path.join(directory, "python/kobrixa"))) {
    artifactHashes["python/kobrixa/" + file] = hash(
      await readFile(path.join(directory, "python/kobrixa", file)),
    );
    sources.add(path.join(root, "sdks/python/kobrixa", file));
  }
  for (const role of ["owner", "denied"]) {
    const folder = path.join(directory, role);
    await mkdir(folder);
    const { manifest, panel, settings } = documents(role);
    await writeFile(path.join(folder, "kobrixa-plugin.json"), JSON.stringify(manifest));
    await cp(
      path.join(root, "tests/desktop/fixtures/device-ui-public/consumer.py"),
      path.join(folder, "consumer.py"),
    );
    if (role === "owner") await writeFile(path.join(folder, "panel.json"), JSON.stringify(panel));
    await writeFile(path.join(folder, "preferences.json"), JSON.stringify(settings));
    for (const file of await readdir(folder))
      artifactHashes[role + "/" + file] = hash(await readFile(path.join(folder, file)));
  }
  await writeFile(path.join(directory, "config.json"), JSON.stringify({ python }));
  artifactHashes["config.json"] = hash(await readFile(path.join(directory, "config.json")));
  const sourceHashes = {};
  for (const file of sources) sourceHashes[file] = hash(await readFile(file));
  const identity = {
    claim: "synthetic-device-python-stdio",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    artifactHashes,
    sourceHashes,
    python,
    pythonVersion,
    pythonSha256: hash(await readFile(python)),
  };
  await writeFile(path.join(directory, "identity.json"), JSON.stringify(identity, null, 2));
  return identity;
}
// Bound both periodic and final observations; a late poll cannot mutate evidence.
export async function boundedObservation(poll, timeoutMs = 5500) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(poll),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Process observation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function createProcessMonitor({
  poll,
  observe,
  onError,
  intervalMs = 50,
  timeoutMs = 5500,
}) {
  let pending,
    stopped = false;
  const tick = () => {
    if (stopped || pending) return;
    pending = boundedObservation(poll, timeoutMs)
      .then(observe)
      .catch(onError)
      .finally(() => {
        pending = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await pending;
    },
  };
}
export async function finishProcessObservation({
  poll,
  parent,
  known,
  onError,
  kill = process.kill,
  timeoutMs = 5500,
}) {
  let survivors;
  try {
    survivors = descendants(await boundedObservation(poll, timeoutMs), parent, known);
  } catch (error) {
    onError(error);
    // Failure cannot prove exit; attempt cleanup of all previously observed owned PIDs.
    survivors = [...known].filter(Number.isSafeInteger).map((pid) => ({ pid }));
  }
  for (const row of survivors) {
    try {
      kill(row.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") onError(error);
    }
  }
  return survivors;
}
async function main(args) {
  assert.ok(["--build-only", "--run-built"].includes(args[0]));
  if (args[0] === "--build-only") {
    const python = await realpath(
      args[1] ??
        execFileSync("python3", ["-c", "import sys;print(sys.executable)"], {
          encoding: "utf8",
        }).trim(),
    );
    const directory = await realpath(await mkdtemp("/private/tmp/kobrixa-device-stdio-"));
    await buildDeviceStdio(directory, python, args[2]);
    console.log(`BUILD ONLY, no Electron: ${directory}`);
    return;
  }
  const directory = await realpath(args[1]),
    identity = JSON.parse(await readFile(path.join(directory, "identity.json"), "utf8"));
  assert.equal(
    hash(await readFile(identity.python)),
    identity.pythonSha256,
    "Python executable changed",
  );
  for (const [file, h] of Object.entries(identity.sourceHashes))
    assert.equal(hash(await readFile(file)), h, `Changed source ${file}`);
  for (const [file, h] of Object.entries(identity.artifactHashes))
    assert.equal(hash(await readFile(path.join(directory, file))), h, file);
  assert.deepEqual(await readdir(path.join(directory, "profile")), []);
  const electron = args[2];
  assert.ok(
    electron && path.isAbsolute(electron),
    "Pass the actual Electron executable as the third argument",
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(directory, "main.cjs"), `--stdio-root=${directory}`], {
    cwd: directory,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    timedOut = false;
  let outputOverflow = false;
  const capture = (b) => {
    if (Buffer.byteLength(output) + b.length > 4 * 1024 * 1024) {
      outputOverflow = true;
      child.kill("SIGKILL");
      return;
    }
    output += b;
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const known = new Set(),
    monitorErrors = [];
  const monitor = createProcessMonitor({
    poll: processTable,
    observe: (rows) => {
      descendants(rows, child.pid, known);
    },
    onError: (e) => {
      monitorErrors.push(String(e));
    },
  });
  monitor.tick();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 120000);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    result = { error: String(error) };
  } finally {
    clearTimeout(timer);
    await monitor.stop();
    await writeFile(path.join(directory, "native.log"), output);
  }
  const survivors = await finishProcessObservation({
    poll: processTable,
    parent: child.pid,
    known,
    onError: (error) => {
      monitorErrors.push(String(error));
    },
  });
  await writeFile(
    path.join(directory, "process.json"),
    JSON.stringify({ result, timedOut, outputOverflow, survivors, monitorErrors }, null, 2),
  );
  assert.equal(timedOut, false);
  assert.equal(outputOverflow, false);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.deepEqual(survivors, []);
  assert.deepEqual(monitorErrors, []);
  const raw = await readFile(path.join(directory, "producer.json"));
  const receipt = verifyDeviceStdio(JSON.parse(raw));
  await writeFile(
    path.join(directory, "receipt.json"),
    JSON.stringify(
      {
        receipt,
        producerSha256: hash(raw),
        processSha256: hash(await readFile(path.join(directory, "process.json"))),
        logSha256: hash(await readFile(path.join(directory, "native.log"))),
        electronSha256: hash(await readFile(electron)),
        identity,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(receipt));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
