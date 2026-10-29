import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDevice, verifyDeviceReceipt } from "./device-ui-public-run.mjs";
import { verifyLeaf, digest } from "./sensor-lab-installed-artifacts.mjs";
import { auditPayload, finishInstalledBuild, runInstalled } from "./sensor-lab-installed-run.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const pluginId = "kobrixa.device-ev3";
export function verifyInstalledDeviceReceipt(report) {
  assert.equal(report.schema, 1);
  assert.equal(report.installed, true);
  assert.equal(report.stage, "complete");
  assert.deepEqual(report.failures, []);
  assert.ok(["healthy", "absent", "missing-resource", "tampered"].includes(report.scenario));
  const isolation = report.checkpoints.isolation;
  for (const key of ["sourceDenied", "networkDenied", "noPathNode"])
    assert.equal(isolation[key], true);
  assert.ok(
    isolation.probes.length >= 2 &&
      isolation.probes.every((p) => typeof p === "string" && path.isAbsolute(p)),
  );
  assert.equal(report.checkpoints.chromiumSandbox, true);
  assert.equal(report.cleanup.workers, 0);
  for (const counters of [report.cleanup.bridge, report.cleanup.worker]) {
    assert.ok(Object.keys(counters).length);
    for (const value of Object.values(counters)) assert.equal(value, 0);
  }
  if (report.scenario === "healthy") {
    assert.ok(Number.isSafeInteger(report.providerCreations) && report.providerCreations >= 1);
    return { scenario: report.scenario, ...verifyDeviceReceipt(report, { installed: true }) };
  }
  for (const key of ["launches", "exits", "wire"]) assert.deepEqual(report[key], []);
  assert.equal(report.providerCreations, 0);
  const { row, catalog, activation } = report.checkpoints.negative;
  assert.equal(row.sourceKey, "builtin:" + pluginId);
  assert.equal(row.status, "invalid");
  assert.ok(row.problems.some((p) => p.code === "PLUGIN_E_ENTRY"));
  assert.equal(catalog.ok, true);
  assert.ok(!catalog.value.entries.some((e) => e.pluginId === pluginId));
  assert.equal(activation.ok, false);
  return { scenario: report.scenario };
}
export const deviceInstalledOptions = Object.freeze({
  pluginId,
  slug: "device-ev3",
  switchPrefix: "device",
  missingResource: "settings/preferences.json",
  verify: verifyInstalledDeviceReceipt,
});
export async function prepareInstalledDevice(directory, artifact) {
  assert.ok(path.isAbsolute(artifact));
  const index = await verifyLeaf(artifact, pluginId);
  const dependencies = process.env.KOBRIXA_E6_DEPS ?? root;
  const audit = await auditPayload(artifact, dependencies);
  const identity = await buildDevice(directory, { productionLeaf: artifact });
  await writeFile(
    path.join(directory, "payload-audit.json"),
    JSON.stringify(audit.metafile, null, 2),
  );
  identity.artifactHashes["payload-audit.json"] = digest(
    await readFile(path.join(directory, "payload-audit.json")),
  );
  for (const name of ["device-ui-installed-run.mjs", "device-ui-installed-test.mjs"]) {
    const file = path.join(root, "tests/desktop", name);
    identity.sourceHashes[path.relative(root, file)] = digest(await readFile(file));
  }
  identity.claim =
    "installed production device leaf in acceptance host, not unmodified packaged application";
  identity.productArtifact = {
    path: artifact,
    index,
    indexSha256: digest(await readFile(path.join(artifact, "resource-index.json"))),
    buildCommit: "unattested: bind controller production packaging receipt separately",
  };
  return finishInstalledBuild(directory, artifact, identity, dependencies);
}
async function main(args) {
  if (args[0] === "--prepare") {
    const directory = await realpath(
      await mkdtemp(path.join(tmpdir(), "kobrixa-device-installed-")),
    );
    await prepareInstalledDevice(directory, args[1]);
    console.log("BUILD ONLY, no native execution: " + directory);
  } else {
    assert.equal(args[0], "--run-built");
    await runInstalled(await realpath(args[1]), deviceInstalledOptions);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
