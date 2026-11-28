import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  command,
  sudo,
  subject,
  envArgs,
  j,
  checkpoint,
  intent,
  ledger,
  note,
  row,
  measured,
  blocked,
  src,
  hash,
} from "./context.mjs";

const ds = (args, opts) => command("/usr/bin/dscl", [".", ...args], opts);
export function users() {
  return ds(["-list", "/Users", "UniqueID"], { privateOutput: true })
    .stdout.trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/));
}
export function ownedUser() {
  const rows = users().filter(([n, u]) => n === j.name || Number(u) === j.uid);
  if (!rows.length) return false;
  assert.deepEqual(rows, [[j.name, String(j.uid)]], "user/UID no longer unique and owned");
  assert.equal(
    ds(["-read", "/Users/" + j.name, "NFSHomeDirectory"]).stdout.trim(),
    "NFSHomeDirectory: " + j.home,
  );
  if (j.guid)
    assert.equal(
      ds(["-read", "/Users/" + j.name, "GeneratedUID"]).stdout.trim(),
      "GeneratedUID: " + j.guid,
    );
  return true;
}
export function stageClients() {
  intent("stage read-only client executables and script", j.stage, "remove stage");
  for (const exe of [j.node, j.child]) {
    fs.copyFileSync(process.execPath, exe);
    fs.chmodSync(exe, 0o555);
  }
  const staged = [process.execPath, j.node, j.child];
  for (const name of ["client.cjs", "electron.cjs"]) {
    const from = src + "/" + name,
      to = j.stage + "/" + name;
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o444);
    staged.push(from, to);
    assert.equal(hash(from), hash(to));
  }
  note("staged clients", Object.fromEntries(staged.map((p) => [p, hash(p)])));
}
export function compile(name, source, flags, destination) {
  const exe = destination ?? j.stage + "/" + name;
  intent("compile helper", exe, destination ? "remove controller helper" : "remove stage");
  command("/usr/bin/clang", [src + "/" + source, ...flags, "-o", exe], { timeout: 60000 });
  fs.chmodSync(exe, 0o555);
  note("compiled", { source, sourceHash: hash(src + "/" + source), exe, hash: hash(exe) });
}
export function task(data, role = "subject") {
  if (data.action === "profile") intent("profile challenge", data.path, "remove home");
  const args = [
    j.node,
    j.stage + "/client.cjs",
    JSON.stringify(role === "child" ? { ...data, child: j.child } : data),
  ];
  return JSON.parse(subject(args).stdout);
}
export function validIdentity(result, role) {
  return (
    result.uid === j.uid &&
    result.euid === j.uid &&
    result.exe === (role === "child" ? j.child : j.node) &&
    (role !== "child" ||
      (result.parent?.uid === j.uid &&
        result.ppid === result.parent.pid &&
        result.parent.exe === j.node))
  );
}
export function account(protectController) {
  const all = users();
  assert.ok(!all.some(([n]) => n === j.name));
  j.uid = randomInt(51000, 61000);
  assert.ok(!all.some(([, u]) => Number(u) === j.uid));
  j.accountIntent = true;
  checkpoint();
  const credential = randomBytes(36).toString("base64url");
  // sysadminctl's '-' requests stdin/terminal input. An unavailable prompt is a
  // measured blocker. Keep both its input and potentially echoed output private.
  const add = sudo(
    [
      "/usr/sbin/sysadminctl",
      "-addUser",
      j.name,
      "-UID",
      String(j.uid),
      "-home",
      j.home,
      "-password",
      "-",
    ],
    {
      input: credential + "\n" + credential + "\n",
      privateOutput: true,
      check: false,
      timeout: 30000,
    },
  );
  note("account service", {
    code: add.code,
    signal: add.signal,
    diagnostic: (add.stderr + add.stdout)
      .replaceAll(credential, "[redacted]")
      .replace(/[^\n]*password[^\n]*/gi, "[credential prompt]")
      .slice(-2000),
  });
  assert.ok(ownedUser(), "directory service record missing");
  j.guid = ds(["-read", "/Users/" + j.name, "GeneratedUID"])
    .stdout.trim()
    .split(/\s+/)
    .at(-1);
  checkpoint();
  protectController();
  intent("create private profile and temp", j.home, "remove home");
  subject(["/bin/mkdir", "-p", j.home + "/tmp", j.home + "/profile"]);
  subject(["/bin/chmod", "700", j.home, j.home + "/tmp", j.home + "/profile"]);
  const id = task({ action: "identity" });
  const groups = subject(["/usr/bin/id", "-Gn"]).stdout.trim().split(/\s+/);
  const privilege = subject(["/usr/bin/sudo", "-n", "/usr/bin/true"], { check: false });
  const grants = sudo(["/usr/bin/sudo", "-n", "-l", "-U", j.name], { check: false });
  const standard =
    add.code === 0 &&
    validIdentity(id, "subject") &&
    id.home === j.uid &&
    j.uid !== 0 &&
    j.uid !== process.getuid() &&
    !groups.includes("admin") &&
    !groups.includes("wheel") &&
    privilege.code === 1 &&
    grants.code === 1 &&
    /not allowed|may not run sudo/i.test(grants.stdout + grants.stderr);
  measured("M1.identity", standard, { id, groups, privilege: privilege.code, grants: grants.code });
  assert.ok(standard, "standard identity or privilege controls failed");
}
const xml = (s) =>
  String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
