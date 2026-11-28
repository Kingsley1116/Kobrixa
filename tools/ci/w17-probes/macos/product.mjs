import { randomUUID } from "node:crypto";
import {
  checkpointUtility,
  diagnosticSummary,
  captureFile,
  launchReceipt,
} from "../diagnostics.mjs";
import { exact, enforcement, alternative, packagedControls, productTree } from "./judge.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  connect,
  until,
  observeBeforeStartup,
  releaseStartingWorkers,
  waitForRendererTarget,
} from "../../../../tests/desktop/builtin-installed-client.mjs";
import {
  macBundle,
  verifyMacBundle,
  copyDesktopBundle,
} from "../../../release/macos-test-bundle.mjs";
import {
  j,
  root,
  note,
  row,
  measured,
  intent,
  blockPrefix,
  command,
  sudo,
  subject,
  start,
  subjectArgs,
  checkpoint,
  hash,
  ledger,
} from "./context.mjs";
import { agent, removeAgent } from "./account.mjs";
import { processTable, processes, identity, stopOwned } from "./processes.mjs";
import { receivers, control, tuple, attempt, client } from "./network.mjs";
import { allowBaseline, deny, restoreACL, positive, reads, baselineOK } from "./acl.mjs";
import { install, removePF, counters } from "./pf.mjs";

