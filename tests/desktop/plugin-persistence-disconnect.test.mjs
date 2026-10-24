import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDisconnectObservation,
  cleanupDisconnect,
  produceDisconnectRetry,
} from "./plugin-persistence-disconnect.ts";
import { build } from "esbuild";
const compiled = await build({
  entryPoints: ["apps/desktop/src/main/plugins/core-recovery.ts"],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const { createCoreActionLedger, CoreRecovery } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);

// Validator specimens only. No synthetic object is passed off as native evidence.
function specimen() {
  const owner = {
    sourceKey: "source",
    pluginId: "plugin",
    generation: 1,
    hostEpoch: "host",
    processEpoch: "process",
  };
  const scope = { hostEpoch: "host", workbenchInstance: "window" };
  const action = { actionToken: "retry", scope };
  const target = { kind: "persistence-retry", recovery: "recovery" };
  const names = ["prior", "current"];
  const reservations = names.map((name) => ({ reservationId: name, sessionId: `${name}-session` }));
  const checkpoints = names.map((name, i) => ({
    checkpoint: `${name}-checkpoint`,
    record: { id: name },
    document: { binding: { ...reservations[i], owner }, record: { id: name } },
  }));
  const requests = names.map((name, i) => ({
    at: 2,
    request: {
      token: "grant",
      remainingMs: 98,
      writes: [{ id: name, write: name, state: "sealed" }],
      checkpoints: [
        {
          checkpoint: checkpoints[i].checkpoint,
          record: { id: name },
          reservationEnd: { reservationId: name },
        },
      ],
    },
  }));
  const offers = requests.map(({ request }) => ({
    owner,
    token: request.token,
    deadlineMonotonicMs: 100,
    checkpoints: request.checkpoints,
  }));
  const payload = {
    kind: "test.registration-end",
    schemaVersion: 1,
    label: "Final recording",
    mediaType: "application/octet-stream",
    byteLength: 64,
    sha256: "a".repeat(64),
  };
  const ticket = (id) => ({
    id,
    owner,
    target: { kind: "record", id, expectedRevision: `${id}-revision` },
    metadata: {
      kind: "record",
      record: { ...payload, id, checkpoint: "final", revision: `${id}-revision` },
    },
  });
  const report = {
    state: "saved",
    blocker: false,
    records: names.map((id) => ({ id, final: true, committedRevision: `${id}-revision` })),
    errors: [],
  };
  const committed = (id) => ({ disposition: "committed", receipt: { revision: `${id}-revision` } });
  const retry = { at: 5, wall: 500, action, report };
  const disconnectActions = ["disconnect", "disconnect-again"].map((actionToken) => ({
    actionToken,
    scope,
  }));
  const disconnectTarget = { kind: "device-disconnect", sessionId: reservations[1].sessionId };
  return {
    scope: "host-adapter",
    reservations,
    checkpoints,
    staged: names.map((id, i) => ({
      ...reservations[i],
      checkpoint: checkpoints[i].checkpoint,
      id,
      write: id,
      token: "grant",
      at: 1,
    })),
    retryDrain: { offer: structuredClone(offers[0]), at: 6, report, callbacks: 0 },
    grantProbes: names.map((id, i) => ({
      params: {
        ...payload,
        target: { mode: "replace", id, expectedRevision: `${id}-revision` },
        checkpoint: { handle: checkpoints[i].checkpoint, phase: "final" },
        drainToken: "grant",
      },
      result: { ok: false, error: { code: "PLUGIN_E_STALE_RESOURCE" } },
      at: 6,
      ended: 7,
      recordAfter: ticket(id).metadata.record,
      ticketsBefore: [],
      ticketsAfter: [],
    })),
    retryDispatches: [{ recovery: "recovery", ...retry }],
    motion: {
      operationId: "motion",
      sessionId: "current-session",
      atDisconnect: {
        operationId: "motion",
        sessionId: "current-session",
        startAccepted: true,
        stage: "running",
        stopRequested: false,
      },
    },
    ended: reservations.map((reservation, i) => ({
      ...reservation,
      owner,
      reason: i === 0 ? "disconnected" : "released",
      drain: { owner, reservationId: reservation.reservationId, expiresMonotonicMs: 100 },
    })),
    offers,
    requests,
    sdkDrains: requests.map(({ request }) => ({
      request: structuredClone(request),
      result: { ok: true },
    })),
    finalAdmissions: names.map((id, i) => ({
      ticket: ticket(id),
      at: 1,
      params: {
        ...payload,
        drainToken: "grant",
        target: { mode: "replace", id, expectedRevision: `${id}-revision` },
        checkpoint: { handle: checkpoints[i].checkpoint, phase: "final" },
      },
      result: { ok: true, value: { write: id, id } },
    })),
    reports: [report, { state: "retryable", blocker: true }],
    publications: [
      { ticket: ticket("prior"), at: 3, result: { disposition: "not-committed" } },
      { ticket: ticket("current"), at: 4, result: committed("current") },
      {
        ticket: ticket("prior"),
        at: 6,
        result: committed("prior"),
        retryDeadline: 100,
        retryPin: "pin",
      },
    ],
    fault: [
      { point: "before-publish", ticket: "prior" },
      ...names.map((ticket) => ({ point: "after-publish", ticket })),
    ],
    failed: {
      id: "recovery",
      ticket: ticket("prior"),
      sealedPin: "pin",
      expiresAt: 1000,
      report: { state: "retryable", blocker: true },
    },
    recovered: {
      id: "recovery",
      ticket: ticket("prior"),
      sealedPin: null,
      expiresAt: 1000,
      report,
    },
    snapshot: { items: [{ id: "recovery", state: "retryable" }] },
    retry,
    actions: [
      { kind: "mint", action: disconnectActions[0], target: disconnectTarget },
      { kind: "mint", action, target },
      { kind: "claim", action, target, accepted: true },
      { kind: "mint", action: disconnectActions[1], target: disconnectTarget },
      ...disconnectActions.map((action) => ({
        kind: "claim",
        action,
        target: disconnectTarget,
        accepted: true,
      })),
    ],
    flushes: [{ at: 7, tickets: names.map(ticket), result: { state: "saved", accepted: names } }],
    disconnects: [8],
    events: [
      ["quiesce", 1],
      ["stop-confirmed", 2],
      ["journal-confirmed", 2],
      ["save-failed", 3],
      ["save-confirmed", 7],
      ["disconnect", 8],
    ].map(([kind, time]) => ({ kind, time, turn: time })),
    providerTrace: ["stop", "readback"].map((step) => ({
      step,
      operationId: "motion",
      dispatch: "sent",
    })),
    exits: [],
    ownerBefore: owner,
    ownerAfter: structuredClone(owner),
    oldReservationResults: [{ ok: false }, { ok: false }],
    blocked: true,
    journalCommits: [
      {
        at: 2,
        document: {
          entries: [
            {
              operationId: "motion",
              sessionId: "current-session",
              state: "resolved",
              stopConfirmation: "confirmed",
            },
          ],
        },
      },
    ],
    stops: [
      {
        at: 2,
        result: { stopConfirmation: "confirmed", error: null, value: { programStopped: true } },
      },
    ],
    coordinatorCalls: [
      { kind: "disconnect", args: ["current-session", disconnectActions[0]] },
      { kind: "reconcile", args: ["recovery", report] },
      { kind: "disconnect", args: ["current-session", disconnectActions[1]] },
    ],
  };
}
test("validator specimen is internally consistent, not a native receipt", () =>
  assertDisconnectObservation(specimen()));
for (const field of [
  "reports",
  "providerTrace",
  "ended",
  "offers",
  "reservations",
  "checkpoints",
  "staged",
  "retryDrain",
  "grantProbes",
  "retryDispatches",
  "motion",
  "sdkDrains",
  "finalAdmissions",
  "scope",
  "requests",
  "publications",
  "fault",
  "failed",
  "recovered",
  "snapshot",
  "retry",
  "actions",
  "flushes",
  "disconnects",
  "events",
  "exits",
  "ownerAfter",
  "oldReservationResults",
  "blocked",
  "journalCommits",
  "stops",
  "coordinatorCalls",
]) {
  test(`rejects missing ${field}`, () => {
    const o = specimen();
    delete o[field];
    assert.throws(() => assertDisconnectObservation(o));
  });
}
for (const [name, mutate] of [
  ["checkpoint-only target substitute", (o) => o.requests.forEach((r) => (r.request.writes = []))],
  ["missing provider dispatch", (o) => (o.providerTrace = [])],
  ["invented journal event", (o) => (o.journalCommits[0].at = 999)],
  ["renewed TTL", (o) => o.recovered.expiresAt++],
  ["renewed grant", (o) => (o.retryDrain.offer.token = "replacement")],
  [
    "same session relabelled as prior",
    (o) => (o.reservations[0].sessionId = o.reservations[1].sessionId),
  ],
  ["wrong host-held write", (o) => (o.staged[0].write = "unrelated")],
  ["missing actual SDK dispatch", (o) => (o.sdkDrains = [])],
  ["renewed final admission", (o) => (o.finalAdmissions[0].params.drainToken = "new-grant")],
  ["missing grant probe", (o) => (o.grantProbes = [])],
  [
    "foreign checkpoint owner",
    (o) => (o.checkpoints[0].document.binding.owner = { ...o.ownerBefore, hostEpoch: "foreign" }),
  ],
  ["wrong grant probe revision", (o) => (o.grantProbes[0].params.target.expectedRevision = "old")],
  [
    "grant probe mutated record",
    (o) => (o.grantProbes[0].recordAfter = { ...o.grantProbes[0].recordAfter, revision: "new" }),
  ],
  ["probe after expiry", (o) => (o.grantProbes[0].ended = 101)],
  ["revived grant", (o) => (o.grantProbes[0].result = { ok: true })],
  ["wrong retry pin", (o) => (o.publications[2].retryPin = "new-pin")],
  ["retry callback renewal", (o) => o.retryDrain.callbacks++],
  ["late retry", (o) => (o.retry.at = 100)],
  [
    "foreign recovery claim",
    (o) => (o.actions[2].target = { kind: "persistence-retry", recovery: "other" }),
  ],
  ["replayed action", (o) => (o.actions[3].action.actionToken = "retry")],
  ["unclaimed retry", (o) => (o.actions[2].accepted = false)],
  ["early disconnect", (o) => (o.disconnects[0] = 0)],
  ["duplicate publication", (o) => o.publications.push(o.publications[2])],
  ["unrelated worker receipt", (o) => (o.fault[1].ticket = "unrelated")],
  ["missing prior session", (o) => o.requests.shift()],
  ["source restart", (o) => o.ownerAfter.generation++],
  ["source exit", (o) => o.exits.push({ code: 0 })],
  ["revived rights", (o) => (o.oldReservationResults[0].ok = true)],
  ["unconfirmed stop", (o) => (o.stops[0].result.stopConfirmation = "unconfirmed")],
  ["forged reconciliation", (o) => (o.coordinatorCalls[1].args[1] = { state: "saved" })],
])
  test(`rejects ${name}`, () => {
    const o = specimen();
    mutate(o);
    assert.throws(() => assertDisconnectObservation(o));
  });

test("missing trusted core route rejects before source/resource access", async () => {
  await assert.rejects(produceDisconnectRetry({}), /original trusted core Disconnect route/);
});

test("actual production action ledger rejects replay/foreign target and cleanup releases all actions after an error", async () => {
  let now = 1;
  const scope = { hostEpoch: "host", workbenchInstance: "window" };
  const ledger = createCoreActionLedger({
    now: () => now,
    current: (s) =>
      s.hostEpoch === scope.hostEpoch && s.workbenchInstance === scope.workbenchInstance,
  });
  const target = { kind: "persistence-retry", recovery: "recovery" };
  const first = ledger.mint(scope, target),
    second = ledger.mint(scope, target);
  assert.notEqual(first.actionToken, second.actionToken);
  assert.equal(ledger.claim(first, { ...target, recovery: "forged" }), false);
  assert.equal(ledger.claim(first, target), true);
  assert.equal(ledger.claim(first, target), false);
  now = 6000;
  assert.equal(ledger.claim(second, target), false);
  const order = [];
  const failure = new Error("release failed");
  const errors = await cleanupDisconnect([
    () => {
      order.push("first");
      ledger.complete(first);
    },
    () => {
      order.push("error");
      throw failure;
    },
    () => {
      order.push("second");
      ledger.complete(second);
    },
  ]);
  assert.deepEqual(errors, [failure]);
  assert.deepEqual(order, ["second", "error", "first"]);
  assert.equal(ledger.count(), 0);
  assert.equal(ledger.isClaimed(first, target), false);
});

test("failure cleanup unsubscribes an actual core recovery observer and restores the production ledger method", async () => {
  const scope = { hostEpoch: "host", workbenchInstance: "window" };
  const actions = createCoreActionLedger({ now: () => 1, current: () => true });
  const recovery = new CoreRecovery({
    scope: () => scope,
    entries: () => [],
    actions,
    now: () => 1,
    openDetail: () => {},
  });
  let notifications = 0;
  const off = recovery.onChanged(() => notifications++);
  const mint = actions.mint;
  actions.mint = function (...args) {
    return mint.apply(this, args);
  };
  recovery.changed();
  assert.equal(notifications, 1);
  const errors = await cleanupDisconnect([
    off,
    () => {
      actions.mint = mint;
    },
    async () => {
      throw new Error("worker settlement failed");
    },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(actions.mint, mint);
  recovery.changed();
  assert.equal(notifications, 1);
});

import { assertDisconnectEvidence } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
function evidence() {
  const disconnect = specimen();
  return {
    disconnect,
    events: disconnect.events,
    samples: {},
    checks: {
      disconnectsBeforeSaved: 0,
      failedSaveBlocker: true,
      retriesWithFreshAction: 1,
      finalTargets: 2,
      finalPublications: 2,
      priorSessionIncluded: true,
      firstDeadline: 100,
      lastDeadline: 100,
    },
  };
}
test("outside checker binds disconnect summary to its original observations", () =>
  assertDisconnectEvidence(evidence()));
test("runner selects the concrete case and rejects ambiguous selection", () => {
  assert.deepEqual(selectFoundationCases({ caseId: "disconnect-retry" }), ["disconnect-retry"]);
  assert.throws(() => selectFoundationCases({ caseId: "disconnect-retry", referencesOnly: true }));
});
for (const key of Object.keys(evidence().checks))
  test(`outside checker rejects detached ${key}`, () => {
    const e = evidence();
    e.checks[key] = typeof e.checks[key] === "boolean" ? !e.checks[key] : e.checks[key] + 1;
    assert.throws(() => assertDisconnectEvidence(e));
  });
for (const [name, mutate] of [
  [
    "wrong trusted disconnect session",
    (e) => (e.disconnect.coordinatorCalls[0].args[0] = "prior-session"),
  ],
  ["detached events", (e) => (e.events = [])],
  [
    "unrelated journal",
    (e) => (e.disconnect.journalCommits[0].document.entries[0].operationId = "foreign"),
  ],
  ["unrelated provider stop", (e) => (e.disconnect.providerTrace[0].operationId = "foreign")],
  [
    "missing final recovery revision",
    (e) => (e.disconnect.retryDrain.report.records[0].committedRevision = "foreign"),
  ],
  ["duplicate worker publication", (e) => e.disconnect.fault.push(e.disconnect.fault[1])],
  ["UI click relabel", (e) => (e.disconnect.scope = "native-click")],
])
  test(`outside checker rejects ${name}`, () => {
    const e = evidence();
    mutate(e);
    assert.throws(() => assertDisconnectEvidence(e));
  });

// Concrete counterexamples from the B2 review: mutate correlated evidence together.
for (const [name, mutate] of [
  [
    "both retained tickets have a foreign owner",
    (o) => {
      for (const recovery of [o.failed, o.recovered])
        recovery.ticket.owner = { ...o.ownerBefore, sourceKey: "foreign" };
    },
  ],
  [
    "both retained tickets have a foreign record",
    (o) => {
      for (const recovery of [o.failed, o.recovered]) {
        recovery.ticket.target.id = "foreign";
        recovery.ticket.metadata.record.id = "foreign";
      }
    },
  ],
  [
    "receipt and report agree on a revision absent from metadata",
    (o) => {
      o.publications[2].result.receipt.revision = "foreign";
      o.retryDrain.report.records[0].committedRevision = "foreign";
    },
  ],
  [
    "actual grant expires before retained offer",
    (o) => {
      o.ended[0].drain.expiresMonotonicMs = 4;
    },
  ],
  [
    "publication completes after disconnect",
    (o) => {
      o.publications[2].at = 9;
    },
  ],
  [
    "flush completes before publication",
    (o) => {
      o.flushes[0].at = 5;
    },
  ],
  [
    "publication ticket metadata differs from admission",
    (o) => {
      o.publications[2].ticket.metadata.record.label = "foreign";
    },
  ],
  [
    "flush captures a different ticket with the same ID",
    (o) => {
      o.flushes[0].tickets[0].target.id = "foreign";
    },
  ],
  [
    "save event precedes successful flush",
    (o) => {
      o.events.find((row) => row.kind === "save-confirmed").time = 6;
    },
  ],
]) {
  test(`outside checker rejects review mutant: ${name}`, () => {
    const e = evidence();
    mutate(e.disconnect);
    assert.throws(() => assertDisconnectEvidence(e));
  });
}

// Execute the original fixture callback with SDK registration intercepted. These
// are callback contract tests, not a live SDK/record-service or native receipt.
const fixtureBundle = await build({
  stdin: {
    contents: `import "./tests/desktop/fixtures/plugin-persistence/consumer.ts";
      export { captured as default } from "@kobrixa/plugin-sdk";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  plugins: [
    {
      name: "capture-fixture-registration",
      setup(build) {
        build.onResolve({ filter: /^@kobrixa\/plugin-sdk$/ }, () => ({
          path: "sdk",
          namespace: "fixture-test",
        }));
        build.onLoad({ filter: /.*/, namespace: "fixture-test" }, () => ({
          contents: `export let captured;
          export const definePlugin = (plugin) => plugin;
          export async function runPlugin(plugin) { captured = plugin; }`,
        }));
      },
    },
  ],
});
const { default: fixture } = await import(
  `data:text/javascript;base64,${Buffer.from(fixtureBundle.outputFiles[0].text).toString("base64")}`
);
function fixtureDrain({
  status = "sealed",
  commitError = "PLUGIN_E_STORAGE_IO",
  flushError = "PLUGIN_E_STORAGE_CONFLICT",
  held = true,
} = {}) {
  const calls = [];
  const ok = (value) => ({ ok: true, value });
  const error = (code) => ({ ok: false, error: { code } });
  const request = {
    token: "original-grant",
    checkpoints: held
      ? ["prior", "current"].map((id) => ({
          checkpoint: `${id}-checkpoint`,
          record: { id, kind: "test.registration-end" },
        }))
      : [],
    writes: held
      ? ["prior", "current"].map((id) => ({
          id,
          write: `${id}-held-write`,
          state: "sealed",
        }))
      : [],
  };
  const storage = {
    async commitWrite(params) {
      calls.push(["commitWrite", params]);
      return params.write === "prior-held-write" ? error(commitError) : ok({});
    },
    async writeStatus(params) {
      calls.push(["writeStatus", params]);
      return ok({ state: status });
    },
    async flush(params) {
      calls.push(["flush", params]);
      return flushError ? error(flushError) : ok({});
    },
  };
  return { calls, run: () => fixture.drain({ request, storage }) };
}
test("fixture reconciles the original failed held write before committing the other final and flushing", async () => {
  const f = fixtureDrain();
  assert.deepEqual(await f.run(), {
    ok: true,
    value: { status: "submitted", writes: ["current-held-write"] },
  });
  assert.deepEqual(f.calls, [
    ["commitWrite", { write: "prior-held-write", drainToken: "original-grant" }],
    ["writeStatus", { write: "prior-held-write" }],
    ["commitWrite", { write: "current-held-write", drainToken: "original-grant" }],
    ["flush", {}],
  ]);
});
for (const status of ["unknown", "committed"])
  test(`fixture rejects reconciliation to ${status} instead of sealed`, async () => {
    const f = fixtureDrain({ status });
    await assert.rejects(f.run());
    assert.deepEqual(
      f.calls.map(([method]) => method),
      ["commitWrite", "writeStatus"],
    );
  });
test("fixture rejects an unexpected commit error before reconciliation", async () => {
  const f = fixtureDrain({ commitError: "PLUGIN_E_STORAGE_CONFLICT" });
  await assert.rejects(f.run());
  assert.deepEqual(
    f.calls.map(([method]) => method),
    ["commitWrite"],
  );
});
test("fixture rejects flush I/O failure even with held writes", async () => {
  await assert.rejects(fixtureDrain({ flushError: "PLUGIN_E_STORAGE_IO" }).run());
});
test("fixture requires successful flush when no held writes exist", async () => {
  await assert.rejects(fixtureDrain({ held: false }).run());
  assert.deepEqual(await fixtureDrain({ held: false, flushError: null }).run(), {
    ok: true,
    value: { status: "submitted", writes: [] },
  });
});

test("ordinary oracle gate explicitly includes the disconnect regression file", async () => {
  const { readFile } = await import("node:fs/promises");
  const { scripts } = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.ok(
    scripts["test:persistence:oracles"]
      .split(/\s+/)
      .includes("tests/desktop/plugin-persistence-disconnect.test.mjs"),
  );
  for (const name of ["test", "test:desktop", "test:ci"])
    assert.ok(scripts[name].includes("pnpm test:persistence:oracles"), name);
});
for (const [name, mutate] of [
  ["admission payload differs from ticket", (o) => o.finalAdmissions[0].params.byteLength++],
  [
    "admission revision differs from ticket",
    (o) => {
      o.finalAdmissions[0].params.target.expectedRevision = "foreign";
    },
  ],
  [
    "original grant belongs to another reservation",
    (o) => {
      o.ended[0].drain.reservationId = "foreign";
    },
  ],
])
  test(`outside checker rejects ${name}`, () => {
    const e = evidence();
    mutate(e.disconnect);
    assert.throws(() => assertDisconnectEvidence(e));
  });

test("SDK dispatch may shorten a fractional budget but cannot renew or erase it", () => {
  const observation = specimen();
  observation.requests[0].request.remainingMs = 98.75;
  observation.sdkDrains[0].request.remainingMs = 97;
  assert.doesNotThrow(() => assertDisconnectObservation(observation));
  for (const remainingMs of [99, 0, -1, NaN, Infinity]) {
    observation.sdkDrains[0].request.remainingMs = remainingMs;
    assert.throws(() => assertDisconnectObservation(observation));
  }
});
