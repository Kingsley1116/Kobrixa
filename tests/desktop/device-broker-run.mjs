import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  root,
  run,
  assertParity,
  assertLoad,
  assertArtifactIdentity,
} from "./device-broker-harness.mjs";

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const electron = require("electron");
const temporary = await mkdtemp(path.join(tmpdir(), "kobrixa-device-transport-"));
const python = [process.env.KOBRIXA_TEST_PYTHON, "python3", "python"].filter(Boolean).find(
  (command) =>
    spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)"], {
      stdio: "ignore",
    }).status === 0,
);
if (!python) throw new Error("Python 3.10+ is required; no SKIP acceptance");
const alias = Object.fromEntries(
  [
    ["plugin-protocol", "plugin-protocol"],
    ["plugin-runtime", "plugin-runtime"],
    ["plugin-sdk", "plugin-sdk-js"],
  ].map(([name, folder]) => [
    `@kobrixa/${name}`,
    path.join(root, `packages/${folder}/src/index.ts`),
  ]),
);
const bundle = (entry, outfile, external = []) =>
  build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    external,
  });
let passed = false;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
try {
  for (const language of ["js", "python"]) await mkdir(path.join(temporary, language));
  await bundle("tests/desktop/device-broker-main.ts", path.join(temporary, "main.cjs"), [
    "electron",
  ]);
  await bundle(
    "tests/desktop/fixtures/device-broker/consumer.ts",
    path.join(temporary, "js/consumer.cjs"),
  );
  await cp(
    path.join(root, "tests/desktop/fixtures/device-broker/consumer.py"),
    path.join(temporary, "python/consumer.py"),
  );
  await bundle(
    "tests/desktop/fixtures/device-broker/provider-stall.ts",
    path.join(temporary, "stall.cjs"),
  );
  const manifest = JSON.parse(
    await readFile(
      path.join(root, "tests/desktop/fixtures/device-broker/kobrixa-plugin.json"),
      "utf8",
    ),
  );
  await writeFile(path.join(temporary, "js/kobrixa-plugin.json"), JSON.stringify(manifest));
  await writeFile(
    path.join(temporary, "python/kobrixa-plugin.json"),
    JSON.stringify({ ...manifest, runtime: { kind: "python", entry: "consumer.py" } }),
  );
  const identity = {
    commit,
    artifact: {
      dirty,
      sha256: Object.fromEntries(
        await Promise.all(
          ["main.cjs", "js/consumer.cjs", "python/consumer.py", "stall.cjs"].map(async (file) => [
            file,
            createHash("sha256")
              .update(await readFile(path.join(temporary, file)))
              .digest("hex"),
          ]),
        ),
      ),
    },
  };
  await writeFile(path.join(temporary, "artifact-identity.json"), JSON.stringify(identity));
  const load = process.argv.includes("--load");
  await run(
    electron,
    [
      "--js-flags=--expose-gc",
      path.join(temporary, "main.cjs"),
      `--user-data-dir=${path.join(temporary, "profile")}`,
      temporary,
      python,
    ],
    {
      env: { PYTHONPATH: path.join(root, "sdks/python"), KOBRIXA_DEVICE_LOAD: load ? "1" : "0" },
      timeoutMs: load ? 900_000 : 150_000,
    },
  );
  const report = JSON.parse(await readFile(path.join(temporary, "transport-result.json"), "utf8"));
  assertArtifactIdentity(report, identity);
  assertParity(report);
  const requirements = [
    "absent",
    "required-supported",
    "optional-supported",
    "required-unknown-version",
    "optional-unknown-version",
    "required-disabled",
  ];
  const channelCases = [
    "reply-before-delivery",
    "event-delivery-withheld",
    "hostile-requirements",
    "subscribe-send-throws",
    "subscribe-invalid-result",
    "subscribe-cancel",
    "metadata-absent",
    "metadata-wrong",
    "metadata-retired",
  ];
  assert.equal(report.negotiations.length, requirements.length * 2);
  for (const language of ["js", "python"]) {
    for (const name of requirements) {
      const rows = report.negotiations.filter(
        (row) => row.language === language && row.name === name,
      );
      assert.equal(rows.length, 1, `${language}/${name}: missing or duplicate negotiation`);
      assert.equal(rows[0].ok, true);
    }
    for (const name of channelCases) {
      const rows = report.channelChecks.filter(
        (row) => row.language === language && row.name === name,
      );
      assert.equal(rows.length, 1, `${language}/${name}: missing or duplicate channel evidence`);
      assert.equal(rows[0].ok, true);
      if (name === "reply-before-delivery") assert.ok(rows[0].events > 0);
    }
    for (const name of [
      ...requirements,
      ...channelCases.filter((name) => name !== "reply-before-delivery"),
    ]) {
      const rows = report.channelChecks.filter(
        (row) => row.language === language && row.name === `retired:${name}`,
      );
      assert.equal(rows.length, 1, `${language}/${name}: missing retired owner check`);
      assert.equal(rows[0].ok, true);
    }
  }
  if (load) {
    report.load = JSON.parse(await readFile(path.join(temporary, "load-result.json"), "utf8"));
    assertLoad(report.load, identity);
    for (const [name, values] of Object.entries({
      stopDispatch: report.load.stopDispatchMs,
      ...report.load.measurements,
    })) {
      const sorted = [...values].sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          phase: name,
          samples: sorted.length,
          p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          max: sorted.at(-1),
        }),
      );
    }
  }
  const marker = path.join(temporary, "stall-entered.json");
  const child = spawn(process.execPath, [path.join(temporary, "stall.cjs"), marker], {
    stdio: "ignore",
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const limit = performance.now() + 5_000;
  try {
    for (;;) {
      const value = await readFile(marker, "utf8").catch(() => null);
      if (value) {
        assert.equal(JSON.parse(value).pid, child.pid);
        break;
      }
      if (performance.now() >= limit) throw new Error("Stall fixture failed to enter");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    child.kill("SIGKILL");
  }
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Stall child survived kill")), 5_000),
    ),
  ]);
  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  report.stall = "child-entered-and-killed";
  // Controller keeps this artifact with the acceptance report before deleting the temp directory.
  console.log(JSON.stringify(report, null, 2));
  passed = true;
} finally {
  if (passed) await rm(temporary, { recursive: true, force: true });
  else console.error(`Device transport artifacts: ${temporary}`);
}