async function copy() {
  const source = await macBundle(root + "/apps/desktop/out/Kobrixa-darwin-arm64");
  const dir = j.stage + "/package";
  j.bundle = dir + "/" + path.basename(source);
  j.exe = j.bundle + "/Contents/MacOS/kobrixa";
  j.archive = j.bundle + "/Contents/Resources/app.asar";
  checkpoint();
  fs.mkdirSync(dir);
  fs.chmodSync(dir, 0o755);
  const run = (file, args) => command(file, args, { timeout: 120000 });
  await verifyMacBundle(source, run);
  await copyDesktopBundle(source, j.bundle, "darwin", run);
  await verifyMacBundle(j.bundle, run);
  const cdhash = (bundle) =>
    /^CDHash=([0-9a-f]+)$/m.exec(
      command("/usr/bin/codesign", ["--display", "--verbose=4", bundle]).stderr,
    )?.[1];
  const original = cdhash(source),
    copied = cdhash(j.bundle);
  assert.ok(original && original === copied, "bundle CDHash mismatch");
  note("bundle signature hash", { source: original, copy: copied });
  const hashes = {};
  for (const rel of [
    "/Contents/Resources/app.asar",
    "/Contents/MacOS/kobrixa",
    "/Contents/_CodeSignature/CodeResources",
  ]) {
    hashes[rel] = { source: hash(source + rel), copy: hash(j.bundle + rel) };
    assert.equal(hashes[rel].source, hashes[rel].copy);
  }
  row("M5.copy", "PASS", { source, bundle: j.bundle, hashes });
}
function launch(arm, profile) {
  const args = [
    j.exe,
    "--inspect-brk=127.0.0.1:0",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profile,
  ];
  j.appPending = true;
  checkpoint();
  if (j.route === "agent") {
    const record = agent(args, arm);
    return {
      stderrPath: record.base + ".err",
      stderr: () => captureFile(record.base + ".err"),
      stdout: () => captureFile(record.base + ".out"),
      record,
    };
  }
  const [file, ...argv] = subjectArgs(args, j.route);
  const base = path.join(process.env.W17_OUT, "product-" + arm);
  const fds = [".out", ".err"].map((ext) => fs.openSync(base + ext, "wx", 0o600));
  let child;
  try {
    child = start(file, argv, { stdio: ["ignore", ...fds] });
  } finally {
    for (const fd of fds) fs.closeSync(fd);
  }
  child.once("error", (e) => note("product launch failure", { arm, code: e.code }));
  child.once("exit", (code, signal) => note("product exit", { arm, code, signal }));
  return {
    stderrPath: base + ".err",
    stderr: () => captureFile(base + ".err"),
    stdout: () => captureFile(base + ".out"),
    child,
  };
}
async function negativeInspect(urls, checkLive) {
  const isolation = [];
  for (const [role, user] of [
    ["subject", j.name],
    ["other", "nobody"],
  ]) {
    try {
      await checkLive();
      const uid = Number(command("/usr/bin/id", ["-u", user]).stdout.trim()) >>> 0;
      if (role === "other")
        assert.ok(!/\b(admin|wheel)\b/.test(command("/usr/bin/id", ["-Gn", user]).stdout));
      assert.ok(
        uid !== 0 &&
          uid !== process.getuid() &&
          (role === "subject" ? uid === j.uid : uid !== j.uid),
      );
      const proofs = [];
      for (const url of urls) {
        const args = [
          "-n",
          "-u",
          user,
          "/usr/bin/env",
          "-i",
          "PATH=/usr/bin:/bin",
          j.node,
          j.stage + "/client.cjs",
          "--stdin",
        ];
        const r = JSON.parse(
          command("/usr/bin/sudo", args, {
            input: JSON.stringify({ action: "inspector", url }),
            cwd: j.cwd,
          }).stdout,
        );
        const transport = JSON.parse(
          command("/usr/bin/sudo", args, {
            input: JSON.stringify({ action: "port", port: Number(new URL(url).port) }),
            cwd: j.cwd,
          }).stdout,
        );
        proofs.push({ uid: r.uid, code: r.code, transport: transport.code });
        assert.equal(transport.euid, uid);
        assert.equal(r.euid, uid);
      }
      await checkLive();
      measured(
        "M5.inspector." + role,
        proofs.every(
          (r) =>
            ["HANDSHAKE_ERROR", "TIMEOUT"].includes(r.code) &&
            ["EACCES", "EPERM", "TIMEOUT", "ECONNREFUSED", "ECONNRESET"].includes(r.transport),
        ),
        proofs,
      );
    } catch (e) {
      row("M5.inspector." + role, "FAIL", diagnosticSummary(e.message));
    }
    try {
      const args = ["-n", "-u", user, "/usr/bin/env", "-i", "PATH=/usr/bin:/bin"];
      const uid = Number(command("/usr/bin/id", ["-u", user]).stdout.trim()) >>> 0;
      const file = process.env.W17_OUT + "/ledger.json";
      const opens = ["read", "write"].map((mode) =>
        JSON.parse(
          command("/usr/bin/sudo", [...args, j.node, j.stage + "/client.cjs", "--stdin"], {
            cwd: j.cwd,
            input: JSON.stringify({ action: "controlFile", path: file, mode }),
          }).stdout,
        ),
      );
      const memory = JSON.parse(
        command("/usr/bin/sudo", [...args, j.stage + "/access", "access", String(process.pid)], {
          cwd: j.cwd,
        }).stdout,
      );
      isolation.push({
        role,
        opens,
        memory,
        ok:
          uid !== 0 &&
          uid !== process.getuid() &&
          (role === "subject" ? uid === j.uid : uid !== j.uid) &&
          opens.every((r) => r.euid === uid && ["EACCES", "EPERM"].includes(r.code)) &&
          memory.uid === uid &&
          memory.denied === true,
      });
    } catch (e) {
      isolation.push({ role, ok: false, error: diagnosticSummary(e.message) });
    }
  }
  measured(
    "M5.controllerIsolation",
    isolation.length === 2 && isolation.every((r) => r.ok),
    isolation,
  );
}
async function rendererSandbox(renderer) {
  const contexts = [];
  const off = renderer.on("Runtime.executionContextCreated", ({ context }) =>
    contexts.push(context),
  );
  try {
    await renderer.send("Runtime.enable");
    for (const c of contexts.filter((c) => !c.auxData?.isDefault)) {
      const r = await renderer.send("Runtime.evaluate", {
        contextId: c.id,
        expression: "typeof process === 'object' && process.sandboxed === true",
        returnByValue: true,
      });
      if (r.result?.value === true) return { verified: true, name: c.name };
    }
    return { verified: false, contexts: contexts.map((c) => c.name) };
  } finally {
    off();
  }
}
async function runArm(arm, endpoints, plans, baseline) {
  const restricted = arm === "restricted";
  const key = (s) => "M5." + arm + "." + s;
  const profile = j.home + "/profile/" + arm;
  intent("create product profile", profile, "remove home");
  subject(["/bin/mkdir", "-m", "700", profile]);
  const nonce = randomUUID();
  const app = launch(arm, profile);
  const known = new Map();
  j.productBirths ??= {};
  const sample = () => {
    const table = processTable();
    const tree = productTree(table, j.bundle, mainPid, known);
    for (const p of tree) {
      known.set(p.pid, p.birth);
      try {
        assert.equal(p.uid, j.uid, "foreign UID in product tree");
        if (j.productBirths[p.pid]?.psBirth === p.birth) continue;
        const os = identity(p.pid);
        assert.equal(os.uid, j.uid);
        assert.equal(os.pid, p.pid);
        assert.ok(os.birth);
        j.productBirths[p.pid] = { ...os, psBirth: p.birth };
        checkpoint();
      } catch (e) {
        monitorError ??= e;
      }
    }
    return tree;
  };
  let main,
    renderer,
    workers,
    utilityPid,
    mainPid,
    quitRequested = false,
    stage = "identity";
  let monitorError, snapshot;
  const monitor = setInterval(() => {
    try {
      sample();
    } catch (e) {
      monitorError ??= e;
    }
  }, 500);
  const check = () => {
    if (app.child && (app.child.exitCode !== null || app.child.signalCode))
      throw Error("product exited during startup");
    if (/Primary startup failed\./.test((app.stderr() ?? "").toString()))
      throw Error("primary startup failed");
    workers?.check();
  };
  const waitUrl = (prefix) =>
    until(
      () => {
        check();
        return app
          .stderr()
          ?.toString()
          .match(
            new RegExp(prefix + " listening on (ws://127\\.0\\.0\\.1:\\d+/[^\\s]+)\\r?\\n"),
          )?.[1];
      },
      prefix + " readiness",
      30000,
    );
  try {
    const mainURL = await waitUrl("Debugger");
    main = await connect(mainURL);
    workers = await releaseStartingWorkers(main, {});
    await observeBeforeStartup(main, async (evaluate) => {
      const ready = await evaluate(
        `(globalThis.w17=require(${JSON.stringify(j.stage + "/electron.cjs")}).install(require,${JSON.stringify(nonce)})).readyAtAttach`,
      );
      assert.equal(ready, false);
    });
    stage = "renderer";
    const browserURL = await waitUrl("DevTools");
    const target = await waitForRendererTarget(browserURL, { evidence: {}, check });
    assert.ok(
      decodeURIComponent(new URL(target.url).pathname).startsWith(j.archive + "/"),
      "unexpected renderer document",
    );
    renderer = await connect(target.webSocketDebuggerUrl);
    const ready = await until(
      async () => {
        check();
        return renderer.js(
          "Boolean(window.kobrixa?.plugins?.ui && document.querySelector('.plugin-tools-toggle'))",
        );
      },
      "live product renderer",
      30000,
    );
    stage = "identity";
    const info = await main.js("w17.identity()");
    mainPid = info.pid;
    const os = identity(mainPid);
    const intended =
      info.packaged &&
      ["Kobrixa", "@kobrixa/desktop"].includes(info.name) &&
      info.euid === j.uid &&
      info.uid === j.uid &&
      os.uid === j.uid &&
      os.asid === j.asid &&
      info.exe === j.exe &&
      info.archive === j.archive &&
      info.cwd === j.cwd &&
      info.profile === profile &&
      info.clean &&
      info.path === "/usr/bin:/bin:/usr/sbin:/sbin";
    measured(key("identity"), intended, { info, os });
    assert.ok(intended, "packaged identity/session failed");
    measured(key("renderer"), ready, { url: new URL(target.url).pathname });
    stage = "sandbox";
    try {
      const sandbox = await rendererSandbox(renderer);
      // Current SDKs omit a public sandbox_check declaration. Query the shipped
      // kernel-backed sandbox status for this exact renderer if preload hides process.
      const rendererPids = info.windows.map((w) => w.pid);
      const osSandbox = rendererPids.map((pid) =>
        JSON.parse(sudo([j.processTool, "sandbox", String(pid)]).stdout),
      );
      measured(
        key("sandbox"),
        !info.disabled &&
          info.windows.length > 0 &&
          info.windows.every(
            (w) => w.sandbox === true && w.contextIsolation === true && w.nodeIntegration === false,
          ) &&
          (sandbox.verified || osSandbox.every((r) => r.sandboxed === 1)),
        { sandbox, osSandbox, windows: info.windows },
      );
    } catch (e) {
      row(key("sandbox"), "FAIL", diagnosticSummary(e.message));
    }
    stage = "focus";
    try {
      await renderer.send("Page.bringToFront");
      const focus = await main.js("w17.focus()");
      measured(key("focus"), Object.values(focus).every(Boolean), focus);
    } catch (e) {
      row(key("focus"), "FAIL", diagnosticSummary(e.message));
    }
    stage = "processes";
    try {
      note("utility launch requested", { arm, mainPid: mainPid });
      checkpointUtility(process.env.W17_OUT, arm, app.stderrPath, nonce, mainPid);
      utilityPid = await main.js("w17.startUtility()");
      note("utility spawned", {
        arm,
        mainPid: mainPid,
        pid: utilityPid,
        outcome: "no terminal observation",
      });
    } catch (e) {
      row(key("processes"), "FAIL", diagnosticSummary(e.message));
      blockPrefix(key("utility."), "capable utility launch failed");
    }
    const invoke = (role, t) =>
      main.js(`w17.execute(${JSON.stringify(role)},${JSON.stringify(t)})`);
    for (const role of ["main", "utility"]) {
      if (role === "utility" && !utilityPid) continue;
      stage = role + ".files";
      try {
        const r = await invoke(role, {
          action: "files",
          paths: { ...j.files, copy: j.stage + "/control.json" },
        });
        const w = await invoke(role, {
          action: "profile",
          path: path.join(profile, "control-" + role),
        });
        const id = r.euid === j.uid && r.pid === (role === "main" ? mainPid : utilityPid);
        measured(
          key(role + ".files"),
          id &&
            packagedControls(
              r,
              w,
              role === "main" ? mainPid : utilityPid,
              j.uid,
              j.hashes.checkout,
            ) &&
            Object.keys(j.files).every((k) =>
              restricted
                ? baseline[role + "files"] && ["EACCES", "EPERM"].includes(r.files[k]?.code)
                : r.files[k]?.hash === j.hashes[k],
            ),
          { r, w },
        );
        if (!restricted) baseline[role + "files"] = ledger[key(role + ".files")].status === "PASS";
      } catch (e) {
        row(key(stage), "FAIL", diagnosticSummary(e.message));
      }
      stage = role + ".network";
      let classified =
          endpoints.length === endpoints.expectedRoutes.length && endpoints.length >= 4,
        errno = true,
        eligible = true;
      const results = [];
      for (const { role: who, e, t } of plans.filter((p) => p.role === role)) {
        try {
          const pre = await control(e),
            before = restricted ? counters(t) : null;
          const attemptResult = await attempt(e, t, (params) => invoke(who, params));
          const after = restricted ? counters(t) : null,
            post = await control(e);
          const observed = attemptResult.result;
          const right =
            observed.euid === j.uid && observed.pid === (role === "main" ? mainPid : utilityPid);
          const k = role + e.id;
          const ok =
            right &&
            (restricted
              ? (e.id !== e.family || j.loopbackFiltered === true) &&
                baseline[k] &&
                enforcement(before, after, attemptResult, pre, post)
              : pre.reply && post.reply && attemptResult.reply);
          if (!restricted) baseline[k] = ok;
          classified = classified && ok;
          if (restricted && e.family.startsWith("tcp")) {
            errno &&= exact(observed);
            eligible &&= exact(observed) || alternative(observed);
          }
          results.push({
            family: e.family,
            ok,
            code: observed.code,
            errno: observed.errno,
            elapsed: observed.elapsed,
            before,
            after,
          });
        } catch (e) {
          classified = false;
          results.push({ family: t.family, error: diagnosticSummary(e.message) });
        }
      }
      measured(key(role + ".network"), classified && errno, {
        results,
        differentErrnoOnly: classified && !errno && eligible,
      });
    }
    stage = "processes";
    const metrics = await main.js("w17.metrics()");
    const table = sample();
    const joined = metrics.map((m) => ({ ...m, os: table.find((p) => p.pid === m.pid) ?? null }));
    const gone = await main.js("w17.gone");
    snapshot = {
      ok:
        !monitorError &&
        joined.length > 0 &&
        joined.every((m) => m.os?.uid === j.uid && m.os.exe.startsWith(j.bundle + "/")) &&
        ["Browser", "GPU", "Tab", "Utility"].every((type) => joined.some((m) => m.type === type)) &&
        joined.some((m) => m.pid === utilityPid && m.type === "Utility") &&
        !gone.some((e) => e.reason !== "clean-exit"),
      joined,
      gone,
      utilityPid,
    };
    note("process snapshot", { arm, ...snapshot });

    if (restricted)
      await negativeInspect([mainURL, target.webSocketDebuggerUrl], async () => {
        assert.equal(await main.js("process.pid"), mainPid);
        assert.equal(await renderer.js("Boolean(window.kobrixa?.plugins?.ui)"), true);
      });
  } catch (e) {
    note("product error", { arm, error: diagnosticSummary(e.message) });
    if (ledger[key(stage)].status === "NOT RUN")
      row(key(stage), "FAIL", diagnosticSummary(e.message));
    blockPrefix("M5." + arm + ".", diagnosticSummary(e.message));
  } finally {
    try {
      if (main) {
        await main.js("w17.quit()");
        quitRequested = true;
      }
    } catch (e) {
      note("quit request", { arm, error: diagnosticSummary(e.message) });
    }
    workers?.dispose();
    renderer?.close();
    main?.close();
    if (quitRequested)
      try {
        await until(() => !processes().some((p) => p.pid === mainPid), "normal exit", 10000);
      } catch (e) {
        note("exit deadline", e.message);
      }
    const samples = [];
    try {
      for (let i = 0; i <= 10; i++) {
        if (i) await delay(500);
        samples.push(sample());
      }
    } catch (error) {
      monitorError ??= error;
    } finally {
      clearInterval(monitor);
    }
    const capture = app.stderr();
    const logs = [diagnosticSummary(capture ?? ""), diagnosticSummary(app.stdout() ?? "")];
    const receipt = launchReceipt(capture, nonce, mainPid, utilityPid);
    const crash = logs.some((log) => log.errors.length);
    note("startup output", { arm, logs, receipt });
    const monitored = !monitorError && samples.length === 11;
    measured(key("processes"), snapshot?.ok && receipt.healthy && monitored, {
      snapshot,
      receipt,
      monitorError: monitorError?.message,
    });
    let exit = app.child?.exitCode ?? null;
    if (app.record) {
      const service = sudo(["/bin/launchctl", "print", app.record.service], {
        privateOutput: true,
        check: false,
      });
      const code = /^\s*last exit code = (\d+)$/m.exec(service.stdout);
      if (service.code === 0 && code) exit = Number(code[1]);
    }
    measured(
      key("quit"),
      !!mainPid &&
        quitRequested &&
        samples.every((sample) => sample.length === 0) &&
        monitored &&
        receipt.healthy &&
        !crash &&
        exit === 0,
      { quitRequested, mainPid, samples, crash, exit },
    );
    if (app.record) removeAgent(app.record);
    await stopOwned(true);
    j.appPending = false;
    checkpoint();
  }
}
export async function product() {
  await copy();
  let bothInstalled = false;
  const endpoints = await receivers(),
    baseline = {};
  try {
    allowBaseline();
    for (const arm of ["control", "restricted"]) {
      const plans = [];
      for (const role of ["main", "utility"])
        for (const e of endpoints) plans.push({ role, e, t: await tuple(e, "w17" + role + e.id) });
      if (arm === "restricted") {
        deny();
        assert.ok(positive(), "restricted controls failed");
        if (!j.anchor) throw Error("no evaluated PF anchor");
        const trial =
          ledger["M4.drop.subject.tcp4.errno"].status !== "PASS" &&
          ledger["M4.return-rst.subject.tcp4.errno"].status === "PASS"
            ? "return-rst"
            : "drop";
        install(
          trial,
          plans.map((p) => p.t),
        );
        bothInstalled = true;
      }
      await runArm(arm, endpoints, plans, baseline);
    }
  } finally {
    try {
      await stopOwned(true);
      removePF();
      restoreACL();
      allowBaseline();
      let restored =
        baselineOK(reads("after product policy removal")) &&
        endpoints.length === endpoints.expectedRoutes.length &&
        endpoints.length >= 4;
      for (const e of endpoints)
        for (const role of ["subject", "child"]) {
          const r = await control(e, (t) => client(t, role));
          restored = restored && r.reply;
        }
      if (bothInstalled) measured("M5.restored", restored);
      else row("M5.restored", "BLOCKED", "both restrictions were not installed");
    } finally {
      for (const e of endpoints) e.close();
      if (!j.appPending) restoreACL();
    }
  }
}
