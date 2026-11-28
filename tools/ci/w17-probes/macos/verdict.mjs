import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const checkoutScope =
  "copied run-owned trees only; installed-adapter acceptance must establish enforcement on real paths";
export const families = ["tcp4", "udp4", "tcp6", "udp6"];
export const trials = ["drop", "return-rst"];
export const roles = ["subject", "child"];
export const routes = ["ordinary", "asuser", "agent"];
export const fileRows = ["checkout", "worktree", "dependency"].flatMap((label) => [
  label,
  label + "Alias",
]);
export const netRow = (trial, role, family) => `M4.${trial}.${role}.${family}`;
const network = trials.flatMap((trial) => [
  "M4." + trial + ".reverse",
  ...roles.flatMap((role) =>
    families.flatMap((family) => {
      const prefix = netRow(trial, role, family);
      return [
        prefix + ".native",
        prefix + ".enforcement",
        ...(family.startsWith("tcp") ? [prefix + ".errno"] : []),
      ];
    }),
  ),
]);
const productRows = [
  "identity",
  "renderer",
  "sandbox",
  "processes",
  "focus",
  "main.files",
  "utility.files",
  "main.network",
  "utility.network",
  "quit",
];
export const required = [
  "host",
  "M3.realCheckout",
  "M1.identity",
  "M1.forcedTree",
  "M1.removal",
  "M2.controller",
  "M2.gui",
  "M2.focus",
  ...roles.flatMap((role) => fileRows.map((file) => `M3.${role}.${file}`)),
  "M3.positive",
  "M3.restored",
  ...network,
  "M4.restored",
  "M4.hostRoutes",
  "M4.external",
  "M4.resolver",
  "M5.copy",
  ...["control", "restricted"].flatMap((arm) => productRows.map((row) => `M5.${arm}.${row}`)),
  "M5.inspector.subject",
  "M5.inspector.other",
  "M5.controllerIsolation",
  "M5.restored",
  "cleanup",
];
export function initialLedger() {
  return Object.fromEntries(
    [...required, "M2.unattendedLogin", ...routes.map((route) => "M2." + route)].map((key) => [
      key,
      key === "M3.realCheckout"
        ? { status: "NOT RUN", detail: checkoutScope }
        : { status: "NOT RUN" },
    ]),
  );
}
export function requiredFor(rows) {
  return [...required, ...(rows["M4.hostRoutes"]?.detail?.hostKeys ?? [])];
}
export function decide(rows) {
  const missing = requiredFor(rows).filter((key) => rows[key]?.status !== "PASS");
  const equivalent =
    missing.length > 0 &&
    missing.every(
      (key) =>
        key === "M4.hostRoutes" ||
        key.endsWith(".errno") ||
        /^M5\.restricted\.(main|utility)\.network$/.test(key),
    ) &&
    missing.every(
      (key) => rows[key]?.status === "FAIL" && rows[key]?.detail?.differentErrnoOnly === true,
    );
  return { exact: missing.length === 0, equivalent, missing };
}
export function phaseEvidence(observations, rows) {
  if (observations.some((o) => o.kind === "phase error" || o.kind === "ledger refusal"))
    return false;
  const result = decide(rows);
  return ["primitives", "package", "cleanup"].every((phase) => {
    const events = observations.filter(
      (o) => o.data?.phase === phase && ["phase complete", "phase exit"].includes(o.kind),
    );
    if (
      events.length !== 2 ||
      events[0].kind !== "phase complete" ||
      events[1].kind !== "phase exit"
    )
      return false;
    const { exit, incomplete } = events[1].data;
    if (!Array.isArray(incomplete)) return false;
    const missing = result.missing.filter((k) =>
      phase === "cleanup"
        ? ["cleanup", "M1.removal"].includes(k)
        : phase === "package"
          ? k.startsWith("M5.")
          : !k.startsWith("M5.") && !["cleanup", "M1.removal"].includes(k),
    );
    return (
      JSON.stringify(incomplete) === JSON.stringify(missing) &&
      ((exit === 0 && !missing.length) || (exit === 1 && missing.length > 0 && result.equivalent))
    );
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let rows = {},
    evidence = false;
  try {
    const out = process.env.W17_OUT;
    const read = (name) => {
      const file = path.join(out, name),
        stat = fs.lstatSync(file);
      if (!stat.isFile() || !stat.size) throw Error("Missing regular artifact " + name);
      return fs.readFileSync(file, "utf8");
    };
    rows = JSON.parse(read("ledger.json"));
    const observations = read("observations.jsonl")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const recorded = requiredFor(rows).every(
      (k) =>
        rows[k]?.status === "NOT RUN" ||
        observations.some((o) => o.kind === k && o.data.status === rows[k]?.status),
    );
    const complete = phaseEvidence(observations, rows);
    evidence = read("build.exit").trim() === "0" && recorded && complete;
  } catch (error) {
    console.error(error.message);
  }
  // This collector only opens copies. Older or inconsistent ledgers cannot expand its scope.
  const result = decide({ ...rows, "M3.realCheckout": { status: "NOT RUN" } });
  const summary = `Real-checkout isolation: NOT RUN (${checkoutScope}).\nExact feasibility: ${result.exact && evidence ? "PASS" : "FAIL"}. Equivalent-enforcement candidate: ${result.equivalent && evidence ? "owner review" : "unproven"}.\nIncomplete or failed required rows: ${result.missing.join(", ") || "none"}.\n`;
  const counts = trials
    .map((trial) => {
      const enforced = roles.flatMap((role) =>
        families.map((f) => rows[netRow(trial, role, f) + ".enforcement"]),
      );
      const tcp = roles.flatMap((role) =>
        ["tcp4", "tcp6"].map(
          (f) => rows[netRow(trial, role, f) + ".errno"]?.detail?.r?.result?.code ?? "unobserved",
        ),
      );
      return `${trial}: ${enforced.filter((r) => r?.status === "PASS").length}/8 loopback enforcement rows passed; TCP outcomes ${tcp.join(", ")}.`;
    })
    .join("\n");
  process.stdout.write(summary + counts + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + counts + "\n");
  process.exitCode = Number(!(result.exact && evidence));
}
