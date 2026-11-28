import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { captureFile, diagnosticSummary, launchReceipt, startupCapture } from "./diagnostics.mjs";
import { stagedSentinels } from "./sentinels.mjs";
import {
  alternative,
  exact,
  nativeResult,
  packagedControls,
  parseProcessTable,
  productTree,
} from "./macos/judge.mjs";
import { phaseEvidence, required, decide } from "./macos/verdict.mjs";
import { comparator, restoredTransactions, containerAbsent } from "./windows/verdict.mjs";

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "w17-review-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("Default desktop requests both object rights with standard security rights", () => {
  const args = read("./windows/controller.cpp").match(
    /OpenDesktopW\(L"Default",\s*0,\s*FALSE,\s*([^)]+)\)/,
  );
  assert.ok(args);
  assert.deepEqual(
    new Set(args[1].split("|").map((x) => x.trim())),
    new Set(["DESKTOP_READOBJECTS", "DESKTOP_WRITEOBJECTS", "WRITE_DAC", "READ_CONTROL"]),
  );
  assert.match(read("./windows/broker.ps1"), /'desktop-preflight'\s*\{ return \(DesktopSD 1\)/);
});

test("checkout failure retains bootstrap identity and inline outcomes before upload", (t) => {
  const wf = parse(read("../../../.github/workflows/w17-hosted-probes.yml"));
  assert.deepEqual(wf.on, { push: { branches: ["test/w17-hosted-probes"] } });
  for (const [platform, job] of Object.entries(wf.jobs)) {
    assert.match(job.if, /^github\.run_number <= 3 && github\.run_attempt == 1 && (true|false)$/);
    const { steps } = job,
      checkout = steps.findIndex((s) => s.id === "checkout");
    const init = steps.slice(0, checkout).find((s) => s.run?.includes("observations.jsonl"));
    assert.ok(
      init?.run.includes("bootstrap") &&
        init.run.includes("GITHUB_SHA") &&
        init.run.includes("GITHUB_RUN_ID") &&
        init.run.includes("GITHUB_RUN_ATTEMPT"),
    );
    const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-artifact"));
    const outcomes = steps
      .slice(checkout + 1, upload)
      .find((s) => s.name === "Record step outcomes");
    assert.equal(outcomes.if, "always()");
    assert.equal(steps[upload].with["if-no-files-found"], "error");
    assert.equal(steps[upload].with.path, "${{ steps.outcomes.outputs.files }}");
    const temp = scratch(t);
    const env = {
      ...process.env,
      ...wf.env,
      ...init.env,
      RUNNER_TEMP: temp,
      GITHUB_RUN_ID: "17",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "eae8b2d",
      GITHUB_ENV: path.join(temp, "env"),
      GITHUB_OUTPUT: path.join(temp, "init"),
    };
    const run = (step) =>
      spawnSync("bash", ["-ec", step.run], { cwd: temp, env, encoding: "utf8" });
    const boot = run(init);
    assert.equal(boot.status, 0, boot.stderr);
    const props = Object.fromEntries(
      fs
        .readFileSync(env.GITHUB_OUTPUT, "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("=")),
    );
    const out = props.dir;
    assert.deepEqual(fs.readFileSync(env.GITHUB_ENV, "utf8").trim().split("\n"), [
      "W17_OUT=" + out,
      "W17_ROOT_ID=" + props.identity,
      "W17_OBS_ID=" + props.observations,
    ]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "observations.jsonl"))), {
      kind: "bootstrap",
      platform,
      sha: env.GITHUB_SHA,
      run: "17",
      attempt: "1",
    });
    for (const key of ["CHECKOUT", "SETUP", "PRIMITIVES", "BUILD", "PACKAGE", "CLEANUP"]) {
      assert.equal(outcomes.env[key], "${{ steps." + key.toLowerCase() + ".outcome }}");
      env[key] = ["CHECKOUT", "CLEANUP"].includes(key) ? "failure" : "skipped";
    }
    Object.assign(env, {
      BOOTSTRAP: "success",
      W17_OUT: out,
      OWNED_DIR: props.dir,
      IDENTITY: props.identity,
      OBS_ID: props.observations,
      GITHUB_OUTPUT: path.join(temp, "selected"),
    });
    const result = run(outcomes);
    assert.equal(result.status, 0, result.stderr);
    const snapshot = fs.readFileSync(env.GITHUB_OUTPUT, "utf8").match(/^snapshot=(.*)$/m)[1];
    assert.notEqual(snapshot, out);
    const artifact = fs
      .readFileSync(path.join(snapshot, "observations.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      artifact[0],
      JSON.parse(fs.readFileSync(path.join(out, "observations.jsonl"))),
    );
    assert.equal(artifact.at(-1).checkout, "failure");
    assert.equal(artifact.at(-1).primitives, "skipped");
    assert.equal(artifact.at(-1).owned, true);
    const verdict = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, platform, "verdict.mjs")],
      { cwd: temp, env: { W17_OUT: snapshot } },
    );
    assert.equal(verdict.status, 1);
  }
});

