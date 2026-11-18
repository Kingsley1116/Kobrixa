import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  assertSingleInstanceReceipt,
  SINGLE_INSTANCE_UNRUN,
} from "./builtin-process-installed.mjs";

// Synthetic fixtures only test the verifier. They are never installed evidence.
function fixture() {
  const hash = "a".repeat(64),
    profile = "/temporary/original-profile",
    marker = "--b2-secondary=00000000-0000-4000-8000-000000000001";
  const state = {
    plugins: [
      { id: "kobrixa.basic-plus", required: true, status: "enabled" },
      { id: "kobrixa.ev3", required: true, status: "enabled" },
      { id: "kobrixa.motor-test", running: true },
    ],
  };
  const forks = [{ serviceName: "Kobrixa plugin kobrixa.motor-test", pid: 103, exited: false }];
  const workerStarts = [
    { worker: 0, event: "construct", arguments: ["/product/persistence-worker.cjs"] },
  ];
  const before = {
    pid: 101,
    windowId: 1,
    profile,
    focused: true,
    at: 1,
    state,
    forks,
    workerStarts,
    binding: { processEpoch: "original" },
  };
  return {
    kind: "installed-single-instance-partial",
    status: "partial",
    syntheticHost: false,
    isolated: true,
    unrun: [...SINGLE_INSTANCE_UNRUN],
    originalPayloadIntact: true,
    originalAppAsarIntact: true,
    copiedAppAsarIntact: true,
    originalExecutableIntact: true,
    noPathNode: true,
    noNodePath: true,
    arbitraryCwd: true,
    artifact: { appAsarSha256: hash, originalExecutableSha256: hash, payloadIndexSha256: hash },
    runs: [
      {
        name: "single-instance",
        pid: 101,
        profile,
        identity: { cwd: "/unrelated", packaged: true, userData: profile },
        probeBeforeReady: true,
        observedPids: [101, 103],
        workerTimeline: [...workerStarts, { worker: 0, event: "exit", code: 0 }],
        forks: [{ ...forks[0], exited: true }],
        gracefulQuit: true,
        forcedCleanup: false,
        probeRestored: true,
        exit: { code: 0, signal: null },
        remainingPids: [],
        isolation: { source: "EACCES", dependency: "EACCES", network: "EPERM" },
        fiveSecondCleanup: { startedAt: 1000, endedAt: 6000, remainingPids: [] },
        singleInstance: {
          listenersRemoved: true,
          before: structuredClone(before),
          after: { ...structuredClone(before), at: 10 },
          defocused: { focused: false, at: 2 },
          events: [
            { kind: "focus", windowId: 1, at: 3 },
            {
              kind: "second-instance",
              argv: [`--user-data-dir=${profile}`, marker],
              cwd: "/unrelated",
              at: 4,
            },
          ],
          hashes: {
            before: { asar: hash, executable: hash },
            after: { asar: hash, executable: hash },
          },
          secondary: {
            startup: { pid: 102, ready: false },
            observedIdentities: [{ pid: 102, created: "original-secondary" }],
            observation: {
              phase: "exit",
              pid: 102,
              beforeReady: true,
              code: 0,
              workers: [],
              utilities: [],
              children: [],
              writes: [],
              locks: [{ acquired: false }],
            },
            requestedProfile: profile,
            pid: 102,
            marker,
            argv: [`--user-data-dir=${profile}`, marker],
            exit: { code: 0, signal: null, at: 100 },
            forcedCleanup: false,
            remainingPids: [],
            observedPids: [102],
            cleanupObservedAt: 5100,
            logSha256: hash,
          },
        },
      },
    ],
  };
}
test("Observed startup subset remains partial with recording continuity unrun", () =>
  assertSingleInstanceReceipt(fixture()));
const bad = {
  "unobserved startup": (r) => delete r.runs[0].singleInstance.secondary.startup,
  "late observation": (r) => (r.runs[0].singleInstance.secondary.observation.beforeReady = false),
  "missing birth identity": (r) => (r.runs[0].singleInstance.secondary.observedIdentities = []),
  "secondary acquired lock": (r) =>
    (r.runs[0].singleInstance.secondary.observation.locks[0].acquired = true),
  "secondary worker": (r) =>
    r.runs[0].singleInstance.secondary.observation.workers.push({ api: "Worker" }),
  "secondary provider/plugin": (r) =>
    r.runs[0].singleInstance.secondary.observation.utilities.push({ api: "fork" }),
  "secondary child": (r) =>
    r.runs[0].singleInstance.secondary.observation.children.push({ api: "spawn" }),
  "secondary profile write": (r) =>
    r.runs[0].singleInstance.secondary.observation.writes.push({ api: "writeFile" }),
  "full-pass promotion": (r) => (r.status = "passed"),
  "missing unrun coverage": (r) => r.unrun.pop(),
  nonisolated: (r) => (r.isolated = false),
  "archive changed": (r) => (r.copiedAppAsarIntact = false),
  "same process": (r) => (r.runs[0].singleInstance.secondary.pid = 101),
  "different profile": (r) => (r.runs[0].singleInstance.secondary.requestedProfile = "/other"),
  "missing profile argument": (r) => r.runs[0].singleInstance.secondary.argv.shift(),
  "foreign second-instance": (r) => r.runs[0].singleInstance.events[1].argv.pop(),
  "no second-instance": (r) => r.runs[0].singleInstance.events.pop(),
  "duplicate event": (r) =>
    r.runs[0].singleInstance.events.push(r.runs[0].singleInstance.events[1]),
  "already focused": (r) => (r.runs[0].singleInstance.defocused.focused = true),
  "no focus event": (r) => r.runs[0].singleInstance.events.shift(),
  "wrong window": (r) => (r.runs[0].singleInstance.after.windowId = 2),
  "primary restart": (r) => (r.runs[0].singleInstance.after.pid = 109),
  "plugin restart": (r) => (r.runs[0].singleInstance.after.forks[0].pid = 109),
  "binding replacement": (r) => (r.runs[0].singleInstance.after.binding.processEpoch = "new"),
  "worker restarted": (r) => r.runs[0].singleInstance.after.workerStarts.push({ worker: 2 }),
  "missing worker exit": (r) => r.runs[0].workerTimeline.pop(),
  "secondary failed": (r) => (r.runs[0].singleInstance.secondary.exit.code = 1),
  "secondary killed": (r) => (r.runs[0].singleInstance.secondary.forcedCleanup = true),
  "primary killed": (r) => (r.runs[0].forcedCleanup = true),
  "early secondary cleanup": (r) => (r.runs[0].singleInstance.secondary.cleanupObservedAt = 1000),
  "early primary cleanup": (r) => (r.runs[0].fiveSecondCleanup.endedAt = 2000),
  "secondary survivor": (r) => r.runs[0].singleInstance.secondary.remainingPids.push(108),
  "primary survivor": (r) => r.runs[0].fiveSecondCleanup.remainingPids.push(108),
  "listeners leak": (r) => (r.runs[0].singleInstance.listenersRemoved = false),
  "image drift": (r) => (r.runs[0].singleInstance.hashes.after.executable = "b".repeat(64)),
  "source readable": (r) => (r.runs[0].isolation.source = "READABLE"),
};
for (const [name, mutate] of Object.entries(bad))
  test(`Reject ${name}`, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => assertSingleInstanceReceipt(r));
  });
