import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RECORDING_CRITERION } from "./ev3-uhid-observe.mjs";
import { verifyProfileWrites } from "./ev3-uhid-audit.mjs";
import { assertInstalledPrimary } from "./builtin-installed-primary.mjs";

const digest = (b) => createHash("sha256").update(b).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function only(rows, label) {
  assert.equal(rows.length, 1, label);
  return rows[0];
}
function pairs(rows, method, direction = "plugin-host") {
  return rows.flatMap((q, i) => {
    if (q.direction !== direction || q.message.method !== method) return [];
    const reply = only(
      rows
        .slice(i + 1)
        .filter(
          (r) => r.direction !== direction && !r.message.method && r.message.id === q.message.id,
        ),
      method + " response",
    );
    const sent = direction === "host-plugin" ? q : reply;
    assert.ok(
      Number.isFinite(sent.sendStartedAt) &&
        Number.isFinite(sent.at) &&
        sent.at >= sent.sendStartedAt,
      "missing successful port send timing",
    );
    assert.deepEqual(reply.owner, q.owner);
    assert.equal(reply.message.result?.ok, true, method + " succeeded");
    return [
      { params: q.message.params, value: reply.message.result.value, at: q.at, end: reply.at },
    ];
  });
}
function command(rows, name) {
  const call = only(
    pairs(rows, "command/invoke", "host-plugin").filter(
      (r) => r.params.command === "kobrixa.sensor-lab." + name,
    ),
    name,
  );
  assert.equal(call.params.context.origin, "panel");
  assert.deepEqual(call.value.fieldErrors, []);
  return call;
}
function joinedChunks(chunks, meta, read) {
  let offset = 0;
  const bytes = Buffer.concat(
    chunks.map(({ params, value }, index) => {
      assert.equal(params.offset, offset);
      const data = read ? value.data : params.data;
      const chunk = Buffer.from(data, "base64");
      assert.ok(chunk.length > 0 && chunk.toString("base64") === data, "canonical record chunk");
      if (!read)
        assert.equal(value.receivedBytes, offset + chunk.length, "acknowledged record chunk");
      if (read) {
        assert.equal(value.offset, offset);
        assert.equal(value.nextOffset, offset + chunk.length);
        assert.equal(value.eof, index === chunks.length - 1);
      }
      offset += chunk.length;
      return chunk;
    }),
  );
  assert.equal(bytes.length, meta.byteLength, "complete record length");
  assert.equal(digest(bytes), meta.sha256, "record digest");
  return bytes;
}

function historyBytes(rows) {
  const view = command(rows, "view-record");
  const read = only(
    pairs(rows, "storage/openRead").filter((r) => r.at >= view.at && r.end <= view.end),
    "history read",
  );
  assert.equal(read.params.id, read.value.record.id);
  assert.equal(read.params.expectedRevision, read.value.record.revision);
  return joinedChunks(
    pairs(rows, "storage/readChunk").filter(
      (r) => r.params.read === read.value.read && r.at >= read.end && r.end <= view.end,
    ),
    read.value.record,
    true,
  );
}

// The payload digest pins exactly snapshotCommand() as exercised by the C roundtrip test.
export function parseTrace(trace) {
  const reads = [];
  let opened = false,
    pending,
    previous = -1,
    epoch = 0;
  assert.ok(trace.endsWith("\n"), "complete peer log");
  for (const line of trace.trimEnd().split("\n")) {
    const match =
      /^(\d+\.\d{9}) (CREATE|START|OPEN|REQUEST|REPLY|CLOSE)(?: ((?:[0-9a-f]{2})+))?$/.exec(line);
    assert.ok(match, "unrecognized peer event: " + line.slice(0, 80));
    const [, stamp, event, hex] = match,
      at = Number(stamp) * 1000;
    assert.ok(at > previous, "peer monotonic order");
    previous = at;
    if (pending) assert.equal(event, "REPLY", "unfinished peer exchange");
    if (event === "OPEN") {
      assert.ok(!opened);
      opened = true;
      epoch++;
    }
    if (event === "CLOSE") {
      assert.ok(opened);
      opened = false;
    }
    if (event !== "REQUEST" && event !== "REPLY") continue;
    assert.ok(opened, "read outside peer open");
    let bytes = Buffer.from(hex, "hex");
    if (event === "REQUEST") {
      if (bytes[0] === 0) bytes = bytes.subarray(1);
      const end = bytes.readUInt16LE() + 2;
      assert.ok(end <= bytes.length && bytes.subarray(end).every((b) => b === 0));
      assert.equal(
        digest(bytes.subarray(4, end)),
        "07628c68b024965fc56498d374d431fa4f68050f397d17452be896474937da12",
        "peer monitor request",
      );
      pending = { at, counter: bytes.readUInt16LE(2), epoch };
    } else {
      assert.ok(pending && bytes.length === 512 && bytes.readUInt16LE() === 379 && bytes[4] === 2);
      assert.equal(bytes.readUInt16LE(2), pending.counter, "reply counter");
      assert.equal(bytes[13], 29);
      assert.equal(bytes[14], 0);
      assert.equal(bytes[23], 29);
      assert.equal(bytes[24], 0);
      // Port 0 has fixed type 29 and mode 0 above. monitor.ts marks it
      // unavailable on empty/error connection, busy or unstable type/mode.
      assert.ok(bytes[15] !== 126 && bytes[15] !== 127 && bytes[16] === 0, "port unavailable");
      assert.ok(Math.min(8, bytes[17]) > 0, "port has no dataset");
      const program = bytes[5] === 0x40 ? "stopped" : bytes[5] === 16 ? "running" : "unknown";
      const value = bytes.readFloatLE(49);
      assert.ok(Number.isSafeInteger(value) && value > 0, "wire challenge");
      if (reads.length) assert.equal(value, reads.at(-1).value + 1, "replayed peer sample");
      reads.push({ ...pending, end: at, value, program });
      pending = null;
    }
  }
  assert.ok(!pending && !opened && reads.length, "peer closed after successful exchanges");
  return reads;
}

