// Usage: node tools/audit-new-examples.mjs bytecodes.h bytecodes.c output-directory
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { checkResults } from "./check-new-example-results.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const selectionArgument = args[0] === "--selection" ? args.splice(0, 2)[1] : undefined;
const [header, table, output] = args;
assert(header && table && output, "Expected bytecodes.h, bytecodes.c, and output directory");
const require = createRequire(import.meta.url);
const build = spawnSync(
  process.execPath,
  [
    require.resolve("typescript/bin/tsc"),
    "-b",
    "--force",
    path.join(root, "packages/backend-ev3/tsconfig.json"),
    path.join(root, "frontends/basic-plus/tsconfig.json"),
  ],
  { stdio: "inherit" },
);
if (build.error) throw build.error;
assert.equal(build.status, 0, "Compiler package build failed");
const selection = path.resolve(root, selectionArgument ?? "examples/new-examples.json");
const plan = JSON.parse(await fs.readFile(selection, "utf8"));
const run = spawnSync(
  process.execPath,
  [
    path.join(root, "tools/run-example-bytecode.mjs"),
    path.resolve(header),
    path.resolve(table),
    path.resolve(output),
    selection,
  ],
  { stdio: "inherit" },
);
if (run.error) throw run.error;
assert.equal(run.status, 0, "Bytecode build/decode failed");
const results = JSON.parse(await fs.readFile(path.join(output, "results.json"), "utf8"));
const lessons = checkResults(plan, results);
const firmware = await Promise.all(
  [header, table].map(async (file) => ({
    name: path.basename(file),
    sha256: createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex"),
  })),
);
const report = {
  scope: `Only the projects listed in ${path.relative(root, selection).split(path.sep).join("/")}; no historical examples audited.`,
  method:
    "Decode and execute emitted RBF bytes using firmware opcode/parameter tables and deterministic device stubs.",
  firmware,
  compilerRegressions: JSON.parse(
    await fs.readFile(path.join(output, "compiler-regressions.json"), "utf8"),
  ),
  projects: lessons.length,
  runs: lessons.reduce((sum, lesson) => sum + lesson.runs, 0),
  assertions: lessons.reduce((sum, lesson) => sum + lesson.checks.length, 0),
  mismatches: lessons.reduce(
    (sum, lesson) => sum + lesson.checks.filter((check) => !check.pass).length,
    0,
  ),
  lessons,
};
await fs.writeFile(
  path.join(output, "checked-results.json"),
  JSON.stringify(report, null, 2) + "\n",
);
for (const lesson of lessons)
  for (const check of lesson.checks.filter((check) => !check.pass))
    console.error(lesson.project, check);
console.log(
  `${report.projects} new examples, ${report.runs} runs, ${report.assertions} assertions, ${report.mismatches} mismatches`,
);
if (report.mismatches) process.exitCode = 1;
