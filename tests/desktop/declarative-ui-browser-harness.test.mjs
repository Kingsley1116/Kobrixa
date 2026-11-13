import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { prepareJournalHarness } from "../../tools/release/journal-harness.mjs";
import { JOURNAL_DEVELOPMENT } from "../../tools/release/journal-win32.mjs";
import { journalFixture } from "../../tools/release/journal-win32-fixture.mjs";

test("browser observer main receives production journal bytes at its Electron app path", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-browser-journal-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "production.node");
  const main = path.join(directory, ".vite/build/ui-browser-main.cjs");
  const electron = path.join(directory, "electron.exe");
  const bytes = journalFixture();
  await writeFile(source, bytes);
  assert.equal(prepareJournalHarness(electron, [main], { source, electron, arch: "x64" }), true);
  assert.deepEqual(await readFile(path.join(path.dirname(main), JOURNAL_DEVELOPMENT)), bytes);
  await writeFile(source, journalFixture("x64", true));
  assert.throws(
    () => prepareJournalHarness(electron, [main], { source, electron, arch: "x64" }),
    /Test-hook addon cannot ship/,
  );
  const runner = await readFile(
    new URL("./declarative-ui-browser-run.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /import "\.\.\/\.\.\/tools\/release\/journal-harness.mjs"/);
});

test("blocked production cleanup fails synchronously with complete disposition", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-browser-cleanup-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "cleanup.cjs");
  await build({
    entryPoints: ["tests/desktop/declarative-ui-browser-cleanup.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  const { observeBlockedCleanup } = createRequire(import.meta.url)(outfile);
  const logs = [],
    failures = [];
  const logger = { error: (...args) => logs.push(args) };
  const original = logger.error;
  const restore = observeBlockedCleanup(logger, (error) => failures.push(error));
  logger.error("ordinary diagnostic");
  assert.equal(failures.length, 0);
  const error = Object.assign(new Error("Device or persistence disposition is incomplete."), {
    device: { stopConfirmed: true, journalCommitted: false, faultIds: [] },
    storage: [],
    reason: "journal-unwritable",
  });
  logger.error("Device cleanup blocked.", error);
  assert.equal(failures.length, 1);
  const disposition = JSON.parse(failures[0].message.slice("Device cleanup blocked: ".length))[0];
  assert.deepEqual(disposition.device, error.device);
  assert.deepEqual(disposition.storage, []);
  assert.equal(disposition.reason, error.reason);
  assert.equal(disposition.message, error.message);
  assert.equal(logs[1][1], error);
  restore();
  assert.equal(logger.error, original);
});
