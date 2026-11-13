import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LifecycleCaseInput, CaseEvidence } from "./plugin-persistence-main.js";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import type { CoreWindowScope, Stage3ChannelContext } from "@kobrixa/plugin-runtime";
import type {
  PublicationTicket,
  ExportOutcome,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { ExportDestination } from "../../apps/desktop/src/main/plugins/persistence/actions.js";

// These are serialized observations of heterogeneous public RPCs, not engine substitutes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = Record<string, any>;
type Trace = ReturnType<LifecycleCaseInput["fault"]["trace"]>;
type Blob = { path: string; data: string; identity: string; bytes: number };
type Disk = {
  namespace: string;
  identity: Blob;
  intent: Blob;
  head: Blob;
  previous: Blob;
  oldObject: Blob;
  newObject: Blob;
};
type Call = {
  phase: string;
  method: string;
  owner: ResourceOwner;
  params: Wire;
  result: Wire;
  ticket?: PublicationTicket;
};
export type UnknownObservation = {
  faultMode: "explicit-after-publish-failure";
  scope: "sdk-record-and-native-output-port";
  owner: ResourceOwner;
  channelOwner: ResourceOwner;
  calls: Call[];
  ticket: PublicationTicket;
  oldTicket: PublicationTicket;
  disk: Disk;
  afterProbe: Disk;
  traces: { seed: Trace; unknown: Trace; probe: Trace; reconciled: Trace; final: Trace };
  reconciliation: { ticket: PublicationTicket; result: Wire };
  generation: {
    old: ResourceOwner;
    next: ResourceOwner;
    exit: unknown;
    probes: Call[];
    traceBefore: Trace;
    traceAfter: Trace;
  };
  export: {
    registration: {
      action: string;
      scope: CoreWindowScope;
      nativePath: string;
      deadlineMonotonicMs: number;
    };
    owner: ResourceOwner;
    job: string;
    bytes: string;
    before: Blob;
    parentIdentity: string;
    parentAfter: string;
    staged: Blob;
    published: Blob;
    substituted: Blob;
    restored: Blob;
    final: Blob;
    calls: { method: string; job: string; args: Wire; result: unknown; trace: Trace }[];
  };
};
export type UnknownCaseInput = LifecycleCaseInput & {
  profilePath: string;
  channel: Stage3ChannelContext;
  scope(): CoreWindowScope;
  command(step: string): Promise<void>;
  reenable(): Promise<ResourceOwner>;
};
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const decoded = (blob: Blob) => Buffer.from(blob.data, "base64");
const json = (blob: Blob): Wire => JSON.parse(decoded(blob).toString("utf8"));
const count = (trace: Trace, point: string, ticket: string | null) =>
  trace.filter((row) => row.point === point && row.ticket === ticket).length;
function blobCheck(blob: Blob, expected: string) {
  assert.equal(blob.path, expected);
  assert.equal(decoded(blob).length, blob.bytes);
  assert.equal(decoded(blob).toString("base64"), blob.data);
  assert.match(blob.identity, /^\d+:\d+$/);
}
function record(ticket: PublicationTicket) {
  assert.equal(ticket.metadata.kind, "record");
  assert.equal(ticket.target.kind, "record");
  assert.ok(ticket.metadata.kind === "record" && ticket.target.kind === "record");
  assert.equal(ticket.metadata.deleted, false);
  assert.equal(ticket.target.id, ticket.metadata.record.id);
  return ticket.metadata.record;
}
function diskCheck(d: Disk, ticket: PublicationTicket, old: PublicationTicket) {
  const current = record(ticket),
    predecessor = record(old);
  const ns = `namespaces/${hash(ticket.owner.sourceKey)}`;
  assert.equal(d.namespace, ns);
  const dir = `${ns}/records/${current.id}`;
  for (const [key, relative] of Object.entries({
    identity: `${ns}/identity.json`,
    intent: `${ns}/staging/${ticket.id}/intent.json`,
    head: `${dir}/head.json`,
    previous: `${dir}/head.previous`,
    oldObject: `${dir}/objects/${predecessor.revision}.bin`,
    newObject: `${dir}/objects/${current.revision}.bin`,
  }))
    blobCheck(d[key as keyof Omit<Disk, "namespace">], relative);
  assert.deepEqual(json(d.identity), { formatVersion: 1, sourceKey: ticket.owner.sourceKey });
  const intent = json(d.intent),
    head = json(d.head),
    previous = json(d.previous);
  assert.deepEqual(intent.ticket, ticket);
  assert.equal(intent.byteLength, current.byteLength);
  assert.deepEqual(intent.predecessor, previous);
  for (const [h, t, bytes] of [
    [head, ticket, d.newObject],
    [previous, old, d.oldObject],
  ] as const) {
    const meta = record(t);
    assert.equal(h.formatVersion, 1);
    assert.deepEqual(h.metadata, t.metadata);
    assert.deepEqual(h.target, t.target);
    assert.equal(h.object, `${meta.revision}.bin`);
    assert.equal(h.receipt.revision, meta.revision);
    assert.match(h.receipt.commitId, /^[0-9a-f-]{36}$/);
    assert.equal(h.sha256, meta.sha256);
    assert.equal(hash(decoded(bytes)), meta.sha256);
    assert.equal(h.byteLength, meta.byteLength);
    assert.equal(bytes.bytes, meta.byteLength);
  }
  assert.notEqual(head.receipt.commitId, previous.receipt.commitId);
  assert.notEqual(current.sha256, predecessor.sha256);
  assert.notEqual(d.newObject.identity, d.oldObject.identity);
}
function denied(call: Call) {
  assert.equal(call.result.ok, false);
  assert.equal(call.result.value, undefined);
  assert.ok(call.result.error?.code);
}
export function assertUnknownFenceFailure(result: Wire): void {
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "PLUGIN_E_STORAGE_IO");
  assert.equal(
    result.error?.detail?.reason,
    "publish-uncertain",
    "OWNER HANDOFF B2: namespace admission must preserve publish-uncertain. " +
      "worker.ts recordUnadmittedReserve records an aborted tombstone, but atomic-store.ts abort " +
      "uses entry() and rejects that original ticket as stale; record-service.ts begin then " +
      "masks the reserve error and skips targets/writes cleanup. Minimal owner path: " +
      "make abort honor an unexpired exact-ticket aborted tombstone, with real-worker regression coverage.",
  );
}

