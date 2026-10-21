import assert from "node:assert/strict";
import { access, readFile, writeFile, mkdir, mkdtemp, cp, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { verifyFoundationReports, verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// These are dependency locations, not permission to edit another owner's source.
export const PREREQUISITES = Object.freeze([
  ["A/D170", "apps/desktop/src/main/plugins/profile-writer-lock.ts"],
  ["A/D170", "apps/desktop/src/main/device-broker/authority-context.ts"],
  ["A/D170", "apps/desktop/src/main/device-broker/journal.ts"],
  ["A/D170", "apps/desktop/src/main/device-broker/journal-filesystem.ts"],
  ["B1/D170", "apps/desktop/src/main/plugins/ui-bridge.ts"],
  ["B1", "packages/plugin-runtime/src/ui-state.ts"],
  ["B1-T9", "tests/desktop/declarative-ui-browser.ts"],
  ["B1-T9", "tests/desktop/fixtures/builtin-process/kobrixa-plugin.json"],
  ["K160/K170", "apps/desktop/vite.plugin.config.ts"],
  ["K160/K170", "apps/desktop/src/main/plugins/builtin-launch.ts"],
]);
export async function preflight(receiptPath = process.env.PERSISTENCE_HANDOFFS) {
  const blockers = [];
  for (const [owner, file] of PREREQUISITES)
    try {
      await access(path.join(root, file));
    } catch {
      blockers.push(`${owner}: missing ${file}`);
    }
  const controller = await readFile(
    path.join(root, "apps/desktop/src/main/plugins/controller.ts"),
    "utf8",
  );
  for (const name of [
    "composeDesktopMain",
    "desktopFoundationTestHandles",
    "desktopUi",
    "desktopLifecycle",
  ])
    if (!new RegExp(`export (?:async )?function ${name}\b`).test(controller))
      blockers.push(`D170: missing implemented ${name}`);
  const protocol = await readFile(
    path.join(root, "packages/plugin-protocol/src/limits.ts"),
    "utf8",
  );
  if (!/1\.7\.0/.test(protocol)) blockers.push("P170: public API 1.7.0 publication not attached");
  let handoffs;
  if (!receiptPath)
    blockers.push(
      "PERSISTENCE_HANDOFFS: missing P170/R170/D170/V170/K170/B1-T9 stopped-owner receipts",
    );
  else {
    handoffs = JSON.parse(await readFile(receiptPath, "utf8"));
    for (const owner of ["P170", "R170", "D170", "V170", "K170", "B1-T9"]) {
      const r = handoffs[owner];
      if (!r || r.stopped !== true || !/^[0-9a-f]{40}$/.test(r.commit ?? ""))
        blockers.push(`Missing valid ${owner} stopped-owner receipt`);
    }
    for (const owner of ["D170", "K170"])
      for (const file of [
        "tests/desktop/plugin-persistence-main.ts",
        "tests/desktop/plugin-persistence-run.mjs",
      ])
        if (!handoffs[owner]?.returnedPaths?.includes(file))
          blockers.push(`${owner} must return ${file}`);
    // No source replacement or product adapter injection is accepted.
    for (const field of ["rendererUrl", "preload", "filesystem"])
      if (typeof handoffs[field] !== "string" || !handoffs[field])
        blockers.push(`Missing artifact ${field}`);
    // Final native mounting/collector review cannot be guessed against F declarations.
    if (handoffs.nativeMountsReviewed !== true)
      blockers.push("D170/V170: review and attach native settings/recovery mounts in T7 shell");
  }
  if (blockers.length) throw new Error(`BLOCKED authoring acceptance:\n${blockers.join("\n")}`);
  return handoffs;
}
async function materialize(buildRoot, build) {
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const { build: viteBuild } = desktopRequire("vite");
  const configBundle = path.join(buildRoot, "builtin-config.cjs");
  await build({
    entryPoints: [path.join(root, "apps/desktop/vite.plugin.config.ts")],
    outfile: configBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    banner: {
      js: `module.paths.push(${JSON.stringify(path.join(root, "node_modules"))},${JSON.stringify(path.join(root, "apps/desktop/node_modules"))});`,
    },
  });
  const { builtinPluginConfig } = desktopRequire(configBundle);
  const template = path.join(root, "tests/desktop/fixtures/builtin-process");
  const fixture = path.join(root, "tests/desktop/fixtures/plugin-persistence");
  for (const role of ["recording", "settings"]) {
    const id = `acceptance.ui-${role}`,
      slug = `acceptance-builtin-${role}`,
      sourceRoot = path.join(buildRoot, "sources", slug);
    await cp(template, sourceRoot, { recursive: true });
    const rewrite = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await rewrite(file);
        else if (/\.(json|ts)$/.test(entry.name))
          await writeFile(file, (await readFile(file, "utf8")).replaceAll("acceptance.ui", id));
      }
    };
    await rewrite(sourceRoot);
    const manifest = JSON.parse(
      await readFile(path.join(sourceRoot, "kobrixa-plugin.json"), "utf8"),
    );
    const persistence = JSON.parse(
      await readFile(path.join(fixture, "kobrixa-plugin.json"), "utf8"),
    );
    manifest.apiVersion = "^1.7.0";
    manifest.runtime = { kind: "node", entry: "main.cjs" };
    manifest.permissions = [...new Set([...manifest.permissions, ...persistence.permissions])];
    manifest.contributes.settings = persistence.contributes.settings;
    manifest.contributes.commands.push(
      ...persistence.contributes.commands.map((command) => ({ ...command, id: `${id}.run` })),
    );
    if (role === "recording") {
      manifest.permissions = [
        ...new Set([...manifest.permissions, "devices.read", "devices.connect"]),
      ];
      manifest.requires = {
        ...manifest.requires,
        devices: [{ capability: "recordingReservation.v1", required: true }],
      };
    }
    await writeFile(
      path.join(sourceRoot, "kobrixa-plugin.json"),
      JSON.stringify(manifest, null, 2),
    );
    await cp(path.join(fixture, "settings.json"), path.join(sourceRoot, "settings.json"));
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await cp(path.join(fixture, "consumer.ts"), path.join(sourceRoot, "src/main.ts"));
    const config = builtinPluginConfig({ slug, pluginId: id, sourceRoot });
    await viteBuild({
      ...config,
      configFile: false,
      build: { ...config.build, outDir: path.join(buildRoot, "plugins", slug) },
    });
  }
}
function processTable() {
  // Controller-only process observation; no PID is inferred from worker/main identity.
  if (process.platform === "win32")
    throw new Error("BLOCKED: Windows installed child-tree observer receipt required");
  return execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number));
}
async function launchCase(electron, entry, configFile, reportFile) {
  const child = spawn(electron, [entry, `--persistence-config=${configFile}`], {
    stdio: "inherit",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
  });
  const descendants = new Set();
  let observationError;
  const observe = () => {
    try {
      const table = processTable(),
        parents = new Set([child.pid, ...descendants]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, ppid] of table)
          if (parents.has(ppid) && !parents.has(pid)) {
            parents.add(pid);
            descendants.add(pid);
            changed = true;
          }
      }
    } catch (error) {
      observationError = error;
    }
  };
  const poll = setInterval(observe, 100);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 60000);
  let exitCode, signal;
  try {
    [exitCode, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, sig) => resolve([code, sig]));
    });
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
  }
  const exitedAt = Date.now();
  if (observationError) throw observationError;
  assert.equal(timedOut, false, "Electron timeout; profile retained");
  assert.equal(exitCode, 0);
  assert.equal(signal, null);
  // Required five-second post-exit observation, outside Electron's profile lifetime.
  await new Promise((resolve) => setTimeout(resolve, 5000));
  const remaining = new Set(processTable().map(([pid]) => pid));
  const leaked = [...descendants].filter((pid) => remaining.has(pid));
  assert.deepEqual(leaked, [], "Child process leak");
  const candidate = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(candidate.pid, child.pid);
  assert.equal(candidate.status, "closed-reference");
  const receipt = {
    ...candidate,
    status: "passed",
    exitCode,
    signal,
    exitedAt,
    reportedAt: Date.now(),
    cleanup: { ...candidate.cleanup, children: leaked.length },
    observedDescendants: [...descendants],
  };
  verifyRunReceipt(receipt);
  return receipt;
}
export async function runFoundationEvidence({ referencesOnly = false } = {}) {
  const handoffs = await preflight();
  if (!referencesOnly)
    throw new Error(
      "BLOCKED: thirteen observation-table producers, B2-N01–29, public parity, load/import and installed trials await controller continuation",
    );
  const output = process.env.PERSISTENCE_EVIDENCE;
  assert.ok(
    output && path.isAbsolute(output),
    "PERSISTENCE_EVIDENCE must be an absolute retained report path",
  );
  const { build } = await import("esbuild");
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-persistence-"));
  const buildRoot = path.join(directory, "build");
  await mkdir(buildRoot);
  // Failed artifacts/profiles are retained for diagnosis; no profile deletion while a process is alive.
  await materialize(buildRoot, build);
  const alias = {
    "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
    "@kobrixa/plugin-runtime": path.join(root, "packages/plugin-runtime/src/index.ts"),
    "@kobrixa/plugin-sdk": path.join(root, "packages/plugin-sdk-js/src/index.ts"),
  };
  const bundle = async (entry, outfile) =>
    build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      platform: "node",
      format: "cjs",
      alias,
      external: ["electron"],
      plugins: [rawResourcePlugin()],
    });
  const syntheticRoot = path.join(directory, "synthetic");
  await mkdir(syntheticRoot);
  const workerSource = path.join(directory, "worker.ts"),
    workerEntry = path.join(buildRoot, "worker.cjs");
  await writeFile(
    workerSource,
    `import {runSyntheticPersistenceWorker} from ${JSON.stringify(path.join(root, "tests/desktop/fixtures/plugin-persistence/kill-worker.mjs"))};\nrunSyntheticPersistenceWorker(new Map([['test.synthetic-import',${JSON.stringify(syntheticRoot)}]]));\n`,
  );
  await bundle(workerSource, workerEntry);
  const source = path.join(directory, "entry.ts"),
    entry = path.join(buildRoot, "main.cjs");
  await writeFile(
    source,
    `import {app} from 'electron';
import {readFile,writeFile} from 'node:fs/promises';
import {createFoundationFixture} from ${JSON.stringify(path.join(root, "tests/desktop/plugin-persistence-main.ts"))};
const config=JSON.parse(await readFile(process.argv.find(a=>a.startsWith('--persistence-config=')).slice(21),'utf8'));
app.setPath('userData',config.profile);
let fixture;
try {
 fixture=await createFoundationFixture();
 const started=fixture.composition.workerCount;
 const evidence=await fixture.runCase(config.case);
 await fixture.close();await fixture.close();
 const workers=fixture.composition.workerCount,listeners=fixture.composition.reservationListenerCount;
 await writeFile(config.report,JSON.stringify({format:1,level:'real-process',status:'closed-reference',
 runId:config.runId,case:config.case,commit:config.commit,bundleSha256:config.bundleSha256,artifactSha256:config.artifactSha256,
 pid:process.pid,profileId:config.profileId,hostEpoch:fixture.composition.profile.hostEpoch,
 environment:fixture.environment,evidence,closedAt:Date.now(),cleanup:{workers,listeners,errors:[]},
 workerTrace:[{kind:'start',count:started,pid:process.pid},{kind:'exit',count:workers,pid:process.pid}]}));
 app.exit(0);
} catch(error) { console.error(error);if(fixture)try{await fixture.close();}catch(cleanup){console.error(cleanup);}app.exit(1); }
`,
  );
  // CJS build wraps the entry's awaits without changing the inert producer.
  await writeFile(
    source,
    (await readFile(source, "utf8")).replace("const config=", "void (async()=>{\nconst config=") +
      "\n})();\n",
  );
  await bundle(source, entry);
  const bundleSha256 = digest(await readFile(entry)),
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const artifactSha256 = digest(
    Buffer.concat([
      await readFile(entry),
      await readFile(workerEntry),
      await readFile(
        path.join(buildRoot, "plugins/acceptance-builtin-recording/resource-index.json"),
      ),
      await readFile(
        path.join(buildRoot, "plugins/acceptance-builtin-settings/resource-index.json"),
      ),
    ]),
  );
  const electron = createRequire(path.join(root, "apps/desktop/package.json"))("electron");
  const reports = [];
  for (const id of ["retirement", "healthy-release"]) {
    const profile = await mkdtemp(path.join(directory, `${id}-`)),
      report = path.join(directory, `${id}.candidate.json`),
      configFile = path.join(directory, `${id}.json`);
    const config = {
      case: id,
      profile,
      profileId: randomUUID(),
      runId: randomUUID(),
      report,
      commit,
      artifact: entry,
      artifactSha256,
      bundleSha256,
      buildRoot,
      workerEntry,
      rendererUrl: handoffs.rendererUrl,
      preload: handoffs.preload,
      filesystem: handoffs.filesystem,
    };
    await writeFile(configFile, JSON.stringify(config));
    const receipt = await launchCase(electron, entry, configFile, report);
    verifyRunReceipt(receipt, {
      runId: config.runId,
      case: id,
      bundleSha256,
      artifactSha256,
      commit,
    });
    reports.push(receipt);
  }
  verifyFoundationReports(reports, ["retirement", "healthy-release"]);
  const result = {
    format: 1,
    level: "real-process",
    status: "reference-only",
    reports,
    artifact: entry,
    bundleSha256,
    artifactSha256,
    blocked: [
      "full foundation matrix",
      "public JS/Python parity",
      "load",
      "import/restart",
      "installed",
      "manual/hardware",
    ],
  };
  await writeFile(output, JSON.stringify(result, null, 2), { flag: "wx" });
  return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes("--preflight")) await preflight();
    else await runFoundationEvidence({ referencesOnly: process.argv.includes("--references") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
