import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileFunction, runInNewContext } from "node:vm";
import { parse } from "yaml";
import { appendObservation } from "./evidence.mjs";
import {
  checkpointUtility,
  launchReceipt,
  diagnosticSummary,
  startupCapture,
} from "./diagnostics.mjs";
import { nativeResult } from "./macos/judge.mjs";
import * as mac from "./macos/verdict.mjs";
import * as win from "./windows/verdict.mjs";

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), "utf8");
const workflow = () => parse(read("../../../.github/workflows/w17-hosted-probes.yml"));
const noop = () => {};
function scratch(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "w17-closeout-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
// Execute complete production functions, including their row writers and assertions.
// Replace privileged OS calls in their lexical environment.
function caller(file, name, bindings) {
  const source = read(file).match(
    new RegExp("^(?:export )?((?:async )?function " + name + "\\([^]*?^\\})", "m"),
  )?.[1];
  assert.ok(source, "production caller " + name);
  return compileFunction("return " + source, Object.keys(bindings))(...Object.values(bindings));
}
function journal(t, platform) {
  const dir = scratch(t),
    file = path.join(dir, "observations.jsonl");
  const note = caller(platform + "/context.mjs", "note", {
    appendObservation,
    fs,
    path,
    out: dir,
    phase: "fixture",
    target: (name) => path.join(dir, name),
  });
  return {
    dir,
    note,
    records: () => fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse),
  };
}
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: "utf8", ...opts });
  assert.equal(r.status, 0, r.error?.message ?? r.stderr + "\n" + r.stdout);
  return r.stdout;
}

test("W6 packaged negative controls retain both target births and each actual memory call", async (t) => {
  const { dir, note, records } = journal(t, "windows");
  const ctx = {
    controller: { pid: process.pid, birth: "1234" },
    broker: { pid: process.pid + 1, birth: "5678" },
    accounts: { subject: { sid: "subject" }, other: { sid: "other" } },
  };
  let role,
    changed = false;
  const calls = [];
  const proc = {
    env: { TEMP: dir },
    getBuiltinModule(name) {
      if (name === "node:fs")
        return {
          ...fs,
          openSync(file, ...args) {
            if (file === path.join(dir, "ledger.json"))
              throw Object.assign(Error(), { code: "EACCES" });
            return fs.openSync(file, ...args);
          },
        };
      if (name === "node:child_process")
        return {
          execFile(_exe, [file, action, target], _options, done) {
            assert.equal(action, "memory");
            calls.push([role, Number(target)]);
            fs.writeFileSync(
              file,
              JSON.stringify({ error: 5, token: { sid: role }, targetPid: Number(target) }),
            );
            done(null);
          },
        };
      return process.getBuiltinModule(name);
    },
  };
  const module = { exports: {} };
  runInNewContext(read("windows/client.cjs"), {
    module,
    process: proc,
    require: {},
    __dirname: dir,
  });
  const statuses = [];
  const negatives = caller("windows/product.mjs", "negatives", {
    ctx,
    path,
    out: dir,
    assert,
    process,
    note,
    rpc: (_op, { pid }) => ({
      ...Object.values(ctx).find((v) => v.pid === pid),
      ...(changed ? { birth: "88" } : {}),
    }),
    measure: async (key, fn) => {
      if (!key.endsWith(".resources")) return;
      try {
        await fn();
        statuses.push(true);
      } catch {
        statuses.push(false);
      }
    },
    actor: (task, opts) => {
      role = opts.role;
      return module.exports.execute(task);
    },
  });
  // Drive the packaged caller through the inspector boundary with synthetic
  // replies. A known PID with a truncated start/final capture must also fail quit.
  Object.assign(ctx, { exe: "fixture.exe", archive: dir, bin: dir });
  ctx.accounts.subject.home = dir;
  const productPid = 300,
    utilityPid = 301,
    processRows = [];
  let quitting = false,
    clock = 0;
  const token = { sid: "subject", elevated: 0, birth: "fixture" };
  const main = {
    js: async (expression) => {
      if (expression === "w17.identity()")
        return {
          packaged: true,
          name: "Kobrixa",
          exe: ctx.exe,
          archive: dir,
          profile: path.join(dir, "product-wfp"),
          cwd: path.join(dir, "empty"),
          clean: true,
          path: path.join(dir, "System32"),
        };
      if (expression === "w17.startUtility()") return utilityPid;
      if (expression === "w17.metrics()")
        return ["Browser", "GPU", "Tab", "Utility"].map((type, i) => ({
          type,
          pid: i === 3 ? utilityPid : productPid,
        }));
      if (expression === "w17.gone") return [];
      if (expression === "w17.quit()") {
        quitting = true;
        return true;
      }
      return productPid;
    },
    close: noop,
  };
  const capture = Buffer.from(
    "Debugger listening on ws://127.0.0.1:42/abc\nW17 n 300 0 start\nW17 n 300 1 final\n",
  );
  const capturePath = path.join(dir, "private.stderr");
  fs.writeFileSync(capturePath, capture);
  const product = caller("windows/product.mjs", "product", {
    ctx,
    fs,
    path,
    assert,
    process: { env: { SystemRoot: dir } },
    fresh: () => ({ localPort: 42 }),
    intent: noop,
    randomUUID: () => "n",
    launch: () => ({
      pid: productPid,
      stderr: capturePath,
      wait: () => {
        if (changed) throw Error("fixture wait unavailable");
        return { wait: 0, exit: 0 };
      },
    }),
    inspector: () => 1,
    connect: (url) => (url === 1 ? main : { js: () => true, close: noop }),
    releaseStartingWorkers: () => ({ dispose: noop }),
    observeBeforeStartup: noop,
    timed: () => 42,
    waitForRendererTarget: () => ({ url: "fixture", webSocketDebuggerUrl: 2 }),
    fileURLToPath: () => path.join(dir, "renderer"),
    row: (k, status, detail) => {
      if (k.endsWith(".processes")) processRows.push({ status, detail });
    },
    rpc: (op) =>
      op === "inspect"
        ? token
        : op === "tree"
          ? quitting
            ? []
            : [productPid, utilityPid].map((pid) => ({ pid, exe: ctx.exe, token, member: 1 }))
          : 0,
    note,
    same: (a, b) => a === b,
    measure: async (k, fn) => {
      if (k.endsWith(".quit")) await assert.rejects(fn());
    },
    trial: noop,
    negatives,
    performance: { now: () => (clock += 5001) },
    sleep: noop,
    captureFile: () => capture,
    diagnosticSummary,
    out: dir,
    checkpointUtility,
    startupCapture,
    launchReceipt,
    block: noop,
    rows: {},
    safe: String,
  });
  await product("wfp", {}, {});
  changed = true;
  quitting = false;
  await product("wfp", {}, {});
  assert.equal(
    records().filter(
      (r) =>
        r.kind === "utility spawned" &&
        r.data.pid === utilityPid &&
        r.data.outcome === "no terminal observation",
    ).length,
    2,
  );
  assert.ok(records().some((r) => r.kind === "orphan monitoring failed"));
  assert.equal(processRows.length, 2);
  for (const { status, detail } of processRows) {
    assert.equal(status, "FAIL");
    assert.equal(detail.snapshot.utility, utilityPid);
    assert.deepEqual(detail.receipt.utility, {
      pid: utilityPid,
      acknowledged: false,
      exitCode: null,
      outcome: "no terminal observation",
    });
  }
  assert.deepEqual(statuses, [true, true, false, false]);
  assert.deepEqual(
    calls.slice(0, 4),
    ["subject", "other"].flatMap((r) => [ctx.controller, ctx.broker].map((t) => [r, t.pid])),
  );
  const receipts = records().filter((r) => r.kind === "controller resource access");
  for (const { data } of receipts)
    for (const name of ["controller", "broker"]) {
      assert.equal(data.memory[name].birth, ctx[name].birth);
      assert.equal(data.memory[name].targetPid, ctx[name].pid);
    }
  assert.match(read("windows/probe.mjs"), /rpc\("host",\s*\{ controllerPid: process.pid \}\)/);
  assert.match(
    read("windows/broker.ps1"),
    /controller=\(Get-TokenSample \$p.controllerPid\);broker=\(Get-TokenSample \$PID\)/,
  );
});

test(
  "Darwin primitive callers retain interrupted poll and failed read as distinct unavailable outcomes",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const { dir, note, records } = journal(t, "macos");
    // Interpose only on this fixture translation unit. No bind/connect reaches the OS.
    fs.writeFileSync(
      path.join(dir, "fixture.c"),
      `
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <poll.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>
#define socket(a,b,c) 42
#define fcntl(a,b,c) 0
#define connect(a,b,c) (errno=EINPROGRESS,-1)
#define poll(a,b,c) (errno=EINTR,-1)
#define open(a,b) 43
#define read(a,b,c) (errno=EACCES,-1)
#define close(a) ((void)0)
#include "native.c"
`,
    );
    run("clang", ["-I", path.join(import.meta.dirname, "macos"), "fixture.c", "-o", "native"], {
      cwd: dir,
    });
    fs.copyFileSync(new URL("macos/client.cjs", import.meta.url), path.join(dir, "client.cjs"));
    const task = (t) =>
      JSON.parse(run(process.execPath, [path.join(dir, "client.cjs"), JSON.stringify(t)]));
    const j = {
      uid: process.getuid(),
      files: { checkout: "fixture" },
      hashes: { checkout: "h" },
      anchor: "fixture",
    };
    const measured = (key, pass, data) => note(key, { status: pass ? "PASS" : "FAIL", ...data });
    const common = {
      j,
      roles: ["subject"],
      validIdentity: () => true,
      task,
      measured,
      note,
      nativeResult,
    };
    caller("macos/acl.mjs", "aclTrial", {
      ...common,
      allowBaseline: noop,
      deny: noop,
      checkpoint: noop,
      reads: (phase) => ({
        subject: { checkout: phase === "baseline" ? { hash: "h" } : { code: "EACCES" } },
      }),
      positive: () => true,
      fileRows: ["checkout"],
    })();
    const endpoint = { id: "tcp4", family: "tcp4", port: 42, host: "127.0.0.1", events: [] };
    await caller("macos/network.mjs", "primitivesNetwork", {
      ...common,
      trials: ["drop"],
      families: ["tcp4"],
      subjectControls: () => ({ subjecttcp4: true }),
      tuple: () => ({}),
      install: noop,
      removePF: noop,
      netRow: mac.netRow,
      control: () => {
        throw Error("fixture");
      },
      blocked: noop,
      delay: noop,
      randomUUID: () => "fixture",
      reverse: () => ({ ok: false }),
      row: noop,
      blockPrefix: noop,
    })(Object.assign([endpoint], { expectedRoutes: [] }), noop);
    const file = records().find((r) => r.kind === "M3.subject.checkout").data;
    assert.equal(file.status, "FAIL");
    assert.ok(file.native.native.open.result >= 0);
    assert.deepEqual(file.native.native.read, { result: -1, errno: 13 });
    assert.deepEqual(
      records().find((r) => r.kind === "native file attempt").data.native,
      file.native,
    );
    const tcp = records().find((r) => r.kind === "M4.drop.subject.tcp4.native").data;
    assert.deepEqual(
      records().find((r) => r.kind === "native socket attempt").data.result,
      tcp.result,
    );
    assert.equal(tcp.status, "FAIL");
    assert.deepEqual(tcp.result.native.poll, { result: -1, errno: 4 });
    assert.equal(tcp.result.native.connect.errno, 36);
    assert.ok(!Object.hasOwn(tcp.result.native, "completedConnectErrno"));
  },
);

test("Defender primitives retain eight advertised tuples, raw failed binds and invalid native results", async (t) => {
  const { note, records } = journal(t, "windows"),
    ctx = { node: "node", child: "child", accounts: { subject: { sid: "S" } } };
  let failedBind = true,
    invalid = false,
    bracket = true;
  const rpc = (op, args) => {
    if (op === "receiver")
      return args.location === "routed6" && failedBind
        ? { operation: "bind", wsa: 10049, port: null, pid: 18 }
        : { wsa: 0, port: 9000, pid: 18 };
    if (op === "firewall") return { enabled: "True", direction: "Outbound", action: "Block" };
    return ctx.accounts;
  };
  const receivers = caller("windows/network.mjs", "receivers", {
    ctx,
    os: {
      networkInterfaces: () => ({
        eth: [
          { family: "IPv4", address: "192.0.2.1" },
          { family: "IPv6", address: "2001:db8::1" },
        ],
      }),
    },
    rpc,
    row: noop,
    note,
    safe: String,
  });
  const complete = caller("windows/network.mjs", "complete", { ctx, endpoints: win.endpoints });
  const trial = caller("windows/network.mjs", "trial", {
    ctx,
    controller: () => bracket,
    fresh: () => ({ localPort: 1 }),
    delivery: () => [],
    reply: () => false,
    note,
    sleep: noop,
    comparator: win.comparator,
  });
  const both = async (prefix) => {
    const all = {};
    for (const who of ["subject", "child"]) {
      if (prefix === "baseline") for (const e of ctx.listeners) all[who + "." + e.label] = true;
      else
        Object.assign(
          all,
          await trial(prefix, who, ({ tasks }) =>
            tasks.map((task, i) =>
              task.action === "native"
                ? {
                    token: { sid: "S", isContainer: 0 },
                    wsa: invalid && i === 0 ? 10022 : 10013,
                    step: "connect",
                    exit: 0,
                    elapsed: 8,
                  }
                : {
                    pid: 41,
                    exe: who === "child" ? "child" : "node",
                    code: "TIMEOUT",
                    elapsed: 2002,
                    events: [{ event: "TIMEOUT" }],
                  },
            ),
          ),
        );
    }
    return all;
  };
  const rows = [];
  const primitives = caller("windows/probe.mjs", "primitives", {
    ctx,
    rpc,
    stage: noop,
    layout: noop,
    note,
    standard: noop,
    forced: noop,
    receivers,
    both,
    reverse: () => ({}),
    complete,
    assert,
    endpoints: win.endpoints,
    measure: async (key, fn) => {
      if (key === "W3.firewallRemoved") throw Error("fixture end");
      if (key !== "W3.firewall") return;
      try {
        await fn();
        rows.push("PASS");
      } catch {
        rows.push("FAIL");
      }
    },
  });
  const sample = () => assert.rejects(primitives(), /fixture end/);
  await sample();
  failedBind = false;
  invalid = true;
  await sample();
  invalid = false;
  bracket = false;
  await sample();
  bracket = true;
  await sample();
  assert.deepEqual(rows, ["FAIL", "FAIL", "FAIL", "PASS"]);
  const log = records();
  assert.deepEqual(
    log.find((r) => r.kind === "Defender comparison coverage").data.incomplete.map((r) => r.key),
    ["subject", "child"].flatMap((role) =>
      ["tcp", "udp"].map((protocol) => role + ".routed6." + protocol),
    ),
  );
  assert.equal(log.find((r) => r.kind === "advertised receivers").data.length, 8);
  assert.deepEqual(
    log
      .filter((r) => r.kind === "receiver unavailable")
      .map((r) => [r.data.label, r.data.host, r.data.operation, r.data.wsa]),
    ["tcp", "udp"].map((p) => ["routed6." + p, "2001:db8::1", "bind", 10049]),
  );
  assert.equal(
    log.filter((r) => r.kind === "Defender classified outcomes")[1].data["subject.loop4.tcp"]
      .native,
    "not-a-policy-result",
  );
  assert.ok(log.some((r) => r.kind === "network attempt" && r.data.osResult.wsa === 10022));
});

