import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  auditFeature,
  auditSource,
  auditBundle,
  auditTrace,
  auditRetiredSource,
  auditRetiredSources,
  retainedCoreAllowlist,
  root,
  auditRetiredText,
  auditProductionLeaf,
  auditInstalledTrace,
  retainedCoreChannels,
  rpcPolicy,
} from "./stage-3-boundary-audit.mjs";

const feature = "device-ev3";
const filename = "plugins/device-ev3/src/negative.ts";
const artifact = auditFeature(feature);

test("device source AST and actual transitive bundle depend only on public SDK/protocol", async () => {
  const result = await artifact;
  assert.ok(result.sources["plugins/device-ev3/src/controller.ts"]);
  assert.ok(result.sources["packages/plugin-sdk-js/src/index.ts"]);
  assert.equal(result.bundleSha256.length, 64);
});

test("device AST rejects dynamic imports, hidden facade, private channels, DTOs and native providers", () => {
  for (const source of [
    'import("@kobrixa/plugin-sdk");',
    'require("node:fs");',
    'const hidden = globalThis; hidden["window"]["kobrixa"].device.connect();',
    'const { device: d } = window["kobrixa"]; d.monitor();',
    'const channel = "device:connect-wifi";',
    'const channel = "device:set-preferences";',
    'import { DeviceMonitorSnapshot } from "@kobrixa/device";',
    'export * from "../../../apps/desktop/src/shared/api";',
    'import type { DeviceApi } from "../../../apps/desktop/src/shared/api";',
    'type Private = import("../../../apps/desktop/src/shared/api").DeviceApi;',
    'import x from "electron";',
    'import x from "node-hid";',
    'import x from "usb";',
    'import x from "node:net";',
    'import x from "node:fs/promises";',
    'process.parentPort.postMessage("connect");',
    "const p = process; p.env.HOME;",
    'import * as crypto from "node:crypto";',
    'import { createSecretKey } from "node:crypto";',
  ])
    assert.throws(() => auditSource(feature, source, filename), undefined, source);
  auditSource(feature, 'import { createHash } from "node:crypto";', filename);
  auditSource(
    feature,
    'import type { DeviceSessionSnapshot } from "@kobrixa/plugin-protocol";',
    filename,
  );
});

test("device bundle rejects hidden transitive facade, private content and every unapproved external", async () => {
  const { metadata, code } = await artifact;
  for (const name of [
    "apps/desktop/src/main/device/device.ts",
    "packages/device/src/index.ts",
    "node_modules/usb/index.js",
    "plugins/sensor-lab/src/model/data.ts",
  ]) {
    const bad = structuredClone(metadata);
    bad.inputs[name] = { imports: [] };
    assert.throws(() => auditBundle(feature, bad, code));
  }
  for (const name of [
    "electron",
    "node:fs",
    "node:net",
    "@kobrixa/device",
    "@kobrixa/plugin-sdk",
    "./private-facade.js",
  ]) {
    const bad = structuredClone(metadata);
    Object.values(bad.outputs)[0].imports.push({
      path: name,
      external: true,
      kind: "require-call",
    });
    assert.throws(() => auditBundle(feature, bad, code));
  }
  for (const injected of [
    '"device:monitor";',
    '"device:set-preferences";',
    "const x = window.kobrixa;",
    "class MonitorService {}",
  ])
    assert.throws(() => auditBundle(feature, metadata, code + injected));
});

// Validator-only fixtures; no synthetic row is evidence of an executed feature.
function sampleWire() {
  const owner = {
    pluginId: "kobrixa.device-ev3",
    sourceKey: "builtin:kobrixa.device-ev3",
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
test("device RPC oracle requires successful original replies and rejects private or cross-feature methods", () => {
  assert.equal(auditTrace(feature, sampleWire()).length, rpcPolicy[feature].required.length);
  assert.throws(() => auditTrace(feature, []));
  for (const method of [
    "device:connect",
    "devices/disconnect",
    "devices/motion/start",
    "devices/recording/reserve",
    "storage/beginWrite",
    "devices/private/connect",
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
      wire[1].owner = { ...wire[1].owner, processEpoch: "stale" };
    },
    (wire) => {
      wire[0].message.jsonrpc = "1.0";
    },
  ]) {
    const wire = sampleWire();
    mutate(wire);
    assert.throws(() => auditTrace(feature, wire));
  }
});

test("device retirement checker distinguishes retained core deployment/files/recovery from old feature bridges", () => {
  for (const channel of retainedCoreChannels)
    auditRetiredText(feature, JSON.stringify(channel), "product.cjs");
  for (const code of [
    '"device:connect"',
    '"device:set-preferences"',
    '"device:watch-monitor"',
    '"device:input-modes"',
    "<MonitorPanel />",
    "<MonitorWorkspace />",
  ])
    assert.throws(() => auditRetiredText(feature, code, "product.cjs"));
});

test("device retired feature bridges and old mounted controls are absent after W07b", async () => {
  await auditRetiredSource(feature);
});

// Real source is the baseline; mutations are validator negatives, not native evidence.
let coreSources;
async function retainedSources() {
  coreSources ??= auditRetiredSource(feature).then(async (files) =>
    Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [file, await readFile(path.join(root, file), "utf8")]),
      ),
    ),
  );
  return { ...(await coreSources) };
}

