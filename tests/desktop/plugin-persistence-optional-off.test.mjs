import { optionalOffOracle as specimen } from "./fixtures/plugin-persistence/optional-off-oracle.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertOptionalEvidence,
  assertOptionalPhaseReceipt,
} from "./plugin-persistence-optional-off.ts";
import { verifyRunReceipt, runReferenceEntry } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases, superviseCase } from "./plugin-persistence-run.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clone = structuredClone;
// Consistency specimens only. No specimen is a native run or an implementation receipt.
test("three separately evidenced phases pass both raw and outside receipt oracles", () => {
  const r = specimen();
  assertOptionalEvidence(r.evidence, r.hostEpoch);
  verifyRunReceipt(r);
  assert.deepEqual(selectFoundationCases({ caseId: "all-optional-off" }), ["all-optional-off"]);
});
const cold = (r) => r.evidence.optionalOff.cold;
const seed = (r) => r.evidence.optionalOff.seed.evidence.optionalPhase;
const settings = (r) => r.evidence.optionalOff.settings.evidence.optionalPhase;
const mutations = {
  "summary only": (r) => delete r.evidence.optionalOff,
  "missing settings trial": (r) => delete r.evidence.optionalOff.settings,
  "same host": (r) => {
    cold(r).hostEpoch = seed(r).hostEpoch;
    r.hostEpoch = seed(r).hostEpoch;
  },
  "different durable profile": (r) => {
    cold(r).profile += "-other";
  },
  "cold starts before observed exit": (r) => {
    r.evidence.optionalOff.seed.exitedAt = cold(r).started + 1;
  },
  "old artifact": (r) => {
    r.evidence.optionalOff.seed.artifactSha256 = "d".repeat(64);
  },
  "fake clean seed close": (r) => {
    r.evidence.optionalOff.seed.cleanup.workers = 0;
  },
  "remaining child": (r) => {
    r.evidence.optionalOff.seed.cleanup.children = 1;
  },
  "missing worker observer": (r) => {
    cold(r).observation.mapper = [];
  },
  "wrong mapper run": (r) => {
    cold(r).observation.mapper[0].runId = id(98);
  },
  "mapper executed": (r) => {
    cold(r).observation.mapper.push({ kind: "map" });
  },
  "optional startup read": (r) => {
    cold(r).observation.events.push({ kind: "resource", wall: cold(r).started + 100 });
  },
  "optional launch": (r) => {
    cold(r).observation.events.push({ kind: "launch", wall: cold(r).started + 100 });
  },
  "optional connect": (r) => {
    cold(r).observation.events.push({ kind: "connect", wall: cold(r).started + 100 });
  },
  "optional reconnect": (r) => {
    cold(r).observation.events.push({ kind: "reconnect", wall: cold(r).started + 100 });
  },
  "feature action minted": (r) => {
    cold(r).observation.events.push({ kind: "feature-mint", wall: cold(r).started + 100 });
  },
  "post-discovery policy": (r) => {
    cold(r).policy.at = cold(r).policy.beforeCompose + 1;
  },
  "policy missing source": (r) => {
    cold(r).policy.disabled.pop();
  },
  "enabled optional": (r) => {
    cold(r).after[0].status = "enabled";
  },
  "no real exit": (r) => {
    seed(r).exits = [];
  },
  "newly manufactured recovery ID": (r) => {
    cold(r).recovered.items[0].id = id(99);
  },
  "oldhost sealed pin preserved": (r) => {
    cold(r).recovered.items[0].sealedPin = id(9);
  },
  "wrong committed revision": (r) => {
    cold(r).recovered.items[0].report.records[0].committedRevision = id(99);
  },
  "sealed export after original TTL": (r) => {
    seed(r).export.end = 32000;
  },
  "renewed TTL": (r) => {
    seed(r).recovered.items[0].expiresAt = 32000;
  },
  "wrong original channel owner": (r) => {
    seed(r).calls.find((c) => c.kind === "sdk").args[0] = { kind: "plugin", owner: {} };
  },
  "fake SDK bytes": (r) => {
    seed(r).calls.find((c) => c.method === "storage/writeChunk").args[2].data = "YWJj";
  },
  "missing original receipt": (r) => {
    delete seed(r).calls.find((c) => c.method === "storage/commitWrite" && c.result.ok).result.value
      .receipt;
  },
  "wrong drain token": (r) => {
    seed(r).calls.find((c) => c.kind === "peer").args[1].token = id(99);
  },
  "sealed final published": (r) => {
    seed(r).trace.push({ ticket: id(7), point: "after-publish" });
  },
  "wrong native token identity": (r) => {
    cold(r).calls.find((c) => c.kind === "output" && c.method === "begin").destination = 2;
  },
  "wrong native destination": (r) => {
    cold(r).calls.find(
      (c) => c.kind === "destination" && c.method === "register",
    ).args[0].nativePath = "/tmp/forged";
  },
  "uncommitted output": (r) => {
    cold(r).calls.find((c) => c.kind === "output" && c.method === "commit").result.disposition =
      "unknown";
  },
  "wrong output job": (r) => {
    cold(r).calls.find((c) => c.kind === "output" && c.method === "append").args[0] = id(99);
  },
  "fake disk bytes": (r) => {
    cold(r).export.file.data = "YWJj";
  },
  "old core window": (r) => {
    cold(r).calls.find((c) => c.kind === "recovery").args[0].action.scope = {};
  },
  "core claim denied": (r) => {
    cold(r).calls.find((c) => c.kind === "core-action" && c.method === "claim").result = false;
  },
  "renderer IPC missing": (r) => {
    cold(r).bridgeCalls = [];
  },
  "UI hidden": (r) => {
    cold(r).visible.rendered.visible = false;
  },
  "UI absent": (r) => {
    cold(r).visible.dom = "";
  },
  "settings launched process": (r) => {
    settings(r).observation.events.push({ kind: "launch", wall: settings(r).started + 100 });
  },
  "settings unchanged": (r) => {
    settings(r).settings.after.value.revision = null;
  },
  "unchecked summary": (r) => {
    r.evidence.checks.noProcessSettings = false;
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`outside optional-off rejects ${name}`, () => {
    const r = specimen();
    mutate(r);
    assert.throws(() => verifyRunReceipt(r));
  });
test("seed receipt cannot be accepted as the whole foundation case", () => {
  const r = specimen().evidence.optionalOff.seed;
  assertOptionalPhaseReceipt(r);
  assert.throws(() => verifyRunReceipt(r));
});
test("retained seed entry does not fabricate a clean shutdown", async () => {
  const p = seed(specimen());
  let closes = 0;
  const writes = [];
  const config = {
    case: "all-optional-off",
    optionalPhase: "seed",
    report: "/tmp/specimen",
    runId: p.runId,
    profileId: p.profileId,
  };
  const code = await runReferenceEntry(
    async () => ({
      composition: {
        workerCount: 1,
        reservationListenerCount: 1,
        profile: { hostEpoch: p.hostEpoch },
      },
      environment: {},
      async runCase() {
        return { optionalPhase: p };
      },
      async close() {
        closes++;
        throw new Error("retained recovery blocks close");
      },
    }),
    config,
    {
      pid: p.pid,
      now: () => p.ended + 1,
      write: async (_file, data) => writes.push(JSON.parse(data)),
    },
  );
  assert.equal(code, 0);
  assert.equal(closes, 0);
  assert.equal(writes[0].status, "retained-phase");
  assert.equal(writes[0].workerTrace.length, 1);
  assert.equal(writes[0].cleanup.workers, 1);
});
test("optional startup policy excludes reference preloading and activation", async () => {
  const main = await readFile(new URL("./plugin-persistence-main.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /if \(optional\)\s*{\s*builtins.push\(optional.source\(config.buildRoot, role\)\);\s*continue;/,
  );
  assert.ok(
    main.includes('for (const role of optional || compatibility ? [] : ["recording", "settings"])'),
  );
  assert.ok(
    main.indexOf("optionalPolicy =") < main.indexOf("composition = await composeDesktopMain"),
  );
  const runner = await readFile(new URL("./plugin-persistence-run.mjs", import.meta.url), "utf8");
  assert.ok(runner.includes('for (const optionalPhase of ["settings", "seed", "cold"])'));
  assert.ok(runner.includes("assert.deepEqual(receipt.evidence.optionalOff.seed, receipts.seed)"));
});

// Pure OS-observer model for the new branch; never launches a process.
for (const phase of ["seed", "settings"])
  test(`supervisor accepts only correlated ${phase} phase exit`, async () => {
    const receipt = specimen().evidence.optionalOff[phase];
    const candidate = clone(receipt);
    candidate.status = phase === "seed" ? "retained-phase" : "closed-phase";
    let time = receipt.evidence.optionalPhase.ended + 1;
    let exit;
    let alive = true;
    const result = await superviseCase(
      {
        case: "all-optional-off",
        optionalPhase: phase,
        runId: receipt.runId,
        commit: receipt.commit,
        bundleSha256: receipt.bundleSha256,
        artifactSha256: receipt.artifactSha256,
      },
      {
        now: () => time,
        async start() {
          return { pid: receipt.pid, exit: () => exit };
        },
        async processes() {
          return alive
            ? [
                {
                  pid: receipt.pid,
                  ppid: 1,
                  pgid: receipt.pid,
                  start: "actual-observer-model-birth",
                },
              ]
            : [];
        },
        async sleep(ms) {
          time += ms;
          exit = { code: 0, signal: null, at: time };
          alive = false;
        },
        async readCandidate() {
          return { candidate };
        },
        async killGroup() {
          assert.fail("success must not kill");
        },
        async killProcess() {
          assert.fail("success must not kill");
        },
        async writeFailure(failure) {
          assert.fail(JSON.stringify(failure));
        },
      },
      { timeoutMs: 100, pollMs: 1, settleMs: 2 },
    );
    assertOptionalPhaseReceipt(result);
    assert.equal(result.status, phase === "seed" ? "retained-exit" : "passed-phase");
    assert.throws(() => verifyRunReceipt(result));
  });
