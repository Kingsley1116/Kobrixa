import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pluginId = "kobrixa.sensor-lab";
const ok = (result) => {
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result.value;
};

/** Inert pure oracle: build success or a submitted receipt alone cannot pass. */
export function verifyLabReceipt(report) {
  assert.equal(report.schema, 1);
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.equal(report.launches.length, 1, "Exactly the original bundled Lab process");
  const owner = report.launches[0].owner;
  assert.equal(owner.pluginId, pluginId);
  assert.equal(owner.sourceKey, `builtin:${pluginId}`);
  for (const key of ["hostEpoch", "generation", "processEpoch"])
    assert.ok(owner[key] !== undefined);
  assert.equal(report.exits.length, 1);
  assert.deepEqual(report.exits[0].owner, owner);
  assert.ok(report.exits[0].at > report.checkpoints.history.at);
  const freeze = report.gate.find((r) => r.phase === "gate-freeze");
  const settled = report.gate.find((r) => r.phase === "gate-settled");
  assert.ok(
    freeze && settled && freeze.at <= settled.at && settled.at <= report.launches[0].at,
    "Real legacy barrier before activation/launch",
  );
  for (const row of report.wire) assert.deepEqual(row.owner, owner, "No replacement owner");
  const pairs = (method, direction = "plugin-host") =>
    report.wire
      .filter((r) => r.direction === direction && r.message.method === method)
      .map((request) => {
        const responses = report.wire.filter(
          (r) =>
            r.sequence > request.sequence &&
            r.direction !== direction &&
            r.message.id === request.message.id &&
            !r.message.method,
        );
        assert.equal(responses.length, 1, `Exactly one original response: ${method}`);
        return {
          request,
          response: responses[0],
          params: request.message.params,
          value: ok(responses[0].message.result),
        };
      });
  const commands = pairs("command/invoke", "host-plugin");
  for (const name of [
    "select-current",
    "select-channel",
    "capture-a",
    "apply",
    "start",
    "refresh",
    "view-record",
  ]) {
    const rows = commands.filter((r) => r.params.command === `${pluginId}.${name}`);
    assert.equal(rows.length, 1, `One native command ${name}, no auto replay`);
    assert.equal(rows[0].params.context.origin, "panel");
    assert.ok(rows[0].params.context.binding);
    assert.deepEqual(rows[0].value.fieldErrors, []);
  }
  const form = report.checkpoints.applied.state.form;
  assert.equal(form["two-point"], true);
  assert.equal(form["source-a"], "42");
  assert.equal(form["source-b"], "100");
  assert.equal(form["target-b"], "200");
  assert.ok(
    report.ipc.some((r) => r.channel === "plugins:ui:form-sync" && r.result?.ok === true),
    "Native draft crossed canonical syncForm port",
  );
  assert.ok(
    pairs("ui/formPatch").some((r) => r.params.set["source-a"] === "42"),
    "Original SDK Capture A patched canonical form",
  );
  const reserve = pairs("devices/recording/reserve");
  assert.equal(reserve.length, 1);
  const reservation = reserve[0].value.reservation;
  assert.ok(reservation);
  const registered = pairs("storage/registerCheckpoint");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].params.reservation, reservation.reservationId);
  const checkpoint = registered[0].value.checkpoint;
  const background = report.checkpoints.background;
  assert.equal(background.launchCount, 1);
  assert.equal(background.exitCount, 0);
  assert.deepEqual(background.owner, owner);
  const closed = report.ipc.find((r) => r.channel === "plugins:ui:close" && r.result?.ok === true);
  assert.ok(closed && closed.at < background.at);
  assert.ok(
    pairs("devices/recording/read").some(
      (r) =>
        r.request.at > closed.at &&
        r.response.at <= background.at &&
        r.params.reservationId === reservation.reservationId &&
        r.value.frames.length > 0,
    ),
    "Original recording continued while panel closed",
  );
  const stops = report.ipc.filter(
    (r) =>
      r.channel === "plugins:ui:interact" &&
      r.args[0]?.kind === "core" &&
      r.args[0]?.actionId === "stop",
  );
  assert.equal(stops.length, 1);
  ok(stops[0].result);
  assert.equal(stops[0].args[0].binding.kind, "status");
  assert.ok(stops[0].at >= background.at);
  assert.ok(
    report.native.some(
      (r) =>
        r.type === "pointerdown" &&
        r.isTrusted &&
        r.status &&
        r.at >= background.at &&
        r.at <= stops[0].at,
    ),
    "Trusted status input preceded core admission",
  );
  const releases = report.brokerCalls.filter((r) => r.method === "devices/recording/release");
  assert.equal(releases.length, 1, "Exactly one actual broker release");
  assert.equal(releases[0].principal.kind, "plugin");
  assert.deepEqual(releases[0].principal.owner, owner);
  assert.equal(releases[0].params.reservationId, reservation.reservationId);
  assert.ok(releases[0].at >= stops[0].at);
  ok(releases[0].result);
  // Core Stop is host-side: the SDK must not receive an invented panel command.
  assert.ok(!commands.some((r) => r.params.command === `${pluginId}.stop`));
  const drain = report.drains.find((d) =>
    d.offer.checkpoints.some((c) => c.checkpoint === checkpoint),
  );
  assert.ok(drain, "Original checkpoint is present in actual host drain offer");
  assert.deepEqual(drain.offer.owner, owner);
  assert.equal(drain.report?.state, "saved");
  assert.equal(drain.report.blocker, false);
  assert.deepEqual(drain.report.errors, []);
  assert.ok(drain.at >= stops[0].at);
  const submitted = pairs("storage/drain", "host-plugin").find(
    (r) => r.params.token === drain.offer.token,
  );
  assert.ok(submitted);
  assert.equal(submitted.value.status, "submitted");
  const begin = pairs("storage/beginWrite").find(
    (r) =>
      r.params.drainToken === drain.offer.token &&
      r.params.checkpoint?.handle === checkpoint &&
      r.params.checkpoint.phase === "final",
  );
  assert.ok(begin, "A new final write uses the original checkpoint and drain token");
  assert.equal(begin.params.target.mode, "replace");
  assert.equal(begin.params.target.id, registered[0].params.id);
  const write = begin.value.write;
  assert.deepEqual(submitted.value.writes, [write]);
  const commit = pairs("storage/commitWrite").find((r) => r.params.write === write);
  assert.ok(commit);
  assert.equal(commit.params.drainToken, drain.offer.token);
  const meta = commit.value.record;
  assert.equal(meta.id, registered[0].params.id);
  assert.equal(meta.checkpoint, "final");
  assert.equal(meta.interrupted, false);
  assert.equal(meta.sha256, begin.params.sha256);
  assert.equal(meta.byteLength, begin.params.byteLength);
  assert.ok(
    drain.report.records.some(
      (r) => r.id === meta.id && r.committedRevision === meta.revision && r.final,
    ),
  );
  const stat = pairs("storage/stat").find(
    (r) =>
      r.request.at > drain.finishedAt &&
      r.params.id === meta.id &&
      r.value.record.revision === meta.revision,
  );
  assert.ok(stat, "Original SDK stat after actual host saved");
  assert.deepEqual(stat.value.record, meta);
  assert.notDeepEqual(
    report.checkpoints.open.state.binding,
    report.checkpoints.reopened.state.binding,
    "Reopen has new binding",
  );
  const opened = pairs("storage/openRead").find(
    (r) => r.params.id === meta.id && r.params.expectedRevision === meta.revision,
  );
  assert.ok(opened);
  assert.deepEqual(opened.value.record, meta);
  const chunks = pairs("storage/readChunk").filter((r) => r.params.read === opened.value.read);
  let offset = 0;
  const bytes = Buffer.concat(
    chunks.map((r, i) => {
      const bytes = Buffer.from(r.value.data, "base64");
      assert.equal(bytes.toString("base64"), r.value.data);
      assert.equal(r.params.offset, offset);
      assert.equal(r.value.offset, offset);
      offset += bytes.length;
      assert.equal(r.value.nextOffset, offset);
      assert.equal(r.value.eof, i === chunks.length - 1);
      return bytes;
    }),
  );
  assert.equal(bytes.length, meta.byteLength);
  assert.equal(digest(bytes), meta.sha256);
  const payload = JSON.parse(bytes.toString("utf8"));
  // Payload UUID and host storage ID are separate identities. Pin both to
  // the original creation instead of assuming their values happen to match.
  const created = pairs("storage/beginWrite").find(
    (r) => r.params.target.mode === "create" && r.value.id === meta.id,
  );
  assert.ok(created, "Original create selected this host record ID");
  const initialChunks = pairs("storage/writeChunk").filter(
    (r) => r.params.write === created.value.write,
  );
  let initialOffset = 0;
  const initialBytes = Buffer.concat(
    initialChunks.map((r) => {
      assert.equal(r.params.offset, initialOffset);
      const chunk = Buffer.from(r.params.data, "base64");
      initialOffset += chunk.length;
      return chunk;
    }),
  );
  assert.equal(initialBytes.length, created.params.byteLength);
  assert.equal(digest(initialBytes), created.params.sha256);
  const initial = JSON.parse(initialBytes.toString("utf8"));
  assert.match(payload.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(payload.id, initial.id, "Original model identity survives finalization and read");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.name, "D7 actual Lab");
  assert.equal(payload.channels.length, 1);
  assert.ok(payload.frames.length > 0);
  assert.equal(payload.frameCount, payload.frames.length);
  assert.ok(
    report.ipc.some(
      (r) =>
        r.channel === "plugins:ui:data-read" &&
        r.at > opened.request.at &&
        r.result?.ok === true &&
        r.result.value.header.view === "full" &&
        r.args[0].dataset === "chart0",
    ),
    "Generic renderer consumed saved full-domain chart",
  );
  assert.ok(payload.frames.some((f) => f.values[0] === 42 && f.status === "ok"));
  assert.equal(payload.channels[0].source.origin, "public");
  assert.equal(payload.channels[0].source.provenance.sessionId, reserve[0].params.sessionId);
  assert.equal(
    payload.channels[0].source.provenance.sourceRevision,
    reserve[0].params.expectedSourceRevision,
  );
  assert.deepEqual(payload.channels[0].calibration, {
    twoPoint: true,
    sourceA: 42,
    sourceB: 100,
    targetA: 0,
    targetB: 200,
    zeroOffset: 0,
    unit: form.unit,
  });
  assert.ok(report.native.some((r) => r.type === "pointerdown" && r.isTrusted && r.close));
  assert.ok(report.native.some((r) => r.type === "input" && r.isTrusted && r.node === "target-b"));
  for (const counters of [report.cleanup.bridge, report.cleanup.worker])
    for (const [name, value] of Object.entries(counters)) assert.equal(value, 0, `Cleanup ${name}`);
  assert.equal(report.cleanup.workers, 0);
  return {
    owner,
    record: meta,
    reservation: reservation.reservationId,
    checkpoint,
    finalWrite: write,
    payloadSha256: digest(bytes),
    frames: payload.frames.length,
  };
}