test("utility installer and final capture retain expected, abnormal and unobserved exits", async () => {
  for (const platform of ["macos", "windows"])
    for (const [exitCode, ack, outcome] of [
      [undefined, false, "no terminal observation"],
      [1, true, "abnormal exit"],
      [0, false, "abnormal exit"],
      [0, true, "expected quit"],
    ]) {
      const app = new EventEmitter(),
        main = new EventEmitter(),
        utility = new EventEmitter(),
        exports = {};
      Object.assign(main, { pid: 17, cwd: () => "fixture" });
      app.isReady = () => false;
      const port = new EventEmitter(),
        child = {
          pid: 43,
          getBuiltinModule: process.getBuiltinModule,
          parentPort: port,
          exit: () => utility.emit("exit", exitCode),
        };
      port.postMessage = (message) => {
        if (ack) utility.emit("message", message);
      };
      Object.assign(utility, { pid: 43, postMessage: (data) => port.emit("message", { data }) });
      runInNewContext(read(platform + "/client.cjs"), {
        process: child,
        module: { exports: {} },
        require: {},
        __dirname: "fixture",
      });
      let stream = "";
      runInNewContext(read("macos/electron.cjs"), {
        exports,
        __dirname: "fixture",
        process: main,
        setTimeout: noop,
      });
      const api = exports.install(
        (n) =>
          n === "electron"
            ? { app, utilityProcess: { fork: () => utility } }
            : n === "node:fs"
              ? { writeSync: (_fd, s) => (stream += s) }
              : {},
        "n",
      );
      const start = api.startUtility();
      utility.emit("spawn");
      const pid = await start;
      api.quit();
      if (!ack && exitCode !== undefined) utility.emit("exit", exitCode);
      main.emit("exit");
      const receipt = launchReceipt(stream, "n", 17, pid);
      assert.deepEqual(receipt.utility, {
        pid: 43,
        acknowledged: ack,
        exitCode: exitCode ?? null,
        outcome,
      });
      assert.equal(receipt.healthy, outcome === "expected quit");
      assert.equal(launchReceipt(stream, "n", 17, 99).healthy, false);
      if (exitCode === undefined) assert.match(stream, /utility-missing 43/);
    }
});

test("broker cleanup retains intent-only, replaced and redirected stages before recursive deletion", (t) => {
  const dir = scratch(t);
  // Substitute only Win32 handle primitives. Run the real recursive walk and
  // directory disposition against the fixture tree.
  const bridge = read("windows/bridge.cs")
    .replace(
      /(public static SafeFileHandle CreateStage\(string path\) \{)[^]*?\n {2}\}/,
      "$1 Directory.CreateDirectory(path); return PinStage(path); }",
    )
    .replace(
      "public static extern bool CreateDirectoryW(string path, IntPtr security);",
      "public static bool CreateDirectoryW(string path, IntPtr security) { Directory.CreateDirectory(path); return true; }",
    )
    .replace(/ {2}\[DllImport[^\n]+\n( {2}public static bool CreateDirectoryW)/, "$1")
    .replace(
      /(static SafeFileHandle PinStage\(string path, bool readOwner\) \{)[^]*?\n {2}\}/,
      `$1
      var pin=new SafeFileHandle((IntPtr)(pins.Count+100),false); pins.Add(pin,path); return pin;
    }
    static System.Collections.Generic.Dictionary<SafeFileHandle,string> pins=new System.Collections.Generic.Dictionary<SafeFileHandle,string>();`,
    )
    .replace(
      /(static string PinnedOwner\(SafeFileHandle pin\) \{)[^]*?\n {2}\}/,
      '$1 return Path.GetFileName(pins[pin]) == "foreign-owner" ? "foreign" : "subject"; }',
    )
    .replace(
      /(public static string Identity\([^]*?\) \{)[^]*?\n {2}\}/,
      `$1
      string path; if(!pins.TryGetValue(handle,out path) || Path.GetFileName(path)==".w17-owner")return "marker";
      return directory ? path : File.ReadAllText(path);
    }`,
    )
    .replace(
      /(public static void DeletePinned\([^]*?\) \{)[^]*?\n {2}\}/,
      `$1
      string path=pins[handle];
      if(Path.GetFileName(path)=="sharing")throw new Win32Exception(32);
      if(Path.GetFileName(path)=="argument")throw new ArgumentException(new string('x',10000));
      if(Path.GetFileName(path)=="link-count")throw new IOException("Unexpected link count");
      if(Directory.Exists(path))Directory.Delete(path,false);else File.Delete(path);
    }`,
    );
  fs.writeFileSync(path.join(dir, "bridge.cs"), bridge);
  // Load the actual dispatch and unwind functions without the broker's Windows startup.
  run(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    $ErrorActionPreference='Stop'
    $ast=[ScriptBlock]::Create((Get-Content -Raw -LiteralPath $env:BROKER)).Ast
    foreach ($fn in $ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] }) { . ([ScriptBlock]::Create($fn.Extent.Text)) }
    function Protect-Stage($path,$sid,[switch]$Marker) {
      if ($Marker -and $path -ceq (Join-Path $j.stage '.w17-owner') -and $script:stageProtected) { throw 'fixture stop after stage receipt' }
      if ($path -cne $j.stage -or !$j.entries[0].data.created) { throw 'stage protected before receipt' }
      $script:stageProtected=$true
    }
    function Save {}
    function Account($role) {}

    Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:TEST_BRIDGE))
    $j=@{stage=(Join-Path $env:FIXTURE stage);entries=@();accounts=@{}}
    $foreign=Join-Path $env:FIXTURE foreign
    $null=New-Item -Type Directory -Path $foreign
    [IO.File]::WriteAllText((Join-Path $foreign 'keep'),'foreign bytes')
    $stage=$j.stage
    $null=New-Item -Type Directory -Path $stage
    [IO.File]::WriteAllText((Join-Path $stage 'keep'),'foreign bytes')
    $entry=Intent 'stage' @{path=$stage}
    function Refuses {
      $r=Dispatch @{op='cleanup'}
      if ($r.Count -ne 1 -or $r[0].restored -or $entry.done -or !(Test-Path -LiteralPath $stage)) {throw 'unowned stage deletion or false receipt'}
    }
    Refuses
    $j.entries=@()
    [IO.Directory]::Move($stage,(Join-Path $env:FIXTURE saved))
    try {Dispatch @{op='prepare'}; throw 'prepare should stop'} catch {if ($_.Exception.Message -ne 'fixture stop after stage receipt') {throw}}
    $entry=$j.entries[0]
    if (!$entry.data.created -or !$entry.data.birth -or !$entry.data.marker) {throw 'missing creation receipt'}
    $birth=$entry.data.birth
    $entry.data.birth='wrong'; Refuses; $entry.data.birth=$birth
    $marker=$entry.data.marker
    $entry.data.marker='wrong'; Refuses; $entry.data.marker=$marker
    $original=Join-Path $env:FIXTURE original
    [IO.Directory]::Move($stage,$original)
    $null=New-Item -ItemType SymbolicLink -Path $stage -Target $foreign
    Refuses
    if ([IO.File]::ReadAllText((Join-Path $foreign keep)) -ne 'foreign bytes') {throw 'modified foreign target'}
    [IO.Directory]::Delete($stage,$false); [IO.Directory]::Move($original,$stage)
    $entry.data.rootId='other'; Refuses; $entry.data.rootId=$stage
    $child=Join-Path $stage 'child'
    [IO.File]::WriteAllText($child,'created')
    Dispatch @{op='stage-created';items=@(@{path=$child;directory=$false;junction=$false})}
    [IO.File]::WriteAllText($child,'replaced')
    Refuses
    if ([IO.File]::ReadAllText($child) -ne 'replaced' -or !(Test-Path (Join-Path $stage '.w17-owner'))) {throw 'replacement or marker removed'}
    [IO.File]::WriteAllText($child,'created')
    $foreignChild=Join-Path $stage 'extra'
    [IO.File]::WriteAllText($foreignChild,'keep')
    Refuses
    if ((Test-Path $child) -or [IO.File]::ReadAllText($foreignChild) -ne 'keep' -or !(Test-Path (Join-Path $stage '.w17-owner'))) {throw 'incorrect partial cleanup'}
    [IO.File]::Delete($foreignChild)
    $homePath=Join-Path $stage 'subject-home'
    [IO.Directory]::CreateDirectory($homePath)
    Dispatch @{op='stage-created';items=@(@{path=$homePath;directory=$true;junction=$false})}
    $j.accounts.subject=@{home=$homePath;sid='subject'}
    $nested=Join-Path $homePath profile
    [IO.Directory]::CreateDirectory($nested)
    [IO.File]::WriteAllText((Join-Path $nested results),'subject output')
    $foreignOwner=Join-Path $homePath 'foreign-owner'
    [IO.File]::WriteAllText($foreignOwner,'foreign bytes')
    Refuses
    if ((Test-Path $nested) -or [IO.File]::ReadAllText($foreignOwner) -ne 'foreign bytes') {throw 'wrong home ownership decision'}
    [IO.File]::Delete($foreignOwner)
    $sharing=Join-Path $homePath 'sharing'
    $link=Join-Path $homePath 'link-count'
    [IO.Directory]::CreateDirectory($nested)
    $argument=Join-Path $nested argument
    [IO.File]::WriteAllText($argument,'fixture')
    $sibling=Join-Path $nested 'removable'
    foreach ($f in $sharing,$link,$sibling) { [IO.File]::WriteAllText($f,'fixture') }
    $r=Dispatch @{op='cleanup'}
    if ($r[0].restored -or !$r[0].error.Contains($sharing) -or !$r[0].error.Contains($link) -or (Test-Path $sibling)) {throw 'missing per-entry refusal or skipped sibling'}
    if ($entry.done -or !(Test-Path $nested) -or !(Test-Path $homePath) -or !(Test-Path (Join-Path $stage '.w17-owner'))) {throw 'missing pending ancestor or marker'}
    if (!$r[0].error.Contains($argument) -or $r[0].error.Length -gt 8300) {throw 'missing path or oversized refusal'}
    foreach ($f in $sharing,$link,$argument) { [IO.File]::Delete($f) }
    $r=Dispatch @{op='cleanup'}
    if (!$r[0].restored -or (Test-Path $stage)) {throw 'owned stage remained'}
  `,
    ],
    {
      env: {
        ...process.env,
        FIXTURE: dir,
        TEST_BRIDGE: path.join(dir, "bridge.cs"),
        BROKER: path.join(import.meta.dirname, "windows/broker.ps1"),
      },
    },
  );
});

test("workflow collision or replaced directory selects only the fresh outcome artifact", (t) => {
  for (const [platform, job] of Object.entries(workflow().jobs)) {
    for (const replaced of [false, true]) {
      const temp = scratch(t),
        bootstrap = job.steps.find((s) => s.id === "bootstrap"),
        outcomes = job.steps.find((s) => s.id === "outcomes"),
        upload = job.steps.find((s) => s.uses?.includes("upload-artifact"));
      const env = {
        ...process.env,
        ...workflow().env,
        PLATFORM: platform,
        RUNNER_TEMP: temp,
        GITHUB_ENV: path.join(temp, "env"),
        GITHUB_OUTPUT: path.join(temp, "output"),
        GITHUB_RUN_ID: "7",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_SHA: "fixture",
        CHECKOUT: "skipped",
      };
      const dir = path.join(temp, "w17-" + platform + "-7-1");
      for (const [key, value] of Object.entries({ OWNED_DIR: "dir", IDENTITY: "identity" }))
        assert.equal(outcomes.env[key], "${{ steps.bootstrap.outputs." + value + " }}");
      assert.equal(outcomes.env.BOOTSTRAP, "${{ steps.bootstrap.outcome }}");
      if (replaced) {
        run("bash", ["-ec", bootstrap.run], { env });
        const outputs = Object.fromEntries(
          fs
            .readFileSync(env.GITHUB_OUTPUT, "utf8")
            .trim()
            .split("\n")
            .map((l) => l.split("=")),
        );
        Object.assign(env, {
          OWNED_DIR: outputs.dir,
          W17_OUT: dir,
          IDENTITY: outputs.identity,
          BOOTSTRAP: "success",
        });
        fs.renameSync(dir, dir + "-original");
      }
      fs.mkdirSync(dir);
      for (const name of ["ledger.json", "build.exit", "observations.jsonl"])
        fs.writeFileSync(path.join(dir, name), "foreign");
      if (!replaced) {
        assert.notEqual(spawnSync("bash", ["-ec", bootstrap.run], { env }).status, 0);
        assert.equal(fs.existsSync(env.GITHUB_ENV), false);
        env.BOOTSTRAP = "failure";
      }
      env.GITHUB_OUTPUT = path.join(temp, "selection");
      run("bash", ["-ec", outcomes.run], { env });
      assert.equal(upload.with.path, "${{ steps.outcomes.outputs.files }}");
      const [start, file, end, ...rest] = fs
        .readFileSync(env.GITHUB_OUTPUT, "utf8")
        .trim()
        .split("\n");
      assert.deepEqual(
        [start, end, ...rest],
        ["files<<W17_FILES", "W17_FILES", "snapshot=" + path.dirname(file)],
      );
      assert.notEqual(path.dirname(file), dir);
      assert.equal(path.dirname(path.dirname(file)), temp);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ["observations.jsonl"]);
      const receipt = JSON.parse(fs.readFileSync(file));
      assert.equal(receipt.owned, false);
      assert.equal(receipt.bootstrap, env.BOOTSTRAP);
      assert.equal(receipt.checkout, "skipped");
      assert.equal(fs.readFileSync(path.join(dir, "observations.jsonl"), "utf8"), "foreign");
    }
  }
});

test("interrupted AppContainer creation retains dependent resources until the independent folder is absent", async (t) => {
  const { dir, note, records } = journal(t, "windows");
  const ctx = {
    stage: path.join(dir, "uncreated"),
    name: "W17.fixture",
    accounts: { subject: { sid: "S" } },
  };
  const before = {
    mapping: 2,
    query: 0x80070002,
    container: "S-1-15-2-11",
    token: { sid: "S" },
    folder: "",
    folderError: null,
    expectedFolder: "C:\\Users\\Subject\\AppData\\Local\\Packages\\W17.fixture",
    expectedFolderError: 3,
    knownFolderResult: 0,
  };
  let entries = [],
    current = before,
    cleared = 0,
    unrelated = 0;
  const rpc = (op, p) => {
    if (op === "state") return { entries };
    if (op === "intent") {
      entries.push({ data: p.data });
      return;
    }
    if (op === "container-gone") {
      cleared++;
      return;
    }
    if (op === "cleanup") {
      unrelated++;
      return [];
    }
    if (op === "count") return 0;
    return [];
  };
  const policy = caller("windows/network.mjs", "policy", {
    measure: noop,
    process,
    ctx,
    rpc,
    assert,
    containerAbsent: win.containerAbsent,
    sameFolder: win.sameFolder,
    native: ([action]) => {
      if (action === "container-create") throw Error("interrupted create");
      return current;
    },
  });
  await assert.rejects(policy("container"), /interrupted create/);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.before.expectedFolder, before.expectedFolder);
  assert.equal(entries[0].data.folder, undefined);
  const cleanup = caller("windows/probe.mjs", "cleanup", {
    ctx,
    rpc,
    assert,
    fs,
    note,
    recoverUtilities: noop,
    process,
    stopOwned: noop,
    containerAbsent: win.containerAbsent,
    sameFolder: win.sameFolder,
    native: () => current,
    safe: String,
  });
  for (const diff of [
    { expectedFolderError: 0 },
    { expectedFolderError: null },
    { expectedFolderError: 5 },
    { expectedFolder: "C:\\Other" },
  ]) {
    current = { ...before, ...diff };
    await assert.rejects(cleanup());
    assert.equal(cleared, 0);
  }
  assert.equal(unrelated, 4);
  assert.equal(records().filter((r) => r.kind === "profile reconciliation incomplete").length, 4);
  current = before;
  await cleanup();
  assert.equal(cleared, 1);
  entries = [];
  current = { ...before, expectedFolderError: 0 };
  await assert.rejects(policy("container"), /pre-creation absence/);
  assert.equal(entries.length, 0);
});

test("platform primitive entries and verdict summaries identify copied-tree scope", async (t) => {
  const reason =
    "copied run-owned trees only; installed-adapter acceptance must establish enforcement on real paths";
  for (const [platform, key, api] of [
    ["macos", "M3.realCheckout", mac],
    ["windows", "W2.realCheckout", win],
  ]) {
    const { dir, note, records } = journal(t, platform);
    const rows = platform === "macos" ? api.initialLedger() : api.initial();
    assert.equal(rows[key].status, "NOT RUN");
    const row = (k, status, detail) => note(k, { status, detail });
    // Stop at the first host operation. Neither entry can mutate the host.
    if (platform === "macos") {
      const primitive = caller("macos/probe.mjs", "primitives", {
        init: noop,
        row,
        checkoutScope: api.checkoutScope,
        command: () => {
          throw Error("fixture end");
        },
      });
      await assert.rejects(primitive(), /fixture end/);
    } else {
      const entry = read("windows/probe.mjs")
        .split("\ntry {\n  save();\n")[1]
        .split("  Object.assign(ctx,")[0];
      const entryPoint = compileFunction("return async()=>{" + entry + "}", [
        "phase",
        "row",
        "checkoutScope",
        "startBroker",
      ])("primitives", row, api.checkoutScope, () => {
        throw Error("fixture end");
      });
      await assert.rejects(entryPoint(), /fixture end/);
    }
    assert.deepEqual(records().find((r) => r.kind === key)?.data, {
      status: "NOT RUN",
      detail: platform === "macos" ? reason : { reason },
    });
    for (const k of Object.keys(rows)) if (k !== key) rows[k] = { status: "PASS" };
    // Even a ledger claiming an out-of-scope pass must keep that row in the CLI's missing list.
    fs.writeFileSync(
      path.join(dir, "ledger.json"),
      JSON.stringify({ ...rows, [key]: { status: "PASS" } }),
    );
    fs.writeFileSync(path.join(dir, "build.exit"), "0");
    const summary = path.join(dir, "summary");
    const v = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, platform, "verdict.mjs")],
      { env: { ...process.env, W17_OUT: dir, GITHUB_STEP_SUMMARY: summary } },
    );
    assert.equal(v.status, 1);
    const text = fs.readFileSync(summary, "utf8");
    assert.ok(text.includes(reason));
    assert.ok(text.includes(key));
    assert.ok(
      (platform === "macos"
        ? api.decide(rows).missing
        : api.decide(rows).candidates[0].missing
      ).includes(key),
    );
  }
});

// Exercise LF, bare CR, and mixed line endings with trailing whitespace.
// Check from a child process, using a single-line oracle independent of pwsh.
function devShellEnvironment(verifier = workflow().env.W17_PRIVATE_ACL) {
  const values = {
    W17_PRIVATE_ACL: verifier,
    W17_TEST_CR: "private-🪟\rvalue ",
    W17_TEST_MIXED: "private\r\n[unclosed=fixture\n",
  };
  return { ...values, W17_TEST_EXPECTED: JSON.stringify(values) };
}
const assertRestored = `node -e 'for (const [k,v] of Object.entries(JSON.parse(process.env.W17_TEST_EXPECTED))) if (process.env[k] !== v) throw Error(k)'
    if ($LASTEXITCODE) { throw 'restored environment mismatch' }`;
const devShellStub = `
  function Enter-VsDevShell($VsInstallPath,[switch]$SkipAutomaticLocation,$DevCmdArguments) {
    if ($DevCmdArguments -ne '-arch=x64 -host_arch=x64') { throw 'wrong architecture' }
    foreach ($value in [Environment]::GetEnvironmentVariables().Values) {
      if ($value -match '[\\r\\n]') { throw 'dev-shell received multiline value' }
    }
    foreach ($name in 'W17_PRIVATE_ACL','W17_TEST_CR','W17_TEST_MIXED') {
      if (Test-Path "Env:$name") { throw "variable still present: $name" }
    }
    if ($env:W17_TEST_THROW -eq '1') { throw 'fixture shell failure' }
  }
