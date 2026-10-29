import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, appendFileSync } from "node:fs";
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { PluginProcess } from "@kobrixa/plugin-runtime";
import type { PersistenceBackend } from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DesktopMainComposition } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type { PersistenceFaultControl } from "../../apps/desktop/src/main/plugins/persistence/worker.js";
// Heterogeneous, bounded observed RPC envelopes. Payload bytes are hashed then discarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export const IMPORT_SLICE = "head-before-receipt";
export const IMPORT_PUBLICATION_TRIALS = [
  "before-publish",
  "after-publish",
  "before-receipt",
  "after-receipt",
  "before-marker",
  "after-marker",
] as const;
export const IMPORT_SIX = "publication-six";
export function importCut(trial: string) {
  if (trial === IMPORT_SLICE) return "after-publish";
  assert.ok(
    (IMPORT_PUBLICATION_TRIALS as readonly string[]).includes(trial),
    "Unknown import publication trial",
  );
  return trial;
}

/** Specific forwarding probes; never replace the worker, its result, or publication. */
export function armImportTrial(
  backend: PersistenceBackend,
  fault: PersistenceFaultControl,
  trial: string,
  pause: (evidence: Wire) => Promise<never>,
) {
  const cut = importCut(trial);
  const publish = backend.engine.publish.bind(backend.engine);
  const admit = backend.imports.admit.bind(backend.imports);
  const record = backend.imports.record.bind(backend.imports);
  const complete = backend.imports.complete.bind(backend.imports);
  let selected = false;
  let context: Wire | undefined;
  backend.imports.admit = async (owner, planId, key) => {
    const ticket = await admit(owner, planId, key);
    if (!selected) {
      const saved = await backend.imports.load(owner, planId);
      assert.ok(saved);
      const item = saved.plan.items.find((i) => i.key === key);
      assert.ok(item);
      context = { owner, planId, key, ticket, plannedTicket: item.ticket, journal: saved };
    }
    return ticket;
  };
  backend.engine.publish = async (ticket) => {
    if (
      !selected &&
      ticket.target.kind === "record" &&
      ["before-publish", "after-publish"].includes(cut)
    ) {
      selected = true;
      assert.equal(context?.ticket.id, ticket.id);
      const point = cut as "before-publish" | "after-publish";
      const start = fault.trace().length;
      fault.arm(point, "pause");
      const reached = fault.reached(point);
      const operation = publish(ticket);
      // Observe rejection immediately, including failure before the selected hook.
      await Promise.race([
        reached,
        operation.then(() => {
          throw Error("Publication missed fault");
        }),
      ]);
      return pause({
        ...context,
        method: "engine.publish",
        cut,
        trace: fault.trace().slice(start),
      });
    }
    return publish(ticket);
  };
  backend.imports.record = async (owner, planId, evidence) => {
    if (
      !selected &&
      evidence.state === "committed" &&
      ["before-receipt", "after-receipt"].includes(cut)
    ) {
      selected = true;
      assert.ok(evidence.publicationTicket);
      assert.equal(evidence.receipt?.commitId, evidence.publicationTicket.id);
      const before = await backend.imports.load(owner, planId);
      assert.ok(before);
      const item = before.plan.items.find((i) => i.key === evidence.key);
      assert.ok(item);
      if (cut === "after-receipt") await record(owner, planId, evidence);
      const journal = await backend.imports.load(owner, planId);
      return pause({
        cut,
        method: "imports.record",
        owner,
        planId,
        key: evidence.key,
        ticket: evidence.publicationTicket,
        plannedTicket: item.ticket,
        evidence,
        before,
        journal,
        returned: cut === "after-receipt",
        trace: [],
      });
    }
    return record(owner, planId, evidence);
  };
  backend.imports.complete = async (owner, planId) => {
    if (!selected && ["before-marker", "after-marker"].includes(cut)) {
      selected = true;
      const before = await backend.imports.load(owner, planId);
      assert.ok(before && !before.complete);
      assert.equal(before.items.length, 50);
      assert.ok(
        before.items.every((i) => i.state === "committed" && i.receipt && i.publicationTicket),
      );
      const first = before.items[0]!;
      const item = before.plan.items.find((i) => i.key === first.key)!;
      const evidence: Wire = {
        cut,
        method: "imports.complete",
        owner,
        planId,
        ticket: first.publicationTicket,
        plannedTicket: item.ticket,
        key: first.key,
        before,
      };
      if (cut === "before-marker") {
        const start = fault.trace().length;
        fault.arm("import-marker", "pause");
        const reached = fault.reached("import-marker");
        const operation = complete(owner, planId);
        await Promise.race([
          reached,
          operation.then(() => {
            throw Error("Completion missed fault");
          }),
        ]);
        return pause({
          ...evidence,
          journal: before,
          returned: false,
          trace: fault.trace().slice(start),
        });
      }
      await complete(owner, planId);
      return pause({
        ...evidence,
        journal: await backend.imports.load(owner, planId),
        returned: true,
        trace: [],
      });
    }
    return complete(owner, planId);
  };
}

