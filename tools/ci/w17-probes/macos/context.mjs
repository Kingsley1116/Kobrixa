import { appendObservation, phaseLedger, verifyBootstrap } from "../evidence.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { initialLedger } from "./verdict.mjs";

export const root = fs.realpathSync(process.cwd());
export const src = import.meta.dirname;
export const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const out = process.env.W17_OUT;
assert.ok(out && path.isAbsolute(out));
verifyBootstrap(out);
const st = fs.lstatSync(out);
assert.ok(
  st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o777) === 0o700,
  "W17_OUT must be controller-private",
);
assert.ok(!fs.realpathSync(out).startsWith(root + "/"));
const target = (name) => path.join(out, name);
export function save(name, value) {
  verifyBootstrap(out);
  if (name === "ledger.json") return journalLedger.save(value);
  const tmp = target(name + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flush: true });
  fs.renameSync(tmp, target(name));
}
const load = (name, fallback) => {
  verifyBootstrap(out);
  return fs.existsSync(target(name)) ? JSON.parse(fs.readFileSync(target(name))) : fallback;
};
export const journalLedger = phaseLedger(out, process.argv[2], initialLedger(), note);
export const ledger = journalLedger.rows;
export const j = load("resources.json", {});
export const checkpoint = () => save("resources.json", j);
export function intent(operation, resource, undo) {
  verifyBootstrap(out);
  fs.appendFileSync(
    target("journal.jsonl"),
    JSON.stringify({ at: Date.now(), operation, resource, undo }) + "\n",
    { mode: 0o600, flush: true },
  );
}
export function note(kind, data) {
  appendObservation(out, JSON.stringify({ at: new Date().toISOString(), kind, data }) + "\n");
}
export function row(key, status, detail) {
  assert.ok(Object.hasOwn(ledger, key), key);
  if (ledger[key].status === "FAIL" && status !== "FAIL") {
    note("subsequent observation", { key, status, detail });
    return;
  }
  ledger[key] = { status, detail };
  save("ledger.json", ledger);
  if (journalLedger.refused) note("unpublished row", { key, status, detail });
  else note(key, { status, detail });
}
export const measured = (key, ok, detail) => row(key, ok ? "PASS" : "FAIL", detail);
export function blocked(keys, reason) {
  for (const key of keys)
    if (ledger[key]?.status === "NOT RUN" && ledger[key].detail === undefined)
      row(key, "BLOCKED", reason);
}
export function blockPrefix(prefix, reason) {
  blocked(
    Object.keys(ledger).filter((k) => k.startsWith(prefix)),
    reason,
  );
}
export const sanitize = (s) =>
  String(s)
    .replace(/(?:ws|http)s?:\/\/[^\s"']+/g, "[debug endpoint]")
    .slice(-4000);
export function command(file, args = [], options = {}) {
  const {
    privateOutput = false,
    redact = false,
    check = true,
    input,
    timeout = 15000,
    cwd = root,
    outputFd,
  } = options;
  const r = spawnSync(file, args, {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    cwd,
    input,
    timeout,
    ...(outputFd === undefined ? {} : { stdio: ["pipe", outputFd, outputFd] }),
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  const result = {
    code: r.status,
    signal: r.signal,
    error: r.error?.code,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
  note("command", {
    file,
    args: redact ? ["[private operation]"] : args,
    code: r.status,
    signal: r.signal,
    error: r.error?.code,
    ...(privateOutput ? {} : { stdout: sanitize(result.stdout), stderr: sanitize(result.stderr) }),
  });
  if (check && r.status !== 0)
    throw Error(
      `${file} ${redact ? "[private operation]" : args.join(" ")}: ${r.error?.code ?? r.status ?? r.signal} ${privateOutput ? "" : sanitize(result.stderr)}`,
    );
  return result;
}
export const sudo = (args, opts) => command("/usr/bin/sudo", ["-n", ...args], opts);
export const pf = (args, opts) => sudo(["/sbin/pfctl", ...args], opts);
export function envArgs() {
  return [
    "/usr/bin/env",
    "-i",
    "HOME=" + j.home,
    "USER=" + j.name,
    "LOGNAME=" + j.name,
    "TMPDIR=" + j.home + "/tmp",
    "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    "LC_ALL=C",
  ];
}
export function subjectArgs(args, route = "ordinary") {
  const drop = ["/usr/bin/sudo", "-n", "-u", j.name, ...envArgs(), ...args];
  return route === "asuser"
    ? ["/usr/bin/sudo", "-n", "/bin/launchctl", "asuser", String(j.uid), ...drop]
    : drop;
}
export function subject(args, opts = {}) {
  const [file, ...argv] = subjectArgs(args);
  return command(file, argv, { cwd: j.cwd, ...opts });
}
export function start(file, args, options = {}) {
  note("launch", { file, args: options.privateArgs ? "[private endpoints]" : args, cwd: j.cwd });
  return spawn(file, args, {
    cwd: j.cwd,
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" },
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}
export function init() {
  assert.equal(Object.keys(j).length, 0, "refusing to replace an existing resource journal");
  const entries = fs.readdirSync(out);
  if (entries.length || process.env.GITHUB_ACTIONS === "true") {
    assert.deepEqual(entries, ["observations.jsonl"]);
    const stat = fs.lstatSync(target(entries[0]));
    assert.ok(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.uid === process.getuid() &&
        (stat.mode & 0o077) === 0,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(target(entries[0]), "utf8")), {
      kind: "bootstrap",
      platform: "macos",
      sha: process.env.GITHUB_SHA,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
    });
  }
  const id = randomBytes(8).toString("hex");
  Object.assign(j, {
    id,
    name: "w17" + id.slice(0, 12),
    stage: "/private/tmp/kobrixa-w17-" + id,
    acl: {},
    agents: [],
  });
  j.home = j.stage + "/home";
  j.cwd = j.stage + "/cwd";
  j.node = j.stage + "/client";
  j.child = j.stage + "/w17-child";
  assert.ok(!fs.existsSync(j.stage));
  checkpoint();
  save("ledger.json", ledger);
  intent("create stage and empty cwd", j.stage, "remove verified stage");
  fs.mkdirSync(j.stage, { mode: 0o700 });
  const { dev, ino } = fs.lstatSync(j.stage);
  j.stageIdentity = { dev, ino };
  checkpoint();
  fs.mkdirSync(j.cwd);
  fs.chmodSync(j.stage, 0o755);
  fs.chmodSync(j.cwd, 0o755);
}