// Select the closest observations whose wall-clock samples are definitely on
// opposite sides of this interval. An unrelated preemption has no bearing on it.
function clockBounds(clock, start, end) {
  const before = clock.findLast((r) => r.after <= start),
    after = clock.find((r) => r.at >= end);
  assert.ok(before && after, "missing bracketing clock observations");
  const bracket = [before, after];
  for (const r of bracket)
    assert.ok(r.after >= r.at && r.after - r.at <= 5, "ambiguous clock observation");
  const low = Math.min(...bracket.map((r) => r.wall - r.after - 1)),
    high = Math.max(...bracket.map((r) => r.wall - r.at + 1));
  assert.ok(Number.isFinite(low) && high - low <= 5, "ambiguous wall to monotonic correlation");
  return { low, high };
}

function exchangeInterval(clock, wire, frame, delivery) {
  const { low, high } = clockBounds(clock, wire.at, delivery);
  const earliest = frame.sampledAt - high - 1,
    latest = frame.sampledAt - low + 1;
  assert.ok(delivery >= wire.end, "broker delivered frame before peer exchange");
  assert.ok(wire.end <= latest && earliest - wire.at < 100, "frame outside wire time window");
  return {
    start: Math.min(wire.at, earliest),
    end: Math.max(delivery, wire.end, latest),
    earliestReceipt: earliest,
  };
}

function secondaryExit(log, secondary) {
  assert.equal(digest(log), secondary.logSha256);
  const events = log
    .toString()
    .split(/\r?\n/)
    .filter((s) => s.startsWith("KOBRIXA_SECONDARY "))
    .map((s) => JSON.parse(s.substring(s.indexOf(" ") + 1)));
  assert.deepEqual(
    events.map((e) => e.phase),
    ["installed", "exit"],
    "secondary log order",
  );
  const [entry, exit] = events;
  assert.equal(entry.pid, secondary.pid);
  assert.equal(exit.pid, entry.pid);
  assert.equal(entry.beforeReady, true);
  assert.equal(entry.installedMonotonic, exit.installedMonotonic);
  assert.deepEqual(exit, secondary.observation);
  return exit.exitMonotonic;
}

// Sampler.snapshot() accepts a sample through 2500 ms of age.
const freshnessMs = 2500;

function recordingBracket(exchanges, secondary, exit) {
  const before = exchanges.findLast((x) => x.end < secondary.resumeConfirmed);
  const after = exchanges.find((x) => x.start > exit);
  return {
    before: before ?? null,
    after: after ?? null,
    gapMs: before && after ? after.start - before.end : null,
  };
}

