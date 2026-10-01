import { targetAssets, verifyTargetAssets } from "./update-assets.mjs";
import { targets } from "./common.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { signingModes } from "../../apps/desktop/signing.ts";
import {
  isMain,
  parseVersion,
  repositoryRoot,
  validateVersions,
  verifyChecksum,
} from "./common.mjs";

const unsigned = { macos: false, windows: false };

export function marker(tag, sha, modes = unsigned) {
  return `<!-- kobrixa-release:${JSON.stringify({ tag, sha, signing: { macos: modes.macos, windows: modes.windows } })} -->`;
}

export function assertDraft(release, tag, sha, modes = unsigned) {
  assert.ok(release, "Release draft is missing");
  assert.equal(release.draft, true, "Refusing to modify a published release");
  assert.equal(release.tag_name, tag, "Release tag mismatch");
  assert.ok(
    release.body?.includes(marker(tag, sha, modes)),
    "Draft has a different commit/signing mode or was not created by this workflow",
  );
}

export function failedChecks(results) {
  return ["validate", "quality", "prepare", "platform"].filter(
    (name) => results[name]?.result !== "success",
  );
}

export function assertAssets(assets, version, modes = unsigned) {
  const expected = targets
    .flatMap(({ platform, arch }) => targetAssets(version, platform, arch, modes))
    .sort();
  assert.deepEqual(
    assets.map((asset) => asset.name).sort(),
    expected,
    "Release assets are missing, duplicated or unexpected",
  );
  for (const asset of assets)
    assert.ok(asset.size > 0 && asset.state === "uploaded", `Incomplete asset: ${asset.name}`);
}

export function notes(tag, sha, status, generated = "", modes = unsigned, verified = false) {
  const macos = !modes.macos
    ? "Unsigned / 未簽章；not notarized / 未公證"
    : verified
      ? "Developer ID signed and notarized / 已簽章並公證"
      : "Signing and notarization required; not yet verified / 待簽章及公證驗證";
  const windows = !modes.windows
    ? "Unsigned / 未簽章"
    : verified
      ? "SignPath signature and timestamp verified / 已驗證 SignPath 簽章及時間戳"
      : "SignPath signing required; not yet verified / 待 SignPath 簽章驗證";
  const policy = `https://github.com/Kingsley1116/Kobrixa/blob/${sha}/docs/en/code-signing.md`;
  const attribution =
    modes.windows && verified
      ? "\nFree code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).\n"
      : "";
  return `${marker(tag, sha, modes)}\n\n${status}\n\nCommit: ${sha}\n\n- Windows x64: ${windows}. Use the per-user setup.exe for automatic updates; ZIP builds offer manual downloads.\n- macOS Apple Silicon: ${macos}. Install the DMG. Automatic updates require a signed build.\n- Linux x64: unsigned / 未簽章. Use AppImage for automatic updates; tar.gz builds offer manual downloads.\n- Optional: verify your download against its accompanying SHA-256 file. The checksum file is not required for installation. / SHA-256 驗證為選用，安裝不需要下載校驗碼檔案。\n- Automatic downloads use public GitHub Releases; installation requires explicit confirmation. This and future desktop releases include the updater. Intel Mac is not included.\n\n[Code signing policy / 程式碼簽章政策](${policy})\n${attribution}\n${generated}`;
}

export async function prepareRelease(github, tag, sha, modes = unsigned) {
  await github.assertTag(tag, sha);
  const release = await github.getRelease(tag);
  const body = notes(tag, sha, "建置中 / Building — incomplete, do not publish.", "", modes);
  if (release) {
    assertDraft(release, tag, sha, modes);
    await github.edit(release.id, {
      tag_name: tag,
      target_commitish: sha,
      name: `${tag} — 建置中`,
      body,
    });
  } else {
    await github.create(tag, sha, body, parseVersion(tag.slice(1)).prerelease);
  }
}

export async function uploadRelease(github, tag, sha, archive, modes = unsigned) {
  await verifyChecksum(archive);
  await github.assertTag(tag, sha);
  assertDraft(await github.getRelease(tag), tag, sha, modes);
  await github.upload(tag, [archive, `${archive}.sha256`]);
}

