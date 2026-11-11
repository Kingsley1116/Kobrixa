import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  copyDesktopBundle,
  macBundle,
  signMacTestBundle,
  verifyMacBundle,
} from "./macos-test-bundle.mjs";

test("macOS copies use ditto without dereferencing framework links", async () => {
  const calls = [];
  await copyDesktopBundle("/build folder", "/test folder", "darwin", async (...args) =>
    calls.push(args),
  );
  assert.deepEqual(calls, [["/usr/bin/ditto", ["/build folder", "/test folder"]]]);
  const error = new Error("copy failed");
  await assert.rejects(
    copyDesktopBundle("a", "b", "darwin", async () => {
      throw error;
    }),
    (e) => e === error,
  );
});

test("credential-free test signing signs nested code before strict deep verification", async () => {
  const calls = [];
  await signMacTestBundle("/test/Kobrixa.app", "/entitlements.plist", {
    sign: async (options) => {
      calls.push("sign");
      assert.equal(options.identity, "-");
      assert.equal(options.identityValidation, false);
      assert.equal(options.preAutoEntitlements, false);
      assert.equal(options.preEmbedProvisioningProfile, false);
      assert.equal(options.strictVerify, true);
      assert.equal(options.app, "/test/Kobrixa.app");
      assert.deepEqual(options.optionsForFile("helper"), {
        entitlements: "/entitlements.plist",
        hardenedRuntime: false,
        timestamp: "none",
      });
    },
    run: async (file, args) => {
      calls.push("verify");
      assert.equal(file, "/usr/bin/codesign");
      assert.deepEqual(args, ["--verify", "--deep", "--strict", "/test/Kobrixa.app"]);
    },
  });
  assert.deepEqual(calls, ["sign", "verify"]);
});

test("a signing or strict-verification failure remains a failure", async () => {
  const error = new Error("nested helper signature invalid");
  await assert.rejects(
    signMacTestBundle("/app", "/entitlements", {
      sign: async () => {
        throw error;
      },
      run: () => assert.fail("must not verify unsigned output"),
    }),
    (e) => e === error,
  );
  await assert.rejects(
    signMacTestBundle("/app", "/entitlements", {
      sign: async () => {},
      run: async () => {
        throw error;
      },
    }),
    (e) => e === error,
  );
  await assert.rejects(
    verifyMacBundle("/app", async () => {
      throw error;
    }),
    (e) => e === error,
  );
});

test("non-macOS copying retains real files and macOS bundle discovery rejects ambiguity", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "installed-copy-unit-"));
  try {
    const source = path.join(directory, "source"),
      target = path.join(directory, "target");
    await mkdir(source);
    await writeFile(path.join(source, "kobrixa.exe"), "unit fixture");
    await copyDesktopBundle(source, target, "win32", () => assert.fail("no macOS command"));
    assert.equal(await readFile(path.join(target, "kobrixa.exe"), "utf8"), "unit fixture");
    await assert.rejects(macBundle(source), /exactly one/);
    await mkdir(path.join(source, "kobrixa.app"));
    assert.equal(await macBundle(source), path.join(source, "kobrixa.app"));
    await mkdir(path.join(source, "extra.app"));
    await assert.rejects(macBundle(source), /exactly one/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