/** Pure validator: deliberately does not authenticate native execution from JSON alone. */
export function assertUnknownObservation(o: UnknownObservation): void {
  assert.equal(o.faultMode, "explicit-after-publish-failure");
  assert.equal(o.scope, "sdk-record-and-native-output-port");
  assert.deepEqual(o.owner, o.channelOwner);
  assert.deepEqual(o.ticket.owner, o.owner);
  assert.deepEqual(o.oldTicket.owner, o.owner);
  const next = record(o.ticket),
    old = record(o.oldTicket);
  assert.equal(next.id, old.id);
  assert.notEqual(o.ticket.id, o.oldTicket.id);
  assert.notEqual(next.revision, old.revision);
  assert.ok(o.ticket.target.kind === "record" && o.oldTicket.target.kind === "record");
  assert.equal(o.ticket.target.expectedRevision, old.revision);
  assert.equal(o.oldTicket.target.expectedRevision, null);
  diskCheck(o.disk, o.ticket, o.oldTicket);
  assert.deepEqual(o.afterProbe, o.disk, "Fenced mutation changed durable evidence");
  for (const row of o.calls) assert.deepEqual(row.owner, o.owner);
  const begins = o.calls.filter((row) => row.method === "storage/beginWrite");
  assert.equal(begins.length, 3);
  for (const [row, ticket] of [
    [begins[0]!, o.oldTicket],
    [begins[1]!, o.ticket],
  ] as const) {
    assert.equal(row.phase, "seed");
    assert.equal(row.result.ok, true);
    assert.deepEqual(row.ticket, ticket);
    assert.equal(row.result.value.write, ticket.id);
    assert.equal(row.result.value.id, next.id);
    const meta = record(ticket);
    for (const key of [
      "kind",
      "schemaVersion",
      "label",
      "mediaType",
      "byteLength",
      "sha256",
    ] as const)
      assert.equal(row.params[key], meta[key]);
    assert.deepEqual(
      row.params.target,
      ticket.target.kind === "record" && ticket.target.expectedRevision === null
        ? { mode: "create" }
        : { mode: "replace", id: next.id, expectedRevision: old.revision },
    );
    const chunks = o.calls.filter(
      (r) => r.method === "storage/writeChunk" && r.params.write === ticket.id,
    );
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]!.params.offset, 0);
    assert.equal(chunks[0]!.result.ok, true);
    assert.equal(hash(Buffer.from(chunks[0]!.params.data, "base64")), meta.sha256);
    assert.equal(Buffer.from(chunks[0]!.params.data, "base64").length, meta.byteLength);
    const seals = o.calls.filter(
      (r) => r.method === "storage/sealWrite" && r.params.write === ticket.id,
    );
    assert.equal(seals.length, 1);
    assert.equal(seals[0]!.result.ok, true);
    assert.equal(seals[0]!.result.value.state, "sealed");
  }
  const probe = begins[2]!;
  assert.equal(probe.phase, "probe");
  assert.deepEqual(probe.params.target, { mode: "create" });
  denied(probe);
  assertUnknownFenceFailure(probe.result);
  assert.ok(probe.ticket, "Missing actual rejected worker ticket");
  assert.deepEqual(probe.ticket.owner, o.owner);
  const rejected = record(probe.ticket);
  assert.ok(probe.ticket.target.kind === "record");
  assert.equal(probe.ticket.target.expectedRevision, null);
  assert.notEqual(probe.ticket.id, o.ticket.id);
  assert.notEqual(probe.ticket.id, o.oldTicket.id);
  assert.notEqual(rejected.id, next.id);
  for (const key of [
    "kind",
    "schemaVersion",
    "label",
    "mediaType",
    "byteLength",
    "sha256",
  ] as const)
    assert.equal(probe.params[key], rejected[key]);
  const commits = o.calls.filter((row) => row.method === "storage/commitWrite");
  assert.equal(commits.length, 4);
  assert.equal(commits[0]!.params.write, o.oldTicket.id);
  assert.deepEqual(commits[0]!.result.value.receipt, json(o.disk.previous).receipt);
  for (const call of commits.slice(1)) assert.deepEqual(call.params, { write: o.ticket.id });
  assert.equal(commits[1]!.phase, "publish");
  denied(commits[1]!);
  assert.equal(commits[1]!.result.error.code, "PLUGIN_E_STORAGE_IO");
  assert.equal(commits[1]!.result.error.detail.reason, "publish-uncertain");
  assert.equal(commits[1]!.result.error.detail.disposition, "unknown");
  for (const call of commits.slice(2)) {
    assert.equal(call.phase, "reconcile");
    assert.equal(call.result.ok, true);
    assert.deepEqual(call.result.value.record, next);
    assert.deepEqual(call.result.value.receipt, json(o.disk.head).receipt);
  }
  assert.deepEqual(o.reconciliation.ticket, o.ticket);
  assert.deepEqual(o.reconciliation.result, {
    disposition: "committed",
    receipt: json(o.disk.head).receipt,
  });
  const stages = [
    o.traces.seed,
    o.traces.unknown,
    o.traces.probe,
    o.traces.reconciled,
    o.traces.final,
  ];
  for (let i = 1; i < stages.length; i++)
    assert.deepEqual(stages[i]!.slice(0, stages[i - 1]!.length), stages[i - 1]);
  for (const trace of stages) {
    for (const [i, row] of trace.entries()) {
      assert.ok(Number.isFinite(row.time) && row.time >= 0);
      if (i) assert.ok(row.time >= trace[i - 1]!.time);
    }
    assert.equal(count(trace, "reserve", o.oldTicket.id), 1);
    assert.equal(count(trace, "receipt-send", o.oldTicket.id), 1);
    assert.equal(count(trace, "reserve", o.ticket.id), 1);
    assert.equal(count(trace, "open-temp", o.ticket.id), 1);
    assert.equal(count(trace, "after-publish", o.oldTicket.id), 1);
  }
  assert.equal(count(o.traces.seed, "after-publish", o.ticket.id), 0);
  for (const trace of [o.traces.unknown, o.traces.probe, o.traces.reconciled]) {
    for (const point of ["reserve", "open-temp", "before-publish", "after-publish"])
      assert.deepEqual(
        trace.filter((row) => row.point === point).map((row) => row.ticket),
        [o.oldTicket.id, o.ticket.id],
        `Unexpected actual ${point} dispatch`,
      );
  }
  for (const trace of stages.slice(1)) {
    assert.equal(count(trace, "before-publish", o.ticket.id), 1);
    assert.equal(count(trace, "after-publish", o.ticket.id), 1);
    assert.equal(count(trace, "head-dir-sync", o.ticket.id), 0, "Fault did not lose confirmation");
    assert.equal(count(trace, "cache-publish", o.ticket.id), 0);
    assert.equal(count(trace, "receipt-send", o.ticket.id), 0);
  }
  assert.equal(
    o.traces.probe.length,
    o.traces.unknown.length,
    "Denied create dispatched filesystem mutation",
  );
  assert.deepEqual(o.generation.old, o.owner);
  assert.equal(o.generation.next.sourceKey, o.owner.sourceKey);
  assert.equal(o.generation.next.pluginId, o.owner.pluginId);
  assert.equal(o.generation.next.hostEpoch, o.owner.hostEpoch);
  assert.ok(o.generation.next.generation > o.owner.generation);
  assert.notEqual(o.generation.next.processEpoch, o.owner.processEpoch);
  assert.ok(
    o.generation.exit && typeof o.generation.exit === "object",
    "Old consumer exit not observed",
  );
  assert.ok(Object.hasOwn(o.generation.exit, "code"));
  const exitCode = (o.generation.exit as { code: unknown }).code;
  assert.ok(exitCode === null || Number.isSafeInteger(exitCode));
  assert.deepEqual(
    o.generation.traceAfter,
    o.generation.traceBefore,
    "Old generation dispatched mutation",
  );
  assert.deepEqual(o.traces.final, o.generation.traceAfter);
  assert.deepEqual(
    o.generation.probes.map((r) => r.method),
    ["storage/beginWrite", "storage/commitWrite"],
  );
  for (const call of o.generation.probes) {
    assert.deepEqual(call.owner, o.owner);
    denied(call);
    assert.ok(
      ["PLUGIN_E_STALE_RESOURCE", "PLUGIN_E_PERMISSION_DENIED"].includes(call.result.error.code),
    );
  }
  assert.deepEqual(o.generation.probes[0]!.params, probe.params);
  assert.deepEqual(o.generation.probes[1]!.params, { write: o.ticket.id });
  const e = o.export;
  assert.deepEqual(e.owner, o.owner);
  assert.equal(e.registration.scope.hostEpoch, o.owner.hostEpoch);
  assert.ok(e.registration.deadlineMonotonicMs > 0);
  assert.notEqual(e.job, o.ticket.id);
  assert.match(e.registration.action, /^[0-9a-f-]{36}$/);
  const destination = e.registration.nativePath;
  assert.ok(path.isAbsolute(destination));
  for (const b of [e.before, e.published, e.substituted, e.restored, e.final])
    blobCheck(b, destination);
  assert.equal(path.dirname(e.staged.path), path.dirname(destination));
  assert.match(path.basename(e.staged.path), /^\.kobrixa-[0-9a-f-]+\.tmp$/);
  assert.match(e.parentIdentity, /^\d+:\d+$/);
  assert.equal(e.parentAfter, e.parentIdentity);
  assert.notEqual(e.before.identity, e.published.identity);
  assert.notEqual(e.before.data, e.bytes);
  for (const b of [e.staged, e.published, e.substituted, e.restored, e.final]) {
    assert.equal(b.data, e.bytes);
    assert.equal(b.bytes, Buffer.from(e.bytes, "base64").length);
  }
  assert.equal(e.staged.identity, e.published.identity);
  assert.notEqual(
    e.substituted.identity,
    e.published.identity,
    "Identity probe never changed inode",
  );
  assert.equal(e.restored.identity, e.published.identity);
  assert.deepEqual(e.final, e.restored);
  assert.deepEqual(
    e.calls.map((r) => r.method),
    ["begin", "append", "commit", "reconcile", "reconcile", "reconcile"],
  );
  for (const call of e.calls) assert.equal(call.job, e.job);
  assert.deepEqual(e.calls[0]!.args, {
    owner: e.owner,
    registration: e.registration,
    bytes: e.staged.bytes,
    sha256: hash(decoded(e.staged)),
    deadline: e.registration.deadlineMonotonicMs,
  });
  assert.deepEqual(e.calls[1]!.args, { offset: 0, data: e.bytes });
  assert.equal(e.calls[1]!.result, e.staged.bytes);
  for (const call of e.calls.slice(2)) assert.deepEqual(call.args, {});
  assert.deepEqual(e.calls[2]!.result, { disposition: "unknown" });
  assert.deepEqual(e.calls[3]!.result, { disposition: "unknown" });
  const committed = e.calls[4]!.result as ExportOutcome;
  assert.equal(committed.disposition, "committed");
  assert.match(committed.commitId!, /^[0-9a-f-]{36}$/);
  assert.ok(["file-sync-only", "file-and-directory-sync"].includes(committed.durability!));
  assert.deepEqual(e.calls[5]!.result, committed);
  for (const [index, call] of e.calls.entries()) {
    // Output operations have no publication-ticket field in the real worker trace.
    // Isolate the awaited original-job operation; never relabel null as a ticket.
    assert.ok(call.trace.every((row) => row.ticket === null));
    assert.equal(count(call.trace, "after-publish", null), index === 2 ? 1 : 0);
    assert.equal(count(call.trace, "before-publish", null), index === 2 ? 1 : 0);
  }
}

