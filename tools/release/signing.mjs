import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { isMain, readVersion, repositoryRoot } from "./common.mjs";
import { installerNames } from "./update-assets.mjs";
import { macIdentity, required, signingModes, windowsVersion } from "../../apps/desktop/signing.ts";

export function runVerification(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Signature verification failed (${command}): ${result.stderr || result.stdout || result.error?.message}`,
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function verifySignedApplication(
  directory,
  platform,
  version,
  modes,
  env = process.env,
  execute = runVerification,
) {
  if (platform === "darwin" && modes.macos) {
    const { identity, teamId } = macIdentity(env);
    const app = path.join(directory, "Kobrixa.app");
    execute("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
    const description = execute("codesign", ["--display", "--verbose=4", app]);
    const lines = description.split(/\r?\n/);
    for (const expected of [
      `Identifier=com.kobrixa.ide`,
      `TeamIdentifier=${teamId}`,
      `Authority=${identity}`,
    ])
      assert.ok(lines.includes(expected), `Unexpected macOS signature: missing ${expected}`);
    assert.match(description, /flags=.*\bruntime\b/, "Hardened Runtime is missing");
    execute("xcrun", ["stapler", "validate", app]);
    execute("spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  } else if (platform === "win32" && modes.windows) {
    execute("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      path.join(repositoryRoot, "tools/release/verify-windows.ps1"),
      "-ApplicationPath",
      path.join(directory, "kobrixa.exe"),
      "-ExpectedSubject",
      required(env, "SIGNPATH_CERTIFICATE_SUBJECT"),
      "-ExpectedVersion",
      windowsVersion(version),
    ]);
  }
}

export function signPathConfiguration(env = process.env) {
  return Object.fromEntries(
    [
      "SIGNPATH_API_TOKEN",
      "SIGNPATH_ORGANIZATION_ID",
      "SIGNPATH_PROJECT_SLUG",
      "SIGNPATH_SIGNING_POLICY_SLUG",
      "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG",
      "SIGNPATH_CERTIFICATE_SUBJECT",
      "SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG",
    ].map((name) => [name, required(env, name)]),
  );
}

export async function acceptSignedWindows(
  directory,
  signedDirectory,
  version,
  env = process.env,
  execute = runVerification,
) {
  const { treeManifest } = await import("./archive.mjs");
  const before = await treeManifest(directory, "win32");
  const after = await treeManifest(signedDirectory, "win32");
  assert.ok(
    before["kobrixa.exe"]?.hash && after["kobrixa.exe"]?.hash,
    "Signed executable is missing or is a symlink",
  );
  assert.notEqual(
    before["kobrixa.exe"].hash,
    after["kobrixa.exe"].hash,
    "Signing returned the unchanged executable",
  );
  delete before["kobrixa.exe"];
  delete after["kobrixa.exe"];
  assert.deepEqual(after, before, "Signing changed files outside the approved kobrixa.exe");
  verifySignedApplication(
    signedDirectory,
    "win32",
    version,
    { macos: false, windows: true },
    env,
    execute,
  );
  // Only replace the verified executable; never copy unapproved returned files.
  await copyFile(path.join(signedDirectory, "kobrixa.exe"), path.join(directory, "kobrixa.exe"));
}

export async function acceptSignedInstaller(
  original,
  signedDirectory,
  destination,
  version,
  env = process.env,
  execute = runVerification,
) {
  const { treeManifest } = await import("./archive.mjs");
  const { sha256 } = await import("./common.mjs");
  const returned = await treeManifest(signedDirectory, "win32");
  assert.deepEqual(Object.keys(returned), ["setup.exe"], "Unexpected signed installer files");
  assert.ok(returned["setup.exe"].hash, "Signed installer must be a regular file");
  assert.notEqual(
    returned["setup.exe"].hash,
    await sha256(original),
    "Signing returned the unchanged installer",
  );
  const signed = path.join(signedDirectory, "setup.exe");
  execute("pwsh", [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    path.join(repositoryRoot, "tools/release/verify-windows.ps1"),
    "-ApplicationPath",
    signed,
    "-ExpectedSubject",
    required(env, "SIGNPATH_CERTIFICATE_SUBJECT"),
    "-ExpectedVersion",
    windowsVersion(version),
    "-Installer",
    "-ReleaseVersion",
    version,
  ]);
  await copyFile(signed, destination);
}

if (isMain(import.meta)) {
  const modes = signingModes();
  const version = await readVersion();
  if (process.argv[2] === "preflight-windows") {
    assert.ok(modes.windows, "Windows signing is disabled");
    signPathConfiguration();
    await appendFile(
      required(process.env, "GITHUB_OUTPUT"),
      `version=${windowsVersion(version)}\nrelease-version=${version}\n`,
    );
  } else if (process.argv[2] === "stage-installer") {
    assert.ok(modes.windows, "Windows signing is disabled");
    const out = path.join(repositoryRoot, "apps/desktop/out");
    await mkdir(path.join(out, "unsigned-installer"), { recursive: true });
    await copyFile(
      path.join(out, "installers", installerNames(version, "win32", "x64")[0]),
      path.join(out, "unsigned-installer/setup.exe"),
    );
  } else if (process.argv[2] === "accept-installer") {
    assert.ok(modes.windows, "Windows signing is disabled");
    const out = path.join(repositoryRoot, "apps/desktop/out");
    await acceptSignedInstaller(
      path.join(out, "unsigned-installer/setup.exe"),
      path.join(out, "signed-installer"),
      path.join(out, "installers", installerNames(version, "win32", "x64")[0]),
      version,
    );
  } else if (process.argv[2] === "accept-windows") {
    assert.ok(modes.windows, "Windows signing is disabled");
    await acceptSignedWindows(
      path.join(repositoryRoot, "apps/desktop/out/Kobrixa-win32-x64"),
      path.join(repositoryRoot, "apps/desktop/out/signed"),
      version,
    );
  } else throw new Error("Use preflight-windows or accept-windows");
}
