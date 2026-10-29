import { assertImportSlice, originalFiles, IMPORT_SLICE } from "./plugin-persistence-import.ts";
import { approvedHost, pins, versions } from "./plugin-persistence-compatibility.ts";
import { assertOptionalPhaseReceipt } from "./plugin-persistence-optional-off.ts";
import assert from "node:assert/strict";
import {
  access,
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  cp,
  readdir,
  realpath,
  lstat,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  verifyFoundationReports,
  verifyRunReceipt,
  diagnosticError,
} from "./plugin-persistence-harness.mjs";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
import { readFoundationRenderer } from "./plugin-persistence-renderer-build.mjs";
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
  const hostVersion = /PLUGIN_API_VERSION = "([^"]+)"/.exec(protocol)?.[1];
  try {
    approvedHost(hostVersion);
  } catch {
    blockers.push("Unapproved/missing host API publication");
  }
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
    if (typeof handoffs.rendererArtifact !== "string")
      blockers.push("Missing retained renderer artifact receipt");
    else {
      const renderer = await readFoundationRenderer(handoffs.rendererArtifact);
      assert.equal(handoffs.rendererUrl, renderer.rendererUrl);
      assert.equal(handoffs.preload, renderer.preload);
    }
    // Final native mounting/collector review cannot be guessed against F declarations.
    if (handoffs.nativeMountsReviewed !== true)
      blockers.push("D170/V170: review and attach native settings/recovery mounts in T7 shell");
  }
  if (blockers.length) throw new Error(`BLOCKED authoring acceptance:\n${blockers.join("\n")}`);
  return handoffs;
}
export async function materializeFoundationFixtures(
  buildRoot,
  build,
  contention = false,
  actionReplay = false,
) {
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const { build: viteBuild } = desktopRequire("vite");
  const configBundle = path.join(buildRoot, "builtin-config.cjs");
  await build({
    entryPoints: [path.join(root, "apps/desktop/vite.plugin.config.ts")],
    outfile: configBundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    define: {
      // Config URLs describe checkout sources, not the temporary CJS bundle.
      "import.meta.url": JSON.stringify(
        pathToFileURL(path.join(root, "apps/desktop/vite.plugin.config.ts")).href,
      ),
    },
  });
  const { builtinPluginConfig } = desktopRequire(configBundle);
  const template = path.join(root, "tests/desktop/fixtures/builtin-process");
  const templateId = JSON.parse(
    await readFile(path.join(template, "kobrixa-plugin.json"), "utf8"),
  ).id;
  assert.ok(typeof templateId === "string" && templateId.length > 0);
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
          await writeFile(file, (await readFile(file, "utf8")).replaceAll(templateId, id));
      }
    };
    await rewrite(sourceRoot);
    if (actionReplay) {
      // This case needs two distinct trusted UI commands through the real generic
      // form path. The ordinary reference payload intentionally has no fields.
      const panelPath = path.join(sourceRoot, "panel.json");
      const panel = JSON.parse(await readFile(panelPath, "utf8"));
      panel.fields.speed = {
        schema: { type: "number", min: -100, max: 100, integer: true, nullable: false },
        initial: 20,
        required: true,
      };
      panel.nodes.find((node) => node.id === panel.root).children.unshift("speed");
      panel.nodes.push({
        id: "speed",
        type: "number",
        field: "speed",
        label: { en: "Action selection" },
        step: 1,
      });
      panel.nodes.find((node) => node.id === "run").action.arguments.speed = {
        ref: { scope: "form", key: "speed" },
      };
      await writeFile(panelPath, JSON.stringify(panel, null, 2));
    }
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
    for (const step of ["seed", "publish", "probe", "reconcile"])
      manifest.contributes.commands.push({
        id: `${id}.unknown-${step}`,
        title: { en: `Unknown publication ${step}`, "zh-TW": `未知發布 ${step}` },
      });
    if (role === "recording")
      manifest.contributes.commands.push({
        id: `${id}.optional-off-seed`,
        title: { en: "Optional-off seed" },
      });
    if (role === "recording")
      manifest.contributes.commands.push({
        id: `${id}.renderer-seed`,
        title: { en: "Renderer loss seed" },
      });
    for (const step of ["chunk", "commit"])
      manifest.contributes.commands.push({
        id: `${id}.action-${step}`,
        title: { en: `Action ${step}` },
      });
    if (role === "recording")
      for (const step of [
        "seed-sealed",
        "drain-sealed",
        "status",
        "expired",
        "read-sealed",
        "seed-incomplete",
        "drain-incomplete",
        "read-incomplete",
        "cleanup",
      ])
        manifest.contributes.commands.push({
          id: `${id}.ttl-${step}`,
          title: { en: `TTL ${step}` },
        });
    if (actionReplay && role === "recording")
      manifest.contributes.commands.push({
        id: `${id}.action-checkpoint-only`,
        title: { en: "Prepare checkpoint recovery" },
      });
    if (role === "recording" || contention) {
      manifest.permissions = [
        ...new Set([
          ...manifest.permissions,
          "devices.read",
          "devices.connect",
          ...(contention ? ["devices.control"] : []),
        ]),
      ];
      manifest.requires = {
        ...manifest.requires,
        devices: [
          { capability: "recordingReservation.v1", required: true },
          ...(contention ? [{ capability: "finiteMotion.v1", required: true }] : []),
        ],
      };
    }
    await writeFile(
      path.join(sourceRoot, "kobrixa-plugin.json"),
      JSON.stringify(manifest, null, 2),
    );
    await cp(path.join(fixture, "settings.json"), path.join(sourceRoot, "settings.json"));
    await mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await cp(path.join(fixture, "consumer.ts"), path.join(sourceRoot, "src/main.ts"));
    await cp(
      path.join(fixture, "sealed-ttl-consumer.ts"),
      path.join(sourceRoot, "src/sealed-ttl-consumer.ts"),
    );
    await cp(
      path.join(fixture, "optional-off-consumer.ts"),
      path.join(sourceRoot, "src/optional-off-consumer.ts"),
    );
    const config = builtinPluginConfig({ slug, pluginId: id, sourceRoot });
    await viteBuild({
      ...config,
      configFile: false,
      resolve: { ...config.resolve, conditions: ["node"] },
      build: {
        ...config.build,
        lib: { entry: path.join(sourceRoot, "src/main.ts"), formats: ["cjs"] },
        rollupOptions: {
          ...config.build.rollupOptions,
          external: builtinModules.flatMap((name) => [name, `node:${name}`]),
        },
        outDir: path.join(buildRoot, "plugins", slug),
      },
    });
  }
}
// All process operations are controller-local. No product/composition adapter is injected.
// A detached POSIX child gets a private process group. Keep that group through reparenting,
// and pin birth identities so a reused PID cannot seed a foreign descendant tree.
export function createOwnedProcessTracker(parentPid) {
  assert.ok(Number.isSafeInteger(parentPid) && parentPid > 0, "Missing owned parent PID");
  const owned = new Map();
  let parentBirth,
    observedGroup = false,
    groupEnded = false;
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
      if (parent && !observedGroup) parentBirth = parent.start;
      if (parent && parentBirth !== undefined && parentBirth !== parent.start) groupEnded = true;
      const retain = (row) => {
        owned.set(key(row), { ...row });
      };
      if (!groupEnded) {
        const group = rows.filter((row) => row.pgid === parentPid);
        if (!group.length) groupEnded = true;
        else {
          // A fresh identity needs current ownership proof, not historical PID
          // equality. Without a surviving member, group-number reuse is ambiguous.
          if (observedGroup && !group.some((row) => owned.has(key(row)))) {
            groupEnded = true;
            throw new Error("Owned process group identity is unresolved");
          }
          for (const row of group) retain(row);
        }
      }
      observedGroup = true;
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          const parent = byPid.get(row.ppid);
          if (parent && owned.has(key(parent)) && !owned.has(key(row))) {
            retain(row);
            changed = true;
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
  let expectedImportKill = false;
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
      if (
        config.case === "import-restart" &&
        config.importPhase === "kill" &&
        !expectedImportKill
      ) {
        const paused = await io.readCandidate();
        if (paused.entryFailure) throw new Error("Import entry failed before boundary");
        if (paused.candidate) {
          assert.equal(paused.candidate.status, "paused-import");
          assert.equal(paused.candidate.runId, config.runId);
          for (const key of ["profileId", "commit", "artifactSha256", "bundleSha256"])
            assert.equal(paused.candidate[key], config[key]);
          assert.equal(paused.candidate.pid, child.pid);
          const o = paused.candidate.evidence.importSlice;
          assert.equal(o.phase, "kill");
          assert.equal(o.slice, IMPORT_SLICE);
          assert.ok(o.trace.some((t) => t.point === "after-publish" && t.ticket === o.ticket.id));
          expectedImportKill = true;
          await terminateOwned();
        }
      }
      if (io.now() >= deadline) throw new Error("Electron timeout; profile retained");
      await io.sleep(pollMs);
    }
    updateExit();
    if (
      parentExit.observed &&
      !(expectedImportKill && parentExit.signal === "SIGKILL") &&
      (parentExit.code !== 0 || parentExit.signal !== null)
    )
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
  if (!originalError && expectedImportKill) {
    assert.equal(parentExit.signal, "SIGKILL");
    assert.equal(remaining.length, 0);
    return {
      ...candidate,
      status: "killed-import",
      exitCode: parentExit.code,
      signal: parentExit.signal,
      exitedAt: parentExit.at,
      cleanup: { children: remaining.length, errors: cleanupErrors },
      observedProcesses: tracker.observed(),
    };
  }
  let receipt;
  if (!originalError)
    try {
      assert.equal(candidate.pid, child.pid);
      assert.equal(
        candidate.status,
        config.case === "all-optional-off" && config.optionalPhase === "seed"
          ? "retained-phase"
          : config.case === "all-optional-off" && config.optionalPhase === "settings"
            ? "closed-phase"
            : ["retirement", "healthy-release"].includes(config.case)
              ? "closed-reference"
              : "closed-case",
      );
      receipt = {
        ...candidate,
        status:
          config.case === "all-optional-off" && config.optionalPhase === "seed"
            ? "retained-exit"
            : config.case === "all-optional-off" && config.optionalPhase === "settings"
              ? "passed-phase"
              : "passed",
        exitCode: parentExit.code,
        signal: parentExit.signal,
        exitedAt: parentExit.at,
        reportedAt: io.now(),
        cleanup: { ...candidate.cleanup, children: remaining.length },
        observedDescendants: tracker.observed().filter((row) => row.pid !== child.pid),
      };
      const verify =
        config.case === "all-optional-off" && ["seed", "settings"].includes(config.optionalPhase)
          ? assertOptionalPhaseReceipt
          : verifyRunReceipt;
      verify(
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
export async function readEntryFailure(reportFile, read) {
  let finalError;
  try {
    const final = await read(`${reportFile}.entry-failure.json`);
    if (final) return final;
  } catch (error) {
    finalError = error;
  }
  const pending = await read(`${reportFile}.entry-failure-pending.json`);
  if (pending) {
    if (finalError) pending.cleanupErrors.push(diagnosticError(finalError));
    return pending;
  }
  if (finalError) throw finalError;
}
async function launchCase(electron, entry, configFile, reportFile, config) {
  return superviseCase(
    config,
    {
      now: Date.now,
      async start() {
        if (process.platform === "win32")
          throw new Error("BLOCKED: Windows owned-process observer required");
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        if (config.case === "all-optional-off") {
          env.PERSISTENCE_OPTIONAL_MAPPER_LOG = config.mapperLog;
          env.PERSISTENCE_OPTIONAL_RUN_ID = config.runId;
        }
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
        const entryFailure = await readEntryFailure(reportFile, read);
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
    },
    config.case === "import-restart"
      ? { timeoutMs: 300000 }
      : ["sealed-ttl", "compatibility"].includes(config.case)
        ? { timeoutMs: 120000 }
        : undefined,
  );
}
export function selectFoundationCases({ referencesOnly = false, caseId } = {}) {
  assert.ok(!(referencesOnly && caseId), "--references and --case are mutually exclusive");
  if (referencesOnly) return ["retirement", "healthy-release"];
  if (
    [
      "registration-end",
      "contention",
      "suspend-wake",
      "disconnect-retry",
      "sealed-ttl",
      "unknown-publication",
      "action-replay",
      "renderer-loss",
      "all-optional-off",
      "compatibility",
      "import-restart",
    ].includes(caseId)
  )
    return [caseId];
  if (caseId) throw new Error(`BLOCKED: unsupported case ${caseId}`);
  throw new Error(
    "BLOCKED: remaining observation-table producers, B2-N01–29, public parity, load/import and installed trials await controller continuation",
  );
}
export async function runFoundationEvidence({ referencesOnly = false, caseId, importTrial } = {}) {
  if (caseId === "import-restart")
    assert.equal(
      importTrial,
      IMPORT_SLICE,
      "RF5 incomplete: use explicit --import-trial head-before-receipt",
    );
  const selectedCases = selectFoundationCases({ referencesOnly, caseId });
  const handoffs = await preflight();
  const renderer = await readFoundationRenderer(handoffs.rendererArtifact);
  const output = process.env.PERSISTENCE_EVIDENCE;
  assert.ok(
    output && path.isAbsolute(output),
    "PERSISTENCE_EVIDENCE must be an absolute retained report path",
  );
  const { build } = await import("esbuild");
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-persistence-")));
  const buildRoot = path.join(directory, "build");
  await mkdir(buildRoot);
  // Failed artifacts/profiles are retained for diagnosis; no profile deletion while a process is alive.
  await materializeFoundationFixtures(
    buildRoot,
    build,
    selectedCases.some(
      (id) =>
        id === "contention" ||
        id === "suspend-wake" ||
        id === "disconnect-retry" ||
        id === "renderer-loss",
    ),
    selectedCases.some((id) => id === "action-replay" || id === "renderer-loss"),
  );
  let compatibility;
  if (selectedCases.includes("compatibility")) {
    const { legacyFixtures } = await import("./declarative-ui-legacy-fixtures.mjs");
    const currentCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const hostVersion = /PLUGIN_API_VERSION = "([^"]+)"/.exec(
      await readFile(path.join(root, "packages/plugin-protocol/src/limits.ts"), "utf8"),
    )?.[1];
    approvedHost(hostVersion);
    compatibility = { hostVersion, currentCommit, sources: [], cases: [], artifacts: [] };
    for (const [slot, revision] of [...pins, currentCommit].entries()) {
      const target = path.join(buildRoot, `compatibility-${slot}`);
      await mkdir(target);
      const result = await legacyFixtures(target, {
        revision,
        sdkVersion: versions[slot] ?? hostVersion,
        slot,
      });
      compatibility.python ??= result.python;
      assert.equal(compatibility.python, result.python);
      compatibility.sources.push(...result.sources);
      compatibility.cases.push(...result.provenance.cases);
      for (const file of result.artifacts) {
        const absolute = path.join(target, file);
        compatibility.artifacts.push({ path: absolute, sha256: digest(await readFile(absolute)) });
      }
    }
    const generations = [];
    for (const generation of [1, 2]) {
      const serializer = path.join(buildRoot, `schema-${generation}.cjs`);
      await build({
        stdin: {
          contents: `import {serializeJsonSchema} from ${JSON.stringify(path.join(root, "packages/plugin-protocol/src/json-schema.ts"))}; process.stdout.write(serializeJsonSchema());`,
          resolveDir: root,
        },
        outfile: serializer,
        bundle: true,
        platform: "node",
        format: "cjs",
      });
      const bytes = execFileSync(process.execPath, [serializer], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      await writeFile(path.join(buildRoot, `schema-${generation}.json`), bytes, { flag: "wx" });
      generations.push(bytes);
    }
    compatibility.schema = {
      first: generations[0],
      second: generations[1],
      protocol: await readFile(
        path.join(root, "packages/plugin-protocol/schema/plugin-protocol.schema.json"),
        "utf8",
      ),
      python: await readFile(
        path.join(root, "sdks/python/kobrixa/plugin-protocol.schema.json"),
        "utf8",
      ),
    };
    assert.ok(Object.values(compatibility.schema).every((value) => value === generations[0]));
  }
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
      external: ["electron", "node-hid", "usb"],
      plugins: [
        rawResourcePlugin(),
        {
          name: "preserve-packaging-source-url",
          setup(builder) {
            builder.onLoad(
              { filter: /[/\\]apps[/\\]desktop[/\\]packaging\.ts$/ },
              async ({ path: file }) => ({
                contents: (await readFile(file, "utf8")).replaceAll(
                  "import.meta.url",
                  JSON.stringify(pathToFileURL(file).href),
                ),
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
  const syntheticRoot = path.join(directory, "synthetic");
  await mkdir(syntheticRoot);
  if (selectedCases.includes("import-restart")) {
    for (let i = 0; i < 50; i++) {
      const prefix = JSON.stringify({ formatVersion: 1, item: i, payload: "" });
      const json = JSON.stringify({
        formatVersion: 1,
        item: i,
        payload: String.fromCharCode(65 + (i % 26)).repeat(8388608 - Buffer.byteLength(prefix)),
      });
      assert.equal(Buffer.byteLength(json), 8388608);
      await writeFile(path.join(syntheticRoot, `${String(i).padStart(2, "0")}.json`), json, {
        flag: "wx",
      });
    }
    const target = path.join(buildRoot, "plugins/acceptance-builtin-import");
    await mkdir(target, { recursive: true });
    await bundle(
      path.join(root, "tests/desktop/fixtures/plugin-persistence/import-consumer.ts"),
      path.join(target, "main.cjs"),
    );
    await cp(
      path.join(root, "tests/desktop/fixtures/plugin-persistence/import-kobrixa-plugin.json"),
      path.join(target, "kobrixa-plugin.json"),
    );
    const files = [];
    for (const name of ["kobrixa-plugin.json", "main.cjs"]) {
      const bytes = await readFile(path.join(target, name));
      files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
    }
    await writeFile(
      path.join(target, "resource-index.json"),
      JSON.stringify({ version: 1, pluginId: "test.synthetic", files }),
    );
  }

  const workerSource = path.join(directory, "worker.ts"),
    workerEntry = path.join(buildRoot, "worker.cjs");
  await writeFile(
    workerSource,
    selectedCases.includes("all-optional-off")
      ? `import {runOptionalOffWorker} from ${JSON.stringify(path.join(root, "tests/desktop/fixtures/plugin-persistence/optional-off-worker.ts"))};\nrunOptionalOffWorker(new Map([['test.synthetic-import',${JSON.stringify(syntheticRoot)}]]));\n`
      : `import {runSyntheticPersistenceWorker} from ${JSON.stringify(path.join(root, "tests/desktop/fixtures/plugin-persistence/kill-worker.mjs"))};\nrunSyntheticPersistenceWorker(new Map([['test.synthetic-import',${JSON.stringify(syntheticRoot)}]]));\n`,
  );
  await bundle(workerSource, workerEntry);
  const source = path.join(directory, "entry.ts"),
    entry = path.join(buildRoot, "main.cjs");
  await writeFile(
    source,
    `import {app} from 'electron';
import {writeFile} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {createFoundationFixture} from ${JSON.stringify(path.join(root, "tests/desktop/plugin-persistence-main.ts"))};
import {runReferenceEntry} from ${JSON.stringify(path.join(root, "tests/desktop/plugin-persistence-harness.mjs"))};
const config=JSON.parse(readFileSync(process.argv.find(a=>a.startsWith('--persistence-config=')).slice(21),'utf8'));
app.setPath('userData',config.profile);
// This supervised entry owns exit after awaited receipt I/O. Closing its last
// test window must not implicitly terminate an in-flight observation/write.
app.on('window-all-closed',()=>{});
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
      Buffer.from(renderer.receiptSha256),
      Buffer.from(JSON.stringify(compatibility ?? null)),
      ...(selectedCases.includes("import-restart")
        ? [
            await readFile(
              path.join(buildRoot, "plugins/acceptance-builtin-import/resource-index.json"),
            ),
          ]
        : []),
      await readFile(
        path.join(buildRoot, "plugins/acceptance-builtin-recording/resource-index.json"),
      ),
      await readFile(
        path.join(buildRoot, "plugins/acceptance-builtin-settings/resource-index.json"),
      ),
    ]),
  );
  // Never invoke Electron's path getter: it may auto-download an absent binary.
  const electronPackage = path.dirname(
    createRequire(path.join(root, "apps/desktop/package.json")).resolve("electron/package.json"),
  );
  const electron = path.join(
    electronPackage,
    "dist",
    (await readFile(path.join(electronPackage, "path.txt"), "utf8")).trim(),
  );
  await access(electron);
  const reports = [];
  for (const id of selectedCases) {
    const profile = await mkdtemp(path.join(directory, `${id}-`)),
      report = path.join(directory, `${id}.candidate.json`),
      configFile = path.join(directory, `${id}.json`);
    const config = {
      case: id,
      ...(compatibility ? { compatibility } : {}),
      ...(id === "import-restart" ? { importTrial, syntheticRoot } : {}),
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
    if (id === "import-restart") {
      const phases = [];
      const killedReceipt = path.join(directory, "import-kill.receipt.json");
      for (const importPhase of ["kill", "reopen1", "reopen2", "reopen3", "deleted"]) {
        const phase = {
          ...config,
          importPhase,
          runId: randomUUID(),
          killedReceipt,
          importWire: path.join(directory, `import-${importPhase}.wire.jsonl`),
          report: path.join(directory, `import-${importPhase}.candidate.json`),
        };
        const file = path.join(directory, `import-${importPhase}.json`);
        await writeFile(file, JSON.stringify(phase), { flag: "wx" });
        const receipt = await launchCase(electron, entry, file, phase.report, phase);
        await writeFile(
          path.join(directory, `import-${importPhase}.receipt.json`),
          JSON.stringify(receipt),
          { flag: "wx" },
        );
        phases.push(receipt);
      }
      assertImportSlice(phases);
      assert.deepEqual(
        await originalFiles(syntheticRoot),
        phases[0].evidence.importSlice.originals,
      );
      const partial = {
        format: 1,
        level: "real-process",
        status: "partial-import-trial",
        rf5Complete: false,
        trial: IMPORT_SLICE,
        reports: phases,
        artifact: entry,
        bundleSha256,
        artifactSha256,
        pending: [
          "18-boundary RF5 matrix",
          "six full-load publication trials",
          "pre-raw absence and fresh-window capture",
          "settings stale-nonce proof",
          "full foundation import-restart case",
        ],
      };
      await writeFile(output, JSON.stringify(partial), { flag: "wx" });
      return partial;
    }
    if (id === "all-optional-off") {
      const settingsProfile = await mkdtemp(path.join(directory, "optional-settings-"));
      const receipts = {};
      for (const optionalPhase of ["settings", "seed", "cold"]) {
        const phaseConfig = {
          ...config,
          optionalPhase,
          profile: optionalPhase === "settings" ? settingsProfile : profile,
          profileId: optionalPhase === "settings" ? randomUUID() : config.profileId,
          runId: randomUUID(),
          report: path.join(directory, `optional-${optionalPhase}.candidate.json`),
          mapperLog: path.join(directory, `optional-${optionalPhase}.mapper.jsonl`),
          seedReceipt: path.join(directory, "optional-seed.receipt.json"),
          settingsReceipt: path.join(directory, "optional-settings.receipt.json"),
        };
        const phaseConfigFile = path.join(directory, `optional-${optionalPhase}.json`);
        await writeFile(phaseConfigFile, JSON.stringify(phaseConfig), { flag: "wx" });
        const receipt = await launchCase(
          electron,
          entry,
          phaseConfigFile,
          phaseConfig.report,
          phaseConfig,
        );
        if (optionalPhase !== "cold")
          assertOptionalPhaseReceipt(receipt, {
            runId: phaseConfig.runId,
            profileId: phaseConfig.profileId,
          });
        else {
          verifyRunReceipt(receipt, {
            runId: phaseConfig.runId,
            profileId: phaseConfig.profileId,
            commit,
            artifactSha256,
            bundleSha256,
          });
          assert.deepEqual(receipt.evidence.optionalOff.seed, receipts.seed);
          assert.deepEqual(receipt.evidence.optionalOff.settings, receipts.settings);
          // Outside the child, verify the retained native outputs, not only self-reported hashes.
          for (const p of [
            receipts.seed.evidence.optionalPhase,
            receipt.evidence.optionalOff.cold,
          ]) {
            const file = p.export.file;
            const bytes = await readFile(file.path),
              stat = await lstat(file.path);
            assert.equal(digest(bytes), file.sha256);
            assert.equal(bytes.toString("base64"), file.data);
            assert.equal(`${stat.dev}:${stat.ino}`, file.identity);
            assert.equal(stat.size, file.bytes);
          }
          reports.push(receipt);
        }
        receipts[optionalPhase] = receipt;
        await writeFile(
          path.join(directory, `optional-${optionalPhase}.receipt.json`),
          JSON.stringify(receipt, null, 2),
          { flag: "wx" },
        );
      }
      continue;
    }
    await writeFile(configFile, JSON.stringify(config));
    const receipt = await launchCase(electron, entry, configFile, report, config);
    if (compatibility) {
      const observedConfig = { ...receipt.evidence.compatibility };
      delete observedConfig.rows;
      assert.deepEqual(observedConfig, compatibility, "Original controller artifact configuration");
      for (const file of compatibility.artifacts)
        assert.equal(digest(await readFile(file.path)), file.sha256, file.path);
    }
    verifyRunReceipt(receipt, {
      runId: config.runId,
      case: id,
      bundleSha256,
      artifactSha256,
      commit,
    });
    reports.push(receipt);
  }
  verifyFoundationReports(reports, selectedCases);
  const result = {
    format: 1,
    level: "real-process",
    status: referencesOnly ? "reference-only" : "scoped-case",
    cases: selectedCases,
    reports,
    artifact: entry,
    bundleSha256,
    artifactSha256,
    renderer,
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
    else
      await runFoundationEvidence({
        referencesOnly: process.argv.includes("--references"),
        caseId: process.argv.find((arg) => arg.startsWith("--case="))?.slice(7),
        importTrial: process.argv.find((arg) => arg.startsWith("--import-trial="))?.slice(15),
      });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
