import { parentAnchor, packetCount, rules } from "./judge.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pf, j, note, checkpoint } from "./context.mjs";
import { families } from "./verdict.mjs";

function state() {
  const result = pf(["-s", "info"]).stdout.match(/^Status:\s+(Enabled|Disabled)\b/m);
  assert.ok(result, "unknown live PF status");
  return result[1];
}
export function inspectPF() {
  j.pfBefore = state();
  const rules = pf(["-sr"]).stdout;
  const parent = parentAnchor(rules);
  pf(["-s", "Anchors"]);
  const interfaces = pf(["-v", "-s", "Interfaces"]);
  const line = interfaces.stdout.split("\n").find((s) => /^\s*lo0(?:\s|$)/.test(s));
  j.loopbackFiltered = line ? !/\bskip\b/i.test(line) : null;
  note("loopback classification opportunity", { line: line ?? null, filtered: j.loopbackFiltered });
  pf(["-ss"], { privateOutput: true }); // Scope retained state samples to probe ports below.
  assert.ok(parent, "no unconditional live wildcard filter anchor");
  const anchor = parent + "/w17-" + j.id;
  const siblings = pf(["-a", parent, "-s", "Anchors"]).stdout.trim().split(/\s+/);
  assert.ok(
    !siblings.some((a) => a === anchor || a === anchor.split("/").at(-1)),
    "anchor name already exists",
  );
  assert.equal(pf(["-a", anchor, "-sr"]).stdout.trim(), "", "anchor already populated");
  j.rootRules = rules;
  j.anchor = anchor;
  note("PF initial", { state: j.pfBefore, rules, parent, anchor: j.anchor });
  checkpoint();
}
export function enable() {
  if (state() === "Enabled") return;
  fs.rmSync(process.env.W17_OUT + "/enable.response", { force: true });
  j.enablePending = true;
  checkpoint();
  // Save the response privately before parsing it, including on interrupted runs.
  const fd = fs.openSync(process.env.W17_OUT + "/enable.response", "w", 0o600);
  let r;
  try {
    r = pf(["-E"], { privateOutput: true, check: false, outputFd: fd });
  } finally {
    fs.closeSync(fd);
  }
  const token = readToken();
  if (token) {
    j.pfToken = token;
    j.enablePending = false;
    checkpoint();
  }
  assert.ok(r.code === 0 && token, "owned PF enable reference unverified");
}
export function install(trial, tuples) {
  assert.ok(j.anchor && !j.pfDirty);
  assert.equal(pf(["-sr"]).stdout, j.rootRules, "live root anchor order changed");
  assert.equal(pf(["-a", j.anchor, "-sr"]).stdout.trim(), "", "candidate anchor no longer empty");
  const input = rules(j.uid, trial, tuples);
  note("PF candidate", { trial, input });
  pf(["-a", j.anchor, "-n", "-f", "-"], { input });
  enable();
  j.pfDirty = true;
  checkpoint();
  pf(["-a", j.anchor, "-f", "-"], { input });
  const active = pf(["-a", j.anchor, "-sr"]).stdout;
  assert.ok(families.every((f) => active.includes("w17generic" + f)));
  note("PF traversal", { root: pf(["-sr"]).stdout, anchor: j.anchor, active });
}
export function counters(t) {
  const rules = pf(["-a", j.anchor, "-vvsr"], { privateOutput: true }).stdout;
  const states = pf(["-ss"], { privateOutput: true })
    .stdout.split("\n")
    .filter((l) => l.includes(":" + t.port + " ") || l.includes(":" + t.localPort + " "));
  note("PF sample", { label: t.label, rules, states });
  return packetCount(rules, t.label);
}
function readToken() {
  const file = process.env.W17_OUT + "/enable.response";
  if (fs.existsSync(file)) return /\bToken\s*:\s*(\d+)/i.exec(fs.readFileSync(file, "utf8"))?.[1];
}
export function removePF() {
  if (j.enablePending && !j.pfToken) {
    const token = readToken();
    if (token) {
      j.pfToken = token;
      j.enablePending = false;
      checkpoint();
    }
  }
  if (j.pfDirty) {
    pf(["-a", j.anchor, "-F", "rules"]);
    assert.equal(pf(["-a", j.anchor, "-sr"]).stdout.trim(), "");
    j.pfDirty = false;
    checkpoint();
  }
  if (j.pfToken) {
    // A previous cleanup may have released the reference just before interruption.
    const references = () => pf(["-s", "References"], { privateOutput: true }).stdout;
    const token = new RegExp("\\b" + j.pfToken + "\\b");
    if (!j.releasePending || token.test(references())) {
      j.releasePending = true;
      checkpoint();
      pf(["-X", j.pfToken], { redact: true, privateOutput: true });
    }
    assert.ok(!token.test(references()), "run-owned PF reference survived");
    j.releasePending = false;
    delete j.pfToken;
    checkpoint();
    fs.rmSync(process.env.W17_OUT + "/enable.response", { force: true });
  }
  assert.ok(!j.enablePending, "interrupted PF enable without recoverable reference");
  if (j.anchor) {
    const [parent, child] = [
      j.anchor.slice(0, j.anchor.lastIndexOf("/")),
      j.anchor.split("/").at(-1),
    ];
    const anchors = pf(["-a", parent, "-s", "Anchors"]).stdout.trim().split(/\s+/);
    assert.ok(!anchors.includes(j.anchor) && !anchors.includes(child), "owned anchor survived");
  }
  if (j.pfBefore) assert.equal(state(), j.pfBefore);
  if (j.rootRules !== undefined)
    assert.equal(pf(["-sr"]).stdout, j.rootRules, "root rules changed");
}
export function manuals() {
  for (const file of [
    "/usr/share/man/man5/pf.conf.5",
    "/usr/share/man/man8/pfctl.8",
    "/usr/share/man/man1/launchctl.1",
  ]) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const excerpts = lines
      .flatMap((l, i) =>
        /skip on|return-rst|effective user|Fl [EX] |asuser|GUI login/i.test(l)
          ? [{ line: i + 1, text: lines.slice(i, i + 4).join("\n") }]
          : [],
      )
      .slice(0, 45);
    note("shipped manual", { file, excerpts });
  }
}