export async function buildLab(directory) {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const vite = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
  await mkdir(path.join(directory, "profile"), { recursive: true });
  await mkdir(path.join(directory, "plugins/sensor-lab/ui"), { recursive: true });
  await symlink(
    await realpath(path.join(root, "apps/desktop/node_modules")),
    path.join(directory, "node_modules"),
    "dir",
  );
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([name, [file]]) => [
      name,
      path.join(root, file),
    ]),
  );
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external: ["electron", "node-hid", "usb"],
    plugins: [rawResourcePlugin()],
    metafile: true,
  };
  const inputs = new Set(
    [
      "tests/desktop/sensor-lab-public-run.mjs",
      "tests/desktop/sensor-lab-public-test.mjs",
      "tests/desktop/raw-resource-plugin.mjs",
    ].map((file) => path.join(root, file)),
  );
  const bundle = async (name, contents) => {
    const result = await build({
      ...common,
      stdin: { contents, resolveDir: root, loader: "ts" },
      outfile: path.join(directory, name),
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input === "<stdin>") continue;
      const absolute = input.startsWith("kobrixa-raw-resource:")
        ? input.slice("kobrixa-raw-resource:".length)
        : path.resolve(root, input);
      assert.ok(
        absolute.startsWith(root + path.sep) || absolute.includes("/node_modules/"),
        `Foreign workspace source ${absolute}`,
      );
      inputs.add(absolute);
    }
    await writeFile(
      path.join(directory, name.replaceAll("/", "-") + ".meta.json"),
      JSON.stringify(result.metafile, null, 2),
    );
  };
  await bundle(
    "main.cjs",
    `import {runNativeLab} from ${JSON.stringify(path.join(root, "tests/desktop/sensor-lab-public-main.ts"))}; runNativeLab();`,
  );
  await bundle(
    "persistence-worker.cjs",
    `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))}; runShippedPersistenceWorker();`,
  );
  await bundle(
    "preload.cjs",
    `import ${JSON.stringify(path.join(root, "apps/desktop/src/preload/index.ts"))};`,
  );
  await bundle(
    "plugins/sensor-lab/main.cjs",
    `console.error("LAB_PID:"+process.pid); import ${JSON.stringify(path.join(root, "plugins/sensor-lab/src/main.ts"))};`,
  );
  const leaf = path.join(directory, "plugins/sensor-lab");
  for (const name of ["kobrixa-plugin.json", "ui/panel.json", "ui/status.json"])
    await cp(path.join(root, "plugins/sensor-lab", name), path.join(leaf, name));
  const files = [];
  for (const name of [
    "kobrixa-plugin.json",
    "main.cjs",
    "ui/panel.json",
    "ui/status.json",
  ].sort()) {
    const bytes = await readFile(path.join(leaf, name));
    files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  await writeFile(
    path.join(leaf, "resource-index.json"),
    JSON.stringify({ version: 1, pluginId, files }),
  );
  await vite.build({
    configLoader: "runner",
    cacheDir: path.join(directory, "vite-cache"),
    root: path.join(root, "apps/desktop"),
    configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
    base: "./",
    resolve: { alias, dedupe: ["react", "react-dom"] },
    plugins: [
      {
        name: "actual-lab-generic-shell",
        generateBundle() {
          for (const id of this.getModuleIds()) {
            if (id.startsWith("/") && !id.includes("/node_modules/")) {
              assert.ok(id.startsWith(root + path.sep), `Foreign renderer ${id}`);
              inputs.add(id.split("?")[0]);
            }
          }
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html.replace(
              'src="/src/renderer/index.tsx"',
              `src="/@fs/${path.join(root, "tests/desktop/sensor-lab-public-renderer.tsx")}"`,
            ),
        },
      },
    ],
    build: { outDir: path.join(directory, "renderer"), emptyOutDir: true },
  });
  const artifactHashes = {},
    sourceHashes = {};
  for (const name of [
    "main.cjs",
    "persistence-worker.cjs",
    "preload.cjs",
    ...files.map((f) => `plugins/sensor-lab/${f.path}`),
    "plugins/sensor-lab/resource-index.json",
    ...(await readdir(path.join(directory, "renderer"), { recursive: true }))
      .filter((f) => /\.(html|js|css)$/.test(f))
      .map((f) => `renderer/${f}`),
  ])
    artifactHashes[name] = digest(await readFile(path.join(directory, name)));
  for (const file of [...inputs].sort())
    sourceHashes[path.relative(root, file)] = digest(await readFile(file));
  const identity = {
    root,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    artifactHashes,
    sourceHashes,
  };
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  return identity;
}