// Kept even if audit, history or the continuity gate cannot be verified.
// Null means unavailable. Zero is reserved for a measured empty window.
export async function measureResumeWindow(dir, run, recording) {
  const result = {
    holdDurationMs: null,
    holdCompleteExchanges: null,
    durationMs: null,
    bracket: { before: null, after: null, gapMs: null },
    readBefore: null,
    readAfter: null,
    wireGapMs: null,
    completeExchanges: null,
  };
  try {
    const secondary = run.singleInstance.secondary,
      resume = secondary.resumeConfirmed;
    assert.ok(
      Number.isFinite(secondary.beforeSpawn) &&
        Number.isFinite(resume) &&
        resume >= secondary.beforeSpawn,
      "unmeasured entry hold",
    );
    result.holdDurationMs = resume - secondary.beforeSpawn;
    const exit = secondaryExit(
      await readFile(path.join(dir, "single-instance-secondary.log")),
      secondary,
    );
    assert.ok(Number.isFinite(resume) && Number.isFinite(exit), "unmeasured resume or exit");
    result.durationMs = exit - resume;
    const trace = await readFile(path.join(dir, "peer-trace.log"));
    assert.equal(digest(trace), recording.traceSha256, "selected peer trace digest");
    assert.ok(Number.isSafeInteger(recording.device.offset) && recording.device.offset >= 0);
    const traceText = trace.subarray(recording.device.offset).toString();
    const reads = parseTrace(traceText);
    result.readBefore = reads.findLast((w) => w.end <= resume) ?? null;
    result.readAfter = reads.find((w) => w.at >= exit) ?? null;
    if (result.readBefore && result.readAfter)
      result.wireGapMs = result.readAfter.at - result.readBefore.end;
    // A complete peer trace can prove zero wire exchanges even if a later
    // port snapshot failed. Missing trace coverage cannot establish zero.
    const traceLines = traceText.trimEnd().split("\n");
    assert.ok(
      parseFloat(traceLines[0]) * 1000 <= resume && parseFloat(traceLines.at(-1)) * 1000 >= exit,
      "peer trace does not bracket the observed window",
    );
    assert.ok(exit >= resume, "raw exit preceded observed resume");
    const candidates = reads.filter((w) => w.at > resume && w.end < exit);
    if (!candidates.length) result.completeExchanges = 0;
    const bytes = await readFile(path.join(dir, run.name + "-port.json"));
    assert.equal(digest(bytes), run.recordingArtifactHashes["-port.json"], "primary port digest");
    const clock = JSON.parse(bytes);
    const reserve = only(pairs(clock, "devices/recording/reserve"), "one recording reserve");
    const deliveries = [{ frame: reserve.value.firstFrame, at: reserve.end }];
    for (const read of pairs(clock, "devices/recording/read")) {
      assert.equal(read.params.reservationId, reserve.value.reservation.reservationId);
      deliveries.push(...read.value.frames.map((frame) => ({ frame, at: read.end })));
    }
    const counted = new Set();
    const exchanges = [];
    const byValue = new Map();
    for (const item of deliveries) {
      const value = item.frame.values[0]?.value;
      assert.ok(!byValue.has(value), "unique wire delivery");
      byValue.set(value, item);
    }
    for (const wire of reads) {
      if (!byValue.has(wire.value)) continue;
      const { frame, at } = byValue.get(wire.value);
      const interval = exchangeInterval(clock, wire, frame, at);
      exchanges.push({ sequence: frame.sequence, start: interval.start, end: interval.end });
      if (interval.start > resume && interval.end < exit) counted.add(frame.sequence);
    }
    result.bracket = recordingBracket(exchanges, secondary, exit);
    result.holdCompleteExchanges = exchanges.filter(
      (x) => x.end >= secondary.beforeSpawn && x.end < resume,
    ).length;
    result.completeExchanges = counted.size;
  } catch (error) {
    result.observationError = error.message;
  }
  return result;
}

