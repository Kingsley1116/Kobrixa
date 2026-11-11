import assert from "node:assert/strict";
// @ts-expect-error Node pure-oracle imports the test-local TypeScript source.
import { assertImportStorage } from "./plugin-persistence-import.ts";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PersistenceBackend } from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { LegacyWriterPort } from "../../apps/desktop/src/main/plugins/persistence/import-sources.js";
import type { DesktopMainComposition } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type { Wire, importObserver } from "./plugin-persistence-import.js";

export const SEMANTIC_IMPORT_BOUNDARIES = [
  "before-plan",
  "after-plan",
  "before-attempt",
  "after-attempt",
  "before-skip",
  "after-skip",
  "before-barrier",
  "after-barrier",
] as const;
export const TRUSTED_SKIP_REASON = "trusted-user-skip";
/** A synthetic legacy writer with a real disk side effect behind its admission gate. */
export function createImportWriter(sourceKey: string, destination: string) {
  let frozen = false;
  let active: Promise<void> | undefined;
  const witness = observeImportWriter({
    sourceKey,
    freezeAdmission() {
      frozen = true;
    },
    async settled() {
      await active;
    },
  });
  const start = () => {
    if (frozen) throw Error("legacy-writer-frozen");
    return (active = writeFile(destination, "unexpected legacy write"));
  };
  return {
    ...witness,
    start,
    async attempt() {
      const digest = async () =>
        createHash("sha256")
          .update(await readFile(destination))
          .digest("hex");
      const before = await digest();
      const at = Date.now();
      let admitted = false;
      let error: string | null = null;
      try {
        await start();
        admitted = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const proof = {
        sourceKey,
        events: clone(witness.events),
        at,
        admitted,
        error,
        before,
        after: await digest(),
      };
      assertImportWriter(proof);
      return proof;
    },
  };
}
export function assertImportWriter(proof: Wire) {
  const freeze = proof.events.find(
    (e: Wire) => e.kind === "freeze" && e.sourceKey === proof.sourceKey,
  );
  const restored = proof.events.find((e: Wire) => e.kind === "composition-returned");
  assert.ok(freeze && restored && freeze.at <= restored.at && restored.at <= proof.at);
  assert.equal(proof.admitted, false);
  assert.equal(proof.error, "legacy-writer-frozen");
  assert.match(proof.before, /^[a-f0-9]{64}$/);
  assert.equal(proof.after, proof.before);
}
export function semanticBoundary(value: string) {
  assert.ok(
    (SEMANTIC_IMPORT_BOUNDARIES as readonly string[]).includes(value),
    "Unsupported semantic boundary",
  );
  return value;
}
/** Wrap the existing composition writer before compose; never invoke restore again. */
export function observeImportWriter(writer: LegacyWriterPort) {
  const events: Wire[] = [];
  return {
    events,
    writer: {
      sourceKey: writer.sourceKey,
      freezeAdmission() {
        writer.freezeAdmission();
        events.push({ kind: "freeze", sourceKey: writer.sourceKey, at: Date.now() });
      },
      async settled() {
        await writer.settled();
        events.push({ kind: "settled", sourceKey: writer.sourceKey, at: Date.now() });
      },
    },
    composed() {
      events.push({ kind: "composition-returned", at: Date.now() });
    },
  };
}
type Identity = { sourceKey: string; descriptorId: string; planId: string; barrierKey: string };
const clone = <T>(value: T): T => structuredClone(value);
function decodeBarrier(bytes: Uint8Array | null, identity: Identity): Wire | null {
  if (bytes === null) return null;
  assert.ok(bytes.length <= 16384);
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  assert.equal(value.formatVersion, 1);
  assert.equal(value.kind, "barrier");
  assert.equal(value.sourceKey, identity.sourceKey);
  assert.equal(value.descriptorId, identity.descriptorId);
  assert.ok(["active", "complete"].includes(value.state));
  for (const ticket of [value.ticket, value.originalTicket]) {
    assert.equal(ticket.owner.sourceKey, identity.sourceKey);
    assert.deepEqual(ticket.target, { kind: "import", key: identity.barrierKey });
    assert.deepEqual(ticket.metadata, { kind: "import", key: identity.barrierKey });
  }
  return value;
}
function assertPlan(plan: Wire, identity: Identity) {
  assert.equal(plan.id, identity.planId);
  assert.equal(plan.descriptorId, identity.descriptorId);
  assert.equal(plan.targetSourceKey, identity.sourceKey);
  assert.equal(plan.items.length, 50);
  assert.ok(
    plan.items.every((i: Wire) => i.byteLength === 8388608 && i.ticket.target.kind === "record"),
  );
  assert.equal(new Set(plan.items.map((i: Wire) => i.key)).size, 50);
  assert.equal(new Set(plan.items.map((i: Wire) => i.ticket.target.id)).size, 50);
}
/** Exact semantic port edges. Internal journal RPCs do not expose a publication ticket. */
export function armSemanticImport(input: {
  backend: PersistenceBackend;
  identity: Identity;
  boundary: string;
  pause: (e: Wire) => Promise<never>;
}) {
  const { backend, identity, pause } = input,
    boundary = semanticBoundary(input.boundary);
  const plan = backend.imports.plan,
    admit = backend.imports.admit,
    append = backend.engine.append,
    publish = backend.engine.publish;
  const buffers = new Map<string, Buffer>();
  let selected = false;
  const base = { boundary, identity };
  backend.imports.plan = async (owner, value) => {
    if (
      !selected &&
      owner.sourceKey === identity.sourceKey &&
      value.id === identity.planId &&
      boundary.endsWith("plan")
    ) {
      selected = true;
      assertPlan(value, identity);
      const before = await backend.imports.load(owner, value.id);
      assert.equal(before, null);
      if (boundary === "after-plan") await plan.call(backend.imports, owner, value);
      return pause({
        ...base,
        method: "imports.plan",
        owner: clone(owner),
        plan: clone(value),
        journal: await backend.imports.load(owner, value.id),
        attempt: null,
        key: null,
      });
    }
    return plan.call(backend.imports, owner, value);
  };
  backend.imports.admit = async (owner, id, key) => {
    if (
      !selected &&
      owner.sourceKey === identity.sourceKey &&
      id === identity.planId &&
      (boundary.endsWith("attempt") || boundary.endsWith("skip"))
    ) {
      selected = true;
      const before = await backend.imports.load(owner, id);
      assert.ok(before);
      assertPlan(before.plan, identity);
      assert.equal(key, before.plan.items[0]!.key);
      assert.equal(before.items[0]!.state, "pending");
      assert.equal(before.items[0]!.publicationTicket, null);
      let attempt = null;
      if (boundary === "after-attempt") attempt = await admit.call(backend.imports, owner, id, key);
      if (boundary === "after-skip")
        await backend.imports.record(owner, id, {
          key,
          state: "skipped",
          receipt: null,
          skipReason: TRUSTED_SKIP_REASON,
          publicationTicket: null,
        });
      return pause({
        ...base,
        method: boundary.endsWith("skip") ? "imports.record:trusted-host-skip" : "imports.admit",
        owner: clone(owner),
        plan: before.plan,
        key,
        attempt,
        journal: await backend.imports.load(owner, id),
      });
    }
    return admit.call(backend.imports, owner, id, key);
  };
  backend.engine.append = async (ticket, offset, bytes) => {
    const next = await append.call(backend.engine, ticket, offset, bytes);
    if (
      boundary.endsWith("barrier") &&
      ticket.owner.sourceKey === identity.sourceKey &&
      ticket.target.kind === "import" &&
      ticket.target.key === identity.barrierKey
    ) {
      const old = buffers.get(ticket.id) ?? Buffer.alloc(0);
      assert.equal(offset, old.length);
      assert.equal(next, offset + bytes.length);
      assert.ok(next <= 16384);
      assert.ok(buffers.size < 2 || buffers.has(ticket.id));
      buffers.set(ticket.id, Buffer.concat([old, bytes]));
    }
    return next;
  };
  backend.engine.publish = async (ticket) => {
    const bytes = buffers.get(ticket.id);
    if (!selected && bytes && boundary.endsWith("barrier")) {
      const document = decodeBarrier(bytes, identity)!;
      assert.deepEqual(document.ticket, ticket);
      if (document.state === "active") {
        selected = true;
        const before = decodeBarrier(
          await backend.evidence.auxiliary(ticket.owner, "import", identity.barrierKey),
          identity,
        );
        assert.equal(before, null);
        const outcome =
          boundary === "after-barrier" ? await publish.call(backend.engine, ticket) : null;
        if (outcome) assert.equal(outcome.disposition, "committed");
        return pause({
          ...base,
          method: "engine.publish:active-barrier",
          owner: clone(ticket.owner),
          plan: null,
          journal: null,
          attempt: null,
          key: null,
          barrierDocument: document,
          barrierTicket: clone(ticket),
          outcome,
          reconciled: outcome ? await backend.imports.reconcile(ticket) : null,
          barrierReadback: decodeBarrier(
            await backend.evidence.auxiliary(ticket.owner, "import", identity.barrierKey),
            identity,
          ),
        });
      }
    }
    return publish.call(backend.engine, ticket);
  };
  return () => {
    backend.imports.plan = plan;
    backend.imports.admit = admit;
    backend.engine.append = append;
    backend.engine.publish = publish;
  };
}
export function assertSemanticPause(o: Wire) {
  const boundary = semanticBoundary(o.boundary);
  assert.equal(o.slice, boundary);
  assert.equal(o.phase, "kill");
  assert.equal(o.rf5Complete, false);
  assert.equal(o.identity.sourceKey, "builtin:test.synthetic");
  assert.equal(o.owner.sourceKey, o.identity.sourceKey);
  assert.equal(o.owner.hostEpoch, o.hostEpoch);
  assert.equal(o.originals.length, 50);
  assert.ok(o.originals.every((r: Wire) => r.bytes === 8388608));
  assert.equal(o.ticket, undefined, "No fabricated target ticket before admission");
  if (boundary.endsWith("barrier")) {
    assert.equal(o.method, "engine.publish:active-barrier");
    assert.equal(o.plan, null);
    assert.equal(o.journal, null);
    assert.equal(o.attempt, null);
    assert.equal(o.barrierDocument.state, "active");
    assert.deepEqual(o.barrierDocument.ticket, o.barrierTicket);
    if (boundary === "before-barrier") {
      assert.equal(o.barrierReadback, null);
      assert.equal(o.outcome, null);
    } else {
      assert.deepEqual(o.barrierReadback, o.barrierDocument);
      assert.equal(o.outcome.disposition, "committed");
      assert.deepEqual(o.reconciled, o.outcome);
    }
  } else {
    assertPlan(o.plan, o.identity);
    if (boundary === "before-plan") assert.equal(o.journal, null);
    else {
      assert.deepEqual(o.journal.plan, o.plan);
      assert.equal(o.journal.complete, false);
      assert.equal(o.journal.items.length, 50);
    }
    if (boundary.endsWith("plan")) {
      assert.equal(o.method, "imports.plan");
      assert.equal(o.attempt, null);
    } else {
      assert.equal(o.key, o.plan.items[0].key);
      const item = o.journal.items[0];
      assert.equal(item.state, boundary === "after-skip" ? "skipped" : "pending");
      assert.equal(item.skipReason, boundary === "after-skip" ? TRUSTED_SKIP_REASON : null);
      assert.equal(item.receipt, null);
      if (boundary === "after-attempt") {
        assert.ok(o.attempt);
        assert.deepEqual(item.publicationTicket, o.attempt);
        assert.deepEqual(o.attempt.owner, o.owner);
      } else {
        assert.equal(o.attempt, null);
        assert.equal(item.publicationTicket, null);
      }
      assert.equal(
        o.method,
        boundary.endsWith("skip") ? "imports.record:trusted-host-skip" : "imports.admit",
      );
    }
  }
}
/** Retry the authorized host skip only if it never became durable. Never admit a fake attempt. */
export function resumeTrustedSkip(backend: PersistenceBackend, prior: Wire) {
  const admit = backend.imports.admit;
  let done = false;
  backend.imports.admit = async (owner, id, key) => {
    if (
      !done &&
      id === prior.identity.planId &&
      key === prior.key &&
      owner.sourceKey === prior.identity.sourceKey
    ) {
      const saved = await backend.imports.load(owner, id);
      assert.ok(saved);
      const item = saved.items.find((i) => i.key === key)!;
      assert.equal(item.state, "pending");
      assert.equal(item.publicationTicket, null);
      await backend.imports.record(owner, id, {
        key,
        state: "skipped",
        receipt: null,
        skipReason: TRUSTED_SKIP_REASON,
        publicationTicket: null,
      });
      done = true;
      // The normal coordinator catches this, reports blocked, and the next run reads the durable skip.
      throw Error("Trusted host skip persisted; reread journal");
    }
    return admit.call(backend.imports, owner, id, key);
  };
  return () => {
    backend.imports.admit = admit;
  };
}
export async function produceSemanticImport(input: {
  config: Wire;
  live: DesktopMainComposition;
  observer: ReturnType<typeof importObserver>;
  witness: ReturnType<typeof observeImportWriter>;
}) {
  const { desktopFoundationTestHandles } =
    await import("../../apps/desktop/src/main/plugins/controller.js");
  const { syntheticImportDescriptor: descriptor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-fixtures.js");
  const { importIdFor, barrierKeyFor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-sources.js");
  const { originalFiles, publishImportPause, captureImportObservation } =
    await import("./plugin-persistence-import.js");
  const { config, live, observer, witness } = input,
    handles = desktopFoundationTestHandles(live),
    backend = handles.backend;
  const boundary = semanticBoundary(config.importTrial),
    identity = {
      sourceKey: descriptor.targetSourceKey,
      descriptorId: descriptor.id,
      planId: importIdFor(descriptor.id, descriptor.targetSourceKey),
      barrierKey: barrierKeyFor(descriptor.id),
    };
  const originals = await originalFiles(config.syntheticRoot);
  const base = {
    slice: boundary,
    boundary,
    identity,
    phase: config.importPhase,
    rf5Complete: false,
    preferenceSeed: config.importPreferenceSeed ?? null,
    writers: config.importWriterProofs,
    originals,
    pid: process.pid,
    hostEpoch: handles.profile.hostEpoch,
    profileId: config.profileId,
  };
  assert.ok(
    witness.events.some((e) => e.kind === "freeze" && e.sourceKey === identity.sourceKey),
    "Missing original composition writer freeze",
  );
  assert.ok(
    witness.events.some((e) => e.kind === "composition-returned"),
    "Missing actual composition return",
  );
  const run = () =>
    live.plugins.persistence170!.imports.run(descriptor, new AbortController().signal);
  if (config.importPhase === "kill") {
    armSemanticImport({
      backend,
      identity,
      boundary,
      pause: async (evidence) => {
        const observed = { ...base, ...evidence, writerEvents: clone(witness.events) };
        assertSemanticPause(observed);
        await publishImportPause(config.report, {
          format: 1,
          level: "real-process",
          case: "import-restart",
          status: "paused-import",
          runId: config.runId,
          profileId: config.profileId,
          pid: process.pid,
          hostEpoch: handles.profile.hostEpoch,
          commit: config.commit,
          bundleSha256: config.bundleSha256,
          artifactSha256: config.artifactSha256,
          evidence: { importSlice: observed },
          pausedAt: Date.now(),
        });
        return new Promise<never>(() => {});
      },
    });
    await run();
    throw Error("Semantic boundary did not pause");
  }
  assert.ok(["reopen1", "reopen2", "reopen3", "deleted"].includes(config.importPhase));
  const prior = JSON.parse(await readFile(config.killedReceipt, "utf8")).evidence.importSlice;
  assertSemanticPause(prior);
  assert.equal(prior.boundary, boundary);
  assert.deepEqual(prior.originals, originals);
  const load = backend.imports.load,
    reconcile = backend.imports.reconcile;
  let initial: Wire | undefined;
  const reconciliations: Wire[] = [];
  backend.imports.reconcile = async (ticket) => {
    const result = await reconcile.call(backend.imports, ticket);
    if (ticket.owner.sourceKey === identity.sourceKey && ticket.target.kind === "record") {
      assert.ok(reconciliations.length < 512);
      reconciliations.push({ ticket: clone(ticket), result: clone(result) });
    }
    return result;
  };
  backend.imports.load = async (owner, id) => {
    const journal = await load.call(backend.imports, owner, id);
    if (!initial && id === identity.planId && owner.sourceKey === identity.sourceKey) {
      assert.equal(owner.hostEpoch, handles.profile.hostEpoch);
      const barrier = decodeBarrier(
        await backend.evidence.auxiliary(owner, "import", identity.barrierKey),
        identity,
      );
      initial = { owner: clone(owner), journal: clone(journal), barrier, at: Date.now() };
    }
    return journal;
  };
  const restoreSkip =
    boundary === "before-skip" && config.importPhase === "reopen1"
      ? resumeTrustedSkip(backend, prior)
      : () => {};
  let progress;
  try {
    for (let n = 0; n < 10; n++) {
      progress = await run();
      if (progress.state === "complete") break;
      assert.equal(progress.state, "blocked");
    }
  } finally {
    backend.imports.load = load;
    backend.imports.reconcile = reconcile;
    restoreSkip();
  }
  assert.equal(progress?.state, "complete");
  assert.ok(initial);
  const finalJournal = await load.call(backend.imports, initial.owner, identity.planId);
  const finalBarrier = decodeBarrier(
    await backend.evidence.auxiliary(initial.owner, "import", identity.barrierKey),
    identity,
  );
  const count = boundary.endsWith("skip") ? 49 : 50;
  for (let n = 0; n < count - (config.importPhase === "deleted" ? 1 : 0); n++)
    assert.equal((await live.plugins.execute("test.synthetic.inspect")).ok, true);
  if (config.importPhase === "reopen3")
    assert.equal((await live.plugins.execute("test.synthetic.delete-first")).ok, true);
  assert.deepEqual(await originalFiles(config.syntheticRoot), originals);
  const deadline = Date.now() + 5000;
  while (!observer.processes.some((p) => p.kind === "boot")) {
    assert.ok(Date.now() < deadline, "Missing utility process boot");
    await new Promise((r) => setTimeout(r, 10));
  }
  const observed = captureImportObservation(
    {
      ...base,
      prior,
      initial,
      reconciliations,
      finalJournal,
      finalBarrier,
      progress,
      writerEvents: clone(witness.events),
      expectedTargets: count,
    },
    observer,
    [],
  );
  await assertSemanticPhase(observed);
  return { checks: {}, events: [], samples: {}, importSlice: observed };
}
export function assertSemanticPhase(o: Wire) {
  const boundary = semanticBoundary(o.boundary),
    skip = boundary.endsWith("skip");
  assert.equal(o.slice, boundary);
  assert.equal(o.rf5Complete, false);
  assertSemanticPause(o.prior);
  assert.equal(o.prior.boundary, boundary);
  assert.deepEqual(o.identity, o.prior.identity);
  assert.equal(o.originals.length, 50);
  assert.equal(
    o.originals.reduce((n: number, r: Wire) => n + r.bytes, 0),
    419430400,
  );
  assert.deepEqual(o.originals, o.prior.originals);
  assert.equal(o.progress.state, "complete");
  assert.equal(o.initial.owner.hostEpoch, o.hostEpoch);
  assert.equal(o.initial.owner.sourceKey, o.identity.sourceKey);
  const freeze = o.writerEvents.find((e: Wire) => e.kind === "freeze"),
    composed = o.writerEvents.find((e: Wire) => e.kind === "composition-returned");
  assert.ok(freeze && composed && freeze.at <= composed.at && composed.at <= o.initial.at);
  assert.equal(freeze.sourceKey, o.identity.sourceKey);
  if (o.phase === "reopen1") {
    if (["before-plan", "before-barrier", "after-barrier"].includes(boundary))
      assert.equal(o.initial.journal, null);
    else {
      assert.deepEqual(o.initial.journal.plan, o.prior.plan);
      assert.equal(o.initial.journal.complete, false);
      const first = o.initial.journal.items[0];
      assert.equal(first.state, boundary === "after-skip" ? "skipped" : "pending");
      assert.deepEqual(
        first.publicationTicket,
        boundary === "after-attempt" ? o.prior.attempt : null,
      );
    }
    if (boundary === "before-barrier") assert.equal(o.initial.barrier, null);
    else {
      assert.equal(o.initial.barrier.state, "active");
      if (boundary === "after-barrier")
        assert.deepEqual(o.initial.barrier, o.prior.barrierDocument);
    }
  } else {
    assert.equal(o.initial.journal.complete, true);
    assert.equal(o.initial.barrier.state, "complete");
  }
  assertPlan(o.finalJournal.plan, o.identity);
  assert.equal(o.finalJournal.complete, true);
  assert.equal(o.finalBarrier.state, "complete");
  decodeBarrier(Buffer.from(JSON.stringify(o.finalBarrier)), o.identity);
  if (o.initial.barrier) {
    decodeBarrier(Buffer.from(JSON.stringify(o.initial.barrier)), o.identity);
    assert.equal(o.finalBarrier.barrier, o.initial.barrier.barrier);
    assert.deepEqual(o.finalBarrier.originalTicket, o.initial.barrier.originalTicket);
  }
  if (o.prior.journal) assert.deepEqual(o.finalJournal.plan, o.prior.plan);
  if (boundary === "after-attempt" && o.phase === "reopen1") {
    const original = o.prior.plan.items[0].ticket;
    assert.ok(
      o.reconciliations.some(
        (r: Wire) => r.ticket.id === original.id && r.result.disposition === "not-committed",
      ),
    );
    assert.notEqual(o.finalJournal.items[0].publicationTicket.id, o.prior.attempt.id);
  }
  const skipped = o.finalJournal.items.filter((i: Wire) => i.state === "skipped");
  assert.equal(skipped.length, skip ? 1 : 0);
  if (skip) {
    assert.equal(skipped[0].key, o.prior.key);
    assert.equal(skipped[0].skipReason, TRUSTED_SKIP_REASON);
    assert.equal(skipped[0].publicationTicket, null);
    assert.equal(skipped[0].receipt, null);
  }
  assert.equal(
    o.finalJournal.items.filter((i: Wire) => i.state === "committed").length,
    skip ? 49 : 50,
  );
  assert.equal(o.expectedTargets, skip ? 49 : 50);
  assertImportStorage(o, o.expectedTargets - (o.phase === "deleted" ? 1 : 0));
  const records = o.wire.find((r: Wire) => r.direction === "host" && r.method === "storage/list")
    .message.result.value.entries;
  for (const record of records) {
    const index = o.finalJournal.plan.items.findIndex(
      (i: Wire) => i.ticket.target.id === record.id,
    );
    assert.ok(index >= 0);
    const item = o.finalJournal.items[index];
    assert.equal(item.state, "committed");
    assert.equal(item.receipt.commitId, item.publicationTicket.id);
    assert.equal(item.receipt.revision, record.revision);
    assert.deepEqual(item.publicationTicket.metadata.record, record);
  }
  if (skip)
    assert.ok(
      !records.some(
        (r: Wire) =>
          r.id ===
          o.finalJournal.plan.items.find((i: Wire) => i.key === o.prior.key).ticket.target.id,
      ),
    );
}
export async function assertSemanticSequence(receipts: Wire[]) {
  assert.deepEqual(
    receipts.map((r) => r.evidence.importSlice.phase),
    ["kill", "reopen1", "reopen2", "reopen3", "deleted"],
  );
  const killed = receipts[0]!;
  assert.equal(killed.status, "killed-import");
  assert.equal(killed.signal, "SIGKILL");
  assertSemanticPause(killed.evidence.importSlice);
  assert.equal(new Set(receipts.map((r) => r.pid)).size, 5);
  assert.equal(new Set(receipts.map((r) => r.hostEpoch)).size, 5);
  let expected: Wire[] | undefined, deleted: string | undefined;
  for (const receipt of receipts.slice(1)) {
    for (const key of ["profileId", "commit", "artifactSha256", "bundleSha256"])
      assert.deepEqual(receipt[key], killed[key]);
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.cleanup.children, 0);
    assert.equal(receipt.cleanup.workers, 0);
    const o = receipt.evidence.importSlice;
    assert.deepEqual(o.prior, killed.evidence.importSlice);
    await assertSemanticPhase(o);
    const boot = o.processes.find((p: Wire) => p.kind === "boot");
    assert.ok(receipt.observedDescendants.some((p: Wire) => p.pid === boot.pid));
    assert.equal(o.processes.filter((p: Wire) => p.kind === "exit").length, 1);
    const replies = o.wire.filter((r: Wire) => r.direction === "host" && r.method);
    const records = replies
      .find((r: Wire) => r.method === "storage/list")
      .message.result.value.entries.slice()
      .sort((a: Wire, b: Wire) => a.id.localeCompare(b.id));
    expected ??= records;
    assert.ok(expected);
    assert.deepEqual(
      records,
      o.phase === "deleted" ? expected.filter((r) => r.id !== deleted) : expected,
    );
    if (o.phase === "reopen3")
      deleted = replies.find((r: Wire) => r.method === "storage/delete").params.id;
  }
  assert.ok(deleted);
}
