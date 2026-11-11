import test from "node:test";
import { readEvidence, verifyKills } from "./plugin-persistence-harness.mjs";
test("B2-RF1: actual process death at every publication frontier", async () => {
  const report = await readEvidence();
  verifyKills(report);
  assertPublicationKillReport(report);
});

import assert from "node:assert/strict";
test("verifier negatives: mock kill and missing OS exit cannot pass", () => {
  assert.throws(() => verifyKills({ level: "unit", kills: [] }), /real-process/);
  assert.throws(() => verifyKills({ level: "real-process", kills: [] }), /./);
});

import { FAULT_POINTS } from "./plugin-persistence-harness.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
import {
  PUBLICATION_KILL_POINTS,
  assertPublicationPause,
  joinPublicationKill,
  assertPublicationKillReport,
} from "./plugin-persistence-kill.ts";
import { selectFoundationCases, superviseCase } from "./plugin-persistence-run.mjs";
import { mkdtemp, mkdir, realpath, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { build } from "esbuild";

test("W11 oracle: selector and fifteen frontier identities stay exact", () => {
  assert.deepEqual(selectFoundationCases({ caseId: "publication-kill" }), ["publication-kill"]);
  assert.deepEqual(PUBLICATION_KILL_POINTS, FAULT_POINTS);
});

// Deterministic controller negatives, consuming a captured producer pause as
// input. These models are never written as observations/acceptance receipts.
async function controllerNegatives(paused, config) {
  for (const mode of ["valid", "code71", "stale-ticket", "cleanup-failure"]) {
    let time = 0,
      exit;
    const failures = [];
    const candidate = structuredClone(paused);
    if (mode === "stale-ticket") candidate.evidence.publicationKill.trace[0].ticket = randomUUID();
    const io = {
      now: () => time,
      start: async () => ({ pid: paused.pid, exit: () => exit }),
      processes: async () =>
        exit ? [] : [{ pid: paused.pid, ppid: 1, pgid: paused.pid, start: "unit-birth-identity" }],
      sleep: async (ms) => {
        time += ms;
      },
      killGroup: async () => {
        exit = {
          code: mode === "code71" ? 71 : null,
          signal: mode === "code71" ? null : "SIGKILL",
          at: time,
        };
        if (mode === "cleanup-failure") throw Error("unit cleanup failure");
      },
      killProcess: async () => {
        throw Error("Unexpected escaped child in model");
      },
      readCandidate: async () => ({ candidate }),
      writeFailure: async (failure) => {
        failures.push(failure);
      },
      reportFailure: (failure) => {
        failures.push(failure);
      },
    };
    const run = superviseCase(config, io, { timeoutMs: 10, pollMs: 1, settleMs: 1 });
    if (mode === "valid") {
      assert.equal((await run).status, "killed-publication");
      assert.equal(failures.length, 0);
    } else {
      await assert.rejects(run);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].status, "failed");
      if (mode === "cleanup-failure") assert.ok(failures[0].cleanupErrors.length > 0);
    }
  }
}

