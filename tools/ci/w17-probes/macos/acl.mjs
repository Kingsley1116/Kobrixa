import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  command,
  sudo,
  subject,
  j,
  checkpoint,
  intent,
  note,
  root,
  hash,
  measured,
} from "./context.mjs";
import { nativeResult } from "./judge.mjs";
import { task, validIdentity } from "./account.mjs";
import { roles, fileRows } from "./verdict.mjs";

import { stagedSentinels } from "../sentinels.mjs";

function snapshot(file) {
  const stat = fs.lstatSync(file);
  assert.ok(!stat.isSymbolicLink(), "ACL target became a symlink");
  const listing = command("/bin/ls", ["-led", file]).stdout.trimEnd().split("\n");
  const entries = listing.slice(1).map((line) => {
    const m = /^\s*\d+: (.+)$/.exec(line);
    assert.ok(m, "unrecognized ACL");
    return m[1];
  });
  if (stat.isFile()) assert.equal(stat.nlink, 1, "multiply linked ACL target");
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode, entries };
}
// chmod and ls can order the permission names differently within one ACE.
// Keep ACE order, object identity, principal and all rights in the comparison.
function canonical(descriptor) {
  return {
    ...descriptor,
    entries: descriptor.entries.map((e) => {
      const fields = e.split(" ");
      fields.push(fields.pop().split(",").sort().join(","));
      return fields.join(" ");
    }),
  };
}
function ace(file, entry) {
  const before = snapshot(file);
  assert.notEqual(before.uid, j.uid);
  const tx = (j.acl[file] ??= { before });
  if (tx.installed) assert.deepEqual(before, tx.installed, "conflicting ACL before mutation");
  const ace = "user:" + j.name + " ";
  assert.ok(!before.entries.some((e) => e === ace + entry));

  tx.installed = { ...before, entries: [ace + entry, ...before.entries] };
  checkpoint();
  sudo(["/bin/chmod", "+a#", "0", "user:" + j.name + " " + entry, file]);
  const after = snapshot(file);
  assert.equal(after.entries.length, before.entries.length + 1);
  assert.deepEqual(after.entries.slice(1), before.entries);
  assert.deepEqual(canonical(after), canonical(tx.installed));
  tx.installed = after;
  checkpoint();
  note("ACL mutation", { file, before, after });
  assert.ok(after.entries.some((line) => line.includes(j.name)));
}
export function restoreACL(includeGuards = false) {
  const errors = [];
  for (const [file, { before, installed }] of Object.entries(j.acl).reverse()) {
    if (!includeGuards && j.guards?.includes(file)) continue;
    try {
      const current = snapshot(file);
      for (const k of ["ino", "dev", "uid", "gid", "mode"])
        assert.equal(current[k], before[k], "ACL object changed: " + file);
      if (JSON.stringify(current.entries) !== JSON.stringify(before.entries)) {
        assert.ok(installed, "no verified installed ACL");
        assert.deepEqual(canonical(current), canonical(installed), "conflicting ACL: " + file);
        if (before.entries.length)
          sudo(["/bin/chmod", "-E", file], { input: before.entries.join("\n") + "\n" });
        else sudo(["/bin/chmod", "-N", file]);
      }
      assert.deepEqual(snapshot(file), before);
      note("ACL restored", { file, before });
      delete j.acl[file];
      checkpoint();
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length) throw Error(errors.join("\n"));
}
export function protectController() {
  const dir = fs.realpathSync(process.env.RUNNER_TEMP ?? process.env.W17_OUT);
  assert.ok(!root.startsWith(dir + "/") && !j.stage.startsWith(dir + "/"));
  j.guards = [dir];
  checkpoint();
  ace(dir, "deny search,list");
}
export function paths() {
  intent("stage aliases and baseline control", j.stage, "remove stage");
  const git = command("/usr/bin/git", ["rev-parse", "--git-common-dir"]).stdout.trim();
  const checkout = path.dirname(fs.realpathSync(path.resolve(root, git)));
  const dep = fs.realpathSync(
    createRequire(root + "/apps/desktop/package.json").resolve("zod/package.json"),
  );
  const idx = dep.indexOf("/node_modules/");
  assert.ok(idx > 0);
  const sourceRoots = { checkout, worktree: root, dependency: dep.slice(0, idx) + "/node_modules" };
  const sources = {
    checkout: fs.realpathSync(checkout + "/package.json"),
    worktree: fs.realpathSync(root + "/package.json"),
    dependency: dep,
  };
  const copy = stagedSentinels(j.stage, sourceRoots, sources, true);
  j.roots = copy.roots;
  j.files = copy.files;
  note("sentinel source provenance", { sourceRoots, sources });
  for (const [label, r] of Object.entries(j.roots)) {
    assert.ok(!j.stage.startsWith(r + "/") && j.files[label].startsWith(r + "/"));
    const alias = j.stage + "/" + label + "-alias";
    fs.symlinkSync(r, alias);
    j.files[label + "Alias"] = path.join(alias, path.relative(r, j.files[label]));
  }
  fs.copyFileSync(j.files.checkout, j.stage + "/control.json");
  fs.chmodSync(j.stage + "/control.json", 0o444);
  j.hashes = Object.fromEntries(Object.entries(j.files).map(([k, f]) => [k, hash(f)]));
  note("roots and aliases", { roots: j.roots, paths: j.files, hashes: j.hashes });
  checkpoint();
}
export function allowBaseline() {
  for (const file of new Set(Object.values(j.files).map((p) => fs.realpathSync(p)))) {
    assert.ok(file.startsWith(j.stage + "/sentinels/"));
    assert.equal(
      subject(["/bin/test", "-r", file], { check: false }).code,
      0,
      "staged baseline unreadable",
    );
  }
}
export function deny() {
  for (const file of new Set([
    ...Object.values(j.roots),
    ...Object.values(j.files).map((p) => fs.realpathSync(p)),
  ])) {
    assert.equal(
      subject(["/bin/test", "-w", file], { check: false }).code,
      1,
      "subject may write protected object",
    );
    ace(
      file,
      fs.statSync(file).isDirectory()
        ? "deny list,search,readattr,file_inherit,directory_inherit"
        : "deny read,readattr",
    );
  }
}
export function reads(label) {
  const results = {};
  for (const role of roles) {
    const r = task({ action: "files", paths: j.files }, role);
    assert.ok(validIdentity(r, role));
    results[role] = r.files;
    note("opens", { label, role, result: r });
  }
  return results;
}
export function baselineOK(r) {
  return roles.every((role) => fileRows.every((f) => r[role][f]?.hash === j.hashes[f]));
}
export function positive() {
  const controller = Object.entries(j.files).map(([k, p]) => hash(p) === j.hashes[k]);
  const observations = roles.map((role) => {
    const r = task({ action: "files", paths: { copy: j.stage + "/control.json" } }, role);
    const w = task({ action: "profile", path: j.home + "/profile/control-" + role }, role);
    return (
      validIdentity(r, role) &&
      validIdentity(w, role) &&
      r.files.copy.hash === j.hashes.checkout &&
      w.roundTrip
    );
  });
  return [...controller, ...observations].every(Boolean);
}
export function aclTrial() {
  allowBaseline();
  const before = reads("baseline");
  deny();
  j.primitiveACL = true;
  checkpoint();
  const after = reads("policy");
  const controls = positive();
  measured("M3.positive", controls);
  for (const role of roles)
    for (const f of fileRows) {
      const native = task({ action: "native", args: ["open", j.files[f]] }, role);
      note("native file attempt", { role, file: f, native });
      const ok =
        before[role][f].hash === j.hashes[f] &&
        ["EACCES", "EPERM"].includes(after[role][f].code) &&
        validIdentity(native, role) &&
        nativeResult(native, j.uid, "open") &&
        controls;
      measured(`M3.${role}.${f}`, ok, { before: before[role][f], after: after[role][f], native });
    }
}