`;

test("hosted dev-shell restores verifier input even when initialization throws", () => {
  const setup = read("windows/run.ps1").match(
    /Import-Module [^\n]+\n([^]*?)\s+Push-Location \$out/,
  )[1];
  for (const fail of ["0", "1"]) {
    const output = run(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `
      $ErrorActionPreference='Stop'
      ${devShellStub}
      try { ${setup} }
      catch { if ($env:W17_TEST_THROW -ne '1' -or $_.Exception.Message -ne 'fixture shell failure') { throw }; $caught=$true }
      if ([bool]$caught -ne ($env:W17_TEST_THROW -eq '1')) { throw 'unexpected dev-shell outcome' }
      ${assertRestored}
    `,
      ],
      { env: { ...process.env, ...devShellEnvironment(), W17_TEST_THROW: fail } },
    );
    assert.match(output, /setting aside environment variable W17_PRIVATE_ACL/);
    assert.doesNotMatch(output, /DllImport|private-🪟|unclosed=fixture/);
  }
});

test("preflight workflow invokes only the bounded x64 compiler and disposable fixture and selects their logs", (t) => {
  const wf = parse(read("../../../.github/workflows/w17-preflight.yml"));
  assert.deepEqual(wf.on, { push: { branches: ["test/w17-preflight"] } });
  assert.deepEqual(Object.keys(wf.jobs), ["preflight"]);
  const job = wf.jobs.preflight;
  assert.equal(job.if, "github.run_number <= 7 && github.run_attempt == 1 && false");
  assert.equal(wf.env.W17_PRIVATE_ACL, workflow().env.W17_PRIVATE_ACL);
  assert.equal(job["runs-on"], "windows-2022");
  assert.ok(job["timeout-minutes"] <= 20);
  const [checkout, build, upload, ...extra] = job.steps;
  assert.deepEqual(extra, []);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.deepEqual(
    upload.with.path.trim().split("\n"),
    ["compiler", "preflight"].map((n) => "${{ steps.preflight.outputs.build }}/" + n + ".log"),
  );
  assert.equal(upload.if, "always() && steps.preflight.outputs.build != ''");
  const dir = scratch(t);
  // Run the raw payload's verifier subprocess path with a portable assertion
  // in front of the Windows-only body. Keep the entire multiline script as data.
  const verifier =
    assertRestored +
    "\n'raw verifier received exact environment'\nreturn\n" +
    wf.env.W17_PRIVATE_ACL;
  const rawEntry = path.join(dir, "preflight-raw.ps1");
  const verify = read("windows/preflight-raw.ps1").match(
    /^function Check\([^]*?(?=^function Test-RawAcl)/m,
  )[0];
  fs.writeFileSync(
    rawEntry,
    `param($Build)
