import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  cp,
  lstat,
  readlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { test } from "node:test";

async function failedCopy() {
  const source = await readFile(new URL("./packaged-smoke.mjs", import.meta.url), "utf8");
  let options;
  const cleanups = [];
  // Execute the real runner's setup through its first failing copy, without launching Electron.
  await assert.rejects(
    vm.runInNewContext(`(async () => {${source.replace(/^import .*;\n/gm, "")} })()`, {
      process: { platform: "darwin", arch: "arm64" },
      path,
      tmpdir: () => "/tmp",
      repositoryRoot: "/fixture",
      readVersion: async () => "1.0.0",
      mkdtemp: async () => "/isolated-profile",
      cp: async (_source, _destination, input) => {
        options = input;
        throw new Error("copy failed");
      },
      rm: async (...args) => {
        cleanups.push(args);
      },
    }),
    /copy failed/,
  );
  return { options, cleanups };
}

test("packaged copy failure cleans up the isolated profile", async () => {
  const { cleanups } = await failedCopy();
  assert.equal(cleanups.length, 1);
  assert.equal(cleanups[0][0], "/isolated-profile");
  assert.equal(cleanups[0][1].recursive, true);
  assert.equal(cleanups[0][1].force, true);
});

test("packaged copy preserves app framework symlinks verbatim", async () => {
  const { options } = await failedCopy();
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-bundle-links-"));
  try {
    const source = path.join(root, "source");
    const installed = path.join(root, "installed");
    await mkdir(path.join(source, "Versions/A"), { recursive: true });
    await writeFile(path.join(source, "Versions/A/Framework"), "fixture");
    await symlink("A", path.join(source, "Versions/Current"), "dir");
    await symlink("Versions/Current/Framework", path.join(source, "Framework"), "file");
    await cp(source, installed, options);
    for (const [name, target] of [
      ["Versions/Current", "A"],
      ["Framework", "Versions/Current/Framework"],
    ]) {
      assert.equal((await lstat(path.join(installed, name))).isSymbolicLink(), true);
      assert.equal(await readlink(path.join(installed, name)), target);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
