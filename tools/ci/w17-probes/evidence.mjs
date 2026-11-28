// The bootstrap and collector run before checkout is guaranteed. Keep their
// dev/inode/birth tuple in sync with this producer-side check.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { recoverUtilities } from "./diagnostics.mjs";

const identity = (st) => `${st.dev}/${st.ino}/${st.birthtimeNs}`;
export function verifyBootstrap(dir) {
  if (process.env.W17_HOSTED !== "1") return;
  const st = fs.lstatSync(dir, { bigint: true });
  if (!st.isDirectory() || !st.ino || identity(st) !== process.env.W17_ROOT_ID)
    throw Error("Controller directory differs from bootstrap");
}

export function appendObservation(dir, line) {
  if (process.env.W17_HOSTED !== "1") {
    fs.appendFileSync(path.join(dir, "observations.jsonl"), line, { mode: 0o600 });
    return;
  }
  verifyBootstrap(dir);
  const file = path.join(dir, "observations.jsonl");
  const st = fs.lstatSync(file, { bigint: true });
  if (!st.isFile() || st.nlink !== 1n || identity(st) !== process.env.W17_OBS_ID)
    throw Error("Observations differ from bootstrap");
  const fd = fs.openSync(
    file,
    fs.constants.O_APPEND | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || identity(opened) !== process.env.W17_OBS_ID)
      throw Error("Unverified observations file");
    fs.writeFileSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

// Bind each in-memory ledger to the revision actually read by this process.
const revisions = new Map();
export function readLedger(dir, initial) {
  verifyBootstrap(dir);
  const file = path.join(dir, "ledger.json");
  // GitHub imports the command file at the end of a step. Sibling processes
  // within this step must also see revisions already published to that file.
  let expected = process.env.W17_LEDGER_ID;
  if (process.env.W17_HOSTED === "1") {
    const commands = fs.readFileSync(process.env.GITHUB_ENV, "utf8");
    for (const line of commands.split(/\r?\n/))
      if (line.startsWith("W17_LEDGER_ID=")) expected = line.slice("W17_LEDGER_ID=".length);
  }
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (process.env.W17_HOSTED === "1" && expected) throw Error("Published ledger is missing");
    revisions.set(file, undefined);
    return initial;
  }
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (
      !st.isFile() ||
      st.nlink !== 1n ||
      !st.ino ||
      identity(fs.lstatSync(file, { bigint: true })) !== identity(st)
    )
      throw Error("Unverified ledger revision");
    if (process.env.W17_HOSTED === "1" && expected !== identity(st))
      throw Error("Ledger identity differs from published revision");
    const rows = JSON.parse(fs.readFileSync(fd));
    revisions.set(file, identity(st));
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

// A cleanup ledger is evidence, not the resource journal used for restoration.
// After the first refusal leave the disputed revision and its lock untouched.
export function phaseLedger(dir, phase, initial, note) {
  let refusal;
  function attempt(operation, fn) {
    if (refusal) return;
    try {
      return fn();
    } catch (error) {
      if (phase !== "cleanup") throw error;
      refusal = { phase, operation, error: error.message };
      note("ledger refusal", refusal);
    }
  }
  const rows = dir ? attempt("read", () => readLedger(dir, initial)) : initial;
  return {
    rows: refusal ? initial : rows,
    get refused() {
      return Boolean(refusal);
    },
    save(value) {
      attempt("write", () =>
        writeEvidence(dir, "ledger.json", JSON.stringify(value, null, 2) + "\n"),
      );
    },
  };
}

export function writeEvidence(dir, name, bytes) {
  verifyBootstrap(dir);
  const dest = path.join(dir, name);
  const lock = dest + ".lock";
  // A killed writer leaves a visible refusal. Never steal another writer's lock.
  fs.mkdirSync(lock, { mode: 0o700 });
  const tmp = path.join(lock, randomUUID() + ".tmp");
  try {
    if (name === "ledger.json") {
      const current = fs.lstatSync(dest, { bigint: true, throwIfNoEntry: false });
      if ((current && identity(current)) !== revisions.get(dest))
        throw Error("Ledger revision changed since read");
    }
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.renameSync(tmp, dest);
      const installed = fs.lstatSync(dest, { bigint: true });
      const id = identity(installed);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (
        !installed.isFile() ||
        installed.nlink !== 1n ||
        !installed.ino ||
        installed.dev !== opened.dev ||
        installed.ino !== opened.ino
      )
        throw Error("Installed evidence identity mismatch");
      revisions.set(dest, id);
      if (process.env.W17_HOSTED === "1") {
        const key = name === "ledger.json" ? "W17_LEDGER_ID" : "W17_BUILD_ID";
        fs.appendFileSync(process.env.GITHUB_ENV, `${key}=${id}\n`);
      }
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmdirSync(lock);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.W17_OUT;
  verifyBootstrap(dir);
  if (process.argv[2] === "build-exit") {
    const code = process.argv[3];
    if (!/^\d+$/.test(code)) throw Error("Missing build exit");
    writeEvidence(dir, "build.exit", code + "\n");
  } else if (process.argv[2] === "recover") {
    recoverUtilities(dir, (kind, data) =>
      appendObservation(
        dir,
        JSON.stringify({ at: new Date().toISOString(), phase: "cleanup", kind, data }) + "\n",
      ),
    );
  }
}
