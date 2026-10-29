import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pluginId = "kobrixa.sensor-lab";
const ok = (result) => {
  assert.equal(result?.ok, true, JSON.stringify(result));
  return result.value;
};

/** Inert pure oracle: build success or a submitted receipt alone cannot pass. */
export function verifyLabReceipt(report, { requireParity = false } = {}) {
  if (requireParity) assert.ok(report.checkpoints?.parity, "D7 parity extension required");
  if (report.checkpoints?.parity) {
    const boundary = report.checkpoints.history;
    const base = verifyLabReceipt({
      ...report,
      checkpoints: { ...report.checkpoints, parity: undefined },
      wire: report.wire.filter((row) => row.sequence <= boundary.sequence),
      ipc: report.ipc.filter((row) => row.at <= boundary.at),
      brokerCalls: report.brokerCalls.filter((row) => row.at <= boundary.at),
      drains: report.drains.filter((row) => row.at <= boundary.at),
    });
    return { ...base, parity: verifyLabParity(report) };
  }
  assert.equal(report.schema, 1);
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.equal(report.launches.length, 1, "Exactly the original bundled Lab process");
  const owner = report.launches[0].owner;
  assert.equal(owner.pluginId, pluginId);
  assert.equal(owner.sourceKey, `builtin:${pluginId}`);
  for (const key of ["hostEpoch", "generation", "processEpoch"])
    assert.ok(owner[key] !== undefined);
  assert.equal(report.exits.length, 1);
  assert.deepEqual(report.exits[0].owner, owner);
  assert.ok(report.exits[0].at > report.checkpoints.history.at);
  const freeze = report.gate.find((r) => r.phase === "gate-freeze");
  const settled = report.gate.find((r) => r.phase === "gate-settled");
  assert.ok(
    freeze && settled && freeze.at <= settled.at && settled.at <= report.launches[0].at,
    "Real legacy barrier before activation/launch",
  );
  for (const row of report.wire) assert.deepEqual(row.owner, owner, "No replacement owner");
  const pairs = (method, direction = "plugin-host") =>
    report.wire
      .filter((r) => r.direction === direction && r.message.method === method)
      .map((request) => {
        const responses = report.wire.filter(
          (r) =>
            r.sequence > request.sequence &&
            r.direction !== direction &&
            r.message.id === request.message.id &&
            !r.message.method,
        );
        assert.equal(responses.length, 1, `Exactly one original response: ${method}`);
        return {
          request,
          response: responses[0],
          params: request.message.params,
          value: ok(responses[0].message.result),
        };
      });
  const commands = pairs("command/invoke", "host-plugin");
  for (const name of [
    "select-current",
    "select-channel",
    "capture-a",
    "apply",
    "start",
    "refresh",
    "view-record",
  ]) {
    const rows = commands.filter((r) => r.params.command === `${pluginId}.${name}`);
    assert.equal(rows.length, 1, `One native command ${name}, no auto replay`);
    assert.equal(rows[0].params.context.origin, "panel");
    assert.ok(rows[0].params.context.binding);
    assert.deepEqual(rows[0].value.fieldErrors, []);
  }
  const form = report.checkpoints.applied.state.form;
  assert.equal(form["two-point"], true);
  assert.equal(form["source-a"], "42");
  assert.equal(form["source-b"], "100");
  assert.equal(form["target-b"], "200");
  assert.ok(
    report.ipc.some((r) => r.channel === "plugins:ui:form-sync" && r.result?.ok === true),
    "Native draft crossed canonical syncForm port",
  );
  assert.ok(
    pairs("ui/formPatch").some((r) => r.params.set["source-a"] === "42"),
    "Original SDK Capture A patched canonical form",
  );
  const reserve = pairs("devices/recording/reserve");
  assert.equal(reserve.length, 1);
  const reservation = reserve[0].value.reservation;
  assert.ok(reservation);
  const registered = pairs("storage/registerCheckpoint");
  assert.equal(registered.length, 1);
  assert.equal(registered[0].params.reservation, reservation.reservationId);
  const checkpoint = registered[0].value.checkpoint;
  const background = report.checkpoints.background;
  assert.equal(background.launchCount, 1);
  assert.equal(background.exitCount, 0);
  assert.deepEqual(background.owner, owner);
  const closed = report.ipc.find((r) => r.channel === "plugins:ui:close" && r.result?.ok === true);
  assert.ok(closed && closed.at < background.at);
  assert.ok(
    pairs("devices/recording/read").some(
      (r) =>
        r.request.at > closed.at &&
        r.response.at <= background.at &&
        r.params.reservationId === reservation.reservationId &&
        r.value.frames.length > 0,
    ),
    "Original recording continued while panel closed",
  );
  const stops = report.ipc.filter(
    (r) =>
      r.channel === "plugins:ui:interact" &&
      r.args[0]?.kind === "core" &&
      r.args[0]?.actionId === "stop",
  );
  assert.equal(stops.length, 1);
  ok(stops[0].result);
  assert.equal(stops[0].args[0].binding.kind, "status");
  assert.ok(stops[0].at >= background.at);
  assert.ok(
    report.native.some(
      (r) =>
        r.type === "pointerdown" &&
        r.isTrusted &&
        r.status &&
        r.at >= background.at &&
        r.at <= stops[0].at,
    ),
    "Trusted status input preceded core admission",
  );
  const releases = report.brokerCalls.filter((r) => r.method === "devices/recording/release");
  assert.equal(releases.length, 1, "Exactly one actual broker release");
  assert.equal(releases[0].principal.kind, "plugin");
  assert.deepEqual(releases[0].principal.owner, owner);
  assert.equal(releases[0].params.reservationId, reservation.reservationId);
  assert.ok(releases[0].at >= stops[0].at);
  ok(releases[0].result);
  // Core Stop is host-side: the SDK must not receive an invented panel command.
  assert.ok(!commands.some((r) => r.params.command === `${pluginId}.stop`));
  const drain = report.drains.find((d) =>
    d.offer.checkpoints.some((c) => c.checkpoint === checkpoint),
  );
  assert.ok(drain, "Original checkpoint is present in actual host drain offer");
  assert.deepEqual(drain.offer.owner, owner);
  assert.equal(drain.report?.state, "saved");
  assert.equal(drain.report.blocker, false);
  assert.deepEqual(drain.report.errors, []);
  assert.ok(drain.at >= stops[0].at);
  const submitted = pairs("storage/drain", "host-plugin").find(
    (r) => r.params.token === drain.offer.token,
  );
  assert.ok(submitted);
  assert.equal(submitted.value.status, "submitted");
  const begin = pairs("storage/beginWrite").find(
    (r) =>
      r.params.drainToken === drain.offer.token &&
      r.params.checkpoint?.handle === checkpoint &&
      r.params.checkpoint.phase === "final",
  );
  assert.ok(begin, "A new final write uses the original checkpoint and drain token");
  assert.equal(begin.params.target.mode, "replace");
  assert.equal(begin.params.target.id, registered[0].params.id);
  const write = begin.value.write;
  assert.deepEqual(submitted.value.writes, [write]);
  const commit = pairs("storage/commitWrite").find((r) => r.params.write === write);
  assert.ok(commit);
  assert.equal(commit.params.drainToken, drain.offer.token);
  const meta = commit.value.record;
  assert.equal(meta.id, registered[0].params.id);
  assert.equal(meta.checkpoint, "final");
  assert.equal(meta.interrupted, false);
  assert.equal(meta.sha256, begin.params.sha256);
  assert.equal(meta.byteLength, begin.params.byteLength);
  assert.ok(
    drain.report.records.some(
      (r) => r.id === meta.id && r.committedRevision === meta.revision && r.final,
    ),
  );
  const stat = pairs("storage/stat").find(
    (r) =>
      r.request.at > drain.finishedAt &&
      r.params.id === meta.id &&
      r.value.record.revision === meta.revision,
  );
  assert.ok(stat, "Original SDK stat after actual host saved");
  assert.deepEqual(stat.value.record, meta);
  assert.notDeepEqual(
    report.checkpoints.open.state.binding,
    report.checkpoints.reopened.state.binding,
    "Reopen has new binding",
  );
  const opened = pairs("storage/openRead").find(
    (r) => r.params.id === meta.id && r.params.expectedRevision === meta.revision,
  );
  assert.ok(opened);
  assert.deepEqual(opened.value.record, meta);
  const chunks = pairs("storage/readChunk").filter((r) => r.params.read === opened.value.read);
  let offset = 0;
  const bytes = Buffer.concat(
    chunks.map((r, i) => {
      const bytes = Buffer.from(r.value.data, "base64");
      assert.equal(bytes.toString("base64"), r.value.data);
      assert.equal(r.params.offset, offset);
      assert.equal(r.value.offset, offset);
      offset += bytes.length;
      assert.equal(r.value.nextOffset, offset);
      assert.equal(r.value.eof, i === chunks.length - 1);
      return bytes;
    }),
  );
  assert.equal(bytes.length, meta.byteLength);
  assert.equal(digest(bytes), meta.sha256);
  const payload = JSON.parse(bytes.toString("utf8"));
  // Payload UUID and host storage ID are separate identities. Pin both to
  // the original creation instead of assuming their values happen to match.
  const created = pairs("storage/beginWrite").find(
    (r) => r.params.target.mode === "create" && r.value.id === meta.id,
  );
  assert.ok(created, "Original create selected this host record ID");
  const initialChunks = pairs("storage/writeChunk").filter(
    (r) => r.params.write === created.value.write,
  );
  let initialOffset = 0;
  const initialBytes = Buffer.concat(
    initialChunks.map((r) => {
      assert.equal(r.params.offset, initialOffset);
      const chunk = Buffer.from(r.params.data, "base64");
      initialOffset += chunk.length;
      return chunk;
    }),
  );
  assert.equal(initialBytes.length, created.params.byteLength);
  assert.equal(digest(initialBytes), created.params.sha256);
  const initial = JSON.parse(initialBytes.toString("utf8"));
  assert.match(payload.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.equal(payload.id, initial.id, "Original model identity survives finalization and read");
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.name, "D7 actual Lab");
  assert.equal(payload.channels.length, 1);
  assert.ok(payload.frames.length > 0);
  assert.equal(payload.frameCount, payload.frames.length);
  assert.ok(
    report.ipc.some(
      (r) =>
        r.channel === "plugins:ui:data-read" &&
        r.at > opened.request.at &&
        r.result?.ok === true &&
        r.result.value.header.view === "full" &&
        r.args[0].dataset === "chart0",
    ),
    "Generic renderer consumed saved full-domain chart",
  );
  assert.ok(payload.frames.some((f) => f.values[0] === 42 && f.status === "ok"));
  assert.equal(payload.channels[0].source.origin, "public");
  assert.equal(payload.channels[0].source.provenance.sessionId, reserve[0].params.sessionId);
  assert.equal(
    payload.channels[0].source.provenance.sourceRevision,
    reserve[0].params.expectedSourceRevision,
  );
  assert.deepEqual(payload.channels[0].calibration, {
    twoPoint: true,
    sourceA: 42,
    sourceB: 100,
    targetA: 0,
    targetB: 200,
    zeroOffset: 0,
    unit: form.unit,
  });
  assert.ok(report.native.some((r) => r.type === "pointerdown" && r.isTrusted && r.close));
  assert.ok(report.native.some((r) => r.type === "input" && r.isTrusted && r.node === "target-b"));
  for (const counters of [report.cleanup.bridge, report.cleanup.worker])
    for (const [name, value] of Object.entries(counters)) assert.equal(value, 0, `Cleanup ${name}`);
  assert.equal(report.cleanup.workers, 0);
  return {
    owner,
    record: meta,
    reservation: reservation.reservationId,
    checkpoint,
    finalWrite: write,
    payloadSha256: digest(bytes),
    frames: payload.frames.length,
  };
}

