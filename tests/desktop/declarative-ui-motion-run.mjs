import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { root, materialize, padJson } from "./declarative-ui-harness.mjs";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { analyzeLoad } from "./declarative-ui-load-report.mjs";

const faults = [
  "hide",
  "authority-loss",
  "cancel",
  "renderer-freeze",
  "renderer-crash",
  "plugin-kill",
];
const cases = ["prepare", "start", "arm", "pulse"].flatMap((boundary) =>
  ["before", "after"].flatMap((position) => faults.map((fault) => ({ boundary, position, fault }))),
);
const args = process.argv.slice(2);
const slow = args[0] === "--slow-consumer";
const load = ["--load", "--load-probe", "--slow-consumer"].includes(args[0]);
assert.equal(
  args.length,
  1,
  "Pass --all, --stress, --backpressure or --case=boundary:position:fault",
);
const selected = load
  ? Array.from({ length: args[0] === "--load" ? 3 : 1 }, (_, repeat) => ({
      boundary: "pulse",
      position: "after",
      fault: "cancel",
      repeat,
      load: {
        durationMs: args[0] === "--load" ? 60000 : 5000,
        cycles: args[0] === "--load" ? 1000 : 5,
        ...(slow ? { slow: true } : {}),
      },
    }))
  : args[0] === "--backpressure"
    ? [
        {
          boundary: "pulse",
          position: "after",
          fault: "queue-pressure",
          stress: "continuous-backpressure",
        },
      ]
    : args[0] === "--stress"
      ? ["delayed-readback", "withheld-readback", "lost-start"].map((stress) => ({
          boundary: "pulse",
          position: "after",
          fault: "queue-pressure",
          stress,
        }))
      : args[0] === "--all"
        ? cases
        : cases.filter(
            (item) => args[0] === `--case=${item.boundary}:${item.position}:${item.fault}`,
          );
