import { appendObservation, phaseLedger, verifyBootstrap } from "../evidence.mjs";
// Dependency-free so a compiler or workspace setup error still leaves a ledger.
import fs from "node:fs";
import path from "node:path";
import { initial } from "./verdict.mjs";
const [phase, kind, ...args] = process.argv.slice(2);
const dir = process.env.W17_OUT,
  ledger = path.join(dir, "ledger.json");
verifyBootstrap(dir);
const write = (kind, data) =>
  appendObservation(
    dir,
    JSON.stringify({ at: new Date().toISOString(), kind, phase, data }) + "\n",
  );
if (!fs.existsSync(ledger) && kind !== "failure") {
  const state = phaseLedger(dir, phase, initial(), write);
  state.save(state.rows);
}
if (kind === "preflight") {
  write("preflight", { arch: args[0], elevated: args[1], bfe: args[2] });
} else if (kind === "guard-build") {
  // Preserve a failed primitive restoration as a build prerequisite.
  const manifest = path.join(dir, "resources.json");
  const entries = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest)).entries : [];
  const pending = entries.filter(
    (e) => !e.done && (e.kind === "tree-acl" || (e.kind === "acl" && e.data.scope === "baseline")),
  );
  write("build restoration prerequisite", { pending: pending.map((e) => e.kind) });
  if (pending.length) {
    console.error("Primitive sentinel DACL restoration is incomplete");
    process.exitCode = 1;
  }
} else if (kind === "command") {
  const [code, ...argv] = args;
  write("command", { argv, exit: Number(code) });
} else if (kind === "failure") {
  const state = phaseLedger(dir, phase, initial(), write);
  const rows = state.rows;
  rows["phase." + phase] = { ...rows["phase." + phase], status: "FAIL", exit: Number(args[0]) };
  const key = "phase." + phase;
  state.save(rows);
  write(state.refused ? "unpublished row" : "row", { key, ...rows[key] });
  write("phase exit", { phase, exit: Number(args[0]) });
} else
  write("phase entry", {
    phase,
    sha: process.env.GITHUB_SHA,
    image: process.env.ImageVersion,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
  });
