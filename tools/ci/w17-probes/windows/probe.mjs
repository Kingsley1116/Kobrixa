import { recoverUtilities } from "../diagnostics.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  ctx,
  rows,
  phase,
  out,
  src,
  save,
  note,
  row,
  measure,
  block,
  safe,
  startBroker,
  closeBroker,
  rpc,
  dirs,
  native,
  restore,
} from "./context.mjs";
import { stage, layout, acl, undoFile, fileControls, originalFiles } from "./files.mjs";
import { receivers, both, complete, reverse, policy, stopPolicy } from "./network.mjs";
import { copyPackage, forced, product } from "./product.mjs";
import {
  checkoutScope,
  required,
  endpoints,
  restoredTransactions,
  containerAbsent,
  sameFolder,
} from "./verdict.mjs";

const state = path.join(out, "continuation.json");
function checkpoint() {
  fs.writeFileSync(
    state,
    JSON.stringify({
      containerSid: ctx.containerSid,
      wfpFailed: ctx.wfpFailed,
      baselinePaths: ctx.paths,
      baselineHashes: ctx.hashes,
      sid: ctx.accounts.subject.sid,
    }),
  );
}
async function stopOwned() {
  const count = await rpc("count");
  if (count) {
    note("forced recovery", { count });
    await rpc("stop");
  }
  assert.equal(await rpc("count"), 0);
}
async function standard() {
  let window;
  for (const desktop of [false, true]) {
    try {
      window = await native(["window"], { desktop });
      if (window.callback === 1 && window.visible === 1) {
        if (desktop) {
          await rpc("desktop-route");
          ctx.desktop = true;
        }
        break;
      }
    } catch (e) {
      note("desktop attempt", { desktop, error: safe(e) });
    }
    await stopOwned();
  }
  if (!window) {
    // A failed desktop must not preclude a non-GUI identity or file probe.
    const id = await native(["files", ctx.paths.staged]);
    window = { token: id.token };
  }
  const t = window.token;
  await measure("W1.identity", async () => {
    assert.equal(t.sid, ctx.accounts.subject.sid);
    assert.notEqual(t.sid, ctx.accounts.other.sid);
    assert.notEqual(t.sid, ctx.token.sid);
    assert.equal(t.elevated, 0);
    assert.ok(!t.groups.includes("S-1-5-32-544"));
    assert.ok(t.groups.includes("S-1-5-32-545"));
    return { token: t };
  });
  await measure("W1.window", async () => {
    assert.ok(
      window.visible === 1 &&
        window.callback === 1 &&
        window.windowError === 0 &&
        window.desktop &&
        window.station &&
        t.session === ctx.token.session,
    );
    return { route: ctx.desktop ? "logon SID ACE" : "ordinary", window };
  });
  await measure("W1.profile", async () => {
    const profile = await rpc("profile", { sid: t.sid });
    note("loaded local profile", { profile, hkcu: window.hkcu });
    assert.equal(window.hkcu, 0);
    assert.equal(window.loadedHive, 0);
    assert.equal(path.normalize(window.profile).toLowerCase(), profile.path.toLowerCase());
    assert.ok(fs.statSync(profile.path).isDirectory());
    return { profile };
  });
}
async function primitiveArm(arm, baseline) {
  let ids;
  const installed = await measure(arm + ".policy", async () => {
    ids = await policy(arm);
    checkpoint();
    return ids ?? { container: ctx.containerSid, capabilities: 0 };
  });
  if (!installed) {
    await stopOwned();
    await stopPolicy(arm);
    block(
      required(arm).filter((k) => k.startsWith(arm + ".")),
      arm + " installation failed",
    );
    return false;
  }
  try {
    await measure(arm + ".files", async () => {
      await fileControls(true, arm === "container", arm + ".files");
      assert.equal(rows["W2.baseline"].status, "PASS");
      assert.equal(rows["W2.denied"].status, "PASS");
    });
    const results = await both(arm, {
      denied: true,
      ids,
      baseline,
      container: arm === "container",
    });
    await measure(arm + ".reverse", () => reverse(arm === "container"));
    return (
      complete(results) &&
      required(arm)
        .filter((k) => k.startsWith(arm + ".") && k.endsWith(".errno"))
        .every((k) => rows[k].status === "PASS") &&
      rows[arm + ".reverse"].status === "PASS"
    );
  } finally {
    await stopOwned();
    const receipts = await stopPolicy(arm);
    await measure(arm + ".restored", async () => {
      assert.ok(restoredTransactions(ids?.transactions, receipts));
      const controls = await both(arm + "-removed");
      assert.ok(complete(controls));
      return controls;
    });
  }
}
async function primitives() {
  ctx.accounts = await rpc("prepare");
  await stage();
  await layout(true);
  try {
    note("hosted cmdlet help", await rpc("help"));
  } catch (e) {
    note("cmdlet help unavailable", safe(e));
  }
  try {
    note("desktop descriptor preflight", { descriptor: await rpc("desktop-preflight") });
  } catch (e) {
    note("desktop preflight failed", safe(e));
  }
  await measure("W1.logonRights", async () => {
    const rights = await rpc("rights");
    note("interactive logon policy", rights);
    assert.ok(rights.length);
    return { rights };
  });
  try {
    await standard();
  } catch (e) {
    row("W1.identity", "FAIL", { error: safe(e) });
    block(["W1.window", "W1.profile"], safe(e));
    note("standard launch failed", { error: safe(e) });
    await stopOwned();
  }
  await measure("W6.forced", forced);
  // Baselines stay in place until all restricted and restoration reads finish.
  await measure("W2.baseline", async () => {
    await acl(false);
    await fileControls(false, false, "W2.baseline");
  });
  await receivers();
  const netBase = await both("baseline");
  await measure("W3.baseline", async () => {
    assert.ok(complete(netBase));
    return netBase;
  });
  await measure("W3.firewall", async () => {
    const effective = await rpc("firewall", { exe: ctx.node });
    note("Defender comparator", effective);
    const results = await both("firewall");
    note("Defender classified outcomes", results);
    const labels = [...new Set([...endpoints, ...ctx.advertised.map((e) => e.label)])];
    const observed = ["delivered", "observed non-delivery"];
    const incomplete = [];
    for (const who of ["subject", "child"])
      for (const label of labels) {
        const key = who + "." + label,
          sample = results[key];
        if (
          netBase[key] !== true ||
          !observed.includes(sample?.node) ||
          !observed.includes(sample?.native)
        ) {
          incomplete.push({ key, baseline: netBase[key] ?? null, comparison: sample ?? null });
        }
      }
    note("Defender comparison coverage", { labels, incomplete });
    let rev, reverseError;
    try {
      rev = await reverse(false);
      note("comparator reverse", rev);
    } catch (error) {
      reverseError = safe(error);
      note("comparator reverse unavailable", { error: reverseError });
    }
    assert.ok(
      !incomplete.length &&
        ctx.listeners.length === ctx.advertised.length &&
        ctx.listeners.length >= 6 &&
        Object.keys(results).length === 2 * ctx.listeners.length &&
        labels.every((label) => ctx.listeners.some((e) => e.label === label)) &&
        complete(netBase),
      "Incomplete Defender comparison: " + incomplete.map((e) => e.key).join(", "),
    );
    assert.equal(effective.action, "Block");
    assert.equal(effective.enabled, "True");
    assert.equal(effective.direction, "Outbound");
    assert.ok(rev, reverseError || "Missing comparator reverse");
    return { effective, positiveControls: results, reverse: rev };
  });
  const removed = await measure("W3.firewallRemoved", async () => {
    const results = await restore("firewall");
    assert.ok(results.length > 0);
    return { results };
  });
  let installedFiles;
  await measure("W2.denied", async () => {
    installedFiles = await acl(true);
    await fileControls(true, false, "W2.denied");
    assert.equal(rows["W2.baseline"].status, "PASS");
  });
  try {
    if (removed) {
      ctx.wfpFailed = !(await primitiveArm("wfp", netBase));
      checkpoint();
      if (ctx.wfpFailed) {
        await rpc("verify-wfp-absent");
        const fallbackBase = await both("pre-container-standard");
        await primitiveArm("container", fallbackBase);
        checkpoint();
      }
    } else
      block(
        required("wfp").filter((k) => k.startsWith("wfp.")),
        "Defender rule removal unverified",
      );
  } finally {
    await stopOwned();
    const receipts = await undoFile();
    await measure("W2.restored", async () => {
      assert.ok(
        restoredTransactions(installedFiles, receipts),
        "No verified deny/removal transaction",
      );
      await fileControls(false, false, "W2.restored");
      await originalFiles();
    });
    await measure("W3.restored", async () => {
      assert.ok(["wfp", "container"].some((arm) => rows[arm + ".restored"]?.status === "PASS"));
      const r = await both("restored");
      assert.ok(complete(r));
      return r;
    });
    await restore("desktop");
  }
  checkpoint();
}
async function packaged() {
  assert.ok(fs.existsSync(state), "Missing primitive continuation");
  Object.assign(ctx, JSON.parse(fs.readFileSync(state)));
  await layout(false);
  assert.deepEqual(ctx.paths, ctx.baselinePaths, "Canonical paths changed across phases");
  assert.deepEqual(ctx.hashes, ctx.baselineHashes, "File controls changed across phases");
  assert.equal(ctx.accounts.subject.sid, ctx.sid, "Subject SID changed across phases");
  assert.equal(
    fs.readFileSync(path.join(out, "build.exit"), "utf8").trim(),
    "0",
    "Native build failed",
  );
  if (!(await measure("W5.copy", copyPackage))) throw Error("Copy control failed");
  if (rows["W1.window"].status !== "PASS") throw Error("Usable standard desktop missing");
  await acl(false);
  await receivers();
  const base = {};
  await product("startup", base, null);
  await stopOwned();
  if (
    rows["W5.startup.identity"].status !== "PASS" ||
    rows["W5.startup.renderer"].status !== "PASS"
  )
    throw Error("Packaged startup control failed");
  for (const arm of ctx.wfpFailed ? ["wfp", "container"] : ["wfp"]) {
    if (rows[arm + ".policy"].status !== "PASS") {
      block(
        required(arm).filter((k) => k.startsWith("W5." + arm) || k.startsWith("W6." + arm)),
        arm + " primitive policy unavailable",
      );
      continue;
    }
    let files, ids;
    try {
      files = await acl(true);
      ids = await policy(arm);
      await product(arm, base, ids);
    } catch (e) {
      block(
        Object.keys(rows).filter(
          (k) => k.startsWith("W5." + arm + ".") || k.startsWith("W6." + arm + "."),
        ),
        safe(e),
      );
    } finally {
      await stopOwned();
      const receipts = {};
      for (const [name, remove] of [
        ["network", () => stopPolicy(arm)],
        ["files", undoFile],
      ]) {
        try {
          receipts[name] = await remove();
        } catch (e) {
          note("arm rollback failure", { arm, name, error: safe(e) });
        }
      }
      await measure("W5." + arm + ".restored", async () => {
        assert.ok(
          restoredTransactions(ids?.transactions, receipts.network),
          "No verified network transaction",
        );
        assert.ok(restoredTransactions(files, receipts.files), "No verified file transaction");
        await fileControls(false);
        assert.ok(complete(await both("package-restored-" + arm)));
      });
      assert.ok(receipts.network && receipts.files, "Outstanding rollback before next arm");
    }
  }
  await originalFiles();
}
async function cleanup() {
  await stopOwned();
  recoverUtilities(process.env.W17_OUT, note);
  const before = await rpc("tree");
  assert.deepEqual(await rpc("births"), []);
  assert.equal(before.length, 0, "Matching staged process remains");
  const recovered = await rpc("recover-policy");
  note("prior phase recovery", recovered);
  const { entries } = await rpc("state");
  let profileError;
  try {
    if (entries.length) {
      assert.equal(entries.length, 1);
      const data = entries[0].data;
      assert.ok(
        data.name === ctx.name &&
          data.owner === ctx.accounts.subject.sid &&
          data.sid === data.before?.container &&
          containerAbsent(data.before),
      );
      const query = async (action, ...receipt) => {
        const r = await native([action, ctx.name, ...receipt], { desktop: false });
        assert.equal(r.token.sid, data.owner);
        assert.equal(r.container, data.sid);
        assert.ok(
          sameFolder(r.expectedFolder, data.before.expectedFolder),
          "Expected profile folder changed",
        );
        if (data.folder) assert.ok(sameFolder(data.folder, r.expectedFolder));
        if (r.folder) assert.ok(sameFolder(r.folder, r.expectedFolder));
        return r;
      };
      let current = await query("container-query");
      if (!containerAbsent(current)) {
        assert.ok(
          data.created === true &&
            data.folderId &&
            current.folderId === data.folderId &&
            current.mapping === 0 &&
            current.query === 0 &&
            current.folderError === 0 &&
            current.expectedFolderError === 0 &&
            current.knownFolderResult === 0 &&
            sameFolder(current.folder, data.folder),
          "Profile ownership unresolved",
        );
        current = await query("container-delete", data.owner, data.sid, data.folder, data.folderId);
      }
      assert.ok(containerAbsent(current), "AppContainer absence unverified");

      await rpc("container-gone");
    }
  } catch (e) {
    profileError = safe(e);
    note("profile reconciliation incomplete", profileError);
  }
  const results = await rpc("cleanup");
  note("cleanup resource results", results);
  assert.ok(!profileError, profileError);
  assert.ok(
    recovered.every((r) => r.restored),
    "Outstanding policy recovery failed",
  );
  assert.ok(
    results.every((r) => r.restored),
    "An owned resource remains",
  );
  await rpc("verify-wfp-absent");
  const final = await rpc("tree");
  assert.equal(final.length, 0);
  assert.deepEqual(await rpc("births"), []);
  assert.ok(!fs.existsSync(ctx.stage));
  return { before, final, entries: results.length, verified: await rpc("final") };
}
save();
try {
  if (phase === "primitives") row("W2.realCheckout", "NOT RUN", { reason: checkoutScope });
  startBroker();
  Object.assign(ctx, await rpc("host", { controllerPid: process.pid }));
  dirs();
  note("host", {
    ...ctx,
    sha: process.env.GITHUB_SHA,
    image: process.env.ImageVersion,
    imageOS: process.env.ImageOS,
    node: process.version,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    src,
  });
  if (phase !== "cleanup") {
    const host = await measure("host", async () => {
      assert.equal(ctx.arch, "X64");
      assert.equal(process.arch, "x64");
      assert.match(process.version, /^v24\./);
      assert.equal(ctx.admin, true);
      assert.equal(ctx.bfe, "Running");
      return { arch: ctx.arch, build: ctx.build, bfe: ctx.bfe };
    });
    if (!host) throw Error("Windows runtime prerequisites failed");
  }
  if (phase === "primitives") {
    for (const arm of ["wfp", "container"]) {
      row(arm + ".external", "NOT RUN", {
        reason: "No independent off-host nonce receiver supplied",
      });
      row(arm + ".dns", "NOT RUN", {
        reason: "No controlled DNS name and authoritative query receipts supplied",
      });
    }
    await primitives();
  } else if (phase === "package") await packaged();
  else if (phase === "cleanup") {
    let result;
    // Profile service may still be unloading the last logon hive.
    for (let i = 0; i < 3; i++) {
      try {
        result = await cleanup();
        break;
      } catch (e) {
        note("cleanup retry", { attempt: i + 1, error: safe(e) });
        if (i === 2) throw e;
        await sleep(1000);
      }
    }
    row("cleanup", "PASS", result);
  } else throw Error("Unknown phase");
  row("phase." + phase, "PASS", { meaning: "controller completed" });
} catch (e) {
  const detail = { error: safe(e) };
  row("phase." + phase, "FAIL", detail);
  if (phase === "cleanup") row("cleanup", "FAIL", detail);
  if (phase === "package")
    block(
      Object.keys(rows).filter(
        (k) => k.startsWith("W5.") || (k.startsWith("W6.") && k !== "W6.forced"),
      ),
      detail.error,
    );
  console.error(detail.error);
  process.exitCode = 1;
} finally {
  try {
    await stopOwned();
    if (phase !== "cleanup") {
      for (const [kind, scope] of [
        ["wfp"],
        ["firewall"],
        ["audit"],
        ["tree-acl"],
        ["acl", "baseline"],
        ["acl", "container"],
        ["desktop"],
      ])
        await restore(kind, scope);
    }
  } catch (e) {
    row("phase." + phase, "FAIL", { error: safe(e) });
    process.exitCode = 1;
  }
  // Receiver sockets belong to this phase broker and close on broker exit.
  try {
    await closeBroker();
  } catch (e) {
    row("phase." + phase, "FAIL", { error: safe(e) });
    process.exitCode = 1;
  }
  note("phase exit", { phase, exit: process.exitCode ?? 0 });
}
