// Node-only --import bootstrap for native acceptance runners. Electron launched
// with an absolute main.cjs uses its containing directory as app.getAppPath().
// Populate the normal development location there; production has no env fallback.
import childProcess from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire, syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { repositoryRoot } from "./common.mjs";
import { JOURNAL_DEVELOPMENT, validateProductionJournal } from "./journal-win32.mjs";

export function prepareJournalHarness(file, args, { electron, source, arch }) {
  if (path.resolve(file).toLowerCase() !== path.resolve(electron).toLowerCase()) return false;
  const main = args?.find((arg) => path.isAbsolute(arg) && path.basename(arg) === "main.cjs");
  if (!main) return false;
  const bytes = readFileSync(source); // Missing or hook-enabled builds fail before launch.
  validateProductionJournal(bytes, arch);
  const destination = path.join(path.dirname(main), JOURNAL_DEVELOPMENT);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes);
  writeFileSync(
    path.join(path.dirname(main), "journal-addon.json"),
    JSON.stringify(
      {
        source,
        destination,
        arch,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      null,
      2,
    ),
  );
  return true;
}

if (process.platform === "win32") {
  const require = createRequire(path.join(repositoryRoot, "apps/desktop/package.json"));
  const options = {
    electron: require("electron"),
    source: path.join(repositoryRoot, "apps/desktop", JOURNAL_DEVELOPMENT),
    arch: process.arch,
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = function (file, args, ...rest) {
    prepareJournalHarness(file, args, options);
    return spawn.call(this, file, args, ...rest);
  };
  syncBuiltinESMExports();
}
