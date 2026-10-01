import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { macSigningConfig, signingModes, windowsVersion } from "../../apps/desktop/signing.ts";
import {
  acceptSignedWindows,
  acceptSignedInstaller,
  runVerification,
  signPathConfiguration,
  verifySignedApplication,
} from "./signing.mjs";
import { cleanupKeychain, setupKeychain } from "./macos-keychain.mjs";

const version = "0.1.0-v1-candidate.0";
const macEnv = {
  KOBRIXA_RELEASE_BUILD: "true",
  MACOS_SIGNING_ENABLED: "true",
  MACOS_SIGNING_IDENTITY: "Developer ID Application: Test Developer (ABCDEFGHIJ)",
  APPLE_TEAM_ID: "ABCDEFGHIJ",
  MACOS_KEYCHAIN_PATH: "/temporary/release.keychain-db",
  APPLE_ID: "test@example.invalid",
  APPLE_APP_SPECIFIC_PASSWORD: "test-password",
};
const winEnv = { SIGNPATH_CERTIFICATE_SUBJECT: "CN=SignPath Foundation" };
const both = { macos: true, windows: true };
async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-signing-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("signing defaults off, rejects typos and uses the validated snapshot across reruns", () => {
  assert.deepEqual(signingModes({}), { macos: false, windows: false });
  for (const flag of ["MACOS_SIGNING_ENABLED", "WINDOWS_SIGNING_ENABLED"])
    assert.throws(() => signingModes({ [flag]: "yes" }), /true or false/);
  assert.deepEqual(
    signingModes({ SIGNING_MODES: JSON.stringify(both), MACOS_SIGNING_ENABLED: "false" }),
    both,
  );
  for (const value of [
    { macos: "true", windows: false },
    { macos: true },
    { ...both, extra: true },
  ])
    assert.throws(() => signingModes({ SIGNING_MODES: JSON.stringify(value) }));
});

test("local/PR/non-Mac packaging requires no credentials; enabled Mac releases fail closed", () => {
  assert.deepEqual(macSigningConfig({}, "darwin"), {});
  assert.deepEqual(macSigningConfig({ MACOS_SIGNING_ENABLED: "true" }, "darwin"), {});
  assert.deepEqual(macSigningConfig(macEnv, "linux"), {});
  const config = macSigningConfig(macEnv, "darwin");
  assert.equal(config.osxSign.continueOnError, false);
  assert.equal(config.osxSign.optionsForFile("Helper.app").hardenedRuntime, true);
  assert.equal(config.osxNotarize.teamId, macEnv.APPLE_TEAM_ID);
  for (const name of [
    "MACOS_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
    "MACOS_KEYCHAIN_PATH",
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
  ])
    assert.throws(
      () => macSigningConfig({ ...macEnv, [name]: "" }, "darwin"),
      /Missing signing configuration/,
    );
  assert.throws(
    () =>
      macSigningConfig({ ...macEnv, MACOS_SIGNING_IDENTITY: "Apple Development: Test" }, "darwin"),
    /Developer ID Application/,
  );
});

test("Windows numeric versions support prereleases and reject unrepresentable versions", () => {
  assert.equal(windowsVersion(version), "0.1.0.0");
  assert.equal(windowsVersion("1.2.3-beta.4+build.7"), "1.2.3.0");
  assert.throws(() => windowsVersion("65536.1.0"));
  assert.throws(() => windowsVersion("1.2"));
});

test("SignPath preflight requires every credential, policy and expected publisher", () => {
  const names = [
    "SIGNPATH_API_TOKEN",
    "SIGNPATH_ORGANIZATION_ID",
    "SIGNPATH_PROJECT_SLUG",
    "SIGNPATH_SIGNING_POLICY_SLUG",
    "SIGNPATH_ARTIFACT_CONFIGURATION_SLUG",
    "SIGNPATH_CERTIFICATE_SUBJECT",
    "SIGNPATH_INSTALLER_ARTIFACT_CONFIGURATION_SLUG",
  ];
  const env = Object.fromEntries(names.map((name) => [name, "configured"]));
  assert.deepEqual(signPathConfiguration(env), env);
  for (const name of names)
    assert.throws(() => signPathConfiguration({ ...env, [name]: "" }), new RegExp(name));
});

test("macOS trust checks require the expected identity, runtime and notarization ticket", () => {
  const calls = [];
  const description = `Identifier=com.kobrixa.ide\nTeamIdentifier=ABCDEFGHIJ\nAuthority=${macEnv.MACOS_SIGNING_IDENTITY}\nCodeDirectory flags=0x10000(runtime)`;
  const execute = (command, args) => {
    calls.push([command, args]);
    return description;
  };
  verifySignedApplication("/app", "darwin", version, both, macEnv, execute);
  assert.deepEqual(
    calls.map(([command]) => command),
    ["codesign", "codesign", "xcrun", "spctl"],
  );
  for (const bad of [
    "Signature=adhoc",
    description.replace("ABCDEFGHIJ", "WRONGTEAM0"),
    description.replace("runtime", "none"),
  ])
    assert.throws(() =>
      verifySignedApplication("/app", "darwin", version, both, macEnv, () => bad),
    );
  for (const failedCommand of ["codesign", "xcrun", "spctl"])
    assert.throws(
      () =>
        verifySignedApplication("/app", "darwin", version, both, macEnv, (command) => {
          if (command === failedCommand) throw new Error("untrusted");
          return description;
        }),
      /untrusted/,
    );
  verifySignedApplication("/app", "linux", version, both, {}, () => {
    throw new Error("Linux should not sign");
  });
  verifySignedApplication("/app", "darwin", version, { macos: false, windows: false }, {}, () => {
    throw new Error("Disabled");
  });
});