export async function cleanupUnknown(
  tasks: (() => unknown | Promise<unknown>)[],
): Promise<unknown[]> {
  const errors: unknown[] = [];
  for (const task of tasks)
    try {
      await task();
    } catch (error) {
      errors.push(error);
    }
  return errors;
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Unknown-publication producer deadline")), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function produceUnknownPublication(
  input: UnknownCaseInput,
): Promise<CaseEvidence & { unknown: UnknownObservation }> {
  const principal = input.recording.principal();
  assert.equal(principal.kind, "plugin");
  if (principal.kind !== "plugin") throw new Error("Missing original SDK principal");
  const owner = principal.owner;
  const traceStart = input.fault.trace().length;
  const trace = () => input.fault.trace().slice(traceStart);
  assert.deepEqual(owner, input.channel.owner);
  const calls: Call[] = [],
    pending: Promise<unknown>[] = [],
    cleanups: (() => unknown | Promise<unknown>)[] = [];
  let phase = "seed",
    failure: unknown,
    observation: UnknownObservation | undefined;
  const track = <T>(work: Promise<T>) => {
    pending.push(work);
    void work.catch(() => {});
    return bounded(work);
  };
  const tickets = () =>
    input.backend.evidence.tickets(
      input.backend.evidence.capture({ kind: "namespace", owner }, input.now() + 10000),
    );
  const originalRequest = input.host.request;
  input.host.request = async function (this: typeof input.host, ...args) {
    const observe = args[0].kind === "plugin" && args[0].owner.sourceKey === owner.sourceKey;
    const before = observe && args[1] === "storage/beginWrite" ? tickets().map((t) => t.id) : [];
    const result = await originalRequest.apply(this, args);
    if (args[0].kind === "plugin" && args[0].owner.sourceKey === owner.sourceKey) {
      const row: Call = {
        phase,
        method: args[1],
        owner: structuredClone(args[0].owner),
        params: structuredClone(args[2]),
        result: structuredClone(result),
      };
      if (args[1] === "storage/beginWrite") {
        const attempts = tickets().filter((t) => !before.includes(t.id));
        assert.ok(attempts.length <= 1, "Concurrent unrelated admission during SDK probe");
        if (result.ok) {
          assert.equal(attempts.length, 1);
          assert.equal(attempts[0]!.id, (result.value as { write?: string }).write);
        }
        if (attempts[0]) row.ticket = attempts[0];
      }
      calls.push(row);
    }
    return result;
  } as typeof originalRequest;
  cleanups.push(() => {
    input.host.request = originalRequest;
  });
  let exitResolve!: (value: unknown) => void;
  const exit = new Promise<unknown>((resolve) => {
    exitResolve = resolve;
  });
  const off = input.recording.child.onExit(exitResolve);
  cleanups.push(off);
  const command = async (step: string) => {
    phase = step;
    await track(input.command(step));
  };
  const root = path.join(input.profilePath, "plugins/persistence-v1");
  async function blob(file: string, relative = false): Promise<Blob> {
    const bytes = await readFile(file),
      stat = await lstat(file, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink());
    return {
      path: relative ? path.relative(root, file).split(path.sep).join("/") : file,
      data: bytes.toString("base64"),
      bytes: bytes.length,
      identity: `${stat.dev}:${stat.ino}`,
    };
  }
  let ticket: PublicationTicket | undefined,
    destination: ExportDestination | undefined,
    job: string | undefined;
  let moved: { original: string; saved: string } | undefined;
  let retirementStarted = false;
  // Run cleanup even after an assertion or an earlier cleanup fails. Reconcile/abort
  // actual pending work before the composition's unchanged all-zero close gate.
  const settle = async () => {
    input.fault.release("after-publish");
    await bounded(Promise.allSettled(pending));
  };
  try {
    await command("seed");
    const admissions = calls.filter((row) => row.method === "storage/beginWrite" && row.result.ok);
    assert.equal(admissions.length, 2);
    const oldTicket = admissions[0]!.ticket!;
    ticket = admissions[1]!.ticket!;
    const originalTicket = ticket;
    const seed = trace();
    const acknowledgement = input.fault.reached("after-publish");
    input.fault.arm("after-publish", "fail");
    await command("publish");
    await bounded(acknowledgement);
    const unknownTrace = trace();
    const ns = `namespaces/${hash(owner.sourceKey)}`;
    const dir = `${ns}/records/${record(ticket).id}`;
    const snapshot = async (): Promise<Disk> => ({
      namespace: ns,
      identity: await blob(path.join(root, ns, "identity.json"), true),
      intent: await blob(path.join(root, ns, "staging", originalTicket.id, "intent.json"), true),
      head: await blob(path.join(root, dir, "head.json"), true),
      previous: await blob(path.join(root, dir, "head.previous"), true),
      oldObject: await blob(
        path.join(root, dir, "objects", `${record(oldTicket).revision}.bin`),
        true,
      ),
      newObject: await blob(
        path.join(root, dir, "objects", `${record(originalTicket).revision}.bin`),
        true,
      ),
    });
    const disk = await snapshot();
    // Keep whole bytes even if a later assertion fails and cleanup settles the
    // original ticket (which may legitimately collect its predecessor).
    await writeFile(
      path.join(input.profilePath, "unknown-publication-record.json"),
      JSON.stringify({ owner, ticket, oldTicket, disk, seed, unknownTrace, calls }, null, 2),
      { flag: "wx" },
    );
    await command("probe");
    const afterProbe = await snapshot(),
      probe = trace();
    const rejected = calls.find(
      (row) => row.phase === "probe" && row.method === "storage/beginWrite",
    )!;
    try {
      assertUnknownFenceFailure(rejected.result);
    } catch (error) {
      failure = error;
    }
    await writeFile(
      path.join(input.profilePath, "unknown-publication-fence.json"),
      JSON.stringify({ rejected, afterProbe, trace: probe }, null, 2),
      { flag: "wx" },
    );
    // Preserve the first owner-handoff diagnostic but still reconcile original
    // work and exercise the independent NativeOutput path before cleanup.
    await command("reconcile");
    const reconciliation = {
      ticket: structuredClone(ticket),
      result: await track(input.backend.engine.reconcile(ticket)),
    };
    const reconciled = trace();

    // Actual worker NativeOutput port, explicitly not native dialog/action UI evidence.
    const exportDir = path.join(input.profilePath, "unknown-export");
    await mkdir(exportDir);
    const nativePath = path.join(exportDir, "original.bin");
    await writeFile(nativePath, decoded(disk.oldObject), { flag: "wx" });
    const before = await blob(nativePath),
      parent = await lstat(exportDir, { bigint: true });
    const registration = {
      action: randomUUID(),
      scope: input.scope(),
      nativePath,
      deadlineMonotonicMs: input.now() + 10000,
    };
    destination = await track(input.backend.destinations.register(registration));
    job = randomUUID();
    const exportCalls: UnknownObservation["export"]["calls"] = [];
    const outputCall = async <T>(method: string, args: Wire, invoke: () => Promise<T>) => {
      const start = trace().length;
      const result = await track(invoke());
      exportCalls.push({
        method,
        job: job!,
        args: structuredClone(args),
        result: result ?? null,
        trace: trace().slice(start),
      });
      return result;
    };
    const bytes = decoded(disk.newObject);
    await outputCall(
      "begin",
      {
        owner,
        registration,
        bytes: bytes.length,
        sha256: hash(bytes),
        deadline: registration.deadlineMonotonicMs,
      },
      () =>
        input.backend.output.begin(
          job!,
          owner,
          destination!,
          bytes.length,
          hash(bytes),
          registration.deadlineMonotonicMs,
        ),
    );
    await outputCall("append", { offset: 0, data: bytes.toString("base64") }, () =>
      input.backend.output.append(job!, 0, bytes),
    );
    const temps = (await readdir(exportDir)).filter((name) => name.startsWith(".kobrixa-"));
    assert.equal(temps.length, 1);
    const staged = await blob(path.join(exportDir, temps[0]!));
    const outputAcknowledgement = input.fault.reached("after-publish");
    input.fault.arm("after-publish", "fail");
    await outputCall("commit", {}, () => input.backend.output.commit(job!));
    await bounded(outputAcknowledgement);
    // Trace delivery is on a separate MessagePort. Attach the acknowledged interval.
    exportCalls[2]!.trace = trace().slice(reconciled.length);
    const published = await blob(nativePath);
    await writeFile(
      path.join(input.profilePath, "unknown-publication-export.json"),
      JSON.stringify(
        { owner, registration, job, before, staged, published, calls: exportCalls },
        null,
        2,
      ),
      { flag: "wx" },
    );
    moved = { original: nativePath, saved: path.join(exportDir, "original-inode.saved") };
    await rename(moved.original, moved.saved);
    await writeFile(nativePath, bytes, { flag: "wx" });
    const substituted = await blob(nativePath);
    await outputCall("reconcile", {}, () => input.backend.output.reconcile(job!));
    await rename(moved.saved, moved.original);
    moved = undefined;
    const restored = await blob(nativePath);
    await outputCall("reconcile", {}, () => input.backend.output.reconcile(job!));
    await outputCall("reconcile", {}, () => input.backend.output.reconcile(job!));
    const final = await blob(nativePath);
    const parentAfter = await lstat(exportDir, { bigint: true });

    retirementStarted = true;
    assert.equal((await track(input.plugins.setEnabled(owner.sourceKey, false))).ok, true);
    const oldExit = await bounded(exit);
    assert.equal((await track(input.plugins.setEnabled(owner.sourceKey, true))).ok, true);
    const nextOwner = await track(input.reenable());
    phase = "old-generation";
    const traceBefore = trace();
    const probeParams = calls.find(
      (row) => row.phase === "probe" && row.method === "storage/beginWrite",
    )!.params;
    for (const [method, params] of [
      ["storage/beginWrite", probeParams],
      ["storage/commitWrite", { write: ticket.id }],
    ] as const)
      await track(
        input.host.request(principal, method, params as never, new AbortController().signal),
      );
    const generationProbes = calls.filter((row) => row.phase === "old-generation");
    observation = {
      faultMode: "explicit-after-publish-failure",
      scope: "sdk-record-and-native-output-port",
      owner,
      channelOwner: structuredClone(input.channel.owner),
      calls: calls.filter((row) => row.phase !== "old-generation"),
      ticket,
      oldTicket,
      disk,
      afterProbe,
      traces: { seed, unknown: unknownTrace, probe, reconciled, final: trace() },
      reconciliation,
      generation: {
        old: owner,
        next: nextOwner,
        exit: oldExit,
        probes: generationProbes,
        traceBefore,
        traceAfter: trace(),
      },
      export: {
        registration,
        owner,
        job,
        bytes: bytes.toString("base64"),
        before,
        parentIdentity: `${parent.dev}:${parent.ino}`,
        parentAfter: `${parentAfter.dev}:${parentAfter.ino}`,
        staged,
        published,
        substituted,
        restored,
        final,
        calls: exportCalls,
      },
    };
    await writeFile(
      path.join(input.profilePath, "unknown-publication-observation.json"),
      JSON.stringify(observation, null, 2),
      { flag: "wx" },
    );
    assertUnknownObservation(observation);
  } catch (error) {
    failure = failure
      ? new AggregateError(
          [failure, error],
          "Unknown-publication owner handoff and scenario failure",
        )
      : error;
  }
  const errors = await cleanupUnknown([
    settle,
    async () => {
      if (moved) {
        await rename(moved.saved, moved.original);
        moved = undefined;
      }
    },
    async () => {
      if (job) await input.backend.output.abort(job);
    },
    async () => {
      if (destination) await input.backend.destinations.release(destination);
    },
    ...calls
      .filter((row) => row.ticket)
      .map((row) => async () => {
        if (retirementStarted) return;
        const result = await originalRequest.call(
          input.host,
          principal,
          "storage/abortWrite",
          { write: row.ticket!.id },
          new AbortController().signal,
        );
        assert.equal(
          result.ok,
          true,
          `Original SDK write cleanup failed: ${JSON.stringify(result)}`,
        );
      }),
    ...calls
      .filter((row) => row.ticket)
      .map((row) => async () => {
        await input.backend.engine.abort(row.ticket!);
      }),
    ...cleanups.reverse(),
  ]);
  if (errors.length)
    throw new AggregateError(
      failure ? [failure, ...errors] : errors,
      "Unknown-publication cleanup failed",
    );
  if (failure) throw failure;
  assert.ok(observation);
  return { unknown: observation, checks: unknownSummary(observation), events: [], samples: {} };
}

// The outside harness independently binds this producer's summaries to raw proof.
export function unknownSummary(o: UnknownObservation): CaseEvidence["checks"] {
  return {
    disposition: o.calls.find((r) => r.phase === "publish")!.result.error.detail.disposition,
    oldEvidenceRetained: hash(decoded(o.disk.oldObject)) === record(o.oldTicket).sha256,
    newEvidenceRetained: hash(decoded(o.disk.newObject)) === record(o.ticket).sha256,
    namespaceFenced: o.calls.find((r) => r.phase === "probe")!.result.ok === false,
    secondPublicationCalls: count(o.traces.final, "after-publish", o.ticket.id) - 1,
    reconciledOriginalTicket: JSON.stringify(o.reconciliation.ticket) === JSON.stringify(o.ticket),
    reconciledDisposition: o.reconciliation.result.disposition,
    exportOriginalJobReconciled: o.export.calls.slice(3).every((r) => r.job === o.export.job),
    noRepublish:
      o.export.calls.filter((r) => r.method === "commit").length === 1 &&
      o.export.calls.slice(3).every((r) => count(r.trace, "after-publish", null) === 0),
    destinationIdentityPreserved: o.export.staged.identity === o.export.final.identity,
  };
}
