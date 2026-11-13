import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function assertInstalledLinuxNetwork(interfaces) {
  const addresses = Object.values(interfaces).flat().filter(Boolean);
  assert.equal(
    addresses.filter((entry) => !entry.internal).length,
    0,
    "Linux isolated proof requires a networkless namespace in addition to Landlock TCP denial",
  );
  assert.ok(
    addresses.some((entry) => entry.internal && entry.address === "127.0.0.1"),
    "Linux isolated inspectors require loopback up: run ip link set lo up inside unshare --net before dropping privileges",
  );
}

export function installedAppArmorProfile(tempRoot) {
  // The only pattern is our mkdtemp suffix. Never interpolate caller-supplied
  // AppArmor syntax, or grant user namespaces to a general Node/Python binary.
  assert.ok(path.posix.isAbsolute(tempRoot));
  assert.doesNotMatch(tempRoot, /[^a-zA-Z0-9_./-]/);
  assert.equal(path.posix.resolve(tempRoot), tempRoot);
  assert.notEqual(tempRoot, "/");
  return `# Installed test copies only; Landlock still enforces source/TCP denial.
profile kobrixa-installed-test "${tempRoot}/kobrixa-installed-product-*/installed/kobrixa" flags=(unconfined) {
  userns,
}
`;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  assert.equal(process.argv[2], "--apparmor-profile");
  assert.equal(process.argv.length, 4);
  process.stdout.write(installedAppArmorProfile(await realpath(process.argv[3])));
}
