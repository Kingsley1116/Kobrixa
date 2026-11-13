import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function copyDesktopBundle(source, destination, platform, run = execute) {
  if (platform === "darwin") {
    // Keep framework links, resource forks and extended attributes intact.
    await run("/usr/bin/ditto", [source, destination]);
  } else await cp(source, destination, { recursive: true, verbatimSymlinks: true });
}

export async function macBundle(directory) {
  const apps = (await readdir(directory)).filter((name) => name.endsWith(".app"));
  assert.equal(apps.length, 1, "Expected exactly one packaged macOS application");
  return path.join(directory, apps[0]);
}

export async function verifyMacBundle(app, run = execute) {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
}

export async function signMacTestBundle(app, entitlements, { sign, run = execute } = {}) {
  if (!sign) {
    // Resolve the signer's installed version through its owning dependency.
    const require = createRequire(createRequire(import.meta.url).resolve("app-builder-lib"));
    sign = (await import(pathToFileURL(require.resolve("@electron/osx-sign")).href)).signAsync;
  }
  // Builder skips even identity "-" in PRs. Sign inside-out without certificates,
  // keychain discovery, provisioning, notarization or a PR signing-policy override.
  await sign({
    app,
    platform: "darwin",
    identity: "-",
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    strictVerify: true,
    optionsForFile: () => ({ entitlements, hardenedRuntime: false, timestamp: "none" }),
  });
  await verifyMacBundle(app, run);
}
