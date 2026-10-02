import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { targets, sha256 } from "./common.mjs";
import { targetAssets, writeUpdateMetadata } from "./update-assets.mjs";
const expectedAssets = (version, modes) =>
  targets.flatMap(({ platform, arch }) => targetAssets(version, platform, arch, modes));
import {
  assertAssets,
  assertDraft,
  createGithub,
  failedChecks,
  finalizeRelease,
  marker,
  notes,
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
function mockGithub(existing = null, modes = { macos: false, windows: false }) {
  let release = existing;
  const calls = [];
  let checksumManifest;
  const assets = expectedAssets(version, modes).map((name, id) => ({
    id,
    name,
    size: 1,
    state: "uploaded",
  }));
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
      // GitHub can detach a draft from its tag when an update omits tag_name.
      Object.assign(release, { tag_name: fields.tag_name ?? "untagged-fixture" }, fields);
    },
    async upload(actualTag, files) {
      calls.push("upload");
      for (const file of files.filter((file) => path.basename(file) === "SHA256SUMS.txt")) {
        checksumManifest = await readFile(file, "utf8");
        if (!release.assets.some((asset) => asset.name === "SHA256SUMS.txt"))
          release.assets.push({
            id: 100,
            name: "SHA256SUMS.txt",
            size: checksumManifest.length,
            state: "uploaded",
          });
      }
    },
    async downloadChecksums(actualTag, directory) {
      await writeFile(path.join(directory, "SHA256SUMS.txt"), checksumManifest);
    },
    async deleteAsset(id) {
      calls.push("delete");
      release.assets = release.assets.filter((asset) => asset.id !== id);
    },
    async download(actualTag, directory) {
      assert.equal(release.tag_name, actualTag, "Release is no longer available by tag");
      calls.push("download");
      for (const { name } of release.assets.filter(
        ({ name }) => !name.endsWith(".sha256") && name !== "SHA256SUMS.txt",
      )) {
        const file = path.join(directory, name);
        await writeFile(file, "archive fixture");
        if (release.assets.some((asset) => asset.name === `${name}.sha256`))
          await writeFile(`${file}.sha256`, `${await sha256(file)}  ${name}\n`);
      }
      if (checksumManifest)
        await writeFile(path.join(directory, "SHA256SUMS.txt"), checksumManifest);
      for (const { platform, arch } of targets.filter(
        (item) => item.platform !== "darwin" || modes.macos,
      ))
        await writeUpdateMetadata(directory, version, platform, arch);
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

test("preserves the tag and source commit across every draft status update", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  await prepareRelease(github, tag, sha);
  assert.equal(github.release.tag_name, tag);
  assert.equal(github.release.target_commitish, sha);
  await assert.rejects(
    finalizeRelease(github, tag, sha, { ...success, platform: { result: "failure" } }),
    /did not succeed/,
  );
  assert.equal(github.release.tag_name, tag);
  assert.equal(github.release.target_commitish, sha);
  await finalizeRelease(github, tag, sha, success);
  assert.equal(github.release.tag_name, tag);
  assert.equal(github.release.target_commitish, sha);
  assert.match(github.release.name, /待發布/);
  assert.equal(github.release.draft, true);
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

test("requires every complete archive, installer and metadata asset, verifies downloaded bytes and leaves a ready draft", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  const assets = github.release.assets;
  assertAssets(assets, version, undefined, true);
  assert.throws(() => assertAssets(assets.slice(1), version, undefined, true));
  assert.throws(() => assertAssets([...assets, assets[0]], version, undefined, true));
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

test("draft retries cannot change signing modes or claim verification before finalization", async () => {
  const modes = { macos: true, windows: false };
  const github = mockGithub(null, modes);
  await prepareRelease(github, tag, sha, modes);
  assert.match(github.release.body, /not yet verified/);
  assert.doesNotMatch(github.release.body, /已簽章並公證/);
  await prepareRelease(github, tag, sha, modes);
  const count = github.calls.length;
  for (const changed of [
    { macos: false, windows: false },
    { macos: true, windows: true },
  ]) {
    await assert.rejects(prepareRelease(github, tag, sha, changed), /signing mode/);
    await assert.rejects(finalizeRelease(github, tag, sha, success, changed), /signing mode/);
  }
  assert.equal(github.calls.length, count);
  await finalizeRelease(github, tag, sha, success, modes);
  assert.match(github.release.body, /已簽章並公證/);
  assert.match(github.release.body, /Windows x64: Unsigned/);
  assert.doesNotMatch(github.release.body, /Free code signing provided/);
});

test("signing rejection, timeout or cancellation leave signed drafts incomplete", async () => {
  const modes = { macos: true, windows: true };
  for (const result of ["failure", "timed_out", "cancelled"]) {
    const github = mockGithub();
    await prepareRelease(github, tag, sha, modes);
    await assert.rejects(
      finalizeRelease(github, tag, sha, { ...success, platform: { result } }, modes),
    );
    assert.match(github.release.name, /未完成/);
    assert.doesNotMatch(
      github.release.body,
      /已驗證 SignPath 簽章|已簽章並公證|Free code signing provided/,
    );
    assert.ok(!github.calls.includes("download"));
  }
  const body = notes(tag, sha, "Ready", "", modes, true);
  assert.match(body, /已驗證 SignPath 簽章及時間戳/);
  assert.match(body, /Free code signing provided/);
  assert.match(body, /Code signing policy/);
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

test("finalization consolidates checksums and resumes interrupted sidecar cleanup", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  const remove = github.deleteAsset;
  let deletions = 0;
  github.deleteAsset = async (id) => {
    if (++deletions === 2) throw new Error("interrupted cleanup");
    await remove(id);
  };
  await assert.rejects(finalizeRelease(github, tag, sha, success), /interrupted cleanup/);
  assert.match(github.release.name, /建置中/);
  github.deleteAsset = remove;
  await finalizeRelease(github, tag, sha, success);
  assertAssets(github.release.assets, version);
  assert.equal(github.release.assets.length, 8);
  assert.ok(!github.release.assets.some((asset) => asset.name.endsWith(".sha256")));
  await finalizeRelease(github, tag, sha, success);
  assertAssets(github.release.assets, version);
});

test("a corrupted uploaded manifest preserves sidecars and never becomes ready", async () => {
  const github = mockGithub();
  await prepareRelease(github, tag, sha);
  github.downloadChecksums = async (_, directory) =>
    writeFile(path.join(directory, "SHA256SUMS.txt"), "damaged");
  await assert.rejects(finalizeRelease(github, tag, sha, success), /manifest mismatch/);
  assert.ok(!github.calls.includes("delete"));
  assert.match(github.release.name, /建置中/);
});
