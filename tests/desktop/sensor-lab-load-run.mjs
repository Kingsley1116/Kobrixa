import { processTable, descendants } from "./builtin-installed-client.mjs";
import { createProcessMonitor, finishProcessObservation } from "./device-ui-stdio-run.mjs";
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
import { tmpdir, cpus, totalmem } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { restartOriginals } from "./sensor-lab-public-run.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pluginId = "kobrixa.sensor-lab";
export async function buildLabLoad(directory) {
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
      "tests/desktop/sensor-lab-load-run.mjs",
      "tests/desktop/sensor-lab-load.test.mjs",
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
    `import {runNativeLabLoad} from ${JSON.stringify(path.join(root, "tests/desktop/sensor-lab-load-main.ts"))}; runNativeLabLoad();`,
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
              `src="/@fs/${path.join(root, "tests/desktop/sensor-lab-load-renderer.tsx")}"`,
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
      .filter((f) => /\.(html|js|css|map|ttf)$/.test(f))
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

// Short numbers leave ample room under byte caps, while nulls and segment changes
// require real gap preservation. Imported originals remain in the isolated profile.
export function maximumOriginals() {
  const template = JSON.parse(Object.values(restartOriginals)[0]);
  return Array.from({ length: 49 }, (_, record) => {
    const id = `12345678-1234-4234-8234-${String(record + 1).padStart(12, "0")}`;
    const channels = Array.from({ length: 4 }, (_, port) => ({
      ...structuredClone(template.channels[0]),
      source: {
        ...template.channels[0].source,
        port,
        id: JSON.stringify(["input", port, 30, 0, 1, "cm"]),
      },
    }));
    const frames = Array.from({ length: 3600 }, (_, i) => ({
      sampledAt: 100 + i * 500,
      elapsedMs: i * 500,
      values: channels.map((_, c) => (i === 1800 ? null : ((i % 101) - 50) * (c + 1))),
      status: i === 1800 ? "busy" : "ok",
      segment: i > 1800 ? 1 : 0,
    }));
    return {
      ...template,
      id,
      name: `W15 maximum ${record}`,
      channels,
      frames,
      durationMs: 1799500,
      frameCount: frames.length,
    };
  });
}
export function percentile(samples, fraction) {
  assert.ok(samples.length > 0, "Missing raw latency samples");
  assert.ok(
    samples.every((x) => Number.isFinite(x) && x >= 0),
    "Invalid latency sample",
  );
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
}
export function verifyLoad(report) {
  assert.equal(report.schema, 1);
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  const c = report.checkpoints;
  assert.ok(c.steadyEnd - c.steadyStart >= 60000, "60 seconds steady load");
  assert.equal(c.historyRows.length, 50);
  assert.ok(c.backgroundFrames >= 3599, "3600 frames with reservation firstFrame");
  assert.equal(report.launches.length, 1);
  assert.equal(report.exits.length, 1);
  // Reconstruct the original final storage write; checkpoints and frame counters
  // alone do not establish that 3600 samples survived persistence.
  const pairs = (method) =>
    report.wire
      .filter((r) => r.direction === "plugin-host" && r.message.method === method)
      .map((request) => {
        const response = report.wire.find(
          (r) =>
            r.sequence > request.sequence &&
            r.direction === "host-plugin" &&
            r.message.id === request.message.id &&
            !r.message.method,
        );
        assert.ok(response, `Missing response ${method}`);
        return { params: request.message.params, result: response.message.result };
      });
  let saved3600 = false;
  for (const begin of pairs("storage/beginWrite").filter(
    (r) => r.result.ok && r.params.checkpoint?.phase === "final",
  )) {
    const write = begin.result.value.write;
    const chunks = pairs("storage/writeChunk").filter(
      (r) => r.result.ok && r.params.write === write,
    );
    let offset = 0;
    const buffers = chunks.map((r) => {
      assert.equal(r.params.offset, offset);
      const b = Buffer.from(r.params.data, "base64");
      offset += b.length;
      return b;
    });
    const bytes = Buffer.concat(buffers);
    assert.equal(bytes.length, begin.params.byteLength);
    assert.equal(digest(bytes), begin.params.sha256);
    const payload = JSON.parse(bytes.toString("utf8"));
    if (payload.frameCount !== 3600) continue;
    assert.equal(payload.frames.length, 3600);
    assert.ok(
      pairs("storage/commitWrite").some(
        (r) =>
          r.params.write === write && r.result.ok && r.result.value.record.sha256 === digest(bytes),
      ),
    );
    saved3600 = true;
  }
  assert.ok(saved3600, "3600 original frames committed as final bytes");
  const cursors = report.wire.filter(
    (r) =>
      r.direction === "host-plugin" &&
      r.message.method === "command/invoke" &&
      r.message.params.command === `${pluginId}.cursor`,
  );
  assert.ok(cursors.length >= 20, "Original cursor RPC observations");
  for (const request of cursors) {
    const response = report.wire.find(
      (r) =>
        r.sequence > request.sequence &&
        r.direction === "plugin-host" &&
        r.message.id === request.message.id &&
        !r.message.method,
    );
    assert.equal(response?.message.result.ok, true);
    const time = request.message.params.arguments.time;
    // Nearest original frame, ties go to the later frame; null at the gap.
    const i = Math.min(3599, Math.max(0, Math.floor(time / 500 + 0.5)));
    for (let channel = 0; channel < 4; channel++)
      for (const prefix of [`c${channel}`, `c${channel}comparison`])
        assert.equal(
          response.message.result.value.output[`${prefix}raw`],
          i === 1800 ? null : ((i % 101) - 50) * (channel + 1),
          "Raw cursor truth",
        );
  }
  for (const row of report.wire) {
    if (row.message.method?.startsWith("ui/data"))
      assert.ok(
        Buffer.byteLength(JSON.stringify(row.message)) <= 65536,
        "Dataset RPC envelope cap",
      );
  }
  for (const row of report.ipc.filter(
    (r) => r.channel === "plugins:ui:data-read" && r.result?.ok,
  )) {
    assert.ok(Buffer.byteLength(JSON.stringify(row.result.value)) <= 49152, "Read result byte cap");
    assert.ok(Buffer.byteLength(JSON.stringify(row.result)) <= 65536, "Read envelope cap");
  }
  const m = c.measurements;
  verifyLatencies(m);
  const stops = report.ipc.filter(
    (r) =>
      r.channel === "plugins:ui:interact" &&
      r.args[0].kind === "core" &&
      r.args[0].actionId === "stop",
  );
  assert.equal(stops.length, 20, "Twenty independent loaded Stop observations");
  const dispatch = stops.map((row) => {
    const input = report.native
      .filter((e) => e.type === "pointerdown" && e.isTrusted && e.status && e.at <= row.at)
      .at(-1);
    assert.ok(input, "Trusted Stop input");
    assert.equal(row.result.ok, true);
    const release = report.brokerCalls.find(
      (r) => r.method === "devices/recording/release" && r.at >= row.at,
    );
    assert.ok(release, "Real broker release dispatch");
    return release.at - input.at;
  });
  assert.ok(percentile(dispatch, 0.95) <= 100, "Stop dispatch p95 <=100ms (not physical stop)");
  assert.ok(c.memory.length >= 20, "Retained process/cache observations");
  for (const sample of c.memory) {
    assert.ok(sample.main.heapUsed > 0 && sample.main.rss > 0);
    assert.ok(sample.processes.some((p) => p.type === "Tab" && p.memory.workingSetSize > 0));
    assert.ok(sample.bridge.queuedBytes <= 256 * 1024);
    assert.ok(sample.bridge.pendingInvocations <= 4);
    verifyMaximum(sample.renderer);
  }
  verifyMaximum(c.maximum);
  for (const counters of [report.cleanup.bridge, report.cleanup.worker])
    for (const value of Object.values(counters))
      assert.equal(value, 0, "Retained cleanup resource");
  assert.equal(report.cleanup.workers, 0);
  return {
    scope:
      "Lab comparison plus active recorder, standalone Monaco plaintext editor; separate full-frame background recording; synthetic provider only",
    acceptance: "W15 NOT CLOSED",
    applyP95: percentile(m.apply, 0.95),
    inputP95: percentile(m.input, 0.95),
    cursorP95: percentile(m.cursor, 0.95),
    stopDispatchP95: percentile(dispatch, 0.95),
  };
}
export function verifyLatencies(m) {
  for (const [name, limit] of [
    ["apply", 16],
    ["input", 100],
    ["cursor", 100],
  ]) {
    assert.ok(m[name].length >= 20, `${name}: at least 20 raw observations`);
    assert.ok(percentile(m[name], 0.95) <= limit, `${name} p95 <= ${limit}ms`);
  }
  assert.ok(Math.max(...m.apply) <= 50, "apply max <= 50ms");
}
export function verifyMaximum(snapshot) {
  assert.equal(snapshot.charts.length, 4);
  assert.ok(snapshot.cacheBytes <= 512 * 1024, "Panel serialized cache cap");
  assert.ok(snapshot.datasets <= 8);
  for (const [channel, chart] of snapshot.charts.entries()) {
    assert.equal(chart.header.series.length, 2);
    for (let series = 0; series < 2; series++) {
      const points = chart.entries.filter((p) => p[0] === series);
      assert.equal(points.length, 800, "Maximum legal series count");
      assert.ok(
        points.every((p) => p[2] !== 900000),
        "Null sample not bridged",
      );
      assert.ok(
        points.some((p) => p[1] === 0) && points.some((p) => p[1] === 1),
        "Both runs retained",
      );
      for (const point of points) {
        const i = point[2] / 500;
        assert.ok(Number.isInteger(i) && i >= 0 && i < 3600);
        assert.equal(point[1], i > 1800 ? 1 : 0, "Original gap segmentation");
        assert.equal(point[3], ((i % 101) - 50) * (channel + 1), "Original raw point truth");
      }
      assert.deepEqual(chart.header.timeDomain, [0, 1799500]);
      assert.deepEqual(chart.header.series[series].range, [
        -50 * (channel + 1),
        50 * (channel + 1),
      ]);
      const extrema = chart.header.series[series].extrema;
      assert.deepEqual(
        extrema,
        [
          [0, -50 * (channel + 1)],
          [50000, 50 * (channel + 1)],
        ],
        "Full raw extrema",
      );
      for (const [time, value] of extrema)
        assert.ok(
          points.some((p) => p[2] === time && p[3] === value),
          "Original extrema retained",
        );
    }
  }
}
export async function verifyDirectory(directory) {
  const receipt = JSON.parse(await readFile(path.join(directory, "load-receipt.json"), "utf8"));
  const bytes = await readFile(path.join(directory, "load-producer.json"));
  assert.equal(digest(bytes), receipt.producerSha256);
  assert.equal(receipt.outside.code, 0);
  assert.equal(receipt.outside.signal, null);
  assert.equal(receipt.outside.timedOut, false);
  assert.deepEqual(receipt.outside.survivors, []);
  assert.deepEqual(receipt.outside.errors, []);
  for (const [name, hash] of Object.entries(receipt.identity.artifactHashes))
    assert.equal(
      digest(await readFile(path.join(directory, name))),
      hash,
      `Artifact changed: ${name}`,
    );
  assert.ok(Object.keys(receipt.identity.sourceHashes).length > 20, "Transitive source hashes");
  return verifyLoad(JSON.parse(bytes));
}
async function main(args) {
  assert.ok(["--run", "--build-only"].includes(args[0]), "Use --run or --build-only");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-lab-load-")));
  console.log(`W15 artifacts: ${directory}`);
  const identity = await buildLabLoad(directory);
  const originals = maximumOriginals();
  const folder = path.join(directory, "profile/sensor-lab/recordings");
  await mkdir(folder, { recursive: true });
  for (const record of originals)
    await writeFile(path.join(folder, `${record.id}.json`), JSON.stringify(record), { flag: "wx" });
  await writeFile(
    path.join(directory, "load-environment.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        cpu: cpus(),
        ram: totalmem(),
        versions: process.versions,
        fixtureHashes: originals.map((r) => digest(JSON.stringify(r))),
      },
      null,
      2,
    ),
  );
  if (args[0] === "--build-only") {
    console.log("Build only; native acceptance NOT RUN.");
    return;
  }
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
  const known = new Set(),
    errors = [];
  const monitor = createProcessMonitor({
    poll: processTable,
    observe: (rows) => descendants(rows, child.pid, known),
    onError: (error) => errors.push(String(error)),
  });
  monitor.tick();
  const logs = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (b) => {
      logs.push(b.toString());
      process.stderr.write(b);
    });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") errors.push(String(error));
    }
  }, 2400000);
  const outside = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await monitor.stop();
  outside.survivors = await finishProcessObservation({
    poll: processTable,
    parent: child.pid,
    known,
    onError: (error) => errors.push(String(error)),
  });
  outside.errors = errors;
  outside.timedOut = timedOut;
  await writeFile(path.join(directory, "process.json"), JSON.stringify(outside, null, 2));
  await writeFile(path.join(directory, "native.log"), logs.join(""));
  const bytes = await readFile(path.join(directory, "load-producer.json"));
  // Retain failed observations before validating; never create a synthetic success.
  await writeFile(
    path.join(directory, "load-receipt.json"),
    JSON.stringify({ outside, identity, producerSha256: digest(bytes) }, null, 2),
  );
  const verified = await verifyDirectory(directory);
  console.log(JSON.stringify({ directory, verified }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