export function assertImportPause(o: Wire, trial = o.slice) {
  const cut = importCut(trial);
  assert.equal(o.slice, trial);
  // Old first-slice receipts had no semantic-cut field.
  if (o.cut === undefined && trial === IMPORT_SLICE) {
    assert.ok(o.trace.some((t: Wire) => t.point === "after-publish" && t.ticket === o.ticket.id));
    return;
  }
  assert.equal(o.cut, cut);
  assert.equal(o.owner.sourceKey, "builtin:test.synthetic");
  assert.deepEqual(o.ticket.owner, o.owner);
  assert.equal(o.journal.plan.id, o.planId);
  assert.equal(o.journal.plan.items.length, 50);
  const item = o.journal.items.find((i: Wire) => i.key === o.key);
  assert.ok(item);
  assert.deepEqual(o.journal.plan.items.find((i: Wire) => i.key === o.key).ticket, o.plannedTicket);
  assert.deepEqual(item.publicationTicket, o.ticket);
  if (cut.endsWith("publish")) {
    assert.equal(o.method, "engine.publish");
    assert.equal(item.state, "pending");
    assert.equal(o.journal.complete, false);
    assert.ok(o.trace.some((t: Wire) => t.point === cut && t.ticket === o.ticket.id));
  } else if (cut.endsWith("receipt")) {
    assert.equal(o.method, "imports.record");
    assert.equal(o.before.items.find((i: Wire) => i.key === o.key).state, "pending");
    assert.equal(o.evidence.receipt.commitId, o.ticket.id);
    assert.equal(o.evidence.state, "committed");
    assert.equal(o.returned, cut === "after-receipt");
    assert.equal(item.state, o.returned ? "committed" : "pending");
    if (o.returned) assert.deepEqual(item, o.evidence);
    assert.equal(o.journal.complete, false);
  } else {
    assert.equal(o.method, "imports.complete");
    assert.equal(o.before.complete, false);
    assert.equal(o.journal.items.length, 50);
    assert.ok(
      o.journal.items.every(
        (i: Wire) => i.state === "committed" && i.receipt?.commitId === i.publicationTicket?.id,
      ),
    );
    assert.equal(o.returned, cut === "after-marker");
    assert.equal(o.journal.complete, o.returned);
    if (!o.returned)
      assert.ok(o.trace.some((t: Wire) => t.point === "import-marker" && t.ticket === null));
  }
}