// This is an actual OS-kill regression of the producer against the production
// worker/filesystem, with a small Node test host. It is NOT Electron/foundation
// acceptance and never writes PERSISTENCE_EVIDENCE or a passing B2 report.
test(
  "W11 producer: real Node process SIGKILL/reopen at all fifteen frontiers",
  {
    skip:
      process.platform === "win32"
        ? "W17 native Windows termination/observer still required"
        : false,
    timeout: 120000,
  },
  async (t) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), "w11-producer-test-")));
    const module = path.join(root, "tests/desktop/plugin-persistence-kill.ts");
    const workerModule = path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts");
    const fsModule = path.join(root, "apps/desktop/src/main/plugins/persistence/filesystem.ts");
    const worker = path.join(directory, "worker.cjs"),
      host = path.join(directory, "host.cjs");
    const bundle = async (contents, outfile) =>
      build({
        stdin: { contents, resolveDir: root, loader: "ts" },
        outfile,
        bundle: true,
        platform: "node",
        format: "cjs",
        target: "node24",
        logLevel: "error",
        tsconfig: path.join(root, "tsconfig.base.json"),
      });
    await bundle(
      `import {installPublicationKillProbe} from ${JSON.stringify(module)};
    import {runPersistenceWorker} from ${JSON.stringify(workerModule)};
    void (async()=>{await installPublicationKillProbe(process.env.PERSISTENCE_KILL_PROBE);
      runPersistenceWorker({mappers:new Map()});})();`,
      worker,
    );
    await bundle(
      `import {producePublicationKill} from ${JSON.stringify(module)};
    import {startPersistenceWorker,persistenceWorkerCount} from ${JSON.stringify(workerModule)};
    import {openStoreRoot} from ${JSON.stringify(fsModule)};
    import {readFile,writeFile} from 'node:fs/promises';
    import {randomUUID} from 'node:crypto';
    void (async()=>{
      const config=JSON.parse(await readFile(process.argv[2],'utf8'));
      let held=true; const profile={hostEpoch:randomUUID(),assertHeld(){if(!held)throw Error('not-primary')}};
      const root=await openStoreRoot({userData:config.profile,profile}); let fault;
      const {backend,recovery}=await startPersistenceWorker({profile,root,workerEntry:config.worker,
        now:()=>performance.now(),testControl:c=>{fault=c}});
      if(recovery!=='ready')throw Error('Recovery blocked');
      const started=persistenceWorkerCount(backend);
      const evidence=await producePublicationKill({config,backend,fault,hostEpoch:profile.hostEpoch,
        core:()=>({items:[]})});
      await backend.dispose(); held=false;
      await writeFile(config.report,JSON.stringify({...config,pid:process.pid,hostEpoch:profile.hostEpoch,
        level:'real-process',case:'publication-kill',status:'closed-case',evidence,closedAt:Date.now(),
        cleanup:{workers:persistenceWorkerCount(backend),listeners:0,errors:[]},
        workerTrace:[{kind:'start',pid:process.pid,count:started},{kind:'exit',pid:process.pid,count:persistenceWorkerCount(backend)}]}));
    })().catch(e=>{console.error(e);process.exit(1)});`,
      host,
    );
    const digest = createHash("sha256")
      .update(await readFile(host))
      .digest("hex");
    let completed = false;
    const completedPoints = [];
    try {
      for (const point of PUBLICATION_KILL_POINTS) {
        await t.test(point, async () => {
          const profile = path.join(directory, point);
          await mkdir(profile);
          const profileId = randomUUID();
          let killed, killedReceipt;
          for (const phase of ["kill", "reopen"]) {
            const config = {
              case: "publication-kill",
              publicationPoint: point,
              publicationPhase: phase,
              publicationProbe: path.join(directory, `${point}-${phase}.probe.json`),
              report: path.join(directory, `${point}-${phase}.json`),
              worker,
              profile,
              profileId,
              runId: randomUUID(),
              commit: "0".repeat(40),
              bundleSha256: digest,
              artifactSha256: digest,
              ...(killedReceipt ? { killedReceipt } : {}),
            };
            const configFile = path.join(directory, `${point}-${phase}.config.json`);
            await writeFile(configFile, JSON.stringify(config));
            const child = spawn(process.execPath, [host, configFile], {
              env: { ...process.env, PERSISTENCE_KILL_PROBE: config.publicationProbe },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (data) => {
              stderr += data;
            });
            const exit = once(child, "exit");
            let timer;
            let reading = true;
            const deadline = new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(Error(`Timeout ${point}/${phase}: ${stderr}`)),
                10000,
              );
            });
            try {
              if (phase === "kill") {
                const paused = await Promise.race([
                  deadline,
                  exit.then(() => {
                    throw Error(`Exited before pause: ${stderr}`);
                  }),
                  (async () => {
                    while (reading) {
                      try {
                        return JSON.parse(await readFile(config.report, "utf8"));
                      } catch (e) {
                        if (e.code !== "ENOENT") throw e;
                      }
                      await new Promise((resolve) => setTimeout(resolve, 10));
                    }
                  })(),
                ]);
                assertPublicationPause(paused, config);
                if (point === "reserve") await controllerNegatives(paused, config);
                assert.equal(paused.pid, child.pid);
                assert.equal(child.kill("SIGKILL"), true);
                const [code, signal] = await Promise.race([exit, deadline]);
                assert.equal(code, null);
                assert.equal(signal, "SIGKILL");
                killed = {
                  ...paused,
                  status: "killed-publication",
                  exitCode: code,
                  signal,
                  exitedAt: Date.now(),
                  cleanup: { children: 0, errors: [] },
                  observedProcesses: [{ pid: child.pid }],
                  scope: "node-producer-regression-only",
                };
                killedReceipt = path.join(directory, `${point}.killed.json`);
                await writeFile(killedReceipt, JSON.stringify(killed));
              } else {
                const [code, signal] = await Promise.race([exit, deadline]);
                assert.equal(code, 0, stderr);
                assert.equal(signal, null);
                const candidate = JSON.parse(await readFile(config.report, "utf8"));
                const exitedAt = Date.now();
                const reopened = {
                  ...candidate,
                  status: "passed",
                  exitCode: code,
                  signal,
                  exitedAt,
                  reportedAt: Date.now(),
                  cleanup: { ...candidate.cleanup, children: 0 },
                };
                const row = joinPublicationKill(killed, reopened);
                assert.equal(row.republishCount, 0);
                for (const mutation of [
                  (r) => {
                    r.evidence.publicationKill.reconciledTicket.id = randomUUID();
                  },
                  (r) => {
                    r.evidence.publicationKill.reconciledTicket.deadlineMonotonicMs++;
                  },
                  (r) => {
                    r.evidence.publicationKill.after.headHash = "f".repeat(64);
                  },
                  (r) => {
                    r.cleanup.children = 1;
                  },
                  (r) => {
                    r.evidence.publicationKill.probe.publishes.push(randomUUID());
                  },
                ]) {
                  const invalid = structuredClone(reopened);
                  mutation(invalid);
                  assert.throws(() => joinPublicationKill(killed, invalid));
                }
              }
            } finally {
              reading = false;
              clearTimeout(timer);
              if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
              await exit;
            }
          }
          completedPoints.push(point);
        });
      }
      assert.deepEqual(
        completedPoints,
        PUBLICATION_KILL_POINTS,
        "Keep artifacts for every failed frontier",
      );
      completed = true;
    } finally {
      if (completed) await rm(directory, { recursive: true, force: true });
      else t.diagnostic(`Failed producer artifacts retained: ${directory}`);
    }
  },
);
const beforeReplacement = [
  "reserve",
  "open-temp",
  "chunk-write",
  "seal-sync",
  "object-rename",
  "object-dir-sync",
  "backup-head",
  "head-write",
  "before-publish",
  "import-marker",
];
const afterReplacement = [
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
];
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Pure oracle inputs. Never persisted or promoted to real-process evidence.
function killOracle() {
  const quota = Object.fromEntries(
    [
      "recordCount",
      "reservedCreates",
      "committedBytes",
      "reservedBytes",
      "hostCommittedBytes",
      "hostReservedBytes",
      "sourceStaging",
      "hostStaging",
      "sourceExports",
      "hostExports",
      "sourceTemporaryBytes",
      "hostTemporaryBytes",
      "sourceMetadataBytes",
      "hostMetadataBytes",
    ].map((k) => [k, 0]),
  );
  const snapshot = (epoch) => ({
    hostEpoch: uuid(epoch),
    diskTreeHash: "d".repeat(64),
    quota: { ...quota },
    handles: [],
    core: { records: [], errors: [] },
  });
  return {
    level: "real-process",
    execution: {
      level: "real-process",
      status: "passed",
      runId: "oracle-only",
      // The generic execution receipt must still carry a valid foundation outcome.
      // Publication-frontier observations below are independently verified.
      case: "retirement",
      evidence: outcomeOracleFixture("retirement"),
      profileId: "oracle-profile",
      commit: "a".repeat(40),
      bundleSha256: "b".repeat(64),
      artifactSha256: "c".repeat(64),
      pid: 100,
      hostEpoch: uuid(1),
      exitCode: 0,
      signal: null,
      closedAt: 1,
      exitedAt: 2,
      reportedAt: 3,
      cleanup: { workers: 0, listeners: 0, children: 0, errors: [] },
      workerTrace: [
        { kind: "start", count: 1, pid: 100 },
        { kind: "exit", count: 0, pid: 100 },
      ],
    },
    kills: FAULT_POINTS.map((point) => ({
      point,
      pauseAcknowledged: true,
      exitCode: null,
      signal: "SIGKILL",
      exitObserved: true,
      pid: 100,
      reopenedPid: 200,
      profileId: "oracle-profile",
      reopenedProfileId: "oracle-profile",
      before: snapshot(1),
      after: {
        ...snapshot(2),
        headHash: (beforeReplacement.includes(point) ? "a" : "b").repeat(64),
      },
      oldHeadHash: "a".repeat(64),
      newHeadHash: "b".repeat(64),
      partialVisible: false,
      republishCount: 0,
      originalTicketId: uuid(3),
      reconciledTicketId: uuid(3),
      originalCommitId: uuid(4),
      reconciledCommitId: uuid(4),
      trace: [{ point, ticket: uuid(3) }],
    })),
  };
}
test("T7fix I2: each actual publication frontier accepts its observed whole head", () => {
  assert.deepEqual([...beforeReplacement, ...afterReplacement].sort(), [...FAULT_POINTS].sort());
  verifyKills(killOracle());
});
test("T7fix I2: new heads at every pre-replacement frontier are rejected", () => {
  for (const point of beforeReplacement) {
    const report = killOracle(),
      entry = report.kills.find((e) => e.point === point);
    entry.after.headHash = entry.newHeadHash;
    assert.throws(() => verifyKills(report), /head|publication/i, point);
  }
});
test("T7fix I2: old/partial post-replacement heads and changed original tickets fail", () => {
  for (const point of afterReplacement)
    for (const mutate of [
      (e) => (e.after.headHash = e.oldHeadHash),
      (e) => (e.after.headHash = "f".repeat(64)),
      (e) => (e.republishCount = 1),
      (e) => (e.reconciledCommitId = uuid(5)),
      (e) => (e.reconciledTicketId = uuid(5)),
      (e) => (e.trace[0].ticket = uuid(5)),
    ]) {
      const report = killOracle();
      mutate(report.kills.find((e) => e.point === point));
      assert.throws(() => verifyKills(report), /./, point);
    }
});
