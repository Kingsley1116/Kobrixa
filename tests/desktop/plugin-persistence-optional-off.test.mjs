import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertOptionalEvidence,
  assertOptionalPhaseReceipt,
  optionalSummary,
  optionalKeys,
  sha,
} from "./plugin-persistence-optional-off.ts";
import { verifyRunReceipt, runReferenceEntry } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases, superviseCase } from "./plugin-persistence-run.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const success = (value) => ({ ok: true, value });
const clone = structuredClone;
// Consistency specimens only. No specimen is a native run or an implementation receipt.
function specimen() {
  const owner = {
    sourceKey: optionalKeys[0],
    pluginId: "acceptance.ui-recording",
    hostEpoch: id(1),
    processEpoch: id(2),
    generation: 1,
  };
  const originalBytes = Buffer.from("Optional-off committed checkpoint\n"),
    finalBytes = Buffer.from("Optional-off sealed final\n");
  const record = {
    id: id(3),
    revision: id(4),
    kind: "test.optional-off",
    schemaVersion: 1,
    label: "Optional-off",
    mediaType: "application/octet-stream",
    byteLength: originalBytes.length,
    sha256: sha(originalBytes),
    checkpoint: "open",
  };
  const finalRecord = {
    ...record,
    revision: id(5),
    byteLength: finalBytes.length,
    sha256: sha(finalBytes),
    checkpoint: "final",
  };
  const ticket = (n, record, revision) => ({
    id: id(n),
    owner,
    target: { kind: "record", id: record.id, expectedRevision: revision },
    metadata: { kind: "record", record },
  });
  const originalTicket = ticket(6, record, null),
    finalTicket = ticket(7, finalRecord, record.revision);
  const recovery = {
    id: id(8),
    owner,
    ticket: finalTicket,
    sealedPin: id(9),
    expiresAt: 31000,
    report: {
      blocker: true,
      state: "retryable",
      records: [
        {
          id: record.id,
          committedRevision: record.revision,
          final: false,
          payload: "complete-staging",
        },
      ],
    },
  };
  const row = (kind, method, args, result, start = 1500, end = start + 1) => ({
    kind,
    method,
    args,
    result,
    start,
    end,
  });
  const sourceRows = (phase, after) =>
    optionalKeys.map((sourceKey) => ({
      sourceKey,
      required: false,
      status:
        (phase === "settings" && sourceKey === optionalKeys[1]) ||
        (phase === "seed" && !after && sourceKey !== optionalKeys[1])
          ? "enabled"
          : "disabled",
    }));
  function phase(name, start, epoch, profile) {
    const p = {
      phase: name,
      runId: id(epoch + 20),
      profileId: id(profile),
      profile: `/tmp/optional-${profile}`,
      hostEpoch: id(epoch),
      pid: epoch + 100,
      scope: { hostEpoch: id(epoch), workbenchInstance: id(epoch + 30) },
      started: start,
      ended: start + 1900,
      calls: [],
      channels: [],
      disables: [],
      exits: [],
      before: sourceRows(name, false),
      after: sourceRows(name, true),
    };
    const disabled =
      name === "seed"
        ? [optionalKeys[1]]
        : name === "settings"
          ? [optionalKeys[0], optionalKeys[2]]
          : [...optionalKeys];
    const data = JSON.stringify({ schemaVersion: 2, disabled });
    p.policy = {
      at: start + 10,
      beforeCompose: start + 20,
      disabled,
      path: `${p.profile}/plugins/state.json`,
      data,
      sha256: sha(data),
    };
    p.observation = {
      started: start,
      ended: p.ended,
      installed: [
        "resource",
        "launch",
        "connect",
        "reconnect",
        "provider",
        "feature-mint",
        "mapper",
      ],
      events: optionalKeys.slice(0, 2).map((sourceKey) => ({
        kind: "metadata",
        sourceKey,
        manifestSha256: "f".repeat(64),
        indexSha256: "e".repeat(64),
        wall: start + 15,
      })),
      mapper: [{ kind: "installed", runId: p.runId, pid: p.pid, threadId: 1, wall: start + 50 }],
    };
    if (name === "settings") {
      p.observation.events.push({
        kind: "resource",
        sourceKey: optionalKeys[1],
        wall: start + 100,
      });
      const before = {
        schemaVersion: 1,
        revision: null,
        values: [{ key: "fixture.enabled", value: false }],
      };
      const after = {
        schemaVersion: 1,
        revision: id(95),
        values: [{ key: "fixture.enabled", value: true }],
      };
      p.settings = {
        schema: { path: "/tmp/settings.json", data: "{}", sha256: sha("{}") },
        opened: {
          binding: {
            owner: { sourceKey: optionalKeys[1] },
            scope: p.scope,
            resourceDigest: sha("{}"),
          },
          snapshot: before,
          resource: { schemaVersion: 1 },
        },
        before: success(before),
        after: success(after),
        changes: [{ key: "fixture.enabled", value: true }],
        update: success({
          snapshot: after,
          receipt: {
            revision: after.revision,
            commitId: id(96),
            durability: "file-and-directory-sync",
          },
        }),
      };
      return p;
    }
    const stored = clone(recovery);
    if (name === "cold") {
      stored.ticket = null;
      stored.sealedPin = null;
      stored.report.state = "checkpoint-only";
      stored.report.records[0].payload = "checkpoint-only";
      p.discard = success({});
      p.remaining = [];
    }
    p.recovered = { items: [stored], nextCursor: null };
    const item = {
      id: stored.id,
      sourceKey: optionalKeys[0],
      pluginId: "acceptance.ui-recording",
      recordId: record.id,
      committedRevision: record.revision,
      payload: stored.report.records[0].payload,
    };
    p.items = [item];
    p.visible = {
      entry: { item: { id: id(65) } },
      snapshot: success({ items: [item] }),
      dom: "acceptance.ui-recording Export",
      rendered: { text: "acceptance.ui-recording Export", visible: true },
    };
    const bytes = name === "seed" ? finalBytes : originalBytes;
    const file = {
      path: `${p.profile}/optional-off-${name}.bin`,
      data: bytes.toString("base64"),
      sha256: sha(bytes),
      identity: "1:2",
      bytes: bytes.length,
    };
    const exportStart = start + 1100;
    p.export = {
      start: exportStart,
      end: exportStart + 500,
      itemId: stored.id,
      action: { kind: "export", id: id(66) },
      result: success({}),
      dialogs: [{ selected: file.path }],
      file,
    };
    p.bridgeCalls = [
      { method: "snapshot", params: { itemId: id(65) }, result: p.visible.snapshot },
      { method: "act", params: { itemId: id(65), optionId: id(66) }, result: p.export.result },
    ];
    const current = { ...owner, hostEpoch: p.hostEpoch, processEpoch: id(epoch + 40) };
    const action = { actionToken: id(epoch + 50), scope: p.scope };
    const target = { kind: "persistence-export", recovery: stored.id };
    p.calls.push(
      row("core-action", "mint", [p.scope, target], action, exportStart),
      row("core-action", "claim", [action, target], true, exportStart + 2),
      row(
        "recovery",
        "export",
        [{ recovery: stored.id, action }],
        success({ disposition: "committed" }),
        exportStart,
        exportStart + 490,
      ),
      row(
        "destination",
        "register",
        [{ action: action.actionToken, scope: p.scope, nativePath: file.path }],
        {},
        exportStart + 3,
      ),
      row(
        "output",
        "begin",
        [id(60), current, {}, bytes.length, sha(bytes)],
        null,
        exportStart + 10,
      ),
      row(
        "reads",
        "read",
        [name === "seed" ? owner : current, name === "seed" ? stored.sealedPin : id(61)],
        { base64: file.data },
        exportStart + 20,
      ),
      row("output", "append", [id(60), 0, { base64: file.data }], bytes.length, exportStart + 30),
      row(
        "output",
        "commit",
        [id(60)],
        { disposition: "committed", commitId: id(62), durability: "file-and-directory-sync" },
        exportStart + 40,
      ),
      row("destination", "release", [{}], null, exportStart + 50),
      row("core-action", "complete", [action], null, exportStart + 60),
    );
    for (const c of p.calls)
      if (c.kind === "destination" || (c.kind === "output" && c.method === "begin"))
        c.destination = 1;
    if (name === "cold") {
      p.calls.push(
        row("reads", "open", [current, record.id, record.revision], id(61), exportStart + 4),
        row("reads", "stat", [current, record.id], record, exportStart + 4),
      );
      return p;
    }
    p.owner = owner;
    p.disabledAt = start + 1000;
    p.exits = [{ owner, exit: { code: 0 }, wall: start + 999 }];
    p.persisted = { disabled: [...optionalKeys] };
    p.disables = optionalKeys.map((sourceKey) => ({
      sourceKey,
      start: start + 300,
      end: start + 999,
      result: { ok: true },
    }));
    p.observation.events.push({ kind: "launch", owner, wall: start + 90 });
    p.trace = [
      { ticket: originalTicket.id, point: "after-publish" },
      { ticket: finalTicket.id, point: "before-publish" },
    ];
    const principal = { kind: "plugin", owner };
    const token = id(70),
      checkpoint = id(71);
    for (const [index, t, bytes] of [
      [0, originalTicket, originalBytes],
      [1, finalTicket, finalBytes],
    ]) {
      const metadata = Object.fromEntries(
        Object.entries(t.metadata.record).filter(
          ([key]) => !["checkpoint", "id", "revision"].includes(key),
        ),
      );
      const params = {
        ...metadata,
        target: index
          ? { mode: "replace", id: record.id, expectedRevision: record.revision }
          : { mode: "create" },
        ...(index ? { checkpoint: { handle: checkpoint, phase: "final" }, drainToken: token } : {}),
      };
      const time = start + 100 + index * 300;
      p.calls.push(
        {
          ...row(
            "sdk",
            "storage/beginWrite",
            [principal, "storage/beginWrite", params],
            success({ write: t.id }),
            time,
          ),
          ticket: t,
        },
        row(
          "sdk",
          "storage/writeChunk",
          [
            principal,
            "storage/writeChunk",
            { write: t.id, offset: 0, data: bytes.toString("base64") },
          ],
          success({ receivedBytes: bytes.length }),
          time + 2,
        ),
        row(
          "sdk",
          "storage/sealWrite",
          [principal, "storage/sealWrite", { write: t.id }],
          success({ state: "sealed", expiresAt: 31000 }),
          time + 4,
        ),
        row(
          "evidence",
          "retainSealed",
          [t],
          { pin: index ? recovery.sealedPin : id(72), expiresMonotonicMs: 30000 },
          time + 4,
        ),
        row(
          "sdk",
          "storage/commitWrite",
          [
            principal,
            "storage/commitWrite",
            { write: t.id, ...(index ? { drainToken: token } : {}) },
          ],
          index
            ? { ok: false, error: { code: "PLUGIN_E_STORAGE_IO" } }
            : success({
                record,
                receipt: {
                  revision: record.revision,
                  commitId: id(73),
                  durability: "file-and-directory-sync",
                },
              }),
          time + 6,
        ),
      );
    }
    p.calls.push(
      row(
        "sdk",
        "storage/registerCheckpoint",
        [
          principal,
          "storage/registerCheckpoint",
          { id: record.id, expectedRevision: record.revision },
        ],
        success({ checkpoint }),
        start + 200,
      ),
      row(
        "peer",
        "request",
        ["storage/drain", { token }],
        success({ status: "submitted", writes: [finalTicket.id] }),
        start + 300,
      ),
      row("lifecycle", "drain", [{ owner, token }], recovery.report, start + 300),
    );
    return p;
  }
  const receipt = (p, phase = true) => ({
    format: 1,
    level: "real-process",
    status: p.phase === "seed" ? "retained-exit" : phase ? "passed-phase" : "passed",
    case: "all-optional-off",
    runId: p.runId,
    profileId: p.profileId,
    hostEpoch: p.hostEpoch,
    pid: p.pid,
    commit: "a".repeat(40),
    artifactSha256: "b".repeat(64),
    bundleSha256: "c".repeat(64),
    exitCode: 0,
    signal: null,
    ...(p.phase === "seed" ? { retainedAt: p.ended + 1 } : { closedAt: p.ended + 1 }),
    exitedAt: p.ended + 2,
    reportedAt: p.ended + 3,
    cleanup: {
      workers: p.phase === "seed" ? 1 : 0,
      listeners: p.phase === "seed" ? 1 : 0,
      children: 0,
      errors: [],
    },
    workerTrace: [
      { kind: "start", count: 1, pid: p.pid },
      ...(p.phase === "seed" ? [] : [{ kind: "exit", count: 0, pid: p.pid }]),
    ],
    evidence: { checks: {}, events: [], samples: {}, optionalPhase: p },
  });
  const settings = receipt(phase("settings", 1000, 10, 80)),
    seed = receipt(phase("seed", 4000, 1, 81)),
    cold = phase("cold", 7000, 11, 81);
  const optionalOff = { seed, settings, cold };
  const evidence = { optionalOff, checks: optionalSummary(optionalOff), events: [], samples: {} };
  const result = receipt(cold, false);
  result.evidence = evidence;
  return result;
}
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
  assert.ok(main.includes('for (const role of optional ? [] : ["recording", "settings"])'));
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