// Additional native slice. Historical/installed receipts retain the base verifier contract.
export function verifyLabParity(report) {
  const p = report.checkpoints.parity;
  assert.ok(p, "D7 parity extension required");
  const owner = report.launches[0].owner;
  let sequence = -1;
  for (const row of report.wire) {
    assert.deepEqual(row.owner, owner);
    assert.ok(row.sequence > sequence);
    sequence = row.sequence;
  }
  const pairs = (method, direction = "plugin-host") =>
    report.wire
      .filter((row) => row.direction === direction && row.message.method === method)
      .map((request) => {
        const replies = report.wire.filter(
          (row) =>
            row.direction !== direction &&
            !row.message.method &&
            row.message.id === request.message.id &&
            row.sequence > request.sequence,
        );
        assert.equal(replies.length, 1, `Original ${method} reply`);
        return {
          request,
          response: replies[0],
          params: request.message.params,
          value: ok(replies[0].message.result),
        };
      });
  const names = [
    "live-profile",
    "save-profile",
    "list-profile",
    "reset-profile",
    "apply-profile",
    "delete-profile",
    "live-second",
    "start-second",
    "stop-second",
    "list-two",
    "view-first",
    "compare-second",
    "raw",
    "calibrated",
    "live-delete",
    "fresh-history",
    "delete-first",
    "list-after-delete",
  ];
  assert.deepEqual(
    p.steps.map((s) => s.name),
    names,
  );
  let last = report.checkpoints.history.at;
  const step = (name) => p.steps.find((s) => s.name === name);
  for (const s of p.steps) {
    assert.ok(s.at >= last && s.finishedAt >= s.at && s.after >= s.before);
    last = s.finishedAt;
  }
  assert.ok(p.finishedAt >= last && report.exits[0].at > p.finishedAt);
  const within = (row, name) =>
    row.request.sequence > step(name).before && row.response.sequence <= step(name).after;
  const used = new Set();
  const trusted = (ipc, name, expectedNode, dialog = false) => {
    assert.ok(ipc && ipc.at >= step(name).at && ipc.finishedAt <= step(name).finishedAt);
    const drivers = Object.values(report.checkpoints).filter(
      (row) => row.stage === `parity-${name}` && row.at <= ipc.at,
    );
    const events = report.native.filter(
      (e) =>
        e.isTrusted &&
        e.type === "pointerdown" &&
        e.at >= step(name).at &&
        e.at < ipc.at &&
        (dialog
          ? e.dialog === true
          : expectedNode === "#status"
            ? e.status === true
            : e.node === expectedNode) &&
        drivers.some((d) => d.targetId === e.targetId && d.at <= e.at),
    );
    const e = events.at(-1);
    assert.ok(e && !used.has(e), `Distinct native ${name}`);
    used.add(e);
    assert.ok(
      report.native.some(
        (up) =>
          up.type === "pointerup" &&
          up.isTrusted &&
          up.targetId === e.targetId &&
          up.at > e.at &&
          up.at <= ipc.at,
      ),
    );
    return e;
  };
  const commands = pairs("command/invoke", "host-plugin");
  const action = (name, command, node, dialog = false) => {
    const rows = commands.filter(
      (r) => within(r, name) && r.params.command === `${pluginId}.${command}`,
    );
    assert.equal(rows.length, 1, `One ${name} command`);
    const row = rows[0];
    assert.equal(row.params.context.origin, "panel");
    assert.deepEqual(row.value.fieldErrors, []);
    const ipc = report.ipc.find(
      (i) =>
        i.channel === "plugins:ui:interact" &&
        i.result?.ok &&
        i.result.value.invocationId === row.params.invocationId,
    );
    assert.ok(ipc);
    assert.deepEqual(ipc.args[0].binding, row.params.context.binding);
    assert.equal(ipc.args[0].nodeId, node);
    assert.ok(ipc.at <= row.request.at && ipc.finishedAt >= row.response.at);
    trusted(ipc, name, node, dialog);
    return row;
  };
  for (const [name, command, node] of [
    ["live-profile", "live", "live"],
    ["save-profile", "save-profile", "save-profile"],
    ["list-profile", "refresh", "refresh"],
    ["reset-profile", "reset", "reset"],
    ["live-second", "live", "live"],
    ["start-second", "start", "start"],
    ["list-two", "refresh", "refresh"],
    ["live-delete", "live", "live"],
    ["fresh-history", "refresh", "refresh"],
    ["list-after-delete", "refresh", "refresh"],
  ])
    action(name, command, node);
  const pageContains = (dataset, meta, before, binding) =>
    report.ipc.some(
      (i) =>
        i.channel === "plugins:ui:data-read" &&
        i.result?.ok &&
        i.finishedAt < before &&
        i.args[0].dataset === dataset &&
        (!binding || JSON.stringify(i.args[0].binding) === JSON.stringify(binding)) &&
        i.result.value.chunk.entries.some(
          (e) => e.key === meta.id && e.version === String(meta.revision),
        ),
    );
  const rowAction = (name, command, dataset, meta, deleting = false) => {
    const row = action(name, command, deleting ? `delete-${dataset}-confirm` : dataset, deleting);
    assert.equal(row.params.arguments.key, meta.id);
    assert.equal(row.params.arguments.revision, String(meta.revision));
    assert.ok(
      pageContains(dataset, meta, row.request.at, row.params.context.binding),
      `Published ${name} row`,
    );
    const admission = report.ipc.filter(
      (i) =>
        i.channel === "plugins:ui:interact" &&
        i.result?.ok &&
        i.at >= step(name).at &&
        i.finishedAt <= step(name).finishedAt,
    );
    const selected = admission.find(
      (i) =>
        i.args[0].kind === "list" && i.args[0].key === meta.id && i.args[0].dataset === dataset,
    );
    assert.ok(selected);
    assert.equal(selected.args[0].revision, row.params.arguments.dataset);
    assert.ok(
      report.ipc.some(
        (i) =>
          i.channel === "plugins:ui:data-read" &&
          i.result?.ok &&
          i.finishedAt < selected.at &&
          i.args[0].dataset === dataset &&
          i.result.value.revision === selected.args[0].revision &&
          i.result.value.chunk.entries.some(
            (e) => e.key === meta.id && e.version === String(meta.revision),
          ),
      ),
    );
    if (deleting) {
      assert.equal(selected.args[0].actionId, command);
      trusted(selected, name, dataset);
    }
    return row;
  };
  const commits = pairs("storage/commitWrite"),
    begins = pairs("storage/beginWrite");
  const written = (meta) => {
    const commit = commits.find(
      (r) => r.value.record.id === meta.id && r.value.record.revision === meta.revision,
    );
    assert.ok(commit);
    assert.deepEqual(commit.value.record, meta);
    const begin = begins.find((r) => r.value.write === commit.params.write);
    assert.ok(begin);
    let offset = 0;
    const chunks = pairs("storage/writeChunk").filter((r) => r.params.write === begin.value.write);
    const bytes = Buffer.concat(
      chunks.map((r) => {
        assert.equal(r.params.offset, offset);
        const b = Buffer.from(r.params.data, "base64");
        assert.equal(b.toString("base64"), r.params.data);
        offset += b.length;
        return b;
      }),
    );
    assert.equal(bytes.length, meta.byteLength);
    assert.equal(digest(bytes), meta.sha256);
    assert.equal(begin.params.sha256, meta.sha256);
    assert.equal(begin.params.byteLength, meta.byteLength);
    return { commit, begin, payload: JSON.parse(bytes.toString("utf8")) };
  };
  const read = (meta, name) => {
    const opened = pairs("storage/openRead").find(
      (r) =>
        within(r, name) && r.params.id === meta.id && r.params.expectedRevision === meta.revision,
    );
    assert.ok(opened, `Pinned ${name} read`);
    assert.deepEqual(opened.value.record, meta);
    let offset = 0;
    const chunks = pairs("storage/readChunk").filter((r) => r.params.read === opened.value.read);
    const bytes = Buffer.concat(
      chunks.map((r, i) => {
        assert.ok(within(r, name));
        assert.equal(r.params.offset, offset);
        assert.equal(r.value.offset, offset);
        const b = Buffer.from(r.value.data, "base64");
        assert.equal(b.toString("base64"), r.value.data);
        offset += b.length;
        assert.equal(r.value.nextOffset, offset);
        assert.equal(r.value.eof, i === chunks.length - 1);
        return b;
      }),
    );
    assert.equal(bytes.length, meta.byteLength);
    assert.equal(digest(bytes), meta.sha256);
    return JSON.parse(bytes.toString("utf8"));
  };
  assert.notEqual(p.first.id, p.second.id);
  assert.notEqual(p.profile.id, p.first.id);
  assert.notEqual(p.profile.id, p.second.id);
  const profile = written(p.profile);
  assert.ok(within(profile.commit, "save-profile"));
  assert.equal(p.profile.kind, "sensor-lab.calibration");
  assert.equal(profile.payload.name, "D7 saved calibration");
  const first = written(p.first),
    second = written(p.second);
  assert.equal(first.payload.name, "D7 actual Lab");
  assert.equal(second.payload.name, "D7 comparison Lab");
  assert.notEqual(first.payload.id, second.payload.id);
  assert.ok(first.payload.frames.length && second.payload.frames.length);
  assert.deepEqual(profile.payload.calibration, first.payload.channels[0].calibration);
  assert.ok(
    pairs("storage/list").some(
      (r) =>
        within(r, "list-profile") &&
        r.params.kind === "sensor-lab.calibration" &&
        r.value.entries.some((meta) => JSON.stringify(meta) === JSON.stringify(p.profile)),
    ),
    "Original profile listed through SDK",
  );
  rowAction("apply-profile", "apply-profile", "profiles", p.profile);
  assert.deepEqual(read(p.profile, "apply-profile"), profile.payload);
  assert.equal(p.applied.form["source-a"], "42");
  assert.equal(p.applied.form["target-b"], "200");
  assert.deepEqual(second.payload.channels[0].calibration, profile.payload.calibration);
  const reservation = pairs("devices/recording/reserve").find((r) => within(r, "start-second"));
  assert.ok(reservation);
  const registered = pairs("storage/registerCheckpoint").find(
    (r) => r.params.reservation === reservation.value.reservation.reservationId,
  );
  assert.ok(registered);
  assert.equal(registered.params.id, p.second.id);
  const drain = report.drains.find((d) =>
    d.offer.checkpoints.some((c) => c.checkpoint === registered.value.checkpoint),
  );
  assert.ok(drain && drain.report.state === "saved" && !drain.report.blocker);
  assert.deepEqual(drain.offer.owner, owner);
  assert.equal(second.begin.params.checkpoint.handle, registered.value.checkpoint);
  assert.equal(second.begin.params.checkpoint.phase, "final");
  assert.equal(second.commit.params.drainToken, drain.offer.token);
  assert.ok(within(second.commit, "stop-second"));
  const submitted = pairs("storage/drain", "host-plugin").find(
    (row) => row.params.token === drain.offer.token,
  );
  assert.ok(submitted && submitted.value.status === "submitted");
  assert.deepEqual(submitted.value.writes, [second.begin.value.write]);
  assert.ok(
    drain.report.records.some(
      (record) =>
        record.id === p.second.id && record.committedRevision === p.second.revision && record.final,
    ),
  );
  const original = begins.find(
    (row) => row.params.target.mode === "create" && row.value.id === p.second.id,
  );
  assert.ok(original);
  let originalOffset = 0;
  const originalBytes = Buffer.concat(
    pairs("storage/writeChunk")
      .filter((row) => row.params.write === original.value.write)
      .map((row) => {
        assert.equal(row.params.offset, originalOffset);
        const bytes = Buffer.from(row.params.data, "base64");
        originalOffset += bytes.length;
        return bytes;
      }),
  );
  assert.equal(originalBytes.length, original.params.byteLength);
  assert.equal(digest(originalBytes), original.params.sha256);
  assert.equal(
    JSON.parse(originalBytes.toString("utf8")).id,
    second.payload.id,
    "Second original model identity retained",
  );

  const stop = report.ipc.find(
    (i) =>
      i.channel === "plugins:ui:interact" &&
      i.args[0].kind === "core" &&
      i.args[0].actionId === "stop" &&
      i.at >= step("stop-second").at &&
      i.result?.ok,
  );
  assert.ok(stop);
  trusted(stop, "stop-second", "#status");
  assert.ok(
    report.brokerCalls.some(
      (r) =>
        r.method === "devices/recording/release" &&
        r.params.reservationId === reservation.value.reservation.reservationId &&
        r.at >= stop.at &&
        r.result?.ok &&
        JSON.stringify(r.principal.owner) === JSON.stringify(owner),
    ),
  );
  rowAction("view-first", "view-record", "history", p.first);
  assert.deepEqual(read(p.first, "view-first"), first.payload);
  rowAction("compare-second", "compare-record", "history", p.second);
  assert.deepEqual(read(p.second, "compare-second"), second.payload);
  for (const [name, calibrated, value] of [
    ["raw", false, 42],
    ["calibrated", true, 0],
  ]) {
    const evidence = p[name],
      page = evidence.page;
    assert.equal(evidence.form.calibrated, calibrated);
    assert.ok(report.ipc.some((i) => JSON.stringify(i) === JSON.stringify(page)));
    assert.ok(page.at >= step(name).at && page.finishedAt <= step(name).finishedAt);
    assert.equal(page.args[0].dataset, "chart0");
    ok(page.result);
    assert.equal(page.result.value.header.view, "full");
    for (const series of [0, 1])
      assert.ok(
        page.result.value.chunk.entries.some((point) => point[0] === series && point[3] === value),
      );
    assert.ok(
      report.native.some(
        (e) =>
          e.type === "input" &&
          e.isTrusted &&
          e.node === "calibrated" &&
          e.at >= step(name).at &&
          e.at <= step(name).finishedAt,
      ),
    );
  }
  assert.notEqual(p.raw.page.result.value.revision, p.calibrated.page.result.value.revision);
  for (const [name, command, dataset, meta] of [
    ["delete-profile", "delete-profiles", "profiles", p.profile],
    ["delete-first", "delete-history", "history", p.first],
  ]) {
    rowAction(name, command, dataset, meta, true);
    const removed = pairs("storage/delete").filter((r) => within(r, name));
    assert.equal(removed.length, 1);
    assert.equal(removed[0].params.id, meta.id);
    assert.equal(removed[0].params.expectedRevision, meta.revision);
    assert.equal(removed[0].value.deleted, true);
    const listed = pairs("storage/list").find(
      (r) =>
        r.request.sequence > removed[0].response.sequence &&
        r.params.kind === meta.kind &&
        r.value.nextCursor === null,
    );
    assert.ok(listed && !listed.value.entries.some((e) => e.id === meta.id));
    if (dataset === "history")
      assert.ok(
        listed.value.entries.some((e) => e.id === p.second.id && e.revision === p.second.revision),
      );
  }
  assert.ok(
    report.ipc.some(
      (i) =>
        i.channel === "plugins:ui:data-read" &&
        i.result?.ok &&
        i.at >= step("delete-first").at &&
        i.args[0].dataset === "history" &&
        !i.result.value.chunk.entries.some((e) => e.key === p.first.id) &&
        i.result.value.chunk.entries.some((e) => e.key === p.second.id),
    ),
  );
  for (const counters of [report.cleanup.bridge, report.cleanup.worker])
    for (const v of Object.values(counters)) assert.equal(v, 0);
  assert.equal(report.cleanup.workers, 0);
  return { profile: p.profile.id, first: p.first.id, second: p.second.id };
}