function joinFrames({
  delivered,
  frames,
  saved,
  source,
  reservation,
  reads,
  bounds,
  clock,
  stopAt,
}) {
  const { beforeSpawn, heldAt, resumeRequested, resumeConfirmed, exit } = bounds;
  assert.ok(
    beforeSpawn < bounds.observation.installedMonotonic &&
      bounds.observation.installedMonotonic <= heldAt &&
      heldAt < resumeRequested &&
      resumeRequested <= resumeConfirmed &&
      resumeConfirmed < exit.monotonic &&
      exit.monotonic < stopAt,
    "secondary monotonic intervals",
  );
  assert.ok(
    resumeConfirmed < bounds.exitHook && bounds.exitHook <= exit.monotonic,
    "secondary exit clock",
  );
  assert.equal(saved.frames.length, frames.length, "complete history through release");
  assert.equal(saved.frameCount, frames.length);
  const phases = { before: [], heldEntry: [], resumed: [], after: [] };
  const exchanges = [];
  const origin = frames[0].elapsedMs;
  const matches = new Map(reads.map((r, i) => [r.value, i]));
  let previous;
  for (const [i, f] of frames.entries()) {
    assert.equal(f.sequence, reservation.firstSequence + i, "consecutive recording sequences");
    assert.equal(f.status, "ok");
    assert.equal(f.gap, undefined);
    assert.equal(f.sourceRevision, source.provenance.sourceRevision);
    assert.equal(f.values.length, 1);
    assert.equal(f.values[0].channelId, source.channel.channelId);
    const value = f.values[0].value,
      index = matches.get(value),
      wire = reads[index];
    assert.ok(wire, "frame missing peer value");
    assert.equal(f.program, wire.program, "wire program state");
    // sampledAt is stamped after the HID response. Permit 1 ms wall quantization
    // and at most 100 ms from an exchange to the sampler accepting its value.
    const { start, end, earliestReceipt } = exchangeInterval(clock, wire, f, delivered[i]);
    exchanges.push({ sequence: f.sequence, start, end });
    if (previous) {
      assert.equal(index, previous.index + 1, "wire replay or skipped read during recording");
      assert.equal(wire.epoch, previous.wire.epoch, "device reopened");
      // reserve() may schedule the second read immediately. Later automatic
      // reads start on a 500 ms timer set in Sampler.fresh().finally(). Use
      // the earliest possible host receipt and allow 1 ms timer rounding.
      if (i > 1) assert.ok(wire.at - previous.earliestReceipt >= 499, "peer request cadence");
      // Sampler.snapshot() considers a successful sample fresh through 2500 ms.
      // Require freshness from one host receipt through the next.
      const elapsed = f.elapsedMs - frames[i - 1].elapsedMs;
      assert.ok(
        elapsed > 0 && elapsed <= freshnessMs && (i === 1 || elapsed >= 499),
        "sampler freshness gap",
      );
      assert.ok(
        Math.abs(elapsed - (wire.end - previous.wire.end)) < 100,
        "session clock disagrees with wire",
      );
    }
    previous = { index, wire, earliestReceipt };
    assert.deepEqual(saved.frames[i], {
      sequence: f.sequence,
      sourceRevision: f.sourceRevision,
      values: [value],
      segment: 0,
      status: "ok",
      program: f.program,
      sampledAt: f.sampledAt,
      sessionElapsedMs: f.elapsedMs,
      elapsedMs: f.elapsedMs - origin,
    });
    if (end < beforeSpawn) phases.before.push(f.sequence);
    else if (end < resumeConfirmed) phases.heldEntry.push(f.sequence);
    else if (start > resumeConfirmed && end < bounds.exitHook) phases.resumed.push(f.sequence);
    else if (start > exit.monotonic && end < stopAt) phases.after.push(f.sequence);
    // Never credit transition windows or the delay after exit as during.
  }
  assert.ok(phases.before.length >= 3, "fresh pre-launch frames");
  assert.ok(phases.after.length >= 1, "fresh post-exit frame");
  const bracket = recordingBracket(exchanges, bounds, bounds.exitHook);
  assert.ok(bracket.before && bracket.after, "complete bracketing endpoints");
  // All entries in exchanges have passed the consecutive broker, wire and
  // history joins above, including entries that cross a lifetime boundary.
  const before = bracket.before.sequence - reservation.firstSequence;
  const after = bracket.after.sequence - reservation.firstSequence;
  assert.ok(
    bracket.gapMs <= freshnessMs &&
      frames[after].elapsedMs - frames[before].elapsedMs <= freshnessMs,
    "recording bracket exceeds sampler freshness gap",
  );
  for (let i = before + 1; i <= after; i++)
    assert.ok(
      exchanges[i].start - exchanges[i - 1].end <= freshnessMs,
      "exchange gap exceeds sampler freshness",
    );
  return { phases, bracket };
}

