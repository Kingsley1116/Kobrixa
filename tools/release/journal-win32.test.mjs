import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  journalBuildArgs,
  validateProductionJournal,
  JOURNAL_DEVELOPMENT,
} from "./journal-win32.mjs";
import { prepareJournalHarness } from "./journal-harness.mjs";
import { journalFixture } from "./journal-win32-fixture.mjs";

test("fresh production builds pin Electron headers, target architecture and disable hooks explicitly", () => {
  for (const arch of ["x64", "arm64"]) {
    assert.deepEqual(journalBuildArgs("isolated", "44.7.0", arch), [
      "rebuild",
      "--directory=isolated",
      "--target=44.7.0",
      `--arch=${arch}`,
      "--dist-url=https://electronjs.org/headers",
      "--devdir=isolated/headers",
      "--journal_test_hooks=0",
    ]);
    validateProductionJournal(journalFixture(arch), arch);
  }
  assert.throws(() => journalBuildArgs("isolated", "44.7.0", "ia32"), /Unsupported/);
  assert.throws(() => validateProductionJournal(Buffer.from("invalid"), "x64"), /PE addon/);
});

test("temporary Electron main resolves validated production bytes via the development contract", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-journal-harness-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "production.node");
  const main = path.join(directory, "app/main.cjs");
  const electron = path.join(directory, "electron.exe");
  const options = { electron, source, arch: "x64" };
  assert.equal(prepareJournalHarness("other.exe", [main], options), false);
  assert.equal(
    prepareJournalHarness(electron, [path.join(directory, "installed.exe")], options),
    false,
  );
  assert.throws(() => prepareJournalHarness(electron, [main], options), { code: "ENOENT" });
  const bytes = journalFixture();
  await writeFile(source, bytes);
  assert.equal(prepareJournalHarness(electron, ["--no-sandbox", main], options), true);
  assert.deepEqual(await readFile(path.join(path.dirname(main), JOURNAL_DEVELOPMENT)), bytes);
  const receipt = JSON.parse(
    await readFile(path.join(path.dirname(main), "journal-addon.json"), "utf8"),
  );
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  await writeFile(source, journalFixture("x64", true));
  assert.throws(
    () => prepareJournalHarness(electron, [main], options),
    /Test-hook addon cannot ship/,
  );
});
