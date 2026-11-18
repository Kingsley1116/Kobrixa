import { createHash } from "node:crypto";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = structuredClone;

// Pure negative-validation specimen only. Never native evidence or a fake producer.
export function unknownOracle() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  };
  const oldBytes = Buffer.from("complete predecessor"),
    newBytes = Buffer.from("complete replacement");
  const meta = (bytes, revision) => ({
    id: id(3),
    revision,
    kind: "test.unknown-publication",
    schemaVersion: 1,
    label: "Unknown publication",
    mediaType: "application/octet-stream",
    byteLength: bytes.length,
    sha256: digest(bytes),
    createdAt: 1,
    updatedAt: 2,
    checkpoint: "none",
    interrupted: false,
  });
  const old = meta(oldBytes, `r_${"1".repeat(32)}`),
    next = meta(newBytes, `r_${"2".repeat(32)}`);
  const ticketFor = (n, record, expectedRevision) => ({
    id: id(n),
    owner: clone(owner),
    deadlineMonotonicMs: 120000,
    target: { kind: "record", id: id(3), expectedRevision },
    metadata: { kind: "record", record, deleted: false },
  });
  const oldTicket = ticketFor(4, old, null),
    ticket = ticketFor(5, next, old.revision);
  const headFor = (t, n) => ({
    formatVersion: 1,
    metadata: t.metadata,
    target: t.target,
    object: `${t.metadata.record.revision}.bin`,
    byteLength: t.metadata.record.byteLength,
    sha256: t.metadata.record.sha256,
    receipt: {
      revision: t.metadata.record.revision,
      commitId: id(n),
      durability: "file-and-directory-sync",
    },
  });
  const previous = headFor(oldTicket, 6),
    head = headFor(ticket, 7);
  const blob = (path, bytes, inode) => ({
    path,
    data: Buffer.from(bytes).toString("base64"),
    bytes: Buffer.byteLength(bytes),
    identity: `1:${inode}`,
  });
  const ns = `namespaces/${digest(owner.sourceKey)}`,
    dir = `${ns}/records/${id(3)}`;
  const disk = {
    namespace: ns,
    identity: blob(
      `${ns}/identity.json`,
      JSON.stringify({ formatVersion: 1, sourceKey: owner.sourceKey }),
      1,
    ),
    intent: blob(
      `${ns}/staging/${ticket.id}/intent.json`,
      JSON.stringify({
        formatVersion: 1,
        ticket,
        byteLength: newBytes.length,
        predecessor: previous,
      }),
      2,
    ),
    head: blob(`${dir}/head.json`, JSON.stringify(head), 3),
    previous: blob(`${dir}/head.previous`, JSON.stringify(previous), 4),
    oldObject: blob(`${dir}/objects/${old.revision}.bin`, oldBytes, 5),
    newObject: blob(`${dir}/objects/${next.revision}.bin`, newBytes, 6),
  };
  const calls = [];
  const row = (phase, method, params, result, extra = {}) => ({
    phase,
    method,
    owner: clone(owner),
    params: clone(params),
    result: clone(result),
    ...clone(extra),
  });
  const begin = (t, mode) =>
    row(
      "seed",
      "storage/beginWrite",
      {
        ...Object.fromEntries(
          ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"].map((k) => [
            k,
            t.metadata.record[k],
          ]),
        ),
        target: mode === "create" ? { mode } : { mode, id: id(3), expectedRevision: old.revision },
      },
      { ok: true, value: { id: id(3), write: t.id } },
      { ticket: t },
    );
  for (const [t, bytes, mode] of [
    [oldTicket, oldBytes, "create"],
    [ticket, newBytes, "replace"],
  ]) {
    calls.push(
      begin(t, mode),
      row(
        "seed",
        "storage/writeChunk",
        { write: t.id, offset: 0, data: bytes.toString("base64") },
        { ok: true },
      ),
      row("seed", "storage/sealWrite", { write: t.id }, { ok: true, value: { state: "sealed" } }),
    );
    if (mode === "create")
      calls.push(
        row(
          "seed",
          "storage/commitWrite",
          { write: t.id },
          { ok: true, value: { record: old, receipt: previous.receipt } },
        ),
      );
  }
  const uncertain = {
    ok: false,
    error: {
      code: "PLUGIN_E_STORAGE_IO",
      detail: { reason: "publish-uncertain", disposition: "unknown" },
    },
  };
  calls.push(row("publish", "storage/commitWrite", { write: ticket.id }, uncertain));
  const probe = { ...calls[4].params, target: { mode: "create" } };
  const rejectedTicket = ticketFor(14, { ...next, id: id(15) }, null);
  rejectedTicket.target.id = id(15);
  calls.push(row("probe", "storage/beginWrite", probe, uncertain, { ticket: rejectedTicket }));
  for (let i = 0; i < 2; i++)
    calls.push(
      row(
        "reconcile",
        "storage/commitWrite",
        { write: ticket.id },
        { ok: true, value: { record: next, receipt: head.receipt } },
      ),
    );
  let time = 0;
  const trace = (point, ticket) => ({ point, ticket, time: ++time });
  const seed = [
    trace("reserve", oldTicket.id),
    trace("open-temp", oldTicket.id),
    trace("before-publish", oldTicket.id),
    trace("after-publish", oldTicket.id),
    trace("receipt-send", oldTicket.id),
    trace("reserve", ticket.id),
    trace("open-temp", ticket.id),
  ];
  const unknown = [...seed, trace("before-publish", ticket.id), trace("after-publish", ticket.id)];
  const outputTrace = [trace("before-publish", null), trace("after-publish", null)];
  const finalTrace = [...unknown, ...outputTrace];
  const nativePath = "/retained/profile/unknown-export/original.bin";
  const registration = {
    action: id(8),
    scope: { hostEpoch: owner.hostEpoch, workbenchInstance: id(9) },
    nativePath,
    deadlineMonotonicMs: 10000,
  };
  const staged = blob(
    "/retained/profile/unknown-export/.kobrixa-00000000-0000-4000-8000-000000000010.tmp",
    newBytes,
    21,
  );
  const published = blob(nativePath, newBytes, 21);
  const job = id(11),
    committed = {
      disposition: "committed",
      commitId: id(12),
      durability: "file-and-directory-sync",
    };
  const e = {
    registration,
    owner: clone(owner),
    job,
    bytes: newBytes.toString("base64"),
    before: blob(nativePath, oldBytes, 20),
    parentIdentity: "1:19",
    parentAfter: "1:19",
    staged,
    published,
    substituted: blob(nativePath, newBytes, 22),
    restored: clone(published),
    final: clone(published),
    calls: [
      {
        method: "begin",
        job,
        args: {
          owner: clone(owner),
          registration: clone(registration),
          bytes: newBytes.length,
          sha256: digest(newBytes),
          deadline: registration.deadlineMonotonicMs,
        },
        result: null,
        trace: [],
      },
      {
        method: "append",
        job,
        args: { offset: 0, data: newBytes.toString("base64") },
        result: newBytes.length,
        trace: [],
      },
      ...["commit", "reconcile", "reconcile", "reconcile"].map((method, i) => ({
        method,
        job,
        args: {},
        result: i < 2 ? { disposition: "unknown" } : clone(committed),
        trace: i === 0 ? clone(outputTrace) : [],
      })),
    ],
  };
  return {
    faultMode: "explicit-after-publish-failure",
    scope: "sdk-record-and-native-output-port",
    owner,
    channelOwner: clone(owner),
    calls,
    ticket,
    oldTicket,
    disk,
    afterProbe: clone(disk),
    traces: { seed, unknown, probe: clone(unknown), reconciled: clone(unknown), final: finalTrace },
    reconciliation: {
      ticket: clone(ticket),
      result: { disposition: "committed", receipt: head.receipt },
    },
    generation: {
      old: clone(owner),
      next: { ...owner, generation: 2, processEpoch: id(13) },
      exit: { code: 0 },
      traceBefore: clone(finalTrace),
      traceAfter: clone(finalTrace),
      probes: [
        row("old-generation", "storage/beginWrite", probe, {
          ok: false,
          error: { code: "PLUGIN_E_STALE_RESOURCE" },
        }),
        row(
          "old-generation",
          "storage/commitWrite",
          { write: ticket.id },
          { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } },
        ),
      ],
    },
    export: e,
  };
}
