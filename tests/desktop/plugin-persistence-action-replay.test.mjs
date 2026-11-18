import { actionReplayOracle as specimen } from "./fixtures/plugin-persistence/action-replay-oracle.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertActionObservation,
  actionSummary,
  nativeActionControl,
  waitForActionDialog,
} from "./plugin-persistence-action-replay.ts";
import { assertActionReplayEvidence, verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// A pure oracle specimen, not a producer or a claim of native execution.
const evidence = (o) => ({ actionReplay: o, checks: actionSummary(o), events: [], samples: {} });

test("action replay pure oracle validates correlated proof and rejects summary-only receipts", () => {
  assert.deepEqual(selectFoundationCases({ caseId: "action-replay" }), ["action-replay"]);
  const o = specimen();
  assertActionObservation(o);
  assertActionReplayEvidence(evidence(o));
  assert.throws(
    () =>
      verifyRunReceipt({ case: "action-replay", evidence: outcomeOracleFixture("action-replay") }),
    /Missing action replay observations/,
  );
  assert.throws(
    () => verifyRunReceipt({ case: "action-replay", evidence: evidence(o), hostEpoch: id(999) }),
    /another composition/,
  );
  const altered = evidence(o);
  altered.checks.freshCoreAction = false;
  assert.throws(() => assertActionReplayEvidence(altered), /summary differs/);
});
const find = (o, phase, kind, method) =>
  o.rows.find((r) => r.phase === phase && r.kind === kind && (!method || r.method === method));
for (const [name, mutate] of [
  [
    "missing native invocation",
    (o) => {
      o.rows = o.rows.filter((r) => !(r.phase === "cancel" && r.kind === "ui"));
    },
  ],
  [
    "wrong source probe actually same source",
    (o) => {
      find(o, "wrong-source", "rpc").args.principal.owner = o.owner;
    },
  ],
  [
    "wrong generation never changed",
    (o) => {
      find(o, "wrong-generation", "rpc").args.principal.owner.generation = 1;
    },
  ],
  [
    "premature expiry",
    (o) => {
      find(o, "expired", "rpc").start = find(o, "expired", "feature", "mint").end + 4999;
    },
  ],
  [
    "forged token was minted",
    (o) => {
      find(o, "wrong-source", "feature", "mint").result.value = find(
        o,
        "forged",
        "rpc",
      ).args.params.actionRef;
    },
  ],
  [
    "denial reported success",
    (o) => {
      find(o, "forged", "rpc").result.ok = true;
    },
  ],
  [
    "replay never consumed",
    (o) => {
      find(o, "cancel", "feature", "claim").result.value.ok = false;
    },
  ],
  [
    "denied write",
    (o) => {
      o.rows.push({ ...find(o, "identity", "output", "begin"), phase: "forged" });
    },
  ],
  [
    "cancel was selected",
    (o) => {
      find(o, "cancel", "dialog").result.selected = o.files.cancel.before.path;
    },
  ],
  [
    "cancel never settled",
    (o) => {
      find(o, "cancel", "rpc", "storage/exportStatus").result.value.state = "waiting";
    },
  ],
  [
    "destination changed without rehash",
    (o) => {
      o.files.cancel.after.data = Buffer.from("bad").toString("base64");
    },
  ],
  [
    "identity never replaced",
    (o) => {
      o.files.replacement.before.identity = o.files.identity.before.identity;
    },
  ],
  [
    "replacement was overwritten",
    (o) => {
      o.files.replacement.after = o.files.core.after;
    },
  ],
  [
    "unrelated output job",
    (o) => {
      find(o, "identity", "output", "begin").args.job = id(999);
    },
  ],
  [
    "unrelated destination",
    (o) => {
      find(o, "identity", "output", "begin").args.destination = id(999);
    },
  ],
  [
    "registry release missing",
    (o) => {
      o.rows = o.rows.filter((r) => !(r.phase === "registered-cancel" && r.method === "release"));
    },
  ],
  [
    "registry released twice",
    (o) => {
      o.rows.push(structuredClone(find(o, "registered-cancel", "destination", "release")));
    },
  ],
  [
    "late dialog wrote",
    (o) => {
      o.rows.push({ ...find(o, "core", "output", "commit"), phase: "late" });
    },
  ],
  [
    "late dialog registered",
    (o) => {
      o.rows.push({ ...find(o, "core", "destination", "register"), phase: "late" });
    },
  ],
  [
    "renderer never exited",
    (o) => {
      o.renderer.reason = "pending";
    },
  ],
  [
    "renderer exited after selection",
    (o) => {
      o.renderer.at = find(o, "late", "dialog").end + 1;
    },
  ],
  [
    "OS exit not observed",
    (o) => {
      o.renderer.osExit.code = "EPERM";
    },
  ],
  [
    "OS exit after selection",
    (o) => {
      o.renderer.osExit.at = find(o, "late", "dialog").end + 1;
    },
  ],
  [
    "renderer PID absent",
    (o) => {
      o.renderer.pid = 0;
    },
  ],
  [
    "core request missing",
    (o) => {
      o.rows = o.rows.filter((r) => r.kind !== "core-rpc");
    },
  ],
  [
    "core claim bypassed",
    (o) => {
      find(o, "core", "core", "claim").result.value = false;
    },
  ],
  [
    "core claim wrong token",
    (o) => {
      find(o, "core", "core", "claim").args.values[0] = { actionToken: id(999) };
    },
  ],
  [
    "core uncommitted",
    (o) => {
      find(o, "core", "output", "commit").result.disposition = "unknown";
    },
  ],
  [
    "core output bytes not written",
    (o) => {
      o.files.core.after = o.files.core.before;
    },
  ],
  [
    "clipboard touched",
    (o) => {
      o.clipboard.writes.push({ phase: "forged", text: "secret", at: 1 });
    },
  ],
  [
    "clipboard observation changed",
    (o) => {
      o.clipboard.after = "bad";
    },
  ],
  [
    "device recording during dialog",
    (o) => {
      find(o, "cancel", "device").result.value.sessions[0].recording = true;
    },
  ],
  [
    "device motion during dialog",
    (o) => {
      find(o, "cancel", "device").result.value.sessions[0].foreground = "motion";
    },
  ],
  [
    "device snapshot missing",
    (o) => {
      o.rows = o.rows.filter((r) => !(r.phase === "cancel" && r.kind === "device"));
    },
  ],
  [
    "native path leaked",
    (o) => {
      find(o, "forged", "rpc").result.error.message = o.files.cancel.before.path;
    },
  ],
  [
    "clipboard value leaked",
    (o) => {
      find(o, "forged", "rpc").result.error.message = "T7 action export value sentinel";
    },
  ],
])
  test(`action replay tamper: ${name}`, () => {
    const o = structuredClone(specimen());
    mutate(o);
    assert.throws(() => assertActionReplayEvidence(evidence(o)));
  });

test("host native selection seam observes cancellation and pending late selection without OS effects", async () => {
  let now = 1;
  const control = nativeActionControl(() => now);
  control.phase = "cancel";
  const first = control.choose("file.txt");
  await control.opened();
  now++;
  control.select(null);
  assert.equal(await first, null);
  control.phase = "late";
  const second = control.choose("late.txt");
  now++;
  control.select("/private/test/late.txt");
  assert.equal(await second, "/private/test/late.txt");
  assert.deepEqual(
    control.dialogs.map((r) => r.phase),
    ["cancel", "late"],
  );
  assert.deepEqual(control.writes, []);
  assert.throws(() => control.select(null), /No actual adapter dialog/);
});

for (const phase of ["forged", "wrong-source", "expired", "replay"])
  for (const index of [0, 1])
    for (const field of ["owner", "purpose", "actionRef"])
      test(`denied claim tamper: ${phase} ${index} ${field}`, () => {
        const o = specimen();
        const claim = o.rows.filter(
          (r) => r.phase === phase && r.kind === "feature" && r.method === "claim",
        )[index];
        if (field === "owner")
          claim.args.values[0].owner = phase === "wrong-source" ? o.owner : o.otherOwner;
        else if (field === "purpose") claim.args.values[1] = "wrong-purpose";
        else claim.args.values[0].actionRef = id(999);
        assert.throws(() => assertActionObservation(o));
      });
for (const phase of ["identity", "registered-cancel"])
  test(`destination action tamper: ${phase}`, () => {
    const o = specimen();
    find(o, phase, "destination", "register").args.action = id(999);
    assert.throws(() => assertActionObservation(o));
  });
for (const phase of [
  "forged",
  "wrong-source",
  "wrong-generation",
  "expired",
  "replay",
  "cancel",
  "identity",
  "replacement",
  "registered-cancel",
  "core",
  "late",
])
  for (const part of ["pair", "before", "after"])
    test(`missing file evidence: ${phase} ${part}`, () => {
      const o = specimen();
      if (part === "pair") delete o.files[phase];
      else delete o.files[phase][part];
      assert.throws(() => assertActionObservation(o), /Missing .* file pair/);
    });
test("core export failure is surfaced before a chooser opens", async () => {
  const native = nativeActionControl(() => 1);
  await assert.rejects(
    waitForActionDialog(native, Promise.reject(new Error("No recovery export"))),
    /No recovery export/,
  );
  await assert.rejects(waitForActionDialog(native, Promise.resolve()), /completed before opening/);
  const choosing = native.choose("recovery.bin");
  await waitForActionDialog(native, choosing);
  native.select(null);
  await choosing;
});
test("actual initial generation zero remains a valid owner", () => {
  const o = specimen();
  // Rewrite all correlated owners/bindings, preserving the wrong-generation probe.
  const replace = (v) => {
    if (!v || typeof v !== "object") return;
    if (typeof v.generation === "number") v.generation--;
    for (const child of Object.values(v)) replace(child);
  };
  const copy = JSON.parse(JSON.stringify(o));
  replace(copy);
  assertActionObservation(copy);
});

for (const phase of ["cancel", "identity", "registered-cancel", "late"])
  for (const field of [
    "mintOwner",
    "mintScope",
    "hostEpoch",
    "processEpoch",
    "generation",
    "contributionId",
    "panelInstance",
    "uiResourceGeneration",
  ])
    test(`successful action binding tamper: ${phase} ${field}`, () => {
      const o = specimen();
      if (field === "mintOwner") find(o, phase, "feature", "mint").args.values[0] = o.otherOwner;
      else if (field === "mintScope")
        find(o, phase, "feature", "mint").args.values[1] = {
          ...o.scope,
          workbenchInstance: id(999),
        };
      else {
        const row = find(o, phase, "ui", "invoke");
        row.args.binding = {
          ...row.args.binding,
          [field]: ["generation", "uiResourceGeneration"].includes(field) ? 99 : id(999),
        };
      }
      assert.throws(() => assertActionObservation(o));
    });