const marker = (n, event) => "W17 launch 17 " + n + " " + event + "\n";
const announcement = "Debugger listening on ws://127.0.0.1:53187/abcde-123\n";
test("Windows startup requires a nonempty capture from the same launch", (t) => {
  const file = path.join(scratch(t), "stderr");
  assert.equal(startupCapture(captureFile(file), "launch", 17, 53187), false);
  for (const invalid of [
    "",
    announcement,
    marker(0, "start"),
    announcement + marker(0, "start").replace("launch", "stale"),
  ]) {
    fs.writeFileSync(file, invalid);
    assert.equal(startupCapture(captureFile(file), "launch", 17, 53187), false);
  }
  fs.writeFileSync(file, announcement + marker(0, "start"));
  const capture = captureFile(file);
  assert.equal(startupCapture(capture, "launch", 17, 53187), true);
  assert.equal(startupCapture(capture, "launch", 17, 53188), false);
});

test("split debugger URL and split crash signature produce only diagnostic classes", (t) => {
  const file = path.join(scratch(t), "stderr");
  for (const chunk of [
    "Debugger listening on w",
    "s://127.0.0.1:53187/",
    "secret-target\n",
    "FA",
    "TAL: message\n",
  ])
    fs.appendFileSync(file, chunk);
  const summary = diagnosticSummary(captureFile(file));
  assert.deepEqual(Object.keys(summary).sort(), ["bytes", "errors", "hash"]);
  assert.deepEqual(summary.errors, ["fatal"]);
  assert.doesNotMatch(JSON.stringify(summary), /secret-target|53187|127\.0|message/);
  const code = read("./macos/product.mjs");
  assert.doesNotMatch(code, /note\("product output"|tail:\s*sanitize/);
  assert.match(code, /note\("startup output",\s*\{\s*arm,\s*logs,\s*receipt/);
});

test("restoration requires matching installed transaction IDs for each policy", () => {
  const done = (id) => ({ id, restored: true });
  assert.equal(restoredTransactions(["A", "B"], [done("B"), done("A")]), true);
  for (const [install, undo] of [
    [undefined, []],
    [[], []],
    [["A"], []],
    [["A", "B"], [done("A")]],
    [["A"], [done("stale")]],
    [["A"], [{ id: "A", restored: false }]],
  ])
    assert.equal(restoredTransactions(install, undo), false);
});

test("a different-UID descendant remains in the tree after reparenting", () => {
  const table = [
    { pid: 8, ppid: 1, uid: 503, exe: "/stage/app/main", birth: "a" },
    { pid: 9, ppid: 8, uid: 0, exe: "/usr/bin/helper", birth: "b" },
    { pid: 10, ppid: 9, uid: 503, exe: "/other", birth: "c" },
    { pid: 11, ppid: 1, uid: 0, exe: "/other", birth: "d" },
  ];
  const ps = table
    .map((p) => [p.uid, p.pid, p.ppid, "Thu Nov 26 15:01:02 2026", p.exe].join(" "))
    .join("\n");
  assert.deepEqual(
    parseProcessTable(ps).map((p) => p.uid),
    [503, 0, 503, 0],
  );
  assert.throws(() => parseProcessTable(ps.replace("0 9 ", "? 9 ")), /process table/);
  const tree = productTree(table, "/stage/app", 8, new Map());
  assert.deepEqual(
    tree.map((p) => p.pid),
    [8, 9, 10],
  );
  assert.equal(
    tree.every((p) => p.uid === 503),
    false,
  );
  const births = new Map(tree.map((p) => [p.pid, p.birth]));
  assert.deepEqual(
    productTree([{ ...table[1], ppid: 1 }], "/stage/app", 8, births).map((p) => p.uid),
    [0],
  );
  assert.deepEqual(
    productTree([{ ...table[1], ppid: 1, birth: "reused" }], "/stage/app", 8, births),
    [],
  );
});

test("an exception after the last required row invalidates phase completion", () => {
  const rows = Object.fromEntries(required.map((k) => [k, { status: "PASS" }]));
  const phases = ["primitives", "package", "cleanup"].flatMap((phase) => [
    { kind: "phase complete", data: { phase } },
    { kind: "phase exit", data: { phase, exit: 0, incomplete: [] } },
  ]);
  assert.equal(phaseEvidence(phases, rows), true);
  assert.equal(
    phaseEvidence([...phases, { kind: "phase error", data: { phase: "cleanup" } }], rows),
    false,
  );
  assert.equal(phaseEvidence([...phases, { kind: "ledger refusal" }], rows), false);
  assert.equal(phaseEvidence(phases.slice(1), rows), false);
  const key = "M4.drop.subject.tcp4.errno";
  rows[key] = { status: "FAIL", detail: { differentErrnoOnly: true } };
  phases[1].data = { phase: "primitives", exit: 1, incomplete: [key] };
  assert.equal(phaseEvidence(phases, rows), true);
  phases[1].data.exit = 2;
  assert.equal(phaseEvidence(phases, rows), false);
});

test("a missing native helper or wrong parent cannot complete a network trial", () => {
  const r = {
    pid: 30,
    exit: 0,
    native: {
      pid: 31,
      ppid: 30,
      uid: 503,
      elapsed: 2002,
      event: "TIMEOUT",
      socket: { result: 3, errno: 0 },
      fcntl: { result: 0, errno: 0 },
      connect: { result: -1, errno: 36 },
      poll: { result: 0, errno: 0 },
    },
  };
  assert.equal(nativeResult(r, 503, "tcp"), true);
  for (const invalid of [
    null,
    { ...r, exit: 1 },
    { ...r, native: null },
    { ...r, native: { ...r.native, ppid: 9 } },
    { ...r, native: { ...r.native, uid: 0 } },
    { ...r, native: { ...r.native, connect: null } },
  ])
    assert.equal(nativeResult(invalid, 503, "tcp"), false);
  const rows = Object.fromEntries(required.map((k) => [k, { status: "PASS" }]));
  delete rows["M4.drop.child.tcp4.native"];
  assert.equal(decide(rows).exact, false);
  assert.equal(decide(rows).equivalent, false);
});

test("a failed Defender bracket or missing native result is unavailable", () => {
  const v = {
    pre: true,
    post: true,
    valid: true,
    node: { code: "TIMEOUT", elapsed: 2002, events: [{ event: "TIMEOUT" }] },
    native: { exit: 0, wsa: 0, step: "reply", elapsed: 12 },
    nodeReply: false,
    nativeReply: true,
    nodeEvents: 0,
    nativeEvents: 1,
    protocol: "tcp",
  };
  assert.deepEqual(comparator(v), { node: "observed non-delivery", native: "delivered" });
  for (const diff of [
    { pre: false },
    { post: false },
    { valid: false },
    { native: null },
    { nativeReply: false },
    { nodeEvents: 1 },
    { node: { code: "EACCES" } },
  ])
    assert.equal(comparator({ ...v, ...diff }), null);
});

test("missing errno and late access errors cannot qualify as errno-only", () => {
  const r = {
    code: "ECONNREFUSED",
    errno: -61,
    elapsed: 20,
    events: [{ event: "ECONNREFUSED", ms: 19 }],
  };
  assert.equal(alternative(r), true);
  assert.equal(alternative({ ...r, errno: null }), false);
  const late = {
    code: "EACCES",
    errno: -13,
    elapsed: 2001,
    events: [{ event: "EACCES", ms: 2001 }],
  };
  assert.equal(exact(late), false);
  assert.equal(alternative(late), false);
  assert.equal(alternative({ ...r, events: [] }), false);
});

test("packaged file denies require the same PID's staged read and profile round trip", () => {
  const r = { pid: 17, euid: 503, files: { checkout: { code: "EACCES" }, copy: { hash: "abc" } } };
  const w = { pid: 17, euid: 503, roundTrip: true };
  assert.equal(packagedControls(r, w, 17, 503, "abc"), true);
  for (const [read, write] of [
    [{ ...r, files: { checkout: r.files.checkout } }, w],
    [r, { ...w, pid: 18 }],
    [r, { ...w, roundTrip: false }],
    [{ ...r, euid: 0 }, w],
  ])
    assert.equal(packagedControls(read, write, 17, 503, "abc"), false);
});

test("helper loss after the snapshot and missing final monitoring both fail health", () => {
  const app = new EventEmitter(),
    main = new EventEmitter(),
    exports = {};
  main.pid = 17;
  app.isReady = () => false;
  app.quit = () => {};
  let stream = "";
  runInNewContext(read("./macos/electron.cjs"), {
    exports,
    __dirname: "fixture",
    process: main,
    setTimeout: (fn) => fn(),
  });
  const api = exports.install(
    (name) =>
      name === "electron"
        ? { app }
        : name === "node:fs"
          ? {
              writeSync(_fd, bytes) {
                stream += bytes;
              },
            }
          : {},
    "launch",
  );
  assert.equal(api.gone.length, 0);
  api.quit();
  app.emit("render-process-gone", {}, { id: 32 }, { reason: "crashed" });
  main.emit("exit");
  assert.match(stream, /2 final/);
  assert.equal(launchReceipt(stream, "launch", 17).healthy, false);
  const begin = marker(0, "start"),
    clean = begin + marker(1, "clean-exit");
  assert.equal(launchReceipt(clean + marker(2, "final"), "launch", 17).healthy, true);
  for (const data of [
    begin,
    clean,
    clean + marker(2, "abnormal") + marker(3, "final"),
    clean + marker(3, "final"),
    clean + marker(2, "final") + marker(3, "abnormal"),
  ])
    assert.equal(launchReceipt(data, "launch", 17).healthy, false);
});

test("stage copies preserve source overlap, use distinct inodes and reject a second link", (t) => {
  const dir = scratch(t),
    src = path.join(dir, "src"),
    stage = path.join(dir, "stage"),
    dep = path.join(src, "node_modules");
  fs.mkdirSync(dep, { recursive: true });
  fs.mkdirSync(stage);
  const roots = { checkout: src, worktree: src, dependency: dep },
    file = path.join(src, "package.json"),
    dependency = path.join(dep, "package.json");
  fs.writeFileSync(file, "root");
  fs.writeFileSync(dependency, "dep");
  const sources = { checkout: file, worktree: file, dependency };
  const copy = stagedSentinels(stage, roots, sources, true);
  assert.equal(copy.files.checkout, copy.files.worktree);
  assert.ok(copy.files.dependency.startsWith(copy.roots.checkout + path.sep));
  assert.notEqual(fs.statSync(file).ino, fs.statSync(copy.files.checkout).ino);
  fs.linkSync(copy.files.checkout, path.join(dir, "outside"));
  assert.throws(() => stagedSentinels(stage, roots, sources, false));
});

test("AppContainer absence requires the owner mapping and folder to agree", () => {
  const independent = {
    expectedFolder: "C:\\Users\\subject\\AppData\\Local\\Packages\\W17",
    expectedFolderError: 3,
    knownFolderResult: 0,
  };
  for (const query of [0x80070057, 0x80070002]) {
    assert.equal(containerAbsent({ query, mapping: 2, folderError: 0 }), false);
    assert.ok(containerAbsent({ query, mapping: 2, folderError: null, ...independent }));
  }
  assert.ok(
    containerAbsent({
      query: 0,
      mapping: 2,
      folder: independent.expectedFolder,
      folderError: 3,
      ...independent,
    }),
  );
  for (const v of [
    { query: 0, mapping: 2, folderError: 0 },
    { query: 0x80070057, mapping: 0 },
    { query: 0x80070005, mapping: 2 },
    { query: 0x80070057 },
  ])
    assert.equal(containerAbsent(v), false);
});

test("native batch preserves successful tuples when another tuple hits the shared deadline", async (t) => {
  const temp = scratch(t),
    calls = [];
  const fakeProcess = {
    env: { TEMP: temp },
    pid: 51,
    ppid: 8,
    execPath: "w17-child.exe",
    getBuiltinModule(name) {
      if (name === "node:perf_hooks") return { performance: { now: () => 100 } };
      if (name === "node:child_process")
        return {
          execFile(exe, [out, kind], options, done) {
            calls.push({ kind, exe, timeout: options.timeout });
            if (kind === "slow") done({ killed: true });
            else {
              fs.writeFileSync(out, JSON.stringify({ wsa: 0 }));
              done(null);
            }
          },
        };
      return process.getBuiltinModule(name);
    },
  };
  const module = { exports: {} };
  runInNewContext(read("./windows/client.cjs"), {
    process: fakeProcess,
    module,
    require: { main: null },
    __dirname: temp,
  });
  const tasks = ["ok", "slow", "ok"].map((key) => ({ action: "native", child: true, args: [key] }));
  const results = await module.exports.execute({ action: "batch", tasks }, 550);
  assert.deepEqual(
    Array.from(results, (r) => r.error ?? r.exit),
    [0, "NATIVE_TIMEOUT", 0],
  );
  assert.deepEqual(
    calls.map((c) => c.timeout),
    [450, 450, 450],
  );
  const expired = await module.exports.execute({ action: "batch", tasks }, 100);
  assert.ok(expired.every((r) => r.error === "BATCH_DEADLINE"));
  assert.equal(calls.length, 3);
});

test("shared ACL and audit rollback refuse a conflicting current value", () => {
  const broker = read("./windows/broker.ps1") + read("./windows/raw-acl.ps1");
  const fn = broker.match(/function NeedsRestore\([^]*?^\}/m)?.[0];
  assert.ok(fn);
  assert.match(broker, /NeedsRestore \$current \$e.data.before \$e.data.installed/);
  assert.match(broker, /NeedsRestore \$current \$d.before \$d.installed/);
  assert.match(
    broker,
    /\$before=AuditBits \$d.before\s+\$v=AuditBits \$v\s+if \(NeedsRestore \$v \$before \$d.installed/,
  );
  const fixture =
    fn +
    `
    if (NeedsRestore 'before' 'before' 'owned' 'fixture') {exit 1}
    if (!(NeedsRestore 'owned' 'before' 'owned' 'fixture')) {exit 2}
    try {$null=NeedsRestore 'foreign' 'before' 'owned' 'fixture'; exit 3}
    catch {if ($_.Exception.Message -notmatch 'Conflicting') {exit 4}}
    exit 0
  `;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test("broker rollback uses the raw section for conflict detection and post-write verification", () => {
  const broker = read("./windows/broker.ps1") + read("./windows/raw-acl.ps1");
  const functions = ["Check", "Section", "Write-RawDacl", "NeedsRestore", "RestoreAcl"].map(
    (name) => broker.match(new RegExp("^function " + name + "\\([^]*?^\\}", "m"))[0],
  );
  const fixture = `
    $ErrorActionPreference='Stop'
    class W17 {
      static [int] $writes
      static [bool] $dropWrite
      static [uint32] WriteDacl([string]$path,[string]$before,[string]$sddl,[Text.StringBuilder]$observed,[uint32]$cap) {
        if ($before -cne [W17]::raw) {return 1306}
        if ($path -cne 'child') {throw 'bad write path'}
        [W17]::writes++
        if (![W17]::dropWrite) { [W17]::raw=$sddl }
        return 0
      }
      static [string] $raw
      static [uint32] $errorCode
      static [uint32] ReadDacl([string]$path,[Text.StringBuilder]$buf,[uint32]$cap) {
        if ($path -cne 'child' -or $buf.Capacity -ne $cap) { throw 'bad raw query' }
        [void]$buf.Append([W17]::raw)
        return [W17]::errorCode
      }
    }
    ${functions.join("\n")}
    $entry=@{data=@{path='child';before='D:(A;ID;FA;;;BA)';installed='D:(D;;FR;;;WD)(A;ID;FA;;;BA)'}}
    [W17]::writes=0
    [W17]::raw=$entry.data.before
    RestoreAcl $entry
    if ([W17]::writes) {throw 'wrote original'}
    [W17]::raw='D:P(A;;FA;;;BA)'
    try {RestoreAcl $entry; throw 'accepted conflict'}
    catch {if ($_.Exception.Message -notlike 'Conflicting descriptor*') {throw}}
    if ([W17]::writes) {throw 'wrote over conflict'}
    [W17]::raw=$entry.data.installed
    [W17]::dropWrite=$true
    try {RestoreAcl $entry; throw 'accepted stale readback'}
    catch {if ($_.Exception.Message -notlike 'DACL restoration mismatch*') {throw}}
    [W17]::dropWrite=$false
    RestoreAcl $entry
    if ([W17]::writes -ne 2 -or [W17]::raw -cne $entry.data.before) {throw 'restore failed'}
    [W17]::errorCode=5
    try {RestoreAcl $entry; throw 'accepted failed raw read'}
    catch {if ($_.Exception.Message -notlike '*returned 5') {throw}}
    if ([W17]::writes -ne 2) {throw 'wrote after failed read'}
    exit 0
  `;
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", fixture], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});

test("raw private DACL verifier checks exact ACE membership and cleanup records gate failures", () => {
  const wf = parse(read("../../../.github/workflows/w17-hosted-probes.yml"));
  const script = wf.env.W17_PRIVATE_ACL;
  const run = read("./windows/run.ps1");
  assert.doesNotMatch(read("./windows/broker.ps1"), /(?:Ace|Set-Acl)\s+\$env:RUNNER_TEMP/i);
  const broker = read("./windows/broker.ps1");
  assert.match(
    broker,
    /if \(\$a.sid -eq \$j.accounts.subject.sid\) \{\s+\$null=Install-LowLabel \$a.home/,
  );
  assert.match(broker, /'label' \{ RestoreLabel \$e \}/);
  assert.match(broker, /\$pendingStage=.*'label'/);
  // The workflow sets the protected DACL on fresh controller directories only.
  assert.deepEqual(
    script.match(/^.*\b(?:Get|Set)-Acl\b.*$/gim)?.map((s) => s.trim()),
    ["Set-Acl -LiteralPath $env:W17_PRIVATE -AclObject $acl"],
  );
  assert.doesNotMatch(
    run + read("./windows/broker.ps1") + read("./windows/raw-acl.ps1"),
    /\b(?:(?:Get|Set)-Acl|icacls(?:\.exe)?|cacls(?:\.exe)?|SetAccessControl|SetNamedSecurityInfo\w*|SetSecurityInfo)\b/i,
  );
  assert.match(script, /NtQuerySecurityObject/);
  assert.match(
    run,
    /evidence\.mjs" recover[^]*phase-log\.mjs" \$Phase begin[^]*try \{[^]*W17_PRIVATE_ACL[^]*catch \{[^]*\$Phase failure/,
  );
  const verify = script.slice(script.indexOf("$seen=@{}"));
  const testScript = `
    $ErrorActionPreference='Stop'
    function Verify($sd) { $trustees=@('sid1','sid2'); ${verify} }
    function Rule($sid) { @{SecurityIdentifier=@{Value=$sid};AceType='AccessAllowed';AceFlags=3;AccessMask=2032127;OpaqueLength=0} }
    function Fixture { @{ ControlFlags=4096;DiscretionaryAcl=@((Rule sid1),(Rule sid2)) } }
    Verify (Fixture)
    foreach ($case in @('duplicate','rights','extra','deny','inherit','unprotected','opaque')) {
      $sd=Fixture
      switch ($case) {
        duplicate {$sd.DiscretionaryAcl[1]=Rule sid1}
        rights {$sd.DiscretionaryAcl[1].AccessMask=1}
        extra {$sd.DiscretionaryAcl+=Rule sid3}
        deny {$sd.DiscretionaryAcl[1].AceType='AccessDenied'}
        inherit {$sd.DiscretionaryAcl[1].AceFlags=19}
        unprotected {$sd.ControlFlags=0}
        opaque {$sd.DiscretionaryAcl[1].OpaqueLength=1}
      }
      try { Verify $sd } catch { continue }
      throw "Accepted $case"
    }`;
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", testScript + "\nexit 0"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test("audit rollback writes NONE for disabled policy and verifies effective readback", () => {
  const src = read("./windows/broker.ps1") + read("./windows/raw-acl.ps1");
  const defs = ["AuditBits", "NeedsRestore", "Check"].map(
    (name) => src.match(new RegExp("^function " + name + "\\([^]*?^\\}", "m"))[0],
  );
  const restore = src
    .match(/'audit' \{\n([^]*?)\n {16}\}/)[1]
    .replaceAll("[W17]::Audit", "[MockAudit]::Audit");
  const fixture = `
    $ErrorActionPreference='Stop'
    class MockAudit {
      static [uint32]$value
      static [bool]$drop
      static [int]Audit([int]$write,[ref]$v) {
        if (!$write) { $v.Value=[MockAudit]::value }
        elseif ($v.Value -ne 0 -and ![MockAudit]::drop) { [MockAudit]::value=$v.Value }
        return 0
      }
    }
    ${defs.join("\n")}
    function Restore($d) { ${restore} }
    $d=@{before=0;installed=2}
    [MockAudit]::value=2
    Restore $d
    if ([MockAudit]::value -ne 4) { throw 'missing NONE' }
    Restore $d
    [MockAudit]::value=2; [MockAudit]::drop=$true
    try { Restore $d; throw 'accepted failed write' } catch { if ($_.Exception.Message -ne 'Audit restoration mismatch') {throw} }
  `;
  const r = spawnSync("pwsh", ["-NoProfile", "-Command", fixture + "\nexit 0"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