export async function verifyContinuity(file) {
  const dir = path.dirname(file);
  const r = JSON.parse(await readFile(file, "utf8"));
  assert.equal(r.kind, "installed-single-instance-recording");
  assert.equal(r.recording.criterion, RECORDING_CRITERION, "recording continuity criterion");
  assert.equal(r.syntheticHost, false);
  assert.equal(r.isolated, true);
  assert.equal(r.error, undefined);
  assert.equal(r.finalizationError, undefined);
  assert.deepEqual(r.blockers, []);
  assert.ok(
    ["partial", "passed"].includes(r.status),
    "recording receipt had an unsuccessful execution",
  );
  assert.deepEqual(r.unrun, r.status === "partial" ? ["primaryRecordingInterrupted"] : []);
  assert.deepEqual(r.recording.missing, []);
  assert.deepEqual(r.recording.unexpectedPauses, []);
  if (r.status === "partial") assert.equal(r.primaryRecordingInterrupted, undefined);
  assertInstalledPrimary(r);
  assert.equal(r.runs.length, 2);
  assert.equal(r.copiedExecutableSha256, r.artifact.originalExecutableSha256);
  assert.equal(
    r.runs[0].singleInstance.hashes.before.executable,
    r.artifact.originalExecutableSha256,
  );
  const [run, restart] = r.runs,
    secondary = run.singleInstance.secondary,
    recording = r.recording;
  assert.equal(restart.name, "recording-history");
  const transcripts = [];
  for (const row of [run, restart]) {
    const raw = async (suffix) => {
      const bytes = await readFile(path.join(dir, row.name + suffix));
      assert.equal(digest(bytes), row.recordingArtifactHashes[suffix], "raw artifact " + suffix);
      return bytes.toString();
    };
    const events = JSON.parse(await raw("-debugger.json"));
    const [entry, ...later] = events;
    assert.equal(entry.event, "primary-paused");
    assert.equal(entry.reason, "Break on start");
    assert.equal(entry.pid, row.pid);
    assert.deepEqual(
      later,
      row === run
        ? [
            { event: "before-spawn", at: secondary.beforeSpawn },
            { event: "secondary-resumed", pid: secondary.pid, at: secondary.resumeConfirmed },
          ]
        : [],
      "recorded debugger events",
    );
    const messages = JSON.parse(await raw("-port.json"));
    const releases = JSON.parse(await raw("-release.json"));
    const workers = JSON.parse(await raw("-workers.json"));
    const output = await raw(".log");
    only(
      output.split(/\r?\n/).filter((line) => line === "KOBRIXA_INSTALLED_RESTORED"),
      "shutdown probe restoration",
    );
    const emitted = output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("KOBRIXA_INSTALLED_WORKER "))
      .map((line) => JSON.parse(line.substring(line.indexOf(" ") + 1)));
    for (const [index, row] of emitted.entries())
      assert.equal(row.sequence, index, "worker sequence in process log arrival order");
    assert.deepEqual(
      emitted.slice(0, workers.length),
      workers,
      "worker output reconciles with timeline",
    );
    assert.deepEqual(emitted, row.workerTimeline);
    assert.ok(
      emitted
        .slice(workers.length)
        .every((x) => !["publish", "publication-result"].includes(x.event)),
      "late publication",
    );
    transcripts.push({ messages, releases, workers });
  }
  const wire = transcripts[0].messages,
    history = transcripts[1].messages;
  const log = await readFile(path.join(dir, "single-instance-secondary.log"));
  secondaryExit(log, secondary);
  assert.deepEqual(transcripts[1].releases, [], "unexpected restarted broker release");
  assert.notEqual(restart.pid, run.pid);
  assert.equal(restart.profile, run.profile);
  for (const row of [run, restart]) {
    assert.equal(row.identity.packaged, true);
    assert.equal(row.probeBeforeReady, true);
    assert.ok(row.observedPids.includes(row.pid));
    assert.ok(row.fiveSecondCleanup.endedAt - row.fiveSecondCleanup.startedAt >= 5000);
    assert.deepEqual(row.fiveSecondCleanup.remainingPids, []);
    assert.ok(path.posix.isAbsolute(row.identity.appPath));
    assert.equal(row.identity.appPath, run.identity.appPath);
    assert.equal(row.identity.userData, run.profile);
    assert.equal(row.identity.executable, run.identity.executable);
    assert.equal(row.gracefulQuit, true);
    assert.equal(row.exit.code, 0);
    assert.equal(row.exit.signal, null);
    assert.equal(row.probeRestored, true);
    assert.deepEqual(row.remainingPids, []);
    assert.equal(row.forcedCleanup, false);
    assert.equal(row.error, undefined);
    assert.equal(row.cleanupErrors, undefined);
    for (const key of ["network", "checkout", "worktree", "dependency"])
      assert.ok(["EPERM", "EACCES"].includes(row.isolation[key]), key);
    const lab = only(
      row.forks.filter((f) => f.serviceName === "Kobrixa plugin kobrixa.sensor-lab"),
      "original Lab utility",
    );
    assert.equal(lab.exited, true);
    assert.equal(
      lab.cwd,
      path.posix.join(row.identity.appPath + ".unpacked", ".vite/build/plugins/sensor-lab"),
    );
    assert.equal(lab.entry, path.posix.join(lab.cwd, "main.cjs"));
    assert.equal(lab.owner.pluginId, "kobrixa.sensor-lab");
    assert.equal(lab.owner.sourceKey, "builtin:kobrixa.sensor-lab");
    assert.match(lab.owner.hostEpoch, uuid);
    assert.match(lab.owner.processEpoch, uuid);
    assert.ok(Number.isSafeInteger(lab.owner.generation));
    for (const msg of row === run ? wire : history) {
      assert.equal(msg.pid, row.pid);
      assert.equal(msg.utility, lab.pid);
      assert.deepEqual(msg.owner, lab.owner, "changed recording owner");
    }
  }
  const owner = wire[0].owner;
  assert.notEqual(owner.hostEpoch, history[0].owner.hostEpoch);
  assert.notEqual(owner.processEpoch, history[0].owner.processEpoch);
  for (const phase of [run.singleInstance.before, run.singleInstance.after]) {
    const lab = only(
      phase.forks.filter((f) => f.serviceName === "Kobrixa plugin kobrixa.sensor-lab"),
      "active Lab utility",
    );
    assert.equal(lab.exited, false);
    assert.equal(lab.pid, wire[0].utility);
    assert.deepEqual(lab.owner, owner);
  }
  const start = command(wire, "start"),
    binding = start.params.context.binding;
  for (const key of ["generation", "hostEpoch", "processEpoch"])
    assert.equal(binding[key], owner[key]);
  const reserve = only(pairs(wire, "devices/recording/reserve"), "one recording reserve");
  const { reservation, firstFrame } = reserve.value;
  assert.match(reservation.reservationId, uuid);
  assert.match(reservation.sessionId, uuid);
  for (const phase of ["before", "after"])
    assert.deepEqual(
      run.singleInstance[phase].lab,
      { binding, reservation: reservation.reservationId },
      "Lab instance and reservation at " + phase,
    );
  assert.equal(binding.contributionId, "kobrixa.sensor-lab.panel");
  assert.equal(binding.kind, "panel");
  assert.equal(start.params.context.form.values["recording-name"], recording.name);
  assert.equal(reservation.state, "active");
  assert.equal(reservation.reason, "active");
  assert.ok(start.at <= reserve.at && reserve.end <= start.end);
  const channel = only(reservation.channels, "single pinned channel");
  const select = command(wire, "select-channel");
  assert.equal(select.params.arguments.key, channel.channelId);
  assert.ok(select.end <= start.at);
  assert.deepEqual(select.params.context.binding, binding);
  assert.deepEqual(reserve.params.channelIds, [channel.channelId]);
  assert.equal(channel.portId, "input:0");
  assert.equal(reserve.params.sessionId, reservation.sessionId);
  assert.equal(channel.kind, "input");
  assert.equal(channel.typeId, "ev3:29");
  assert.equal(channel.modeId, "mode:0");
  assert.equal(channel.component, 0);
  assert.equal(channel.state, "ready");
  const sessions = pairs(wire, "devices/session").map((x) => x.value.session);
  assert.ok(sessions.length > 0, "provider generation");
  const notifications = wire
    .filter(
      (q) =>
        q.message.method === "events/deliver" && q.at >= reserve.at && q.at <= recording.stopAt,
    )
    .map((q) => q.message.params);
  for (const e of notifications) {
    assert.deepEqual(e.owner, owner, "notification owner");
    if (e.kind === "devices.session") sessions.push(e.data.session);
    if (e.kind === "devices.reservation") {
      assert.equal(e.data.reservationId, reservation.reservationId);
      assert.equal(e.data.reason, "active");
      assert.equal(e.data.state, "active");
      assert.equal(e.data.sessionId, reservation.sessionId);
    }
    assert.notEqual(e.kind, "events.resyncRequired", "recording observation overflow");
  }
  for (const s of sessions) {
    assert.equal(s.state, "connected");
    assert.equal(s.transport, "usb");
    assert.equal(s.name, "Kobrixa UHID spike");
    assert.equal(s.sessionId, reservation.sessionId);
    assert.equal(s.providerGeneration, sessions[0].providerGeneration);
    assert.ok(Number.isSafeInteger(s.providerGeneration));
    assert.equal(s.sourceRevision, reserve.params.expectedSourceRevision);
    assert.equal(s.providerId, "kobrixa.device-ev3");
  }
  assert.equal(
    recording.releaseObservationError,
    undefined,
    "missing original host release reply: " + recording.releaseObservationError,
  );
  const release = only(transcripts[0].releases, "original core Stop broker release reply");
  assert.equal(release.primary, run.pid);
  assert.deepEqual(release.owner, owner);
  assert.equal(release.reservationId, reservation.reservationId);
  assert.ok(release.at >= recording.stopAt);
  assert.equal(release.result.ok, true);
  const terminal = release.result.value.reservation;
  assert.equal(terminal.state, "ended");
  assert.equal(terminal.reason, "released");
  assert.deepEqual(pairs(wire, "devices/recording/release"), [], "no second SDK release");
  const frames = [firstFrame],
    delivered = [reserve.end];
  for (const method of ["devices/recording/query", "devices/recording/read"])
    for (const q of pairs(wire, method).filter(
      (q) => q.end < recording.stopAt && q.at >= reserve.end,
    )) {
      assert.equal(q.value.reservation.state, "active", "recording ended before stop");
      assert.equal(q.value.reservation.reason, "active");
    }
  for (const read of pairs(wire, "devices/recording/read")) {
    assert.equal(read.params.reservationId, reservation.reservationId);
    assert.equal(read.params.afterSequence, frames.at(-1).sequence);
    assert.equal(read.value.gap, null);
    frames.push(...read.value.frames);
    delivered.push(...read.value.frames.map(() => read.end));
    assert.equal(read.value.nextSequence, frames.at(-1).sequence, "broker read cursor");
  }
  for (const snap of [
    terminal,
    ...["devices/recording/read", "devices/recording/query"].flatMap((m) =>
      pairs(wire, m).map((q) => q.value.reservation),
    ),
  ]) {
    for (const key of ["reservationId", "sessionId", "firstSequence", "channels"])
      assert.deepEqual(snap[key], reservation[key], "reservation " + key);
    assert.ok(
      snap.reason === "active" ||
        (snap.reason === "released" && snap.lastSequence === terminal.lastSequence),
    );
  }
  assert.equal(frames.at(-1).sequence, terminal.lastSequence, "read through release");
  const checkpoint = only(pairs(wire, "storage/registerCheckpoint"), "recording checkpoint");
  assert.equal(checkpoint.params.reservation, reservation.reservationId);
  const creates = pairs(wire, "storage/beginWrite");
  const initial = only(
    creates.filter((b) => b.params.target.mode === "create"),
    "one model creation",
  );
  assert.equal(initial.value.id, checkpoint.params.id);
  const commits = pairs(wire, "storage/commitWrite");
  assert.equal(creates.length, commits.length, "all recording writes have receipts");
  let previousRevision = null;
  for (const begin of creates) {
    if (previousRevision !== null) {
      assert.equal(begin.params.target.mode, "replace");
      assert.equal(begin.params.target.id, checkpoint.params.id);
      assert.equal(begin.params.target.expectedRevision, previousRevision);
      assert.equal(begin.params.checkpoint.handle, checkpoint.value.checkpoint);
    }
    const committed = only(
      commits.filter((c) => c.params.write === begin.value.write),
      "matching recording commit",
    );
    assert.equal(committed.value.record.id, checkpoint.params.id);
    assert.equal(begin.params.sha256, committed.value.record.sha256);
    assert.equal(begin.params.byteLength, committed.value.record.byteLength);
    previousRevision = committed.value.record.revision;
  }
  const first = only(
    commits.filter((c) => c.params.write === initial.value.write),
    "initial commit",
  );
  assert.equal(first.value.record.revision, checkpoint.params.expectedRevision);
  const initialModel = JSON.parse(
    joinedChunks(
      pairs(wire, "storage/writeChunk").filter((c) => c.params.write === initial.value.write),
      first.value.record,
      false,
    ),
  );
  const final = only(
    creates.filter((b) => b.params.checkpoint?.phase === "final"),
    "final write",
  );
  assert.equal(final.params.checkpoint.handle, checkpoint.value.checkpoint);
  assert.equal(final.params.target.id, checkpoint.params.id);
  const finalCommit = only(
    commits.filter((c) => c.params.write === final.value.write),
    "final commit",
  );
  const meta = finalCommit.value.record;
  const drain = only(
    pairs(wire, "storage/drain", "host-plugin").filter(
      (d) => d.params.token === final.params.drainToken,
    ),
    "original drain",
  );
  assert.equal(drain.value.status, "submitted");
  assert.deepEqual(drain.value.writes, [final.value.write]);
  const offer = only(
    drain.params.checkpoints.filter((c) => c.checkpoint === checkpoint.value.checkpoint),
    "final checkpoint grant",
  );
  assert.deepEqual(offer.reservationEnd, {
    reservationId: reservation.reservationId,
    lastSequence: terminal.lastSequence,
    reason: "released",
  });
  assert.equal(offer.record.id, meta.id);
  assert.equal(meta.id, checkpoint.params.id);
  assert.equal(meta.revision, previousRevision);
  assert.equal(meta.checkpoint, "final");
  assert.equal(meta.interrupted, false);
  for (const { value } of commits) {
    const worker = only(
      transcripts[0].workers.filter(
        (x) =>
          x.event === "publish" &&
          x.request.args[0].metadata.record?.revision === value.record.revision,
      ),
      "persistence worker publication",
    );
    assert.equal(worker.pid, run.pid);
    assert.deepEqual(worker.request.args[0].owner, owner);
    assert.deepEqual(worker.request.args[0].metadata.record, value.record);
    assert.equal(
      worker.worker,
      only(
        run.singleInstance.before.workerStarts.filter((w) =>
          String(w.arguments?.[0]).includes("persistence-worker"),
        ),
        "original persistence worker",
      ).worker,
    );
    const reply = only(
      transcripts[0].workers.filter(
        (x) =>
          x.worker === worker.worker &&
          x.event === "publication-result" &&
          x.response.id === worker.request.id,
      ),
      "persistence worker acknowledgement",
    );
    assert.ok(reply.sequence > worker.sequence, "acknowledgement precedes publication");
    assert.equal(reply.response.ok, true);
    assert.equal(reply.response.value.disposition, "committed");
    assert.equal(value.receipt.revision, value.record.revision);
    assert.match(value.receipt.commitId, uuid);
    assert.deepEqual(value.receipt, reply.response.value.receipt);
  }
  assert.equal(meta.sha256, final.params.sha256);
  assert.equal(meta.byteLength, final.params.byteLength);
  assert.equal(first.value.record.id, meta.id);
  assert.equal(final.params.target.expectedRevision, offer.record.revision);
  assert.ok(meta.revision !== offer.record.revision);
  const view = command(history, "view-record");
  const restartedBinding = command(history, "refresh").params.context.binding;
  assert.deepEqual(view.params.context.binding, restartedBinding, "restarted panel binding");
  for (const key of ["generation", "hostEpoch", "processEpoch"])
    assert.equal(restartedBinding[key], history[0].owner[key], "restarted Lab owner");
  // Lab obtains the host snapshot when it opens a panel. Bind the command
  // to the instance returned by that restarted host, including panelInstance.
  assert.ok(
    history.some(
      (q, i) =>
        q.direction === "plugin-host" &&
        q.message.method === "ui/state" &&
        isDeepStrictEqual(q.message.params.binding, restartedBinding) &&
        history
          .slice(i + 1)
          .some(
            (reply) =>
              reply.at <= view.at &&
              reply.direction === "host-plugin" &&
              !reply.message.method &&
              reply.message.id === q.message.id &&
              reply.message.result?.ok === true &&
              isDeepStrictEqual(reply.message.result.value.binding, restartedBinding),
          ),
    ),
    "restarted host panel state",
  );
  assert.equal(restartedBinding.kind, "panel");
  assert.equal(restartedBinding.contributionId, "kobrixa.sensor-lab.panel");
  assert.match(restartedBinding.panelInstance, uuid);
  assert.notEqual(restartedBinding.panelInstance, binding.panelInstance);
  assert.equal(view.params.arguments.key, meta.id);
  assert.ok(
    pairs(history, "storage/list").some(
      (q) =>
        q.params.kind === "sensor-lab.recording" &&
        q.value.entries.some((e) => e.id === meta.id && e.revision === meta.revision),
    ),
    "restarted public library entry",
  );
  const opened = only(
    pairs(history, "storage/openRead").filter((x) => x.at >= view.at && x.end <= view.end),
    "public history record",
  );
  assert.deepEqual(opened.value.record, meta);
  const bytes = await readFile(path.join(dir, "recording-history.json"));
  assert.deepEqual(bytes, historyBytes(history), "retained readback");
  const finalChunks = pairs(wire, "storage/writeChunk").filter(
    (c) => c.params.write === final.value.write,
  );
  assert.ok(
    finalChunks.every((c) => c.at >= final.end && c.end <= finalCommit.at),
    "final write window",
  );
  assert.deepEqual(joinedChunks(finalChunks, meta, false), bytes, "final publication bytes");
  const saved = JSON.parse(bytes);
  assert.equal(saved.schemaVersion, 2);
  assert.equal(saved.name, initialModel.name);
  assert.equal(saved.startedAt, initialModel.startedAt);
  assert.deepEqual(saved.recordingOrigin, initialModel.recordingOrigin);
  assert.deepEqual(saved.frames[0], initialModel.frames[0]);
  assert.deepEqual(saved.channels, initialModel.channels);
  assert.match(saved.id, uuid);
  assert.equal(saved.id, initialModel.id);
  assert.match(recording.name, /^P4-[0-9a-f-]{36}$/);
  assert.equal(saved.name, recording.name);
  assert.equal(saved.reason, "manual");
  assert.deepEqual(saved.recordingOrigin, {
    providerId: sessions[0].providerId,
    sessionId: reservation.sessionId,
    sessionElapsedMs: firstFrame.elapsedMs,
  });
  const { source } = only(saved.channels, "saved source");
  assert.equal(source.origin, "public");
  assert.deepEqual(source.channel, channel);
  assert.deepEqual(source.provenance, {
    providerId: sessions[0].providerId,
    sessionId: reservation.sessionId,
    sourceRevision: reserve.params.expectedSourceRevision,
  });
  const trace = await readFile(path.join(dir, "peer-trace.log"));
  assert.equal(digest(trace), recording.traceSha256, "selected peer trace digest");
  assert.equal(recording.device.connection, "Kobrixa UHID spike · connected");
  assert.ok(
    Number.isSafeInteger(recording.device.offset) &&
      recording.device.offset >= 0 &&
      recording.device.offset < trace.length,
  );
  const reads = parseTrace(trace.subarray(recording.device.offset).toString());
  const firstWire = reads.find((x) => x.value === firstFrame.values[0].value);
  assert.ok(
    firstWire && firstWire.at >= reserve.at && firstWire.end <= reserve.end,
    "fresh wire read in original reserve call",
  );
  const lastWire = reads.find((x) => x.value === frames.at(-1).values[0].value);
  assert.ok(
    lastWire && release.at >= lastWire.end && release.at - lastWire.end < 1000,
    "sampler cadence through actual release",
  );
  const { phases, bracket } = joinFrames({
    frames,
    delivered,
    saved,
    source,
    reservation,
    reads,
    bounds: { ...secondary, exitHook: secondary.observation.exitMonotonic },
    clock: wire,
    stopAt: recording.stopAt,
  });
  const launchClock = clockBounds(wire, secondary.beforeSpawn, secondary.exit.monotonic);
  const profileWriteAudit = verifyProfileWrites(
    JSON.parse(await readFile(path.join(dir, "profile-audit.json"), "utf8")),
    await readFile(path.join(dir, "profile-audit.log"), "utf8"),
    run.profile,
    "p4-" + recording.name.slice(3, 27),
    run.pid,
    secondary,
    launchClock,
    {
      start: bracket.before.start,
      end: bracket.after.end,
      clock: clockBounds(wire, bracket.before.start, bracket.after.end),
    },
  );
  const resumeWindow = await measureResumeWindow(dir, run, recording);
  assert.deepEqual(resumeWindow.bracket, bracket, "measured recording bracket");
  assert.equal(resumeWindow.holdCompleteExchanges, phases.heldEntry.length, "measured hold count");
  assert.equal(resumeWindow.completeExchanges, phases.resumed.length, "measured overlap count");
  const derived = {
    profileWriteAudit,
    resumeWindow,
    status: "passed",
    unrun: [],
    primaryRecordingInterrupted: false,
    phases,
  };
  if (r.status === "passed")
    for (const [key, value] of Object.entries(derived))
      assert.deepEqual(r[key], value, "receipt differs from raw evidence: " + key);
  return derived;
}
