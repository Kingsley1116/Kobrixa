import assert from "node:assert/strict";
import { access, readFile, writeFile, mkdir, mkdtemp, cp, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  verifyFoundationReports,
  verifyRunReceipt,
  diagnosticError,
} from "./plugin-persistence-harness.mjs";
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
export function missingCompositionExports(source) {
  return [
    "composeDesktopMain",
    "desktopFoundationTestHandles",
    "desktopUi",
    "desktopLifecycle",
  ].filter(
    (name) =>
      !new RegExp(String.raw`^[ \t]*export\s+(?:async\s+)?function\s+${name}\b`, "m").test(source),
  );
}
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
  for (const name of missingCompositionExports(controller))
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
// All process operations are controller-local. No product/composition adapter is injected.
// A detached POSIX child gets a private process group. Keep that group through reparenting,
// and pin birth identities so a reused PID cannot seed a foreign descendant tree.
export function createOwnedProcessTracker(parentPid) {
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0, "Missing owned parent PID");
  const owned = new Map(),
    births = new Map();
  let groupEnded = false;
  const key = (row) => `${row.pid}:${row.start}`;
  return {
    observe(rows) {
      const byPid = new Map();
      for (const row of rows) {
        assert.ok(
          Number.isSafeInteger(row.pid) &&
            row.pid >= 0 &&
            Number.isSafeInteger(row.ppid) &&
            row.ppid >= 0,
        );
        assert.ok(
          Number.isSafeInteger(row.pgid) &&
            row.pgid >= 0 &&
            typeof row.start === "string" &&
            row.start.length > 0,
        );
        assert.ok(!byPid.has(row.pid), "Duplicate process table PID");
        byPid.set(row.pid, row);
      }
      const parent = byPid.get(parentPid);
      if (parent && births.has(parentPid) && births.get(parentPid) !== parent.start)
        groupEnded = true;
      const retain = (row) => {
        if (births.has(row.pid) && births.get(row.pid) !== row.start) return false;
        births.set(row.pid, row.start);
        owned.set(key(row), { ...row });
        return true;
      };
      if (!groupEnded) {
        for (const row of rows) if (row.pgid === parentPid) retain(row);
        if (!rows.some((row) => row.pgid === parentPid)) groupEnded = true;
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const parent = byPid.get(row.ppid);
          if (parent && owned.has(key(parent)) && !owned.has(key(row))) {
            changed = retain(row) || changed;
          }
        }
      }
      return rows.filter((row) => owned.has(key(row)));
    },
    observed: () => [...owned.values()],
  };
}
export function parseProcessTable(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      assert.ok(match, "Invalid process identity row");
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        start: match[4],
      };
    });
}
function processTable() {
  if (process.platform === "win32")
    throw new Error("BLOCKED: Windows owned-process observer required");
  return parseProcessTable(
    execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C" },
    }),
  );
}
export async function superviseCase(
  config,
  io,
  { timeoutMs = 60000, pollMs = 100, settleMs = 5000 } = {},
) {
  let child,
    tracker,
    originalError,
    controllerError,
    candidate,
    entryFailure,
    observedExit,
    remaining = null;
  const cleanupErrors = [];
  let parentExit = { observed: false, pid: null, code: null, signal: null, at: null };
  const remember = (error) => {
    originalError ??= diagnosticError(error);
    controllerError ??= diagnosticError(error);
  };
  const updateExit = () => {
    const exit = child?.exit();
    if (exit && exit !== observedExit) {
      observedExit = exit;
      parentExit = {
        observed: !exit.error,
        pid: child.pid ?? null,
        code: exit.code ?? null,
        signal: exit.signal ?? null,
        at: exit.at ?? io.now(),
      };
      if (exit.error) remember(exit.error);
    }
    return exit;
  };
  const observe = async () => {
    try {
      remaining = tracker ? tracker.observe(await io.processes()) : [];
    } catch (error) {
      remaining = null;
      cleanupErrors.push(diagnosticError(error));
      remember(error);
    }
    updateExit();
    return remaining;
  };
  const terminateOwned = async () => {
    const live = await observe();
    // While the direct child has not exited, its original process-group ID cannot
    // have been recycled. After exit require a current, still-owned group member.
    const group = tracker && (!child.exit() || live?.some((row) => row.pgid === child.pid));
    if (group)
      try {
        await io.killGroup(
          child.pid,
          live?.filter((row) => row.pgid === child.pid) ?? [],
          !child.exit(),
        );
      } catch (error) {
        cleanupErrors.push(diagnosticError(error));
      }
    for (const row of live ?? [])
      if (row.pgid !== child.pid) {
        try {
          await io.killProcess(row);
        } catch (error) {
          cleanupErrors.push(diagnosticError(error));
        }
      }
  };
  try {
    child = await io.start();
    parentExit.pid = child.pid ?? null;
    tracker = createOwnedProcessTracker(child.pid);
    const deadline = io.now() + timeoutMs;
    while (!updateExit()) {
      await observe();
      if (originalError) break;
      if (io.now() >= deadline) throw new Error("Electron timeout; profile retained");
      await io.sleep(pollMs);
    }
    updateExit();
    if (parentExit.observed && (parentExit.code !== 0 || parentExit.signal !== null))
      throw new Error(`Electron exited ${parentExit.code} (${parentExit.signal ?? "no signal"})`);
  } catch (error) {
    remember(error);
  }
  // Common finalization for timeout, nonzero/signal exit, spawn/observation failure,
  // malformed candidate, failed fixture close and normal completion alike.
  try {
    ({ candidate, entryFailure } = await io.readCandidate());
    if (entryFailure) {
      originalError = entryFailure.originalError;
      cleanupErrors.push(...entryFailure.cleanupErrors);
    }
    if (!originalError && !candidate) remember(new Error("Missing case candidate"));
  } catch (error) {
    remember(error);
  }
  if (originalError) await terminateOwned();
  const settle = async () => {
    const deadline = io.now() + settleMs;
    await observe();
    while (io.now() < deadline) {
      await io.sleep(Math.min(pollMs, deadline - io.now()));
      await observe();
    }
  };
  await settle();
  if (remaining?.length || (child && !parentExit.observed)) {
    remember(new Error("Owned processes remain after parent exit/cleanup"));
    await terminateOwned();
    await settle();
  }
  if (cleanupErrors.length && !originalError)
    remember(new Error("Process cleanup/observation failed"));
  let receipt;
  if (!originalError)
    try {
      assert.equal(candidate.pid, child.pid);
      assert.equal(candidate.status, "closed-reference");
      receipt = {
        ...candidate,
        status: "passed",
        exitCode: parentExit.code,
        signal: parentExit.signal,
        exitedAt: parentExit.at,
        reportedAt: io.now(),
        cleanup: { ...candidate.cleanup, children: remaining.length },
        observedDescendants: tracker.observed().filter((row) => row.pid !== child.pid),
      };
      verifyRunReceipt(
        receipt,
        Object.fromEntries(
          ["runId", "case", "bundleSha256", "artifactSha256", "commit"]
            .filter((key) => config[key] !== undefined)
            .map((key) => [key, config[key]]),
        ),
      );
    } catch (error) {
      remember(error);
    }
  if (originalError) {
    const failure = {
      format: 1,
      kind: "persistence-controller-failure",
      status: "failed",
      runId: config.runId,
      case: config.case,
      profile: config.profile,
      profileRetained: true,
      originalError,
      controllerError,
      parentExit,
      remainingChildren: remaining?.filter((row) => row.pid !== child?.pid) ?? null,
      observedProcesses: tracker?.observed() ?? [],
      cleanupErrors,
      entryFailure,
      reportedAt: io.now(),
    };
    try {
      await io.writeFailure(failure);
    } catch (error) {
      cleanupErrors.push(diagnosticError(error));
      io.reportFailure(failure);
    }
    const error = new Error(originalError.message);
    error.diagnostic = failure;
    throw error;
  }
  return receipt;
}
async function launchCase(electron, entry, configFile, reportFile, config) {
  return superviseCase(config, {
    now: Date.now,
    async start() {
      if (process.platform === "win32")
        throw new Error("BLOCKED: Windows owned-process observer required");
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(electron, [entry, `--persistence-config=${configFile}`], {
        stdio: "inherit",
        env,
        detached: true,
      });
      let exit;
      child.once("exit", (code, signal) => {
        exit = { code, signal, at: Date.now() };
      });
      return new Promise((resolve, reject) => {
        child.once("error", (error) => {
          exit = { error, at: Date.now() };
          reject(error);
        });
        child.once("spawn", () => resolve({ pid: child.pid, exit: () => exit }));
      });
    },
    processes: async () => processTable(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async killGroup(pgid, identities, parentAlive) {
      if (!parentAlive) {
        const current = processTable().filter((row) => row.pgid === pgid);
        if (!current.length) return;
        assert.ok(
          current.some((row) =>
            identities.some((old) => row.pid === old.pid && row.start === old.start),
          ),
          "Owned process group identity changed; refusing to signal it",
        );
      }
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    },
    async killProcess(identity) {
      // Recheck the birth identity immediately before signalling an escaped-group descendant.
      const current = processTable().find((row) => row.pid === identity.pid);
      if (!current || current.start !== identity.start) return;
      try {
        process.kill(identity.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    },
    async readCandidate() {
      const read = async (file) => {
        try {
          return JSON.parse(await readFile(file, "utf8"));
        } catch (error) {
          if (error.code === "ENOENT") return undefined;
          throw error;
        }
      };
      const entryFailure = await read(`${reportFile}.entry-failure.json`);
      if (entryFailure) {
        assert.equal(entryFailure.status, "failed");
        assert.equal(entryFailure.runId, config.runId);
        assert.ok(typeof entryFailure.originalError?.message === "string");
        assert.ok(Array.isArray(entryFailure.cleanupErrors));
        // A partial candidate must not mask the entry's already-recorded original error.
        return { entryFailure };
      }
      return { candidate: await read(reportFile) };
    },
    writeFailure: (failure) =>
      writeFile(`${reportFile}.controller-failure.json`, JSON.stringify(failure, null, 2), {
        flag: "wx",
      }),
    reportFailure: (failure) => console.error(JSON.stringify(failure)),
  });
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
import {runReferenceEntry} from ${JSON.stringify(path.join(root, "tests/desktop/plugin-persistence-harness.mjs"))};
const config=JSON.parse(await readFile(process.argv.find(a=>a.startsWith('--persistence-config=')).slice(21),'utf8'));
app.setPath('userData',config.profile);
const code=await runReferenceEntry(createFoundationFixture,config,{write:writeFile,now:Date.now,pid:process.pid,
 reportFailure:failure=>console.error(JSON.stringify(failure))});
app.exit(code);
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
    const receipt = await launchCase(electron, entry, configFile, report, config);
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