test("nonzero verification commands cannot be treated as valid signatures", () => {
  assert.throws(
    () => runVerification(process.execPath, ["-e", "process.exit(1)"]),
    /Signature verification failed/,
  );
});

test("SignPath output accepts only a verified change to kobrixa.exe", async (t) => {
  const root = await temporary(t);
  const original = path.join(root, "original"),
    signed = path.join(root, "signed");
  for (const directory of [original, signed]) {
    await mkdir(directory);
    await writeFile(path.join(directory, "app.asar"), "application");
    await writeFile(
      path.join(directory, "kobrixa.exe"),
      directory === original ? "unsigned" : "signed",
    );
  }
  await assert.rejects(
    acceptSignedWindows(original, signed, version, winEnv, () => {
      throw new Error("Bad certificate");
    }),
    /Bad certificate/,
  );
  assert.equal(await readFile(path.join(original, "kobrixa.exe"), "utf8"), "unsigned");
  await writeFile(path.join(signed, "app.asar"), "modified application");
  await assert.rejects(
    acceptSignedWindows(original, signed, version, winEnv, () => "valid"),
    /outside the approved/,
  );
  await writeFile(path.join(signed, "app.asar"), "application");
  const calls = [];
  await acceptSignedWindows(original, signed, version, winEnv, (...args) => {
    calls.push(args);
    return "valid";
  });
  assert.equal(calls[0][0], "pwsh");
  assert.ok(calls[0][1].includes(winEnv.SIGNPATH_CERTIFICATE_SUBJECT));
  assert.ok(calls[0][1].includes("0.1.0.0"));
  assert.equal(await readFile(path.join(original, "kobrixa.exe"), "utf8"), "signed");
  await assert.rejects(
    acceptSignedWindows(original, signed, version, winEnv, () => "valid"),
    /unchanged executable/,
  );
});

test("temporary Apple keychain is cleaned after success or failed certificate import", async (t) => {
  const root = await temporary(t);
  const env = {
    ...macEnv,
    RUNNER_TEMP: root,
    GITHUB_ENV: path.join(root, "github-env"),
    MACOS_CERTIFICATE_P12_BASE64: "dGVzdA==",
    MACOS_CERTIFICATE_PASSWORD: "test-p12-password",
  };
  const calls = [];
  const execute = (args) => {
    calls.push(args);
    if (args[0] === "list-keychains" && !args.includes("-s"))
      return '"/original/login.keychain-db"';
    if (args[0] === "find-identity") return `1) fingerprint "${env.MACOS_SIGNING_IDENTITY}"`;
    return "";
  };
  const keychain = await setupKeychain(env, execute);
  const exported = await readFile(env.GITHUB_ENV, "utf8");
  assert.equal(exported, `MACOS_KEYCHAIN_PATH=${keychain}\n`);
  assert.ok(!exported.includes(env.MACOS_CERTIFICATE_PASSWORD));
  await assert.rejects(readFile(path.join(path.dirname(keychain), "certificate.p12")), /ENOENT/);
  await cleanupKeychain({ ...env, MACOS_KEYCHAIN_PATH: keychain }, execute);
  assert.ok(calls.some((args) => args[0] === "delete-keychain"));
  assert.deepEqual(calls.at(-2), [
    "list-keychains",
    "-d",
    "user",
    "-s",
    "/original/login.keychain-db",
  ]);
  await cleanupKeychain({ ...env, MACOS_KEYCHAIN_PATH: keychain }, execute);
  await assert.rejects(
    setupKeychain(env, (args) => {
      if (args[0] === "import") throw new Error("import rejected");
      return execute(args);
    }),
    /import rejected/,
  );
  assert.equal(calls.filter((args) => args[0] === "delete-keychain").length, 2);
});

test("final installer is replaced only after file set and signature verification", async (t) => {
  const root = await temporary(t);
  const original = path.join(root, "original.exe");
  const signed = path.join(root, "signed");
  const destination = path.join(root, "final.exe");
  await mkdir(signed);
  await writeFile(original, "unsigned");
  await writeFile(path.join(signed, "setup.exe"), "unsigned");
  await assert.rejects(
    acceptSignedInstaller(original, signed, destination, version, winEnv, () => "valid"),
    /unchanged/,
  );
  await writeFile(path.join(signed, "setup.exe"), "signed");
  await writeFile(path.join(signed, "extra.exe"), "unexpected");
  await assert.rejects(
    acceptSignedInstaller(original, signed, destination, version, winEnv, () => "valid"),
    /Unexpected/,
  );
  await rm(path.join(signed, "extra.exe"));
  await assert.rejects(
    acceptSignedInstaller(original, signed, destination, version, winEnv, () => {
      throw new Error("Bad certificate");
    }),
    /Bad certificate/,
  );
  await assert.rejects(readFile(destination), /ENOENT/);
  const calls = [];
  await acceptSignedInstaller(original, signed, destination, version, winEnv, (...args) => {
    calls.push(args);
    return "valid";
  });
  assert.ok(calls[0][1].includes("-Installer"));
  assert.ok(calls[0][1].includes(version));
  assert.equal(await readFile(destination, "utf8"), "signed");
});
