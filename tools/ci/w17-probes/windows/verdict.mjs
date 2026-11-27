import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
export const checkoutScope =
  "copied run-owned trees only; installed-adapter acceptance must establish enforcement on real paths";
export const endpoints = ["loop4", "loop6", "routed4"].flatMap((location) =>
  ["tcp", "udp"].map((proto) => location + "." + proto),
);
export const arms = ["wfp", "container"];
const prod = [
  "identity",
  "renderer",
  "sandbox",
  "focus",
  "journal",
  "negative",
  "processes",
  "quit",
  "main.files",
  "utility.files",
];
export const base = [
  "host",
  "W2.realCheckout",
  "W1.identity",
  "W1.logonRights",
  "W1.window",
  "W1.profile",
  "W2.baseline",
  "W2.denied",
  "W2.restored",
  "W3.baseline",
  "W3.firewall",
  "W3.firewallRemoved",
  "W3.restored",
  "W5.copy",
  "W6.forced",
  "cleanup",
  "phase.primitives",
  "phase.package",
  "phase.cleanup",
];
export function required(arm) {
  return [
    ...base,
    arm + ".policy",
    arm + ".files",
    arm + ".reverse",
    arm + ".restored",
    arm + ".external",
    arm + ".dns",
    ...["subject", "child"].flatMap((who) =>
      endpoints.flatMap((e) => [
        arm + "." + who + "." + e + ".block",
        ...(e.endsWith("tcp") ? [arm + "." + who + "." + e + ".errno"] : []),
      ]),
    ),
    ...["startup", arm].flatMap((mode) => prod.map((name) => "W5." + mode + "." + name)),
    ...["main", "utility"].flatMap((who) =>
      endpoints.flatMap((e) => [
        "W5." + arm + "." + who + "." + e + ".block",
        ...(e.endsWith("tcp") ? ["W5." + arm + "." + who + "." + e + ".errno"] : []),
      ]),
    ),
    ...["subject", "other"].flatMap((who) => [
      "W6." + arm + "." + who,
      "W6." + arm + "." + who + ".resources",
    ]),
    "W5." + arm + ".restored",
  ];
}
export function initial() {
  return Object.fromEntries(
    [...new Set([...arms.flatMap(required), "W3.firewall"])].map((k) => [
      k,
      k === "W2.realCheckout"
        ? { status: "NOT RUN", reason: checkoutScope }
        : { status: "NOT RUN" },
    ]),
  );
}
export function exact(r) {
  return (
    ["EPERM", "EACCES"].includes(r?.code) &&
    Number.isFinite(r.elapsed) &&
    r.elapsed >= 0 &&
    r.elapsed < 2000 &&
    Array.isArray(r.events) &&
    r.events.some((v) => v.event === "error" && v.code === r.code) &&
    r.events.at(-1)?.event === r.code &&
    Number.isFinite(r.events.at(-1).ms) &&
    r.events.at(-1).ms >= 0 &&
    r.events.at(-1).ms < 2000 &&
    !r.events.some((v) => ["CONNECTED", "TIMEOUT"].includes(v.event))
  );
}
export function alternative(r) {
  if (
    !Number.isFinite(r?.elapsed) ||
    !Array.isArray(r.events) ||
    r.events.at(-1)?.event !== r.code ||
    r.events.some((v) => v.event === "CONNECTED")
  )
    return false;
  if (r.code === "TIMEOUT") return true;
  return (
    /^E[A-Z0-9]+$/.test(r.code) &&
    !["EPERM", "EACCES"].includes(r.code) &&
    r.events.some((v) => v.event === "error" && v.code === r.code)
  );
}
export function join(events, t, pid, filter, from, to) {
  if (
    !Array.isArray(events) ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !/^[1-9]\d*$/.test(filter ?? "")
  )
    return [];
  return events.filter(
    (v) =>
      Number(v.ProcessID) === pid &&
      v.FilterRTID === filter &&
      v.Direction === "%%14593" &&
      Number(v.SourcePort) === t.localPort &&
      v.SourceAddress === t.source &&
      v.DestAddress === t.host &&
      Number(v.DestPort) === t.port &&
      Number(v.Protocol) === (t.protocol === "tcp" ? 6 : 17) &&
      Date.parse(v.at) >= from &&
      Date.parse(v.at) <= to,
  );
}
export function recorded(rows, observations) {
  if (!observations.length || observations.some((o) => o.kind === "ledger refusal")) return false;
  return (
    Object.entries(rows).every(
      ([key, r]) =>
        r?.status === "NOT RUN" ||
        observations.some(
          (o) => o.kind === "row" && o.data?.key === key && o.data.status === r?.status,
        ),
    ) &&
    ["primitives", "package", "cleanup"].every((phase) => {
      const exits = observations.filter((o) => o.kind === "phase exit" && o.data?.phase === phase);
      return exits.length > 0 && exits.every((o) => o.data.exit === 0);
    })
  );
}
export function decide(rows) {
  function assess(arm) {
    const keys = required(arm);
    if (["PASS", "FAIL"].includes(rows["interface.routed6"]?.status)) {
      for (const k of keys.filter((k) => k.includes(".routed4.")))
        keys.push(k.replace(".routed4.", ".routed6."));
    }
    const missing = keys.filter((k) => rows[k]?.status !== "PASS");
    return {
      arm,
      missing,
      exact: missing.length === 0,
      equivalent:
        missing.length > 0 &&
        missing.every(
          (k) =>
            k.endsWith(".errno") &&
            rows[k]?.status === "FAIL" &&
            rows[k].differentErrnoOnly === true,
        ),
    };
  }
  const candidates = arms.map(assess);
  return {
    exact: candidates.some((c) => c.exact),
    equivalent: candidates.some((c) => c.equivalent),
    candidates,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.env.W17_OUT;
  let rows = {},
    artifacts = false;
  try {
    for (const f of ["ledger.json", "build.exit", "observations.jsonl"]) {
      const s = fs.lstatSync(path.join(out, f));
      if (!s.isFile() || s.size === 0) throw Error("Missing regular artifact " + f);
    }
    artifacts = fs.readFileSync(path.join(out, "build.exit"), "utf8").trim() === "0";
    rows = JSON.parse(fs.readFileSync(path.join(out, "ledger.json"), "utf8"));
    const observations = fs
      .readFileSync(path.join(out, "observations.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((s) => JSON.parse(s));
    artifacts = artifacts && recorded(rows, observations);
  } catch (e) {
    artifacts = false;
    console.error(e.message);
  }
  // This collector only opens copies. Older or inconsistent ledgers cannot expand its scope.
  const result = decide({ ...rows, "W2.realCheckout": { status: "NOT RUN" } });
  const summary = JSON.stringify(
    {
      realCheckout: { status: "NOT RUN", reason: checkoutScope },
      artifacts,
      exactFeasibility: artifacts && result.exact,
      equivalentEnforcementCandidate: artifacts && result.equivalent,
      candidates: result.candidates,
    },
    null,
    2,
  );
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "### Windows W17\n\n```json\n" + summary + "\n```\n",
    );
  if (!artifacts || !result.exact) process.exitCode = 1;
}

export function restoredTransactions(installed, receipts) {
  return (
    Array.isArray(receipts) &&
    Array.isArray(installed) &&
    installed.length > 0 &&
    installed.every(
      (id) => typeof id === "string" && receipts.some((r) => r.id === id && r.restored === true),
    )
  );
}
export function comparator({
  pre,
  post,
  valid,
  node,
  native,
  nodeReply,
  nativeReply,
  nodeEvents,
  nativeEvents,
  protocol,
}) {
  if (
    !pre ||
    !post ||
    !valid ||
    !Number.isFinite(node?.elapsed) ||
    !Number.isFinite(native?.elapsed) ||
    !Number.isInteger(native?.wsa) ||
    native.exit !== 0
  )
    return null;
  const terminal = node.events?.at(-1);
  if (!terminal || terminal.event !== node.code) return null;
  const nodeOutcome =
    node.code === "REPLY" && nodeReply
      ? "delivered"
      : !nodeEvents &&
          !node.events.some((e) => e.event === "CONNECTED") &&
          (node.code === "TIMEOUT" ||
            ([
              "EPERM",
              "EACCES",
              "ECONNREFUSED",
              "ECONNRESET",
              "ENETUNREACH",
              "EHOSTUNREACH",
            ].includes(node.code) &&
              Number.isInteger(node.errno)))
        ? "observed non-delivery"
        : null;
  const nativeOutcome =
    native.step === "reply" && native.wsa === 0 && nativeReply
      ? "delivered"
      : !nativeEvents &&
          [10013, 10051, 10054, 10060, 10061, 10065].includes(native.wsa) &&
          (protocol === "tcp"
            ? native.step === "connect"
            : ["connect", "send", "reply"].includes(native.step))
        ? "observed non-delivery"
        : native.wsa !== 0
          ? "not-a-policy-result"
          : null;
  return nodeOutcome && nativeOutcome ? { node: nodeOutcome, native: nativeOutcome } : null;
}

export function sameFolder(a, b) {
  return (
    typeof a === "string" &&
    !!a &&
    typeof b === "string" &&
    !!b &&
    path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase()
  );
}
export function containerAbsent(r) {
  return (
    r.knownFolderResult === 0 &&
    path.win32.isAbsolute(r.expectedFolder || "") &&
    [2, 3].includes(r.expectedFolderError) &&
    (!r.folder || (sameFolder(r.folder, r.expectedFolder) && [2, 3].includes(r.folderError))) &&
    [2, 3].includes(r.mapping) &&
    ([0x80070057, 0x80070002, 0x80070003, 0x80070490].includes(r.query) ||
      (r.query === 0 && !!r.folder && [2, 3].includes(r.folderError)))
  );
}
