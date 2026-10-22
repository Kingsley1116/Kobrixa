import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

async function reportAt(file) {
  const bytes = await readFile(file);
  return JSON.parse((file.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"));
}

test(
  "actual native UI motion matrix retains original operations and safety disposition",
  {
    skip: !process.env.KOBRIXA_UI_MOTION_REPORT,
  },
  async () => {
    const matrixFile = process.env.KOBRIXA_UI_MOTION_REPORT;
    const matrix = await reportAt(matrixFile);
    assert.equal(matrix.kind, "ui-motion-matrix");
    const expected = ["prepare", "start", "arm", "pulse"].flatMap((boundary) =>
      ["before", "after"].flatMap((position) =>
        [
          "hide",
          "authority-loss",
          "cancel",
          "renderer-freeze",
          "renderer-crash",
          "plugin-kill",
        ].map((fault) => `${boundary}:${position}:${fault}`),
      ),
    );
    assert.deepEqual(
      matrix.reports.map(({ scenario: s }) => `${s.boundary}:${s.position}:${s.fault}`).sort(),
      expected.sort(),
    );
    for (const row of matrix.reports) {
      const report = await reportAt(path.resolve(path.dirname(matrixFile), row.path));
      assert.equal(report.kind, "ui-motion-race");
      assert.equal(report.composition, "composeDesktopMain/createDesktopFoundation");
      assert.equal(report.mockIntent, false);
      assert.deepEqual(report.scenario, row.scenario);
      assert.deepEqual(report.remainingPids, []);
      assert.equal(report.normalClose, true);
      assert.deepEqual(report.failures, []);
      assert.ok(report.pid > 0);
      assert.match(report.operationId, /^[a-f0-9-]{36}$/);
      assert.match(report.artifact.commit, /^[a-f0-9]{40}$/);
      assert.ok(Object.keys(report.artifact.sha256).length >= 6);
      for (const hash of Object.values(report.artifact.sha256))
        assert.match(hash, /^[a-f0-9]{64}$/);
      assert.equal(Object.keys(report.final).length, 10);
      assert.ok(Object.values(report.final).every((value) => value === 0));
      const requests = report.wire.filter((value) => value.direction === "plugin-host");
      const prepared = requests.filter(
        (value) => value.message.method === "devices/motion/prepare",
      );
      const started = requests.filter((value) => value.message.method === "devices/motion/start");
      assert.equal(prepared.length, 1);
      assert.ok(started.length <= 1);
      for (const value of started)
        assert.equal(value.message.params.operationId, report.operationId);
      assert.ok(
        report.events.some(
          (event) =>
            event.time >= report.faultAt &&
            event.kind === (report.scenario.fault === "cancel" ? "stop-dispatch" : "revoke"),
        ),
      );
      assert.ok(
        ["stopped", "completed", "failed", "timeout", "unconfirmed"].includes(
          report.terminal.phase,
        ),
      );
      assert.equal(report.terminal.operationId, report.operationId);
      const effects = new Set(["helper-upload", "helper-run", "helper-arm", "motion-pulse"]);
      assert.equal(
        report.trace
          .slice(report.traceAtRevoke)
          .filter((event) => effects.has(event.step) && event.dispatch !== "not-sent").length,
        0,
      );
      if (report.trace.some((event) => effects.has(event.step) && event.dispatch === "sent")) {
        assert.ok(report.trace.some((event) => event.step === "stop" && event.dispatch === "sent"));
        assert.ok(
          report.trace.some((event) => event.step === "readback" && event.dispatch === "sent"),
        );
        assert.equal(report.terminal.stopConfirmation, "confirmed");
      }
      for (const fault of report.recoverySnapshot.faults.filter(
        (fault) => fault.operationId === report.operationId,
      )) {
        assert.equal(fault.state, "resolved");
        assert.equal(fault.stopConfirmation, "confirmed");
      }
    }
  },
);

test(
  "actual common queue pressure retains stop disposition and original identity",
  {
    skip: !process.env.KOBRIXA_UI_MOTION_STRESS_REPORT,
  },
  async () => {
    const file = process.env.KOBRIXA_UI_MOTION_STRESS_REPORT;
    const matrix = await reportAt(file);
    assert.equal(matrix.kind, "ui-motion-stress");
    assert.deepEqual(matrix.reports.map((row) => row.scenario.stress).sort(), [
      "delayed-readback",
      "lost-start",
      "withheld-readback",
    ]);
    for (const row of matrix.reports) {
      const report = await reportAt(path.resolve(path.dirname(file), row.path));
      assert.deepEqual(report.failures, []);
      assert.deepEqual(report.remainingPids, []);
      assert.equal(report.composition, "composeDesktopMain/createDesktopFoundation");
      assert.equal(report.mockIntent, false);
      assert.ok(report.queueSamples.some((sample) => sample.queuedEvents === 7));
      assert.ok(
        report.queueSamples.every(
          (sample) => sample.queuedEvents <= 8 && sample.queuedBytes <= 8 * 16384,
        ),
      );
      const messages = report.wire
        .filter((event) => event.direction === "plugin-host")
        .map((event) => event.message);
      assert.equal(
        messages.filter((message) => message.method === "devices/motion/prepare").length,
        1,
      );
      assert.equal(
        messages.filter((message) => message.method === "devices/motion/start").length,
        1,
      );
      for (const message of messages.filter((message) =>
        ["devices/motion/start", "devices/motion/query", "devices/motion/stop"].includes(
          message.method,
        ),
      ))
        assert.equal(message.params.operationId, report.operationId);
      const resync = report.wire.find(
        (event) =>
          event.direction === "host-plugin" &&
          event.message.params?.kind === "events.resyncRequired",
      );
      assert.ok(resync);
      assert.equal(resync.message.params.data.reason, "overflow");
      const revoke = report.events.find(
        (event) => event.kind === "revoke" && event.time >= report.faultAt,
      );
      assert.ok(revoke && revoke.time <= resync.at);
      const held = report.ackDeliveries.filter((event) => event.disposition === "held");
      assert.ok(held.length > 0);
      for (const ack of held)
        assert.ok(
          report.ackDeliveries.some(
            (event) =>
              event.disposition === "released" &&
              JSON.stringify(event.message) === JSON.stringify(ack.message) &&
              event.at >= revoke.time,
          ),
        );
      assert.ok(report.trace.some((event) => event.step === "stop" && event.dispatch === "sent"));
      assert.ok(Object.values(report.final).every((value) => value === 0));
      if (row.scenario.stress === "withheld-readback") {
        assert.equal(report.terminal.phase, "unconfirmed");
        assert.equal(report.normalClose, false);
        assert.equal(report.expectedBlockedClose.device.stopConfirmed, false);
        assert.equal(report.expectedBlockedClose.device.journalCommitted, true);
        const fault = report.recoverySnapshot.faults.find(
          (fault) => fault.operationId === report.operationId,
        );
        assert.equal(fault.state, "unconfirmed");
        assert.deepEqual(
          report.afterRetirement.faults.find((item) => item.id === fault.id),
          fault,
        );
      } else {
        assert.equal(report.terminal.stopConfirmation, "confirmed");
        assert.equal(report.normalClose, true);
      }
      if (row.scenario.stress === "lost-start") {
        assert.ok(
          report.logs.some(
            (line) => line.includes("MOTION_START_ERROR:") && line.includes("timed out"),
          ),
        );
        assert.ok(
          report.logs.some(
            (line) => line.includes("MOTION_QUERY:") && line.includes(report.operationId),
          ),
        );
        const reply = report.deliveries.find((event) => event.disposition === "held");
        assert.ok(reply);
        assert.ok(
          report.deliveries.some(
            (event) =>
              event.disposition === "released" &&
              event.id === reply.id &&
              event.at - reply.at >= 4900,
          ),
        );
      }
    }
  },
);
