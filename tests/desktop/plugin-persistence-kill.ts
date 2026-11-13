import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type {
  PersistenceBackend,
  PublicationTicket,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { PersistenceFaultControl } from "../../apps/desktop/src/main/plugins/persistence/worker.js";
import type { PersistenceFaultPoint } from "../../apps/desktop/src/main/plugins/persistence/filesystem.js";
import type { Wire } from "./plugin-persistence-import.js";
import { storageTree } from "./plugin-persistence-negative-storage.js";
import {
  barrierKeyFor,
  parseBarrierDocument,
} from "../../apps/desktop/src/main/plugins/persistence/import-sources.js";

// Run through plugin-persistence-run.mjs --case=publication-kill. Each point gets
// its own profile, an externally killed host, and a fresh host/worker reopen.
export const PUBLICATION_KILL_POINTS: readonly PersistenceFaultPoint[] = [
  "reserve",
  "open-temp",
  "chunk-write",
  "seal-sync",
  "object-rename",
  "object-dir-sync",
  "backup-head",
  "head-write",
  "before-publish",
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
  "import-marker",
];
export const POST_PUBLICATION = [
  "after-publish",
  "head-dir-sync",
  "cache-publish",
  "receipt-send",
  "cleanup",
];
export const KILL_SOURCE = "builtin:acceptance.publication-kill";
const DESCRIPTOR = "acceptance.publication-kill";
const KEY = barrierKeyFor(DESCRIPTOR);
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Observation only: forward all real worker operations unchanged. This probe
 * reads the actual ledger/handle maps, including while the I/O hook is paused.
 * Fail closed if those private layouts change; never substitute zero counters. */
export async function installPublicationKillProbe(file: string | undefined) {
  if (!file) return;
  const { AtomicStore } =
    await import("../../apps/desktop/src/main/plugins/persistence/atomic-store.js");
  const { NodePersistenceFs } =
    await import("../../apps/desktop/src/main/plugins/persistence/filesystem.js");
  let store: InstanceType<typeof AtomicStore> | undefined;
  const publishes: string[] = [];
  const map = (object: object, key: string): Map<string, Wire> => {
    const value: unknown = Reflect.get(object, key);
    assert.ok(value instanceof Map, `Missing observed worker map ${key}`);
    return value;
  };
  const observe = (point: string) => {
    if (!store) return;
    const ledger = store.quota;
    const committed = map(ledger, "committed"),
      reservations = map(ledger, "reservations"),
      temporary = map(ledger, "temporary");
    const all = [...reservations.values()],
      own = all.filter((r) => r.source === KILL_SOURCE);
    const totals = committed.get(KILL_SOURCE);
    const sum = (rows: Wire[], key: string) => rows.reduce((n, r) => n + r[key], 0);
    const quota = {
      ...ledger.snapshot(KILL_SOURCE),
      hostCommittedBytes: sum([...committed.values()], "committed"),
      hostReservedBytes: sum(all, "bytes"),
      sourceStaging: own.filter((r) => r.lane === "write").length,
      hostStaging: all.filter((r) => r.lane === "write").length,
      sourceExports: own.filter((r) => r.lane === "export").length,
      hostExports: all.filter((r) => r.lane === "export").length,
      sourceTemporaryBytes:
        (totals?.temporary ?? 0) +
        sum(
          [...temporary.values()].filter((r) => r.source === KILL_SOURCE),
          "bytes",
        ),
      hostTemporaryBytes:
        sum([...committed.values()], "temporary") + sum([...temporary.values()], "bytes"),
      sourceMetadataBytes: (totals?.metadata ?? 0) + sum(own, "metadata"),
      hostMetadataBytes: sum([...committed.values()], "metadata") + sum(all, "metadata"),
    };
    const handles = ["entries", "pins", "cursors", "finalAdmissions", "evidencePages"].flatMap(
      (key) => [...map(store!, key).keys()].map((id) => `${key}:${id}`),
    );
    const value = {
      point,
      pid: process.pid,
      hostEpoch: store.fs.profile.hostEpoch,
      quota,
      handles,
      publishes: [...publishes],
    };
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  };
  const initialize = AtomicStore.prototype.initialize;
  AtomicStore.prototype.initialize = async function () {
    assert.equal(store, undefined, "One real store per observed worker");
    // Retain the actual worker instance for later read-only boundary observations.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    store = this;
    await initialize.call(this);
    observe("initialized");
  };
  const publish = AtomicStore.prototype.publish;
  AtomicStore.prototype.publish = async function (ticket, ...rest) {
    publishes.push(ticket.id);
    return publish.call(this, ticket, ...rest);
  };
  const at = NodePersistenceFs.prototype.at;
  NodePersistenceFs.prototype.at = async function (
    this: InstanceType<typeof NodePersistenceFs>,
    point,
    work,
  ) {
    observe(point);
    return at.call(this, point, work);
  } as typeof at;
  // Refresh after read-only reconciliation/queries too, without introducing jobs.
  const reconcile = AtomicStore.prototype.reconcileImport;
  AtomicStore.prototype.reconcileImport = async function (ticket) {
    const result = await reconcile.call(this, ticket);
    observe("reconciled");
    return result;
  };
}

async function atomicReport(file: string, value: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(value));
  await rename(`${file}.tmp`, file);
}
export function assertPublicationPause(receipt: Wire, config: Wire) {
  assert.equal(receipt.status, "paused-publication");
  for (const key of ["runId", "profileId", "commit", "bundleSha256", "artifactSha256"])
    assert.equal(receipt[key], config[key], key);
  const o = receipt.evidence.publicationKill;
  assert.ok(PUBLICATION_KILL_POINTS.includes(o.point));
  assert.equal(o.point, config.publicationPoint);
  assert.equal(o.phase, "kill");
  assert.equal(o.pid, receipt.pid);
  assert.equal(o.before.hostEpoch, receipt.hostEpoch);
  assert.equal(o.ticket.owner.hostEpoch, receipt.hostEpoch);
  assert.equal(o.ticket.owner.sourceKey, KILL_SOURCE);
  assert.equal(o.probe.point, o.point);
  assert.equal(o.probe.pid, receipt.pid);
  assert.equal(o.probe.hostEpoch, receipt.hostEpoch);
  assert.ok(o.trace.some((row: Wire) => row.point === o.point && row.ticket === o.ticket.id));
  assert.equal(o.publicationReply, null, "No success reply before the cut");
  assert.equal(o.before.headHash, o.oldHeadHash);
  assert.equal(
    o.paused.headHash,
    POST_PUBLICATION.includes(o.point) ? o.newHeadHash : o.oldHeadHash,
  );
  if (POST_PUBLICATION.includes(o.point))
    assert.equal(o.originalCommitId, o.paused.head.receipt.commitId);
  for (const [name, ticket] of [
    ["old", o.oldTicket],
    ["new", o.ticket],
  ]) {
    const bytes = Buffer.from(o[`${name}Payload`], "base64");
    assert.equal(hash(bytes), o[`${name}HeadHash`]);
    assert.deepEqual(parseBarrierDocument(bytes).ticket, ticket);
  }
}

