import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { developmentSourceKey } from "../../packages/plugin-runtime/dist/index.js";
import {
  readStaticLanguageFixtures,
  writeStaticLanguageFixtures,
} from "./static-languages-fixtures.mjs";
import { waitForSmokeExit } from "./plugins-smoke-process.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const electron = require("electron");
const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-static-acceptance-"));
let passed = false;
try {
  const paths = await writeStaticLanguageFixtures(path.join(directory, "plugins"));
  const { builtin, binding } = await readStaticLanguageFixtures();
  await writeFile(path.join(directory, "input.json"), JSON.stringify({ paths, builtin, binding }));
  const main = path.join(directory, "main.cjs");
  await build({
    entryPoints: [path.join(root, "tests/desktop/static-languages-main.ts")],
    outfile: main,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    alias: {
      "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
      "@kobrixa/plugin-runtime": path.join(root, "packages/plugin-runtime/src/index.ts"),
    },
  });
  const run = async (phase, profile, killed = false) => {
    const child = spawn(electron, [main, `--user-data-dir=${profile}`, directory, phase], {
      stdio: "inherit",
    });
    const result = await waitForSmokeExit(child, `static languages ${phase}`);
    if (killed) {
      assert.notEqual(result.code, 0);
      const ready = JSON.parse(await readFile(path.join(directory, `${phase}-ready.json`), "utf8"));
      assert.equal(ready.launches, 0);
      const marker = JSON.parse(await readFile(path.join(profile, "plugins/session.json"), "utf8"));
      assert.equal(marker.thirdPartyStaticContributions, true);
    } else assert.equal(result.code, 0, `${phase}: ${result.signal}`);
  };
  for (const phase of ["lifecycle", "conflicts", "cli-safe"])
    await run(phase, path.join(directory, phase));
  for (const [crash, recover] of [
    ["unclean", "recover"],
    ["hang", "recover-hang"],
  ]) {
    const profile = path.join(directory, `${crash}-profile`);
    await run(crash, profile, true);
    await run(recover, profile);
    await assert.rejects(readFile(path.join(profile, "plugins/session.json")), { code: "ENOENT" });
  }
  const failureProfile = path.join(directory, "failure-profile");
  await mkdir(path.join(failureProfile, "plugins"), { recursive: true });
  await writeFile(
    path.join(failureProfile, "plugins/state.json"),
    JSON.stringify({
      schemaVersion: 2,
      developerMode: false,
      sources: [],
      legacyDisabledIds: [],
      disabled: [developmentSourceKey(await realpath(paths.toy))],
    }),
  );
  await run("marker-failure", failureProfile);
  passed = true;
} finally {
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Static language acceptance artifacts: ${directory}`);
}
