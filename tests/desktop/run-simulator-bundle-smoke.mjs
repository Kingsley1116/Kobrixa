import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { build, loadConfigFromFile, mergeConfig } from "vite";

const root = fileURLToPath(new URL("../../", import.meta.url));
const desktop = path.join(root, "apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));
const { loadProject } = require("@kobrixa/compiler");
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-simulator-bundle-smoke-"));
const renderer = path.join(temporary, "renderer");
const names = [
  "differential-route",
  "omni-lateral",
  "vision-search",
  "pixy2-search",
  "motor-shooter",
  "mailbox-cooperation",
];
let passed = false;
const unchangedInputs = new Map();
const digest = (content) => createHash("sha256").update(content).digest("hex");

async function prepare(name) {
  const external = name === "Main_Simple_L_2026";
  const input = external
    ? path.resolve(process.env.KOBRIXA_MAIN_SIMPLE_PROJECT)
    : path.join(root, "examples/simulation", name);
  const directory = (await stat(input)).isDirectory() ? input : path.dirname(input);
  const scenePath =
    external && process.env.KOBRIXA_MAIN_SIMPLE_SCENE
      ? path.resolve(process.env.KOBRIXA_MAIN_SIMPLE_SCENE)
      : path.join(directory, "kobrixa.simulator.json");
  const sceneText = await readFile(scenePath, "utf8");
  const scene = JSON.parse(sceneText);
  if (external) {
    unchangedInputs.set(scenePath, digest(sceneText));
    const primary = scene.robots.find((robot) => robot.id === "A1");
    assert.ok(primary, "The external scene must contain A1.");
    // The saved practice may currently use four built-in opponents. Select the
    // competition entry only in this captured fixture, never in the user's file.
    primary.controller = { kind: "program", entry: "Main_Simple_L_2026.bp" };
    scene.mode = "practice";
  }
  const entries = [
    ...new Set(
      scene.robots
        .filter((robot) => robot.controller.kind === "program")
        .map((robot) => robot.controller.entry),
    ),
  ];
  const loaded = await loadProject(input, new Map(), entries[0]);
  assert.ok(loaded.project, `${name}: ${JSON.stringify(loaded.diagnostics)}`);
  const { manifest, sources, assets } = loaded.project;
  if (external)
    for (const source of sources)
      unchangedInputs.set(path.join(directory, source.path), digest(source.content));
  if (!external)
    assert.deepEqual(
      manifest.assets,
      [],
      "The smoke lessons must have no host resource dependency.",
    );
  else
    assert.ok(
      entries.some((entry) => path.basename(entry) === "Main_Simple_L_2026.bp"),
      "The external scene must execute Main_Simple_L_2026.bp.",
    );
  const files = {};
  let assetBytes = 0;
  assert.ok(assets.length <= 64, "Simulation supports at most 64 resource files.");
  for (const asset of assets) {
    const bytes = await readFile(asset.absolutePath);
    assetBytes += bytes.length;
    assert.ok(assetBytes <= 1024 * 1024, "Simulation resource files exceed the 1 MiB limit.");
    files[asset.path.replaceAll("\\", "/")] = [...bytes];
  }
  // A nonexistent root proves this route consumes its captured source rather than
  // re-reading or committing anything into the original example project.
  const worker = new Worker(path.join(temporary, "build-worker.cjs"), {
    execArgv: [],
    workerData: {
      project: { root: path.join(temporary, "captured", name), manifest, sources, assets: [] },
      cancellation: new SharedArrayBuffer(4),
      simulation: { entries, files },
    },
  });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Compilation timed out: ${name}`)), 30_000);
      worker.once("error", reject);
      worker.once("exit", (code) => reject(new Error(`Compiler exited before its reply: ${code}`)));
      worker.on("message", (message) => {
        if (message.type === "simulation") resolve(message.result);
      });
    });
    assert.equal(result.success, true, `${name}: ${JSON.stringify(result.diagnostics)}`);
    assert.deepEqual(Object.keys(result.prepared.programs).sort(), entries.sort());
    console.log(`PASS bundled build worker preparation: ${name} (${entries.length} entries)`);
    return {
      name,
      scene,
      prepared: result.prepared,
      ...(external
        ? {
            mainSimple: {
              sources: sources.map((source) => source.path),
              entries,
              assetBytes,
              scenePath,
              sceneSha256: digest(sceneText),
              controller: scene.robots.find((robot) => robot.id === "A1").controller,
              stateLabels: sources
                .find((source) => source.path === "Main_Simple_L_2026.bp")
                .content.split(/\r?\n/)
                .flatMap((line, index) => {
                  const match = line.match(/^(State_[A-Z_]+):/);
                  return match ? [{ name: match[1], line: index + 1 }] : [];
                }),
            },
          }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

try {
  // Match tools/release/build-desktop.mjs, including its Node resolution conditions
  // and renderer's relative file:// asset base; no development server is involved.
  const user = await loadConfigFromFile(
    { command: "build", mode: "production" },
    path.join(desktop, "vite.build-worker.config.ts"),
  );
  await build(
    mergeConfig(
      {
        configFile: false,
        root: desktop,
        mode: "production",
        resolve: { conditions: ["node"], mainFields: ["module", "jsnext:main", "jsnext"] },
        build: {
          emptyOutDir: false,
          outDir: temporary,
          minify: true,
          lib: { entry: "src/main/workspace/build-worker.ts", formats: ["cjs"] },
          rollupOptions: {
            external: builtinModules.flatMap((name) => [name, `node:${name}`]),
            output: { entryFileNames: "build-worker.cjs", inlineDynamicImports: true },
          },
        },
      },
      user.config,
    ),
  );
  await build({
    configFile: path.join(desktop, "vite.renderer.config.ts"),
    root: desktop,
    base: "./",
    build: { outDir: renderer },
  });
  const candidates = [];
  for (const file of await readdir(path.join(renderer, "assets"))) {
    if (!/^worker-.*\.js$/.test(file)) continue;
    const content = await readFile(path.join(renderer, "assets", file), "utf8");
    if (content.includes("KOBRIXA-VISION") && content.includes("wro-double-tennis-2026"))
      candidates.push(`assets/${file}`);
  }
  assert.equal(candidates.length, 1, "Find exactly one production simulation worker asset.");
  const fixtures = [];
  for (const name of process.env.KOBRIXA_MAIN_SIMPLE_PROJECT ? ["Main_Simple_L_2026"] : names) {
    const fixture = await prepare(name);
    fixtures.push(fixture);
    if (fixture.mainSimple)
      fixtures.push({
        ...fixture,
        // Observe the 180 s route beyond the saved match limit. This must not
        // depend on a rule violation happening to enable practice continuation.
        scene: { ...fixture.scene, mode: "practice" },
        mainSimple: { ...fixture.mainSimple, startAtMs: 1700, durationMs: 180_000 },
      });
  }
  await writeFile(
    path.join(temporary, "fixtures.json"),
    JSON.stringify({ worker: candidates[0], fixtures }),
  );
  // Keep the production CSP verbatim while testing the worker without IPC fixtures
  // or mounting the application. The existing interaction suite covers the UI.
  const html = await readFile(path.join(renderer, "index.html"), "utf8");
  const csp = html.match(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/i)?.[0];
  assert.ok(csp, "Production renderer must declare its CSP.");
  await writeFile(
    path.join(renderer, "simulator-bundle-smoke.html"),
    `<!doctype html><html><head>${csp}<title>Offline simulator bundle smoke</title></head><body></body></html>`,
  );
  const child = spawn(
    process.execPath,
    [
      require.resolve("electron/cli.js"),
      fileURLToPath(new URL("./simulator-bundle-smoke.mjs", import.meta.url)),
      temporary,
    ],
    { stdio: "inherit" },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  assert.equal(code, 0, "Offline Electron simulation worker smoke failed.");
  for (const [file, before] of unchangedInputs)
    assert.equal(digest(await readFile(file)), before, `Smoke modified external input: ${file}`);
  passed = true;
} finally {
  if (passed && !process.env.KOBRIXA_SMOKE_KEEP_ARTIFACTS)
    await rm(temporary, { recursive: true, force: true });
  else console.log(`Simulator bundle smoke artifacts: ${temporary}`);
}
