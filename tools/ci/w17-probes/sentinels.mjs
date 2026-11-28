import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hash } from "node:crypto";

// Preserve containment and aliases (including checkout === worktree) without
// traversing node_modules or inheriting a hard link from a package store.
export function stagedSentinels(stage, sourceRoots, sources, create) {
  const base = path.join(stage, "sentinels");
  if (create) fs.mkdirSync(base);
  assert.equal(fs.realpathSync(base), base);
  const roots = {},
    files = {};
  const entries = Object.entries(sourceRoots).sort((a, b) => a[1].length - b[1].length);
  for (const [key, source] of entries) {
    const parent = entries.find(
      ([k, r]) => roots[k] && (r === source || source.startsWith(r + path.sep)),
    );
    roots[key] = parent
      ? path.join(roots[parent[0]], path.relative(parent[1], source))
      : path.join(base, key);
    const relative = path.relative(source, sources[key]);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const target = path.join(roots[key], relative);
    if (create && !Object.values(files).includes(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(sources[key], target, fs.constants.COPYFILE_EXCL);
    }
    assert.equal(fs.realpathSync(target), target);
    assert.equal(fs.lstatSync(target).nlink, 1);
    if (create && process.platform !== "win32") {
      for (let dir = path.dirname(target); dir !== stage; dir = path.dirname(dir))
        fs.chmodSync(dir, 0o755);
      fs.chmodSync(target, 0o444);
    }
    assert.equal(
      hash("sha256", fs.readFileSync(target)),
      hash("sha256", fs.readFileSync(sources[key])),
    );
    files[key] = target;
  }
  return { roots, files };
}
