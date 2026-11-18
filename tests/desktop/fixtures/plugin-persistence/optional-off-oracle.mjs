import { optionalKeys, optionalSummary, sha } from "../../plugin-persistence-optional-off.ts";
import path from "node:path";
import { tmpdir } from "node:os";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const success = (value) => ({ ok: true, value });
const clone = structuredClone;
// Consistency specimens only. No specimen is a native run or an implementation receipt.
export function optionalOffOracle() {
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
      profile: path.join(tmpdir(), `optional-${profile}`),
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
      path: path.join(p.profile, "plugins/state.json"),
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
        schema: { path: path.join(tmpdir(), "settings.json"), data: "{}", sha256: sha("{}") },
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
      path: path.join(p.profile, `optional-off-${name}.bin`),
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
