import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { frameMessage, parseFrame } from "../../packages/device/dist/framing.js";
import { readMonitor } from "../../packages/device/dist/monitor.js";
import { trimHidReply } from "../../packages/device/dist/usb.js";
import { observedExchange, recordGate } from "./ev3-uhid-spike.mjs";

function packet(frame) {
  const size = Buffer.alloc(2);
  size.writeUInt16LE(frame.length);
  return Buffer.concat([size, frame]);
}

test("C peer round trips the product snapshot and rejects other programs", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "uhid-frame-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const peer = path.join(dir, "peer");
  const source = fileURLToPath(new URL("fixtures/ev3-uhid/peer.c", import.meta.url));
  const built = spawnSync(
    "cc",
    ["-Wall", "-Wextra", "-Werror", "-std=c11", "-DFRAME_TEST", source, "-o", peer],
    { encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.error?.message ?? built.stderr);
  const frames = [];
  let previous;
  for (const counter of [0xffff, 0]) {
    const snapshot = await readMonitor(
      {
        exchange: async (payload) => {
          const frame = frameMessage(counter, payload);
          frames.push(
            counter === 0
              ? Buffer.concat([Buffer.of(0), frame, Buffer.alloc(512 - frame.length)])
              : frame,
          );
          const reply = spawnSync(peer, [], { input: Buffer.concat(frames.map(packet)) });
          assert.equal(reply.status, 0, reply.stderr.toString());
          assert.equal(reply.stdout.length, 512 * frames.length);
          const rawReply = reply.stdout.subarray(-512);
          const rawRequest = Buffer.from(frames.at(-1));
          const trace = () =>
            `1.000000000 OPEN\n1.000000001 REQUEST ${rawRequest.toString("hex")}\n1.000000002 REPLY ${rawReply.toString("hex")}\n`;
          assert.ok(observedExchange(trace()));
          rawReply[2] ^= 1;
          assert.equal(observedExchange(trace()), false);
          rawReply[2] ^= 1;
          const parsed = parseFrame(trimHidReply(reply.stdout.subarray(-512), counter));
          assert.equal(parsed.counter, counter);
          return parsed.payload;
        },
      },
      new AbortController().signal,
    );
    const input = snapshot.inputs[0];
    assert.equal(input.type, 29);
    assert.equal(input.mode, 0);
    assert.equal(input.state, "ready");
    assert.equal(input.values.length, 1);
    assert.ok(Number.isFinite(input.values[0]));
    assert.notEqual(input.values[0], previous);
    previous = input.values[0];
    for (const other of [...snapshot.inputs.slice(1), ...snapshot.outputs])
      assert.equal(other.state, "empty");
  }
  const valid = Buffer.from(frames[0]);
  const unknown = Buffer.from(valid);
  unknown[unknown.length - 1] ^= 1;
  const badLength = Buffer.from(valid);
  badLength[0]--;
  for (const frame of [
    valid.subarray(0, -1),
    Buffer.concat([valid, Buffer.of(1)]),
    unknown,
    badLength,
  ]) {
    const invalid = spawnSync(peer, [], { input: packet(frame) });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr.toString(), /Unknown or malformed/);
    assert.equal(invalid.stdout.length, 0);
  }
});

test("failed and untouched gates retain distinct outcomes", async () => {
  const report = { G1: { status: "NOT RUN" }, G2: { status: "NOT RUN" } };
  const saved = [];
  await assert.rejects(
    recordGate(
      report,
      "G1",
      () => {
        throw Error("module unavailable");
      },
      () => {
        saved.push(report.G1.status);
      },
    ),
    /module unavailable/,
  );
  assert.deepEqual(saved, ["INCOMPLETE", "FAIL"]);
  assert.equal(report.G2.status, "NOT RUN");
  await assert.rejects(
    recordGate(
      report,
      "G1",
      () => true,
      () => {},
    ),
  );
});

test("an enumeration open/close or rejected request cannot establish app traffic", () => {
  const ts = "1.000000001 ";
  for (const events of [
    ["OPEN", "CLOSE"],
    ["OPEN", "REQUEST 00"],
    ["REQUEST 00", "REPLY ff"],
    ["OPEN", "REQUEST 00", "REPLY ff", "REJECT"],
  ])
    assert.equal(observedExchange(events.map((e) => ts + e + "\n").join("")), false);
});

test("result exits nonzero for a fresh report with every gate NOT RUN", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "uhid-gates-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const driver = fileURLToPath(new URL("ev3-uhid-spike.mjs", import.meta.url));
  const invoke = (action) =>
    spawnSync(process.execPath, [driver, action, dir], { encoding: "utf8" });
  assert.equal(invoke("init").status, 0);
  const result = invoke("result");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /G1 NOT RUN/);
  assert.doesNotMatch(result.stdout, /YES:/);
});
