import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ctx, src, out, actor, rpc, intent, digest, restore, note, row, rows } from "./context.mjs";

import { stagedSentinels } from "../sentinels.mjs";

export async function stage() {
  for (const [from, to] of [
    [process.execPath, ctx.node],
    [process.execPath, ctx.child],
    [path.join(out, "subject.exe"), ctx.native],
    [path.join(out, "subject.exe"), path.join(ctx.bin, "native-child.exe")],
    [path.join(src, "client.cjs"), ctx.client],
    [path.join(src, "../macos/electron.cjs"), path.join(ctx.bin, "electron.cjs")],
    [path.resolve("package.json"), path.join(ctx.bin, "positive.json")],
  ]) {
    await intent("stage-file", { path: to });
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    await rpc("stage-created", { items: [{ path: to }] });
    assert.equal(digest(from), digest(to));
    note("stage", { from, to, sha256: digest(to) });
  }
  for (const f of [
    "controller.cpp",
    "tree-acl.cpp",
    "subject.cpp",
    "token.hpp",
    "bridge.cs",
    "receivers.cs",
  ])
    note("helper source", { file: f, sha256: digest(path.join(src, f)) });
  note("controller DLL", { sha256: digest(path.join(out, "controller.dll")) });
}
export async function layout(make) {
  const work = fs.realpathSync("."),
    common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
  const checkout = path.dirname(fs.realpathSync(path.resolve(common)));
  const dep = fs.realpathSync(
    createRequire(path.join(work, "apps/desktop/package.json")).resolve("zod/package.json"),
  );
  const index = dep.toLowerCase().indexOf("\\node_modules\\");
  assert.ok(index > 0);
  const depRoot = dep.slice(0, index) + "\\node_modules";
  const sourceRoots = { checkout, worktree: work, dependency: depRoot };
  const sources = {
    checkout: path.join(checkout, "package.json"),
    worktree: path.join(work, "package.json"),
    dependency: dep,
  };
  const copy = stagedSentinels(ctx.stage, sourceRoots, sources, make);
  if (make) {
    const items = new Map();
    for (const file of Object.values(copy.files)) {
      const parents = [];
      for (let dir = path.dirname(file); dir !== ctx.stage; dir = path.dirname(dir))
        parents.unshift(dir);
      for (const parent of parents) items.set(parent, { path: parent, directory: true });
      items.set(file, { path: file });
    }
    await rpc("stage-created", { items: [...items.values()] });
  }
  ctx.roots = copy.roots;
  ctx.paths = copy.files;
  note("sentinel source provenance", { sourceRoots, sources });
  for (const [key, root] of Object.entries(ctx.roots)) {
    const file = ctx.paths[key];
    assert.ok(!ctx.stage.toLowerCase().startsWith(root.toLowerCase() + "\\"));
    const alias = path.join(ctx.stage, "aliases", key);
    if (make) {
      await intent("junction", { path: alias, target: root });
      fs.symlinkSync(root, alias, "junction");
      await rpc("stage-created", { items: [{ path: alias, directory: true, junction: true }] });
    }
    ctx.paths[key + "Alias"] = path.join(alias, path.relative(root, file));
  }
  ctx.paths.staged = path.join(ctx.bin, "positive.json");
  ctx.originalDacl = {};
  for (const name of new Set([
    ...Object.values(ctx.roots),
    ...["checkout", "worktree", "dependency"].map((k) => ctx.paths[k]),
  ]))
    ctx.originalDacl[name] = await rpc("section", { path: name });
  note("original protected paths", ctx.originalDacl);
  ctx.hashes = Object.fromEntries(Object.entries(ctx.paths).map(([k, p]) => [k, digest(p)]));
  note("canonical roots and alias controls", {
    roots: ctx.roots,
    paths: ctx.paths,
    hashes: ctx.hashes,
  });
}
export async function acl(on) {
  const sid = ctx.accounts.subject.sid;
  if (on) {
    const roots = [...new Set(Object.values(ctx.roots).map((p) => fs.realpathSync(p)))];
    const transactions = [];
    for (const root of roots.filter(
      (r) =>
        !roots.some(
          (parent) => r !== parent && r.toLowerCase().startsWith(parent.toLowerCase() + path.sep),
        ),
    )) {
      const result = await rpc("deny-tree", { path: root });
      transactions.push(result.id);
      note("handle-scoped NTFS deny", result);
    }
    for (const file of Object.keys(ctx.originalDacl))
      note("active DACL", { file, descriptor: await rpc("section", { path: file }) });
    return transactions;
  }
  for (const file of new Set([
    ...Object.values(ctx.roots),
    ...["checkout", "worktree", "dependency"].map((k) => ctx.paths[k]),
  ])) {
    const observation = await rpc("acl", {
      path: file,
      sid,
      rights: "ReadAndExecute",
      inherit: "None",
      type: "Allow",
      scope: "baseline",
    });
    note("acl", observation);
  }
}
export async function fileControls(denied, container = false, prefix) {
  const labels = Object.keys(ctx.paths);
  const outcomes = [];
  for (const child of [false, true]) {
    const [node, native] = await actor(
      {
        action: "batch",
        tasks: [
          {
            action: "files",
            paths: ctx.paths,
            writable: path.join(ctx.accounts.subject.home, "Temp", "roundtrip"),
          },
          { action: "native", child, args: ["files", ...Object.values(ctx.paths)] },
        ],
      },
      { child, container },
    );
    note("file opens", { child, denied, node, native });
    const who = child ? "child" : "subject";
    const identity =
      native.exit === 0 &&
      native.token?.sid === ctx.accounts.subject.sid &&
      (container ? native.token.container === ctx.containerSid : native.token.isContainer === 0) &&
      node.roundTrip === true &&
      path.basename(node.exe) === (child ? "w17-child.exe" : "node.exe");
    for (const [i, k] of labels.entries()) {
      const open = native.opens?.[i],
        read = node.files?.[k],
        controllerHash = digest(ctx.paths[k]);
      const baseline = rows["W2.baseline." + who + "." + k]?.status;
      const ok =
        identity &&
        open?.path === ctx.paths[k] &&
        controllerHash === ctx.hashes[k] &&
        (denied && k !== "staged"
          ? baseline === "PASS" && open.error === 5 && ["EPERM", "EACCES"].includes(read?.code)
          : open.error === 0 && open.bytes === 1 && read?.hash === ctx.hashes[k]);
      if (prefix)
        row(prefix + "." + who + "." + k, ok ? "PASS" : "FAIL", {
          path: ctx.paths[k],
          baseline,
          identity,
          native: open,
          node: read,
          controllerHash,
        });
      outcomes.push(ok);
    }
  }
  assert.ok(
    outcomes.every(Boolean),
    "Native/Node, canonical/alias or positive file control failed",
  );
}
export async function originalFiles() {
  await restore("acl", "baseline");
  for (const [file, original] of Object.entries(ctx.originalDacl)) {
    const actual = await rpc("section", { path: file });
    note("original DACL comparison", { file, original, actual });
    assert.equal(actual, original);
  }
}
export async function undoFile() {
  return restore("tree-acl");
}
