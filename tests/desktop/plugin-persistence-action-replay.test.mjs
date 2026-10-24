import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  assertActionObservation,
  actionSummary,
  nativeActionControl,
} from "./plugin-persistence-action-replay.ts";
import { assertActionReplayEvidence, verifyRunReceipt } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
import { outcomeOracleFixture } from "./fixtures/plugin-persistence/outcome-oracle.mjs";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = (value) => createHash("sha256").update(value).digest("hex");
// A pure oracle specimen, not a producer or a claim of native execution.
function specimen() {
  const owner = {
    sourceKey: "builtin:acceptance.ui-recording",
    pluginId: "acceptance.ui-recording",
    generation: 1,
    hostEpoch: id(1),
    processEpoch: id(2),
  };
  const otherOwner = {
    ...owner,
    sourceKey: "builtin:acceptance.ui-settings",
    pluginId: "acceptance.ui-settings",
    processEpoch: id(4),
  };
  const scope = { hostEpoch: id(1), workbenchInstance: id(3) };
  const rows = [],
    files = {};
  let clock = 10,
    serial = 10;
  const row = (phase, kind, method, args, result, start = clock++, end = clock++) => {
    const r = { phase, kind, method, args, result, start, end };
    rows.push(r);
    return r;
  };
  const blob = (text, inode) => ({
    path: "/private/case/destination.txt",
    identity: `1:${inode}`,
    data: Buffer.from(text).toString("base64"),
    sha256: hash(text),
  });
  let current = blob("sentinel", 1);
  const copyFile = (phase) => {
    files[phase] = { before: structuredClone(current), after: structuredClone(current) };
  };
  const binding = { ...owner };
  const mint = (phase) => {
    const action = id(serial++),
      start = clock++;
    const minted = row(phase, "feature", "mint", { values: [owner, scope, 1] }, { value: action });
    const invoked = row(
      phase,
      "ui",
      "invoke",
      { binding },
      { ok: true, value: { output: { "action-ref": action } } },
      start,
      clock++,
    );
    return { action, minted, invoked };
  };
  const denied = (phase, action, caller = owner) => {
    for (const method of ["storage/exportBegin", "ui/copyText"]) {
      if (phase !== "wrong-generation")
        row(
          phase,
          "feature",
          "claim",
          {
            values: [
              { owner: caller, actionRef: action },
              method === "ui/copyText" ? "ui.clipboard" : "storage.export",
            ],
          },
          { value: { ok: false } },
        );
      row(
        phase,
        "rpc",
        method,
        { principal: { kind: "plugin", owner: caller }, params: { actionRef: action } },
        {
          ok: false,
          error: {
            code: "PLUGIN_E_PERMISSION_DENIED",
            message: "A current user action is required.",
          },
        },
      );
    }
  };
  for (const phase of ["forged", "wrong-source", "wrong-generation", "expired"]) {
    const action = phase === "forged" ? id(serial++) : mint(phase).action;
    if (phase === "expired") clock += 5100;
    denied(
      phase,
      action,
      phase === "wrong-source"
        ? otherOwner
        : phase === "wrong-generation"
          ? { ...owner, generation: 2 }
          : owner,
    );
    copyFile(phase);
  }
  let replay;
  const dialogs = [];
  let renderer;
  for (const phase of ["cancel", "identity", "registered-cancel", "core", "late"]) {
    copyFile(phase);
    let action,
      job = id(serial++),
      invoked;
    if (phase === "core") {
      const reference = { actionToken: id(serial++), scope },
        target = { kind: "persistence-export", recovery: id(5) };
      action = reference.actionToken;
      row(phase, "core", "mint", { values: [scope, target] }, { value: reference });
      row(
        phase,
        "core-rpc",
        "export",
        { action: reference, recovery: target.recovery },
        { ok: true, value: { disposition: "committed" } },
      );
      row(phase, "core", "claim", { values: [reference, target] }, { value: true });
    } else {
      ({ action, invoked } = mint(phase));
      row(
        phase,
        "feature",
        "claim",
        { values: [{ owner, actionRef: action }, "storage.export"] },
        { value: { ok: true, value: { action } } },
      );
    }
    const start = clock++;
    row(
      phase,
      "device",
      "devices/list",
      { principal: { kind: "plugin", owner } },
      {
        ok: true,
        value: { sessions: [{ sessionId: id(6), recording: false, foreground: "none" }] },
      },
    );
    if (invoked) {
      row(
        phase,
        "rpc",
        "storage/exportBegin",
        { principal: { kind: "plugin", owner }, params: { actionRef: action } },
        { ok: true, value: { export: job, state: "waiting" } },
      );
      invoked.end = clock++;
      invoked.result.value.output.export = job;
    }
    if (phase === "late")
      renderer = {
        pid: 321,
        at: clock++,
        reason: "crashed",
        exitCode: 1,
        osExit: { at: clock++, code: "ESRCH" },
      };
    const end = clock++;
    dialogs.push({
      phase,
      kind: "dialog",
      method: "choose",
      start,
      end,
      args: { name: "action.txt" },
      result: { selected: phase === "cancel" ? null : current.path },
    });
    if (phase === "cancel") {
      replay = action;
      row(
        phase,
        "rpc",
        "storage/exportStatus",
        { params: { export: job } },
        { ok: true, value: { state: "cancelled" } },
      );
      denied("replay", replay);
      copyFile("replay");
    } else if (phase !== "late") {
      const destination = id(serial++);
      row(
        phase,
        "destination",
        "register",
        { action, scope, nativePath: current.path },
        { destination },
      );
      if (phase !== "registered-cancel") {
        const data = "exported";
        row(
          phase,
          "output",
          "begin",
          { job, owner, destination, sha256: hash(data), bytes: data.length },
          { returned: true },
        );
        row(
          phase,
          "output",
          "append",
          { job, data: Buffer.from(data).toString("base64") },
          data.length,
        );
        row(
          phase,
          "output",
          "commit",
          { job },
          phase === "core"
            ? {
                disposition: "committed",
                commitId: id(serial++),
                durability: "file-and-directory-sync",
              }
            : { thrown: "Destination changed" },
        );
        if (phase === "identity") {
          current = blob("replacement", 2);
          copyFile("replacement");
          files.identity.after = structuredClone(current);
          row(
            phase,
            "rpc",
            "storage/exportCommit",
            { params: { export: job } },
            {
              ok: false,
              error: { code: "PLUGIN_E_STORAGE_IO", detail: { reason: "destination-changed" } },
            },
          );
        } else {
          current = blob(data, 3);
          files.core.after = structuredClone(current);
        }
      }
      if (phase === "registered-cancel")
        row(
          phase,
          "rpc",
          "storage/exportCancel",
          { params: { export: job } },
          { ok: true, value: { disposition: "aborted" } },
        );
      row(phase, "destination", "release", { destination }, { returned: true });
      if (phase === "core")
        row(
          phase,
          "core",
          "complete",
          { values: [{ actionToken: action, scope }] },
          { value: null },
        );
    }
  }
  rows.find((r) => r.kind === "core-rpc").end = rows.find(
    (r) => r.phase === "core" && r.kind === "core" && r.method === "complete",
  ).end;
  rows.push(...dialogs);
  return {
    owner,
    otherOwner,
    scope,
    rows,
    files,
    clipboard: {
      before: "observed",
      after: "observed",
      beforeSha256: hash("observed"),
      afterSha256: hash("observed"),
      writes: [],
    },
    renderer,
  };
}
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
