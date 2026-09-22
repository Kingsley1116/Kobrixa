import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";
import { EV3Backend } from "../../packages/backend-ev3/dist/index.js";
import { loadProject } from "../../packages/compiler/dist/index.js";
import { validateIR } from "../../packages/ir/dist/index.js";
import { checkResults } from "../../tools/check-new-example-results.mjs";
import { decode, VM } from "./support/ev3-vm.mjs";

// Literal bytes independently check the central VM representation rule:
// MOVEF_F LC0(2) preserves bits 0x00000002; MOVE32_F LC0(2) converts to 2.0.
test("VM distinguishes floating-point bit moves from numeric conversion", () => {
  const code = Buffer.from([0x3f, 0x02, 0x60, 0x3b, 0x02, 0x64, 0x0a]);
  const image = Buffer.alloc(28 + code.length);
  image.write("LEGO");
  image.writeUInt32LE(image.length, 4);
  image.writeUInt16LE(104, 8);
  image.writeUInt16LE(1, 10);
  image.writeUInt32LE(8, 12);
  image.writeUInt32LE(28, 16);
  code.copy(image, 28);
  const result = new VM(decode(image)).run();
  assert.equal(result.status, "ended");
  const memory = Buffer.from(result.globals, "hex");
  assert.equal(memory.readUInt32LE(0), 2);
  assert.equal(memory.readFloatLE(4), 2);
});
// These literal native images are independent of the compiler being checked.
function nativeImage(codes, globalBytes = 8) {
  let offset = 16 + 12 * codes.length;
  const image = Buffer.alloc(offset + codes.reduce((sum, code) => sum + code.length, 0));
  image.write("LEGO");
  image.writeUInt32LE(image.length, 4);
  image.writeUInt16LE(104, 8);
  image.writeUInt16LE(codes.length, 10);
  image.writeUInt32LE(globalBytes, 12);
  codes.forEach((code, index) => {
    image.writeUInt32LE(offset, 16 + 12 * index);
    image.writeUInt16LE(index === 0 ? 0 : 1, 22 + 12 * index);
    Buffer.from(code).copy(image, offset);
    offset += code.length;
  });
  return image;
}
test("VM matches native narrowing, shifts, trigonometry and subcall exclusion", () => {
  // MOVE32_8 128 saturates to 127; MOVE8_32 -128 propagates NaN.
  const run = new VM(
    decode(nativeImage([[0x38, 0x82, 0x80, 0, 0x60, 0x32, 0x81, 0x80, 0x64, 0x0a]])),
  ).run();
  assert.equal(run.status, "ended");
  const memory = Buffer.from(run.globals, "hex");
  assert.equal(memory.readInt8(0), 127);
  assert.equal(memory.readInt32LE(4), -2147483648);
  // Firmware RL8 drops shifted-out bits; it does not rotate them back in.
  const shifted = new VM(decode(nativeImage([[0x2c, 0x82, 0xa5, 0, 1, 0x60, 0x0a]]))).run();
  assert.equal(Buffer.from(shifted.globals, "hex")[0], 0x4a);
  // The native SIN instruction consumes degrees, whereas Basic Plus uses radians.
  const trig = new VM(decode(nativeImage([[0x8d, 11, 0x83, 0, 0, 0xb4, 0x42, 0x60, 0x0a]]))).run();
  assert.equal(trig.status, "ended");
  assert.equal(Buffer.from(trig.globals, "hex").readFloatLE(), 1);
  // A SUBCALL calling its busy self is invalid, even though a host JS stack can do it.
  const recursive = new VM(
    decode(
      nativeImage([
        [0x09, 2, 0, 0x0a],
        [0, 0x09, 2, 0, 0x08, 0x0a],
      ]),
    ),
  ).run();
  assert.equal(recursive.status, "error");
  assert.match(recursive.error, /Non-reentrant/);
});

const root = fileURLToPath(new URL("../../", import.meta.url));
for (const selection of ["new-examples.json", "clev3r-parity.json"]) {
  const plan = JSON.parse(await fs.readFile(path.join(root, "examples", selection), "utf8"));
  for (const lesson of plan) {
    test(`${selection}: ${lesson.project}`, async () => {
      const loaded = await loadProject(path.join(root, "examples", lesson.project));
      assert.deepEqual(loaded.diagnostics, []);
      assert(loaded.project);
      const front = await new BasicPlusFrontend().compile(
        loaded.project,
        new AbortController().signal,
      );
      assert.deepEqual(front.diagnostics, []);
      assert(front.ir);
      assert.deepEqual(validateIR(front.ir), []);
      const back = await new EV3Backend().compile(front.ir, new AbortController().signal);
      assert.deepEqual(back.diagnostics, []);
      assert(back.rbf);
      const decoded = decode(back.rbf);
      const result = {
        project: lesson.project,
        ...new VM(decoded, lesson.defaultInput ?? {}).run(),
        variants: (lesson.scenarios ?? []).map(({ input }) => ({
          scenario: input,
          ...new VM(decoded, input).run(),
        })),
      };
      const checked = checkResults([lesson], [result])[0];
      assert.deepEqual(
        checked.checks.filter((check) => !check.pass),
        [],
      );
    });
  }
}
