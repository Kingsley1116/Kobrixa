import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { build } from "esbuild";
import { root, fixture, readFixtures } from "./declarative-ui-harness.mjs";

const require = createRequire(path.join(root, "apps/desktop/package.json"));
const plainGlyphs = process.argv.slice(2).includes("--plain-glyphs");
assert.deepEqual(process.argv.slice(2), plainGlyphs ? ["--plain-glyphs"] : []);
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-ui-browser-")));
console.log(`Real workbench browser workspace: ${directory}`);
await cp(path.join(root, "apps/desktop/.vite"), path.join(directory, ".vite"), { recursive: true });
await cp(
  path.join(root, "apps/desktop/out/stage/node_modules"),
  path.join(directory, "node_modules"),
  { recursive: true },
);
const alias = Object.fromEntries(
  [
    ["plugin-protocol", "plugin-protocol"],
    ["plugin-sdk", "plugin-sdk-js"],
  ].map(([name, folder]) => [
    `@kobrixa/${name}`,
    path.join(root, `packages/${folder}/src/index.ts`),
  ]),
);
const sources = [];
for (let n = 0; n < 2; n++) {
  const folder = path.join(directory, `source-${n}`);
  sources.push(folder);
  await mkdir(folder);
  const data = await readFixtures();
  // Diagnostic mode isolates a platform emoji-rasterization failure. Keep the
  // wire Unicode assertion intact; this mode cannot establish emoji UI support.
  if (plainGlyphs) data.panel.fields.note.initial = "界";
  for (const [file, object] of [
    ["kobrixa-plugin.json", data.manifest],
    ["panel.json", data.panel],
    ["status.json", data.status],
  ])
    await writeFile(
      path.join(folder, file),
      JSON.stringify(object).replaceAll("acceptance.ui", `acceptance.ui-${n}`),
    );
  await build({
    entryPoints: [new URL("consumer.ts", fixture).pathname],
    outfile: path.join(folder, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    alias,
    banner: { js: 'console.error("UI_PID:" + process.pid);' },
  });
}
const entry = path.join(directory, ".vite/build/ui-browser-main.cjs");
const probe = path.join(directory, "probe.js");
await build({
  entryPoints: [path.join(root, "tests/desktop/declarative-ui-browser-main.ts")],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await build({
  entryPoints: [path.join(root, "tests/desktop/declarative-ui-browser.ts")],
  outfile: probe,
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "declarativeProbe",
  alias,
});
const artifact = {
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty:
    execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length >
    0,
  glyphs: plainGlyphs ? "cjk-diagnostic" : "emoji-and-cjk",
  sha256: Object.fromEntries(
    await Promise.all(
      [
        ".vite/build/main.cjs",
        ".vite/build/preload.cjs",
        ...(
          await readdir(path.join(directory, ".vite/renderer/main_window"), {
            recursive: true,
            withFileTypes: true,
          })
        )
          .filter((entry) => entry.isFile())
          .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name))),
        ".vite/build/ui-browser-main.cjs",
        "probe.js",
        "source-0/main.cjs",
        "source-1/main.cjs",
        ...[0, 1].flatMap((n) =>
          ["kobrixa-plugin.json", "panel.json", "status.json"].map((name) => `source-${n}/${name}`),
        ),
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(path.join(directory, name)))
          .digest("hex"),
      ]),
    ),
  ),
};
await writeFile(path.join(directory, "artifact-identity.json"), JSON.stringify(artifact, null, 2));
const output = path.join(directory, "browser.json");
const child = spawn(
  require("electron"),
  [
    entry,
    "--enable-logging=stderr",
    `--ui-browser-output=${output}`,
    `--ui-browser-probe=${probe}`,
    `--user-data-dir=${path.join(directory, "profile")}`,
    `--plugin-dev-dir=${sources.join(path.delimiter)}`,
  ],
  { cwd: directory, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" },
);
const log = [];
for (const stream of [child.stdout, child.stderr])
  stream.on("data", (data) => {
    log.push(data.toString());
    process.stderr.write(data);
  });
const terminate = () => {
  if (!child.pid) return;
  if (process.platform === "win32")
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
};
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  terminate();
}, 100_000);
let result;
try {
  result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
} finally {
  clearTimeout(timer);
  await writeFile(path.join(directory, "electron.log"), log.join(""));
  if (!result || result.code !== 0 || timedOut) terminate();
}
assert.equal(timedOut, false);
assert.equal(result.code, 0, JSON.stringify(result));
const report = JSON.parse(await readFile(output, "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const deadline = performance.now() + 5000;
while (report.childPids.some(alive) && performance.now() < deadline) await pause(25);
report.remainingPids = report.childPids.filter(alive);
report.normalClose = result.code === 0 && !timedOut;
report.artifact = artifact;
report.emojiDisplay = plainGlyphs ? "not-tested" : "passed";
await writeFile(output, JSON.stringify(report, null, 2));
assert.deepEqual(report.remainingPids, []);
assert.equal(report.kind, "ui-browser-baseline");
assert.equal(report.nativeInput, true);
console.log(
  `PASS ${plainGlyphs ? "CJK diagnostic" : "actual production workbench"} baseline: ${output}`,
);
console.log(
  "Motion races, renderer diagnostics and load remain separate acceptance gates.",
);