assert.ok(selected.length > 0, "Unknown motion scenario");
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-ui-motion-")));
console.log(`Motion acceptance workspace: ${directory}`);
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const alias = Object.fromEntries(
  [
    ["plugin-protocol", "plugin-protocol"],
    ["plugin-runtime", "plugin-runtime"],
    ["plugin-sdk", "plugin-sdk-js"],
  ].map(([name, folder]) => [
    `@kobrixa/${name}`,
    path.join(root, `packages/${folder}/src/index.ts`),
  ]),
);
const template = path.join(directory, "template");
await mkdir(path.join(template, "source"), { recursive: true });
await cp(
  path.join(root, "apps/desktop/out/stage/node_modules"),
  path.join(directory, "node_modules"),
  { recursive: true },
);
await cp(
  path.join(root, "apps/desktop/.vite/build/preload.cjs"),
  path.join(template, "preload.cjs"),
);
await build({
  entryPoints: [path.join(root, "tests/desktop/declarative-ui-motion-main.ts")],
  outfile: path.join(directory, "main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  alias,
  external: ["electron", "node-hid", "usb"],
  plugins: [rawResourcePlugin()],
});
await build({
  entryPoints: [path.join(root, "tests/desktop/fixtures/declarative-ui/motion-consumer.ts")],
  outfile: path.join(template, "source/main.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  alias,
});
await writeFile(
  path.join(template, "source/kobrixa-plugin.json"),
  JSON.stringify({
    id: "acceptance.motion",
    version: "0.1.0",
    apiVersion: "^1.6.0",
    displayName: { en: "Motion acceptance" },
    runtime: { kind: "node", entry: "main.cjs" },
    permissions: ["ui.panels", "devices.read", "devices.connect", "devices.control"],
    contributes: {
      commands: [
        {
          id: "acceptance.motion.hold",
          title: { en: "Hold" },
          invocation: "context-v1",
          arguments: {},
        },
      ],
      panels: [
        {
          id: "acceptance.motion.panel",
          title: { en: "Motion acceptance" },
          location: "right",
          resource: { version: 1, path: "panel.json" },
        },
      ],
    },
  }),
);
if (load) {
  const sources = await materialize(template, { sources: 8, maximum: true });
  for (const folder of sources) {
    await build({
      entryPoints: [path.join(root, "tests/desktop/fixtures/declarative-ui/consumer.ts")],
      outfile: path.join(folder, "main.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      alias,
      banner: { js: 'console.error("UI_PID:" + process.pid);' },
    });
    // Preserve full UTF-8 resource budgets while excluding the independently
    // reproduced CoreText emoji crash. This is explicitly a CJK diagnostic run.
    for (const name of ["panel-0.json", "panel-1.json", "status-0.json", "status-1.json"]) {
      const value = JSON.parse(
        (await readFile(path.join(folder, name), "utf8")).replaceAll("🙂", "界"),
      );
      await writeFile(path.join(folder, name), padJson(value, 256 * 1024));
    }
  }
}
await writeFile(
  path.join(template, "source/panel.json"),
  JSON.stringify({
    kind: "panel",
    data: {},
    fields: {},
    root: "root",
    nodes: [
      { id: "root", type: "group", layout: "stack", children: ["hold"] },
      {
        id: "hold",
        type: "holdAction",
        label: { en: "Hold" },
        command: "acceptance.motion.hold",
        arguments: {},
      },
    ],
  }),
);
await buildRenderer({
  root: path.join(root, "apps/desktop"),
  configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
  base: "./",
  // The entry is under tests/; resolve React from the desktop graph, not the
  // separately installed root copy. The production pane must share its hooks.
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [
    {
      name: "real-motion-pane-entry",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html.replace(
            'src="/src/renderer/index.tsx"',
            `src="/@fs/${path.join(root, load ? "tests/desktop/declarative-ui-load-renderer.tsx" : "tests/desktop/declarative-ui-motion-renderer.tsx")}"`,
          ),
      },
    },
  ],
  build: { outDir: path.join(template, "renderer"), emptyOutDir: true },
});
const artifact = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length >
    0,
  ...(load
    ? {
        scope: "production pane and status load; CJK diagnostic glyphs",
        fixture: {
          panels: 16,
          statuses: 16,
          nodesPerPanel: 256,
          depth: 8,
          resourceBytes: (
            await Promise.all(
              Array.from({ length: 8 }, (_, n) =>
                ["panel-0.json", "panel-1.json", "status-0.json", "status-1.json"].map(
                  async (name) => (await readFile(path.join(template, `ui-${n}`, name))).byteLength,
                ),
              ).flat(),
            )
          ).reduce((a, b) => a + b, 0),
          producerMinimumIntervalMs: 100,
        },
      }
    : {}),
  sha256: Object.fromEntries(
    await Promise.all(
      [
        "main.cjs",
        ...(await readdir(template, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name))),
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(path.join(directory, name)))
          .digest("hex"),
      ]),
    ),
  ),
};
await writeFile(path.join(directory, "artifact-identity.json"), JSON.stringify(artifact, null, 2));
const reports = [];
for (const scenario of selected) {
  const name = scenario.load
    ? `load-${scenario.repeat}`
    : (scenario.stress ?? `${scenario.boundary}-${scenario.position}-${scenario.fault}`);
  const folder = path.join(directory, name);
  await cp(template, folder, { recursive: true });
  await mkdir(path.join(folder, "profile"));
  await writeFile(
    path.join(folder, "source/motion.json"),
    JSON.stringify({
      mode: scenario.boundary === "arm" ? "relative-angle" : "jog",
      stress: scenario.stress,
    }),
  );
  const input = path.join(folder, "input.json"),
    output = path.join(folder, "report.json");
  await writeFile(input, JSON.stringify(scenario));
  const child = spawn(
    require("electron"),
    [
      path.join(directory, "main.cjs"),
      `--motion-input=${input}`,
      `--motion-output=${output}`,
      ...(load ? ["--ui-load"] : []),
    ],
    {
      cwd: folder,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const logs = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      logs.push(data.toString());
      process.stderr.write(data);
    });
  const terminate = () => {
    if (child.pid)
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
  };
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      terminate();
    },
    load ? 620_000 : 75_000,
  );
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    clearTimeout(timer);
    await writeFile(path.join(folder, "electron.log"), logs.join(""));
    if (!result || result.code !== 0 || timedOut) terminate();
  }
  assert.equal(timedOut, false, name);
  assert.equal(result.code, 0, `${name}: ${JSON.stringify(result)}; see ${folder}`);
  const report = JSON.parse(await readFile(output, "utf8"));
  assert.equal(
    report.kind,
    slow ? "ui-slow-renderer-run" : load ? "ui-maximum-load-run" : "ui-motion-race",
  );
  const pids = load ? report.childPids : [report.pid];
  assert.ok(pids.length && pids.every((pid) => pid > 0));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const closedAt = performance.now();
  await pause(5000);
  report.orphanCheckMs = performance.now() - closedAt;
  report.remainingPids = pids.filter(alive);
  report.artifact = artifact;
  report.normalClose = !report.expectedBlockedClose;
  await writeFile(output, JSON.stringify(report, null, 2));
  assert.deepEqual(report.remainingPids, []);
  reports.push({ scenario, path: output });
  console.log(`${load ? "RECORDED native UI load" : "PASS native motion"} ${name}: ${output}`);
}
await writeFile(
  path.join(directory, "matrix.json"),
  JSON.stringify(
    {
      kind: slow
        ? "ui-slow-renderer"
        : load
          ? "ui-maximum-load"
          : args[0] === "--backpressure"
            ? "ui-sdk-backpressure"
            : args[0] === "--stress"
              ? "ui-motion-stress"
              : "ui-motion-matrix",
      reports,
      artifact,
    },
    null,
    2,
  ),
);
console.log(
  `${reports.length}/${selected.length} native ${load ? "UI" : "motion"} cases recorded; other acceptance gates remain separate.`,
);
if (args[0] === "--load") {
  const analysis = await analyzeLoad(path.join(directory, "matrix.json"));
  await writeFile(path.join(directory, "load-analysis.json"), JSON.stringify(analysis, null, 2));
  assert.equal(analysis.pass, true, JSON.stringify(analysis.runs.map((run) => run.checks)));
  console.log("Native UI load timing, heap and cleanup thresholds PASS.");
}