export async function buildLab(directory) {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const vite = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
  await mkdir(path.join(directory, "profile"), { recursive: true });
  await mkdir(path.join(directory, "plugins/sensor-lab/ui"), { recursive: true });
  await symlink(
    await realpath(path.join(root, "apps/desktop/node_modules")),
    path.join(directory, "node_modules"),
    "dir",
  );
  const config = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const alias = Object.fromEntries(
    Object.entries(config.compilerOptions.paths).map(([name, [file]]) => [
      name,
      path.join(root, file),
    ]),
  );
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external: ["electron", "node-hid", "usb"],
    plugins: [rawResourcePlugin()],
    metafile: true,
  };
  const inputs = new Set(
    [
      "tests/desktop/sensor-lab-public-run.mjs",
      "tests/desktop/sensor-lab-public-test.mjs",
      "tests/desktop/raw-resource-plugin.mjs",
    ].map((file) => path.join(root, file)),
  );
  const bundle = async (name, contents) => {
    const result = await build({
      ...common,
      stdin: { contents, resolveDir: root, loader: "ts" },
      outfile: path.join(directory, name),
    });
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input === "<stdin>") continue;
      const absolute = input.startsWith("kobrixa-raw-resource:")
        ? input.slice("kobrixa-raw-resource:".length)
        : path.resolve(root, input);
      assert.ok(
        absolute.startsWith(root + path.sep) || absolute.includes("/node_modules/"),
        `Foreign workspace source ${absolute}`,
      );
      inputs.add(absolute);
    }
    await writeFile(
      path.join(directory, name.replaceAll("/", "-") + ".meta.json"),
      JSON.stringify(result.metafile, null, 2),
    );
  };
  await bundle(
    "main.cjs",
    `import {runNativeLab} from ${JSON.stringify(path.join(root, "tests/desktop/sensor-lab-public-main.ts"))}; runNativeLab();`,
  );
  await bundle(
    "persistence-worker.cjs",
    `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))}; runShippedPersistenceWorker();`,
  );
  await bundle(
    "preload.cjs",
    `import ${JSON.stringify(path.join(root, "apps/desktop/src/preload/index.ts"))};`,
  );
  await bundle(
    "plugins/sensor-lab/main.cjs",
    `console.error("LAB_PID:"+process.pid); import ${JSON.stringify(path.join(root, "plugins/sensor-lab/src/main.ts"))};`,
  );
  const leaf = path.join(directory, "plugins/sensor-lab");
  for (const name of ["kobrixa-plugin.json", "ui/panel.json", "ui/status.json"])
    await cp(path.join(root, "plugins/sensor-lab", name), path.join(leaf, name));
  const files = [];
  for (const name of [
    "kobrixa-plugin.json",
    "main.cjs",
    "ui/panel.json",
    "ui/status.json",
  ].sort()) {
    const bytes = await readFile(path.join(leaf, name));
    files.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  await writeFile(
    path.join(leaf, "resource-index.json"),
    JSON.stringify({ version: 1, pluginId, files }),
  );
  await vite.build({
    configLoader: "runner",
    cacheDir: path.join(directory, "vite-cache"),
    root: path.join(root, "apps/desktop"),
    configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
    base: "./",
    resolve: { alias, dedupe: ["react", "react-dom"] },
    plugins: [
      {
        name: "actual-lab-generic-shell",
        generateBundle() {
          for (const id of this.getModuleIds()) {
            if (id.startsWith("/") && !id.includes("/node_modules/")) {
              assert.ok(id.startsWith(root + path.sep), `Foreign renderer ${id}`);
              inputs.add(id.split("?")[0]);
            }
          }
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html.replace(
              'src="/src/renderer/index.tsx"',
              `src="/@fs/${path.join(root, "tests/desktop/sensor-lab-public-renderer.tsx")}"`,
            ),
        },
      },
    ],
    build: { outDir: path.join(directory, "renderer"), emptyOutDir: true },
  });
  const artifactHashes = {},
    sourceHashes = {};
  for (const name of [
    "main.cjs",
    "persistence-worker.cjs",
    "preload.cjs",
    ...files.map((f) => `plugins/sensor-lab/${f.path}`),
    "plugins/sensor-lab/resource-index.json",
    ...(await readdir(path.join(directory, "renderer"), { recursive: true }))
      .filter((f) => /\.(html|js|css)$/.test(f))
      .map((f) => `renderer/${f}`),
  ])
    artifactHashes[name] = digest(await readFile(path.join(directory, name)));
  for (const file of [...inputs].sort())
    sourceHashes[path.relative(root, file)] = digest(await readFile(file));
  const identity = {
    root,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    status: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
    artifactHashes,
    sourceHashes,
  };
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  return identity;
}

