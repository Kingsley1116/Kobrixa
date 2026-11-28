import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditFeature,
  auditSource,
  auditBundle,
  auditTrace,
  auditRetiredSource,
  auditRetiredText,
  auditProductionLeaf,
  auditInstalledTrace,
  classifyInput,
  rpcPolicy,
  auditLaunchedTrace,
  auditRuntimeCode,
} from "./stage-3-boundary-audit.mjs";

const feature = "sensor-lab";
const filename = "plugins/sensor-lab/src/negative.ts";
const artifact = auditFeature(feature);

test("Lab source AST and actual transitive bundle use only public contracts and feature models", async () => {
  const result = await artifact;
  assert.ok(result.sources["plugins/sensor-lab/src/model/chart.ts"]);
  assert.equal(
    classifyInput(feature, "plugins/sensor-lab/src/model/calibration.ts"),
    "pure-feature-model",
  );
  assert.ok(result.sources["packages/plugin-sdk-js/src/index.ts"]);
  assert.equal(result.bundleSha256.length, 64);
});

test("Lab negative AST: dynamic imports, hidden facades, channels, DTOs and native I/O", () => {
  for (const source of [
    'import("@kobrixa/plugin-sdk");',
    'const load = require; load("node:fs");',
    'const hidden = globalThis; hidden["kobrixa"].sensorLab.start();',
    "const { kobrixa: facade } = window; facade.sensorLab.start();",
    'const host = (globalThis as unknown); host["window"];',
    'const c = "sensor-lab:start";',
    'const c = "device:monitor";',
    'import type { SensorLabApi } from "../../../apps/desktop/src/shared/api";',
    'export * from "../../../apps/desktop/src/shared/sensor-lab";',
    'type Private = import("../../../apps/desktop/src/shared/api").KobrixaApi;',
    'import x = require("node:fs");',
    'import x from "node-hid";',
    'import x from "@kobrixa/device";',
    'import x from "node:fs/promises";',
    'import { createRequire } from "node:module";',
    'import crypto from "node:crypto";',
    'import { createPrivateKey } from "node:crypto";',
    'const p = process; p.parentPort.postMessage("hidden");',
    "(process as unknown as {parentPort: object}).parentPort;",
    'new Function("return process")();',
    'const evaluate = eval; evaluate("process");',
  ])
    assert.throws(() => auditSource(feature, source, filename), undefined, source);
  auditSource(feature, 'import { createHash as hash, randomUUID } from "node:crypto";', filename);
  auditSource(feature, 'import { reduceSeries } from "./model/chart.js";', filename);
  auditSource(
    feature,
    "process.env.KOBRIXA_RESOURCE_OWNER; process.exit(1); (process as unknown as {parentPort: object}).parentPort;",
    "packages/plugin-sdk-js/src/index.ts",
  );
  for (const source of [
    "process.env.HOME;",
    "const p = process;",
    'process.getBuiltinModule("fs");',
    'import("node:fs");',
  ])
    assert.throws(() => auditSource(feature, source, "packages/plugin-sdk-js/src/index.ts"));
});

test("Lab transitive metadata, hidden private bundle and runtime external negatives", async () => {
  const { metadata, code } = await artifact;
  for (const name of [
    "apps/desktop/src/shared/sensor-lab.ts",
    "apps/desktop/src/main/plugins/facade.ts",
    "packages/device/src/index.ts",
    "node_modules/node-hid/index.js",
    "plugins/device-ev3/src/controller.ts",
    "plugins/sensor-lab/src/../../../../apps/desktop/src/shared/api.ts",
  ]) {
    const bad = structuredClone(metadata);
    bad.inputs[name] = { imports: [] };
    assert.throws(() => auditBundle(feature, bad, code));
  }
  for (const external of [
    "electron",
    "node:fs",
    "node:net",
    "node-hid",
    "@kobrixa/plugin-sdk",
    "./hidden-facade.cjs",
  ]) {
    const bad = structuredClone(metadata);
    Object.values(bad.outputs)[0].imports.push({
      path: external,
      external: true,
      kind: "require-call",
    });
    assert.throws(() => auditBundle(feature, bad, code));
  }
  for (const injected of [
    '"sensor-lab:start";',
    'const hidden = "ipcRenderer";',
    "class SensorLabService {}",
  ])
    assert.throws(() => auditBundle(feature, metadata, code + injected));
  const dynamic = structuredClone(metadata);
  Object.values(dynamic.outputs)[0].imports.push({
    path: "node:crypto",
    external: true,
    kind: "dynamic-import",
  });
  assert.throws(() => auditBundle(feature, dynamic, code));
});

