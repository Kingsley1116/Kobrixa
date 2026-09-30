import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMain } from "./common.mjs";
import { macIdentity, required, signingModes } from "../../apps/desktop/signing.ts";

// Never include a child-process error, arguments or stderr: security arguments
// contain the P12 and temporary keychain passwords.
function security(args) {
  try {
    return execFileSync("security", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error(`macOS keychain operation failed: ${args[0]}`);
  }
}

export async function cleanupKeychain(env = process.env, execute = security) {
  if (!env.MACOS_KEYCHAIN_PATH) return;
  const directory = path.dirname(env.MACOS_KEYCHAIN_PATH);
  assert.equal(path.dirname(directory), path.resolve(required(env, "RUNNER_TEMP")));
  assert.ok(path.basename(directory).startsWith("kobrixa-signing-"));
  assert.equal(path.basename(env.MACOS_KEYCHAIN_PATH), "release.keychain-db");
  let previous;
  try {
    previous = JSON.parse(await readFile(path.join(directory, "search-list.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return; // Setup already cleaned up after a failure.
    throw error;
  }
  try {
    execute(["list-keychains", "-d", "user", "-s", ...previous]);
    execute(["delete-keychain", env.MACOS_KEYCHAIN_PATH]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function setupKeychain(env = process.env, execute = security) {
  assert.ok(signingModes(env).macos, "macOS signing is disabled");
  const { identity } = macIdentity(env);
  const certificate = required(env, "MACOS_CERTIFICATE_P12_BASE64");
  assert.match(certificate, /^[A-Za-z0-9+/]+={0,2}$/, "P12 must be single-line base64");
  const certificatePassword = required(env, "MACOS_CERTIFICATE_PASSWORD");
  required(env, "APPLE_ID");
  required(env, "APPLE_APP_SPECIFIC_PASSWORD");
  const githubEnv = required(env, "GITHUB_ENV");
  const previous = [...execute(["list-keychains", "-d", "user"]).matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(previous.length, "Cannot read the existing keychain search list");
  const directory = await mkdtemp(
    path.join(path.resolve(required(env, "RUNNER_TEMP")), "kobrixa-signing-"),
  );
  const keychain = path.join(directory, "release.keychain-db");
  const p12 = path.join(directory, "certificate.p12");
  const password = randomBytes(32).toString("hex");
  await writeFile(path.join(directory, "search-list.json"), JSON.stringify(previous), {
    mode: 0o600,
  });
  let created = false;
  try {
    await writeFile(p12, Buffer.from(certificate, "base64"), { mode: 0o600 });
    execute(["create-keychain", "-p", password, keychain]);
    created = true;
    // Expose only the path. Cleanup can run even if a later import/build fails.
    await appendFile(githubEnv, `MACOS_KEYCHAIN_PATH=${keychain}\n`);
    execute(["set-keychain-settings", "-lut", "21600", keychain]);
    execute(["unlock-keychain", "-p", password, keychain]);
    execute(["import", p12, "-k", keychain, "-P", certificatePassword, "-T", "/usr/bin/codesign"]);
    execute([
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    execute(["list-keychains", "-d", "user", "-s", keychain, ...previous]);
    assert.ok(
      execute(["find-identity", "-v", "-p", "codesigning", keychain]).includes(`"${identity}"`),
      "The imported P12 does not contain the expected valid Developer ID Application identity",
    );
    await rm(p12);
    return keychain;
  } catch (error) {
    if (created) await cleanupKeychain({ ...env, MACOS_KEYCHAIN_PATH: keychain }, execute);
    else await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (isMain(import.meta)) {
  assert.equal(process.platform, "darwin", "Keychain operations require macOS");
  if (process.argv[2] === "setup") await setupKeychain();
  else if (process.argv[2] === "cleanup") await cleanupKeychain();
  else throw new Error("Use setup or cleanup");
}