async function main(args) {
  assert.ok(
    ["--build-only", "--run", "--run-built"].includes(args[0]),
    "Use --build-only | --run | --run-built <absolute directory>",
  );
  const directory =
    args[0] === "--run-built"
      ? await realpath(args[1])
      : await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-lab-public-")));
  console.log(`Lab public artifacts: ${directory}`);
  const identity =
    args[0] === "--run-built"
      ? JSON.parse(await readFile(path.join(directory, "artifact-identity.json"), "utf8"))
      : await buildLab(directory);
  if (args[0] === "--build-only") {
    console.log("BUILD ONLY: Electron was not launched; no native PASS claimed.");
    return;
  }
  assert.equal(
    digest(await readFile(fileURLToPath(import.meta.url))),
    identity.sourceHashes["tests/desktop/sensor-lab-public-run.mjs"],
    "Oracle changed since build; rebuild before native execution",
  );
  for (const [file, hash] of Object.entries(identity.artifactHashes))
    assert.equal(
      digest(await readFile(path.join(directory, file))),
      hash,
      `Changed artifact ${file}`,
    );
  // An existing profile/receipt must never silently turn this into a replay run.
  assert.deepEqual(
    await readdir(path.join(directory, "profile")),
    [],
    "Native run requires a fresh isolated profile",
  );
  const require = createRequire(path.join(root, "apps/desktop/package.json"));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [path.join(directory, "main.cjs"), `--lab-root=${directory}`],
    {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const logs = [];
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      logs.push(bytes.toString());
      process.stderr.write(bytes);
    });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
  }, 150_000);
  const outside = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  await writeFile(path.join(directory, "native.log"), logs.join(""));
  assert.equal(timedOut, false, "Native timeout");
  assert.equal(outside.code, 0, "Native producer failed; inspect producer.json/native.log");
  assert.equal(outside.signal, null);
  const producerBytes = await readFile(path.join(directory, "producer.json"));
  const verified = verifyLabReceipt(JSON.parse(producerBytes), { requireParity: true });
  const receipt = { verified, outside, producerSha256: digest(producerBytes), identity };
  await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  console.log(`Actual public Lab PASS: ${path.join(directory, "receipt.json")}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
