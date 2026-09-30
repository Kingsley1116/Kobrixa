import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BuildSession, loadProject } from "../../../packages/compiler/dist/index.js";
import { BasicPlusFrontend } from "../../../frontends/basic-plus/dist/index.js";
import { EV3Backend } from "../../../packages/backend-ev3/dist/index.js";
import { decode } from "./ev3-vm.mjs";

export async function compileRobotFixture() {
  const entry = fileURLToPath(new URL("../fixtures/robot-control/", import.meta.url));
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "kobrixa-bytecode-test-"));
  try {
    const loaded = await loadProject(path.resolve(entry));
    assert.deepEqual(loaded.diagnostics, []);
    assert(loaded.project);
    // Build artifacts stay in a temporary directory outside the source fixture.
    const project = {
      ...loaded.project,
      root: out,
      manifest: { ...loaded.project.manifest, outputDir: "build" },
    };
    // These subcalls are exercised directly by the movement/robot tests even
    // when the fixture's main object does not call them.
    const backend = new EV3Backend({
      retainFunctions: ["move_gyro", "move_time", "turn_gyro", "speed", "atan2_m90"],
    });
    const build = await new BuildSession(new BasicPlusFrontend(), backend).compile(project);
    assert.equal(build.success, true, JSON.stringify(build.diagnostics));
    assert.deepEqual(build.diagnostics, []);
    const rbf = await fs.readFile(build.artifacts.find((a) => a.kind === "rbf").path);
    const ir = JSON.parse(
      await fs.readFile(build.artifacts.find((a) => a.kind === "ir").path, "utf8"),
    );
    const listing = await fs.readFile(
      build.artifacts.find((a) => a.kind === "listing").path,
      "utf8",
    );
    const decoded = decode(rbf);
    const names = listing
      .trim()
      .split("\n")
      .map((line) => line.split("\t")[1]);
    const globals = new Map();
    let offset = 0;
    for (const variable of ir.globals) {
      const size = variable.type.kind === "string" ? 252 : variable.type.kind === "boolean" ? 1 : 4;
      offset = Math.ceil(offset / (size >= 4 ? 4 : 1)) * (size >= 4 ? 4 : 1);
      globals.set(variable.name, { offset, kind: variable.type.kind });
      offset += size;
    }
    function global(vm, name, value) {
      const { offset, kind } = globals.get(name);
      if (value !== undefined) {
        if (kind === "number") vm.g.writeFloatLE(value, offset);
        else if (kind === "string") {
          vm.g.fill(0, offset, offset + 252);
          vm.g.write(value + "\0", offset);
        } else vm.g.writeInt32LE(value, offset);
      }
      return kind === "number"
        ? vm.g.readFloatLE(offset)
        : kind === "string"
          ? vm.g.toString("utf8", offset, vm.g.indexOf(0, offset))
          : vm.g.readInt32LE(offset);
    }
    return { decoded, names, global };
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
}
