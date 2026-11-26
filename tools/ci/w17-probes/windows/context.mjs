import { appendObservation, verifyBootstrap, writeEvidence } from "../evidence.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { hash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { initial } from "./verdict.mjs";
import assert from "node:assert/strict";

export const src = import.meta.dirname,
  out = process.env.W17_OUT,
  phase = process.argv[2],
  ctx = {};
if (out) verifyBootstrap(out);
export const rows =
  out && fs.existsSync(path.join(out, "ledger.json"))
    ? JSON.parse(fs.readFileSync(path.join(out, "ledger.json")))
    : initial();
export function safe(e) {
  return String(e?.message ?? e)
    .replace(/(?:ws|http)s?:\/\/[^\s"']+/gi, "[endpoint]")
    .slice(0, 600);
}
export function note(kind, data) {
  appendObservation(
    out,
    JSON.stringify({ at: new Date().toISOString(), phase, kind, data }) + "\n",
  );
}
export function row(key, status, detail = {}) {
  if (rows[key]?.status === "FAIL" && status !== "FAIL") return;
  rows[key] = { status, ...detail };
  save();
  note("row", { key, ...rows[key] });
}
export function save() {
  writeEvidence(out, "ledger.json", JSON.stringify(rows, null, 2) + "\n");
}
export async function measure(k, fn) {
  try {
    const detail = await fn();
    row(k, "PASS", detail);
    return true;
  } catch (e) {
    row(k, "FAIL", { error: safe(e) });
    return false;
  }
}
export function block(keys, why) {
  for (const k of keys) if (rows[k]?.status === "NOT RUN") row(k, "BLOCKED", { prerequisite: why });
}
export function digest(file) {
  return hash("sha256", fs.readFileSync(file));
}
export function timed(read, limit = 10000) {
  return (async () => {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      const r = await read();
      if (r) return r;
      await sleep(75);
    }
    throw Error("Observation deadline");
  })();
}
export function ownedFile(role = "subject") {
  return path.join(ctx.accounts[role].home, "Temp", randomUUID() + ".json");
}
export function waitJSON(file) {
  return timed(() => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  });
}
let child, lines, stopError, brokerClosed;
export function startBroker() {
  child = spawn(
    path.join(path.dirname(process.env.W17_PWSH), "pwsh.exe"),
    ["-NoProfile", "-NonInteractive", "-File", path.join(src, "broker.ps1"), phase],
    { stdio: ["pipe", "pipe", "inherit"], windowsHide: true },
  );
  brokerClosed = new Promise((resolve) => child.once("close", resolve));
  // Listener events can arrive while no RPC is pending. Persist them as soon
  // as the broker emits them, including before a later bracket or phase fails.
  const replies = new PassThrough({ objectMode: true });
  lines = replies[Symbol.asyncIterator]();
  const reader = createInterface({ input: child.stdout });
  reader.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.kind === "listener") note("listener", message.data);
      else if (!stopError) replies.write(message);
    } catch {
      stopError = Error("Private broker message could not be recorded");
      replies.end();
    }
  });
  reader.on("close", () => replies.end());
  const inputFailed = (e) => {
    stopError ??= e;
    replies.end();
  };
  child.on("error", inputFailed);
  child.stdin.on("error", inputFailed);
}
let tail = Promise.resolve();
export function rpc(op, p = {}) {
  const next = tail.then(async () => {
    if (stopError) throw stopError;
    child.stdin.write(JSON.stringify({ op, ...p }) + "\n");
    const { done, value } = await lines.next();
    if (done) throw Error("Controller broker exited during " + op);
    if (!value.ok) throw Error(op + ": " + value.error);
    return value.value;
  });
  tail = next.catch(() => {});
  return next;
}
export async function closeBroker() {
  if (!child) return;
  child.stdin.end();
  const code = await brokerClosed;
  if (stopError) throw stopError;
  assert.equal(code, 0, "private broker exit");
}
export const intent = (kind, data) => rpc("intent", { kind, data });
export async function restore(kind, scope) {
  const results = await rpc("restore", { kind, scope });
  note("restore", { kind, scope, results });
  assert.ok(
    results.every((r) => r.restored),
    "Failed restore " + kind,
  );
  return results;
}
export async function plan(data) {
  const file = path.join(ctx.stage, "plans", randomUUID() + ".json");
  await intent("stage-file", { path: file });
  fs.writeFileSync(file, JSON.stringify(data), { flag: "wx" });
  await rpc("stage-created", { items: [{ path: file }] });
  return file;
}
function quote(a) {
  return (
    '"' +
    String(a)
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/, "$1$1") +
    '"'
  );
}
export async function launch(
  exe,
  args,
  { role = "subject", container = false, capture = false, desktop = ctx.desktop } = {},
) {
  const output = ownedFile(role);
  if (container) {
    // SECURITY_CAPABILITIES are installed by the standard-user parent.
    const commandFile = path.join(ctx.stage, "plans", randomUUID() + ".cmdline");
    await intent("stage-file", { path: commandFile });
    fs.writeFileSync(commandFile, [exe, ...args].map(quote).join(" "), {
      encoding: "utf16le",
      flag: "wx",
    });
    await rpc("stage-created", { items: [{ path: commandFile }] });
    args = [output, "container-launch", ctx.name, exe, commandFile];
    exe = ctx.native;
  }
  note("launch", {
    role,
    exe,
    args: args.filter((a) => !/^--(?:inspect|remote-debugging)/.test(a)),
    desktop: !!desktop,
    container,
  });
  const stderr = capture ? path.join(out, randomUUID() + ".stderr") : null;
  if (stderr) await intent("private-output", { path: stderr });
  const token = await rpc("launch", { role, exe, args, desktop, stderr });
  note("CreateProcessWithLogonW", { exe, token });
  assert.equal(token.sid, ctx.accounts[role].sid);
  assert.equal(token.elevated, 0);
  let appPid = token.pid;
  if (container) {
    const r = await waitJSON(output);
    appPid = r.child;
    assert.equal(r.container, ctx.containerSid);
    assert.ok(appPid > 0);
  }
  return {
    token,
    stderr,
    pid: appPid,
    wait: async (ms = 10000) => {
      const result = await rpc("wait", { pid: token.pid, ms });
      note("process exit", { exe, pid: token.pid, ...result });
      return result;
    },
  };
}
export async function native(args, options = {}) {
  const file = ownedFile(options.role);
  const p = await launch(ctx.native, [file, ...args], options);
  const r = await p.wait();
  assert.equal(r.wait, 0);
  const result = JSON.parse(fs.readFileSync(file));
  note("native result", { action: args[0], ...result, exit: r.exit });
  assert.equal(r.exit, 0, args[0] + " exit " + r.exit);
  return result;
}
// Keep only fields produced by the flow, native and access probes. Inspector
// URLs and staged command lines never enter this pre-validation receipt.
function checkpointActor(task, result, identity) {
  const pick = (v, keys) =>
    Object.fromEntries(
      keys.filter((k) => ["number", "string"].includes(typeof v?.[k])).map((k) => [k, v[k]]),
    );
  const observation = (value) => ({
    ...pick(value, [
      "pid",
      "ppid",
      "exe",
      "code",
      "errno",
      "elapsed",
      "error",
      "exit",
      "targetPid",
      "step",
      "wsa",
      "read",
      "write",
    ]),
    token: pick(value?.token, ["pid", "birth", "sid", "container", "isContainer", "capabilities"]),
    events: Array.isArray(value?.events)
      ? value.events.map((e) => pick(e, ["event", "ms", "code", "errno", "syscall"]))
      : undefined,
  });
  if (task.action === "controllerAccess") {
    for (const [name, target] of Object.entries(task.targets))
      note("staged target result", {
        ...identity,
        name,
        target,
        actor: observation(result),
        memory: observation(result?.memory?.[name]),
      });
  } else if (task.action === "batch" || task.action === "flow") {
    const tasks = task.tasks ?? [task];
    const values = Array.isArray(result) ? result : [result];
    note("staged flow results", {
      ...identity,
      attempts: tasks.map((t, i) => ({
        tuple:
          t.action === "native"
            ? {
                protocol: t.args[1],
                host: t.args[2],
                port: t.args[3],
                localPort: t.args[4],
                nonce: t.args[5],
              }
            : pick(t, ["protocol", "host", "source", "port", "localPort", "nonce"]),
        result: observation(values[i]),
      })),
    });
  }
}
export async function actor(
  task,
  { role = "subject", child = false, container = false, asyncStart = false } = {},
) {
  const output = ownedFile(role);
  const file = await plan({ output, task, child: child ? ctx.child : null });
  const p = await launch(ctx.node, [ctx.client, file], { role, container });
  if (asyncStart) return p;
  let exit, result;
  try {
    exit = await p.wait(30000);
  } finally {
    if (fs.existsSync(output)) {
      result = JSON.parse(fs.readFileSync(output));
      checkpointActor(task, result, {
        role,
        container,
        child,
        requestedPid: p.pid,
        expectedExe: child ? ctx.child : ctx.node,
        exit: exit ?? null,
      });
    }
  }
  assert.deepEqual(exit, { wait: 0, exit: 0 }, "staged Node exit");
  assert.notEqual(result, undefined, "Missing staged Node result");
  for (const r of Array.isArray(result) ? result : [result]) {
    if (r?.pid) {
      assert.equal(child ? r.ppid : r.pid, p.pid, "Unexpected Node ancestry");
      assert.equal(r.exe.toLowerCase(), (child ? ctx.child : ctx.node).toLowerCase());
    }
  }
  return result;
}
export function dirs() {
  ctx.bin = path.join(ctx.stage, "bin");
  ctx.node = path.join(ctx.bin, "node.exe");
  ctx.child = path.join(ctx.bin, "w17-child.exe");
  ctx.client = path.join(ctx.bin, "client.cjs");
  ctx.native = path.join(ctx.bin, "subject.exe");
}
