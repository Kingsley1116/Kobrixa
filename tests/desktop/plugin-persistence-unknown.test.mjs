import { unknownOracle as specimen } from "./fixtures/plugin-persistence/unknown-oracle.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertUnknownObservation,
  assertUnknownFenceFailure,
  cleanupUnknown,
  unknownSummary,
} from "./plugin-persistence-unknown.ts";
import { assertUnknownEvidence, verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
import { assertFoundationOutcome, FOUNDATION_CHECKS } from "./plugin-persistence-outcomes.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const clone = structuredClone;

// Pure negative-validation specimen only. Never native evidence or a fake producer.
function evidence(o = specimen()) {
  return { unknown: o, checks: unknownSummary(o), events: [], samples: {} };
}
const mutateJson = (blob, change) => {
  const raw = JSON.parse(Buffer.from(blob.data, "base64"));
  change(raw);
  const bytes = Buffer.from(JSON.stringify(raw));
  blob.data = bytes.toString("base64");
  blob.bytes = bytes.length;
};

test("pure unknown validator and independent outside binding accept a correlated specimen", () => {
  const e = evidence();
  assertUnknownObservation(e.unknown);
  assertUnknownEvidence(e);
  assertFoundationOutcome("unknown-publication", e);
  assert.deepEqual(
    Object.keys(e.checks).sort(),
    [...FOUNDATION_CHECKS["unknown-publication"].checks].sort(),
  );
});

const corruptions = {
  "OS kill label without OS exit evidence": (o) => {
    o.faultMode = "os-kill";
  },
  "fake SDK scope": (o) => {
    o.scope = "mock-host";
  },
  "different ticket": (o) => {
    o.reconciliation.ticket.id = id(99);
  },
  "ticket metadata": (o) => {
    o.reconciliation.ticket.metadata.record.sha256 = "f".repeat(64);
  },
  "ticket owner": (o) => {
    o.ticket.owner.generation++;
  },
  "old owner": (o) => {
    o.oldTicket.owner.processEpoch = id(99);
  },
  "channel owner": (o) => {
    o.channelOwner.sourceKey = "different";
  },
  "request owner": (o) => {
    o.calls[0].owner.hostEpoch = id(99);
  },
  "request admission ticket": (o) => {
    o.calls[0].ticket.id = id(99);
  },
  "request target": (o) => {
    o.calls.find((r) => r.ticket?.id === o.ticket.id).params.target.id = id(99);
  },
  "second create target": (o) => {
    o.ticket.target.expectedRevision = null;
  },
  "namespace hash": (o) => {
    o.disk.namespace = `namespaces/${"0".repeat(64)}`;
  },
  "namespace source identity": (o) => {
    mutateJson(o.disk.identity, (r) => {
      r.sourceKey = "other";
    });
  },
  "unrelated intent": (o) => {
    mutateJson(o.disk.intent, (r) => {
      r.ticket.id = id(99);
    });
  },
  "intent owner": (o) => {
    mutateJson(o.disk.intent, (r) => {
      r.ticket.owner.generation++;
    });
  },
  "intent predecessor": (o) => {
    mutateJson(o.disk.intent, (r) => {
      r.predecessor.receipt.commitId = id(99);
    });
  },
  "old whole bytes": (o) => {
    o.disk.oldObject.data = Buffer.from("truncated").toString("base64");
  },
  "new whole bytes": (o) => {
    o.disk.newObject.data = Buffer.from("truncated").toString("base64");
  },
  "old head object binding": (o) => {
    mutateJson(o.disk.previous, (r) => {
      r.object = "different.bin";
    });
  },
  "new head receipt": (o) => {
    mutateJson(o.disk.head, (r) => {
      r.receipt.commitId = id(99);
    });
  },
  "wrong object path": (o) => {
    o.disk.newObject.path = o.disk.oldObject.path;
  },
  "evidence deleted during fence": (o) => {
    o.afterProbe.intent.data = "";
  },
  "successful create through fence": (o) => {
    o.calls.find((r) => r.phase === "probe").result = { ok: true };
  },
  "wrong fence reason": (o) => {
    o.calls.find((r) => r.phase === "probe").result.error.detail.reason = "disk-full";
  },
  "lost confirmation never reached": (o) => {
    o.traces.unknown = o.traces.seed;
  },
  "wrong after-publish ticket": (o) => {
    o.traces.unknown.at(-1).ticket = id(99);
  },
  "no actual reserve": (o) => {
    o.traces.seed[0].point = "chunk-write";
  },
  "second actual publish": (o) => {
    o.traces.final.push({ point: "after-publish", ticket: o.ticket.id, time: 30 });
  },
  "second actual create": (o) => {
    o.traces.probe.push({ point: "reserve", ticket: id(99), time: 30 });
  },
  "invalid acknowledgement time": (o) => {
    o.traces.unknown.at(-1).time = NaN;
  },
  "publication confirmation received": (o) => {
    o.calls.find((r) => r.phase === "publish").result = { ok: true, value: {} };
  },
  "SDK repeated commit new handle": (o) => {
    o.calls.find((r) => r.phase === "reconcile").params.write = id(99);
  },
  "wrong committed receipt": (o) => {
    o.reconciliation.result.receipt.commitId = id(99);
  },
  "generation unchanged": (o) => {
    o.generation.next.generation = o.owner.generation;
  },
  "process revived": (o) => {
    o.generation.next.processEpoch = o.owner.processEpoch;
  },
  "old rights revived": (o) => {
    o.generation.probes[0].result = { ok: true };
  },
  "old commit replay identity": (o) => {
    o.generation.probes[1].params.write = id(99);
  },
  "old replay mutated": (o) => {
    o.generation.traceAfter.push({ point: "reserve", ticket: id(99), time: 30 });
  },
  "export owner": (o) => {
    o.export.owner.generation++;
  },
  "export job": (o) => {
    o.export.calls[3].job = id(99);
  },
  "export registration scope": (o) => {
    o.export.registration.scope.hostEpoch = id(99);
  },
  "export registration destination": (o) => {
    o.export.calls[0].args.registration.nativePath += ".other";
  },
  "export destination path": (o) => {
    o.export.final.path += ".other";
  },
  "export parent identity": (o) => {
    o.export.parentAfter = "2:19";
  },
  "export inode": (o) => {
    o.export.final.identity = "1:99";
  },
  "export equal bytes never changed inode": (o) => {
    o.export.substituted.identity = o.export.published.identity;
  },
  "export accepts wrong inode": (o) => {
    o.export.calls[3].result = clone(o.export.calls[4].result);
  },
  "export reused job never committed": (o) => {
    o.export.calls[4].result = { disposition: "unknown" };
  },
  "export republish": (o) => {
    o.export.calls[4].method = "commit";
  },
  "export hidden syscall": (o) => {
    o.export.calls[4].trace = clone(o.export.calls[2].trace);
  },
  "export unacknowledged failure": (o) => {
    o.export.calls[2].trace = [];
  },
  "export relabelled ticket": (o) => {
    o.export.calls[2].trace[0].ticket = o.ticket.id;
  },
  "export old bytes": (o) => {
    o.export.before.data = o.export.bytes;
  },
  "export complete bytes": (o) => {
    o.export.final.data = "";
  },
  "export renewed deadline": (o) => {
    o.export.calls[0].args.deadline++;
  },
};
for (const [name, change] of Object.entries(corruptions))
  test(`unknown proof rejects ${name}`, () => {
    const o = specimen();
    change(o);
    assert.throws(() => assertUnknownObservation(o));
    assert.throws(() => assertUnknownEvidence({ ...evidence(), unknown: o }));
  });

test("every summary field is independently bound outside the producer checker", () => {
  for (const key of Object.keys(evidence().checks)) {
    const e = evidence();
    e.checks[key] = typeof e.checks[key] === "boolean" ? !e.checks[key] : "wrong";
    assert.throws(() => assertUnknownEvidence(e), key);
  }
  const e = evidence();
  delete e.unknown;
  assert.throws(
    () => verifyRunReceipt({ case: "unknown-publication", evidence: e }),
    /Missing unknown-publication/,
  );
});

test("unknown cleanup settles all tasks even when multiple tasks fail", async () => {
  const calls = [];
  const errors = await cleanupUnknown([
    async () => {
      calls.push("pending");
      throw new Error("pending failed");
    },
    () => {
      calls.push("restore inode");
      throw new Error("restore failed");
    },
    () => {
      calls.push("abort original output");
    },
    () => {
      calls.push("release destination");
    },
    () => {
      calls.push("abort writes");
    },
    () => {
      calls.push("restore observer");
    },
  ]);
  assert.equal(errors.length, 2);
  assert.deepEqual(calls, [
    "pending",
    "restore inode",
    "abort original output",
    "release destination",
    "abort writes",
    "restore observer",
  ]);
});

test("selector and sole composition wire the imported actual producer", async () => {
  assert.deepEqual(selectFoundationCases({ caseId: "unknown-publication" }), [
    "unknown-publication",
  ]);
  const main = await readFile(new URL("./plugin-persistence-main.ts", import.meta.url), "utf8");
  assert.match(main, /await import\("\.\/plugin-persistence-unknown\.js"\)/);
  assert.match(main, /"unknown-publication": \(\) =>\s*produceUnknownPublication\(/);
  assert.doesNotMatch(main, /"unknown-publication": unavailable/);
  assert.equal((main.match(/await composeDesktopMain\(/g) ?? []).length, 1);
  const source = await readFile(
    new URL("./plugin-persistence-unknown.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /startPersistenceWorker|new AtomicStore|new NativeOutput|composeDesktopMain\(/,
  );
  assert.match(source, /fault\.arm\("after-publish", "fail"\)/);
});

test("masked SDK admission errors fail with the precise product owner handoff", () => {
  assert.throws(
    () =>
      assertUnknownFenceFailure({
        ok: false,
        error: {
          code: "PLUGIN_E_STORAGE_IO",
          detail: { kind: "persistence", reason: "io" },
        },
      }),
    /OWNER HANDOFF B2:.*aborted tombstone/,
  );
});

test("outside receipt rejects a complete proof borrowed from another composition", () => {
  assert.throws(
    () =>
      verifyRunReceipt({ case: "unknown-publication", evidence: evidence(), hostEpoch: id(99) }),
    /proof belongs to another composition/,
  );
});

test("correlated trace prefixes cannot hide a second actual create or publication", () => {
  for (const point of ["reserve", "open-temp", "before-publish", "after-publish"]) {
    const o = specimen();
    const index = o.traces.unknown.length;
    for (const trace of [
      o.traces.unknown,
      o.traces.probe,
      o.traces.reconciled,
      o.traces.final,
      o.generation.traceBefore,
      o.generation.traceAfter,
    ])
      trace.splice(index, 0, { point, ticket: o.ticket.id, time: trace[index - 1].time });
    assert.throws(() => assertUnknownObservation(o));
  }
});

test("rejected create retains the actual attempted ticket without borrowing another owner", () => {
  for (const change of [
    (row) => {
      delete row.ticket;
    },
    (row) => {
      row.ticket.owner.generation++;
    },
    (row) => {
      row.ticket.target.expectedRevision = "r_" + "f".repeat(32);
    },
    (row) => {
      row.ticket.id = id(5);
    },
    (row) => {
      row.ticket.metadata.record.byteLength++;
    },
  ]) {
    const o = specimen();
    change(o.calls.find((row) => row.phase === "probe"));
    assert.throws(() => assertUnknownObservation(o));
  }
});
