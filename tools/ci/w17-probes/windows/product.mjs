import inspectorClient from "./client.cjs";
import { randomUUID } from "node:crypto";
import {
  checkpointUtility,
  captureFile,
  diagnosticSummary,
  startupCapture,
  launchReceipt,
} from "../diagnostics.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import {
  connect,
  observeBeforeStartup,
  releaseStartingWorkers,
  waitForRendererTarget,
} from "../../../../tests/desktop/builtin-installed-client.mjs";
import {
  installedJournalExpression,
  assertWindowsJournalReady,
} from "../../../../tests/desktop/builtin-process-installed.mjs";
import {
  JOURNAL_PACKAGED,
  JOURNAL_PRODUCTION_EXPORTS,
  validateProductionJournal,
} from "../../../release/journal-win32.mjs";
import {
  ctx,
  rows,
  out,
  ownedFile,
  waitJSON,
  actor,
  intent,
  launch,
  rpc,
  digest,
  timed,
  note,
  measure,
  block,
  row,
  safe,
} from "./context.mjs";
import { fresh, trial } from "./network.mjs";

const same = (a, b) =>
  typeof a === "string" && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
export async function copyPackage() {
  const source = path.resolve("apps/desktop/out/Kobrixa-win32-x64");
  ctx.bundle = path.join(ctx.bin, "package");
  ctx.exe = path.join(ctx.bundle, "kobrixa.exe");
  ctx.archive = path.join(ctx.bundle, "resources", "app.asar");
  ctx.addon = path.join(ctx.archive + ".unpacked", JOURNAL_PACKAGED);
  await intent("copy package", { path: ctx.bundle, source });
  const copied = [];
  fs.cpSync(source, ctx.bundle, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter(from, to) {
      assert.ok(!fs.lstatSync(to, { throwIfNoEntry: false }), "Package copy collision");
      const st = fs.lstatSync(from);
      if (st.isFile() || st.isDirectory()) copied.push({ path: to, directory: st.isDirectory() });
      return true;
    },
  });
  await rpc("stage-created", { items: copied });
  const hashes = {};
  for (const target of [ctx.exe, ctx.archive, ctx.addon]) {
    const from = path.join(source, path.relative(ctx.bundle, target));
    hashes[target] = { original: digest(from), copied: digest(target) };
    assert.equal(hashes[target].original, hashes[target].copied);
  }
  validateProductionJournal(fs.readFileSync(ctx.addon), "x64");
  return { source, bundle: ctx.bundle, hashes };
}
export async function forced() {
  const ready = ownedFile();
  const p = await actor({ action: "tree", ready, childExe: ctx.child }, { asyncStart: true });
  try {
    const ids = await waitJSON(ready),
      tree = await rpc("tree");
    const root = tree.find((x) => x.pid === p.pid),
      child = tree.find((x) => x.pid === ids.child);
    assert.ok(root && child && child.ppid === root.pid && root.pid === ids.pid);
    for (const x of [root, child]) {
      assert.equal(x.token.sid, ctx.accounts.subject.sid);
      assert.equal(x.member, 1);
      await rpc("pin", { pid: x.pid, birth: x.token.birth });
    }
    const wrong = String(BigInt(child.token.birth) + 1n),
      refusal = await rpc("kill", { pid: child.pid, birth: wrong });
    assert.equal(refusal, 13);
    assert.equal((await rpc("inspect", { pid: child.pid })).birth, child.token.birth);
    for (const x of [child, root])
      assert.equal(await rpc("kill", { pid: x.pid, birth: x.token.birth }), 0);
    const final = await rpc("tree");
    assert.equal(await rpc("count"), 0);
    assert.ok(
      !final.some((x) =>
        [root, child].some((y) => y.pid === x.pid && y.token.birth === x.token.birth),
      ),
    );
    return { tree, wrong, refusal, final };
  } finally {
    await rpc("stop");
  }
}
async function rendererSandbox(renderer) {
  const contexts = [],
    off = renderer.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context));
  try {
    await renderer.send("Runtime.enable");
    for (const c of contexts.filter((c) => !c.auxData?.isDefault)) {
      const r = await renderer.send("Runtime.evaluate", {
        contextId: c.id,
        expression: "typeof process === 'object' && process.sandboxed === true",
        returnByValue: true,
      });
      if (r.result?.value === true) return { verified: true, context: c.name };
    }
    return { verified: false, contexts: contexts.map((c) => c.name) };
  } finally {
    off();
  }
}
async function inspector(port) {
  return timed(async () => {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/json/list", {
        signal: AbortSignal.timeout(1000),
      });
      if (!r.ok) return null;
      const pages = await r.json();
      return pages.find((p) => p.type === "node")?.webSocketDebuggerUrl;
    } catch {
      return null;
    }
  }, 20000);
}
async function negatives(arm, urls, main, renderer, pid) {
  for (const role of ["subject", "other"]) {
    const options = { role, container: arm === "container" && role === "subject" };
    const resources = await measure("W6." + arm + "." + role + ".resources", async () => {
      const r = { memory: {} };
      const controls = [];
      for (const name of ["controller", "broker"]) {
        const target = { pid: ctx[name].pid, birth: ctx[name].birth };
        const sample = await actor(
          {
            action: "controllerAccess",
            control: path.join(out, "ledger.json"),
            targets: { [name]: target },
          },
          options,
        );
        note("controller target access", { role, name, target, sample });
        if (name === "controller")
          Object.assign(r, {
            pid: sample.pid,
            ppid: sample.ppid,
            exe: sample.exe,
            read: sample.read,
            write: sample.write,
          });
        r.memory[name] = sample.memory[name];
        controls.push({ read: sample.read, write: sample.write });
      }
      r.controls = controls;
      note("controller resource access", { role, ...r });
      assert.equal(ctx.controller.pid, process.pid);
      assert.notEqual(ctx.broker.pid, ctx.controller.pid);
      for (const name of ["controller", "broker"]) {
        const target = ctx[name],
          sample = r.memory[name];
        assert.match(target.birth, /^[1-9]\d*$/);
        assert.equal(sample.targetPid, target.pid);
        assert.equal(sample.token?.sid, ctx.accounts[role].sid);
        assert.equal(sample.exit, 0);
        assert.equal(sample.error, 5);
        const after = await rpc("inspect", { pid: target.pid });
        note("resource target identity", { role, name, pid: after.pid, birth: after.birth });
        assert.equal(after.pid, target.pid);
        assert.equal(after.birth, target.birth);
      }
      for (const control of controls) {
        assert.ok(["EACCES", "EPERM"].includes(control.read));
        assert.ok(["EACCES", "EPERM"].includes(control.write));
      }
      return r;
    });
    await measure("W6." + arm + "." + role, async () => {
      const checkLive = async () => {
        assert.equal(await main.js("process.pid"), pid);
        assert.equal(await renderer.js("Boolean(window.kobrixa?.plugins?.ui)"), true);
      };
      await checkLive();
      const r = await actor(
        {
          action: "inspect",
          urls,
        },
        options,
      );
      note("negative controls", { role, r });
      // Existing CDP sessions can survive a listener failure. Challenge the
      // same advertised endpoints with the same client from the controller.
      const control = await inspectorClient.execute({ action: "inspect", urls });
      note("controller inspector control", { role, outcomes: control.outcomes });
      assert.equal(control.pid, process.pid);
      assert.ok(
        control.outcomes.length === 2 &&
          control.outcomes.every(
            (o) =>
              o.result === "ATTACHED" && o.transport.events.some((e) => e.event === "CONNECTED"),
          ),
        "Controller fresh inspector handshake or TCP control failed",
      );
      await checkLive();
      assert.ok(resources, "controller resource access unresolved");
      assert.ok(
        r.outcomes.length === 2 &&
          r.outcomes.every(
            (o) =>
              ["HANDSHAKE_ERROR", "TIMEOUT"].includes(o.result) &&
              !o.transport.events.some((e) => e.event === "CONNECTED") &&
              ["EACCES", "EPERM", "TIMEOUT", "ECONNREFUSED", "ECONNRESET"].includes(
                o.transport.code,
              ),
          ),
        "No verified inspector denial for " + role,
      );
      return { pid: r.pid, outcomes: r.outcomes };
    });
  }
}
export async function product(arm, base, ids) {
  const restricted = arm !== "startup",
    container = arm === "container",
    prefix = "W5." + arm + ".";
  const profile = path.join(ctx.accounts.subject.home, "product-" + arm);
  const logFile = path.join(ctx.accounts.subject.home, "Temp", "startup-" + arm + ".log");
  const { localPort: port } = await fresh({
    protocol: "tcp",
    host: "127.0.0.1",
    source: "127.0.0.1",
  });
  await intent("product profile", { profile, logFile });
  const nonce = randomUUID();
  assert.ok(!fs.existsSync(logFile), "startup capture already exists");
  const p = await launch(
    ctx.exe,
    [
      "--inspect-brk=127.0.0.1:" + port,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--user-data-dir=" + profile,
      "--enable-logging=file",
      "--log-file=" + logFile,
    ],
    { container, capture: true },
  );
  let main,
    renderer,
    workers,
    utility,
    quit = false,
    snapshot;
  const checkpoint = (key) => prefix + key;
  let current = "identity";
  try {
    const mainURL = await inspector(port);
    main = await connect(mainURL);
    workers = await releaseStartingWorkers(main, {});
    await observeBeforeStartup(main, async (evaluate) => {
      const script = JSON.stringify(path.join(ctx.bin, "electron.cjs"));
      assert.deepEqual(
        await evaluate(
          `(globalThis.__installedProbe={electron:require("electron"),require},globalThis.w17=require(${script}).install(require,${JSON.stringify(nonce)}),[process.pid,w17.readyAtAttach])`,
        ),
        [p.pid, false],
      );
    });
    current = "renderer";
    const devPort = await timed(() => {
      try {
        return Number(
          fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0],
        );
      } catch {
        return 0;
      }
    }, 20000);
    const target = await waitForRendererTarget("http://127.0.0.1:" + devPort, {
      evidence: {},
      check: () => workers.check(),
    });
    assert.ok(
      fileURLToPath(target.url)
        .toLowerCase()
        .startsWith(ctx.archive.toLowerCase() + path.sep),
    );
    renderer = await connect(target.webSocketDebuggerUrl);
    await timed(
      () =>
        renderer.js(
          "Boolean(window.kobrixa?.plugins?.ui && document.querySelector('.plugin-tools-toggle'))",
        ),
      20000,
    );
    row(checkpoint("renderer"), "PASS", { document: fileURLToPath(target.url) });
    current = "identity";
    const info = await main.js("w17.identity()"),
      token = await rpc("inspect", { pid: p.pid });
    note("product identity", { arm, info, token });
    assert.equal(token.sid, ctx.accounts.subject.sid);
    assert.equal(token.elevated, 0);
    if (container) {
      assert.equal(token.container, ctx.containerSid);
      assert.equal(token.isContainer, 1);
      assert.equal(token.capabilities, 0);
    }
    assert.ok(
      info.packaged &&
        ["Kobrixa", "@kobrixa/desktop"].includes(info.name) &&
        same(info.exe, ctx.exe) &&
        same(info.archive, ctx.archive) &&
        same(info.profile, profile) &&
        same(info.cwd, path.join(ctx.accounts.subject.home, "empty")) &&
        info.clean &&
        same(info.path, path.join(process.env.SystemRoot, "System32")),
    );
    row(checkpoint("identity"), "PASS", { pid: p.pid, birth: token.birth });
    await measure(checkpoint("sandbox"), async () => {
      const live = await rendererSandbox(renderer);
      const renderers = await Promise.all(info.windows.map((w) => rpc("inspect", { pid: w.pid })));
      const restrictedRenderer =
        renderers.length > 0 &&
        renderers.every(
          (r) =>
            r.sid === token.sid &&
            !r.elevated &&
            r.integrity <= 4096 &&
            r.restrictedSids > 0 &&
            (r.integrity < token.integrity || token.restrictedSids === 0),
        );
      note("sandbox", { arm, live, renderers, windows: info.windows, disabled: info.disabled });
      assert.ok(
        !info.disabled &&
          info.windows.length &&
          info.windows.every(
            (w) => w.sandbox === true && w.nodeIntegration === false && w.contextIsolation === true,
          ) &&
          (live.verified || restrictedRenderer),
      );
      return live;
    });
    await measure(checkpoint("focus"), async () => {
      await renderer.send("Page.bringToFront");
      const result = await main.js("w17.focus()");
      note("focus", result);
      assert.ok(result.focused && result.defocused && result.refocused);
      return result;
    });
    await measure(checkpoint("journal"), async () => {
      const metadata = await main.js(
        `(()=>{const a=__installedProbe.require(${JSON.stringify(ctx.addon)});return {exports:Object.keys(a).sort(),arch:process.arch,addonArch:a.arch,addonNapi:a.napiVersion,apiVersion:a.apiVersion,abi:process.versions.modules,napi:process.versions.napi,electron:process.versions.electron,profile:__installedProbe.electron.app.getPath("userData")}})()`,
      );
      metadata.volume = await rpc("volume", { file: path.join(profile, "DevToolsActivePort") });
      note("production addon metadata", metadata);
      assert.deepEqual(metadata.exports, [...JOURNAL_PRODUCTION_EXPORTS].sort());
      assert.equal(metadata.arch, "x64");
      assert.equal(metadata.addonArch, "x64");
      assert.ok(
        metadata.abi && metadata.electron && Number(metadata.napi) >= Number(metadata.addonNapi),
      );
      assert.equal(metadata.volume.filesystem, "NTFS");
      assert.equal(metadata.volume.type, "Fixed");
      const journal = await main.js(installedJournalExpression());
      note("actual profile journal", { arm, ...journal });
      assert.ok(same(journal.filename, ctx.addon));
      assert.equal(journal.sha256, digest(ctx.addon));
      assert.equal(journal.capabilities.scope, "local-fixed-NTFS");
      const pages = await renderer.js(
        `(async()=>{const pages=[],seen=new Set();let cursor;do{const p=await window.kobrixa.plugins.recovery.snapshot(cursor?{cursor}:{});pages.push(p);if(!p.ok)break;cursor=p.value.nextCursor;if(cursor&&seen.has(cursor))throw Error("Repeated recovery cursor");seen.add(cursor)}while(cursor);return pages})()`,
      );
      assertWindowsJournalReady(pages, journal);
      return { pages: pages.length, journal, metadata };
    });
    await measure(checkpoint("negative"), async () => {
      const result = await main.js(
        `(()=>{const r=__installedProbe.require,a=r(${JSON.stringify(ctx.addon)}),dir=${JSON.stringify(path.join(ctx.stage, "negative"))};let open;try{r("node:fs").writeFileSync(r("node:path").join(dir,"negative-control"),"w17",{flag:"wx"});open="WRITABLE"}catch(e){open=e.code}try{return {open,barrier:a.syncDirectory(dir)}}catch(e){return {open,code:e.code,win32:e.win32Code,phase:e.phase}}})()`,
      );
      note("unwritable journal", result);
      assert.ok(["EACCES", "EPERM"].includes(result.open));
      assert.ok(
        ["EACCES", "EPERM"].includes(result.code) &&
          result.win32 === 5 &&
          result.phase &&
          !result.barrier,
      );
      return result;
    });
    try {
      note("utility launch requested", { arm, mainPid: p.pid });
      checkpointUtility(out, arm, p.stderr, nonce, p.pid);
      utility = await main.js("w17.startUtility()");
      note("utility spawned", {
        arm,
        mainPid: p.pid,
        pid: utility,
        outcome: "no terminal observation",
      });
      const metrics = await main.js("w17.metrics()"),
        tree = await rpc("tree"),
        gone = await main.js("w17.gone");
      note("CIM and exact handle identity", { arm, metrics, tree, gone, utility });
      const productTree = tree.filter((r) => same(r.exe, ctx.exe));
      assert.ok(
        productTree.some((r) => r.pid === p.pid) &&
          productTree.some((r) => r.pid === utility) &&
          tree.every((r) => r.token.sid === ctx.accounts.subject.sid && r.member === 1),
      );
      assert.ok(
        metrics.every((m) => productTree.some((r) => r.pid === m.pid)) &&
          ["Browser", "GPU", "Tab", "Utility"].every((t) => metrics.some((m) => m.type === t)),
      );
      if (container)
        assert.ok(
          tree
            .filter((r) => r.pid !== p.token.pid)
            .every(
              (r) =>
                r.token.isContainer === 1 &&
                r.token.container === ctx.containerSid &&
                r.token.capabilities === 0,
            ),
        );
      assert.ok(!gone.some((r) => r.reason !== "clean-exit"));
      snapshot = { utility, count: tree.length };
    } catch (e) {
      row(checkpoint("processes"), "FAIL", { error: safe(e) });
    }
    ctx.productPids = { main: p.pid, utility };
    for (const who of ["main", "utility"]) {
      if (who === "utility" && !utility) continue;
      const invoke = (task) =>
        main.js(`w17.execute(${JSON.stringify(who)},${JSON.stringify(task)})`);
      await measure(checkpoint(who + ".files"), async () => {
        const r = await invoke({
          action: "files",
          paths: ctx.paths,
          writable: path.join(profile, "control-" + who),
        });
        note("packaged reads", { arm, who, r });
        assert.equal(r.pid, ctx.productPids[who]);
        assert.equal(r.roundTrip, true);
        for (const [k, v] of Object.entries(ctx.hashes)) {
          assert.equal(digest(ctx.paths[k]), v);
          if (restricted && k !== "staged") {
            assert.equal(rows["W5.startup." + who + ".files"].status, "PASS");
            assert.ok(["EPERM", "EACCES"].includes(r.files[k].code));
          } else assert.equal(r.files[k].hash, v);
        }
      });
      current = who + ".network";
      try {
        const outcomes = await trial("W5." + arm, who, invoke, {
          denied: restricted,
          ids,
          baseline: base,
          nativeToo: false,
          container,
        });
        if (!restricted) Object.assign(base, outcomes);
      } catch (e) {
        row(checkpoint(current), "FAIL", { error: safe(e) });
      }
    }
    if (restricted)
      await negatives(arm, [mainURL, target.webSocketDebuggerUrl], main, renderer, p.pid);
  } catch (e) {
    row(checkpoint(current), "FAIL", { error: safe(e) });
    block(
      Object.keys(rows).filter((k) => k.startsWith(prefix) && !k.endsWith(".quit")),
      current + " failed",
    );
  } finally {
    try {
      if (main) quit = await main.js("w17.quit()");
    } catch (e) {
      note("quit request", { error: safe(e) });
    }
    workers?.dispose();
    renderer?.close();
    main?.close();
    await measure(checkpoint("quit"), async () => {
      let exit, monitorError;
      const samples = [];
      try {
        exit = await p.wait(10000);
        const start = performance.now();
        do {
          samples.push({
            ms: performance.now() - start,
            tree: await rpc("tree"),
            count: await rpc("count"),
          });
          note("orphan sample", { arm, ...samples.at(-1) });
          if (performance.now() - start < 5000) await sleep(350);
        } while (samples.at(-1).ms < 5000);
      } catch (error) {
        monitorError = safe(error);
        note("orphan monitoring failed", { arm, error: monitorError });
      }
      const monitored = !monitorError && samples.at(-1)?.ms >= 5000;
      const capture = captureFile(p.stderr);
      const receipt = launchReceipt(capture, nonce, p.pid, utility);
      const startup = [capture, captureFile(logFile)].map((b) => b && diagnosticSummary(b));
      row(checkpoint("processes"), snapshot && receipt.healthy && monitored ? "PASS" : "FAIL", {
        receipt,
        snapshot,
      });
      note("graceful exit and orphan window", { arm, quit, exit, samples, startup, receipt });
      assert.ok(
        quit &&
          monitored &&
          exit?.wait === 0 &&
          exit.exit === 0 &&
          samples.every((s) => !s.tree.length && s.count === 0) &&
          startupCapture(capture, nonce, p.pid, port) &&
          receipt.healthy &&
          startup.every((s) => !s?.errors.length),
      );
      return { samples: samples.length, ms: samples.at(-1).ms };
    });
    // Cleanup after measuring graceful exit is never graceful-exit evidence.
    await rpc("stop");
  }
}
