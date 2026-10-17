import { createServer } from "vite";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";
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
import {
  HOSTILE_PATTERN,
  HOSTILE_COMPILED_PATTERN,
  HOSTILE_DOCUMENT,
  killStaticAcceptanceChild,
  waitForHostileTermination,
} from "./static-languages-stress.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(path.join(root, "apps/desktop/package.json"));
const electron = require("electron");
const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-static-acceptance-"));
const server = await createServer({
  root: path.join(root, "apps/desktop"),
  configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
  // Prebundle both entries together so the late private import shares the
  // registrar's TokenizationRegistry instead of creating a second singleton.
  optimizeDeps: {
    include: ["monaco-editor", "monaco-editor/editor/common/languages.js"],
  },
  server: { host: "127.0.0.1", port: 0, watch: null, hmr: false },
});
let passed = false;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const rendererUrl = `http://127.0.0.1:${address.port}/@fs/${path.join(root, "tests/desktop/static-languages-browser.html")}`;
  await build({
    entryPoints: [path.join(root, "apps/desktop/src/preload/index.ts")],
    outfile: path.join(directory, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
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
    plugins: [rawResourcePlugin()],
    alias: {
      "@kobrixa/plugin-protocol": path.join(root, "packages/plugin-protocol/src/index.ts"),
      "@kobrixa/plugin-runtime": path.join(root, "packages/plugin-runtime/src/index.ts"),
    },
  });
  const run = async (phase, profile, killed = false) => {
    const recovery = phase === "recover-hostile";
    const child = spawn(
      electron,
      [main, `--user-data-dir=${profile}`, rendererUrl, directory, phase],
      {
        stdio: "inherit",
        detached: recovery && process.platform !== "win32",
      },
    );
    // A regression that re-registers the hostile language during Restore must
    // also stay bounded and cannot leave a renderer running in the background.
    const recoveryDeadline = recovery
      ? setTimeout(() => killStaticAcceptanceChild(child), 10_000)
      : undefined;
    const result = await waitForSmokeExit(child, `static languages ${phase}`).finally(() => {
      clearTimeout(recoveryDeadline);
      if (recovery) killStaticAcceptanceChild(child);
    });
    if (killed) {
      assert.notEqual(result.code, 0);
      const ready = JSON.parse(await readFile(path.join(directory, `${phase}-ready.json`), "utf8"));
      assert.equal(ready.launches, 0);
      const marker = JSON.parse(await readFile(path.join(profile, "plugins/session.json"), "utf8"));
      assert.equal(marker.thirdPartyStaticContributions, true);
    } else assert.equal(result.code, 0, `${phase}: ${result.signal}`);
  };
  for (const phase of ["browser", "lifecycle", "conflicts", "cli-safe"])
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
  const stressProfile = path.join(directory, "hostile-profile");
  const stressStarted = performance.now();
  const hostile = spawn(
    electron,
    [main, `--user-data-dir=${stressProfile}`, rendererUrl, directory, "hostile-tokenization"],
    { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"] },
  );
  const proof = await waitForHostileTermination(hostile);
  assert.equal(proof.ready.launches, 0);
  assert.ok(Number.isSafeInteger(proof.ready.rendererPid) && proof.ready.rendererPid > 0);
  assert.equal(proof.ready.languageId, "toy-hostile");
  assert.equal(proof.ready.pattern, HOSTILE_PATTERN);
  assert.equal(proof.ready.codeUnits, HOSTILE_DOCUMENT.length);
  assert.equal(proof.entered.pattern, HOSTILE_COMPILED_PATTERN);
  assert.equal(proof.entered.languageId, "toy-hostile");
  assert.equal(proof.entered.codeUnits, HOSTILE_DOCUMENT.length);
  assert.equal(proof.entered.documentUri, "file:///stress/document.hostile");
  const stressMarker = JSON.parse(
    await readFile(path.join(stressProfile, "plugins/session.json"), "utf8"),
  );
  assert.equal(stressMarker.thirdPartyStaticContributions, true);
  assert.equal(stressMarker.thirdPartyRunning, false);
  if (proof.unresponsive) assert.equal(stressMarker.rendererUnresponsive, true);
  await writeFile(
    path.join(directory, "stress-result.json"),
    JSON.stringify({ ...proof, marker: stressMarker }, null, 2),
  );
  console.log(
    `PASS static acceptance: hostile-tokenization ${JSON.stringify({ ...proof, marker: stressMarker })}`,
  );
  await run("recover-hostile", stressProfile);
  await assert.rejects(readFile(path.join(stressProfile, "plugins/session.json")), {
    code: "ENOENT",
  });
  const recovery = JSON.parse(await readFile(path.join(directory, "stress-recovery.json"), "utf8"));
  recovery.sessionMarkerCleared = true;
  recovery.totalMs = Math.round(performance.now() - stressStarted);
  await writeFile(path.join(directory, "stress-recovery.json"), JSON.stringify(recovery, null, 2));
  console.log(`PASS static stress recovery evidence: ${JSON.stringify(recovery)}`);
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
  await server.close();
  if (passed && process.env.STATIC_LANGUAGE_ACCEPTANCE_KEEP_ARTIFACTS !== "1")
    await rm(directory, { recursive: true, force: true });
  else console.error(`Static language acceptance artifacts: ${directory}`);
}
