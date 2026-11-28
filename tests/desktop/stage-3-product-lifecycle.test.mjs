import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cases,
  events,
  features,
  verifyLifecycleCase,
  verifyLifecycleReceipt,
} from "./stage-3-product-lifecycle-run.mjs";

// Deliberately synthetic oracle specimens, never producer output or native acceptance evidence.
function specimen(event = "provider-loss") {
  const owner = {
    pluginId: "kobrixa.sensor-lab",
    sourceKey: "builtin:kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: "host-fixture",
    processEpoch: "process-fixture",
  };
  const launch = { owner, pid: 102, sequence: 2 };
  const binding = { panelInstance: "old-panel" };
  const row = {
    schema: 1,
    id: `sensor-lab/${event}`,
    scope: "acceptance-host",
    syntheticProvider: true,
    versions: { electron: "fixture" },
    mainPid: 101,
    stage: "complete",
    failures: [],
    cleanup: { workers: 0 },
    launches: [launch],
    exits: [{ owner, sequence: 99 }],
    wire: [],
    providerTrace: [],
    native: [],
    drains: [],
    ended: [],
    lost: [],
    checkpoints: {
      idle: { sequence: 1, launches: [], providerSteps: [] },
      active: { sequence: 20, owner, binding },
      injected: { sequence: 30 },
      settled: {
        sequence: 70,
        owner,
        launches: [launch],
        reservations: [{ reservationId: "reservation", current: null }],
      },
      finished: { sequence: 90 },
    },
  };
  const rpc = (method, sequence, value, params = {}) => {
    const id = sequence;
    row.wire.push(
      { sequence, direction: "plugin-host", owner, message: { id, method, params } },
      {
        sequence: sequence + 1,
        direction: "host-plugin",
        owner,
        message: { id, result: { ok: true, value } },
      },
    );
  };
  rpc("devices/recording/reserve", 3, { reservation: { reservationId: "reservation" } });
  rpc(
    "storage/registerCheckpoint",
    5,
    { checkpoint: "checkpoint" },
    { id: "record", expectedRevision: "checkpoint-revision" },
  );
  rpc("ui/patch", 7, { revision: 2 }, { binding, baseRevision: 1, set: { phase: "active" } });
  if (["hide", "close", "blur", "minimize", "window-hide", "renderer-freeze"].includes(event)) {
    rpc("devices/recording/read", 40, { frames: [{ sequence: 1 }] });
    row.checkpoints.settled.reservations[0].current = { reservationId: "reservation" };
    if (event === "renderer-freeze") row.native.push({ event: "Debugger.paused", sequence: 31 });
  } else if (event !== "consumer-kill") {
    row.drains.push({
      sequence: 32,
      finishedSequence: 50,
      startedMonotonicMs: 100,
      finishedMonotonicMs: 500,
      offer: { owner, token: "drain-token", deadlineMonotonicMs: 10_000 },
      report: {
        state: "saved",
        blocker: false,
        records: [{ final: true, committedRevision: "revision" }],
      },
    });
    rpc(
      "storage/commitWrite",
      40,
      { record: { checkpoint: "final" } },
      { drainToken: "drain-token" },
    );
  }
  if (!["hide", "close", "blur", "minimize", "window-hide", "renderer-freeze"].includes(event))
    row.ended.push({ sequence: 31, event: { reservationId: "reservation" } });
  if (event === "consumer-kill")
    row.lost.push({
      owner,
      report: {
        state: "checkpoint-only",
        records: [{ id: "record", committedRevision: "checkpoint-revision", final: false }],
      },
    });
  if (
    [
      "provider-loss",
      "provider-disable",
      "provider-replacement",
      "feature-disable",
      "suspend-wake",
    ].includes(event)
  ) {
    row.checkpoints.beforeRestore = { sequence: 74, launches: [launch] };
    row.checkpoints.restored = { sequence: 78, launches: [launch] };
  }
  if (["renderer-crash", "window-destroyed", "feature-disable", "consumer-kill"].includes(event))
    row.exits[0].sequence = 60;
  if (["renderer-crash", "consumer-kill"].includes(event)) {
    row.checkpoints.beforeReopen = { sequence: 72, launches: [launch] };
    row.checkpoints.reopened = {
      sequence: 80,
      owner: { ...owner, generation: 2, processEpoch: "new-process" },
      binding: { panelInstance: "new-panel" },
    };
    row.checkpoints.stale = { result: { ok: false } };
    row.checkpoints.originalBinding = { result: { ok: true } };
    row.checkpoints.lateCallback = {
      sequence: 75,
      owner,
      originalSequence: 7,
      message: structuredClone(row.wire.find((r) => r.sequence === 7).message),
      result: { ok: false },
      instances: [],
    };
    row.checkpoints.explicitOpen = {
      sequence: 76,
      finishedSequence: 79,
      result: { ok: true, value: { binding: row.checkpoints.reopened.binding } },
    };
    row.launches.push({ owner: row.checkpoints.reopened.owner, sequence: 77, pid: 103 });
    row.exits.push({ owner: row.checkpoints.reopened.owner, sequence: 100 });
  }
  if (event === "close")
    row.checkpoints.reopened = { owner, binding: { panelInstance: "reopened-panel" } };
  return row;
}
const validate = (row) =>
  verifyLifecycleCase(
    row,
    cases.find((spec) => spec.id === row.id),
  );
