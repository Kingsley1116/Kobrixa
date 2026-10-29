import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  PersistenceBackend,
  PersistenceOwner,
} from "../../apps/desktop/src/main/plugins/persistence/engine-port.js";
import type { DesktopMainComposition } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import type { Wire, importObserver } from "./plugin-persistence-import.js";
// @ts-expect-error Node oracle loads the test-local source without a shared build.
import { assertImportStorage } from "./plugin-persistence-import.ts";
import {
  parseNonceDocument,
  snapshotBytes,
  IMPORT_LIMITS,
} from "../../apps/desktop/src/main/plugins/persistence/import-sources.js";

export const PREFERENCE_CUTS = [
  "before-raw",
  "after-raw",
  "before-consumption",
  "after-consumption",
] as const;
export const PREFERENCE_SOURCE = "builtin:test.preferences";
export const PREFERENCE_DESCRIPTOR = "test.synthetic-preferences";
export function preferenceCut(cut: string) {
  assert.ok((PREFERENCE_CUTS as readonly string[]).includes(cut));
  return cut;
}
export function preferencePhases(cut: string) {
  preferenceCut(cut);
  return [
    "kill",
    ...(cut === "before-raw" ? ["pending", "capture"] : []),
    "reopen1",
    "reopen2",
    "reopen3",
    "deleted",
  ];
}
const clone = <T>(v: T): T => structuredClone(v);
export function nonceDocument(value: unknown) {
  const d = parseNonceDocument(Buffer.from(JSON.stringify(value)));
  assert.equal(d.sourceKey, PREFERENCE_SOURCE);
  assert.equal(d.descriptorId, PREFERENCE_DESCRIPTOR);
  assert.deepEqual(d.allowlist, ["test.preference"]);
  return d;
}
function sameCapture(a: Wire, b: Wire) {
  for (const key of [
    "nonce",
    "scope",
    "allowlist",
    "raw",
    "digest",
    "originalTicket",
    "sourceKey",
    "descriptorId",
  ])
    assert.deepEqual(a[key], b[key], key);
}
/** Forward actual auxiliary publications; challenge issuance is NOT a raw-capture cut. */
export function armPreferenceCut(input: {
  backend: PersistenceBackend;
  cut: string;
  pause: (e: Wire) => Promise<never>;
}) {
  const { backend } = input,
    cut = preferenceCut(input.cut);
  const append = backend.engine.append,
    publish = backend.engine.publish;
  const buffers = new Map<string, Buffer>();
  let selected = false;
  backend.engine.append = async (ticket, offset, bytes) => {
    const next = await append.call(backend.engine, ticket, offset, bytes);
    if (
      !selected &&
      ticket.owner.sourceKey === PREFERENCE_SOURCE &&
      ticket.target.kind === "import" &&
      ticket.target.key.startsWith("nonce/")
    ) {
      const old = buffers.get(ticket.id) ?? Buffer.alloc(0);
      assert.equal(offset, old.length);
      assert.equal(next, offset + bytes.length);
      assert.ok(next <= IMPORT_LIMITS.journalBytes);
      assert.ok(buffers.has(ticket.id) || buffers.size < 2);
      buffers.set(ticket.id, Buffer.concat([old, bytes]));
    }
    return next;
  };
  backend.engine.publish = async (ticket) => {
    const bytes = buffers.get(ticket.id);
    if (!bytes || selected) return publish.call(backend.engine, ticket);
    buffers.delete(ticket.id);
    const document = nonceDocument(JSON.parse(bytes.toString("utf8")));
    assert.deepEqual(document.ticket, ticket);
    const target = cut.endsWith("raw")
      ? document.state === "issued" && document.raw !== null
      : document.state === "consumed";
    if (!target) return publish.call(backend.engine, ticket);
    selected = true;
    const key = "nonce/" + document.nonce;
    const previousBytes = await backend.evidence.auxiliary(ticket.owner, "import", key);
    assert.ok(previousBytes);
    const previous = nonceDocument(JSON.parse(Buffer.from(previousBytes).toString("utf8")));
    let outcome = null,
      reconciled = null;
    if (cut.startsWith("after")) {
      outcome = await publish.call(backend.engine, ticket);
      if (outcome.disposition === "unknown") outcome = await backend.imports.reconcile(ticket);
      assert.equal(outcome.disposition, "committed");
      reconciled = await backend.imports.reconcile(ticket);
      assert.deepEqual(reconciled, outcome);
    }
    const readbackBytes = await backend.evidence.auxiliary(ticket.owner, "import", key);
    assert.ok(readbackBytes);
    const evidence = {
      cut,
      document,
      previous,
      outcome,
      reconciled,
      readback: nonceDocument(JSON.parse(Buffer.from(readbackBytes).toString("utf8"))),
    };
    assertPreferenceTransition(evidence);
    return input.pause(evidence);
  };
  return () => {
    backend.engine.append = append;
    backend.engine.publish = publish;
    buffers.clear();
  };
}
export function assertPreferenceTransition(e: Wire) {
  const cut = preferenceCut(e.cut),
    d = nonceDocument(e.document),
    p = nonceDocument(e.previous);
  assert.equal(p.state, "issued");
  assert.notEqual(d.ticket.id, p.ticket.id);
  for (const key of ["nonce", "scope", "originalTicket", "allowlist"])
    assert.deepEqual(d[key as keyof typeof d], p[key as keyof typeof p]);
  assert.ok(d.raw && d.digest);
  if (cut.endsWith("raw")) {
    assert.equal(p.raw, null);
    assert.equal(d.state, "issued");
  } else {
    sameCapture(d, p);
    assert.equal(d.state, "consumed");
  }
  if (cut.startsWith("before")) {
    assert.equal(e.outcome, null);
    assert.equal(e.reconciled, null);
    assert.deepEqual(e.readback, p);
  } else {
    assert.equal(e.outcome.disposition, "committed");
    assert.ok(e.outcome.receipt);
    assert.deepEqual(e.reconciled, e.outcome);
    assert.deepEqual(e.readback, d);
  }
}
/** Capture current owner from the real coordinator; never reconstruct a historical owner. */
export async function readPreferenceState(live: DesktopMainComposition) {
  const { desktopFoundationTestHandles } =
    await import("../../apps/desktop/src/main/plugins/controller.js");
  const { syntheticPreferencesImportDescriptor: descriptor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-fixtures.js");
  const { importIdFor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-sources.js");
  const handles = desktopFoundationTestHandles(live),
    backend = handles.backend;
  const load = backend.imports.load;
  let current: PersistenceOwner | undefined;
  const id = importIdFor(descriptor.id, descriptor.targetSourceKey);
  backend.imports.load = async (owner, planId) => {
    if (owner.sourceKey === PREFERENCE_SOURCE && planId === id) current = clone(owner);
    return load.call(backend.imports, owner, planId);
  };
  let progress;
  try {
    progress = await live.plugins.persistence170!.imports.run(
      descriptor,
      new AbortController().signal,
    );
  } finally {
    backend.imports.load = load;
  }
  assert.ok(current);
  assert.equal(current.hostEpoch, handles.profile.hostEpoch);
  const documents = [];
  let cursor: string | undefined;
  do {
    const page = await backend.evidence.auxiliaryKeys(current, "import", cursor);
    for (const key of page.keys.filter((k) => k.startsWith("nonce/"))) {
      const bytes = await backend.evidence.auxiliary(current, "import", key);
      assert.ok(bytes);
      const d = nonceDocument(JSON.parse(Buffer.from(bytes).toString("utf8")));
      assert.equal(key, "nonce/" + d.nonce);
      assert.ok(documents.length < 4, "Unexpected challenge proliferation");
      const outcome = await backend.imports.reconcile(d.ticket);
      assert.equal(outcome.disposition, "committed");
      documents.push({ document: d, outcome });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return {
    owner: current,
    progress,
    documents,
    journal: await load.call(backend.imports, current, id),
  };
}
/** Renderer functions are invoked through actual webContents/main-frame preload by integration. */
export type PreferenceCaptureDriver = {
  capture(oldSnapshot?: Wire): Promise<Wire>;
  // Actual main-side IPC forwarder observations, including rejected calls. Never renderer summaries.
  ipc: Wire[];
};
export async function producePreferenceImport(input: {
  config: Wire;
  live: DesktopMainComposition;
  observer: ReturnType<typeof importObserver>;
  driver?: PreferenceCaptureDriver;
  prior?: Wire;
  captured?: Wire;
}) {
  const { config, live, observer, driver, prior, captured } = input;
  const { desktopFoundationTestHandles } =
    await import("../../apps/desktop/src/main/plugins/controller.js");
  const { syntheticImportDescriptor } =
    await import("../../apps/desktop/src/main/plugins/persistence/import-fixtures.js");
  const { originalFiles, captureImportObservation, publishImportPause } =
    await import("./plugin-persistence-import.js");
  const handles = desktopFoundationTestHandles(live),
    cut = preferenceCut(config.importTrial);
  assert.ok(preferencePhases(cut).includes(config.importPhase));
  const originals = await originalFiles(config.syntheticRoot);
  const base = {
    slice: cut,
    cut,
    phase: config.importPhase,
    rf5Complete: false,
    pid: process.pid,
    hostEpoch: handles.profile.hostEpoch,
    originals,
    profileId: config.profileId,
  };
  // Independent file descriptor: always actual 50 x 8 MiB, never renderer padding.
  assert.equal(
    (
      await live.plugins.persistence170!.imports.run(
        syntheticImportDescriptor,
        new AbortController().signal,
      )
    ).state,
    "complete",
  );
  if (config.importPhase === "kill") {
    assert.ok(driver, "Kill phase requires trusted capture document");
    armPreferenceCut({
      backend: handles.backend,
      cut,
      pause: async (transition) => {
        const observed = { ...base, transition, ipc: clone(driver.ipc) };
        assertPreferencePause(observed);
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
          pausedAt: Date.now(),
          evidence: { importPreferences: observed },
        });
        return new Promise<never>(() => {});
      },
    });
    await driver.capture();
    throw Error("Preference boundary did not pause");
  }
  assert.ok(prior);
  assertPreferencePause(prior);
  assert.deepEqual(prior.originals, originals);
  let capture: Wire | null = null;
  if (config.importPhase === "capture") {
    assert.equal(cut, "before-raw");
    assert.ok(driver);
    capture = await driver.capture(prior.transition.document.raw);
  } else assert.equal(driver, undefined, "Headless phases must not attach capture driver");
  const preferences = await readPreferenceState(live);
  const fileCount = config.importPhase === "deleted" ? 49 : 50;
  for (let n = 0; n < fileCount; n++)
    assert.equal((await live.plugins.execute("test.synthetic.inspect")).ok, true);
  if (config.importPhase !== "pending")
    assert.equal((await live.plugins.execute("test.preferences.inspect")).ok, true);
  if (config.importPhase === "reopen3")
    assert.equal((await live.plugins.execute("test.synthetic.delete-first")).ok, true);
  assert.deepEqual(await originalFiles(config.syntheticRoot), originals);
  const requiredSources = [
    "builtin:test.synthetic",
    ...(config.importPhase === "pending" ? [] : [PREFERENCE_SOURCE]),
  ];
  const deadline = Date.now() + 5000;
  while (
    !requiredSources.every((source) =>
      observer.processes.some((p) => p.kind === "boot" && p.owner.sourceKey === source),
    )
  ) {
    assert.ok(Date.now() < deadline, "Missing actual consumer boot");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const observed = captureImportObservation(
    {
      ...base,
      prior,
      captured: captured ?? null,
      capture,
      preferences,
      ipc: driver ? clone(driver.ipc) : [],
      headless: !driver,
    },
    observer,
    [],
  );
  assertPreferencePhase(observed);
  return { checks: {}, events: [], samples: {}, importPreferences: observed };
}
function fileProof(o: Wire) {
  assert.equal(o.originals.length, 50);
  assert.equal(new Set(o.originals.map((r: Wire) => r.name ?? r.path ?? r.sha256)).size, 50);
  assert.ok(o.originals.every((r: Wire) => r.bytes === 8388608));
}
function partition(o: Wire, sourceKey: string) {
  return {
    ...o,
    wire: o.wire.filter((r: Wire) => r.owner?.sourceKey === sourceKey),
    processes: o.processes.filter((r: Wire) => r.owner?.sourceKey === sourceKey),
  };
}
export function assertPreferencePause(o: Wire) {
  preferenceCut(o.cut);
  assert.equal(o.slice, o.cut);
  assert.equal(o.phase, "kill");
  assert.equal(o.rf5Complete, false);
  fileProof(o);
  assertPreferenceTransition(o.transition);
  assert.equal(o.transition.cut, o.cut);
  assert.equal(o.transition.document.ticket.owner.hostEpoch, o.hostEpoch);
  assertCaptureIpc(o.ipc, o.transition.document, false);
}
/** Actual forwarded IPC rows: channel, args, scope, senderId/frame, requestId, stage, at, result/error. */
export function assertCaptureIpc(rows: Wire[], d: Wire, stale: boolean) {
  const requests = rows.filter((r) => r.stage === "request");
  for (const r of requests) {
    assert.ok(r.senderId > 0 && typeof r.frame === "string" && r.frame.length > 0);
    assert.ok(typeof r.requestId === "string" && r.requestId.length > 0);
    assert.ok(Number.isFinite(r.at));
  }
  assert.equal(new Set(requests.map((r) => r.requestId)).size, requests.length);
  const challenge = rows.find(
    (r) =>
      r.stage === "reply" &&
      r.channel === "persistence:legacy-preferences-challenge" &&
      r.result?.nonce === d.nonce,
  );
  assert.ok(challenge);
  const q = requests.find((r) => r.requestId === challenge.requestId);
  assert.ok(q);
  assert.deepEqual(q.args, [PREFERENCE_DESCRIPTOR]);
  assert.deepEqual(challenge.result.scope, d.scope);
  assert.deepEqual(challenge.result.keys, d.allowlist);
  assert.equal(challenge.result.descriptorId, PREFERENCE_DESCRIPTOR);
  const submit = requests.find(
    (r) => r.channel === "persistence:legacy-preferences-submit" && r.args[0]?.nonce === d.nonce,
  );
  assert.ok(submit);
  assert.deepEqual(submit.args[0], d.raw);
  assert.deepEqual(submit.scope, d.scope);
  assert.ok(q.at <= challenge.at && challenge.at <= submit.at);
  for (const r of [q, challenge, submit]) {
    assert.equal(r.senderId, q.senderId);
    assert.equal(r.frame, q.frame);
  }
  if (stale) {
    const rejection = rows.find(
      (r) =>
        r.stage === "error" &&
        r.channel === "persistence:legacy-preferences-submit" &&
        /stale/i.test(r.error),
    );
    assert.ok(rejection);
    const old = requests.find((r) => r.requestId === rejection.requestId);
    assert.ok(old);
    assert.notEqual(old.args[0].nonce, d.nonce);
    assert.deepEqual(old.scope, d.scope);
    assert.notDeepEqual(old.args[0].scope, d.scope);
    assert.ok(old.at <= rejection.at && rejection.at <= q.at);
  }
}
export function assertPreferencePhase(o: Wire) {
  preferenceCut(o.cut);
  assert.equal(o.rf5Complete, false);
  assertPreferencePause(o.prior);
  assert.equal(o.cut, o.prior.cut);
  assert.deepEqual(o.originals, o.prior.originals);
  const p = o.preferences;
  assert.equal(p.owner.sourceKey, PREFERENCE_SOURCE);
  assert.equal(p.owner.hostEpoch, o.hostEpoch);
  const docs = p.documents.map((r: Wire) => {
    assert.equal(r.outcome.disposition, "committed");
    return nonceDocument(r.document);
  });
  const old = docs.find((d: Wire) => d.nonce === o.prior.transition.document.nonce);
  assert.ok(old);
  assertImportStorage(partition(o, "builtin:test.synthetic"), o.phase === "deleted" ? 49 : 50);
  if (o.phase === "pending") {
    assert.equal(o.cut, "before-raw");
    assert.equal(o.headless, true);
    assert.deepEqual(o.ipc, []);
    assert.equal(p.progress.state, "pending");
    assert.equal(p.journal, null);
    assert.equal(old.raw, null);
    assert.equal(old.state, "issued");
    assert.equal(docs.length, 1);
    assert.equal(partition(o, PREFERENCE_SOURCE).wire.length, 0);
    return;
  }
  assert.equal(p.progress.state, "complete");
  assert.equal(p.journal.complete, true);
  const captured = docs.filter((d: Wire) => d.raw !== null);
  assert.equal(captured.length, 1);
  const d = captured[0];
  assert.equal(d.state, "consumed");
  if (o.cut === "before-raw") {
    assert.notEqual(d.nonce, old.nonce);
    assert.equal(old.raw, null);
    assert.deepEqual(d.raw.entries, o.prior.transition.document.raw.entries);
    if (o.phase === "capture") {
      assert.equal(o.headless, false);
      assertCaptureIpc(o.ipc, d, true);
      assert.ok(
        o.ipc.some(
          (r: Wire) =>
            r.stage === "request" &&
            r.channel === "persistence:legacy-preferences-submit" &&
            JSON.stringify(r.args[0]) === JSON.stringify(o.prior.transition.document.raw),
        ),
      );
      assert.deepEqual(o.capture.snapshot, d.raw);
      assert.ok(["accepted", "reconciled"].includes(o.capture.result.state));
      assert.equal(o.capture.original, d.raw.entries[0].raw);
      const submit = o.ipc.find(
        (r: Wire) =>
          r.stage === "request" &&
          r.channel === "persistence:legacy-preferences-submit" &&
          r.args[0]?.nonce === d.nonce,
      );
      const reply = o.ipc.find(
        (r: Wire) => r.stage === "reply" && r.requestId === submit.requestId,
      );
      assert.ok(reply);
      assert.deepEqual(reply.result, o.capture.result);
      assert.ok(submit.at <= reply.at);
    } else {
      assert.ok(o.captured);
      sameCapture(d, o.captured);
    }
  } else sameCapture(d, o.prior.transition.document);
  if (o.phase !== "capture") {
    assert.equal(o.headless, true);
    assert.deepEqual(o.ipc, []);
  }
  assert.deepEqual(p.journal.plan.preferencesEvidence, { nonce: d.nonce, digest: d.digest });
  assert.equal(p.journal.plan.items.length, 1);
  assert.equal(p.journal.items.length, 1);
  assert.equal(p.journal.items[0].state, "committed");
  assertPreferenceStorage(partition(o, PREFERENCE_SOURCE), d, p.journal);
}
export function assertPreferenceStorage(o: Wire, d: Wire, journal: Wire) {
  const bytes = snapshotBytes(d.raw, d.allowlist),
    digest = createHash("sha256").update(bytes).digest("hex");
  assert.ok(bytes.length <= 65536);
  assert.equal(d.digest, digest);
  const boots = o.processes.filter((r: Wire) => r.kind === "boot");
  assert.equal(boots.length, 1);
  assert.ok(boots[0].pid > 0 && boots[0].pid !== o.pid);
  assert.equal(boots[0].owner.hostEpoch, o.hostEpoch);
  const replies = o.wire.filter((r: Wire) => r.direction === "host" && r.method);
  for (const r of replies) {
    assert.equal(r.message.error, undefined);
    assert.equal(r.message.result?.ok, true);
    assert.equal(r.owner.sourceKey, PREFERENCE_SOURCE);
    assert.equal(r.owner.hostEpoch, o.hostEpoch);
    const q = o.wire.find(
      (q: Wire) =>
        q.direction === "plugin" && q.message.id === r.requestId && q.message.method === r.method,
    );
    assert.ok(q);
    assert.deepEqual(q.owner, r.owner);
    assert.deepEqual(q.message.params, r.params);
    assert.equal(r.message.id, r.requestId);
    assert.ok(q.sequence < r.sequence);
  }
  const list = replies.find((r: Wire) => r.method === "storage/list");
  assert.ok(list);
  assert.equal(list.params.kind, "test.preferences");
  assert.equal(list.message.result.value.nextCursor, undefined);
  const records = list.message.result.value.entries;
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.byteLength, bytes.length);
  assert.equal(record.sha256, digest);
  assert.equal(record.id, journal.plan.items[0].ticket.target.id);
  assert.deepEqual(record, journal.items[0].publicationTicket.metadata.record);
  assert.equal(record.revision, journal.items[0].receipt.revision);
  const opened = replies.filter((r: Wire) => r.method === "storage/openRead");
  assert.equal(opened.length, 1);
  const open = opened[0];
  assert.deepEqual(open.message.result.value.record, record);
  assert.equal(open.params.expectedRevision, record.revision);
  const closed = replies.filter((r: Wire) => r.method === "storage/closeRead");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].params.read, open.message.result.value.read);
  const chunks = replies.filter((r: Wire) => r.method === "storage/readChunk");
  assert.ok(chunks.length);
  let offset = 0;
  for (const r of chunks) {
    assert.equal(r.params.read, open.message.result.value.read);
    assert.equal(r.params.offset, offset);
    assert.equal(r.chunk.offset, offset);
    assert.equal(r.chunk.recordId, record.id);
    assert.ok(
      r.chunk.bytes > 0 && r.chunk.bytes <= r.params.maxBytes && r.params.maxBytes <= 262144,
    );
    assert.ok(open.sequence < r.sequence && r.sequence < closed[0].sequence);
    assert.equal(
      r.chunk.sha256,
      createHash("sha256")
        .update(bytes.subarray(offset, offset + r.chunk.bytes))
        .digest("hex"),
    );
    offset += r.chunk.bytes;
    assert.ok(offset <= bytes.length);
    assert.equal(r.chunk.eof, offset === bytes.length);
    assert.equal(r.message.result.value.data, undefined);
    assert.equal(r.message.result.value.offset, r.chunk.offset);
    assert.equal(r.message.result.value.nextOffset, offset);
    assert.equal(r.message.result.value.eof, r.chunk.eof);
  }
  assert.equal(chunks.at(-1).chunk.recordSha256, digest);
  assert.equal(offset, bytes.length);
  assert.equal(
    replies.some((r: Wire) => r.method === "storage/delete"),
    false,
  );
}
export function assertPreferenceSequence(receipts: Wire[]) {
  assert.ok(receipts.length);
  const first = receipts[0]!,
    prior = first.evidence.importPreferences;
  assertPreferencePause(prior);
  assert.equal(first.status, "killed-import");
  assert.equal(first.signal, "SIGKILL");
  assert.deepEqual(
    receipts.map((r) => r.evidence.importPreferences.phase),
    preferencePhases(prior.cut),
  );
  assert.equal(new Set(receipts.map((r) => r.pid)).size, receipts.length);
  assert.equal(new Set(receipts.map((r) => r.hostEpoch)).size, receipts.length);
  let captured: Wire | undefined, records: Wire[] | undefined, deleted: string | undefined;
  let preferenceRecords: Wire[] | undefined, preferencePlan: Wire | undefined;
  for (const r of receipts.slice(1)) {
    for (const key of ["profileId", "commit", "bundleSha256", "artifactSha256"])
      assert.deepEqual(r[key], first[key]);
    assert.equal(r.exitCode, 0);
    assert.equal(r.signal, null);
    for (const key of ["children", "workers", "listeners"]) assert.equal(r.cleanup[key], 0);
    assert.deepEqual(r.cleanup.errors, []);
    const o = r.evidence.importPreferences;
    assert.deepEqual(o.prior, prior);
    assertPreferencePhase(o);
    if (o.phase === "capture")
      captured = o.preferences.documents.find((v: Wire) => v.document.raw)?.document;
    if (captured && o.phase !== "capture") assert.deepEqual(o.captured, captured);
    for (const boot of o.processes.filter((p: Wire) => p.kind === "boot")) {
      assert.ok(r.observedDescendants.some((p: Wire) => p.pid === boot.pid));
      assert.equal(
        o.processes.filter(
          (p: Wire) => p.kind === "exit" && p.owner.sourceKey === boot.owner.sourceKey,
        ).length,
        1,
      );
    }
    if (o.phase !== "pending") {
      const preferenceRows = partition(o, PREFERENCE_SOURCE).wire;
      const currentPreferences = preferenceRows.find(
        (w: Wire) => w.direction === "host" && w.method === "storage/list",
      ).message.result.value.entries;
      preferenceRecords ??= currentPreferences;
      preferencePlan ??= o.preferences.journal.plan;
      assert.deepEqual(currentPreferences, preferenceRecords);
      assert.deepEqual(o.preferences.journal.plan, preferencePlan);
    }
    const rows = partition(o, "builtin:test.synthetic").wire.filter(
      (w: Wire) => w.direction === "host",
    );
    const current = rows
      .find((w: Wire) => w.method === "storage/list")
      .message.result.value.entries.slice()
      .sort((a: Wire, b: Wire) => a.id.localeCompare(b.id));
    records ??= current;
    assert.deepEqual(
      current,
      o.phase === "deleted" ? records!.filter((v: Wire) => v.id !== deleted) : records,
    );
    if (o.phase === "reopen3")
      deleted = rows.find((w: Wire) => w.method === "storage/delete").params.id;
  }
  assert.ok(deleted);
}