// Validator samples only. These synthetic rows are never written as receipts.
function sampleWire() {
  const owner = {
    pluginId: "kobrixa.sensor-lab",
    sourceKey: "builtin:kobrixa.sensor-lab",
    hostEpoch: "host",
    processEpoch: "process",
    generation: 1,
  };
  return rpcPolicy[feature].required.flatMap((method, i) => [
    {
      sequence: i * 2 + 1,
      owner,
      direction: "plugin-host",
      message: { jsonrpc: "2.0", id: i, method, params: {} },
    },
    {
      sequence: i * 2 + 2,
      owner,
      direction: "host-plugin",
      message: { jsonrpc: "2.0", id: i, result: { ok: true, value: {} } },
    },
  ]);
}
test("Lab trace oracle accepts correlated samples, rejects private calls and unsupported observation claims", () => {
  assert.equal(auditTrace(feature, sampleWire()).length, rpcPolicy[feature].required.length);
  assert.throws(() => auditTrace(feature, []));
  for (const method of [
    "sensor-lab:start",
    "device:monitor",
    "devices/connect",
    "devices/motion/start",
    "storage/private/read",
    "fs/readFile",
  ])
    assert.throws(() => {
      const wire = sampleWire();
      wire[0].message.method = method;
      auditTrace(feature, wire);
    });
  for (const mutate of [
    (wire) => wire.splice(0, 2),
    (wire) => {
      wire[1].message.result.ok = false;
    },
    (wire) => {
      wire[1].message.id = "unrelated";
    },
    (wire) => {
      wire[1].sequence = 1;
    },
    (wire) => {
      wire[1].owner = { ...wire[1].owner, generation: 2 };
    },
    (wire) => {
      wire[0].direction = "hidden";
    },
    (wire) => {
      wire[0].message = { jsonrpc: "2.0", method: "$/cancelRequest", params: { id: 999 } };
    },
  ]) {
    const wire = sampleWire();
    mutate(wire);
    assert.throws(() => auditTrace(feature, wire));
  }
});

test("Lab retired runtime symbols and channels are absent from current product source", async () => {
  assert.ok((await auditRetiredSource(feature)).length > 0);
  for (const code of ['"sensor-lab:state"', "new SensorLabService()", "<SensorLabPanel />"])
    assert.throws(() => auditRetiredText(feature, code, "product.js"));
  auditRetiredText(
    feature,
    "sensorLabImportDescriptors; validateCalibration(); recordingCsv();",
    "product.js",
  );
});

test("installed Lab generations are audited separately without laundering coverage or unknown owners", () => {
  const first = sampleWire();
  const secondOwner = { ...first[0].owner, generation: 2, processEpoch: "second" };
  const second = structuredClone(first.slice(0, 2)).map((row, i) => ({
    ...row,
    sequence: first.length + i + 1,
    owner: secondOwner,
  }));
  const report = {
    launches: [{ owner: first[0].owner }, { owner: secondOwner }],
    wire: [...first, ...second],
  };
  assert.equal(auditLaunchedTrace(feature, report).length, 2);
  for (const mutate of [
    (r) => {
      r.wire.at(-2).message.method = "device:monitor";
    },
    (r) => {
      r.wire.at(-1).owner = { ...secondOwner, processEpoch: "foreign" };
    },
    (r) => {
      r.launches[1].owner = r.launches[0].owner;
    },
    (r) => {
      r.wire[0].owner = secondOwner;
      r.wire[1].owner = secondOwner;
    },
    (r) => {
      r.wire.at(-1).sequence = 0;
    },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => auditLaunchedTrace(feature, invalid));
  }
});

test("shipped-code parser rejects computed, dynamic, aliased and private runtime loading", () => {
  auditRuntimeCode('const crypto = require("node:crypto");');
  for (const source of [
    'require("node:fs");',
    'require("@kobrixa/plugin-sdk");',
    'require("node:" + "fs");',
    "require(name);",
    'import("node:crypto");',
    'const load = require; load("node:fs");',
    'require.call(null, "node:fs");',
    'const channel = "sensor-lab:state";',
  ])
    assert.throws(() => auditRuntimeCode(source), undefined, source);
});

test(
  "Lab final production leaf metadata/content and actual installed RPC transcript",
  {
    skip:
      !process.env.W08_LAB_LEAF || !process.env.W08_LAB_RECEIPTS
        ? "NOT RUN: set W08_LAB_LEAF and W08_LAB_RECEIPTS to a final leaf and freshly executed installed acceptance directory"
        : false,
  },
  async () => {
    const production = await auditProductionLeaf(
      feature,
      process.env.W08_LAB_LEAF,
      process.env.W08_LAB_SOURCE_MAP,
    );
    await auditInstalledTrace(feature, process.env.W08_LAB_RECEIPTS, production);
  },
);
