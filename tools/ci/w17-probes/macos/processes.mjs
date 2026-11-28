import { sameBirth, parseProcessTable } from "./judge.mjs";
import { once } from "node:events";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  j,
  command,
  note,
  sudo,
  subject,
  subjectArgs,
  start,
  intent,
  measured,
} from "./context.mjs";
import { ownedUser } from "./account.mjs";

export function processTable() {
  const ps = command("/bin/ps", ["-axo", "uid=,pid=,ppid=,lstart=,comm="], { privateOutput: true });
  return parseProcessTable(ps.stdout);
}
export function processes() {
  const rows = processTable().filter((p) => p.uid === j.uid);
  note("subject process sample", rows);
  return rows;
}
export function identity(pid) {
  return JSON.parse(sudo([j.processTool, "identity", String(pid)]).stdout);
}
export function signalOwned(expected, signal) {
  assert.ok(ownedUser());
  const live = identity(expected.pid);
  assert.ok(expected.uid === j.uid && sameBirth(expected, live), "refusing birth/UID mismatch");
  subject(["/bin/kill", "-" + signal, String(live.pid)]);
}
export async function stopOwned(onlyApp = false) {
  // GUI sessions can have unrelated system-managed agents. In the product arm
  // stop only processes in the staged bundle; final cleanup owns this whole UID.
  const list = () =>
    processes().filter(
      (r) =>
        !onlyApp ||
        r.exe.startsWith(j.stage + "/package/") ||
        j.productBirths?.[r.pid]?.psBirth === r.birth,
    );
  for (const signal of ["TERM", "KILL"]) {
    const targets = list();
    if (!targets.length) return;
    for (const p of targets) {
      try {
        const recorded = j.productBirths?.[p.pid];
        signalOwned(recorded?.psBirth === p.birth ? recorded : identity(p.pid), signal);
      } catch (e) {
        if (list().some((r) => r.pid === p.pid)) throw e;
      }
    }
    await delay(600);
  }
  assert.equal(list().length, 0, "subject processes survived teardown");
}

// Use a deliberately wrong birth first, then exercise the same checked signal
// path on this disposable tree. A refusal alone cannot establish teardown.
export async function forcedTree() {
  const file = j.stage + "/client.cjs";
  const [exe, ...argv] = subjectArgs([
    j.node,
    file,
    JSON.stringify({ action: "tree", childExe: j.child }),
  ]);
  intent("launch disposable parent and child", j.uid, "stop verified probe UID processes");
  const proc = start(exe, argv);
  const exit = once(proc, "close");
  let parent, child;
  try {
    const [line] = await Promise.race([
      once(proc.stdout, "data"),
      delay(6000).then(() => {
        throw Error("tree startup deadline");
      }),
    ]);
    const ids = JSON.parse(line);
    parent = identity(ids.pid);
    child = identity(ids.childPid);
    assert.equal(child.ppid, parent.pid);
    assert.equal(parent.uid, j.uid);
    assert.equal(child.uid, j.uid);
    let refused = false;
    try {
      signalOwned({ ...child, birth: child.birth + "-mismatch" }, "TERM");
    } catch (e) {
      if (!e.message.includes("refusing birth/UID mismatch")) throw e;
      refused = true;
    }
    assert.ok(refused && sameBirth(child, identity(child.pid)));
    signalOwned(child, "TERM");
    signalOwned(parent, "TERM");
    await Promise.race([
      exit,
      delay(5000).then(() => {
        throw Error("forced exit deadline");
      }),
    ]);
    const after = processes();
    assert.ok(!after.some((p) => p.pid === parent.pid || p.pid === child.pid));
    measured("M1.forcedTree", true, { parent, child, refused, after });
  } finally {
    for (const p of [child, parent].filter(Boolean)) {
      if (processes().some((r) => r.pid === p.pid)) signalOwned(p, "KILL");
    }
  }
}
