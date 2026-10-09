// Actual USB hardware checks for explicitly selected, newly added examples.
// Runs the original image, then a copy with only an appended completion/readback epilogue.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { UsbTransport } from "../../packages/device/dist/index.js";
import {
  EV3Backend,
  inspectRbf,
  createRbf,
  lc,
  gv,
  lv,
  lcs,
} from "../../packages/backend-ev3/dist/index.js";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";
import { loadProject } from "../../packages/compiler/dist/index.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const plan = JSON.parse(
  await fs.readFile(new URL("./fixtures/new-examples.json", import.meta.url), "utf8"),
);
const selected = process.argv.slice(2);
const gyroFixture = selected[0] === "--gyro-port2";
if (gyroFixture) {
  assert.equal(selected.length, 1, "Gyro fixture runs separately");
  selected.splice(0, 1, "sensors/mode-inspector");
  plan.push({
    project: "sensors/mode-inspector",
    texts: ["Type: 32", "Mode: 1"],
    textRanges: { "Percent: ": [-100, 100] },
  });
}
const cases = selected.length
  ? selected.map((name) => {
      const found = plan.find((item) => item.project === name);
      assert(found, "Unknown new lesson " + name);
      return found;
    })
  : plan;
const output =
  process.env.EV3_NEW_REPORT ??
  path.join(
    root,
    gyroFixture
      ? "docs/audits/hardware-new-gyro-fixture-2026-09-21.json"
      : "docs/audits/hardware-new-examples-2026-09-21.json",
  );
const signal = AbortSignal.timeout(600000),
  transport = new UsbTransport();