export async function producePublicationKill(input: {
  config: Wire;
  backend: PersistenceBackend;
  fault: PersistenceFaultControl;
  hostEpoch: string;
  core: () => unknown;
}) {
  const { config, backend, fault, hostEpoch } = input;
  assert.ok(PUBLICATION_KILL_POINTS.includes(config.publicationPoint));
  const owner = {
    sourceKey: KILL_SOURCE,
    pluginId: "acceptance.publication-kill",
    generation: 1,
    hostEpoch,
    processEpoch: randomUUID(),
  };
  const root = path.join(config.profile, "plugins", "persistence-v1");
  const headFile = path.join(root, "namespaces", hash(KILL_SOURCE), "imports", `${hash(KEY)}.json`);
  const snapshot = async (probe: Wire) => {
    assert.equal(probe.pid, process.pid);
    assert.equal(probe.hostEpoch, hostEpoch);
    const tree = await storageTree(root);
    const headBytes = await readFile(headFile);
    const head = JSON.parse(headBytes.toString("utf8"));
    // Hash the committed payload, and separately retain the complete head hash.
    // Early cuts precede random revision/receipt allocation; do not invent it.
    const core = input.core() as Wire;
    assert.ok(Array.isArray(core.items));
    return {
      hostEpoch,
      diskTreeHash: hash(JSON.stringify(tree)),
      tree,
      headHash: head.sha256,
      diskHeadSha256: hash(headBytes),
      head,
      quota: probe.quota,
      handles: probe.handles,
      core: {
        records: core.items.filter((item: Wire) => item.recordId !== null),
        errors: core.items.filter((item: Wire) => item.state === "failed"),
        snapshot: core,
      },
    };
  };
  const probe = async () => JSON.parse(await readFile(config.publicationProbe, "utf8"));
  const base = {
    point: config.publicationPoint,
    phase: config.publicationPhase,
    pid: process.pid,
    profileId: config.profileId,
    hostEpoch,
    headHashKind: "committed-payload-sha256",
  };
  if (config.publicationPhase === "kill") {
    const ticket = (): PublicationTicket => ({
      id: randomUUID(),
      owner,
      deadlineMonotonicMs: performance.now() + 120000,
      target: { kind: "import", key: KEY },
      metadata: { kind: "import", key: KEY },
    });
    const stage = async (t: PublicationTicket, bytes: Uint8Array) => {
      await backend.engine.reserve(t, bytes.length);
      await backend.engine.append(t, 0, bytes);
      await backend.engine.seal(t, bytes.length, hash(bytes));
      return backend.engine.publish(t);
    };
    const old = ticket(),
      next = ticket(),
      barrier = randomUUID();
    // Use the actual durable host metadata codec: a generic JSON import value
    // has no ticket binding once cleanup deletes intent.json, so cannot prove
    // original-ticket reconciliation after receipt loss.
    const payload = (ticket: PublicationTicket, state: "active" | "complete") => {
      const bytes = Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          kind: "barrier",
          descriptorId: DESCRIPTOR,
          sourceKey: KILL_SOURCE,
          barrier,
          state,
          originalTicket: old,
          ticket,
        }),
      );
      parseBarrierDocument(bytes);
      return bytes;
    };
    const oldBytes = payload(old, "active"),
      newBytes = payload(next, "complete");
    assert.equal((await stage(old, oldBytes)).disposition, "committed");
    if (!fault.trace().some((row) => row.point === "receipt-send" && row.ticket === old.id))
      await fault.reached("receipt-send");
    assert.ok(fault.trace().some((row) => row.point === "receipt-send" && row.ticket === old.id));
    const before = await snapshot(await probe());
    assert.equal(before.headHash, hash(oldBytes));
    const start = fault.trace().length;
    const reached = fault.reached(config.publicationPoint);
    fault.arm(config.publicationPoint, "pause");
    const pending = stage(next, newBytes);
    await Promise.race([
      reached,
      pending.then(() => {
        throw Error("Publication missed the selected frontier");
      }),
    ]);
    const observed = await probe();
    const paused = await snapshot(observed);
    const o = {
      ...base,
      before,
      paused,
      probe: observed,
      ticket: next,
      oldTicket: old,
      oldPayload: oldBytes.toString("base64"),
      newPayload: newBytes.toString("base64"),
      oldHeadHash: hash(oldBytes),
      newHeadHash: hash(newBytes),
      originalCommitId: POST_PUBLICATION.includes(config.publicationPoint)
        ? paused.head.receipt.commitId
        : null,
      trace: fault.trace().slice(start),
      publicationReply: null,
    };
    const receipt = {
      format: 1,
      level: "real-process",
      case: "publication-kill",
      status: "paused-publication",
      runId: config.runId,
      profileId: config.profileId,
      pid: process.pid,
      hostEpoch,
      commit: config.commit,
      bundleSha256: config.bundleSha256,
      artifactSha256: config.artifactSha256,
      evidence: { publicationKill: o },
      pausedAt: Date.now(),
    };
    assertPublicationPause(receipt, config);
    await atomicReport(config.report, receipt);
    // The outside supervisor alone sends SIGKILL. No release, finally/dispose,
    // worker.terminate(), fabricated return value, or cooperative exit here.
    await new Promise<never>(() => {});
    throw Error("Unreachable publication continuation");
  }
  assert.equal(config.publicationPhase, "reopen");
  const killed = JSON.parse(await readFile(config.killedReceipt, "utf8"));
  const prior = killed.evidence.publicationKill;
  assert.equal(killed.status, "killed-publication");
  assert.equal(killed.profileId, config.profileId);
  assert.equal(prior.point, config.publicationPoint);
  assert.notEqual(killed.pid, process.pid);
  assert.notEqual(killed.hostEpoch, hostEpoch);
  const reconciliation = await backend.imports.reconcile(prior.ticket);
  const bytes = await backend.evidence.auxiliary(owner, "import", KEY);
  const expected = Buffer.from(
    POST_PUBLICATION.includes(config.publicationPoint) ? prior.newPayload : prior.oldPayload,
    "base64",
  );
  assert.deepEqual(bytes, Uint8Array.from(expected), "Whole committed payload after reopen");
  const observed = await probe();
  assert.equal(observed.publishes.length, 0, "Reopen must reconcile without republishing");
  const after = await snapshot(observed);
  assert.equal(after.headHash, hash(expected));
  assert.equal(
    after.diskHeadSha256,
    (POST_PUBLICATION.includes(config.publicationPoint) ? prior.paused : prior.before)
      .diskHeadSha256,
    "Reopen preserves the exact whole head, including its original receipt",
  );
  if (POST_PUBLICATION.includes(config.publicationPoint)) {
    assert.equal(reconciliation.disposition, "committed");
    assert.equal(reconciliation.receipt?.commitId, prior.originalCommitId);
    assert.equal(after.head.receipt.commitId, prior.originalCommitId);
  } else assert.ok(["not-committed", "unknown"].includes(reconciliation.disposition));
  return {
    checks: {},
    events: [],
    samples: {},
    publicationKill: {
      ...base,
      after,
      probe: observed,
      reconciledTicket: prior.ticket,
      reconciliation,
      republishCount: observed.publishes.length,
      partialVisible: !Buffer.from(bytes!).equals(expected),
      trace: fault.trace(),
    },
  };
}