export function agent(args, label) {
  const name = "org.kobrixa.w17." + j.id + "." + label;
  const service = "gui/" + j.uid + "/" + name,
    base = j.stage + "/" + label;
  const record = { service, base };
  j.agents.push(record);
  checkpoint();
  for (const ext of [".out", ".err"]) {
    fs.writeFileSync(base + ext, "", { flag: "wx" });
    command("/bin/chmod", ["+a", "user:" + j.name + " allow write,append", base + ext]);
  }
  const str = (s) => "<string>" + xml(s) + "</string>";
  fs.writeFileSync(
    base + ".plist",
    `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key>${str(name)}<key>LimitLoadToSessionType</key><string>Aqua</string><key>ProgramArguments</key><array>${[...envArgs(), ...args].map(str).join("")}</array><key>WorkingDirectory</key>${str(j.cwd)}<key>StandardOutPath</key>${str(base + ".out")}<key>StandardErrorPath</key>${str(base + ".err")}<key>RunAtLoad</key><true/></dict></plist>`,
  );
  fs.chmodSync(base + ".plist", 0o644);
  sudo(["/usr/sbin/chown", "root:wheel", base + ".plist"]);
  sudo(["/bin/launchctl", "bootstrap", "gui/" + j.uid, base + ".plist"]);
  return record;
}
export function removeAgent(record) {
  const check = () =>
    sudo(["/bin/launchctl", "print", record.service], { check: false, privateOutput: true });
  if (check().code === 0) sudo(["/bin/launchctl", "bootout", record.service]);
  const after = check();
  assert.ok(
    after.code !== 0 &&
      /could not find|not found|no such process/i.test(after.stderr + after.stdout),
    "agent absence unverified",
  );
  j.agents = j.agents.filter((a) => a.service !== record.service);
  checkpoint();
}
function domain(who, kind) {
  const r = sudo(["/bin/launchctl", "print", kind + "/" + who], {
    privateOutput: true,
    check: false,
  });
  note("bootstrap domain", {
    who,
    kind,
    code: r.code,
    error: r.stderr.trim(),
    header: r.stdout.split("\n")[0],
    metadata: r.stdout
      .split("\n")
      .filter((l) => /^\s*(?:type|handle|creator|audit session|security context) = /.test(l))
      .slice(0, 8),
  });
  return r.code === 0;
}
function guiOK(r, uid, controller) {
  return (
    r.uid === uid &&
    Number.isInteger(r.asid) &&
    r.asid > 0 &&
    (r.sessionUID === uid ||
      (controller?.status === "PASS" &&
        r.sessionUID === controller.detail.sessionUID &&
        r.asid === controller.detail.asid)) &&
    !!r.loggedIn &&
    r.visible &&
    r.callback &&
    r.window > 0 &&
    r.ownerPID === r.pid
  );
}
export async function gui() {
  for (const uid of [process.getuid(), j.uid]) domain(uid, "user");
  domain(process.getuid(), "gui");
  const hasGUI = domain(j.uid, "gui");
  row(
    "M2.unattendedLogin",
    "NOT RUN",
    "no documented non-disruptive second-login route identified in W17P",
  );
  const win = j.stage + "/window";
  try {
    compile("window", "window.m", [
      "-fobjc-arc",
      "-framework",
      "AppKit",
      "-framework",
      "CoreGraphics",
      "-lbsm",
    ]);
  } catch (e) {
    blocked(
      ["M2.controller", "M2.ordinary", "M2.asuser", "M2.agent", "M2.gui", "M2.focus"],
      e.message,
    );
    return;
  }
  for (const route of ["controller", "ordinary", "asuser", "agent"]) {
    if (route === "agent" && !hasGUI) {
      row("M2.agent", "BLOCKED", "no subject gui/<uid> domain");
      continue;
    }
    let record;
    try {
      let stdout;
      if (route === "agent") {
        record = agent([win], "windowprobe");
        for (
          let i = 0;
          i < 30 && !fs.readFileSync(record.base + ".out", "utf8").includes("\n");
          i++
        )
          await delay(200);
        stdout = fs.readFileSync(record.base + ".out", "utf8");
      } else if (route === "controller") stdout = command(win, [], { cwd: j.cwd }).stdout;
      else if (route === "asuser")
        stdout = sudo(
          [
            "/bin/launchctl",
            "asuser",
            String(j.uid),
            "/usr/bin/sudo",
            "-n",
            "-u",
            j.name,
            ...envArgs(),
            win,
          ],
          { cwd: j.cwd },
        ).stdout;
      else stdout = subject([win]).stdout;
      const r = JSON.parse(stdout);
      const ok = guiOK(
        r,
        route === "controller" ? process.getuid() : j.uid,
        ledger["M2.controller"],
      );
      measured("M2." + route, ok, r);
      if (ok && route !== "controller" && !j.route) {
        j.route = route;
        j.asid = r.asid;
        checkpoint();
      }
    } catch (e) {
      row("M2." + route, "FAIL", e.message);
    } finally {
      if (record) removeAgent(record);
    }
  }
  if (!j.route) {
    blocked(["M2.gui", "M2.focus"], "hosted GUI blocked: no verified unattended subject route");
    return;
  }
  const r = ledger["M2." + j.route].detail;
  row("M2.gui", "PASS", { route: j.route, existingSubjectGUI: hasGUI, asid: r.asid });
  measured("M2.focus", r.focused && r.defocused && r.refocused, r);
}
