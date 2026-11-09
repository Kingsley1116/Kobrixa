import { createHash } from "node:crypto";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = (b) => createHash("sha256").update(b).digest("hex");
const offset = 1700000000000;
const clock = (mono) => ({ mono, wall: offset + mono, end: mono, elapsed: mono });
const copy = structuredClone;
export function sealedTtlOracle() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  };
  const calls = [],
    retained = [];
  function row(phase, method, params, value, start, extra = {}) {
    const r = {
      phase,
      method: `storage/${method}`,
      owner: copy(owner),
      params: copy(params),
      result: { ok: true, value: copy(value) },
      start: clock(start),
      end: clock(start + 1),
      ...copy(extra),
    };
    calls.push(r);
    return r;
  }
  const bad = (phase, method, params, code, start) => {
    const r = row(phase, method, params, {}, start);
    r.result = { ok: false, error: { code } };
    return r;
  };
  function seed(n, at, phase, complete) {
    const oldBytes = Buffer.from(`checkpoint ${n}`),
      finalBytes = Buffer.from(`complete final payload ${n}`);
    const meta = (bytes, revision, checkpoint) => ({
      id: id(n),
      revision,
      kind: "test.registration-end",
      schemaVersion: 1,
      label: "TTL",
      mediaType: "application/octet-stream",
      byteLength: bytes.length,
      sha256: digest(bytes),
      createdAt: offset + at,
      updatedAt: offset + at,
      checkpoint,
      interrupted: false,
    });
    const old = meta(oldBytes, `r_${String(n).padStart(32, "0")}`, "none"),
      next = meta(finalBytes, `r_${String(n + 1).padStart(32, "0")}`, "final");
    const ticket = (record, handle, created, expectedRevision) => ({
      id: id(handle),
      owner: copy(owner),
      deadlineMonotonicMs: created + 120000,
      metadata: { kind: "record", record: copy(record), deleted: false },
      target: { kind: "record", id: record.id, expectedRevision },
    });
    const oldTicket = ticket(old, n + 2, at, null),
      finalTicket = ticket(next, n + 3, at + 10, old.revision);
    const params = (r) =>
      Object.fromEntries(
        ["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"].map((k) => [
          k,
          r[k],
        ]),
      );
    row(
      phase,
      "beginWrite",
      { ...params(old), target: { mode: "create" } },
      { write: oldTicket.id, id: old.id, expiresAt: offset + at + 30000 },
      at,
      { ticket: oldTicket },
    );
    row(
      phase,
      "writeChunk",
      { write: oldTicket.id, offset: 0, data: oldBytes.toString("base64") },
      { receivedBytes: oldBytes.length },
      at + 2,
    );
    row(phase, "sealWrite", { write: oldTicket.id }, { state: "sealed" }, at + 4);
    row(
      phase,
      "commitWrite",
      { write: oldTicket.id },
      { record: old, receipt: { commitId: id(n + 4), revision: old.revision } },
      at + 6,
    );
    row(
      phase,
      "registerCheckpoint",
      { id: old.id, expectedRevision: old.revision, reservation: id(n + 5) },
      { checkpoint: id(n + 6) },
      at + 8,
    );
    row(
      phase,
      "beginWrite",
      {
        ...params(next),
        target: { mode: "replace", id: old.id, expectedRevision: old.revision },
        checkpoint: { handle: id(n + 6), phase: "final" },
      },
      { write: finalTicket.id, id: old.id, expiresAt: offset + at + 30010 },
      at + 10,
      { ticket: finalTicket },
    );
    const sent = complete ? finalBytes : finalBytes.subarray(0, 4);
    row(
      phase,
      "writeChunk",
      { write: finalTicket.id, offset: 0, data: sent.toString("base64") },
      { receivedBytes: sent.length },
      at + 12,
    );
    if (complete) {
      row(
        phase,
        "sealWrite",
        { write: finalTicket.id },
        {
          write: finalTicket.id,
          id: next.id,
          receivedBytes: finalBytes.length,
          state: "sealed",
          expiresAt: offset + at + 30015,
        },
        at + 14,
      );
      retained.push({ ticket: copy(finalTicket), pin: id(n + 7), expiresMonotonicMs: at + 30014 });
    }
    return { old, next, oldBytes, finalBytes, finalTicket, oldTicket, at, n };
  }
  function read(s, phase, at, handle) {
    row(
      phase,
      "openRead",
      { id: s.old.id, expectedRevision: s.old.revision, schemaVersion: 1 },
      { read: id(handle), record: s.old, expiresAt: offset + at + 30000 },
      at,
    );
    row(
      phase,
      "readChunk",
      { read: id(handle), offset: 0, maxBytes: 262144 },
      { offset: 0, data: s.oldBytes.toString("base64"), nextOffset: s.oldBytes.length, eof: true },
      at + 2,
    );
  }
  const s = seed(10, 10, "seed-sealed", true);
  read(s, "seed-sealed", 28, 50);
  const drain = (s, phase, at, complete) => {
    const offer = {
      owner: copy(owner),
      reason: "reservation-ended",
      deadlineMonotonicMs: at + 10000,
      token: id(s.n + 8),
      checkpoints: [{ checkpoint: id(s.n + 6), record: copy(s.old) }],
      writes: [{ write: s.finalTicket.id, id: s.old.id, state: complete ? "sealed" : "receiving" }],
      acceptedTickets: [s.finalTicket.id],
    };
    const report = {
      state: complete ? "retryable" : "checkpoint-only",
      blocker: true,
      pendingSettings: false,
      recovery: id(s.n + 9),
      records: [
        {
          id: s.old.id,
          committedRevision: s.old.revision,
          final: false,
          payload: complete ? "complete-staging" : "checkpoint-only",
          ...(complete ? { expiresAt: offset + 30024 } : {}),
        },
      ],
      errors: [],
    };
    return {
      phase,
      offer,
      start: clock(at),
      end: clock(at + 10),
      requests: [
        {
          owner: copy(owner),
          request: {
            token: offer.token,
            remainingMs: 9999,
            reason: "reservation-ended",
            writes: copy(offer.writes),
            checkpoints: copy(offer.checkpoints),
          },
          result: {
            ok: true,
            value: { status: complete ? "submitted" : "checkpoint-only", writes: [] },
          },
        },
      ],
      report,
    };
  };
  const d = drain(s, "drain-sealed", 19, true);
  bad(
    "drain-sealed",
    "commitWrite",
    { write: s.finalTicket.id, drainToken: d.offer.token },
    "PLUGIN_E_STORAGE_IO",
    42,
  );
  d.end = clock(50);
  const recovery = {
    id: d.report.recovery,
    owner: copy(owner),
    report: copy(d.report),
    ticket: copy(s.finalTicket),
    sealedPin: retained[0].pin,
    expiresAt: offset + 30024,
  };
  const retry = {
    id: recovery.id,
    action: {
      actionToken: id(60),
      scope: { hostEpoch: owner.hostEpoch, workbenchInstance: id(61) },
    },
    start: clock(60),
    end: clock(70),
    report: copy(d.report),
  };
  row(
    "status",
    "writeStatus",
    { write: s.finalTicket.id },
    { write: s.finalTicket.id, state: "sealed", expiresAt: offset + 30025 },
    72,
  );
  const expired = {
    phase: "after-expiry",
    offer: copy(d.offer),
    start: clock(30200),
    end: clock(30201),
    requests: [],
    report: {
      ...copy(d.report),
      state: "checkpoint-only",
      records: [
        {
          id: s.old.id,
          committedRevision: s.old.revision,
          final: false,
          payload: "checkpoint-only",
        },
      ],
    },
  };
  bad(
    "expired",
    "readChunk",
    { read: id(50), offset: 0, maxBytes: 262144 },
    "PLUGIN_E_STALE_RESOURCE",
    30202,
  );
  bad("expired", "commitWrite", { write: s.finalTicket.id }, "PLUGIN_E_STALE_RESOURCE", 30204);
  row(
    "expired",
    "writeStatus",
    { write: s.finalTicket.id },
    {
      write: s.finalTicket.id,
      id: s.old.id,
      state: "expired",
      receivedBytes: s.finalBytes.length,
      expiresAt: offset + 30025,
    },
    30205,
  );
  read(s, "read-sealed", 30206, 51);
  const i = seed(30, 30220, "seed-incomplete", false),
    di = drain(i, "drain-incomplete", 30229, false);
  read(i, "read-incomplete", 30252, 52);
  const seedTrace = [
    { point: "reserve", ticket: s.finalTicket.id, time: 20 },
    { point: "open-temp", ticket: s.finalTicket.id, time: 20.5 },
  ];
  const failed = [...seedTrace, { point: "before-publish", ticket: s.finalTicket.id, time: 42.5 }];
  const retried = [...failed, { point: "before-publish", ticket: s.finalTicket.id, time: 63 }];
  for (const r of calls) {
    if (
      (r.phase === "seed-sealed" || r.phase === "seed-incomplete") &&
      ((r.method === "storage/beginWrite" && r.params.target.mode === "replace") ||
        (["storage/writeChunk", "storage/sealWrite"].includes(r.method) &&
          [s.finalTicket.id, i.finalTicket.id].includes(r.params.write)))
    ) {
      r.phase = r.phase.replace("seed-", "drain-");
      if (r.method === "storage/beginWrite")
        r.params.drainToken = r.phase === "drain-sealed" ? d.offer.token : di.offer.token;
    }
  }
  for (const entry of [d, expired, di]) {
    entry.offer.writes = [];
    entry.offer.acceptedTickets = [];
    for (const req of entry.requests) req.request.writes = [];
  }
  return copy({
    owner,
    channelOwner: owner,
    ownerAfter: owner,
    started: clock(0),
    ended: clock(30260),
    exits: [],
    sdkDrains: [d, di].flatMap((d) =>
      d.requests.map((r) => ({ request: copy(r.request), result: copy(r.result) })),
    ),
    calls,
    drains: [d, expired, di],
    retry: [retry],
    discards: [
      {
        id: recovery.id,
        action: { ...copy(retry.action), actionToken: id(77) },
        start: clock(30210),
        end: clock(30211),
        report: { ...copy(expired.report), state: "saved", blocker: false },
      },
    ],
    publications: [
      {
        ticket: s.finalTicket,
        pin: retained[0].pin,
        deadline: 10060,
        start: clock(62),
        end: clock(64),
        result: { disposition: "not-committed" },
      },
    ],
    retained,
    recovery: {
      before: copy(recovery),
      after: copy(recovery),
      expired: { ...copy(recovery), sealedPin: null, report: copy(expired.report) },
    },
    payloads: { before: s.finalBytes.toString("base64"), after: s.finalBytes.toString("base64") },
    traces: { seed: [], failed, retried, expired: copy(retried), final: copy(retried) },
  });
}
