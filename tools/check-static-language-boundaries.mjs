import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-boundaries-"));
const pnpmEntry = process.env.npm_execpath;
assert.ok(pnpmEntry, "Run through pnpm test:static-languages:boundaries");
function run(args) {
  const result = spawnSync(process.execPath, [pnpmEntry, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      pnpm_config_pm_on_fail: "ignore",
      pnpm_config_verify_deps_before_run: "false",
    },
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error) throw result.error;
  assert.equal(result.status, 0, args.join(" "));
  return `${result.stdout}\n${result.stderr}`;
}
const groups = [
  [
    "@kobrixa/plugin-protocol",
    [
      "src/conformance.test.ts",
      "src/json-schema.test.ts",
      "src/static-language-manifest.test.ts",
      "src/static-language-schemas.test.ts",
      "src/static-language-regex.test.ts",
      "src/static-language-graph.test.ts",
      "src/static-languages.test.ts",
    ],
    [
      "boundary structural inventory is complete",
      "boundary manifest collections and text",
      "boundary resource path grammar and versions",
      "boundary raw and compiled regex sources",
      "boundary include depth independently of DFS visitation order",
      "boundary expanded rules with bounded raw entries",
      "boundary semantic totals and byte counters",
    ],
  ],
  [
    "@kobrixa/plugin-runtime",
    ["src/packaged-json-resource.test.ts", "src/static-languages.test.ts"],
    [
      "boundary original file bytes for disk and builtin providers",
      "boundary runtime plugin and global admission totals",
    ],
  ],
  [
    "@kobrixa/desktop",
    [
      "src/renderer/editor/static-language-registration.test.ts",
      "src/renderer/editor/static-language-migration.test.ts",
    ],
    [
      "boundary session distinct ids at zero one 255 256 257",
      "validates real macro literals and the 4096 transformed-source boundary before Monaco",
    ],
  ],
];
try {
  for (const [index, [pkg, files, required]] of groups.entries()) {
    const report = path.join(directory, `${index}.json`);
    run([
      "--filter",
      pkg,
      "exec",
      "vitest",
      "run",
      ...files,
      "--allowOnly=false",
      "--reporter=json",
      `--outputFile=${report}`,
    ]);
    const result = JSON.parse(await readFile(report, "utf8"));
    assert.equal(result.success, true);
    const tests = result.testResults.flatMap((suite) => suite.assertionResults);
    assert.ok(tests.length > 0);
    assert.ok(
      tests.every((test) => test.status === "passed"),
      "No skipped/pending boundary suite tests",
    );
    console.log(`PASS ${pkg}: ${tests.length} tests, no skipped cases`);
    for (const title of required)
      assert.ok(
        tests.some((test) => test.title === title),
        `Missing assigned boundary test: ${title}`,
      );
  }
  const python = run(["test:python-sdk"]);
  assert.doesNotMatch(python, /\bskip(?:ped)?\b/i, "Python schema conformance must execute");
} finally {
  await rm(directory, { recursive: true, force: true });
}
