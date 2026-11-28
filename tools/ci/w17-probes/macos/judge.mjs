import assert from "node:assert/strict";
import { families } from "./verdict.mjs";
export function parentAnchor(rules) {
  // Only a top-level, unconditional filter anchor call covers all four tuples.
  return rules
    .split("\n")
    .map((l) => l.trim())
    .map((l) => /^anchor "([\w./-]+)\/\*" all$/.exec(l)?.[1])
    .find(Boolean);
}
export function packetCount(text, label) {
  const blocks = text.split(/(?=^@\d+ )/m);
  const hits = blocks.filter((rule) => rule.split("\n")[0].includes('label "' + label + '"'));
  if (hits.length !== 1) return null;
  const match = /\bPackets:\s*(\d+)\b/i.exec(hits[0]);
  return match ? Number(match[1]) : null;
}
export function rules(uid, trial, tuples) {
  return (
    [...tuples, ...families.map((family) => ({ family, label: "w17generic" + family }))]
      .map((t) => {
        const { family, host, port, localPort, label } = t;
        const proto = family.slice(0, 3),
          af = family.endsWith("6") ? "inet6" : "inet";
        const action = trial === "return-rst" && proto === "tcp" ? "return-rst" : "drop";
        return `block ${action} out quick ${af} proto ${proto} from any${localPort ? " port = " + localPort : ""} to ${host?.split("%")[0] ?? "any"}${port ? " port = " + port : ""} user = ${uid} label "${label}"`;
      })
      .join("\n") + "\n"
  );
}
export function sameBirth(expected, actual) {
  return (
    !!expected?.birth &&
    expected.birth === actual?.birth &&
    expected.uid === actual.uid &&
    expected.pid === actual.pid
  );
}
export function enforcement(before, after, result, pre, post) {
  return (
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    after > before &&
    result.events.length === 0 &&
    pre.reply &&
    post.reply &&
    !result.result.events.some((e) => e.event === "CONNECTED") &&
    [
      "TIMEOUT",
      "EPERM",
      "EACCES",
      "ECONNREFUSED",
      "ECONNRESET",
      "EHOSTUNREACH",
      "ENETUNREACH",
    ].includes(result.result.code) &&
    result.result.events.some((e) => e.event === result.result.code)
  );
}
export function exact(r) {
  return (
    ["EPERM", "EACCES"].includes(r.code) &&
    Number.isInteger(r.errno) &&
    r.events.some((e) => e.event === r.code) &&
    r.elapsed >= 0 &&
    r.elapsed < 2000 &&
    !r.events.some((e) => ["TIMEOUT", "CONNECTED"].includes(e.event))
  );
}

export function alternative(r) {
  const last = r.events?.at(-1);
  if (
    !Number.isFinite(r.elapsed) ||
    r.elapsed < 0 ||
    last?.event !== r.code ||
    !Number.isFinite(last.ms) ||
    last.ms < 0 ||
    last.ms > r.elapsed ||
    r.events.some((e) => e.event === "CONNECTED")
  )
    return false;
  if (r.code === "TIMEOUT") return r.errno === null;
  return (
    ["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH"].includes(r.code) &&
    Number.isInteger(r.errno) &&
    r.errno !== 0 &&
    !r.events.some((e) => e.event === "TIMEOUT")
  );
}
export function productTree(table, bundle, mainPid, known) {
  const ids = new Set(
    table
      .filter(
        (p) => p.exe.startsWith(bundle + "/") || p.pid === mainPid || known.get(p.pid) === p.birth,
      )
      .map((p) => p.pid),
  );
  let size;
  do {
    size = ids.size;
    for (const p of table) if (ids.has(p.ppid)) ids.add(p.pid);
  } while (size !== ids.size);
  return table.filter((p) => ids.has(p.pid));
}
export function packagedControls(read, write, pid, uid, hash) {
  return (
    read?.pid === pid &&
    write?.pid === pid &&
    read.euid === uid &&
    write.euid === uid &&
    !!hash &&
    read.files?.copy?.hash === hash &&
    write.roundTrip === true
  );
}
export function nativeResult(r, uid, op) {
  const n = r?.native;
  if (
    r?.exit !== 0 ||
    !Number.isInteger(r.pid) ||
    r.pid < 1 ||
    !n ||
    n.uid !== uid ||
    !Number.isInteger(n.pid) ||
    n.pid < 1 ||
    n.ppid !== r.pid ||
    n.pid === r.pid ||
    !Number.isFinite(n.elapsed) ||
    n.elapsed < 0
  )
    return false;
  if (op === "open") return n.open?.result === -1 && [1, 13].includes(n.open.errno);
  if (!(n.socket?.result >= 0 && n.fcntl?.result === 0)) return false;
  // Darwin EPERM, EACCES, ENETUNREACH, ECONNRESET, ETIMEDOUT, ECONNREFUSED, EHOSTUNREACH.
  const terminalErrors = [1, 13, 51, 54, 60, 61, 65];
  if (op === "udp")
    return (
      (n.sendto?.result > 0 && n.sendto.errno === 0) ||
      (n.sendto?.result === -1 && terminalErrors.includes(n.sendto.errno))
    );
  if (op !== "tcp" || n.connect?.result !== -1) return false;
  if (n.connect.errno === 36) {
    if (n.event === "TIMEOUT")
      return n.poll?.result === 0 && n.poll.errno === 0 && n.completedConnectErrno === undefined;
    if (!(n.poll?.result > 0 && n.poll.errno === 0 && n.getsockopt?.result === 0)) return false;
  } else if (n.completedConnectErrno !== n.connect.errno) return false;
  return terminalErrors.includes(n.completedConnectErrno);
}

export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.trimEnd().split("\n")) {
    const m = /^\s*(-?\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(
      line,
    );
    assert.ok(m, "unrecognized process table");
    rows.push({
      uid: Number(m[1]),
      pid: Number(m[2]),
      ppid: Number(m[3]),
      birth: m[4],
      exe: m[5],
    });
  }
  return rows;
}