async function main(args) {
  assert.ok(
    ["--build-only", "--run", "--run-built"].includes(args[0]),
    "Use --build-only | --run | --run-built <absolute directory>",
  );
  const directory =
    args[0] === "--run-built"
      ? await realpath(args[1])
      : await realpath(await mkdtemp("/private/tmp/kobrixa-lab-public-"));
  console.log(`Lab public artifacts: ${directory}`);
  const identity =
    args[0] === "--run-built"
      ? JSON.parse(await readFile(path.join(directory, "artifact-identity.json"), "utf8"))
      : await buildLab(directory);
  if (args[0] === "--build-only") {
    console.log("BUILD ONLY: Electron was not launched; no native PASS claimed.");
    return;
  }
  assert.equal(
    digest(await readFile(fileURLToPath(import.meta.url))),
    identity.sourceHashes["tests/desktop/sensor-lab-public-run.mjs"],
    "Oracle changed since build; rebuild before native execution",
  );
  for (const [file, hash] of Object.entries(identity.artifactHashes))
    assert.equal(
      digest(await readFile(path.join(directory, file))),
      hash,
      `Changed artifact ${file}`,
    );
  // An existing profile/receipt must never silently turn this into a replay run.
  assert.deepEqual(
    await readdir(path.join(directory, "profile")),
    [],
    "Native run requires a fresh isolated profile",
  );
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [path.join(directory, "main.cjs"), `--lab-root=${directory}`],
    {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const logs = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      logs.push(bytes.toString());
      process.stderr.write(bytes);
    });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }, 150_000);
  const outside = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await writeFile(path.join(directory, "native.log"), logs.join(""));
  assert.equal(timedOut, false, "Native timeout");
  assert.equal(outside.code, 0, "Native producer failed; inspect producer.json/native.log");
  assert.equal(outside.signal, null);
  const producerBytes = await readFile(path.join(directory, "producer.json"));
  const verified = verifyLabReceipt(JSON.parse(producerBytes));
  const receipt = { verified, outside, producerSha256: digest(producerBytes), identity };
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`Actual public Lab PASS: ${path.join(directory, "receipt.json")}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