$ErrorActionPreference='Stop'
$log=Join-Path $Build preflight.log
${verify}
Verify-Private '1'
`,
  );
  const fixture = `
    function Import-Module {}
    ${devShellStub}
    function cl.exe { if (($args -join ' ') -notmatch '/LD .*controller.cpp .*tree-acl.cpp /link /MACHINE:X64') {throw 'wrong compiler command'}; $global:LASTEXITCODE=0; 'compiler fixture' }
    function npm.cmd { $global:LASTEXITCODE=0 }
    function pwsh {
      if ($args[2] -like '*/preflight-raw.ps1' -and $args[3] -eq '-Build' -and $args[4] -eq $pwd.Path) {
        & (Get-Process -Id $PID).Path -NoProfile -File $env:W17_TEST_RAW -Build $args[4]
        if ($LASTEXITCODE) { throw 'raw verifier fixture failed' }
        Add-Content preflight.log 'raw fixture'
      } else {
        if ($args[2] -notlike '*/preflight.ps1' -or $args[3] -ne '-ControllerDll' -or $args[4] -ne "$pwd/controller.dll") { throw 'wrong preflight' }
        Add-Content preflight.log 'preflight fixture'
      }
      $global:LASTEXITCODE=0
    }
  `;
  // Only substitute the OS-specific VS discovery executable.
  const script = build.run.replace(
    /^\s*\$vs=& \$vswhere .*$/m,
    "\n    $vs='fixture'; $global:LASTEXITCODE=0",
  );
  assert.match(build.run, /vswhere -latest .*VC.Tools.x86.x64/);
  run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", fixture + script], {
    env: {
      ...process.env,
      ...devShellEnvironment(verifier),
      W17_TEST_RAW: rawEntry,
      GITHUB_OUTPUT: path.join(dir, "output"),
      CHECKOUT: "success",
      GITHUB_WORKSPACE: process.cwd(),
      TMPDIR: dir,
      TMP: dir,
      TEMP: dir,
    },
  });
  const out = fs.readFileSync(path.join(dir, "output"), "utf8").trim().slice(6);
  assert.equal(path.dirname(out), dir);
  assert.deepEqual(fs.readdirSync(out).sort(), ["compiler.log", "preflight.log"]);
  const log = fs.readFileSync(path.join(out, "preflight.log"), "utf8");
  assert.match(log, /preflight fixture/);
  assert.match(log, /^raw fixture$/m);
  assert.match(log, /^raw verifier received exact environment$/m);
  for (const name of ["W17_PRIVATE_ACL", "W17_TEST_CR", "W17_TEST_MIXED"])
    assert.ok(log.includes("setting aside environment variable " + name));
  assert.doesNotMatch(log, /DllImport|private-🪟|unclosed=fixture/);
  // Exercise the script with a DLL at the actual workflow-selected location.
  const failed = preflightFixture(out, 23, false, 13);
  assert.equal(failed.status, 23, failed.stderr);
  const retained = fs.readFileSync(path.join(out, "preflight.log"), "utf8");
  const rows = retained.match(/^fixture trace .*$/gm);
  assert.deepEqual(
    rows,
    ["snapshot", "apply", "restore"].flatMap((phase) =>
      Array.from({ length: 7 }, (_, i) => `fixture trace ${phase} ${i}`),
    ),
  );
  assert.match(retained, /apply rc=13 elapsedMs=\d+ verified=0/);
  assert.match(retained, /restore rc=23 elapsedMs=\d+ verified=4/);
  assert.match(retained, /cleanup removed scratch=/);
});

test("Windows broker streams listener evidence before another RPC and preserves the bind exception", (t) => {
  const dir = scratch(t);
  const root = dir;
  for (const name of ["evidence.mjs", "diagnostics.mjs"])
    fs.copyFileSync(new URL(name, import.meta.url), path.join(root, name));
  const work = path.join(root, "windows");
  fs.mkdirSync(work);
  for (const file of ["context.mjs", "verdict.mjs"])
    fs.copyFileSync(new URL("windows/" + file, import.meta.url), path.join(work, file));
  const pwsh = run("pwsh", ["-NoProfile", "-Command", "(Get-Process -Id $PID).Path"]).trim();
  if (process.platform !== "win32")
    fs.writeFileSync(path.join(work, "pwsh.exe"), '#!/bin/sh\nexec pwsh "$@"\n', { mode: 0o700 });
  fs.writeFileSync(
    path.join(work, "broker.ps1"),
    `
    $ErrorActionPreference='Stop'
    $receivers=@{}
    $source=[ScriptBlock]::Create((Get-Content -Raw -LiteralPath $env:BROKER)).Ast
    $dispatch=$source.EndBlock.Statements | Where-Object Name -eq 'Dispatch'
    . ([ScriptBlock]::Create($dispatch.Extent.Text))
    Add-Type 'public class ProbeReceiver {public ProbeReceiver(string host,string protocol,string label,bool reserve){var error=new System.Net.Sockets.SocketException(10049);error.Data["operation"]="bind";throw error;}}'
    [Console]::WriteLine('{"kind":"listener","data":{"event":"accept","pid":17,"port":42}}')
    while ($null -ne ($line=[Console]::ReadLine())) {
      $p=$line|ConvertFrom-Json -AsHashtable
      $result=Dispatch $p
      [Console]::WriteLine((ConvertTo-Json -Compress @{ok=$true;value=$result}))
    }
  `,
  );
  const sub = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import {startBroker,rpc,closeBroker,timed} from './context.mjs';
    startBroker();
    try {
      const start=performance.now();
      await timed(()=>fs.existsSync('observations.jsonl'),3000);
      console.log('Listener observation wait '+(performance.now()-start).toFixed(1)+' ms');
      const event=JSON.parse(fs.readFileSync('observations.jsonl'));
      assert.equal(event.kind,'listener');
      assert.deepEqual(event.data,{event:'accept',pid:17,port:42});
      const failure=await rpc('receiver',{label:'routed6.tcp',host:'2001:db8::1',protocol:'tcp'});
      assert.equal(failure.operation,'bind'); assert.equal(failure.wsa,Number(process.env.EXPECTED));
      assert.equal(failure.port,null);
    } finally { await closeBroker(); }
  `;
  const expected = run("pwsh", [
    "-NoProfile",
    "-Command",
    "[Net.Sockets.SocketException]::new(10049).NativeErrorCode",
  ]).trim();
  const timing = run(
    process.execPath,
    ["--input-type=module", "-e", sub, "fixture", "primitives"],
    {
      cwd: work,
      env: {
        ...process.env,
        W17_OUT: work,
        W17_PWSH: process.platform === "win32" ? pwsh : path.join(work, "pwsh.exe"),
        BROKER: path.join(import.meta.dirname, "windows/broker.ps1"),
        EXPECTED: expected,
      },
    },
  );
  t.diagnostic(timing.trim());
});

test("A5 preflight preserves checkout, setup exits and measurements before restore failure", (t) => {
  const dir = scratch(t);
  const build = parse(read("../../../.github/workflows/w17-preflight.yml")).jobs.preflight.steps[1];
  for (const stage of ["checkout", "compile", "dependency"]) {
    const checkout = stage === "checkout" ? "failure" : "success";
    const output = path.join(dir, stage);
    const script = build.run.replace(
      /^\s*\$vs=& \$vswhere .*$/m,
      "\n$vs='fixture'; $global:LASTEXITCODE=0",
    );
    const r = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-Command",
        `
      function Import-Module {}
      ${devShellStub}
      function cl.exe { & node -e "console.error('fixture compiler diagnostic'); process.exit(${stage === "compile" ? 23 : 0})"; $global:LASTEXITCODE=$LASTEXITCODE }
      function pwsh { if ($args[2] -like '*/preflight-raw.ps1') { 'raw-dacl diagnostic'; $global:LASTEXITCODE=41 } else { 'fixture diagnostic'; $global:LASTEXITCODE=39 } }
      function npm.cmd {'PRIVATE SETUP OUTPUT'; 1..40 | ForEach-Object { "npm line $_" }; $global:LASTEXITCODE=37}
    ` + script,
      ],
      {
        cwd: dir,
        env: {
          ...process.env,
          TMPDIR: dir,
          TEMP: dir,
          TMP: dir,
          ...devShellEnvironment(),
          GITHUB_OUTPUT: output,
          CHECKOUT: checkout,
          GITHUB_WORKSPACE:
            checkout === "success" ? process.cwd() : path.join(dir, "missing-workspace"),
        },
      },
    );
    assert.equal(r.status, { checkout: 1, compile: 23, dependency: 37 }[stage]);
    const dest = fs.readFileSync(output, "utf8").trim().slice(6);
    const log = fs.readFileSync(path.join(dest, "preflight.log"), "utf8");
    assert.match(log, new RegExp("checkout=" + checkout));
    assert.match(log, /restore : not attempted yet/);
    assert.ok(!log.includes("PRIVATE SETUP OUTPUT"));
    if (stage === "compile") {
      assert.match(
        fs.readFileSync(path.join(dest, "compiler.log"), "utf8"),
        /fixture compiler diagnostic\r?\ncompile exit=23 elapsedMs=\d+/,
      );
    }
    if (stage === "dependency") {
      assert.match(log, /npm line 1\r?\n/);
      assert.match(log, /npm line 40\r?\ndependency exit=37/);
      assert.match(log, /dependency exit=37 elapsedMs=\d+/);
      assert.match(log, /fixture diagnostic\r?\nfixture exit=39/);
      assert.match(log, /raw-dacl diagnostic\r?\nraw-dacl exit=41/);
      assert.match(
        fs.readFileSync(path.join(dest, "compiler.log"), "utf8"),
        /compile exit=0 elapsedMs=\d+/,
      );
    }
  }
  assert.equal(build["working-directory"], "${{ runner.temp }}");
  const r = preflightFixture(dir, 23);
  assert.equal(r.status, 23, r.stderr);
  const log = fs.readFileSync(path.join(dir, "preflight.log"), "utf8");
  assert.match(log, /cleanup removed scratch=/);
  for (const [name, code, data] of [
    ["descriptor", 0, "desktop=descriptor"],
    ["snapshot", 0, "objects=7"],
    ["apply", 0, "verified=7"],
    ["restore", 23, "verified=4"],
  ])
    assert.match(log, new RegExp(name + " rc=" + code + " elapsedMs=\\d+ " + data));
});