export function assertPublicationReopen(receipt: Wire, config: Wire) {
  assert.equal(receipt.level, "real-process");
  assert.equal(receipt.case, "publication-kill");
  assert.equal(receipt.status, "passed");
  for (const key of ["runId", "profileId", "commit", "bundleSha256", "artifactSha256"])
    assert.equal(receipt[key], config[key], key);
  assert.equal(receipt.exitCode, 0);
  assert.equal(receipt.signal, null);
  assert.match(receipt.commit, /^[0-9a-f]{40}$/);
  for (const key of ["bundleSha256", "artifactSha256"])
    assert.match(receipt[key], /^[0-9a-f]{64}$/);
  assert.ok(Number.isSafeInteger(receipt.pid) && receipt.pid > 0);
  for (const key of ["closedAt", "exitedAt", "reportedAt"])
    assert.ok(Number.isFinite(receipt[key]));
  assert.ok(receipt.closedAt <= receipt.exitedAt && receipt.exitedAt <= receipt.reportedAt);
  assert.deepEqual(receipt.cleanup, { workers: 0, listeners: 0, errors: [], children: 0 });
  assert.deepEqual(
    receipt.workerTrace.map((r: Wire) => r.count),
    [1, 0],
  );
  assert.deepEqual(
    receipt.workerTrace.map((r: Wire) => r.kind),
    ["start", "exit"],
  );
  assert.ok(receipt.workerTrace.every((r: Wire) => r.pid === receipt.pid));
  const o = receipt.evidence.publicationKill;
  assert.equal(o.phase, "reopen");
  assert.equal(o.point, config.publicationPoint);
  assert.equal(o.hostEpoch, receipt.hostEpoch);
  assert.equal(o.after.hostEpoch, receipt.hostEpoch);
  assert.equal(o.pid, receipt.pid);
  assert.equal(o.probe.pid, receipt.pid);
  assert.equal(o.probe.hostEpoch, receipt.hostEpoch);
  assert.equal(o.republishCount, 0);
  assert.deepEqual(o.probe.publishes, []);
  assert.equal(o.partialVisible, false);
}

