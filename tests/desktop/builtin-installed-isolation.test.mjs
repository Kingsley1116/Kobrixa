import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  assertInstalledLinuxNetwork,
  installedAppArmorProfile,
} from "./builtin-installed-linux.mjs";
import {
  checkMacInstalledSandbox,
  MACOS_NESTED_SANDBOX_BLOCKED,
} from "./builtin-installed-macos.mjs";

test("Linux isolation requires reachable IPv4 loopback and rejects external addresses", () => {
  const loopback = { internal: true, address: "127.0.0.1" };
  assertInstalledLinuxNetwork({ lo: [loopback] });
  assertInstalledLinuxNetwork({ lo: [loopback, { internal: true, address: "::1" }] });
  assert.throws(() => assertInstalledLinuxNetwork({}), /loopback up/);
  assert.throws(
    () => assertInstalledLinuxNetwork({ lo: [{ internal: true, address: "::1" }] }),
    /loopback up/,
  );
  assert.throws(
    () =>
      assertInstalledLinuxNetwork({
        lo: [loopback],
        eth0: [{ internal: false, address: "10.0.0.2" }],
      }),
    /networkless namespace/,
  );
});

test("AppArmor permission targets copied installed executables without accepting policy injection", () => {
  const profile = installedAppArmorProfile("/home/runner/work/_temp");
  assert.match(
    profile,
    /"\/home\/runner\/work\/_temp\/kobrixa-installed-product-\*\/installed\/kobrixa" flags=\(unconfined\)/,
  );
  assert.match(profile, /\{\n {2}userns,\n\}/);
  for (const root of [
    "/",
    "relative",
    "/tmp/../root",
    "/tmp/",
    "/tmp/**",
    '/tmp/"',
    "/tmp/\n",
    "/tmp/{a,b}",
  ])
    assert.throws(() => installedAppArmorProfile(root));
});

test("macOS nested sandbox failure remains blocked with both native command results", async () => {
  const evidence = {};
  const cause = Object.assign(new Error("sandbox-exec: sandbox_apply: Operation not permitted"), {
    code: 71,
    stdout: "",
    stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n",
  });
  const calls = [];
  await assert.rejects(
    checkMacInstalledSandbox(
      "/tmp/evidence/isolation.sb",
      evidence,
      async (file, args, options) => {
        calls.push([file, args, options]);
        if (calls.length === 2) throw cause;
        return { stdout: "", stderr: "" };
      },
    ),
    (error) => error.code === MACOS_NESTED_SANDBOX_BLOCKED && error.cause === cause,
  );
  assert.equal(evidence.status, "blocked");
  assert.equal(evidence.results[0].code, 0);
  assert.equal(evidence.results[1].code, 71);
  assert.equal(evidence.results[1].stderr, cause.stderr);
  assert.deepEqual(
    calls.map(([file, args]) => [file, ...args]),
    evidence.commands,
  );
  assert.deepEqual(evidence.commands[1], [
    "/usr/bin/sandbox-exec",
    "-f",
    "/tmp/evidence/isolation.sb",
    "/usr/bin/sandbox-exec",
    "-p",
    "(version 1)(allow default)",
    "/usr/bin/true",
  ]);
  assert.equal(calls.length, 2); // No unsandboxed fallback.
});

test("macOS outer profile errors stay failures, and successful nesting is only a prerequisite", async () => {
  const evidence = {};
  const cause = Object.assign(new Error("invalid outer profile"), { code: 65 });
  let calls = 0;
  await assert.rejects(
    checkMacInstalledSandbox("bad.sb", evidence, async () => {
      calls++;
      throw cause;
    }),
    (error) => error === cause,
  );
  assert.equal(calls, 1);
  assert.equal(evidence.status, "failed");
  const allowed = {};
  await checkMacInstalledSandbox("valid.sb", allowed, async () => ({ stdout: "", stderr: "" }));
  assert.equal(allowed.status, "prerequisite-passed");
  assert.equal(allowed.results.length, 2);
  assert.equal(allowed.isolated, undefined);
});

test("installed workflow raises loopback before dropping root and pins the selected Node", async () => {
  const workflow = parse(
    await readFile(
      new URL("../../.github/workflows/stage-3-acceptance.yml", import.meta.url),
      "utf8",
    ),
  );
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
  const run = steps.find((step) => step.name === "Execute required native gate").run;
  assert.match(run, /installed_node="\$\(node -p 'process.execPath'\)"/);
  const linux = run.slice(
    run.indexOf("unshare --net"),
    run.indexOf("else", run.indexOf("unshare --net")),
  );
  assert.ok(linux.indexOf("ip link set lo up") < linux.indexOf("exec sudo"));
  assert.match(linux, /-u "\$1" -- "\$2" tests\/desktop\/stage-3-closeout-run.mjs installed --run/);
  assert.match(linux, /--preserve-env=DISPLAY,XAUTHORITY,TMPDIR,TMP,TEMP/);
  assert.doesNotMatch(run, /--no-sandbox|--disable-setuid-sandbox|sysctl -w/);
  const apparmor = steps.find(
    (step) => step.name === "Allow installed Chromium user namespaces on AppArmor hosts",
  );
  assert.equal(apparmor.if, "runner.os == 'Linux' && matrix.gate == 'installed'");
  assert.equal(apparmor.uses, "./.github/actions/installed-apparmor");
  assert.equal(apparmor.with.operation, "load");
  const action = parse(
    await readFile(
      new URL("../../.github/actions/installed-apparmor/action.yml", import.meta.url),
      "utf8",
    ),
  );
  const policy = action.runs.steps.map((step) => step.run).join("\n");
  assert.match(policy, /apparmor_parser -r/);
  assert.doesNotMatch(policy, /--no-sandbox|--disable-setuid-sandbox|sysctl -w/);
  const cleanup = steps.find(
    (step) =>
      step.name === "Retain installed Linux kernel denials and remove test AppArmor profile",
  );
  assert.match(cleanup.if, /always\(\)/);
  assert.equal(cleanup.uses, "./.github/actions/installed-apparmor");
  assert.equal(cleanup.with.operation, "unload");
  assert.match(policy, /apparmor_parser -R/);
});
