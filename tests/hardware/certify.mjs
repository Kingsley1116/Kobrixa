// Run unmodified RBF images on an EV3 and record firmware completion results.
// Usage: node tests/hardware/certify.mjs [project/path ...]
// Default selection excludes sensors, motor movement, and human button input.
import fs from "node:fs/promises";
import path from "node:path";
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
const observe = process.env.EV3_CERT_OBSERVE === "1";
const observeMs = Number(process.env.EV3_CERT_OBSERVE_MS ?? 3000);
if (observe && (!Number.isInteger(observeMs) || observeMs < 1 || observeMs > 20000))
  throw Error("Observation hold must be 1–20000 milliseconds");
const out =
  process.env.EV3_CERT_REPORT ??
  path.join(root, "docs/audits/hardware-original-rbf-2026-09-19.json");
const transport = new UsbTransport(),
  signal = AbortSignal.timeout(600000);
const descriptor = (await transport.discover(signal))[0];
if (!descriptor) throw Error("No USB EV3");
const session = await transport.connect(descriptor, signal);
const report = {
  startedAt: new Date().toISOString(),
  device: descriptor,
  mode: observe
    ? `Original example code with a ${observeMs}-millisecond observation hold before main OBJECT_END; original resources and filenames.`
    : "Unmodified RBF; original resources and filenames; firmware completion is distinct from human visual/audio acceptance.",
  cases: [],
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function direct(code, n = 0) {
  const reply = Buffer.from(
    await session.connection.exchange(Uint8Array.from([0, n & 255, n >> 8, ...code]), signal),
  );
  if (reply[0] !== 2) throw Error("Direct command rejected: " + reply.toString("hex"));
  return reply.subarray(1);
}
async function state() {
  const b = await direct([0x0c, 22, 1, 0x60, 0x0c, 24, 1, 0x61], 2);
  return { status: b[0], result: b[1] };
}
async function counts() {
  const code = [0, 1, 2, 3].flatMap((port) => [0xb3, 0, port, ...gv(port * 4)]);
  const bytes = await direct(code, 16);
  return [0, 1, 2, 3].map((port) => bytes.readInt32LE(port * 4));
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
async function projects(dir) {
  const es = await fs.readdir(dir, { withFileTypes: true });
  if (es.some((e) => e.name === "kobrixa.json"))
    return [path.relative(path.join(root, "examples"), dir)];
  return (
    await Promise.all(
      es
        .filter((e) => e.isDirectory() && !["build", "node_modules"].includes(e.name))
        .map((e) => projects(path.join(dir, e.name))),
    )
  ).flat();
}
let active = false;
try {
  const info = await direct([0x81, 26, ...lc(40), ...gv(0)], 40);
  report.firmware = info.toString().split("\0")[0];
  if ((await state()).status !== 64) throw Error("Existing user program is running");
  const selected = process.argv.slice(2);
  const list = selected.length
    ? selected
    : (await projects(path.join(root, "examples")))
        .filter(
          (p) =>
            !p.startsWith("sensors/") &&
            !p.startsWith("motors/") &&
            !p.startsWith("capstones/") &&
            !p.startsWith("buttons/") &&
            !p.startsWith("projects/include-"),
        )
        .sort();
  for (const project of list) {
    const row = {
        project,
        startedAt: new Date().toISOString(),
        visualAudio: "pending human observation",
      },
      backups = new Map(),
      executable = "kxc_" + randomBytes(4).toString("hex") + ".rbf";
    // The source Folder directive decides where the program and its relative files live.
    let directory = "/home/root/lms2012/prjs",
      remote = directory + "/" + executable;
    report.cases.push(row);
    try {
      const loaded = await loadProject(path.join(root, "examples", project));
      if (!loaded.project) throw Error(JSON.stringify(loaded.diagnostics));
      const front = await new BasicPlusFrontend().compile(loaded.project, signal);
      if (!front.ir || front.diagnostics.length) throw Error(JSON.stringify(front.diagnostics));
      directory = front.ir.program.runtimeDirectory ?? directory;
      remote = directory + "/" + executable;
      const calls = front.ir.functions.flatMap((f) =>
        f.blocks.flatMap((b) => b.instructions.filter((i) => i.op === "ev3-call")),
      );
      const operations = calls.map((i) => i.operation);
      const expectedMovement = {
        "motors/motor-reverse": -180,
        "projects/include-multiple": 120,
      }[project];
      const allowMotorA =
        process.env.EV3_CERT_MOTOR_A === "raised" && expectedMovement !== undefined;
      if (
        calls.some(
          (call) =>
            call.operation.startsWith("Motor.") &&
            !["Motor.GetCount", "Motor.GetSpeed", "Motor.IsBusy"].includes(call.operation) &&
            !(
              allowMotorA &&
              call.operation === "Motor.Move" &&
              call.args[0]?.kind === "string" &&
              call.args[0].value === "A"
            ),
        )
      )
        throw Error("Motor movement requires a separately approved fixture-specific run");
      if (operations.some((op) => op.startsWith("Sensor")))
        throw Error("Sensor fixture requires a separately configured run");
      const compiled = await new EV3Backend().compile(front.ir, signal);
      if (!compiled.rbf) throw Error(JSON.stringify(compiled.diagnostics));
      row.sha256 = createHash("sha256").update(compiled.rbf).digest("hex");
      row.bytes = compiled.rbf.length;
      let image = compiled.rbf;
      if (observe) {
        const original = Buffer.from(image),
          info = inspectRbf(image);
        const objects = info.offsets.map((start, index) => {
          let code = original.subarray(start, info.offsets[index + 1] ?? original.length);
          let localBytes = original.readUInt32LE(24 + index * 12);
          if (index === 0) {
            if (code.at(-1) !== 10) throw Error("Main OBJECT_END missing");
            const timer = Math.ceil(localBytes / 4) * 4;
            code = Uint8Array.from([
              ...code.subarray(0, -1),
              0x85,
              ...lc(observeMs),
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
        image = createRbf(objects, info.globalBytes);
        row.observationSha256 = createHash("sha256").update(image).digest("hex");
      }
      const names =
        project === "files/binary-record"
          ? ["lesson.bin"]
          : project === "files/file-round-trip"
            ? ["KobrixaExample.txt"]
            : [];
      for (const n of names)
        backups.set(directory + "/" + n, await readRemote(directory + "/" + n));
      for (const asset of loaded.project.assets) {
        const dest = directory + "/" + asset.path;
        backups.set(dest, await readRemote(dest));
        const data = await fs.readFile(asset.absolutePath);
        (row.assets ??= []).push({
          path: asset.path,
          bytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
        await session.upload(dest, data, signal);
        const uploaded = await readRemote(dest);
        row.assets.at(-1).readbackMatches = !!uploaded?.equals(data);
        if (!row.assets.at(-1).readbackMatches)
          throw Error("Uploaded asset bytes differ: " + asset.path);
      }
      await session.upload(remote, image, signal);
      if (allowMotorA) row.encoderBefore = await counts();
      active = true;
      const began = Date.now();
      const ack = await direct(
        [
          0xc0,
          8,
          1,
          ...lcs(remote),
          0x60,
          0x64,
          3,
          1,
          0x60,
          0x64,
          0,
          0x0c,
          22,
          1,
          0x68,
          0x0c,
          24,
          1,
          0x69,
        ],
        10,
      );
      row.loadStartState = { status: ack[8], result: ack[9] };
      let final;
      do {
        await wait(project === "buttons/button-feedback" ? 100 : 50);
        final = await state();
        if (final.status === 64) break;
        if (project === "buttons/button-feedback") {
          const bytes = await direct([0x7f, 1, 0, 0, 16, 0x60], 16);
          const click = bytes.toString().split("\0")[0];
          if (click) row.buttonObserved = click;
        }
      } while (Date.now() - began < (project === "buttons/button-feedback" ? 90000 : 30000));
      row.finalState = final;
      row.durationMs = Date.now() - began;
      row.firmwareCompleted = final.status === 64 && final.result === 0;
      if (!row.firmwareCompleted)
        throw Error("Firmware did not complete successfully: " + JSON.stringify(final));
      if (project === "buttons/button-feedback" && !row.buttonObserved)
        throw Error("No physical button value observed before program termination");
      if (allowMotorA) {
        row.encoderAfter = await counts();
        row.encoderDelta = row.encoderAfter.map((value, port) => value - row.encoderBefore[port]);
        row.expectedEncoderDelta = [expectedMovement, 0, 0, 0];
        row.encoderPassed = row.encoderDelta.every(
          (value, port) => Math.abs(value - row.expectedEncoderDelta[port]) <= (port === 0 ? 5 : 2),
        );
        if (!row.encoderPassed) throw Error("Encoder displacement mismatch");
      }
      if (names.length) {
        const data = await readRemote(directory + "/" + names[0]);
        row.writtenBytes = data?.toString("hex");
        const wanted =
          project === "files/binary-record"
            ? Buffer.from([42])
            : Buffer.from("Hello from Kobrixa\n");
        row.fileContentPassed = !!data?.equals(wanted);
        if (!row.fileContentPassed) throw Error("File contents mismatch");
      }
      row.passed = true;
      console.log(project, "firmware OK", row.durationMs + "ms");
    } catch (e) {
      row.passed = false;
      row.error = e.message;
      console.log(project, "FAIL", e.message);
    } finally {
      if (active) {
        await session.stop(undefined, signal);
        await direct([0xa3, 0, 15, 1]);
        active = false;
      }
      try {
        await session.delete(remote, signal);
      } catch (e) {
        row.rbfCleanupError = e.message;
      }
      for (const [dest, data] of backups) {
        try {
          if (data === null) await session.delete(dest, signal);
          else await session.upload(dest, data, signal);
        } catch (e) {
          row.restoreError = (row.restoreError ?? []).concat(dest + ": " + e.message);
        }
      }
      await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
    }
  }
} finally {
  if (active) await session.stop(undefined, signal);
  await session.disconnect();
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(out, JSON.stringify(report, null, 2) + "\n");
}
if (report.cases.some((row) => !row.passed)) process.exitCode = 1;
