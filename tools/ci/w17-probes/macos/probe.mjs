import { recoverUtilities } from "../diagnostics.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
  command,
  sudo,
  j,
  checkpoint,
  journalLedger,
  ledger,
  note,
  row,
  measured,
  blocked,
  blockPrefix,
  init,
  sanitize,
} from "./context.mjs";
import { account, ownedUser, users, gui, compile, stageClients, removeAgent } from "./account.mjs";
import {
  paths,
  reads,
  aclTrial,
  protectController,
  allowBaseline,
  restoreACL,
  baselineOK,
} from "./acl.mjs";
import { inspectPF, removePF, manuals } from "./pf.mjs";
import { receivers, primitivesNetwork } from "./network.mjs";
import { processes, stopOwned, forcedTree } from "./processes.mjs";
import { product } from "./product.mjs";
import { checkoutScope, requiredFor } from "./verdict.mjs";

const phase = process.argv[2];
assert.ok(["primitives", "package", "cleanup"].includes(phase));
assert.equal(process.platform, "darwin");
assert.notEqual(process.getuid(), 0, "controller must be the job user");
async function restoreFiles() {
  restoreACL();
  if (!j.primitiveACL) {
    blocked(["M3.restored"], "full primitive ACL candidate was not installed");
    return;
  }
  try {
    allowBaseline();
    measured("M3.restored", baselineOK(reads("policy removed")));
  } finally {
    restoreACL();
  }
}
async function primitives() {
  init();
  row("M3.realCheckout", "NOT RUN", checkoutScope);
  const arch = command("/usr/bin/uname", ["-m"]).stdout.trim();
  const os = command("/usr/bin/sw_vers").stdout;
  note("host", {
    os,
    arch,
    node: process.version,
    sha: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    image: process.env.ImageVersion ?? null,
    controller: command("/usr/bin/id").stdout,
    console: command("/usr/bin/stat", ["-f", "%Su", "/dev/console"]).stdout,
  });
  measured(
    "host",
    arch === "arm64" &&
      /^ProductVersion:\s*26[.\s]/m.test(os) &&
      process.versions.node.split(".")[0] === "24",
    { os, arch, node: process.version },
  );
  assert.equal(ledger.host.status, "PASS", "macos-26 arm64 / Node 24 required");
  command("/usr/sbin/sysadminctl", ["-h"], { check: false });
  command("/usr/bin/man", ["-w", "sysadminctl"], { check: false });
  try {
    manuals();
  } catch (e) {
    note("manual unavailable", e.message);
  }
  try {
    sudo(["/usr/bin/true"]);
    stageClients();
    account(protectController);
  } catch (e) {
    row("M1.identity", "BLOCKED", e.message);
    for (const prefix of ["M2.", "M3.", "M4."]) blockPrefix(prefix, "M1.identity: " + e.message);
    return;
  }
  try {
    await gui();
  } catch (e) {
    blockPrefix("M2.", e.message);
  }
  try {
    compile("access", "process.c", ["-lbsm", "-DSUBJECT_ACCESS_ONLY"]);
    j.processTool = process.env.W17_OUT + "/process";
    checkpoint();
    compile("process", "process.c", ["-lbsm"], j.processTool);
    await forcedTree();
  } catch (e) {
    row("M1.forcedTree", "FAIL", e.message);
  }
  try {
    compile("native", "native.c", []);
  } catch (e) {
    note("native helper unavailable", e.message);
  }
  try {
    paths();
    aclTrial();
  } catch (e) {
    blockPrefix("M3.", e.message);
  } finally {
    if (j.files)
      try {
        await restoreFiles();
      } catch (e) {
        row("M3.restored", "FAIL", e.message);
      }
  }
  row(
    "M4.external",
    "NOT RUN",
    "no orchestrator-controlled routed IPv4/IPv6 TCP/UDP receivers or remote nonce receipts supplied",
  );
  row(
    "M4.resolver",
    "NOT RUN",
    "no controlled unique DNS name and authoritative query receipts supplied",
  );
  const endpoints = await receivers();
  try {
    await primitivesNetwork(endpoints, inspectPF);
  } catch (e) {
    blockPrefix("M4.", e.message);
  } finally {
    for (const e of endpoints) e.close();
    removePF();
  }
}
async function packageProbe() {
  const prerequisites = ["M1.identity", "M2.gui"].filter((k) => ledger[k]?.status !== "PASS");
  if (prerequisites.length) {
    blockPrefix("M5.", prerequisites.join(", "));
    return;
  }
  assert.ok(ownedUser(), "original M1 identity missing");
  const build = process.env.W17_OUT + "/build.exit";
  if (
    (fs.existsSync(build) && fs.readFileSync(build, "utf8").trim() !== "0") ||
    (process.env.GITHUB_ACTIONS === "true" && !fs.existsSync(build))
  ) {
    blockPrefix("M5.", "build exit unavailable or nonzero");
    return;
  }
  assert.ok(
    !j.pfDirty &&
      !j.enablePending &&
      !j.pfToken &&
      Object.keys(j.acl).every((f) => j.guards?.includes(f)),
    "primitive restrictions still active",
  );
  note("product policy lifecycle", { uid: j.uid, guid: j.guid, route: j.route, reapplied: true });
  try {
    await product();
  } catch (e) {
    if (ledger["M5.copy"].status === "NOT RUN") row("M5.copy", "FAIL", e.message);
    blockPrefix("M5.", e.message);
    throw e;
  }
}
async function cleanup() {
  assert.ok(
    j.id && j.stage === "/private/tmp/kobrixa-w17-" + j.id,
    "missing or unexpected journal",
  );
  if (j.stageIdentity && fs.existsSync(j.stage)) {
    const s = fs.lstatSync(j.stage);
    assert.ok(
      s.isDirectory() &&
        s.uid === process.getuid() &&
        s.ino === j.stageIdentity.ino &&
        s.dev === j.stageIdentity.dev,
      "stage ownership changed",
    );
  }
  if (j.accountIntent && ownedUser()) {
    for (const a of [...j.agents]) removeAgent(a);
    if (processes().length && (!j.processTool || !fs.existsSync(j.processTool))) {
      j.processTool = process.env.W17_OUT + "/process";
      checkpoint();
      compile("process", "process.c", ["-lbsm"], j.processTool);
    }
    await stopOwned();
    assert.equal(processes().length, 0);
  } else assert.equal(j.agents.length, 0, "owned LaunchAgent absence unresolved");
  // Keep policy in force until the subject tree has stopped.
  const errors = [];
  for (const release of [removePF, () => restoreACL(true)]) {
    try {
      release();
    } catch (e) {
      errors.push(e.message);
    }
  }
  assert.ok(!errors.length, errors.join("\n"));
  if (j.accountIntent) {
    if (ownedUser()) {
      j.removalIntent = true;
      checkpoint();
      sudo(["/usr/sbin/sysadminctl", "-deleteUser", j.name, "-keepHome"], { timeout: 30000 });
      for (let i = 0; i < 10 && ownedUser(); i++) await delay(200);
    }
    assert.ok(
      !users().some(([name, uid]) => name === j.name || Number(uid) === j.uid),
      "directory record survived removal",
    );
    assert.equal(processes().length, 0);
  }
  if (fs.existsSync(j.stage)) {
    assert.ok(j.stageIdentity, "cannot establish ownership of partial staging directory");
    recoverUtilities(process.env.W17_OUT, note);
    sudo(["/bin/rm", "-rf", "--", j.stage]);
  }
  assert.ok(!fs.existsSync(j.stage) && !fs.existsSync(j.home), "stage/home still present");
  if (j.processTool) {
    fs.rmSync(j.processTool, { force: true });
    assert.ok(!fs.existsSync(j.processTool));
  }
  if (j.accountIntent && j.removalIntent)
    row("M1.removal", "PASS", { uid: j.uid, name: j.name, home: j.home });
  else blocked(["M1.removal"], "account creation unverified");
  row("cleanup", "PASS", {
    absentStage: j.stage,
    absentHome: j.home,
    originalPF: j.pfBefore ?? null,
    anchor: j.anchor ?? null,
    pendingACL: Object.keys(j.acl),
    agents: j.agents,
  });
}
try {
  if (phase === "primitives") await primitives();
  if (phase === "package") await packageProbe();
  if (phase === "cleanup") await cleanup();
  note("phase complete", { phase });
} catch (e) {
  const error = sanitize(e.message);
  note("phase error", { phase, error });
  console.error(error);
  if (phase === "cleanup") row("cleanup", "FAIL", error);
  if (phase === "package") blockPrefix("M5.", error);
  process.exitCode = 1;
} finally {
  const keys = requiredFor(ledger).filter((k) =>
    phase === "cleanup"
      ? ["cleanup", "M1.removal"].includes(k)
      : phase === "package"
        ? k.startsWith("M5.")
        : !k.startsWith("M5.") && !["M1.removal", "cleanup"].includes(k),
  );
  const incomplete = keys.filter((k) => ledger[k]?.status !== "PASS");
  if (incomplete.length || journalLedger.refused) process.exitCode = 1;
  note("phase exit", { phase, exit: process.exitCode ?? 0, incomplete });
}
