import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, appendFileSync } from "node:fs";
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { PluginProcess } from "@kobrixa/plugin-runtime";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { DesktopMainComposition } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type { PersistenceFaultControl } from "../../apps/desktop/src/main/plugins/persistence/worker.js";
// Heterogeneous, bounded observed RPC envelopes. Payload bytes are hashed then discarded.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Wire = Record<string, any>;
export const IMPORT_SLICE = "head-before-receipt";
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
          if (m.result && request.method === "storage/openRead")
            reads.set(m.result.read, {
              hash: createHash("sha256"),
              offset: 0,
              id: m.result.record.id,
            });
          if (m.result && request.method === "storage/readChunk") {
            const bytes = Buffer.from(m.result.data, "base64"),
              r = reads.get(request.params.read);
            assert.ok(r);
            assert.equal(request.params.offset, r.offset);
            r.hash.update(bytes);
            r.offset += bytes.length;
            row.chunk = {
              offset: request.params.offset,
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              recordId: r.id,
              eof: m.result.eof,
            };
            if (m.result.eof) row.chunk.recordSha256 = r.hash.digest("hex");
            row.message = { ...m, result: { ...m.result, data: undefined } };
          }
          if (m.result && request.method === "storage/closeRead") reads.delete(request.params.read);
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
  assert.equal(config.importTrial, IMPORT_SLICE);
  assert.ok(["kill", "reopen1", "reopen2", "reopen3", "deleted"].includes(config.importPhase));
  const originals = await originalFiles(config.syntheticRoot);
  const base: Wire = {
    slice: IMPORT_SLICE,
    phase: config.importPhase,
    rf5Complete: false,
    originals,
    profileId: config.profileId,
    hostEpoch: handles.profile.hostEpoch,
    pid: process.pid,
  };
  const imports = live.plugins.persistence170!.imports;
  if (config.importPhase === "kill") {
    const publish = backend.engine.publish.bind(backend.engine);
    let selected: Wire | undefined;
    backend.engine.publish = async (ticket) => {
      if (!selected && ticket.target.kind === "record") {
        selected = structuredClone(ticket);
        fault.arm("after-publish", "pause");
        const reached = fault.reached("after-publish");
        const operation = publish(ticket);
        await reached;
        const trace = fault.trace().filter((t) => t.ticket === ticket.id);
        assert.ok(trace.some((t) => t.point === "after-publish"));
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
          evidence: { importSlice: { ...base, ticket, trace } },
          pausedAt: Date.now(),
        });
        return operation;
      }
      return publish(ticket);
    };
    await imports.run(syntheticImportDescriptor, new AbortController().signal);
    throw Error("Selected import boundary did not pause");
  }
  const killed = JSON.parse(await readFile(config.killedReceipt, "utf8"));
  assert.deepEqual(originals, killed.evidence.importSlice.originals);
  // Reconcile the exact old ticket before the coordinator can dispatch new work.
  const reconciliation = await backend.imports.reconcile(killed.evidence.importSlice.ticket);
  assert.equal(reconciliation.disposition, "committed");
  let progress: Awaited<ReturnType<typeof imports.run>> | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    progress = await imports.run(syntheticImportDescriptor, new AbortController().signal);
    if (progress.state === "complete") break;
    assert.equal(progress.state, "blocked", JSON.stringify(progress));
  }
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
    { ...base, reconciliation, progress },
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
  assert.equal(o.slice, IMPORT_SLICE);
  assert.equal(o.rf5Complete, false);
  assert.ok(["reopen1", "reopen2", "reopen3", "deleted"].includes(o.phase));
  assert.equal(o.originals.length, 50);
  assert.equal(
    o.originals.reduce((n: number, r: Wire) => n + r.bytes, 0),
    419430400,
  );
  assert.equal(o.reconciliation.disposition, "committed");
  assert.equal(o.progress.state, "complete");
  const boots = o.processes.filter((p: Wire) => p.kind === "boot");
  assert.equal(boots.length, 1);
  assert.ok(boots[0].pid > 0 && boots[0].pid !== o.pid);
  assert.equal(boots[0].owner.hostEpoch, o.hostEpoch);
  const replies = o.wire.filter((r: Wire) => r.direction === "host" && r.method);
  for (const row of replies) {
    assert.equal(row.message.error, undefined);
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
  const records = list.message.result.entries;
  assert.equal(list.message.result.nextCursor, undefined);
  assert.equal(records.length, o.phase === "deleted" ? 49 : 50);
  assert.equal(new Set(records.map((r: Wire) => r.id)).size, records.length);
  for (const record of records) {
    assert.equal(record.byteLength, 8388608);
    const source = o.originals.find((r: Wire) => r.sha256 === record.sha256);
    assert.ok(source);
    const opened = replies.filter(
      (r: Wire) => r.method === "storage/openRead" && r.message.result.record.id === record.id,
    );
    assert.equal(opened.length, 1);
    assert.equal(opened[0].params.expectedRevision, record.revision);
    assert.deepEqual(opened[0].message.result.record, record);
    const closed = replies.filter(
      (r: Wire) =>
        r.method === "storage/closeRead" && r.params.read === opened[0].message.result.read,
    );
    assert.equal(closed.length, 1);
    const chunks = replies.filter((r: Wire) => r.chunk?.recordId === record.id);
    assert.equal(chunks.length, 32);
    chunks.forEach((r: Wire, index: number) => {
      assert.equal(r.params.read, opened[0].message.result.read);
      assert.ok(opened[0].sequence < r.sequence && r.sequence < closed[0].sequence);
      assert.equal(r.chunk.sha256, source.chunks[index].sha256);
      assert.equal(r.chunk.offset, index * 262144);
      assert.equal(r.chunk.bytes, 262144);
      assert.equal(r.chunk.eof, index === 31);
      assert.equal(r.requestId, r.message.id);
      assert.equal(r.message.result.data, undefined);
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
    assert.equal(chunks.at(-1).chunk.recordSha256, record.sha256);
  }
  if (o.phase === "reopen3") {
    const deleted = replies.filter((r: Wire) => r.method === "storage/delete");
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].message.result.deleted, true);
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
  assert.ok(
    killed.evidence.importSlice.trace.some(
      (r: Wire) =>
        r.point === "after-publish" && r.ticket === killed.evidence.importSlice.ticket.id,
    ),
  );
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
    assert.equal(o.reconciliation.receipt.commitId, killed.evidence.importSlice.ticket.id);
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
      .message.result.entries.slice()
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