const device = (await transport.discover(signal))[0];
assert(device, "No USB EV3 found");
const session = await transport.connect(device, signal);
const report = {
  startedAt: new Date().toISOString(),
  device,
  scope: "Only selected new examples; no historical example execution.",
  method:
    "First run unmodified RBF to firmware completion. Then append array readback, a completion marker and a bounded hold before main OBJECT_END; all original instructions remain. Read actual EV3 global/local RAM. Display rendering and audible sound require human observation.",
  cases: [],
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const size = (type) => (type.kind === "string" ? 252 : type.kind === "boolean" ? 1 : 4);
function layout(variables, offset = 0) {
  const entries = new Map();
  for (const variable of variables) {
    const n = size(variable.type),
      a = n >= 4 ? 4 : 1;
    offset = Math.ceil(offset / a) * a;
    entries.set(variable.name.toLowerCase(), { ...variable, offset, size: n });
    offset += n;
  }
  return entries;
}
function value(bytes, entry) {
  const off = entry.offset;
  return entry.type.kind === "string"
    ? bytes
        .subarray(off, off + 252)
        .toString()
        .split("\0")[0]
    : entry.type.kind === "number"
      ? bytes.readFloatLE(off)
      : entry.type.kind === "boolean"
        ? bytes[off]
        : bytes.readInt32LE(off);
}
async function direct(code, n = 0) {
  const reply = Buffer.from(
    await session.connection.exchange(Uint8Array.from([0, n & 255, n >> 8, ...code]), signal, 5000),
  );
  assert.equal(reply[0], 2, "EV3 direct command reply");
  return reply.subarray(1);
}
async function state() {
  const b = await direct([0x0c, 22, 1, ...gv(0), 0x0c, 24, 1, ...gv(1)], 2);
  return { status: b[0], result: b[1] };
}
async function memory(object, offset, length) {
  const bytes = Buffer.alloc(length);
  for (let start = 0; start < length; start += 200) {
    const n = Math.min(200, length - start);
    (await direct([0x7f, 1, ...lc(object), ...lc(offset + start), ...lc(n), ...gv(0)], n)).copy(
      bytes,
      start,
    );
  }
  return bytes;
}
async function start(remote) {
  const ack = await direct(
    [
      0xc0,
      8,
      1,
      ...lcs(remote),
      ...gv(0),
      ...gv(4),
      3,
      1,
      ...gv(0),
      ...gv(4),
      0,
      0x0c,
      22,
      1,
      ...gv(8),
    ],
    9,
  );
  assert.notEqual(ack[8], 64, "Image failed to start");
}
async function readRemote(name) {
  let r = Buffer.from(
    await session.connection.exchange(
      Uint8Array.from([1, 0x94, 0x84, 3, ...Buffer.from(name), 0]),
      signal,
    ),
  );
  if (r[2] === 1) return null;
  if (![0, 8].includes(r[2])) throw Error("Cannot back up " + name + ": " + r.toString("hex"));
  const size = r.readUInt32LE(3),
    handle = r[7],
    parts = [r.subarray(8)];
  if (size > 1000000) throw Error("Backup too large");
  while (r[2] !== 8) {
    r = Buffer.from(
      await session.connection.exchange(Uint8Array.from([1, 0x95, handle, 0x84, 3]), signal),
    );
    if (![0, 8].includes(r[2])) throw Error("Backup continuation rejected");
    parts.push(r.subarray(4));
  }
  const data = Buffer.concat(parts);
  if (data.length !== size) throw Error("Backup length mismatch");
  return data;
}

let remote,
  active = false;
try {
  report.firmware = (await direct([0x81, 26, ...lc(40), ...gv(0)], 40)).toString().split("\0")[0];
  assert.equal((await state()).status, 64, "Existing user program is running");
  for (const lesson of cases) {
    const row = { project: lesson.project, checks: [], visualAudio: "not independently observed" };
    report.cases.push(row);
    const backups = new Map();
    try {
      const loaded = await loadProject(path.join(root, "examples", lesson.project));
      assert.deepEqual(loaded.diagnostics, []);
      if (gyroFixture) {
        row.fixture =
          "Input 1 remapped to gyro input 2 in memory; no source files changed. This does not certify the original color-sensor fixture.";
        row.originalSourceHashes = loaded.project.sources.map((s) => ({
          path: s.path,
          sha256: hash(s.content),
        }));
        const sensor = await direct([0x99, 5, 0, 1, ...gv(0), ...gv(1)], 2);
        assert.equal(sensor[0], 32, "Input 2 must contain an EV3 gyro");
        row.originalGyroMode = sensor[1];
        for (const source of loaded.project.sources)
          source.content = source.content.replace(/Sensor\.([A-Za-z]+)\(1/g, "Sensor.$1(2");
      }
      const front = await new BasicPlusFrontend().compile(loaded.project, signal);
      assert.deepEqual(front.diagnostics, []);
      const ir = front.ir,
        calls = ir.functions.flatMap((fn) =>
          fn.blocks.flatMap((b) => b.instructions.filter((i) => i.op === "ev3-call")),
        );
      assert(
        !calls.some(
          (i) =>
            /^(Motor|Mailbox)/.test(i.operation) ||
            (!gyroFixture && /^Sensor/.test(i.operation)) ||
            ["Buttons.Wait", "Program.End"].includes(i.operation),
        ),
        "This runner only accepts non-actuating examples",
      );
      const compiled = await new EV3Backend().compile(ir, signal);
      assert.deepEqual(compiled.diagnostics, []);
      const original = Buffer.from(compiled.rbf),
        info = inspectRbf(original);
      row.sourceHashes = loaded.project.sources.map((s) => ({
        path: s.path,
        sha256: hash(s.content),
      }));
      row.originalSha256 = hash(original);
      row.bytes = original.length;
      const directory = ir.program.runtimeDirectory ?? "/home/root/lms2012/prjs";
      for (const file of Object.keys(lesson.files ?? {})) {
        const dest = directory + "/" + file;
        backups.set(dest, await readRemote(dest));
      }
      for (const asset of loaded.project.assets) {
        const dest = directory + "/" + asset.path;
        backups.set(dest, await readRemote(dest));
        const data = await fs.readFile(asset.absolutePath);
        await session.upload(dest, data, signal);
        assert((await readRemote(dest))?.equals(data), "Asset readback differs");
        (row.assets ??= []).push({ path: dest, sha256: hash(data), readbackMatches: true });
      }
      remote = directory + "/kxn_" + randomBytes(5).toString("hex") + ".rbf";
      await session.upload(remote, original, signal);
      active = true;
      await start(remote);
      const began = Date.now();
      let final;
      do {
        await wait(60);
        final = await state();
      } while (final.status !== 64 && Date.now() - began < 20000);
      row.originalFinalState = final;
      row.originalDurationMs = Date.now() - began;
      assert.deepEqual(
        final,
        { status: 64, result: 0 },
        "Original RBF did not finish successfully",
      );
      active = false;
      const base = calls.some((i) =>
        ["Thread.CreateMutex", "Thread.Lock", "Thread.Unlock", "LCD.StopUpdate"].includes(
          i.operation,
        ),
      )
        ? 8
        : 0;
      const globals = layout(ir.globals, base),
        marker = Math.ceil(info.globalBytes / 4) * 4;
      let extended = marker + 4;
      const extra = [],
        arrayOffsets = {};
      for (const [name, expected] of Object.entries(lesson.arrays ?? {})) {
        const entry = globals.get(name);
        assert(entry, "Missing array " + name);
        arrayOffsets[name] = extended;
        expected.forEach((_, index) => {
          extra.push(0xc3, ...gv(entry.offset), ...lc(index), ...gv(extended));
          extended += 4;
        });
      }
      const objects = info.offsets.map((offset, index) => {
        let code = original.subarray(offset, info.offsets[index + 1] ?? original.length),
          localBytes = original.readUInt32LE(24 + index * 12);
        if (index === 0) {
          assert.equal(code.at(-1), 10);
          const timer = Math.ceil(localBytes / 4) * 4;
          code = Uint8Array.from([
            ...code.subarray(0, -1),
            ...extra,
            0x3a,
            ...lc(123456789),
            ...gv(marker),
            0x85,
            ...lc(15000),
            ...lv(timer),
            0x86,
            ...lv(timer),
            10,
          ]);
          localBytes = timer + 4;
        }
        return {
          ownerObjectId: original.readUInt16LE(20 + index * 12),
          triggerCount: original.readUInt16LE(22 + index * 12),
          localBytes,
          code,
        };
      });
      const observed = createRbf(objects, extended);
      row.observationSha256 = hash(observed);
      await session.upload(remote, observed, signal);
      active = true;
      await start(remote);
      const observedStart = Date.now();
      let complete = false;
      while (Date.now() - observedStart < 20000) {
        await wait(80);
        const current = await state();
        if (current.status === 64)
          throw Error("Stopped before readback marker: " + JSON.stringify(current));
        if ((await memory(0, marker, 4)).readInt32LE() === 123456789) {
          complete = true;
          break;
        }
      }
      assert(complete, "Readback completion marker timed out");
      const bytes = await memory(0, 0, extended);
      row.values = Object.fromEntries(
        [...globals]
          .filter(([, entry]) => entry.type.kind !== "array")
          .map(([name, entry]) => [name, value(bytes, entry)]),
      );
      row.arrays = {};
      const check = (name, actual, expected, passed) =>
        row.checks.push({ name, actual, expected, passed });
      for (const [name, expected] of Object.entries(lesson.values ?? {})) {
        const actual = row.values[name];
        check(
          name,
          actual,
          expected,
          typeof expected === "number"
            ? Number.isFinite(actual) && Math.abs(actual - expected) < 0.0001
            : actual === expected,
        );
      }
      for (const [name, range] of Object.entries(lesson.ranges ?? {})) {
        const actual = row.values[name];
        check(name, actual, range, actual >= range[0] && actual <= range[1]);
      }
      for (const [name, expected] of Object.entries(lesson.arrays ?? {})) {
        const actual = expected.map((_, index) =>
          bytes.readFloatLE(arrayOffsets[name] + index * 4),
        );
        row.arrays[name] = actual;
        check(
          name,
          actual,
          expected,
          actual.every((v, index) => Math.abs(v - expected[index]) < 0.0001),
        );
      }
      row.computedTextOperands = [];
      for (const [index, fn] of ir.functions.entries()) {
        const callSize = (v) => (v.type.kind === "array" ? 2 : size(v.type));
        const parameters = [...fn.parameters].sort((a, b) => callSize(b) - callSize(a));
        const locals = layout([
          ...parameters,
          ...(fn.returnType.kind === "void" ? [] : [{ name: "$return", type: fn.returnType }]),
          ...fn.locals,
        ]);
        const localBytes = await memory(index + 1, 0, original.readUInt32LE(24 + index * 12));
        for (const call of fn.blocks
          .flatMap((b) => b.instructions)
          .filter((i) => i.op === "ev3-call" && ["LCD.Text", "LCD.Write"].includes(i.operation))) {
          const arg = call.args[call.operation === "LCD.Text" ? 4 : 2];
          if (arg.kind !== "variable") continue;
          const entry = locals.get(arg.name.toLowerCase()) ?? globals.get(arg.name.toLowerCase());
          if (entry?.type.kind === "string")
            row.computedTextOperands.push(
              value(locals.has(arg.name.toLowerCase()) ? localBytes : bytes, entry),
            );
        }
      }
      for (const expected of lesson.texts ?? [])
        check(
          "computed text",
          row.computedTextOperands,
          expected,
          row.computedTextOperands.includes(expected),
        );
      for (const [prefix, range] of Object.entries(lesson.textRanges ?? {})) {
        const text = row.computedTextOperands.find((v) => v.startsWith(prefix)),
          actual = Number(text?.slice(prefix.length));
        check(
          prefix,
          actual,
          range,
          Number.isFinite(actual) && actual >= range[0] && actual <= range[1],
        );
      }
      for (const [file, expected] of Object.entries(lesson.files ?? {})) {
        const actual = (await readRemote(directory + "/" + file))?.toString("hex");
        check("file " + file, actual, expected, actual === expected);
      }
      check("completion marker reached", true, true, true);
      row.passed = row.checks.every((item) => item.passed);
      console.log(
        lesson.project,
        row.passed ? "PASS" : "FAIL",
        JSON.stringify(row.checks.filter((item) => !item.passed)),
      );
    } catch (error) {
      row.passed = false;
      row.error = error.message;
      console.log(lesson.project, "FAIL", error.message);
    } finally {
      if (active) {
        await session.stop(undefined, AbortSignal.timeout(5000));
        active = false;
      }
      if (remote) {
        await session.delete(remote, AbortSignal.timeout(5000));
        remote = undefined;
      }
      if (row.originalGyroMode !== undefined) {
        await direct([0x99, 0x1c, 0, 1, 0, ...lc(row.originalGyroMode), 1, ...gv(0)], 4);
        const sensor = await direct([0x99, 5, 0, 1, ...gv(0), ...gv(1)], 2);
        assert.equal(sensor[1], row.originalGyroMode, "Gyro mode restoration");
        row.gyroModeRestored = true;
      }
      for (const [dest, backup] of backups) {
        if (backup === null) await session.delete(dest, AbortSignal.timeout(5000));
        else await session.upload(dest, backup, AbortSignal.timeout(5000));
        assert(
          backup === null
            ? (await readRemote(dest)) === null
            : (await readRemote(dest))?.equals(backup),
          "File restoration differs: " + dest,
        );
      }
      row.filesRestored = true;
      await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
    }
  }
} finally {
  if (active) await session.stop(undefined, AbortSignal.timeout(5000));
  report.finalState = await state();
  await session.disconnect();
  report.finishedAt = new Date().toISOString();
  report.passed = report.cases.every((row) => row.passed);
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
}
if (!report.passed) process.exitCode = 1;