// Exercise the production script on a real temp tree with the Windows APIs substituted.
function preflightFixture(dir, restoreExit, extra = false, applyExit = 0) {
  fs.writeFileSync(path.join(dir, "controller.dll"), "fixture");
  const script = read("windows/preflight.ps1")
    .replace(/^param\(.*$/m, "$ControllerDll=$env:FIXTURE_DLL")
    .replace(/^Add-Type -TypeDefinition .*$/m, "")
    .replace(/\$repo = \(Resolve-Path .*$/m, "$repo=$pwd")
    .replace(
      /try \{\n\s*\$null=\[Security.Principal.SecurityIdentifier\][^]*?IdentityNotMappedException\] \{ \}/,
      "",
    );
  return spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      `
    Add-Type @'
using System;
using System.IO;
using System.Text;
public class W17 {
  public class Pin:IDisposable { public string path; public void Dispose(){} }
  public static Pin PinStage(string path) => new Pin {path=path};
  public static string Identity(Pin pin,bool dir) => pin.path;
  public static void DeletePinned(Pin pin) {
    if(Directory.Exists(pin.path))Directory.Delete(pin.path,false);else File.Delete(pin.path);
  }
  public static bool CreateDirectoryW(string p,IntPtr s){ Directory.CreateDirectory(p);return true;}
  public static int DesktopRead(int i,StringBuilder b,int n){b.Append("descriptor");return 0;}
  static void Trace(string log,string phase,uint count){
    for(uint i=0;i<count;++i) File.AppendAllText(log,"fixture trace "+phase+" "+i+Environment.NewLine);
  }
  public static int TreeSaveTrace(string root,string manifest,ref uint count,string log){
    count=7; Trace(log,"snapshot",count);
    ${extra ? 'File.WriteAllText(Path.Combine(root,"dependency","foreign"),"keep");' : ""}
    return 0;
  }
  public static int TreeChangeTrace(string m,uint c,string sid,int restore,ref uint verified,string log){
    Trace(log,restore==1 ? "restore":"apply",c);
    verified=restore==1 && ${restoreExit}!=0 ? 4u:7u;
    if(restore==0 && ${applyExit}!=0) verified=0;
    return restore==0 ? ${applyExit} : ${restoreExit};
  }
}
'@
  ` + script,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FIXTURE_DLL: path.join(dir, "controller.dll"),
        TMPDIR: dir,
        TEMP: dir,
        TMP: dir,
      },
    },
  );
}
// Compile the production comparison and trace formatter without the NTFS adapter.
test("DACL trace distinguishes request flags, foreign edits, setter errors and readback failures", (t) => {
  const dir = scratch(t);
  const cpp = read("windows/tree-acl.cpp");
  const logic = cpp.slice(cpp.indexOf("wstring persistedSddl("), cpp.indexOf("void appendTrace("));
  const transaction = cpp.match(/^DWORD setAndVerify\([^]*?^\}/m)[0];
  assert.match(
    cpp,
    /auto original = dacl\(file.handle\);[^]*?if \(before != expectedBefore\)\s+return ERROR_REVISION_MISMATCH;[^]*?buildDescriptor\(original.data\(\), acl, rollback\);\s+return setAndVerify\(file.handle, sd, rollback,/,
  );
  const snapshot = cpp.slice(
    cpp.indexOf("struct DescriptorOutput"),
    cpp.indexOf("DWORD setAndVerifyLabel"),
  );
  const labelAces = cpp.match(/^auto labelAces\([^]*?^\}/m)[0];
  const labelTransaction = cpp.match(/^DWORD setAndVerifyLabel\([^]*?^\}/m)[0];
  assert.match(
    cpp,
    /File file\(path, FILE_READ_ATTRIBUTES \| READ_CONTROL \| WRITE_OWNER\);\s+verifyFile\(file, entry\);[^]*?initial\.read\(file.handle, labelOut, \{beforeDacl, capacity\}\);[^]*?const auto before = journalLabel\(initial.labelSd.data\(\)\);\s+if \(before != expectedBefore\)\s+return ERROR_REVISION_MISMATCH;/,
  );
  const query = cpp.match(/^std::vector<BYTE> queryDescriptor\([^]*?^\}/m)[0];
  const raw = cpp.match(/^std::vector<BYTE> dacl\([^]*?^\}/m)[0];
  const before = cpp.match(/^void readBefore\([^]*?^\}/m)[0];
  const json = read("windows/token.hpp").match(/^inline wstring jsonString\([^]*?^\}/m)[0];
  const source = path.join(dir, "trace.cpp");
  const exe = path.join(dir, process.platform === "win32" ? "trace.exe" : "trace");
  fs.writeFileSync(
    source,
    String.raw`
#include <cassert>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
using std::wstring;
using DWORD = uint32_t;
constexpr DWORD ERROR_INVALID_ACL=1336, ERROR_REVISION_MISMATCH=1306, ERROR_INVALID_DATA=13;
struct Entry { wstring path; };
${json}
${logic}
using BYTE = uint8_t;
using ULONG = uint32_t;
using HANDLE = int;
using NTSTATUS = int32_t;
constexpr DWORD DACL_SECURITY_INFORMATION=4, ERROR_INVALID_SECURITY_DESCR=1338;
constexpr DWORD LABEL_SECURITY_INFORMATION=16, SACL_SECURITY_INFORMATION=8, labelSections=24;
wstring currentLabel=L"S:";
bool failLabelRead=false;
BYTE daclByte=7;
bool queryFails=false;
int queryCount=0, diagnosticCount=0;
NTSTATUS NtQuerySecurityObject(HANDLE h, DWORD info, BYTE *out, ULONG cap, ULONG *used) {
  assert(h==42 && cap>=2);
  if (info==LABEL_SECURITY_INFORMATION) {
    if (failLabelRead) { failLabelRead=false; return -1; }
    out[0]=currentLabel==L"S:" ? 0 : currentLabel==L"wrong" ? 2 : 1;
    *used=1; return 0;
  }
  assert(info==DACL_SECURITY_INFORMATION);
  ++queryCount;
  if (queryFails) return -1;
  out[0]=daclByte; out[1]=8; *used=2; return 0;
}
DWORD RtlNtStatusToDosError(NTSTATUS status) { assert(status==-1); return 5; }
${query}
${raw}
wstring current = L"D:AI(A;ID;FA;;;BA)";
wstring sddl(BYTE *p) { assert(p[0]==7 && p[1]==8); return current; }
using SECURITY_DESCRIPTOR = wstring;
constexpr DWORD ERROR_INSUFFICIENT_BUFFER=122, APPLICATION_ERROR_MASK=0x20000000, ERROR_READ_FAULT=30, ERROR_SUCCESS=0;
using PSECURITY_DESCRIPTOR = SECURITY_DESCRIPTOR *;
wstring labelAces(BYTE *p) { return *p==0 ? L"S:" : *p==2 ? L"wrong" : L"S:(ML;OICI;NW;;;LW)"; }
wstring labelAces(SECURITY_DESCRIPTOR *p) { return *p; }
wstring sddl(BYTE *p,DWORD section) { return section==labelSections ? labelAces(p) : current; }
wstring labelString(BYTE *,DWORD section) { assert(section==SACL_SECURITY_INFORMATION); return L"S:"; }
${snapshot}
namespace aceFixture {
using BOOL=bool;
struct ACE_HEADER { BYTE AceType, AceFlags; uint16_t AceSize; };
struct Ace { ACE_HEADER header; DWORD mask; BYTE sid[12]; };
struct Acl { uint16_t AceCount; Ace entries[2]; };
using PACL=Acl *;
using PSECURITY_DESCRIPTOR=Acl *;
bool GetSecurityDescriptorSacl(Acl *sd,BOOL *present,PACL *acl,BOOL *defaulted) {
  *present=true; *acl=sd; *defaulted=false; return true;
}
bool GetAce(PACL acl,DWORD index,void **out) { *out=&acl->entries[index]; return true; }
void check(bool ok) { assert(ok); }
${labelAces}
void verify() {
  Acl requested{1,{{{17,3,sizeof(Ace)},1,{1,1,0,0,0,0,0,16,0,16,0,0}}}};
  auto expected=labelAces(&requested);
  auto actual=requested;
  assert(labelAces(&actual)==expected);
  ++actual.entries[0].header.AceType; assert(labelAces(&actual)!=expected); actual=requested;
  --actual.entries[0].header.AceFlags; assert(labelAces(&actual)!=expected); actual=requested;
  ++actual.entries[0].mask; assert(labelAces(&actual)!=expected); actual=requested;
  ++actual.entries[0].sid[9]; assert(labelAces(&actual)!=expected); actual=requested;
  actual.AceCount=2; assert(labelAces(&actual)!=expected);
  actual.AceCount=0; assert(labelAces(&actual).empty() && labelAces(&actual)!=expected);
}
}
enum class Damage { None, Label, Dacl, Restore, Set };
Damage damage=Damage::None;
int writes=0, labelWrites=0;
NTSTATUS NtSetSecurityObject(HANDLE h,DWORD info,SECURITY_DESCRIPTOR *value) {
  assert(h==42);
  if (info==LABEL_SECURITY_INFORMATION) {
    ++labelWrites;
    if (damage==Damage::Set || (damage==Damage::Restore && *value==L"S:")) return -1;
    currentLabel = *value;
    if (*value!=L"S:") {
      if (damage==Damage::Label || damage==Damage::Restore) currentLabel=L"wrong";
      if (damage==Damage::Dacl) ++daclByte;
    }
    return 0;
  }
  assert(info==4);
  ++writes;
  current=*value;
  return 0;
}
${transaction}
${labelTransaction}
wstring directoryView(HANDLE h) {
  assert(h==42); ++diagnosticCount; return L"D:P(A;;FA;;;BA)";
}
${before}
int main() {
  aceFixture::verify();
  assert(dacl(42).size()==2);
  Observation file;
  readBefore(42,false,file);
  assert(file.getSecurityInfoBefore==L"-" && diagnosticCount==0);
  queryFails=true;
  try { readBefore(42,true,file); assert(false); } catch (DWORD rc) { assert(rc==5); }
  assert(diagnosticCount==0);
  queryFails=false;
  const wstring aces=L"(D;OICI;FR;;;WD)(A;ID;FA;;;BA)";
  assert(persistedSddl(L"D:PARAI"+aces)==L"D:PAI"+aces);
  assert(persistedSddl(L"D:AR")==L"D:");
  assert(persistedSddl(L"D:AI"+aces)==L"D:AI"+aces);
  assert(persistedSddl(L"D:(XA;;;;;WD;(Title == \"AR\"))")==L"D:(XA;;;;;WD;(Title == \"AR\"))");
  Observation o;
  o.snapshot=L"D:AI(A;ID;FA;;;BA)";
  readBefore(42,true,o);
  assert(queryCount==4 && diagnosticCount==1);
  assert(o.before==o.snapshot && o.observed==o.before);
  o.expectedBefore=o.snapshot;
  o.expected=L"D:AI"+aces;
  o.observed=o.expected;
  auto emit=[&](auto action) {
    DWORD rc=0;
    try { action(); } catch (DWORD error) { rc=error; }
    std::wcout << o.line(L"apply", 0, Entry{L"test fixture"}, rc);
  };
  emit([&]{ o.requireDacl(false); });
  o.before=L"D:(A;;FA;;;WD)";
  emit([&]{ o.requireBefore(); });
  o.before=o.snapshot;
  emit([&]{ o.requireDacl(true); o.requireBefore(); o.setRc=L"1336"; o.verifyAfter(1336); });
  o.setRc=L"0";
  o.observed=L"D:"+aces;
  emit([&]{ o.verifyAfter(0); });
  o.observed=o.expected;
  emit([&]{ o.verifyAfter(0); });
  wchar_t observed[100]{};
  wstring rollback=L"D:AI", landed=L"D:PAI";
  assert(setAndVerify(42,landed,rollback,L"D:P",rollback,observed,100)==ERROR_INVALID_DATA);
  assert(current==rollback && wstring(observed)==landed && writes==2);
  assert(setAndVerify(42,landed,rollback,L"D:P",L"unrestored",observed,100)==0x20000001);
  assert(writes==4);
  assert(setAndVerify(42,landed,rollback,landed,rollback,observed,100)==ERROR_SUCCESS && writes==5);
  wstring low=L"S:(ML;OICI;NW;;;LW)", absent=L"S:";
  wchar_t observedLabel[100]{}, observedDacl[100]{}, beforeDacl[100]{};
  LabelSnapshot initial;
  assert(initial.read(42,{observedLabel,100},{beforeDacl,100})==0);
  assert(wstring(beforeDacl)==L"0708|"+current);
  auto writeLabel=[&](wstring &request,wstring &original) {
    *observedLabel=*observedDacl=0;
    return setAndVerifyLabel(42,&request,&original,initial.daclSd,{observedLabel,100},{observedDacl,100});
  };
  assert(writeLabel(low,absent)==0 && currentLabel==low);
  assert(wstring(observedLabel)==L"01|"+low+L" legacyLabel=S:" && wstring(observedDacl)==beforeDacl);
  assert(writeLabel(absent,low)==0 && currentLabel==absent);
  damage=Damage::Label;
  assert(writeLabel(low,absent)==ERROR_INVALID_DATA && currentLabel==absent);
  assert(wstring(observedLabel)==L"02|wrong legacyLabel=S:" && wstring(observedDacl)==beforeDacl);
  damage=Damage::Restore;
  assert(writeLabel(low,absent)==0x20000001);
  damage=Damage::Dacl;
  currentLabel=absent;
  assert(writeLabel(low,absent)==0x20000001 && currentLabel==absent);
  assert(wstring(observedDacl)==L"0808|"+current && wstring(observedLabel)==L"01|"+low+L" legacyLabel=S:");
  assert(labelWrites==8 && writes==5);
  damage=Damage::Set; daclByte=7;
  assert(writeLabel(low,absent)==5 && currentLabel==absent);
  assert(wstring(observedLabel)==L"00|S: legacyLabel=S:" && wstring(observedDacl)==beforeDacl);
  damage=Damage::None; daclByte=7; failLabelRead=true;
  assert(writeLabel(low,absent)==5 && currentLabel==absent && !*observedLabel && wstring(observedDacl)==beforeDacl);
}
`,
  );
  run("clang++", ["-std=c++17", source, "-o", exe], { cwd: dir });
  const rows = run(exe, [])
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const m =
        /^dacl phase=apply index=0 site=(\S+) rc=(\d+) setRc=(\S+) path="test fixture" request=- snapshot=(\S+) expected=(\S+) expectedBefore=(\S+) before=(\S+) observed=(\S+) getSecurityInfoBefore=(\S+)$/.exec(
          line,
        );
      assert.ok(m, line);
      return m.slice(1);
    });
  assert.deepEqual(
    rows.map((r) => r.slice(0, 3)),
    [
      ["null-dacl", "1336", "not-called"],
      ["before-conflict", "1306", "not-called"],
      ["set", "1336", "1336"],
      ["post-mismatch", "13", "0"],
      ["verified", "0", "0"],
    ],
  );
  assert.notEqual(rows[1][5], rows[1][6]); // expectedBefore vs before
  assert.notEqual(rows[3][4], rows[3][7]); // expected vs observed, AI differs
  assert.equal(rows[4][4], rows[4][7]);
  assert.equal(rows[4][8], "D:P(A;;FA;;;BA)");
  assert.notEqual(rows[4][6], rows[4][8]);
});

test("failed apply still attempts restore and identity-bound cleanup, retaining each result", (t) => {
  const dir = scratch(t);
  const r = preflightFixture(dir, 0, false, 13);
  assert.equal(r.status, 13, r.stderr);
  const log = fs.readFileSync(path.join(dir, "preflight.log"), "utf8");
  assert.match(log, /apply rc=13 elapsedMs=\d+ verified=0/);
  assert.match(log, /restore rc=0 elapsedMs=\d+ verified=7/);
  assert.match(log, /cleanup removed scratch=/);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith("w17-preflight-")),
    false,
  );
});

test("C1 preflight leaves an unexpected child and records its nonempty directory", (t) => {
  const dir = scratch(t);
  const r = preflightFixture(dir, 0, true);
  assert.equal(r.status, 1, r.stderr);
  const stage = fs.readdirSync(dir).find((n) => n.startsWith("w17-preflight-"));
  assert.equal(
    fs.readFileSync(path.join(dir, stage, "sentinels/dependency/foreign"), "utf8"),
    "keep",
  );
  for (const label of ["checkout", "worktree", "dependency"])
    assert.equal(fs.existsSync(path.join(dir, stage, "sentinels", label, "package.json")), false);
  assert.match(
    fs.readFileSync(path.join(dir, "preflight.log"), "utf8"),
    /cleanup retained child=.*foreign/,
  );
  assert.equal(fs.existsSync(path.join(dir, stage, "snapshot.dacl")), false);
  assert.match(
    fs.readFileSync(path.join(dir, "preflight.log"), "utf8"),
    /cleanup pending path=.*dependency/,
  );
});

