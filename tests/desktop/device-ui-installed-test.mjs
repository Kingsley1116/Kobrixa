import assert from "node:assert/strict";
import test from "node:test";
import {
  verifyInstalledDeviceReceipt,
  deviceInstalledOptions,
} from "./device-ui-installed-run.mjs";
// Manufactured oracle fixtures only; never native evidence.
const fixture = () => ({
  schema: 1,
  stage: "complete",
  installed: true,
  scenario: "absent",
  failures: [],
  launches: [],
  exits: [],
  wire: [],
  providerCreations: 0,
  checkpoints: {
    isolation: {
      sourceDenied: true,
      networkDenied: true,
      noPathNode: true,
      probes: ["/source/package.json", "/deps/package.json"],
    },
    chromiumSandbox: true,
    negative: {
      row: {
        sourceKey: "builtin:kobrixa.device-ev3",
        status: "invalid",
        problems: [{ code: "PLUGIN_E_ENTRY" }],
      },
      catalog: { ok: true, value: { entries: [] } },
      activation: { ok: false },
    },
  },
  cleanup: { bridge: { pending: 0 }, worker: { pending: 0 }, workers: 0 },
});
for (const scenario of ["absent", "missing-resource", "tampered"])
  test("invalid installed " + scenario + " requires no launch/fallback", () => {
    const r = fixture();
    r.scenario = scenario;
    assert.equal(verifyInstalledDeviceReceipt(r).scenario, scenario);
  });
for (const [name, mutate] of [
  ["not installed", (r) => (r.installed = false)],
  ["unknown scenario", (r) => (r.scenario = "other")],
  ["source accessible", (r) => (r.checkpoints.isolation.sourceDenied = false)],
  ["no probes", (r) => (r.checkpoints.isolation.probes = [])],
  ["network accessible", (r) => (r.checkpoints.isolation.networkDenied = false)],
  ["sandbox disabled", (r) => (r.checkpoints.chromiumSandbox = false)],
  ["fallback provider", (r) => (r.providerCreations = 1)],
  ["launch", (r) => r.launches.push({})],
  ["RPC", (r) => r.wire.push({})],
  ["valid row", (r) => (r.checkpoints.negative.row.status = "enabled")],
  [
    "catalog fallback",
    (r) => r.checkpoints.negative.catalog.value.entries.push({ pluginId: "kobrixa.device-ev3" }),
  ],
  ["activation succeeded", (r) => (r.checkpoints.negative.activation.ok = true)],
  ["worker leak", (r) => (r.cleanup.workers = 1)],
])
  test("rejects " + name, () => {
    const r = fixture();
    mutate(r);
    assert.throws(() => verifyInstalledDeviceReceipt(r));
  });
test("device configuration selects production leaf and declared settings negative", () => {
  assert.equal(deviceInstalledOptions.slug, "device-ev3");
  assert.equal(deviceInstalledOptions.missingResource, "settings/preferences.json");
  assert.equal(deviceInstalledOptions.switchPrefix, "device");
});

test("device scenarios copy only immutable declared original fixture, never a consumed profile", async (t) => {
  const { mkdtemp, mkdir, writeFile, readFile, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { prepareDeviceProfileFixture } = await import("./device-ui-installed-run.mjs");
  const { prepareScenarioProfile, labInstalledOptions } =
    await import("./sensor-lab-installed-run.mjs");
  const { legacyDevice } = await import("./device-ui-public-run.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "e6-seed-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { artifactHashes: {} };
  await prepareDeviceProfileFixture(root, identity);
  await mkdir(path.join(root, "profile"));
  await writeFile(
    path.join(root, "profile/device-settings.json"),
    "consumed profile must not copy",
  );
  for (const name of ["healthy", "absent", "missing-resource", "tampered"]) {
    const target = path.join(root, name);
    await mkdir(target);
    await prepareScenarioProfile(root, target, identity, deviceInstalledOptions);
    assert.deepEqual(await readdir(path.join(target, "profile")), ["device-settings.json"]);
    assert.equal(
      await readFile(path.join(target, "profile/device-settings.json"), "utf8"),
      JSON.stringify(legacyDevice),
    );
    await assert.rejects(prepareScenarioProfile(root, target, identity, deviceInstalledOptions));
  }
  const lab = path.join(root, "lab");
  await mkdir(lab);
  await prepareScenarioProfile(root, lab, {}, labInstalledOptions);
  assert.deepEqual(await readdir(path.join(lab, "profile")), []);
  await writeFile(path.join(root, "fixtures/device-settings.json"), "tampered");
  const bad = path.join(root, "bad");
  await mkdir(bad);
  await assert.rejects(prepareScenarioProfile(root, bad, identity, deviceInstalledOptions));
});
test("device scenario refuses missing or foreign fixture metadata", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { prepareScenarioProfile } = await import("./sensor-lab-installed-run.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "e6-seed-metadata-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [i, identity] of [
    { artifactHashes: {} },
    {
      artifactHashes: {},
      profileFixture: {
        path: "profile/device-settings.json",
        target: "device-settings.json",
        sha256: "x",
      },
    },
  ].entries()) {
    const target = path.join(root, String(i));
    await mkdir(target);
    await assert.rejects(prepareScenarioProfile(root, target, identity, deviceInstalledOptions));
  }
});
