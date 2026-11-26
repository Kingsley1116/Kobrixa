import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { initial, required, decide, recorded, exact, alternative, join } from "./verdict.mjs";

const observed = (code) => ({
  code,
  elapsed: 8,
  events: [
    { event: "error", code, ms: 7 },
    { event: code, ms: 7 },
  ],
});
test("the exact TCP predicate requires a measured access error before the installed timer", () => {
  for (const code of ["EPERM", "EACCES"]) assert.equal(exact(observed(code)), true);
  for (const code of ["TIMEOUT", "ECONNREFUSED", "ECONNRESET", "CONNECTED", "REPLY", "EOF"])
    assert.equal(exact(observed(code)), false);
  for (const r of [
    null,
    {},
    { ...observed("EPERM"), elapsed: 2000 },
    { code: "EPERM", elapsed: 8, events: [{ event: "EPERM", ms: null }] },
    {
      code: "EPERM",
      elapsed: 8,
      events: [
        { event: "CONNECTED", ms: 1 },
        { event: "EPERM", ms: 8 },
      ],
    },
  ])
    assert.equal(exact(r), false);
});
test("an errno-only amendment requires a measured alternative, including a literal timeout", () => {
  for (const c of ["TIMEOUT", "ECONNREFUSED", "ECONNRESET"])
    assert.equal(alternative(observed(c)), true);
  for (const c of ["EPERM", "EACCES", "REPLY", "BAD_REPLY", "CONNECTED"])
    assert.equal(alternative(observed(c)), false);
  assert.equal(alternative({ code: "TIMEOUT" }), false);
});
test("5157 correlation requires the correct filter ID, direction, PID, time, protocol and full tuple", () => {
  const t = {
    protocol: "tcp",
    host: "127.0.0.1",
    source: "127.0.0.1",
    port: 50101,
    localPort: 50102,
  };
  const id = "9007199254740993",
    at = "2026-11-25T00:00:00.000Z",
    ms = Date.parse(at);
  const event = {
    at,
    ProcessID: "0x7b",
    FilterRTID: id,
    Direction: "%%14593",
    SourceAddress: t.source,
    SourcePort: String(t.localPort),
    DestAddress: t.host,
    DestPort: String(t.port),
    Protocol: "6",
  };
  const match = (e) => join([e], t, 123, id, ms - 100, ms + 100);
  assert.deepEqual(match(event), [event]);
  for (const diff of [
    { Direction: "%%14592" },
    { at: "2026-11-25T00:00:03Z" },
    { SourceAddress: "::1" },
    { DestAddress: "::1" },
    { ProcessID: "122" },
    { FilterRTID: "9007199254740992" },
    { SourcePort: "1" },
    { DestPort: "1" },
    { Protocol: "17" },
  ])
    assert.deepEqual(match({ ...event, ...diff }), []);
  assert.deepEqual(join(null, t, 123, id, ms, ms), []);
  assert.deepEqual(join([event], t, null, id, ms, ms), []);
});
const ok = () => Object.fromEntries(required("wfp").map((k) => [k, { status: "PASS" }]));
test("every required row is individually decisive, including the package, external, second identity and cleanup joins", () => {
  assert.equal(decide(initial()).exact, false);
  assert.equal(decide(ok()).exact, true);
  for (const k of required("wfp")) {
    const rows = ok();
    delete rows[k];
    assert.equal(decide(rows).exact, false, k);
    rows[k] = { status: "BLOCKED", prerequisite: "missing" };
    assert.equal(decide(rows).equivalent, false, k);
  }
  const rows = ok();
  rows["interface.routed6"] = { status: "PASS" };
  assert.equal(decide(rows).exact, false);
});
test("alternative enforcement requires the entire same arm and an observed errno-only delta", () => {
  const rows = ok(),
    key = "W5.wfp.main.loop4.tcp.errno";
  rows[key] = { status: "FAIL", differentErrnoOnly: true, code: "TIMEOUT" };
  assert.equal(decide(rows).exact, false);
  assert.equal(decide(rows).equivalent, true);
  rows["container.child.loop4.tcp.block"] = { status: "PASS" };
  rows["wfp.child.loop4.tcp.block"] = { status: "NOT RUN" };
  assert.equal(decide(rows).equivalent, false);
  rows["wfp.child.loop4.tcp.block"] = { status: "PASS" };
  rows[key].differentErrnoOnly = false;
  assert.equal(decide(rows).equivalent, false);
});
test("each claimed observation and each phase exit needs a matching controller record", () => {
  const rows = ok(),
    obs = Object.entries(rows).map(([key, data]) => ({ kind: "row", data: { key, ...data } }));
  assert.equal(recorded(rows, obs), false);
  obs.push(
    ...["primitives", "package", "cleanup"].map((phase) => ({
      kind: "phase exit",
      data: { phase, exit: 0 },
    })),
  );
  assert.equal(recorded(rows, obs), true);
  assert.equal(recorded(rows, obs.slice(1)), false);
  assert.equal(
    recorded(rows, [...obs, { kind: "phase exit", data: { phase: "package", exit: 1 } }]),
    false,
  );
});
test("a compiler failure survives initialization of a later phase and the final verdict fails", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "w17-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (file, ...args) =>
    spawnSync(process.execPath, [path.join(import.meta.dirname, file), ...args], {
      env: { ...process.env, W17_OUT: dir, GITHUB_STEP_SUMMARY: "" },
      encoding: "utf8",
    });
  assert.equal(run("phase-log.mjs", "primitives", "begin").status, 0);
  assert.equal(run("phase-log.mjs", "primitives", "failure", "2").status, 0);
  assert.equal(run("phase-log.mjs", "package", "begin").status, 0);
  writeFileSync(
    path.join(dir, "resources.json"),
    JSON.stringify({ entries: [{ kind: "tree-acl", done: false }] }),
  );
  assert.equal(run("phase-log.mjs", "build", "guard-build").status, 1);
  writeFileSync(
    path.join(dir, "resources.json"),
    JSON.stringify({ entries: [{ kind: "tree-acl", done: true }] }),
  );
  assert.equal(run("phase-log.mjs", "build", "guard-build").status, 0);
  const ledger = JSON.parse(readFileSync(path.join(dir, "ledger.json")));
  assert.equal(ledger["phase.primitives"].status, "FAIL");
  assert.equal(ledger["W2.denied"].status, "NOT RUN");
  writeFileSync(path.join(dir, "build.exit"), "0");
  const verdict = run("verdict.mjs");
  assert.equal(verdict.status, 1);
  assert.equal(JSON.parse(verdict.stdout).equivalentEnforcementCandidate, false);
});
test("the staged Node parent and differently named child perform actual file reads and keep the missing-file errno", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "w17-client-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const client = path.join(import.meta.dirname, "client.cjs"),
    file = path.join(dir, "input"),
    output = path.join(dir, "output"),
    plan = path.join(dir, "plan");
  const child = path.join(
    dir,
    path.basename(process.execPath) + "-w17" + (process.platform === "win32" ? ".exe" : ""),
  );
  copyFileSync(process.execPath, child);
  writeFileSync(file, "test file");
  for (const descendant of [false, true]) {
    writeFileSync(
      plan,
      JSON.stringify({
        task: {
          action: "files",
          paths: { present: file, missing: path.join(dir, "absent") },
          writable: path.join(dir, "profile"),
        },
        output,
        child: descendant ? child : null,
      }),
    );
    const r = spawnSync(process.execPath, [client, plan], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const data = JSON.parse(readFileSync(output));
    assert.equal(data.roundTrip, true);
    assert.match(data.files.present.hash, /^[a-f0-9]{64}$/);
    assert.equal(data.files.missing.code, "ENOENT");
    assert.equal(data.exe, descendant ? child : process.execPath);
  }
});
test("Windows has its own bounded allocation and only ordinary allowlisted files can be uploaded", () => {
  const workflow = parse(
      readFileSync(path.resolve(".github/workflows/w17-hosted-probes.yml"), "utf8"),
    ),
    job = workflow.jobs.windows;
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(job["runs-on"], "windows-2022");
  assert.equal(job["timeout-minutes"], 45);
  assert.match(job.if, /run_number <= 3 && github.run_attempt == 1/);
  const steps = job.steps;
  assert.equal(
    steps.find((s) => s.uses?.startsWith("actions/checkout")).with["persist-credentials"],
    false,
  );
  assert.ok(steps.some((s) => s.uses === "./.github/actions/setup"));
  const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact"));
  const cleanup = steps.findIndex((s) => s.if === "always()" && s.run?.endsWith("-Phase cleanup"));
  assert.ok(cleanup >= 0 && cleanup < upload);
  assert.equal(steps[upload].if, "always() && steps.outcomes.outputs.files != ''");
  assert.equal(steps[upload].with["retention-days"], 14);
  assert.match(steps[upload].with.name, /^w17-probe-windows-/);
  assert.equal(steps[upload].with.path, "${{ steps.outcomes.outputs.files }}");
  const collect = steps.find((s) => s.id === "outcomes");
  assert.deepEqual(
    JSON.parse(collect.run.match(/const names\s*=\s*owned\s*\?\s*(\[[^\]]+\])/)[1]),
    ["ledger.json", "observations.jsonl", "build.exit"],
  );
  assert.equal(steps.at(-1).if, "always()");
  assert.match(steps.at(-1).run, /windows\/verdict\.mjs/);
});