test("retained-core allowlist still rejects every retired feature outside its entries", async () => {
  const sources = await retainedSources();
  for (const token of [
    "device:monitor",
    "device:set-input-mode",
    "device:connect",
    "device:discover",
    "device:set-preferences",
    "MonitorPanel",
  ]) {
    assert.throws(
      () =>
        auditRetiredSources(feature, {
          ...sources,
          "apps/desktop/src/renderer/negative.ts": `const forbidden = ${JSON.stringify(token)};`,
        }),
      /Retired feature/,
    );
  }
});

test("retained-core channels reject second literal and facade consumers", async () => {
  const sources = await retainedSources();
  for (const entry of retainedCoreAllowlist.slice(0, 2)) {
    assert.throws(
      () =>
        auditRetiredSources(feature, {
          ...sources,
          "apps/desktop/src/renderer/negative.ts": `const channel = ${JSON.stringify(entry.token)};`,
        }),
      /Unapproved retained-core use/,
    );
  }
  for (const method of ["watchMonitor", "onMonitor"]) {
    const file = "apps/desktop/src/renderer/app.tsx";
    assert.throws(
      () =>
        auditRetiredSources(feature, {
          ...sources,
          [file]: sources[file] + `\nwindow.kobrixa.device["${method}"]();`,
        }),
      /Second retained-core consumer/,
    );
  }
});

test("retained-core consumers reject mode, sensor, connection, discovery and preference behavior", async () => {
  const sources = await retainedSources();
  for (const entry of retainedCoreAllowlist)
    for (const operation of [
      "setInputMode",
      "sampleSensors",
      "connect",
      "discover",
      "setPreferences",
    ]) {
      const file = entry.consumer.file;
      assert.throws(
        () =>
          auditRetiredSources(feature, {
            ...sources,
            [file]: sources[file] + `\nfeature.${operation}();`,
          }),
        /Changed retained-core consumer|Unapproved retained-core use/,
      );
    }
  const file = "apps/desktop/src/preload/index.ts";
  assert.throws(
    () =>
      auditRetiredSources(feature, {
        ...sources,
        [file]: sources[file].replace(
          'ipcRenderer.invoke("device:watch-monitor", sessionId, enabled)',
          'ipcRenderer.invoke("device:watch-monitor", sessionId, feature.sampleSensors())',
        ),
      }),
    /Unapproved retained-core use/,
  );
});

test("every retained-core entry must remain present, including its single reachable consumer", async () => {
  const sources = await retainedSources();
  for (const entry of retainedCoreAllowlist) {
    const missing = Object.fromEntries(
      Object.entries(sources).map(([file, source]) => [
        file,
        source.replaceAll(entry.token, "removedCoreItem"),
      ]),
    );
    assert.throws(() => auditRetiredSources(feature, missing), /Stale retained-core allowlist/);
  }
});

test(
  "device final production leaf metadata/content and actual installed RPC transcript",
  {
    skip:
      !process.env.W08_DEVICE_LEAF || !process.env.W08_DEVICE_RECEIPTS
        ? "NOT RUN: set W08_DEVICE_LEAF and W08_DEVICE_RECEIPTS after W07b and fresh installed execution"
        : false,
  },
  async () => {
    const production = await auditProductionLeaf(
      feature,
      process.env.W08_DEVICE_LEAF,
      process.env.W08_DEVICE_SOURCE_MAP,
    );
    await auditInstalledTrace(feature, process.env.W08_DEVICE_RECEIPTS, production);
  },
);
