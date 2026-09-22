// Usage: node tools/run-example-bytecode.mjs bytecodes.h bytecodes.c output-directory [selection.json]
import assert from "node:assert/strict";
import { runCompilerRegressions } from "../tests/bytecode/support/compiler-regressions.mjs";
import { decode as decodeBytes, VM, firmwareTables } from "../tests/bytecode/support/ev3-vm.mjs";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { EV3Backend } from "../packages/backend-ev3/dist/index.js";
import { BasicPlusFrontend } from "../frontends/basic-plus/dist/index.js";
import { loadProject } from "../packages/compiler/dist/index.js";
import { validateIR } from "../packages/ir/dist/index.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const [headerPath, tablePath, outputPath, selectionPath] = process.argv.slice(2);
assert(
  headerPath && tablePath && outputPath,
  "Expected bytecodes.h, bytecodes.c, and output directory arguments",
);
const tables = firmwareTables(
  await fs.readFile(headerPath, "utf8"),
  await fs.readFile(tablePath, "utf8"),
);
const decode = (bytes) => decodeBytes(bytes, tables);
async function projects(dir) {
  const es = await fs.readdir(dir, { withFileTypes: true });
  if (es.some((e) => e.name === "kobrixa.json")) return [dir];
  return (
    await Promise.all(
      es
        .filter((e) => e.isDirectory() && !["build", "node_modules"].includes(e.name))
        .map((e) => projects(path.join(dir, e.name))),
    )
  ).flat();
}
async function auditExamples() {
  const out = path.resolve(outputPath);
  await fs.mkdir(out, { recursive: true });
  const regressions = await runCompilerRegressions((bytes) => new VM(decode(bytes)).run());
  await fs.writeFile(
    path.join(out, "compiler-regressions.json"),
    JSON.stringify(regressions, null, 2) + "\n",
  );
  const results = [];
  const selection = selectionPath ? JSON.parse(await fs.readFile(selectionPath, "utf8")) : null;
  if (selection) {
    assert(selection.length > 0, "Empty example selection");
    assert.equal(new Set(selection.map((item) => item.project)).size, selection.length);
    for (const item of selection)
      assert(/^[a-z0-9-]+\/[a-z0-9-]+$/.test(item.project), "Invalid example path");
  }
  const directories = selection
    ? selection.map((item) => path.join(root, "examples", item.project))
    : await projects(path.join(root, "examples"));
  for (const dir of directories.sort()) {
    const project = path.relative(path.join(root, "examples"), dir).split(path.sep).join("/"),
      loaded = await loadProject(dir);
    assert.deepEqual(loaded.diagnostics, [], project + " project diagnostics");
    assert(loaded.project, project + " missing project");
    const front = await new BasicPlusFrontend().compile(
      loaded.project,
      new AbortController().signal,
    );
    assert.deepEqual(front.diagnostics, [], project + " frontend diagnostics");
    assert(front.ir, project + " missing IR");
    assert.deepEqual(validateIR(front.ir), [], project + " IR diagnostics");
    const back = await new EV3Backend().compile(front.ir, new AbortController().signal);
    assert.deepEqual(back.diagnostics, [], project + " backend diagnostics");
    if (!back.rbf) throw Error(project + JSON.stringify(back.diagnostics));
    const selected = selection?.find((item) => item.project === project);
    const decoded = decode(back.rbf);
    const sim = new VM(decoded, selected?.defaultInput ?? {}).run();
    const variants = [];
    if (selected)
      for (const { input: scenario } of selected.scenarios ?? [])
        variants.push({ scenario, ...new VM(decoded, scenario).run() });
    if (
      !selection &&
      (project.startsWith("sensors/") ||
        project.startsWith("capstones/") ||
        project === "motors/motor-counter")
    )
      for (const scenario of [
        { sensor: 0, motorCount: 0, button: 1 },
        { sensor: 75, motorCount: -1, button: 2 },
      ])
        variants.push({ scenario, ...new VM(decoded, scenario).run() });
    if (!selection && ["sensors/raw-and-mode", "sensors/sensor-details"].includes(project)) {
      for (const sensor of [-42, -2147483648]) {
        const scenario = { sensor };
        variants.push({ scenario, ...new VM(decoded, scenario).run() });
      }
    }
    const filename = project.replaceAll("/", "--");
    await fs.writeFile(path.join(out, filename + ".rbf"), back.rbf);
    await fs.writeFile(
      path.join(out, filename + ".json"),
      JSON.stringify({ ir: front.ir, decoded, sim, variants }, null, 2),
    );
    results.push({
      project,
      bytes: back.rbf.length,
      sha256: createHash("sha256").update(back.rbf).digest("hex"),
      sources: loaded.project.sources.map((source) => ({
        path: source.path,
        sha256: createHash("sha256").update(source.content).digest("hex"),
      })),
      instructions: decoded.objects.reduce((n, o) => n + o.ins.length, 0),
      ...sim,
      variants,
    });
    console.log(
      project,
      sim.status,
      sim.error ?? "",
      sim.trace
        .filter((x) => x.op === "UI_DRAW.TEXT" || x.op === "UI_DRAW.VALUE")
        .slice(0, 8)
        .map((x) => x.args),
    );
  }
  await fs.writeFile(path.join(out, "results.json"), JSON.stringify(results, null, 2));
}
if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await auditExamples();