test("W18a inventory covers each shipped consumer and lifecycle event exactly once", () => {
  assert.equal(cases.length, 49);
  assert.equal(new Set(cases.map((row) => row.id)).size, cases.length);
  for (const feature of features)
    for (const event of events)
      assert.ok(cases.some((row) => row.feature === feature && row.event === event));
});
test("synthetic oracle specimens exercise saved, background, freeze and retirement branches", () => {
  for (const event of events) validate(specimen(event));
});
const mutations = {
  "summary PASS without execution": (r) => {
    delete r.versions.electron;
  },
  "idle consumer autostart": (r) => {
    r.checkpoints.idle.launches.push(r.launches[0]);
  },
  "idle provider exchange": (r) => {
    r.checkpoints.idle.providerSteps.push("connect");
  },
  "same main/plugin PID": (r) => {
    r.launches[0].pid = r.mainPid;
  },
  "missing process exit": (r) => {
    r.exits = [];
  },
  "different healthy generation": (r) => {
    r.checkpoints.settled.owner = { ...r.checkpoints.active.owner, generation: 2 };
  },
  "consumer retired on provider loss": (r) => {
    r.exits[0].sequence = 60;
  },
  "claimed saved without drain": (r) => {
    r.drains = [];
  },
  "checkpoint-only mislabelled final": (r) => {
    r.drains[0].report.state = "checkpoint-only";
  },
  "save blocker hidden": (r) => {
    r.drains[0].report.blocker = true;
  },
  "extended original drain deadline": (r) => {
    r.drains[0].offer.deadlineMonotonicMs = 20_000;
  },
  "save after original deadline": (r) => {
    r.drains[0].finishedMonotonicMs = 10_001;
  },
  "missing reservation end": (r) => {
    r.ended = [];
  },
  "revived ended reservation": (r) => {
    r.checkpoints.settled.reservations[0].current = {};
  },
  "autostart on provider restore": (r) => {
    r.checkpoints.restored.launches = [...r.checkpoints.restored.launches, {}];
  },
  "missing original commit reply": (r) => {
    r.wire = r.wire.filter((w) => w.sequence !== 41);
  },
  "foreign drain token": (r) => {
    r.wire.find((w) => w.message.method === "storage/commitWrite").message.params.drainToken =
      "foreign";
  },
  "replayed reservation": (r) => {
    const pair = structuredClone(r.wire.slice(0, 2));
    pair[0].sequence = 52;
    pair[1].sequence = 53;
    pair[0].message.id = pair[1].message.id = 52;
    r.wire.push(...pair);
  },
  "foreign owner reply": (r) => {
    r.wire.find((w) => w.sequence === 41).owner = {
      ...r.launches[0].owner,
      processEpoch: "foreign",
    };
  },
  "duplicate reply": (r) => {
    const row = structuredClone(r.wire.find((w) => w.sequence === 41));
    row.sequence++;
    r.wire.push(row);
  },
};
for (const [name, mutate] of Object.entries(mutations))
  test(`rejects ${name}`, () => {
    const row = specimen();
    mutate(row);
    assert.throws(() => validate(row));
  });
