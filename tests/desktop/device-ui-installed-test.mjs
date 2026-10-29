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