export function joinPublicationKill(killed: Wire, reopened: Wire) {
  const before = killed.evidence.publicationKill,
    after = reopened.evidence.publicationKill;
  assert.equal(killed.status, "killed-publication");
  assertPublicationPause(
    { ...killed, status: "paused-publication" },
    {
      ...killed,
      publicationPoint: before.point,
    },
  );
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(killed.exitCode, null);
  assert.ok(Number.isFinite(killed.exitedAt) && killed.exitedAt >= killed.pausedAt);
  assert.equal(killed.cleanup.children, 0);
  assert.deepEqual(killed.cleanup.errors, []);
  assert.ok(killed.observedProcesses.some((r: Wire) => r.pid === killed.pid));
  assertPublicationReopen(reopened, {
    ...killed,
    runId: reopened.runId,
    publicationPoint: before.point,
  });
  assert.deepEqual(
    after.reconciledTicket,
    before.ticket,
    "Exact original ticket, including deadline/owner",
  );
  assert.equal(after.profileId, before.profileId);
  assert.notEqual(killed.pid, reopened.pid);
  assert.notEqual(killed.hostEpoch, reopened.hostEpoch);
  const post = POST_PUBLICATION.includes(before.point);
  assert.equal(after.after.headHash, post ? before.newHeadHash : before.oldHeadHash);
  assert.equal(after.after.diskHeadSha256, (post ? before.paused : before.before).diskHeadSha256);
  for (const snapshot of [before.before, before.paused, after.after]) {
    assert.equal(snapshot.diskTreeHash, hash(JSON.stringify(snapshot.tree)));
    assert.equal(snapshot.diskHeadSha256, hash(JSON.stringify(snapshot.head)));
    assert.equal(snapshot.headHash, snapshot.head.sha256);
  }
  if (post) {
    assert.equal(after.reconciliation.disposition, "committed");
    assert.equal(after.reconciliation.receipt.commitId, before.originalCommitId);
    assert.equal(after.after.head.receipt.commitId, before.originalCommitId);
  } else assert.ok(["not-committed", "unknown"].includes(after.reconciliation.disposition));
  return {
    point: before.point,
    pauseAcknowledged: true,
    exitObserved: true,
    pid: killed.pid,
    reopenedPid: reopened.pid,
    signal: killed.signal,
    exitCode: killed.exitCode,
    profileId: killed.profileId,
    reopenedProfileId: reopened.profileId,
    before: before.paused,
    after: after.after,
    oldHeadHash: before.oldHeadHash,
    newHeadHash: before.newHeadHash,
    originalTicketId: before.ticket.id,
    reconciledTicketId: after.reconciledTicket.id,
    originalCommitId: before.originalCommitId,
    reconciledCommitId: after.reconciliation.receipt?.commitId ?? null,
    republishCount: after.republishCount,
    partialVisible: after.partialVisible,
    trace: before.trace,
    headHashKind: before.headHashKind,
    reconciliation: after.reconciliation,
    receipts: { killed, reopened },
  };
}

/** Additional RF1 bindings beyond the unchanged shared oracle. */
export function assertPublicationKillReport(report: Wire) {
  assert.equal(report.level, "real-process");
  assert.equal(report.execution.case, "retirement");
  assert.equal(report.status, "scoped-publication-kill");
  assert.deepEqual(
    report.kills.map((row: Wire) => row.point),
    PUBLICATION_KILL_POINTS,
  );
  const epochs = new Set<string>(),
    profiles = new Set<string>();
  for (const row of report.kills) {
    const { killed, reopened } = row.receipts;
    assert.deepEqual(joinPublicationKill(killed, reopened), row);
    assert.ok(!profiles.has(killed.profileId), "Separate profile for each frontier");
    profiles.add(killed.profileId);
    for (const receipt of [killed, reopened]) {
      assert.ok(!epochs.has(receipt.hostEpoch), "Fresh host epoch for every phase");
      epochs.add(receipt.hostEpoch);
      for (const key of ["commit", "artifactSha256", "bundleSha256"])
        assert.equal(receipt[key], report.execution[key], `Cross-artifact kill receipt: ${key}`);
    }
  }
}
