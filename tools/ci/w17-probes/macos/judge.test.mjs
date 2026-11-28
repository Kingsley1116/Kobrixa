import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { parentAnchor, packetCount, rules, sameBirth, enforcement, exact } from "./judge.mjs";
import { initialLedger, required, decide } from "./verdict.mjs";

test("only unconditional live filter wildcard calls are eligible", () => {
  assert.equal(parentAnchor('nat-anchor "com.apple/*" all\nanchor "unused" all'), undefined);
  assert.equal(parentAnchor('anchor "only/*" on en0 all'), undefined);
  assert.equal(parentAnchor('anchor "com.apple/*" all'), "com.apple");
});
test("only an unambiguous packet counter for the attempted tuple is usable", () => {
  const a =
    '@0 block drop out quick label "probe"\n  [ Evaluations: 9 Packets: 0 Bytes: 0 States: 0 ]\n';
  const b =
    '@1 block drop out quick label "probe2"\n  [ Evaluations: 9 Packets: 13 Bytes: 130 States: 0 ]\n';
  assert.equal(packetCount(a + b, "probe"), 0);
  assert.equal(packetCount(a + b, "probe2"), 13);
  assert.equal(packetCount(a + a, "probe"), null);
  assert.equal(packetCount(b, "probe"), null);
  assert.equal(packetCount(a.replace("Packets: 0", "Packets: ?") + b, "probe"), null);
});
test("attribution rules precede UID-wide blocks for every family and protocol", () => {
  for (const trial of ["drop", "return-rst"]) {
    const result = rules(51001, trial, [
      { family: "tcp4", localPort: 41000, host: "127.0.0.1", port: 43210, label: "w17probe" },
    ])
      .trimEnd()
      .split("\n");
    assert.equal(result.length, 5);
    assert.match(result[0], /from any port = 41000 to 127\.0\.0\.1 port = 43210 user = 51001/);
    for (const [i, f] of ["tcp4", "udp4", "tcp6", "udp6"].entries()) {
      const tcp = f.startsWith("tcp");
      assert.equal(
        result[i + 1],
        `block ${tcp && trial === "return-rst" ? "return-rst" : "drop"} out quick ${f.endsWith("6") ? "inet6" : "inet"} proto ${f.slice(0, 3)} from any to any user = 51001 label "w17generic${f}"`,
      );
    }
  }
});
test("timeout and refusal are distinct from exact Node errno even with a classified drop", () => {
  const sample = (code, errno) => ({ code, errno, elapsed: 71, events: [{ event: code }] });
  const ok = { reply: true };
  for (const code of ["TIMEOUT", "ECONNREFUSED", "ECONNRESET"]) {
    const raw = sample(code, code === "TIMEOUT" ? null : -61);
    assert.equal(exact(raw), false);
    assert.equal(enforcement(3, 4, { events: [], result: raw }, ok, ok), true);
  }
  for (const code of ["EPERM", "EACCES"]) {
    const raw = sample(code, -1);
    assert.equal(exact(raw), true);
    assert.equal(exact({ ...raw, elapsed: 2001 }), false);
    assert.equal(exact({ ...raw, events: [{ event: "CONNECTED" }] }), false);
    assert.equal(exact({ ...raw, errno: null }), false);
  }
});
test("missing telemetry, a delivered flow or a failed bracket cannot establish denial", () => {
  const sample = { events: [], result: { code: "TIMEOUT", events: [{ event: "TIMEOUT" }] } },
    ok = { reply: true };
  for (const [before, after] of [
    [0, 0],
    [1, 0],
    [null, 2],
    [0, null],
  ])
    assert.equal(enforcement(before, after, sample, ok, ok), false);
  assert.equal(enforcement(0, 1, { ...sample, events: [{ type: "accept" }] }, ok, ok), false);
  assert.equal(
    enforcement(
      0,
      1,
      { ...sample, result: { code: "TIMEOUT", events: [{ event: "CONNECTED" }] } },
      ok,
      ok,
    ),
    false,
  );
  assert.equal(enforcement(0, 1, sample, { reply: false }, ok), false);
  assert.equal(enforcement(0, 1, sample, ok, { reply: false }), false);
});
test("checked signal requires UID, PID and matching nonempty birth", () => {
  const expected = { uid: 501, pid: 1456, birth: "11.000234" };
  assert.equal(sameBirth(expected, expected), true);
  for (const patch of [{ pid: 2 }, { uid: 0 }, { birth: "11.000235" }, { birth: null }])
    assert.equal(sameBirth(expected, { ...expected, ...patch }), false);
  assert.equal(sameBirth({}, {}), false);
});
test("missing and blocked rows fail exact; equivalence needs measured different errno alone", () => {
  const rows = initialLedger();
  assert.ok(required.every((k) => rows[k].status === "NOT RUN"));
  assert.equal(decide(rows).exact, false);
  for (const k of required) rows[k] = { status: "PASS" };
  assert.equal(decide(rows).exact, true);
  rows["M4.drop.subject.tcp4.errno"] = { status: "FAIL", detail: { differentErrnoOnly: true } };
  assert.equal(decide(rows).exact, false);
  assert.equal(decide(rows).equivalent, true);
  rows["M4.external"] = { status: "BLOCKED", detail: "no receiver" };
  assert.equal(decide(rows).equivalent, false);
  delete rows["cleanup"];
  assert.ok(decide(rows).missing.includes("cleanup"));
});
test("staged child really opens an existing file and reports missing file literally", () => {
  const path = import.meta.dirname + "/client.cjs";
  const r = spawnSync(
    process.execPath,
    [
      path,
      JSON.stringify({
        action: "files",
        child: process.execPath,
        paths: { file: path, absent: path + ".absent" },
      }),
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.ppid, data.parent.pid);
  assert.match(data.files.file.hash, /^[a-f0-9]{64}$/);
  assert.equal(data.files.absent.code, "ENOENT");
  assert.deepEqual(
    data.files,
    createRequire(import.meta.url)("./client.cjs").files({ file: path, absent: path + ".absent" }),
  );
});
test("push filters, budgets, action inputs and upload allowlist", () => {
  const wf = parse(
    fs.readFileSync(
      new URL("../../../../.github/workflows/w17-hosted-probes.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(wf.on, {
    push: {
      branches: ["test/w17-hosted-probes"],
    },
  });
  assert.deepEqual(wf.permissions, { contents: "read" });
  // A later writer may add the planned independent Windows job.
  const job = wf.jobs.macos,
    steps = job.steps;
  assert.equal(job["runs-on"], "macos-26");
  assert.equal(job["timeout-minutes"], 45);
  assert.equal(
    steps.find((s) => s.uses?.startsWith("actions/checkout")).with["persist-credentials"],
    false,
  );
  assert.ok(steps.some((s) => s.uses === "./.github/actions/setup"));
  const artifact = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.equal(artifact.if, "always() && steps.outcomes.outputs.files != ''");
  assert.equal(artifact.with["retention-days"], 14);
  assert.equal(
    artifact.with.name,
    "w17-probe-macos-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.equal(artifact.with.path, "${{ steps.outcomes.outputs.files }}");
  const collect = steps.find((s) => s.id === "outcomes");
  assert.deepEqual(
    JSON.parse(collect.run.match(/const names\s*=\s*owned\s*\?\s*(\[[^\]]+\])/)[1]),
    ["ledger.json", "observations.jsonl", "build.exit"],
  );
  assert.equal(steps.find((s) => s.run?.includes("run.sh cleanup")).if, "always()");
  assert.equal(steps.at(-1).if, "always()");
});

test("a blocked package phase persists prerequisites and a nonzero verdict without launching anything", (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "w17-unit-"));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const cwd = scratch + "/cwd",
    out = scratch + "/private";
  fs.mkdirSync(cwd);
  fs.mkdirSync(out, { mode: 0o700 });
  const launch = (script, args = []) =>
    spawnSync(process.execPath, [import.meta.dirname + "/" + script, ...args], {
      cwd,
      env: { W17_OUT: out },
      encoding: "utf8",
    });
  if (process.platform === "darwin") {
    const result = launch("probe.mjs", ["package"]);
    assert.equal(result.status, 1, result.stderr);
    const ledger = JSON.parse(fs.readFileSync(out + "/ledger.json"));
    assert.equal(ledger["M5.copy"].status, "BLOCKED");
    assert.match(ledger["M5.copy"].detail, /M1.identity.*M2.gui/);
    assert.equal(ledger["M4.restored"].status, "NOT RUN");
    const log = fs.readFileSync(out + "/observations.jsonl", "utf8");
    assert.doesNotMatch(log, /"kind":"(?:launch|command)"/);
  }
  const verdict = launch("verdict.mjs");
  assert.equal(verdict.status, 1);
  assert.match(verdict.stdout, /Exact feasibility: FAIL/);
  assert.match(verdict.stdout, /Equivalent-enforcement candidate: unproven/);
});