test(
  "Controller partial receipt retains original evidence",
  { skip: !process.env.KOBRIXA_SINGLE_INSTANCE_REPORT && "controller native execution required" },
  async () => {
    const report = JSON.parse(await readFile(process.env.KOBRIXA_SINGLE_INSTANCE_REPORT, "utf8"));
    if (report.kind === "installed-single-instance-recording") {
      const { verifyContinuity } = await import("./ev3-uhid-continuity.mjs");
      const result = await verifyContinuity(process.env.KOBRIXA_SINGLE_INSTANCE_REPORT);
      for (const [key, value] of Object.entries(result)) assert.deepEqual(report[key], value);
      return;
    }
    assertSingleInstanceReceipt(report);
    const { createHash } = await import("node:crypto");
    const secondary = report.runs[0].singleInstance.secondary;
    assert.equal(
      createHash("sha256")
        .update(await readFile(secondary.log))
        .digest("hex"),
      secondary.logSha256,
    );
  },
);

// Protocol-shaped unit inputs. All bytes and process identities here are synthetic.
test("independent recording validator reopens raw files and rejects corrupt joins", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { randomUUID, createHash } = await import("node:crypto");
  const { verifyContinuity, measureResumeWindow } = await import("./ev3-uhid-continuity.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "p4-validator-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const digest = (b) => createHash("sha256").update(b).digest("hex");
  const r = fixture(),
    run = r.runs[0],
    obs = run.singleInstance,
    secondary = obs.secondary;
  r.kind = "installed-single-instance-recording";
  r.blockers = [];
  r.copiedExecutableSha256 = r.artifact.originalExecutableSha256;
  run.identity.appPath = "/copy/resources/app.asar";
  const uid = randomUUID,
    name = "P4-" + uid(),
    storageId = uid(),
    sessionId = uid(),
    reservationId = uid();
  const owner = {
    pluginId: "kobrixa.sensor-lab",
    sourceKey: "builtin:kobrixa.sensor-lab",
    generation: 1,
    hostEpoch: uid(),
    processEpoch: uid(),
  };
  const binding = {
    generation: 1,
    hostEpoch: owner.hostEpoch,
    processEpoch: owner.processEpoch,
    kind: "panel",
    contributionId: "kobrixa.sensor-lab.panel",
    panelInstance: uid(),
    uiResourceGeneration: 1,
  };
  const channel = {
    kind: "input",
    channelId: uid(),
    typeId: "ev3:29",
    modeId: "mode:0",
    portId: "input:0",
    component: 0,
    state: "ready",
  };
  const provenance = { sessionId, providerId: "kobrixa.device-ev3", sourceRevision: 1 };
  const reserve = {
    reservationId,
    sessionId,
    firstSequence: 10,
    lastSequence: 10,
    channels: [channel],
    state: "active",
    reason: "active",
  };
  const terminal = { ...reserve, lastSequence: 25, state: "ended", reason: "released" };
  const source = { origin: "public", channel, provenance };
  // One read completes late while the previous snapshot is still fresh.
  const sampleOffset = (i) => i * 500 + (i >= 6 ? 150 : 0);
  const frames = Array.from({ length: 16 }, (_, i) => ({
    sequence: 10 + i,
    sourceRevision: 1,
    sampledAt: 101000 + sampleOffset(i),
    elapsedMs: 300 + sampleOffset(i),
    status: "ok",
    program: "stopped",
    values: [{ channelId: channel.channelId, value: 401 + i }],
  }));
  const saved = {
    schemaVersion: 2,
    id: uid(),
    name,
    reason: "manual",
    startedAt: 101000,
    recordingOrigin: { sessionId, providerId: provenance.providerId, sessionElapsedMs: 300 },
    frameCount: frames.length,
    channels: [{ source }],
    frames: frames.map((f) => ({
      ...f,
      values: [f.values[0].value],
      sessionElapsedMs: f.elapsedMs,
      elapsedMs: f.elapsedMs - 300,
      segment: 0,
    })),
  };
  const initial = { ...saved, frameCount: 1, frames: saved.frames.slice(0, 1) };
  delete initial.reason;
  const bytes = Buffer.from(JSON.stringify(saved)),
    initialBytes = Buffer.from(JSON.stringify(initial));
  const meta = (b, revision, checkpoint) => ({
    id: storageId,
    revision,
    checkpoint,
    interrupted: false,
    sha256: digest(b),
    byteLength: b.length,
  });
  const first = meta(initialBytes, "r1", "open"),
    final = meta(bytes, "r2", "final");
  const lab = { serviceName: "Kobrixa plugin kobrixa.sensor-lab", owner, pid: 105, exited: true };
  lab.cwd = run.identity.appPath + ".unpacked/.vite/build/plugins/sensor-lab";
  lab.entry = lab.cwd + "/main.cjs";
  run.forks.push(lab);
  for (const phase of [obs.before, obs.after]) {
    phase.lab = { binding, reservation: reservationId };
    phase.forks.push({ ...lab, exited: false });
  }
  Object.assign(secondary, {
    beforeSpawn: 2520,
    heldAt: 2560,
    resumeRequested: 2600,
    resumeConfirmed: 2650,
  });
  secondary.observation.installedMonotonic = 2550;
  secondary.observation.exitMonotonic = 3200;
  secondary.exit.monotonic = 3250;
  secondary.startedAt = 102525;
  secondary.exit.at = 103250;
  secondary.cleanupObservedAt = 108250;
  obs.before.at = 102000;
  obs.defocused.at = 102050;
  obs.events[0].at = 103051;
  obs.events[1].at = 103050;
  obs.after.at = 104110;
  run.fiveSecondCleanup = { startedAt: 109100, endedAt: 114100, remainingPids: [] };
  run.identity.executable = "/copy/kobrixa";
  run.isolation = { checkout: "EPERM", worktree: "EACCES", dependency: "EPERM", network: "EPERM" };
  run.recordingReleases = [
    {
      primary: run.pid,
      at: 8900,
      owner,
      reservationId,
      result: { ok: true, value: { reservation: terminal } },
    },
  ];
  run.recordingMessages = [];
  const restart = {
    ...structuredClone(run),
    name: "recording-history",
    pid: 106,
    recordingMessages: [],
  };
  restart.fiveSecondCleanup = { startedAt: 116000, endedAt: 121000, remainingPids: [] };
  restart.observedPids = [106, 107];
  restart.forks.at(-1).owner.hostEpoch = uid();
  restart.forks.at(-1).owner.processEpoch = uid();
  restart.forks.at(-1).pid = 107;
  const restartedBinding = {
    ...binding,
    hostEpoch: restart.forks.at(-1).owner.hostEpoch,
    processEpoch: restart.forks.at(-1).owner.processEpoch,
    panelInstance: uid(),
  };
  restart.recordingReleases = [];
  r.runs.push(restart);
  let serial = 0;
  function rpc(row, method, params, value, at, end, direction = "plugin-host") {
    const id = ++serial;
    for (const [time, dir, message] of [
      [at, direction, { method, params, id }],
      [
        end,
        direction === "plugin-host" ? "host-plugin" : "plugin-host",
        { id, result: { ok: true, value } },
      ],
    ]) {
      row.recordingMessages.push({
        ...(dir === "host-plugin" ? { sendStartedAt: time - 0.1 } : {}),
        at: time,
        after: time + 0.1,
        wall: time + 100000,
        owner: row.forks.at(-1).owner,
        pid: row.pid,
        utility: row.forks.at(-1).pid,
        direction: dir,
        message,
      });
    }
  }
  const cmd = (row, action, at, end, args = {}) =>
    rpc(
      row,
      "command/invoke",
      {
        command: "kobrixa.sensor-lab." + action,
        context: {
          origin: "panel",
          binding: row === run ? binding : restartedBinding,
          form: { values: { "recording-name": name } },
        },
        arguments: args,
      },
      { fieldErrors: [] },
      at,
      end,
      "host-plugin",
    );
  cmd(run, "select-channel", 850, 875, { key: channel.channelId });
  cmd(run, "start", 900, 1050);
  rpc(
    run,
    "devices/session",
    { sessionId },
    {
      session: {
        ...provenance,
        state: "connected",
        providerGeneration: 1,
        transport: "usb",
        name: "Kobrixa UHID spike",
      },
    },
    901,
    905,
  );
  rpc(
    run,
    "devices/recording/reserve",
    { sessionId, channelIds: [channel.channelId], expectedSourceRevision: 1 },
    { reservation: reserve, firstFrame: frames[0] },
    950,
    1001,
  );
  rpc(
    run,
    "storage/beginWrite",
    { target: { mode: "create" }, sha256: first.sha256, byteLength: first.byteLength },
    { id: storageId, write: "initial" },
    1002,
    1004,
  );
  rpc(
    run,
    "storage/writeChunk",
    { write: "initial", offset: 0, data: initialBytes.toString("base64") },
    { receivedBytes: initialBytes.length },
    1005,
    1006,
  );
  const receipts = [first, final].map((m) => ({ commitId: uid(), revision: m.revision }));
  rpc(
    run,
    "storage/commitWrite",
    { write: "initial" },
    { record: first, receipt: receipts[0] },
    1007,
    1008,
  );
  rpc(
    run,
    "storage/registerCheckpoint",
    { id: storageId, expectedRevision: "r1", reservation: reservationId },
    { checkpoint: "grant" },
    1010,
    1012,
  );
  for (const [i, f] of frames.slice(1).entries()) {
    const at = 1001 + sampleOffset(i + 1);
    rpc(
      run,
      "devices/recording/read",
      { reservationId, afterSequence: f.sequence - 1 },
      {
        gap: null,
        nextSequence: f.sequence,
        reservation: { ...reserve, lastSequence: f.sequence },
        frames: [f],
      },
      at,
      at + 1,
    );
  }
  rpc(
    run,
    "storage/drain",
    {
      token: "drain",
      reason: "reservation-ended",
      checkpoints: [
        {
          checkpoint: "grant",
          record: first,
          reservationEnd: { reservationId, lastSequence: 25, reason: "released" },
        },
      ],
    },
    { status: "submitted", writes: ["finish"] },
    8901,
    9000,
    "host-plugin",
  );
  rpc(
    run,
    "storage/beginWrite",
    {
      target: { mode: "replace", id: storageId, expectedRevision: "r1" },
      sha256: final.sha256,
      byteLength: bytes.length,
      checkpoint: { handle: "grant", phase: "final" },
      drainToken: "drain",
    },
    { write: "finish" },
    8910,
    8911,
  );
  rpc(
    run,
    "storage/writeChunk",
    { write: "finish", offset: 0, data: bytes.toString("base64") },
    { receivedBytes: bytes.length },
    8912,
    8913,
  );
  rpc(
    run,
    "storage/commitWrite",
    { write: "finish", drainToken: "drain" },
    { record: final, receipt: receipts[1] },
    8914,
    8915,
  );
  const workerExit = run.workerTimeline.pop();
  for (const [id, record] of [first, final].entries()) {
    run.workerTimeline.push(
      {
        worker: 0,
        pid: run.pid,
        event: "publish",
        request: { id, args: [{ metadata: { record }, owner }] },
      },
      {
        worker: 0,
        pid: run.pid,
        event: "publication-result",
        response: { id, ok: true, value: { disposition: "committed", receipt: receipts[id] } },
      },
    );
  }
  run.workerTimeline.push(workerExit);
  rpc(
    restart,
    "ui/state",
    { binding: restartedBinding },
    { binding: restartedBinding },
    14990,
    14991,
  );
  // On panel open, the renderer follows the latest chart sample automatically.
  cmd(restart, "cursor", 14995, 15001, { time: 1000, presentation: 1 });
  const [cursor, cursorReply] = restart.recordingMessages.slice(-2);
  cursor.message.params.context.form.revision = 0;
  cursorReply.message.result = { ok: false, error: { code: "PLUGIN_E_COMMAND_FAILED" } };
  restart.recordingMessages.push({
    ...cursor,
    at: 14998,
    message: {
      method: "events/deliver",
      params: {
        kind: "ui.form",
        data: { binding: restartedBinding, revision: 1 },
      },
    },
  });
  cmd(restart, "refresh", 14999, 15002);
  rpc(
    restart,
    "storage/list",
    { kind: "sensor-lab.recording" },
    { entries: [final] },
    15000,
    15001,
  );
  cmd(restart, "view-record", 15010, 15050, { key: storageId });
  rpc(
    restart,
    "storage/openRead",
    { id: storageId, expectedRevision: "r2" },
    { read: "pin", record: final },
    15011,
    15012,
  );
  rpc(
    restart,
    "storage/readChunk",
    { read: "pin", offset: 0 },
    { data: bytes.toString("base64"), nextOffset: bytes.length, offset: 0, eof: true },
    15013,
    15014,
  );
  for (const row of r.runs) row.recordingMessages.sort((a, b) => a.at - b.at);
  const program = Buffer.from(
    (await readFile(new URL("fixtures/ev3-uhid/snapshot.h", import.meta.url), "utf8"))
      .match(/0x[0-9a-f]+/g)
      .map(Number),
  );
  let trace = "0.900000000 OPEN\n";
  for (const [i, f] of frames.entries()) {
    const req = Buffer.alloc(4 + program.length);
    req.writeUInt16LE(req.length - 2);
    req.writeUInt16LE(i, 2);
    program.copy(req, 4);
    const reply = Buffer.alloc(512);
    reply.writeUInt16LE(379);
    reply.writeUInt16LE(i, 2);
    reply[4] = 2;
    reply[5] = 0x40;
    reply[13] = reply[23] = 29;
    reply[15] = 122;
    reply[17] = 1;
    reply.writeFloatLE(f.values[0].value, 49);
    trace +=
      ((998 + sampleOffset(i)) / 1000).toFixed(9) +
      " REQUEST " +
      req.toString("hex") +
      "\n" +
      ((999 + sampleOffset(i)) / 1000).toFixed(9) +
      " REPLY " +
      reply.toString("hex") +
      "\n";
  }
  trace += "9.010000000 CLOSE\n";
  r.recording = {
    criterion: "installed-recording-bracketing-v1",
    missing: [],
    unexpectedPauses: [],
    name,
    stopAt: 8800,
    device: { connection: "Kobrixa UHID spike · connected", offset: 0 },
    traceSha256: digest(trace),
  };
  const key = "p4-" + name.slice(3, 27),
    status = "enabled 1\npid 100\nlost 0";
  const rules = ["b64", "b32"]
    .map(
      (abi) =>
        "-a always,exit -F arch=" +
        abi +
        " -S all -F dir=" +
        run.profile +
        " -F perm=wa -F success=1 -F key=" +
        key,
    )
    .join("\n");
  const audit = {
    attribution:
      "Linux SYSCALL pid is the thread-group ID. Writes by primary worker threads are attributed to the primary process.",
    kernel: {
      machine: "x86_64",
      x32Getpid: { pid: 200, native: 200, result: -1, errno: 38, seccomp: "Seccomp: 0" },
    },
    attempts: {
      b64: { installed: true },
      b32: { installed: true },
      x32: { installed: false, error: "unknown architecture" },
    },
    rulesBefore: rules,
    profile: run.profile,
    key,
    rules,
    before: status,
    after: status,
  };
  function rawArtifacts(receipt) {
    const files = {};
    const summary = structuredClone(receipt);
    for (const row of summary.runs) {
      const workers = row.workerTimeline.map((w, sequence) => ({ ...w, sequence }));
      row.workerTimeline = workers;
      const events = [{ event: "primary-paused", pid: row.pid, at: 800, reason: "Break on start" }];
      if (row === summary.runs[0]) {
        const s = row.singleInstance.secondary;
        events.push({ event: "before-spawn", at: s.beforeSpawn });
        events.push({ event: "secondary-resumed", pid: s.pid, at: s.resumeConfirmed });
        const log = [
          {
            phase: "installed",
            pid: s.pid,
            beforeReady: true,
            installedMonotonic: s.observation.installedMonotonic,
          },
          s.observation,
        ]
          .map((e) => "KOBRIXA_SECONDARY " + JSON.stringify(e))
          .join("\n");
        files["single-instance-secondary.log"] = log;
        s.logSha256 = digest(log);
      }
      row.recordingArtifactHashes = {};
      for (const [suffix, bytes] of [
        ["-debugger.json", JSON.stringify(events)],
        ["-port.json", JSON.stringify(row.recordingMessages)],
        ["-release.json", JSON.stringify(row.recordingReleases)],
        ["-workers.json", JSON.stringify(workers.slice(0, -1))],
        [
          ".log",
          workers.map((w) => "KOBRIXA_INSTALLED_WORKER " + JSON.stringify(w) + "\n").join("") +
            "KOBRIXA_INSTALLED_RESTORED\n",
        ],
      ]) {
        files[row.name + suffix] = bytes;
        row.recordingArtifactHashes[suffix] = digest(bytes);
      }
      delete row.recordingMessages;
      delete row.recordingReleases;
    }
    files["installed.json"] = JSON.stringify(summary);
    return files;
  }
  const files = {
    ...rawArtifacts(r),
    "profile-audit.json": JSON.stringify(audit),
    "profile-audit.log": ["101.990", "102.600", "103.260", "103.600"]
      .map(
        (at, i) =>
          "type=SYSCALL msg=audit(" +
          at +
          ":" +
          i +
          ') success=yes pid=101 ppid=50 key="' +
          key +
          '"\n',
      )
      .join(""),
    "recording-history.json": bytes,
    "peer-trace.log": trace,
  };
  audit.sha256 = digest(files["profile-audit.log"]);
  files["profile-audit.json"] = JSON.stringify(audit);
  const persist = async (files) => {
    for (const [file, data] of Object.entries(files)) await writeFile(path.join(dir, file), data);
  };
  await persist(files);
  const verify = () => verifyContinuity(path.join(dir, "installed.json"));
  const result = await verify();
  await t.test("CLI evaluates the recording finalizer and verifies a saved fixture", () => {
    const entry = fileURLToPath(new URL("./builtin-process-installed.mjs", import.meta.url));
    const child = spawnSync(
      process.execPath,
      [entry, "--verify-recording", path.join(dir, "installed.json")],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), result);
  });
  assert.deepEqual(result.phases, {
    before: [10, 11, 12, 13],
    heldEntry: [],
    resumed: [14],
    after: frames.slice(5).map((f) => f.sequence),
  });
  assert.equal(result.primaryRecordingInterrupted, false);
  assert.deepEqual(result.unrun, []);
  assert.deepEqual(result.profileWriteAudit.coveredAbis, ["b64", "b32"]);
  assert.equal(result.resumeWindow.durationMs, 550);
  assert.equal(result.resumeWindow.completeExchanges, 1);
  assert.equal(result.resumeWindow.readBefore.value, 404);
  assert.equal(result.resumeWindow.readAfter.value, 406);
  assert.equal(result.resumeWindow.wireGapMs, 999);
  await t.test("missing port evidence retains measured duration and adjacent reads", async () => {
    const primary = JSON.parse(files["installed.json"]).runs[0];
    await rm(path.join(dir, primary.name + "-port.json"));
    const window = await measureResumeWindow(dir, primary, r.recording);
    assert.equal(window.durationMs, 550);
    assert.deepEqual(window.readBefore, result.resumeWindow.readBefore);
    assert.deepEqual(window.readAfter, result.resumeWindow.readAfter);
    assert.equal(window.wireGapMs, 999);
    assert.equal(window.completeExchanges, null);
    assert.equal(window.bracket.gapMs, null);
    assert.match(window.observationError, /ENOENT/);
    await persist(files);
  });
  await t.test("short synthetic window needs no inside-lifetime exchange", async () => {
    const copy = structuredClone(r);
    copy.runs[0].singleInstance.secondary.observation.exitMonotonic = 2750;
    await persist(rawArtifacts(copy));
    const verified = await verify();
    assert.equal(verified.primaryRecordingInterrupted, false);
    assert.equal(verified.resumeWindow.completeExchanges, 0);
    assert.equal(verified.resumeWindow.durationMs, 100);
    assert.equal(verified.resumeWindow.bracket.before.sequence, 13);
    assert.equal(verified.resumeWindow.bracket.after.sequence, 14);
    assert.ok(Math.abs(verified.resumeWindow.bracket.gapMs - 496) < 1);
  });
  await t.test(
    "unrelated slow port observation does not discredit a bracketed sample",
    async () => {
      const copy = structuredClone(r);
      copy.runs[0].recordingMessages.find((m) => m.at === 850).after += 4;
      await persist(rawArtifacts(copy));
      assert.deepEqual((await verify()).phases, result.phases);
    },
  );
  await t.test(
    "long inspector hold credits complete primary exchanges with zero inside",
    async () => {
      const copy = structuredClone(r);
      const obs = copy.runs[0].singleInstance;
      const s = obs.secondary;
      s.resumeRequested = 5190;
      s.resumeConfirmed = 5200;
      s.observation.exitMonotonic = 5300;
      s.exit.monotonic = 5350;
      s.exit.at = 105350;
      s.cleanupObservedAt = 110350;
      obs.events[0].at = 105251;
      obs.events[1].at = 105250;
      obs.after.at = 105700;
      const auditLog = files["profile-audit.log"].replace("103.600", "105.700");
      await persist({
        ...rawArtifacts(copy),
        "profile-audit.log": auditLog,
        "profile-audit.json": JSON.stringify({ ...audit, sha256: digest(auditLog) }),
      });
      const verified = await verify();
      assert.deepEqual(verified.phases.heldEntry, [14, 15, 16, 17, 18]);
      const w = verified.resumeWindow;
      assert.equal(w.holdDurationMs, 2680);
      assert.equal(w.durationMs, 100);
      assert.equal(w.holdCompleteExchanges, 5);
      assert.equal(w.completeExchanges, 0);
      assert.equal(w.bracket.before.sequence, 18);
      assert.equal(w.bracket.after.sequence, 19);
      assert.ok(Math.abs(w.bracket.gapMs - 496) < 1);
      await persist(files);
    },
  );
  for (const boundary of ["resume", "exit"]) {
    await t.test(
      "broker send crossing " + boundary + " counts only as an intermediate",
      async () => {
        const copy = structuredClone(r);
        const primary = copy.runs[0];
        const s = primary.singleInstance.secondary;
        if (boundary === "resume") s.resumeConfirmed = 3050;
        const instant = boundary === "resume" ? s.resumeConfirmed : s.observation.exitMonotonic;
        const reply = primary.recordingMessages.find(
          (m) => m.message.result?.value?.frames?.[0]?.sequence === 14,
        );
        assert.ok(reply.sendStartedAt < instant);
        reply.at = instant + 10;
        reply.after = reply.at + 0.1;
        reply.wall = reply.at + 100000;
        await persist(rawArtifacts(copy));
        const verified = await verify();
        assert.equal(verified.resumeWindow.completeExchanges, 0);
        assert.equal(verified.resumeWindow.holdCompleteExchanges, 0);
        assert.equal(verified.resumeWindow.bracket.before.sequence, 13);
        assert.equal(verified.resumeWindow.bracket.after.sequence, 15);
        // A promoted receipt must not claim the crossing delivery as an endpoint
        // or as an exchange wholly inside the secondary lifetime.
        const promoted = { ...JSON.parse(rawArtifacts(copy)["installed.json"]), ...verified };
        if (boundary === "resume") promoted.resumeWindow.bracket.before.sequence = 14;
        else promoted.resumeWindow.completeExchanges = 1;
        await persist({ "installed.json": JSON.stringify(promoted) });
        await assert.rejects(verify, /receipt differs from raw evidence: resumeWindow/);
      },
    );
  }
  const cases = [
    ...[
      [
        "current cursor",
        (event) => {
          event.message.params.data.revision = 0;
        },
      ],
      [
        "form change on another panel",
        (event) => {
          event.message.params.data.binding = binding;
        },
      ],
      [
        "form change after the failed reply",
        (event) => {
          event.at = 15003;
        },
      ],
    ].map(([label, change]) => [
      label,
      (r) => change(r.runs[1].recordingMessages.find((m) => m.message.params?.kind === "ui.form")),
      /command\/invoke succeeded/,
    ]),
    [
      "failed history Refresh",
      (r) => {
        const rows = r.runs[1].recordingMessages;
        const refresh = rows.find(
          (m) => m.message.params?.command === "kobrixa.sensor-lab.refresh",
        );
        rows.find((m) => !m.message.method && m.message.id === refresh.message.id).message.result =
          {
            ok: false,
            error: { code: "PLUGIN_E_COMMAND_FAILED" },
          };
      },
      /command\/invoke succeeded/,
    ],
    [
      "final save from a shutdown drain",
      (r) => {
        r.runs[0].recordingMessages.find(
          (m) => m.message.method === "storage/drain",
        ).message.params.reason = "shutdown";
      },
      /final drain reason/,
    ],
    [
      "old criterion",
      (r) => {
        r.recording.criterion = "installed-recording-inside-lifetime-v1";
      },
      /continuity criterion/,
    ],
    [
      "unversioned receipt",
      (r) => {
        delete r.recording.criterion;
      },
      /continuity criterion/,
    ],
    [
      "legacy reply has no successful send observation",
      (r) => {
        delete r.runs[0].recordingMessages.find(
          (m) => m.message.result?.value?.frames?.[0]?.sequence === 14,
        ).sendStartedAt;
      },
      /missing successful port send timing/,
    ],
    [
      "aggregate bracket exceeds freshness despite fresh adjacent samples",
      (r) => {
        const s = r.runs[0].singleInstance.secondary;
        s.observation.exitMonotonic = 5200;
        s.exit.monotonic = 5250;
        s.exit.at = 105250;
        s.cleanupObservedAt = 110250;
      },
      /bracket exceeds sampler freshness/,
    ],
    [
      "missing sequence inside bracket",
      (r) => {
        const row = r.runs[0].recordingMessages.find(
          (x) => x.message.result?.value?.frames?.[0]?.sequence === 14,
        );
        row.message.result.value.frames = [];
      },
      /broker read cursor/,
    ],
    [
      "session change inside bracket",
      (r) => {
        const row = r.runs[0].recordingMessages.find(
          (x) => x.message.result?.value?.frames?.[0]?.sequence === 14,
        );
        row.message.result.value.reservation.sessionId = uid();
      },
      /reservation sessionId/,
    ],
    [
      "release and reacquire inside bracket",
      (r) => {
        const primary = r.runs[0];
        primary.recordingReleases.unshift({ ...primary.recordingReleases[0], at: 2800 });
        rpc(
          primary,
          "devices/recording/reserve",
          { sessionId },
          { reservation: reserve },
          2801,
          2802,
        );
        primary.recordingMessages.sort((a, b) => a.at - b.at);
      },
      /one recording reserve/,
    ],
    [
      "stale history panel",
      (r) => {
        const view = r.runs[1].recordingMessages.find((x) =>
          x.message.params?.command?.endsWith("view-record"),
        );
        view.message.params.context.binding = binding;
      },
      /restarted panel binding/,
    ],
    [
      "missing final write chunks",
      (r) => {
        r.runs[0].recordingMessages = r.runs[0].recordingMessages.filter(
          (x) => x.message.params?.write !== "finish" || x.message.method !== "storage/writeChunk",
        );
      },
      /complete record length/,
    ],
    [
      "incompatible launch clocks",
      (r) => {
        r.runs[0].singleInstance.secondary.startedAt = 75;
      },
      /spawn wall time/,
    ],
    ["primary paused", (r) => r.recording.unexpectedPauses.push({ reason: "other" }), /other/],
    [
      "corrupt final write payload",
      (r) => {
        const write = r.runs[0].recordingMessages.find(
          (x) => x.message.method === "storage/writeChunk" && x.message.params.write === "finish",
        );
        const altered = Buffer.from(write.message.params.data, "base64");
        altered[0] ^= 1;
        write.message.params.data = altered.toString("base64");
      },
      /record digest/,
    ],
    ["failed receipt", (r) => (r.status = "failed"), /unsuccessful execution/],
    [
      "late final frame",
      (r) => (r.runs[0].recordingReleases[0].at += 2000),
      /cadence through actual release/,
    ],
    [
      "interrupted recording",
      (r) => {
        r.runs[0].recordingReleases[0].result.value.reservation.reason = "retired";
      },
      /retired/,
    ],
    [
      "reacquired recording",
      (r) => {
        const w = r.runs[0].recordingMessages;
        const original = w.find((x) => x.message.method === "devices/recording/reserve");
        const reply = w.find((x) => x.message.id === original.message.id && !x.message.method);
        const second = [original, reply].map((x) => structuredClone(x));
        second[0].message.id = second[1].message.id = 10000;
        second[1].message.result.value.reservation.reservationId = uid();
        w.push(...second);
      },
      /one recording reserve/,
    ],
    [
      "foreign reservation",
      (r) => {
        r.runs[0].recordingMessages.find(
          (x) => x.message.method === "devices/recording/read",
        ).message.params.reservationId = "foreign";
      },
      /foreign/,
    ],
    [
      "changed owner",
      (r) => {
        r.runs[0].recordingMessages[3].owner = { ...owner, processEpoch: uid() };
      },
      /changed recording owner/,
    ],
    [
      "ambiguous clocks",
      (r) => {
        r.runs[0].recordingMessages.find((m) => m.at === 950).after += 4;
      },
      /ambiguous/,
    ],
    [
      "sampler exceeds freshness gap",
      (r) => {
        r.runs[0].recordingMessages.find(
          (x) => x.message.result?.value?.frames,
        ).message.result.value.frames[0].elapsedMs += 2100;
      },
      /sampler freshness gap/,
    ],
    [
      "stale sample",
      (r) => {
        r.runs[0].recordingMessages.find(
          (x) => x.message.result?.value?.frames,
        ).message.result.value.frames[0].sampledAt += 1000;
      },
      /wire time/,
    ],
    [
      "replayed sample",
      (r) => {
        r.runs[0].recordingMessages.find(
          (x) => x.message.result?.value?.frames,
        ).message.result.value.frames[0].values[0].value = 401;
      },
      /wire time|replay/,
    ],
  ];
  for (const [label, change, error] of cases)
    await t.test(label, async () => {
      const copy = structuredClone(r);
      change(copy);
      await persist(rawArtifacts(copy));
      await assert.rejects(verify, error);
    });
  await t.test("different peer run even with a corresponding trace digest", async () => {
    const foreign = trace.replace(/REPLY ([0-9a-f]+)/g, (_, hex) => {
      const reply = Buffer.from(hex, "hex");
      reply.writeFloatLE(reply.readFloatLE(49) + 5000, 49);
      return "REPLY " + reply.toString("hex");
    });
    const copy = structuredClone(r);
    copy.recording.traceSha256 = digest(foreign);
    await persist({ ...files, "peer-trace.log": foreign, ...rawArtifacts(copy) });
    await assert.rejects(verify, /fresh wire read in original reserve/);
  });
  for (const [label, index, value, error] of [
    ["empty dataset", 17, 0, /no dataset/],
    ["busy port", 16, 1, /port unavailable/],
    ["disconnected port", 15, 126, /port unavailable/],
    ["wrong program", 5, 16, /wire program state/],
  ])
    await t.test(label, async () => {
      const invalid = trace.replace(/REPLY ([0-9a-f]+)/, (_, hex) => {
        const reply = Buffer.from(hex, "hex");
        reply[index] = value;
        return "REPLY " + reply.toString("hex");
      });
      const copy = structuredClone(r);
      copy.recording.traceSha256 = digest(invalid);
      await persist({ ...files, ...rawArtifacts(copy), "peer-trace.log": invalid });
      await assert.rejects(verify, error);
    });
  await t.test("passed receipt must report the measured gap and inside count", async () => {
    const promoted = { ...JSON.parse(files["installed.json"]), ...structuredClone(result) };
    await persist({ ...files, "installed.json": JSON.stringify(promoted) });
    assert.deepEqual(await verify(), result);
    promoted.resumeWindow.completeExchanges = 0;
    promoted.resumeWindow.bracket.gapMs--;
    await persist({ "installed.json": JSON.stringify(promoted) });
    await assert.rejects(verify, /receipt differs from raw evidence: resumeWindow/);
  });
  await t.test("a raw primary pause rejects an otherwise clean receipt", async () => {
    const summary = JSON.parse(files["installed.json"]);
    const primary = summary.runs[0],
      name = primary.name + "-debugger.json";
    const events = JSON.parse(files[name]);
    events.push({ event: "primary-paused", pid: primary.pid, at: 2900, reason: "other" });
    const bytes = JSON.stringify(events);
    primary.recordingArtifactHashes["-debugger.json"] = digest(bytes);
    await persist({ ...files, [name]: bytes, "installed.json": JSON.stringify(summary) });
    await assert.rejects(verify, /recorded debugger events/);
  });
  await t.test("resume confirmation must match the inspector event", async () => {
    const summary = JSON.parse(files["installed.json"]);
    summary.runs[0].singleInstance.secondary.resumeConfirmed++;
    await persist({ ...files, "installed.json": JSON.stringify(summary) });
    await assert.rejects(verify, /recorded debugger events/);
  });
  await t.test("worker output disagrees despite matching artifact hash", async () => {
    const summary = JSON.parse(files["installed.json"]);
    const primary = summary.runs[0];
    const name = primary.name + ".log";
    const output = files[name].replace('"event":"publish"', '"event":"lost-publication"');
    primary.recordingArtifactHashes[".log"] = digest(output);
    await persist({ ...files, [name]: output, "installed.json": JSON.stringify(summary) });
    await assert.rejects(verify, /worker output reconciles/);
  });
  await t.test("secondary raw exit arrives before installation", async () => {
    const summary = JSON.parse(files["installed.json"]);
    const reordered = files["single-instance-secondary.log"].split("\n").reverse().join("\n");
    summary.runs[0].singleInstance.secondary.logSha256 = digest(reordered);
    await persist({
      ...files,
      "single-instance-secondary.log": reordered,
      "installed.json": JSON.stringify(summary),
    });
    await assert.rejects(verify, /secondary log order/);
  });
  await t.test("publication result arrives before publish despite matching digest", async () => {
    const summary = JSON.parse(files["installed.json"]);
    const primary = summary.runs[0];
    const name = primary.name + ".log";
    const lines = files[name].split("\n");
    const i = lines.findIndex((line) => line.includes('"event":"publish"'));
    assert.ok(i >= 0 && lines[i + 1].includes('"event":"publication-result"'));
    [lines[i], lines[i + 1]] = [lines[i + 1], lines[i]];
    const output = lines.join("\n");
    primary.recordingArtifactHashes[".log"] = digest(output);
    await persist({ ...files, [name]: output, "installed.json": JSON.stringify(summary) });
    await assert.rejects(verify, /arrival order/);
  });
  for (const [label, change, error] of [
    [
      "missing compat rule before launch",
      (a) => {
        a.rulesBefore = rules.split("\n")[0];
      },
      /rule for b32/,
    ],
    [
      "missing compat rule after exit",
      (a) => {
        a.rules = rules.split("\n")[0];
      },
      /rule for b32/,
    ],
    [
      "permitted x32 ABI without coverage",
      (a) => {
        a.kernel.x32Getpid.result = 200;
      },
      /attribution for x32/,
    ],
    [
      "filtered x32 probe",
      (a) => {
        a.kernel.x32Getpid.seccomp = "Seccomp: 2";
      },
      /attribution for x32/,
    ],
    [
      "missing ABI inventory",
      (a) => {
        delete a.attempts.b32;
      },
      /attribution for b32/,
    ],
  ])
    await t.test(label, async () => {
      const copy = structuredClone(audit);
      change(copy);
      await persist({ ...files, "profile-audit.json": JSON.stringify(copy) });
      await assert.rejects(verify, error);
    });
  // Hand-authored excerpts of the two rule installations. Only the second
  // event has a SOCKADDR. The kernel and auditd fields are separated by GS.
  const install = (id, pid) => [
    `type=CONFIG_CHANGE msg=audit(${id}): op=add_rule key="${key}" list=4 res=1\x1dAUID="unset"`,
    `type=SYSCALL msg=audit(${id}): arch=c000003e syscall=44 success=yes items=0 ppid=50 pid=${pid} uid=0 euid=0 comm="auditctl" exe="/usr/sbin/auditctl" key=(null)\x1dARCH=x86_64 SYSCALL=sendto`,
  ];
  const firstInstall = install("100.911:202", 51);
  const secondInstall = [
    ...install("100.921:209", 52),
    "type=SOCKADDR msg=audit(100.921:209): saddr=100000000000000000000000\x1dSADDR={ saddr_fam=netlink nlnk-pid=0 }",
  ];
  const [config, send, socket] = secondInstall;
  for (const [label, records, accepted] of [
    ["both audit rule installations", [...firstInstall, ...secondInstall], true],
    ["audit rule removal", [config.replace("add_rule", "remove_rule"), send, socket], true],
    [
      "keyless send from another executable",
      [config, send.replace("/usr/sbin/auditctl", "/bin/other")],
    ],
    [
      "keyless profile write",
      [send.replace("syscall=44", "syscall=257").replace("/usr/sbin/auditctl", "/copy/kobrixa")],
    ],
    ["keyless auditctl without a rule change", [send, socket]],
    ["audit rule change in another event", [config.replace(":209", ":208"), send]],
    ["audit rule change at another time", [config.replace("100.921", "100.922"), send]],
    ["audit rule change for another key", [config.replace(key, key + "-other"), send]],
    ["two changes for one send", [config, config, send]],
    ["two sends for one change", [config, send, send]],
    ["two destinations for one send", [config, send, socket, socket]],
    [
      "send declaring a path item without its PATH record",
      [config, send.replace("items=0", "items=1")],
    ],
    ["missing syscall key field", [config, send.replace(" key=(null)", "")]],
    ["key only in auditd enrichment", [send + ' key="' + key + '"']],
    ["unsuccessful audit rule change", [config.replace("res=1", "res=0"), send]],
    ["auditctl without real root uid", [config, send.replace(" uid=0", " uid=1")]],
    ["auditctl without effective root uid", [config, send.replace(" euid=0", " euid=1")]],
    ["auditctl using another syscall", [config, send.replace("syscall=44", "syscall=2")]],
    ["auditctl using another ABI", [config, send.replace("c000003e", "40000003")]],
    [
      "auditctl using another socket family",
      [config, send, socket.replace("saddr=1000", "saddr=0200")],
    ],
    [
      "rule change accompanied by a profile path",
      [
        config,
        send,
        socket,
        `type=PATH msg=audit(100.921:209): item=0 name="${run.profile}/cache.db" nametype=NORMAL`,
      ],
    ],
  ]) {
    await t.test(label, async () => {
      const raw = [...records, files["profile-audit.log"]].join("\n");
      await persist({
        ...files,
        "profile-audit.log": raw,
        "profile-audit.json": JSON.stringify({ ...audit, sha256: digest(raw) }),
      });
      if (accepted) assert.deepEqual(await verify(), result);
      else await assert.rejects(verify, /audit rule attribution/);
    });
  }
  await t.test("valid raw recording cannot clear a retained receipt failure", async () => {
    const retained = JSON.parse(files["installed.json"]);
    retained.unrun.push("prior recording failure");
    await persist({ ...files, "installed.json": JSON.stringify(retained) });
    await assert.rejects(verify, /prior recording failure/);
  });
  await t.test("unknown process writes during launch", async () => {
    const raw = files["profile-audit.log"].replace(
      /(102\.600:1\) success=yes )pid=101 ppid=50/,
      "$1pid=999 ppid=777",
    );
    await persist({
      ...files,
      "profile-audit.log": raw,
      "profile-audit.json": JSON.stringify({ ...audit, sha256: digest(raw) }),
    });
    await assert.rejects(verify, /unattributed profile write/);
  });
  await t.test(
    "unknown writer after process exit but before the first complete post-exit delivery",
    async () => {
      const raw = files["profile-audit.log"].replace(
        "103.260:2) success=yes pid=101 ppid=50",
        "103.260:2) success=yes pid=999 ppid=777",
      );
      await persist({
        ...files,
        "profile-audit.log": raw,
        "profile-audit.json": JSON.stringify({ ...audit, sha256: digest(raw) }),
      });
      await assert.rejects(verify, /unattributed profile write/);
    },
  );
  for (const [file, data] of Object.entries(files).filter(([file]) => file !== "installed.json"))
    await t.test("missing and truncated " + file, async () => {
      await persist(files);
      await rm(path.join(dir, file));
      await assert.rejects(verify, /ENOENT/);
      await persist({ [file]: Buffer.from(data).subarray(0, -1) });
      await assert.rejects(verify);
    });
  for (const [label, file, modified, error] of [
    ["swapped trace", "peer-trace.log", trace.replace("9.010", "9.020"), /trace digest/],
    [
      "secondary write",
      "profile-audit.log",
      files["profile-audit.log"].replace("pid=101", "pid=102"),
      /secondary profile write/,
    ],
    ["truncated readback", "recording-history.json", bytes.subarray(0, -1), /retained readback/],
  ])
    await t.test(label, async () => {
      await persist({ ...files, [file]: modified });
      await assert.rejects(verify, error);
    });
});