export async function originalFiles(root: string) {
  const rows = [];
  for (const name of (await readdir(root)).sort()) {
    const hash = createHash("sha256");
    let bytes = 0;
    const chunks = [];
    for await (const chunk of createReadStream(path.join(root, name), { highWaterMark: 262144 })) {
      chunks.push({
        offset: bytes,
        bytes: chunk.length,
        sha256: createHash("sha256").update(chunk).digest("hex"),
      });
      hash.update(chunk);
      bytes += chunk.length;
    }
    rows.push({ name, bytes, sha256: hash.digest("hex"), chunks });
  }
  assert.equal(rows.length, 50);
  assert.ok(rows.every((r) => r.bytes === 8388608));
  return rows;
}
export function importObserver(file: string) {
  const rows: Wire[] = [];
  const processes: Wire[] = [];
  const pending = new Map<string, Wire>();
  const reads = new Map<
    string,
    { hash: ReturnType<typeof createHash>; offset: number; id: string }
  >();
  let sequence = 0;
  return {
    rows,
    processes,
    output(owner: ResourceOwner, line: string) {
      const index = line.indexOf("IMPORT_BOOT:");
      if (index < 0) return;
      const boot = JSON.parse(line.slice(index + 12));
      assert.ok(Number.isSafeInteger(boot.pid) && boot.pid > 0);
      assert.equal(boot.pluginId, owner.pluginId);
      processes.push({ kind: "boot", owner: structuredClone(owner), ...boot, at: Date.now() });
    },
    attach(owner: ResourceOwner, child: PluginProcess): PluginProcess {
      const observe = (direction: string, text: string) => {
        const m = JSON.parse(text);
        const row: Wire = {
          sequence: ++sequence,
          at: Date.now(),
          owner: structuredClone(owner),
          direction,
          message: m,
        };
        if (direction === "plugin" && m.method?.startsWith("storage/")) {
          assert.ok(pending.size < 32);
          pending.set(String(m.id), structuredClone(m));
        }
        if (direction === "host" && m.id !== undefined && pending.has(String(m.id))) {
          const request = pending.get(String(m.id))!;
          pending.delete(String(m.id));
          row.requestId = request.id;
          row.method = request.method;
          row.params = request.params;
          // Preserve JSON-RPC's business envelope. Failed business results remain
          // on the wire and are forwarded unchanged; only successful values decode.
          const value = m.result?.ok === true ? m.result.value : undefined;
          if (value && request.method === "storage/openRead")
            reads.set(value.read, {
              hash: createHash("sha256"),
              offset: 0,
              id: value.record.id,
            });
          if (value && request.method === "storage/readChunk") {
            const bytes = Buffer.from(value.data, "base64"),
              r = reads.get(request.params.read);
            assert.ok(r);
            assert.equal(request.params.offset, r.offset);
            assert.equal(value.offset, r.offset);
            assert.equal(value.nextOffset, r.offset + bytes.length);
            r.hash.update(bytes);
            r.offset += bytes.length;
            row.chunk = {
              offset: request.params.offset,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              recordId: r.id,
              eof: value.eof,
            };
            if (value.eof) row.chunk.recordSha256 = r.hash.digest("hex");
            row.message = { ...m, result: { ...m.result, value: { ...value, data: undefined } } };
          }
          if (value && request.method === "storage/closeRead") reads.delete(request.params.read);
        }
        assert.ok(rows.length < 10000, "bounded per-phase trace");
        appendFileSync(file, JSON.stringify(row) + "\n");
        rows.push(row);
      };
      const off = child.onMessage((text) => observe("plugin", text));
      child.onExit((exit) => {
        processes.push({ kind: "exit", owner: structuredClone(owner), exit, at: Date.now() });
        off();
      });
      return {
        ...child,
        send(text) {
          observe("host", text);
          child.send(text);
        },
      };
    },
  };
}
/** Observe the coordinator's own admitted owner; historical tickets are not read authority. */
export async function observeImportJournal<T>(
  backend: PersistenceBackend,
  prior: Wire,
  hostEpoch: string,
  run: () => Promise<T>,
) {
  const original = backend.imports.load;
  let observed:
    | { journal: NonNullable<Awaited<ReturnType<typeof original>>>; owner: ResourceOwner }
    | undefined;
  backend.imports.load = async (owner, planId) => {
    const journal = await original.call(backend.imports, owner, planId);
    if (!observed && planId === prior.planId && owner.sourceKey === prior.owner.sourceKey) {
      assert.equal(owner.hostEpoch, hostEpoch);
      assert.equal(owner.pluginId, prior.owner.pluginId);
      assert.ok(journal);
      observed = { journal: structuredClone(journal), owner: structuredClone(owner) };
    }
    return journal;
  };
  try {
    const value = await run();
    assert.ok(observed, "Missing coordinator journal read under current admitted owner");
    return { value, ...observed };
  } finally {
    backend.imports.load = original;
  }
}