export async function finalizeRelease(github, tag, sha, results, modes = unsigned) {
  const failures = failedChecks(results);
  if (failures.length) {
    if (results.prepare?.result === "success") {
      await github.assertTag(tag, sha);
      const release = await github.getRelease(tag);
      assertDraft(release, tag, sha, modes);
      await github.edit(release.id, {
        tag_name: tag,
        target_commitish: sha,
        name: `${tag} — 未完成`,
        body: notes(
          tag,
          sha,
          `未完成 / Incomplete: ${failures.join(", ")}. See workflow job summaries; rerun failed jobs.`,
          "",
          modes,
        ),
      });
    }
    throw new Error(`Release checks did not succeed: ${failures.join(", ")}`);
  }
  await github.assertTag(tag, sha);
  const release = await github.getRelease(tag);
  assertDraft(release, tag, sha, modes);
  // Finalize can itself be rerun. Clear a previous ready status before any
  // download or checksum operation that may now fail.
  await github.edit(release.id, {
    // Omitting tag_name can turn a draft into an untagged release, breaking
    // the download below. Preserve the verified identity on every update.
    tag_name: tag,
    target_commitish: sha,
    name: `${tag} — 建置中`,
    body: notes(
      tag,
      sha,
      "驗證下載中 / Verifying downloaded assets — do not publish yet.",
      "",
      modes,
    ),
  });
  assertAssets(release.assets, tag.slice(1), modes);
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-release-"));
  try {
    await github.download(tag, directory);
    for (const { platform, arch } of targets)
      await verifyTargetAssets(directory, tag.slice(1), platform, arch, modes);
    const generated = await github.generateNotes(tag, sha);
    // Recheck immediately before writing, including whether someone published the draft.
    await github.assertTag(tag, sha);
    assertDraft(await github.getRelease(tag), tag, sha, modes);
    await github.edit(release.id, {
      tag_name: tag,
      target_commitish: sha,
      name: `${tag} — 待發布`,
      body: notes(
        tag,
        sha,
        "待發布 / Ready for manual publication — all checks and checksums passed.",
        generated,
        modes,
        true,
      ),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function command(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function createGithub(repo, execute = command) {
  assert.match(repo, /^[\w.-]+\/[\w.-]+$/, "Invalid repository");
  const prefix = `repos/${repo}`;
  const api = (endpoint, method = "GET", body) => {
    const output = execute(
      ["api", `${prefix}/${endpoint}`, "--method", method, ...(body ? ["--input", "-"] : [])],
      body ? JSON.stringify(body) : undefined,
    );
    return output.trim() ? JSON.parse(output) : null;
  };
  return {
    async assertTag(tag, sha) {
      assert.equal(
        api(`commits/${encodeURIComponent(tag)}`).sha,
        sha,
        "Remote tag moved to a different commit",
      );
    },
    async getRelease(tag) {
      // The by-tag REST endpoint is for published releases. Listing with write
      // access includes drafts and pagination also covers older release retries.
      const pages = JSON.parse(
        execute(["api", `${prefix}/releases?per_page=100`, "--paginate", "--slurp"]),
      );
      const matches = pages.flat().filter((release) => release.tag_name === tag);
      assert.ok(matches.length <= 1, "Multiple releases exist for the same tag");
      return matches[0] ?? null;
    },
    async create(tag, sha, body, prerelease) {
      execute(
        [
          "release",
          "create",
          tag,
          "--repo",
          repo,
          "--verify-tag",
          "--target",
          sha,
          "--draft",
          "--title",
          `${tag} — 建置中`,
          "--notes-file",
          "-",
          ...(prerelease ? ["--prerelease"] : []),
        ],
        body,
      );
    },
    async edit(id, body) {
      return api(`releases/${id}`, "PATCH", body);
    },
    async upload(tag, files) {
      execute(["release", "upload", tag, ...files, "--repo", repo, "--clobber"]);
    },
    async download(tag, directory) {
      execute(["release", "download", tag, "--repo", repo, "--dir", directory]);
    },
    async generateNotes(tag, sha) {
      return api("releases/generate-notes", "POST", { tag_name: tag, target_commitish: sha }).body;
    },
    async jobs(runId, attempt) {
      // A rerun must report this attempt, not stale failures from an earlier attempt.
      const pages = JSON.parse(
        execute([
          "api",
          `${prefix}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
          "--paginate",
          "--slurp",
        ]),
      );
      return pages.flatMap((page) => page.jobs);
    },
  };
}

export function validateCommit(tag, sha, root = repositoryRoot) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  assert.equal(git(["rev-parse", "HEAD"]), sha, "Checkout is not the triggering commit");
  assert.equal(
    git(["rev-parse", `${tag}^{commit}`]),
    sha,
    "Tag does not point at the triggering commit",
  );
  git(["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]);
}

async function main() {
  const tag = process.env.RELEASE_TAG;
  const sha = process.env.RELEASE_SHA;
  assert.match(sha ?? "", /^[a-f0-9]{40}$/, "Invalid release commit");
  const { version } = await validateVersions(tag);
  const modes = signingModes();
  const action = process.argv[2];
  if (action === "validate") {
    validateCommit(tag, sha);
    if (process.env.GITHUB_OUTPUT)
      await appendFile(process.env.GITHUB_OUTPUT, `signing=${JSON.stringify(modes)}\n`);
    console.log(`Validated ${tag} at ${sha}`);
    return;
  }
  const github = createGithub(process.env.GITHUB_REPOSITORY);
  if (action === "prepare") await prepareRelease(github, tag, sha, modes);
  else if (action === "upload") {
    const directory = path.join(repositoryRoot, "apps/desktop/out/release");
    const platform = process.env.TARGET_PLATFORM,
      arch = process.env.TARGET_ARCH;
    await verifyTargetAssets(directory, version, platform, arch, modes);
    await github.assertTag(tag, sha);
    assertDraft(await github.getRelease(tag), tag, sha, modes);
    await github.upload(
      tag,
      targetAssets(version, platform, arch, modes).map((name) => path.join(directory, name)),
    );
  } else if (action === "finalize") {
    const results = JSON.parse(process.env.RELEASE_RESULTS || "{}");
    const jobs = await github.jobs(process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT);
    const summary = jobs
      .filter((job) => job.name.startsWith("Release ("))
      .map((job) => `- ${job.name}: ${job.conclusion ?? job.status}`)
      .join("\n");
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Desktop Release\n\n${summary}\n\n`);
    await finalizeRelease(github, tag, sha, results, modes);
  } else throw new Error(`Unknown release action: ${action}`);
}

if (isMain(import.meta)) await main();