test("A1 broker joins an in-flight receive and journals its final stdout after input failure", async (t) => {
  const { dir, note, records } = journal(t, "windows");
  // The socket substitute releases one completed datagram on disposal. The
  // production receiver thread, serializer, broker epilogue and Node reader run.
  const source =
    read("windows/receivers.cs").replace(
      "using System.Net.Sockets;",
      "using System.Net.Sockets;\nusing Socket = FixtureSocket;",
    ) +
    `
public sealed class FixtureSocket : IDisposable {
  public static ManualResetEvent entered = new ManualResetEvent(false);
  readonly ManualResetEvent closed = new ManualResetEvent(false);
  public FixtureSocket(AddressFamily a,SocketType t,ProtocolType p){}
  public EndPoint LocalEndPoint {get {if(closed.WaitOne(0))throw new ObjectDisposedException("receiver"); return new IPEndPoint(IPAddress.Loopback,42);}}
  public AddressFamily AddressFamily => AddressFamily.InterNetwork;
  public EndPoint RemoteEndPoint => LocalEndPoint;
  public int ReceiveTimeout {get;set;} public int SendTimeout {get;set;}
  public void Bind(EndPoint e){} public void Listen(int n){}
  public FixtureSocket Accept()=>throw new NotSupportedException();
  public int Receive(byte[] b,int s,int n,SocketFlags f)=>0;
  public int Send(byte[] b,int s,int n,SocketFlags f)=>n;
  public int ReceiveFrom(byte[] b,ref EndPoint e){
    entered.Set();closed.WaitOne();e=new IPEndPoint(IPAddress.Loopback,19);
    byte[] data=Encoding.ASCII.GetBytes("954c1495-362e-4086-a1e9-aaba37ec12d7"); data.CopyTo(b,0);return data.Length;
  }
  public void SendTo(byte[] b,EndPoint p){}
  public void Dispose(){closed.Set();}
}`;
  fs.writeFileSync(path.join(dir, "receivers.cs"), source);
  const epilogue = read("windows/broker.ps1").slice(
    read("windows/broker.ps1").lastIndexOf("foreach ($secret"),
  );
  const broker = read("windows/broker.ps1");
  const shutdown = broker.includes("foreach ($receiver in $receivers.Values)")
    ? broker.slice(
        broker.indexOf("foreach ($receiver in $receivers.Values)"),
        broker.lastIndexOf("}"),
      )
    : epilogue;
  fs.writeFileSync(
    path.join(dir, "shutdown.ps1"),
    `
    $ErrorActionPreference='Stop'
    Add-Type -Path "$PSScriptRoot/receivers.cs"
    $receivers=@{test=[ProbeReceiver]::new('127.0.0.1','udp','test',$false)}
    $secrets=@{}
    if(![FixtureSocket]::entered.WaitOne(5000)){throw 'worker failed to enter receive'}
    $null=[Console]::ReadLine()
    ${shutdown}
  `,
  );
  const { spawn } = await import("node:child_process");
  const { PassThrough } = await import("node:stream");
  const { createInterface } = await import("node:readline");
  const child = spawn("pwsh", ["-NoProfile", "-File", path.join(dir, "shutdown.ps1")], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const body = read("windows/context.mjs")
    .split("let child, lines, stopError, brokerClosed;")[1]
    .split("export const intent")[0]
    .replaceAll("export ", "");
  const api = compileFunction(
    "let child,lines,stopError,brokerClosed;" + body + ";return {startBroker,closeBroker}",
    [
      "spawn",
      "src",
      "phase",
      "path",
      "note",
      "process",
      "createInterface",
      "PassThrough",
      "assert",
    ],
  )(
    () => child,
    dir,
    "fixture",
    path,
    note,
    { env: { W17_PWSH: "pwsh" } },
    createInterface,
    PassThrough,
    assert,
  );
  api.startBroker();
  child.stdin.emit("error", Error("fixture RPC input"));
  await assert.rejects(api.closeBroker(), /fixture RPC input/);
  assert.deepEqual(
    records().map((r) => [r.data.event, r.data.port]),
    [
      ["datagram", 42],
      ["receiver joined", 42],
      ["receiver shutdown complete", undefined],
    ],
  );
});

test("A2 checkpoints controller, reverse, mismatched batch and first W6 target before later failures", async (t) => {
  const { dir, note, records } = journal(t, "windows");
  const tuple = {
    protocol: "tcp",
    host: "127.0.0.1",
    port: 10,
    source: "127.0.0.1",
    localPort: 12,
    nonce: "fixture",
  };
  const flowResult = {
    pid: 19,
    ppid: 1,
    exe: "wrong.exe",
    code: "TIMEOUT",
    errno: -1,
    events: [{ event: "error", errno: -1, ms: 4 }],
    elapsed: 5,
  };
  const controller = caller("windows/network.mjs", "controller", {
    fresh: () => tuple,
    flow: () => flowResult,
    note,
    drain: () => {
      throw Error("lost drain");
    },
    safe: String,
  });
  assert.equal(await controller(tuple), false);
  assert.deepEqual(records().find((r) => r.kind === "controller flow").data.r, flowResult);
  const reverse = caller("windows/network.mjs", "reverse", {
    ownedFile: () => "",
    actor: () => ({ pid: 18 }),
    waitJSON: () => ({ pid: 18, port: 10 }),
    randomUUID: () => "nonce",
    flow: () => flowResult,
    note,
    assert,
  });
  await assert.rejects(reverse(false), /REPLY/);
  assert.equal(records().find((r) => r.kind === "reverse flow").data.r.errno, -1);
  const output = path.join(dir, "result");
  fs.writeFileSync(output, JSON.stringify([flowResult]));
  const checkpointActor = caller("windows/context.mjs", "checkpointActor", { note });
  const actor = caller("windows/context.mjs", "actor", {
    fs,
    ctx: { node: "node.exe" },
    ownedFile: () => output,
    plan: noop,
    launch: () => ({ pid: 18, wait: () => ({ wait: 0, exit: 0 }) }),
    assert,
    checkpointActor,
  });
  await assert.rejects(actor({ action: "batch", tasks: [tuple] }), /ancestry/);
  const batch = records().find((r) => r.kind === "staged flow results").data;
  assert.equal(batch.requestedPid, 18);
  assert.equal(batch.attempts[0].result.pid, 19);
  assert.deepEqual(batch.attempts[0].result.events, flowResult.events);
  const ctx = { controller: { pid: 1, birth: "2" }, broker: { pid: 3, birth: "4" } };
  const negatives = caller("windows/product.mjs", "negatives", {
    ctx,
    path,
    out: dir,
    assert,
    note,
    measure: async (key, f) => {
      if (key.endsWith(".resources")) await assert.rejects(f(), /bad second result/);
    },
    actor: (task) => {
      if (!task.targets.controller || task.targets.broker) throw Error("bad second result");
      return { memory: { controller: { ...task.targets.controller, targetPid: 1, error: 5 } } };
    },
  });
  await negatives("wfp");
  assert.deepEqual(
    records()
      .filter((r) => r.kind === "controller target access")
      .map((r) => [r.data.role, r.data.sample.memory.controller.error]),
    [
      ["subject", 5],
      ["other", 5],
    ],
  );
});

test("A3 always-run recovery retains only typed launch-bound markers after interruption", (t) => {
  for (const platform of ["macos", "windows"]) {
    const dir = scratch(t),
      file = path.join(dir, "private.stderr");
    fs.writeFileSync(file, "Debugger listening on ws://localhost:123/PRIVATE\n");
    fs.writeFileSync(path.join(dir, "observations.jsonl"), "");
    checkpointUtility(dir, "trial", file, "abc", 71);
    fs.appendFileSync(
      file,
      "W17 abc 71 1 utility-launch\nW17 abc 71 2 utility-spawn 73\nW17 abc 71 3 utility-ack 73\nW17 abc 71 4 utility-quit 73 0\nW17 abc 99 5 utility-abnormal 11 4\nW17 abc 71 6 utility-ack PRIVATE\nW17 abc 71 7 utility-missing 73",
    );
    // Drive each cleanup entry. Substitute the host ACL preamble on macOS
    // and the actual cleanup driver, which must see the receipt on entry.
    const probes = path.join(dir, "checkout", "tools", "ci", "w17-probes");
    const tree = path.join(probes, platform);
    fs.mkdirSync(tree, { recursive: true });
    for (const name of ["evidence.mjs", "diagnostics.mjs"])
      fs.copyFileSync(new URL(name, import.meta.url), path.join(probes, name));
    fs.writeFileSync(
      path.join(tree, "probe.mjs"),
      `import fs from "node:fs";
      if(!fs.readFileSync(process.env.W17_OUT+"/observations.jsonl","utf8").includes('"kind":"utility lifecycle"'))throw Error("cleanup started before marker recovery");`,
    );
    const script = platform === "macos" ? "run.sh" : "run.ps1";
    let wrapper = read(platform + "/" + script);
    if (platform === "windows") {
      wrapper = wrapper.replace(/\$expected = Join-Path[^]*?(?=\$recovery=0)/, "");
      wrapper = wrapper.replaceAll("$PSScriptRoot\\", "$PSScriptRoot/");
      fs.writeFileSync(path.join(tree, "phase-log.mjs"), "");
    }
    fs.writeFileSync(path.join(tree, script), wrapper);
    const recover = () =>
      run(
        platform === "macos" ? "bash" : "pwsh",
        platform === "macos"
          ? [path.join(tree, script), "cleanup"]
          : ["-NoProfile", "-File", path.join(tree, script), "-Phase", "cleanup"],
        { env: { ...process.env, W17_OUT: dir, W17_PRIVATE_ACL: "return" } },
      );
    recover();
    const obs = path.join(dir, "observations.jsonl");
    const receipts = fs.readFileSync(obs, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      receipts.map((r) => [r.data.mainPid, r.data.event, r.data.pid, r.data.exitCode]),
      [
        [71, "launch", null, null],
        [71, "spawn", 73, null],
        [71, "ack", 73, null],
        [71, "quit", 73, 0],
      ],
    );
    assert.doesNotMatch(fs.readFileSync(obs, "utf8"), /PRIVATE|orphan|ws:\/\//);
    fs.renameSync(file, file + ".old");
    fs.writeFileSync(file, "W17 abc 71 5 utility-abnormal 73 42\n");
    recover();
    assert.equal(
      JSON.parse(fs.readFileSync(obs, "utf8").trim().split("\n").at(-1)).kind,
      "utility capture refused",
    );
    assert.match(
      read(platform + "/product.mjs"),
      /checkpointUtility\([^;]+;\s*\w+ = await main.js\("w17.startUtility\(\)"\)/,
    );
  }
});

function hostedFixture(t, platform) {
  const temp = scratch(t),
    wf = workflow(),
    job = wf.jobs[platform];
  const env = {
    ...process.env,
    ...wf.env,
    PLATFORM: platform,
    RUNNER_TEMP: temp,
    GITHUB_ENV: path.join(temp, "env"),
    GITHUB_OUTPUT: path.join(temp, "outputs"),
    GITHUB_RUN_ID: "7",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "fixture",
    BOOTSTRAP: "success",
    CHECKOUT: "success",
    SETUP: "success",
    PRIMITIVES: "failure",
    BUILD: "failure",
    PACKAGE: "skipped",
    CLEANUP: "failure",
  };
  const props = (file) =>
    Object.fromEntries(
      fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  run("bash", ["-ec", job.steps.find((s) => s.id === "bootstrap").run], { env });
  Object.assign(env, props(env.GITHUB_ENV));
  const { dir, identity, observations } = props(env.GITHUB_OUTPUT);
  Object.assign(env, {
    OWNED_DIR: dir,
    IDENTITY: identity,
    OBS_ID: observations,
    GITHUB_OUTPUT: path.join(temp, "selected"),
  });
  run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {writeEvidence} from ${JSON.stringify(new URL("evidence.mjs", import.meta.url).href)};writeEvidence(process.env.W17_OUT,"ledger.json",'{"fixture":true}\\n');`,
    ],
    { env },
  );
  run(process.execPath, [path.join(import.meta.dirname, "evidence.mjs"), "build-exit", "37"], {
    env,
  });
  Object.assign(env, props(env.GITHUB_ENV));
  const select = () => {
    run("bash", ["-ec", job.steps.find((s) => s.id === "outcomes").run], { env });
    const lines = fs.readFileSync(env.GITHUB_OUTPUT, "utf8").trim().split("\n");
    const snapshot = lines.at(-1).slice("snapshot=".length);
    assert.deepEqual(
      lines.slice(1, -2).sort(),
      fs
        .readdirSync(snapshot)
        .map((n) => path.join(snapshot, n))
        .sort(),
    );
    return snapshot;
  };
  return { temp, env, dir, select };
}
test("A4 unusable observations produce a fresh refusal with actual steps and independent evidence", (t) => {
  for (const [platform, damage] of [
    ["macos", "missing"],
    ["windows", "hardlink"],
    ["macos", "redirected"],
    ["windows", "partial"],
  ]) {
    const { temp, dir, select } = hostedFixture(t, platform),
      file = path.join(dir, "observations.jsonl");
    if (damage === "missing") fs.unlinkSync(file);
    if (damage === "hardlink") fs.linkSync(file, path.join(temp, "second-name"));
    if (damage === "redirected") {
      fs.renameSync(file, file + ".original");
      fs.symlinkSync(file + ".original", file);
    }
    if (damage === "partial") fs.appendFileSync(file, '{"kind":"measured","data":7}\n{"cut":');
    const snapshot = select(),
      rows = fs
        .readFileSync(path.join(snapshot, "observations.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
    const last = rows.at(-1);
    assert.notEqual(snapshot, dir);
    assert.equal(last.kind, "step outcomes");
    assert.deepEqual(
      [last.checkout, last.setup, last.primitives, last.build, last.package, last.cleanup],
      ["success", "success", "failure", "failure", "skipped", "failure"],
    );
    assert.match(last.refusals.join(" "), /observations.jsonl/);
    assert.equal(rows.length, damage === "partial" ? 3 : 1);
    if (damage === "partial") assert.equal(rows[1].data, 7);
    assert.equal(fs.readFileSync(path.join(snapshot, "ledger.json"), "utf8"), '{"fixture":true}\n');
    assert.equal(fs.readFileSync(path.join(snapshot, "build.exit"), "utf8"), "37\n");
  }
});
test("C2 cleanup rejects a replacement before journal I/O and upload reads only the verified snapshot", (t) => {
  for (const platform of ["windows", "macos"]) {
    const { temp, dir, env, select } = hostedFixture(t, platform);
    fs.renameSync(dir, dir + ".owned");
    fs.mkdirSync(dir, { mode: 0o700 });
    const original = {
      "observations.jsonl": "foreign",
      "resources.json": '{"foreign":true}',
      "ledger.json": '{"foreign":true}',
    };
    for (const [name, bytes] of Object.entries(original))
      fs.writeFileSync(path.join(dir, name), bytes);
    const args =
      platform === "macos"
        ? ["bash", [path.join(import.meta.dirname, "macos/run.sh"), "cleanup"]]
        : [
            process.execPath,
            [path.join(import.meta.dirname, "windows/phase-log.mjs"), "cleanup", "failure", "7"],
          ];
    const r = spawnSync(...args, { env, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    for (const [name, bytes] of Object.entries(original))
      assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), bytes);
    assert.match(r.stderr, /differs from bootstrap/);
    fs.renameSync(dir, dir + ".foreign");
    fs.renameSync(dir + ".owned", dir);
    const ledger = path.join(dir, "ledger.json");
    fs.renameSync(ledger, ledger + ".old");
    fs.writeFileSync(ledger, "foreign ledger");
    const swap = path.join(temp, "swap.cjs");
    // Swap the pathname after open; the collector must read from that open fd.
    fs.writeFileSync(
      swap,
      `const fs=require("node:fs");const open=fs.openSync;fs.openSync=function(file,...args){const fd=open.call(this,file,...args);if(file===process.env.W17_SWAP){fs.renameSync(file,file+".old");fs.writeFileSync(file,"foreign after open");}return fd;};`,
    );
    env.NODE_OPTIONS = "--require=" + JSON.stringify(swap);
    env.W17_SWAP = path.join(dir, "build.exit");
    const snapshot = select();
    fs.writeFileSync(env.W17_SWAP, "another replacement");
    assert.notEqual(snapshot, dir);
    assert.deepEqual(fs.readdirSync(snapshot).sort(), ["build.exit", "observations.jsonl"]);
    assert.equal(fs.readFileSync(path.join(snapshot, "build.exit"), "utf8"), "37\n");
    assert.match(
      fs.readFileSync(path.join(snapshot, "observations.jsonl"), "utf8"),
      /ledger.json unverified/,
    );
  }
});
test("C3 intent alone cannot delete a present profile and confirmed cleanup requires the creation receipt", async (t) => {
  const { dir, note, records } = journal(t, "windows");
  const folder = "C:\\Users\\test\\AppData\\Local\\Packages\\W17.fixture",
    name = "W17.fixture",
    sid = "S-1-15-2-1",
    owner = "S";
  const before = {
    mapping: 2,
    query: 0x80070002,
    container: sid,
    token: { sid: owner },
    folder: "",
    expectedFolder: folder,
    knownFolderResult: 0,
    expectedFolderError: 3,
  };
  const present = {
    ...before,
    mapping: 0,
    query: 0,
    folder,
    folderError: 0,
    expectedFolderError: 0,
    folderId: "4/7",
  };
  let current = present,
    deleted = 0,
    cleared = 0;
  const data = { name, sid, owner, before };
  const cleanup = caller("windows/probe.mjs", "cleanup", {
    ctx: { name, stage: path.join(dir, "stage"), accounts: { subject: { sid: owner } } },
    rpc: (op) => {
      if (op === "state") return { entries: [{ data }] };
      if (op === "container-gone") cleared++;
      if (op === "count") return 0;
      return [];
    },
    fs,
    process,
    assert,
    note,
    recoverUtilities: noop,
    stopOwned: noop,
    safe: String,
    containerAbsent: win.containerAbsent,
    sameFolder: win.sameFolder,
    native: (args) => {
      if (args[0] === "container-delete") {
        deleted++;
        assert.deepEqual(args, ["container-delete", name, owner, sid, folder, "4/7"]);
        return before;
      }
      return current;
    },
  });
  for (const diff of [{}, { folder: "" }, { mapping: 5 }]) {
    current = { ...present, ...diff };
    await assert.rejects(cleanup());
    assert.equal(deleted, 0);
    assert.equal(cleared, 0);
  }
  Object.assign(data, { created: true, folder, folderId: "4/7" });
  for (const diff of [
    { folderId: "4/8" },
    { folder: "" },
    { query: 5 },
    { expectedFolderError: 5 },
    { token: { sid: "changed" } },
  ]) {
    current = { ...present, ...diff };
    await assert.rejects(cleanup());
    assert.equal(deleted, 0);
    assert.equal(cleared, 0);
  }
  assert.equal(records().filter((r) => r.kind === "profile reconciliation incomplete").length, 8);
  current = present;
  await cleanup();
  assert.equal(deleted, 1);
  assert.equal(cleared, 1);
  delete data.created;
  current = before;
  await cleanup();
  assert.equal(deleted, 1);
  assert.equal(cleared, 2);
});

test("a failed snapshot ACL publishes only fresh refusal and actual step outcomes", (t) => {
  const { env, dir, temp } = hostedFixture(t, "windows");
  env.USERPROFILE = temp;
  const script = workflow()
    .jobs.windows.steps.find((s) => s.id === "outcomes")
    .run.replace("try { protect(dir); }", 'try { throw Error("fixture ACL failure"); }');
  run("bash", ["-ec", script], { env });
  const outputs = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
  const snapshot = outputs.trim().split("snapshot=").at(-1);
  assert.notEqual(snapshot, dir);
  assert.deepEqual(fs.readdirSync(snapshot), ["observations.jsonl"]);
  const result = JSON.parse(fs.readFileSync(path.join(snapshot, "observations.jsonl")));
  assert.equal(result.owned, false);
  assert.equal(result.cleanup, "failure");
  assert.ok(result.refusals.includes("snapshot ACL verification failed"));
  assert.ok(outputs.includes(path.join(snapshot, "observations.jsonl")));
});

test("ledger writers reject a locked destination and a stale in-memory revision", async (t) => {
  const { dir, env, select } = hostedFixture(t, "windows");
  const first = await import("./evidence.mjs?first"),
    second = await import("./evidence.mjs?second");
  for (const reader of [first, second]) assert.deepEqual(reader.readLedger(dir), { fixture: true });
  const lock = path.join(dir, "ledger.json.lock");
  fs.mkdirSync(lock);
  assert.throws(() => first.writeEvidence(dir, "ledger.json", "{}"), { code: "EEXIST" });
  fs.rmdirSync(lock);
  const code =
    "import {readLedger,writeEvidence} from " +
    JSON.stringify(new URL("evidence.mjs", import.meta.url).href) +
    ';readLedger(process.env.W17_OUT);writeEvidence(process.env.W17_OUT,"ledger.json",\'{"revision":2}\');';
  run(process.execPath, ["--input-type=module", "-e", code], { env });
  env.W17_LEDGER_ID = fs.readFileSync(env.GITHUB_ENV, "utf8").trim().split("W17_LEDGER_ID=").at(-1);
  assert.throws(() => second.writeEvidence(dir, "ledger.json", "{}"), /revision changed/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(select(), "ledger.json"))), {
    revision: 2,
  });
});

test("fresh controller handshake failures and unprivileged inspector attaches are distinct", async () => {
  const attached = { result: "ATTACHED", transport: { events: [{ event: "CONNECTED" }] } };
  const denied = {
    result: "HANDSHAKE_ERROR",
    transport: { code: "EACCES", events: [{ event: "EACCES" }] },
  };
  for (const controlWorks of [false, true]) {
    const status = {},
      observed = [];
    const negatives = caller("windows/product.mjs", "negatives", {
      assert,
      process,
      note: noop,
      inspectorClient: {
        execute: () => ({
          pid: process.pid,
          outcomes: Array(2).fill(controlWorks ? attached : denied),
        }),
      },
      actor: (_task, { role }) => {
        observed.push(role);
        return { pid: 42, outcomes: Array(2).fill(role === "subject" ? denied : attached) };
      },
      measure: async (key, fn) => {
        if (key.endsWith(".resources")) return true;
        try {
          await fn();
          status[key] = "PASS";
        } catch (error) {
          status[key] = error.message;
        }
      },
    });
    await negatives("wfp", ["main", "renderer"], { js: () => 11 }, { js: () => true }, 11);
    assert.deepEqual(observed, ["subject", "other"]);
    if (controlWorks) {
      assert.equal(status["W6.wfp.subject"], "PASS");
      assert.match(status["W6.wfp.other"], /No verified inspector denial for other/);
    } else {
      for (const role of ["subject", "other"])
        assert.match(status["W6.wfp." + role], /fresh inspector/);
    }
  }
});

test("publication uses the destination creation time when replace-rename changes it", (t) => {
  const { dir, env } = hostedFixture(t, "windows");
  const script = `
    import fs from "node:fs";
    import {readLedger,writeEvidence} from ${JSON.stringify(new URL("evidence.mjs", import.meta.url).href)};
    readLedger(process.env.W17_OUT);
    const rename=fs.renameSync, stat=fs.lstatSync;
    let installed;
    fs.renameSync=(src,dst)=>{rename(src,dst); installed=dst};
    fs.lstatSync=(p,...args)=>{
      const s=stat(p,...args);
      if(p===installed) s.birthtimeNs=17n;
      return s;
    };
    writeEvidence(process.env.W17_OUT,"ledger.json",'{"revision":2}');
  `;
  run(process.execPath, ["--input-type=module", "-e", script], { env });
  const st = fs.lstatSync(path.join(dir, "ledger.json"), { bigint: true });
  assert.equal(
    fs.readFileSync(env.GITHUB_ENV, "utf8").trim().split("\n").at(-1),
    "W17_LEDGER_ID=" + st.dev + "/" + st.ino + "/17",
  );
});

test("Windows cleanup still drives broker restoration after a ledger refusal", (t) => {
  for (const damage of ["lock", "unpublished"]) {
    const { temp, dir, env } = hostedFixture(t, "windows");
    const file = path.join(dir, "ledger.json");
    if (damage === "lock") fs.mkdirSync(file + ".lock");
    else {
      fs.renameSync(file, file + ".published");
      fs.writeFileSync(file, "unpublished bytes");
    }
    const original = fs.readFileSync(file);
    // Substitute only the private broker process. Drive the actual phase entry,
    // RPC stream, restoration checks, evidence writes and exit handling.
    const broker = path.join(temp, "broker.cjs");
    fs.writeFileSync(
      broker,
      `
      const replies = {host:{stage:process.env.W17_OUT+"/absent"},count:0,
        tree:[],births:[],"recover-policy":[{restored:true}],state:{entries:[]},
        cleanup:[{restored:true}],"verify-wfp-absent":true,final:true};
      require("readline").createInterface({input:process.stdin}).on("line", line=>{
        const {op}=JSON.parse(line);
        console.log(JSON.stringify({ok:Object.hasOwn(replies,op),value:replies[op]}));
      });`,
    );
    const preload = path.join(temp, "spawn.cjs");
    fs.writeFileSync(
      preload,
      `
      const cp=require("node:child_process"), spawn=cp.spawn;
      cp.spawn=(file,args,opts)=>{
        if (!file.endsWith("pwsh.exe")) throw Error("unexpected fixture command");
        return spawn(process.execPath,[process.env.BROKER],opts);
      };`,
    );
    const r = spawnSync(
      process.execPath,
      ["--require", preload, path.join(import.meta.dirname, "windows/probe.mjs"), "cleanup"],
      {
        env: { ...env, W17_PWSH: path.join(temp, "pwsh.exe"), BROKER: broker },
        encoding: "utf8",
      },
    );
    assert.equal(r.status, 1, r.stderr);
    const records = () =>
      fs
        .readFileSync(path.join(dir, "observations.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
    assert.equal(
      records().find((o) => o.kind === "ledger refusal")?.data.operation,
      damage === "lock" ? "write" : "read",
    );
    assert.deepEqual(records().find((o) => o.kind === "cleanup resource results")?.data, [
      { restored: true },
    ]);
    assert.deepEqual(records().at(-1).data, { phase: "cleanup", exit: 1 });
    run(
      process.execPath,
      [path.join(import.meta.dirname, "windows/phase-log.mjs"), "cleanup", "failure", "7"],
      { env },
    );
    assert.deepEqual(records().at(-1).data, { phase: "cleanup", exit: 7 });
    assert.deepEqual(fs.readFileSync(file), original);
    assert.equal(fs.existsSync(file + ".lock"), damage === "lock");
    if (damage === "lock") {
      fs.rmdirSync(file + ".lock");
      fs.writeFileSync(
        broker,
        `
        require("readline").createInterface({input:process.stdin}).on("line", line=>{
          const {op}=JSON.parse(line);
          if(op==="host")require("fs").mkdirSync(process.env.W17_OUT+"/ledger.json.lock");
          console.log(JSON.stringify({ok:op!=="host",value:op==="count"?0:[],error:"host failure"}));
        });`,
      );
      const phase = spawnSync(
        process.execPath,
        ["--require", preload, path.join(import.meta.dirname, "windows/probe.mjs"), "package"],
        {
          env: { ...env, W17_PWSH: path.join(temp, "pwsh.exe"), BROKER: broker },
          encoding: "utf8",
        },
      );
      assert.equal(phase.status, 1, phase.stderr);
      assert.deepEqual(records().at(-1).data, { phase: "package", exit: 1 });
    }
  }
});

test("cleanup refuses unpublished macOS ledger bytes and can still checkpoint restoration", (t) => {
  const { dir, env } = hostedFixture(t, "macos");
  const ledger = path.join(dir, "ledger.json");
  fs.renameSync(ledger, ledger + ".old");
  fs.writeFileSync(ledger, "unpublished");
  fs.writeFileSync(path.join(dir, "resources.json"), '{"pfDirty":true}');
  const exercise = `
    import assert from 'node:assert/strict';
    import {j,checkpoint,row,journalLedger} from ${JSON.stringify(new URL("macos/context.mjs", import.meta.url).href)};
    assert.equal(journalLedger.refused,true);
    row("cleanup","FAIL","fixture refusal");
    assert.equal(j.pfDirty,true);
    j.pfDirty=false;
    checkpoint();`;
  const args = ["--input-type=module", "-e", exercise, "fixture"];
  const closed = spawnSync(process.execPath, [...args, "package"], { env, encoding: "utf8" });
  assert.equal(closed.status, 1);
  assert.match(closed.stderr, /differs from published revision/);
  run(process.execPath, [...args, "cleanup"], { env });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "resources.json"))), {
    pfDirty: false,
  });
  assert.equal(fs.readFileSync(ledger, "utf8"), "unpublished");
  const notes = fs
    .readFileSync(path.join(dir, "observations.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(notes.find((n) => n.kind === "ledger refusal")?.data.operation, "read");
  assert.equal(notes.at(-1).kind, "unpublished row");
});

test("a ledger refusal vetoes otherwise complete Windows phase evidence", () => {
  const phases = ["primitives", "package", "cleanup"].map((phase) => ({
    kind: "phase exit",
    data: { phase, exit: 0 },
  }));
  assert.equal(win.recorded({}, phases), true);
  assert.equal(win.recorded({}, [...phases, { kind: "ledger refusal" }]), false);
});

test("container policy journals every staged binary and subject scratch directory individually", () => {
  const broker = read("windows/broker.ps1");
  const grant = broker.match(/^function Grant-Container\([^]*?^\}/m)[0];
  assert.match(broker, /'container-grants' \{ return ,@\(Grant-Container \$p.sid\)/);
  assert.match(read("windows/network.mjs"), /transactions = await rpc\("container-grants"/);
  const script = `
    $ErrorActionPreference='Stop'
    ${grant}
    $stage=Join-Path ([IO.Path]::GetTempPath()) stage
    $bin=Join-Path $stage bin
    $subject=Join-Path $stage subject-home
    $children=@{}
    $j=@{stage=$stage;accounts=@{subject=@{home=$subject}};entries=@(@{kind='stage';data=@{children=$children}})}
    foreach ($name in 'node.exe','w17-child.exe','subject.exe','native-child.exe','client.cjs','electron.cjs','positive.json','package/resources/app.asar') {
      $children[(Join-Path $bin $name)]='file:id'
    }
    $children[(Join-Path $bin package)]='directory:id'
    $children[(Join-Path $stage 'aliases/root')]='junction:id'
    function Ace($path,$sid,$rights,$inherit,$type,$scope) {
      if ($scope -cne 'container' -or $sid -cne 'test-sid' -or $type -cne 'Allow') {throw 'bad grant'}
      return @{id=@{path=$path;rights=$rights;inherit=$inherit}}
    }
    @(Grant-Container test-sid) | ConvertTo-Json -Compress
  `;
  const grants = JSON.parse(run("pwsh", ["-NoProfile", "-Command", script]));
  const paths = grants.map(({ path: target, rights, inherit }) => {
    const rel = path.relative(path.join(os.tmpdir(), "stage"), target).split(path.sep).join("/");
    assert.equal(rights, rel.startsWith("subject-home") ? "Modify" : "ReadAndExecute");
    const leaf = !rel || rel === "aliases" || !!path.extname(rel);
    assert.equal(inherit, leaf ? "None" : "ContainerInherit,ObjectInherit");
    return rel;
  });
  assert.deepEqual(
    paths.sort(),
    [
      "",
      "aliases",
      "bin",
      "negative",
      "plans",
      "subject-home",
      ...["Roaming", "Local", "Temp", "empty"].map((n) => "subject-home/" + n),
      ...[
        "node.exe",
        "w17-child.exe",
        "subject.exe",
        "native-child.exe",
        "client.cjs",
        "electron.cjs",
        "positive.json",
        "package",
        "package/resources/app.asar",
      ].map((n) => "bin/" + n),
    ].sort(),
  );
  assert.match(read("windows/files.mjs"), /writable: ownedFile\(\)/);
});

test("raw preflight records independent measurements and retains primary and cleanup failures", (t) => {
  const dir = scratch(t);
  // Substitute only the Windows ACL editor types and the native exports.
  // Keep the real Protect-Stage, Ace, Section, journal intent and RestoreAcl.
  const editor = `
    class FixtureRule {
      [string] $label
      FixtureRule([string]$sid,[string]$rights,[string]$inherit,[string]$prop,[string]$type) {
        $this.label="($sid $rights $inherit $prop $type)"
      }
    }
    class FixtureAcl {
      [string] $raw
      [bool] $AreAccessRulesProtected
      [void] SetAccessRuleProtection([bool]$enabled,[bool]$preserve) {if ($enabled -and !$preserve) {$this.raw='D:P'}}
      [void] SetSecurityDescriptorSddlForm([string]$sddl,[object]$section) {$this.raw=$sddl}
      [string] GetSecurityDescriptorSddlForm([string]$section) {return $this.raw}
      [void] AddAccessRule([FixtureRule]$rule) {$this.raw+=$rule.label}
    }
  `;
  fs.writeFileSync(
    path.join(dir, "raw-acl.ps1"),
    editor +
      read("windows/raw-acl.ps1")
        .replaceAll(
          /\[Security\.AccessControl\.(DirectorySecurity|FileSecurity)\]/g,
          "[FixtureAcl]",
        )
        .replaceAll("[Security.AccessControl.FileSystemAccessRule]", "[FixtureRule]")
        .replaceAll(/\[Security\.Principal\.SecurityIdentifier\]::new\((\$\w+)\)/g, "$1"),
  );
  const script = read("windows/preflight-raw.ps1")
    .replace(
      /^Add-Type -TypeDefinition .*$/m,
      `
    class W17 {
      static [hashtable] $values=@{}
      static [hashtable] $labels=@{}
      static [uint32] ReadLabel([string]$p,[Text.StringBuilder]$b,[uint32]$cap) {
        $v=[W17]::labels[$p]
        if (!$v) {$v=if ($env:DAMAGE -eq 'restorelabel') {'S:(ML;;NW;;;ME)'} else {'S:'}}
        [void]$b.Append($v)
        return 0
      }
      static [uint32] WriteLabel([string]$p,[string]$before,[string]$request,[Text.StringBuilder]$label,[Text.StringBuilder]$oldDacl,[Text.StringBuilder]$newDacl,[uint32]$capacity) {
        [void]$oldDacl.Append('0708')
        [void]$newDacl.Append('0708')
        if ($env:DAMAGE -eq 'labelrc') { [void]$label.Append('02|wrong'); return 13 }
        [void]$label.Append($request)
        $current=[Text.StringBuilder]::new()
        if ([W17]::ReadLabel($p,$current,65536) -or $before -cne $current.ToString()) {return 1306}
        if ($env:DAMAGE -in 'label','cleanup') {[W17]::values[$p]='unexpected'}
        if ($env:DAMAGE -eq 'cleanup') {[IO.File]::WriteAllText((Join-Path $p unexpected),'fixture')}
        if ($env:DAMAGE -ne 'nolabel' -and !($env:DAMAGE -eq 'restorelabel' -and $request -ceq 'S:(ML;;NW;;;ME)')) {
          [W17]::labels[$p]=$request
        }
        return 0
      }
      static [IDisposable] CreateStage([string]$p) {
        [IO.Directory]::CreateDirectory($p)
        return [IO.MemoryStream]::new()
      }
      static [bool] CreateDirectoryW([string]$p,[IntPtr]$sd) {
        [IO.Directory]::CreateDirectory($p)
        return $true
      }
      static [uint32] ReadDacl([string]$p,[Text.StringBuilder]$b,[uint32]$cap) {
        if ($env:DAMAGE -eq 'read') {return 5}
        $v=[W17]::values[$p]
        if ($p -eq $env:W17_PRIVATE -and [IO.File]::Exists($env:STATE)) { $v=[IO.File]::ReadAllText($env:STATE) }
        if (!$v) {$v=if ($env:DAMAGE -eq 'absent') {'D:(original)'} else {'D:AI(original)'}}
        [void]$b.Append($v)
        return 0
      }
      static [uint32] WriteDacl([string]$p,[string]$before,[string]$request,[Text.StringBuilder]$b,[uint32]$cap) {
        $current=[Text.StringBuilder]::new()
        if ([W17]::ReadDacl($p,$current,65536) -or $before -cne $current.ToString()) {return 1306}
        if ($p -eq $env:W17_PRIVATE) { [IO.File]::WriteAllText($env:STATE,$request) }
        if ($env:DAMAGE -in 'sticky','rollback' -and [IO.Path]::GetFileName($p) -like 'W17-preflight-*' -and $request.StartsWith('D:P(') -and $before.StartsWith('D:AI')) { [void]$b.Append($request.Insert(3,'AI')); if ($env:DAMAGE -eq 'rollback') {return 0x20000001}; return 13 }
        if ($env:DAMAGE -eq 'propagation' -and [IO.File]::Exists((Join-Path $p input))) {
          [W17]::values[(Join-Path $p input)]='changed'
        }
        [W17]::values[$p]=$request
        [void]$b.Append($request)
        return 0
      }
    }`,
    )
    .replace(
      "$ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
      "$ownerSid='owner'",
    )
    .replaceAll('& "$env:SystemRoot\\System32\\icacls.exe"', "Fixture-Icacls")
    .replace(
      /^function Test-RawAcl/m,
      `
      function Fixture-Icacls($dir,$verb,$level) {
        if (!$verb) { $global:LASTEXITCODE=0; if ($env:DAMAGE -ne 'nolabel') { 'Mandatory Label\\Low Mandatory Level:(OI)(CI)(NW)' }; return }
        if ($verb -cne '/setintegritylevel' -or $level -cne '(OI)(CI)L') {throw 'wrong label invocation'}
        [W17]::values[$dir]='icacls rewrote the control DACL'
        [W17]::labels[$dir]='S:(ML;OICI;NW;;;LW)'
        $global:LASTEXITCODE=0
      }
      function Test-RawAcl`,
    );
  const target = path.join(dir, "raw.ps1");
  fs.writeFileSync(target, script);
  fs.writeFileSync(path.join(dir, "controller.dll"), "");
  const fixtures = path.join(dir, "fixtures");
  fs.mkdirSync(fixtures);
  const log = path.join(dir, "preflight.log");
  for (const [damage, expected] of [
    ["missing", "Missing private DACL verifier"],
    ["read", "rc=5"],
    ["sticky", "result=PROTECT_STAGE_AI_STICKY"],
    ["label", "Integrity label changed"],
    ["cleanup", "Integrity label changed"],
    ["rollback", "raw DACL rollback failed"],
    ["restorelabel", "Label restoration mismatch"],
    ["labelrc", "write mandatory label returned 13"],
    ["nolabel", "Inherited low integrity label missing"],
    ["absent", "PROTECT_STAGE_INITIAL_AI_ABSENT"],
    ["accept", "Expected private verifier rejection rc=0"],
    ["broken", "Expected private verifier rejection rc=1"],
    ["propagation", "non-propagation mismatch"],
    ["same", "Private verifier produced no DACL change"],
    ["", "result=RAW_PREFLIGHT_VERIFIED"],
  ]) {
    fs.writeFileSync(log, "");
    fs.rmSync(path.join(dir, "private-state"), { force: true });
    const r = spawnSync("pwsh", ["-NoProfile", "-File", target, "-Build", dir], {
      encoding: "utf8",
      env: {
        ...process.env,
        ProgramFiles: fixtures,
        TMPDIR: fixtures,
        TMP: fixtures,
        TEMP: fixtures,
        DAMAGE: damage,
        STATE: path.join(dir, "private-state"),
        W17_PRIVATE_ACL:
          damage === "missing"
            ? ""
            : `
          if ($env:W17_ACL_VERIFY_ONLY -eq '0') {
            if ($env:DAMAGE -ne 'same') { [IO.File]::WriteAllText($env:STATE,'D:P(private)') }
          } elseif ([IO.File]::ReadAllText($env:STATE) -cne 'D:P(private)') {
            if ($env:DAMAGE -eq 'broken') {throw 'Unexpected verifier error'}
            if ($env:DAMAGE -ne 'accept') {throw 'Private directory DACL mismatch'}
          }
        `,
      },
    });
    const result = fs.readFileSync(log, "utf8");
    assert.equal(r.status, damage ? 1 : 0, r.stderr + result);
    assert.ok(result.includes(expected), result);
    for (const name of ["PRIVATE_VERIFIER", "PROTECT_STAGE", "CHILD_GRANTS", "INTEGRITY_LABEL"]) {
      assert.equal(
        [...result.matchAll(new RegExp("^result=" + name + " (PASS|FAIL) ", "gm"))].length,
        1,
        result,
      );
    }
    if (["sticky", "absent"].includes(damage)) {
      assert.match(result, /^result=PROTECT_STAGE FAIL /m);
      assert.match(result, /^result=CHILD_GRANTS PASS /m);
      assert.match(result, /^result=INTEGRITY_LABEL PASS /m);
      assert.match(
        result,
        damage === "sticky" ? /beforeAI=True afterAI=True/ : /beforeAI=False afterAI=False/,
      );
      if (damage === "sticky") assert.match(result, /result=STICKY_STAGE_FALLBACK PASS raw=D:PAI/);
    }
    if (damage) assert.ok(!result.includes("result=RAW_PREFLIGHT_VERIFIED"));
    else {
      assert.match(result, /^result=ICACLS_LABEL_REWRITES_DACL observed=True rc=0 /m);
      assert.match(
        result,
        /^result=INTEGRITY_LABEL PASS .* originalLabel=S: installedLabel=S:\(ML;OICI;NW;;;LW\) restoredLabel=S:$/m,
      );
      assert.match(result, /verify-private mode=1/);
      assert.match(
        result,
        /WriteDacl action=protect stage DACL path=.*\.w17-owner rc=0 requested=D:P\(owner FullControl None None Allow\)\(S-1-5-18 FullControl None None Allow\)/,
      );
      const restored = [
        ...result.matchAll(/^WriteDacl action=restore raw file DACL path=(.*?) rc=0 /gm),
      ].map((m) => path.basename(m[1]));
      assert.deepEqual(restored.slice(0, 3), ["input", "home", "home"]);
      assert.equal(restored.length, 5);
      assert.equal(restored[4], "integrity");
      assert.match(result, /beforeAI=True afterAI=False/);
      assert.match(restored[3], /^W17-preflight-/);
    }
    if (!damage || damage === "labelrc") {
      const observed = damage ? "02|wrong" : "S:(ML;OICI;NW;;;LW)";
      assert.ok(
        result
          .split(/\r?\n/)
          .some(
            (line) =>
              line.includes("WriteLabel path=") &&
              line.includes(
                "rc=" + (damage ? 13 : 0) + " before=S: requested=S:(ML;OICI;NW;;;LW)",
              ) &&
              line.endsWith("observedLabel=" + observed + " beforeDacl=0708 observedDacl=0708"),
          ),
        result,
      );
    }
    if (damage === "rollback") assert.doesNotMatch(result, /STICKY_STAGE_FALLBACK/);
    if (damage === "propagation") assert.match(result, /^result=INTEGRITY_LABEL PASS /m);
    if (damage === "cleanup") {
      assert.match(
        result,
        /result=INTEGRITY_LABEL FAIL .*Integrity label changed[^]*cleanup pending path=.*integrity[^]*Raw preflight cleanup incomplete/,
      );
      const [stage] = fs.readdirSync(fixtures);
      assert.deepEqual(fs.readdirSync(path.join(fixtures, stage)), ["integrity"]);
      assert.deepEqual(fs.readdirSync(path.join(fixtures, stage, "integrity")), ["unexpected"]);
      fs.rmSync(path.join(fixtures, stage), { recursive: true });
    }
    assert.deepEqual(
      fs
        .readdirSync(fixtures)
        .filter((n) => n.startsWith("W17-preflight-") || n.startsWith("w17-private-")),
      [],
    );
  }
});