test("renderer retirement must save before exit", () => {
  const row = specimen("renderer-crash");
  row.exits[0].sequence = 49;
  assert.throws(() => validate(row), /Save precedes/);
});
test("reload cannot create new processes before explicit open", () => {
  const row = specimen("renderer-crash");
  row.checkpoints.beforeReopen.launches.push({});
  assert.throws(() => validate(row), /Reload cannot/);
});
test("old binding cannot revive", () => {
  const row = specimen("renderer-crash");
  row.checkpoints.stale.result.ok = true;
  assert.throws(() => validate(row), /Old binding/);
});
test("stale probe must have worked before retirement", () => {
  const row = specimen("renderer-crash");
  row.checkpoints.originalBinding.result.ok = false;
  assert.throws(() => validate(row), /worked before/);
});
test("late callback must use original accepted bytes and cannot revive status", () => {
  for (const change of [
    (row) => {
      row.checkpoints.lateCallback.message.params.baseRevision++;
    },
    (row) => {
      row.checkpoints.lateCallback.instances.push({ kind: "status" });
    },
  ]) {
    const row = specimen("renderer-crash");
    change(row);
    assert.throws(() => validate(row));
  }
});
test("consumer kill cannot be relabelled as final save", () => {
  const row = specimen("consumer-kill");
  row.lost[0].report.state = "saved";
  assert.throws(() => validate(row), /committed checkpoint/);
});
test("new open must have a new process and panel identity", () => {
  const row = specimen("renderer-crash");
  row.checkpoints.reopened.owner = row.checkpoints.active.owner;
  assert.throws(() => validate(row));
});
test("freeze cannot be a resumed renderer", () => {
  const row = specimen("renderer-freeze");
  row.native.push({ event: "Debugger.resumed", sequence: 50 });
  assert.throws(() => validate(row));
});
test("background continuation needs original nonempty frames", () => {
  const row = specimen("hide");
  row.wire.find((w) => w.sequence === 41).message.result.value.frames = [];
  assert.throws(() => validate(row), /background frames/);
});
test("partial selections and duplicate case ids cannot close W18a", () => {
  assert.throws(
    () => verifyLifecycleReceipt({ schema: 1, scope: "W18a", results: [] }),
    /partial selection/,
  );
  assert.throws(() =>
    verifyLifecycleReceipt({
      schema: 1,
      scope: "W18a",
      results: Array.from({ length: cases.length }, () => specimen()),
    }),
  );
});
const receipt = process.env.STAGE3_PRODUCT_LIFECYCLE_RECEIPT;
test(
  "native W18a receipt (requires executed Electron producer)",
  {
    skip: receipt
      ? false
      : "NOT RUN: set STAGE3_PRODUCT_LIFECYCLE_RECEIPT to the native receipt.json",
  },
  async () => {
    assert.equal(verifyLifecycleReceipt(JSON.parse(await readFile(receipt, "utf8"))), cases.length);
  },
);

function coldSpecimen(event) {
  const row = specimen();
  row.id = event;
  row.launches = [];
  row.exits = [];
  row.wire = [];
  row.checkpoints.seedMarker = {
    rendererUnresponsive: event === "renderer-unclean",
    thirdPartyUiContributions: event === "third-party-unclean",
    thirdPartyRunning: false,
  };
  row.checkpoints.finished = {
    sequence: 90,
    state: {
      safeMode: !["all-off", "optional-unclean"].includes(event),
      plugins: [
        ...["kobrixa.basic-plus", "kobrixa.ev3"].map((id) => ({
          id,
          required: true,
          enabled: true,
        })),
        ...features.map((feature) => ({ id: `kobrixa.${feature}`, enabled: event !== "all-off" })),
      ],
    },
    launches: [],
    providerSteps: [],
    providersCreated: 0,
    catalog: { entries: [] },
    importGates: [],
  };
  return row;
}
test("cold risk marker fixtures are distinct and suppression retains required compilers", () => {
  for (const event of [
    "cold-safe",
    "all-off",
    "optional-unclean",
    "renderer-unclean",
    "third-party-unclean",
  ])
    validate(coldSpecimen(event));
});
for (const [name, mutate] of Object.entries({
  "hidden provider construction": (row) => {
    row.checkpoints.finished.providersCreated = 1;
  },
  "optional import despite suppression": (row) => {
    row.checkpoints.finished.importGates.push({ phase: "freeze" });
  },
  "required compiler disabled": (row) => {
    row.checkpoints.finished.state.plugins[0].enabled = false;
  },
  "all-off switch lost": (row) => {
    row.checkpoints.finished.state.plugins[2].enabled = true;
  },
}))
  test(`cold startup rejects ${name}`, () => {
    const row = coldSpecimen("all-off");
    mutate(row);
    assert.throws(() => validate(row));
  });
test("optional-only marker must not be turned into global safe mode", () => {
  const row = coldSpecimen("optional-unclean");
  row.checkpoints.finished.state.safeMode = true;
  assert.throws(() => validate(row));
});
test("replay after restoration is still rejected", () => {
  const row = specimen();
  const pair = structuredClone(row.wire.slice(0, 2));
  pair[0].sequence = 85;
  pair[1].sequence = 86;
  pair[0].message.id = pair[1].message.id = 85;
  row.wire.push(...pair);
  assert.throws(() => validate(row), /No replay through restoration/);
});
