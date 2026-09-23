import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { expectedAssets, sha256 } from "./common.mjs";
import {
  assertAssets,
  assertDraft,
  createGithub,
  failedChecks,
  finalizeRelease,
  marker,
  prepareRelease,
  uploadRelease,
  validateCommit,
} from "./github.mjs";

const version = "0.1.0-v1-candidate.0";
const tag = `v${version}`;
const sha = "a".repeat(40);
const success = Object.fromEntries(
  ["validate", "quality", "prepare", "platform"].map((key) => [key, { result: "success" }]),
);
function mockGithub(existing = null) {
  let release = existing;
  const calls = [];
  const assets = expectedAssets(version).map((name) => ({ name, size: 1, state: "uploaded" }));
  return {
    calls,
    get release() {
      return release;
    },
    async assertTag(actualTag, actualSha) {
      assert.equal(actualTag, tag);
      assert.equal(actualSha, sha);
    },
    async getRelease() {
      return release;
    },
    async create(actualTag, actualSha, body, prerelease) {
      calls.push("create");
      release = { id: 1, tag_name: actualTag, draft: true, body, prerelease, assets };
      assert.equal(actualSha, sha);
    },
    async edit(id, fields) {
      assert.equal(id, release.id);
      calls.push("edit");
      Object.assign(release, fields);
    },
    async upload() {
      calls.push("upload");
    },
    async download(_tag, directory) {
      calls.push("download");
      for (const { name } of assets.filter(({ name }) => !name.endsWith(".sha256"))) {
        const file = path.join(directory, name);
        await writeFile(file, "archive fixture");
        await writeFile(`${file}.sha256`, `${await sha256(file)}  ${name}\n`);
      }
    },
    async generateNotes() {
      return "Generated changes";
    },
  };
}
function draft() {
  return { id: 1, tag_name: tag, draft: true, body: marker(tag, sha), assets: [] };
}

test("GitHub transport finds drafts across pages and preserves API errors", async () => {
  const github = createGithub("owner/repo", (args) => {
    assert.deepEqual(args, [
      "api",
      "repos/owner/repo/releases?per_page=100",
      "--paginate",
      "--slurp",
    ]);
    return JSON.stringify([[{ ...draft(), tag_name: "v9.0.0" }], [draft()]]);
  });
  assert.equal((await github.getRelease(tag)).draft, true);
  const broken = createGithub("owner/repo", () => {
    throw new Error("HTTP 403");
  });
  await assert.rejects(broken.getRelease(tag), /HTTP 403/);
  assert.equal(await createGithub("owner/repo", () => "[[]]").getRelease(tag), null);
});

test("creates a prerelease draft and safely resumes only the same commit", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  assert.equal(github.release.draft, true);
  assert.equal(github.release.prerelease, true);
  await prepareRelease(github, tag, sha);
  assert.deepEqual(github.calls, ["create", "edit"]);
  for (const invalid of [
    { ...draft(), draft: false },
    { ...draft(), body: marker(tag, "b".repeat(40)) },
  ]) {
    const rejected = mockGithub(invalid);
    await assert.rejects(prepareRelease(rejected, tag, sha));
    assert.deepEqual(rejected.calls, []);
  }
});

test("rejects moved tags before release mutation", async () => {
  const github = mockGithub(draft());
  github.assertTag = async () => {
    throw new Error("Remote tag moved");
  };
  await assert.rejects(prepareRelease(github, tag, sha), /tag moved/);
  assert.deepEqual(github.calls, []);
});

test("missing, cancelled, failed and skipped checks cannot produce a ready draft", async () => {
  assert.equal(failedChecks({}).length, 4);
  for (const result of ["failure", "cancelled", "skipped"]) {
    const github = mockGithub(draft());
    await assert.rejects(
      finalizeRelease(github, tag, sha, { ...success, platform: { result } }),
      /did not succeed/,
    );
    assert.match(github.release.name, /未完成/);
    assert.equal(github.release.draft, true);
    assert.ok(!github.calls.includes("download"));
  }
  const github = mockGithub();
  await assert.rejects(finalizeRelease(github, tag, sha, {}));
  assert.deepEqual(github.calls, []);
});

test("requires exactly six complete assets, verifies downloaded bytes and leaves a ready draft", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  const assets = github.release.assets;
  assert.throws(() => assertAssets(assets.slice(1), version));
  assert.throws(() => assertAssets([...assets, assets[0]], version));
  assert.throws(() =>
    assertAssets(
      assets.map((item) => ({ ...item, state: "new" })),
      version,
    ),
  );
  await finalizeRelease(github, tag, sha, success);
  assert.match(github.release.name, /待發布/);
  assert.match(github.release.body, /Generated changes/);
  assert.equal(github.release.draft, true);
  assertDraft(github.release, tag, sha);
});

test("corrupted downloads never mark a release ready", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  await finalizeRelease(github, tag, sha, success);
  assert.match(github.release.name, /待發布/);
  const download = github.download;
  github.download = async (tag, directory) => {
    await download(tag, directory);
    await writeFile(path.join(directory, expectedAssets(version)[0]), "damaged");
  };
  await assert.rejects(finalizeRelease(github, tag, sha, success), /Checksum mismatch/);
  assert.match(github.release.name, /建置中/);
});

test("uploads verify checksums and refuse a published release", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-upload-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, expectedAssets(version)[0]);
  await writeFile(file, "archive");
  await writeFile(`${file}.sha256`, `${await sha256(file)}  ${path.basename(file)}\n`);
  const github = mockGithub(draft());
  await uploadRelease(github, tag, sha, file);
  assert.deepEqual(github.calls, ["upload"]);
  github.release.draft = false;
  await assert.rejects(uploadRelease(github, tag, sha, file), /published/);
  await assert.rejects(finalizeRelease(github, tag, sha, success), /published/);
  assert.deepEqual(github.calls, ["upload"]);
});

test("validates annotated tags and rejects commits outside main history or mismatched checkouts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "kobrixa-tag-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", commit);
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "tag",
    "-a",
    tag,
    "-m",
    "test tag",
  );
  validateCommit(tag, commit, root);
  assert.throws(() => validateCommit(tag, sha, root), /triggering commit/);
  git("checkout", "-b", "unmerged");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "not on main",
  );
  git("tag", "v9.0.0");
  assert.throws(() => validateCommit("v9.0.0", git("rev-parse", "HEAD"), root));
});