export async function produceImportSlice(input: {
  config: Wire;
  live: DesktopMainComposition;
  fault: PersistenceFaultControl;
  observer: ReturnType<typeof importObserver>;
}) {
  const { desktopFoundationTestHandles } =
    await import("../../apps/desktop/src/main/plugins/controller.js");
  const { syntheticImportDescriptor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-fixtures.js");
  const { config, live, fault, observer } = input,
    handles = desktopFoundationTestHandles(live),
    backend = handles.backend;
  const cut = importCut(config.importTrial);
  assert.ok(["kill", "reopen1", "reopen2", "reopen3", "deleted"].includes(config.importPhase));
  const originals = await originalFiles(config.syntheticRoot);
  const base: Wire = {
    slice: config.importTrial,
    cut,
    phase: config.importPhase,
    rf5Complete: false,
    originals,
    profileId: config.profileId,
    hostEpoch: handles.profile.hostEpoch,
    pid: process.pid,
  };
  const imports = live.plugins.persistence170!.imports;
  if (config.importPhase === "kill") {
    armImportTrial(backend, fault, config.importTrial, async (evidence) => {
      const observed = { ...base, ...evidence };
      assertImportPause(observed);
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
      // Only the external supervisor terminates this host. Do not advance the operation.
      return new Promise<never>(() => {});
    });
    await imports.run(syntheticImportDescriptor, new AbortController().signal);
    throw Error("Selected import boundary did not pause");
  }
  const killed = JSON.parse(await readFile(config.killedReceipt, "utf8"));
  assert.deepEqual(originals, killed.evidence.importSlice.originals);
  // Reconcile the exact old ticket before the coordinator can dispatch new work.
  const prior = killed.evidence.importSlice;
  assertImportPause(prior, config.importTrial);
  // A pre-publication attempt is replaced on resume. Its planned ticket remains
  // the stable journal anchor; do not pretend the retired attempt was committed.
  const anchor =
    cut === "before-publish" && config.importPhase !== "reopen1"
      ? prior.plannedTicket
      : prior.ticket;
  const reconciliation = await backend.imports.reconcile(anchor);
  assert.equal(
    reconciliation.disposition,
    cut === "before-publish" && config.importPhase === "reopen1" ? "not-committed" : "committed",
  );
  const observedJournal = await observeImportJournal(
    backend,
    prior,
    handles.profile.hostEpoch,
    async () => {
      let result: Awaited<ReturnType<typeof imports.run>> | undefined;
      for (let attempt = 0; attempt < 10; attempt++) {
        result = await imports.run(syntheticImportDescriptor, new AbortController().signal);
        if (result.state === "complete") break;
        assert.equal(result.state, "blocked", JSON.stringify(result));
      }
      return result;
    },
  );
  const { value: progress, journal: journalAtReopen, owner: journalOwner } = observedJournal;
  assert.equal(progress?.state, "complete");
  for (let n = 0; n < (config.importPhase === "deleted" ? 49 : 50); n++) {
    const result = await live.plugins.execute("test.synthetic.inspect");
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  if (config.importPhase === "reopen3") {
    const deletion = await live.plugins.execute("test.synthetic.delete-first");
    assert.equal(deletion.ok, true, JSON.stringify(deletion));
  }
  assert.deepEqual(await originalFiles(config.syntheticRoot), originals);
  const bootDeadline = Date.now() + 5000;
  while (!observer.processes.some((p) => p.kind === "boot")) {
    assert.ok(Date.now() < bootDeadline, "Missing actual utilityProcess boot");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const observed = captureImportObservation(
    {
      ...base,
      reconciliation,
      reconciliationTicket: anchor,
      journalAtReopen,
      journalOwner,
      journalKey: prior.key,
      progress,
    },
    observer,
    fault.trace(),
  );
  assertImportPhase(observed);
  return { checks: {}, events: [], samples: {}, importSlice: observed };
}
/** Keep observer arrays live: the entry serializes after actual composition.close(). */
export function captureImportObservation(
  base: Wire,
  observer: ReturnType<typeof importObserver>,
  trace: ReturnType<PersistenceFaultControl["trace"]>,
) {
  return { ...base, wire: observer.rows, processes: observer.processes, trace };
}

/** The external supervisor polls while this host is alive. Never expose partial JSON. */
export async function publishImportPause(file: string, report: Wire) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(report), { flag: "wx" });
  await rename(temporary, file);
}

export function assertImportPhase(o: Wire) {
  const cut = importCut(o.slice);
  assert.equal(o.rf5Complete, false);
  assert.ok(["reopen1", "reopen2", "reopen3", "deleted"].includes(o.phase));
  assert.equal(o.originals.length, 50);
  assert.equal(
    o.originals.reduce((n: number, r: Wire) => n + r.bytes, 0),
    419430400,
  );
  assert.equal(
    o.reconciliation.disposition,
    cut === "before-publish" && o.phase === "reopen1" ? "not-committed" : "committed",
  );
  assert.equal(o.progress.state, "complete");
  if (o.cut !== undefined) {
    assert.equal(o.cut, cut);
    assert.equal(o.journalOwner.hostEpoch, o.hostEpoch);
    assert.equal(o.journalOwner.sourceKey, "builtin:test.synthetic");
    assert.equal(o.journalAtReopen.plan.items.length, 50);
    assert.equal(o.journalAtReopen.items.length, 50);
    assert.equal(o.journalAtReopen.complete, o.phase !== "reopen1" || cut === "after-marker");
    const first = o.journalAtReopen.items.find((i: Wire) => i.key === o.journalKey);
    assert.ok(first);
    assert.equal(
      first.state,
      o.phase !== "reopen1" || ["after-receipt", "before-marker", "after-marker"].includes(cut)
        ? "committed"
        : "pending",
    );
  }
  const boots = o.processes.filter((p: Wire) => p.kind === "boot");
  assert.equal(boots.length, 1);
  assert.ok(boots[0].pid > 0 && boots[0].pid !== o.pid);
  assert.equal(boots[0].owner.hostEpoch, o.hostEpoch);
  const replies = o.wire.filter((r: Wire) => r.direction === "host" && r.method);
  for (const row of replies) {
    assert.equal(row.message.error, undefined);
    assert.equal(row.message.result?.ok, true, "storage business response failed");
    assert.ok(row.message.result.value && typeof row.message.result.value === "object");
    assert.equal(row.owner.sourceKey, "builtin:test.synthetic");
    assert.equal(row.owner.hostEpoch, o.hostEpoch);
    const request = o.wire.find(
      (q: Wire) =>
        q.direction === "plugin" &&
        q.message.id === row.requestId &&
        q.message.method === row.method,
    );
    assert.ok(request);
    assert.equal(row.requestId, row.message.id);
    assert.deepEqual(request.owner, row.owner);
    assert.deepEqual(request.message.params, row.params);
    assert.ok(request.sequence < row.sequence);
  }

  const list = replies.find((r: Wire) => r.method === "storage/list");
  assert.ok(list?.message.result);
  const records = list.message.result.value.entries;
  assert.equal(list.message.result.value.nextCursor, undefined);
  assert.equal(records.length, o.phase === "deleted" ? 49 : 50);
  assert.equal(new Set(records.map((r: Wire) => r.id)).size, records.length);
  for (const record of records) {
    assert.equal(record.byteLength, 8388608);
    const source = o.originals.find((r: Wire) => r.sha256 === record.sha256);
    assert.ok(source);
    const opened = replies.filter(
      (r: Wire) =>
        r.method === "storage/openRead" && r.message.result.value.record.id === record.id,
    );
    assert.equal(opened.length, 1);
    assert.equal(opened[0].params.expectedRevision, record.revision);
    assert.deepEqual(opened[0].message.result.value.record, record);
    const closed = replies.filter(
      (r: Wire) =>
        r.method === "storage/closeRead" && r.params.read === opened[0].message.result.value.read,
    );
    assert.equal(closed.length, 1);
    const chunks = replies.filter((r: Wire) => r.chunk?.recordId === record.id);
    assert.ok(chunks.length > 0);
    let offset = 0;
    chunks.forEach((r: Wire, index: number) => {
      assert.equal(r.params.read, opened[0].message.result.value.read);
      assert.ok(opened[0].sequence < r.sequence && r.sequence < closed[0].sequence);
      const aligned = source.chunks.find(
        (c: Wire) => c.offset === r.chunk.offset && c.bytes === r.chunk.bytes,
      );
      if (aligned) assert.equal(r.chunk.sha256, aligned.sha256);
      assert.match(r.chunk.sha256, /^[0-9a-f]{64}$/);
      assert.equal(r.chunk.offset, offset);
      assert.equal(r.params.offset, offset);
      assert.ok(Number.isSafeInteger(r.chunk.bytes) && r.chunk.bytes > 0);
      assert.ok(
        Number.isSafeInteger(r.params.maxBytes) &&
          r.params.maxBytes > 0 &&
          r.params.maxBytes <= 262144,
      );
      assert.ok(r.chunk.bytes <= r.params.maxBytes);
      offset += r.chunk.bytes;
      assert.ok(offset <= record.byteLength);
      assert.equal(r.chunk.eof, offset === record.byteLength);
      assert.equal(r.chunk.eof, index === chunks.length - 1);
      assert.equal(r.requestId, r.message.id);
      assert.equal(r.message.result.value.data, undefined);
      assert.equal(r.message.result.value.offset, r.chunk.offset);
      assert.equal(r.message.result.value.nextOffset, r.chunk.offset + r.chunk.bytes);
      assert.equal(r.message.result.value.eof, r.chunk.eof);
      const request = o.wire.find(
        (q: Wire) =>
          q.direction === "plugin" &&
          q.message.id === r.requestId &&
          q.message.method === "storage/readChunk",
      );
      assert.ok(request);
      assert.deepEqual(request.message.params, r.params);
      assert.ok(request.sequence < r.sequence);
      assert.deepEqual(request.owner, r.owner);
    });
    assert.equal(offset, record.byteLength);
    assert.equal(chunks.at(-1).chunk.recordSha256, source.sha256);
  }
  if (o.phase === "reopen3") {
    const deleted = replies.filter((r: Wire) => r.method === "storage/delete");
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].message.result.value.deleted, true);
    const target = records.find((r: Wire) => r.id === deleted[0].params.id);
    assert.ok(target);
    assert.equal(target.revision, deleted[0].params.expectedRevision);
  }
}
export function assertImportSlice(receipts: Wire[]) {
  assert.deepEqual(
    receipts.map((r) => r.evidence.importSlice.phase),
    ["kill", "reopen1", "reopen2", "reopen3", "deleted"],
  );
  const killed = receipts[0]!;
  assert.equal(killed.signal, "SIGKILL");
  assert.equal(killed.status, "killed-import");
  assertImportPause(killed.evidence.importSlice);
  assert.equal(new Set(receipts.map((r) => r.hostEpoch)).size, 5);
  assert.equal(new Set(receipts.map((r) => r.pid)).size, 5);
  let expected: Wire[] | undefined, deletedId: string | undefined;
  for (const receipt of receipts.slice(1)) {
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.signal, null);
    assert.equal(receipt.cleanup.children, 0);
    assert.equal(receipt.cleanup.workers, 0);
    for (const key of ["profileId", "commit", "artifactSha256", "bundleSha256"])
      assert.equal(receipt[key], killed[key]);
    const o = receipt.evidence.importSlice;
    assertImportPhase(o);
    assert.equal(o.slice, killed.evidence.importSlice.slice);
    if (o.cut !== undefined) {
      assert.deepEqual(o.journalAtReopen.plan, killed.evidence.importSlice.journal.plan);
      assert.equal(o.journalKey, killed.evidence.importSlice.key);
    }
    if (importCut(o.slice) !== "before-publish")
      assert.equal(o.reconciliation.receipt.commitId, killed.evidence.importSlice.ticket.id);
    else if (o.phase !== "reopen1") {
      assert.deepEqual(o.reconciliationTicket, killed.evidence.importSlice.plannedTicket);
      assert.notEqual(o.reconciliation.receipt.commitId, killed.evidence.importSlice.ticket.id);
    }
    const boot = o.processes.find((p: Wire) => p.kind === "boot");
    assert.ok(
      receipt.observedDescendants.some((p: Wire) => p.pid === boot.pid),
      "Utility process not independently observed",
    );
    assert.equal(o.processes.filter((p: Wire) => p.kind === "exit").length, 1);
    assert.deepEqual(o.originals, killed.evidence.importSlice.originals);
    const replies = o.wire.filter((r: Wire) => r.direction === "host" && r.method);
    const records = replies
      .find((r: Wire) => r.method === "storage/list")
      .message.result.value.entries.slice()
      .sort((a: Wire, b: Wire) => a.id.localeCompare(b.id));
    if (!expected) expected = records;
    assert.ok(expected);
    assert.deepEqual(
      records,
      o.phase === "deleted" ? expected.filter((r) => r.id !== deletedId) : expected,
    );
    if (o.phase === "reopen3")
      deletedId = replies.find((r: Wire) => r.method === "storage/delete").params.id;
  }
  assert.ok(deletedId);
}

/** Six publication cuts are still only a subset of the 18-boundary matrix. */
export function assertImportTrials(trials: Wire[], selection: string) {
  const required = selection === IMPORT_SIX ? [...IMPORT_PUBLICATION_TRIALS] : [selection];
  assert.deepEqual(
    trials.map((t) => t.trial),
    required,
  );
  assert.equal(new Set(trials.map((t) => t.reports[0]?.profileId)).size, required.length);
  const all = trials.flatMap((t) => t.reports);
  assert.equal(new Set(all.map((r) => r.pid)).size, required.length * 5);
  assert.equal(new Set(all.map((r) => r.hostEpoch)).size, required.length * 5);
  for (const t of trials) {
    assert.equal(t.reports[0].evidence.importSlice.slice, t.trial);
    assertImportSlice(t.reports);
  }
}
