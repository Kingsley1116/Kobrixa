import test from "node:test";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { verifyDeviceReceipt, legacyDevice } from "./device-ui-public-run.mjs";

// Oracle-only manufactured input. Never a producer receipt or native evidence.
function fixture() {
  const owner = {
    pluginId: "kobrixa.device-ev3",
    sourceKey: "builtin:kobrixa.device-ev3",
    generation: 1,
    hostEpoch: "00000000-0000-4000-8000-000000000001",
    processEpoch: "00000000-0000-4000-8000-000000000002",
  };
  const previous = {
    hostEpoch: owner.hostEpoch,
    workbenchInstance: "00000000-0000-4000-8000-000000000003",
  };
  const committed = { ...previous, workbenchInstance: "00000000-0000-4000-8000-000000000004" };
  const checkpoints = Object.fromEntries(
    [
      "migrated",
      "opened",
      "reopened",
      "read",
      "mode",
      "updated",
      "reset",
      "hiding",
      "hidden",
      "disabled",
      "reenabled",
    ].map((name, i) => [
      name,
      {
        at: 100 + i * 100,
        launches: i === 0 ? 0 : 1,
        settings: { state: name === "disabled" ? "unavailable" : "ready" },
      },
    ]),
  );
  checkpoints.migrated.settings.values = {
    ...legacyDevice,
    connectionMode: "usb",
    rememberWifiAddress: true,
    lastWifiAddress: " 192.0.2.9 ",
  };
  checkpoints.updated.settings.values = { skipUnchangedAssets: false };
  checkpoints.reset.settings.values = { skipUnchangedAssets: true };
  const wire = [],
    native = [],
    inputs = [],
    actionIpc = [];
  let id = 0;
  function pair(method, params = {}, at = 350, direction = "plugin-host") {
    const request = { sequence: 0, at, owner, direction, message: { id: ++id, method, params } };
    const response = {
      sequence: 0,
      at: at + 1,
      owner,
      direction: direction === "plugin-host" ? "host-plugin" : "plugin-host",
      message: { id, result: { ok: true, value: { fieldErrors: [] } } },
    };
    wire.push(request, response);
    return { request, response };
  }
  for (const method of ["settings/read", "settings/watch"]) pair(method);
  const specs = [
    ["discover", "discover-action", "devices/discover"],
    ["candidate", "candidates", "devices/connect"],
    ["refresh", "refresh-action", "devices/read"],
    ["modes", "modes-action", "devices/inputModes/query"],
    ["mode", "modes", "devices/inputModes/set"],
  ];
  for (const [index, [command, node, operation]] of specs.entries()) {
    const at = 350 + index * 10,
      binding = { panelInstance: "original" },
      targetId = index + 1;
    const row = command === "candidate" || command === "mode";
    const args = row ? { key: `row-${index}`, version: "1", dataset: 2 } : {};
    const ariaLabel = row ? `Select: ${args.key}` : null;
    const invocationId = `invocation-${index}`;
    const commandPair = pair(
      "command/invoke",
      {
        command: `kobrixa.device-ev3.${command}`,
        invocationId,
        arguments: args,
        context: { origin: "panel", binding },
      },
      at,
      "host-plugin",
    );
    commandPair.response.at = at + 8;
    pair(operation, {}, at + 1);
    inputs.push({
      command,
      at: at - 4,
      selector: row
        ? `[data-ui-node="${node}"] tbody tr button`
        : `[data-ui-node="${node}"] button`,
      binding,
      target: { node, targetId, ariaLabel },
    });
    for (const [offset, type] of [
      [-3, "pointerdown"],
      [-2, "pointerup"],
    ])
      native.push({ type, isTrusted: true, at: at + offset, node, targetId, ariaLabel });
    actionIpc.push({
      channel: "plugins:ui:interact",
      at: at - 1,
      finishedAt: at + 9,
      args: [
        {
          kind: row ? "row" : "action",
          nodeId: node,
          binding,
          ...(row ? { key: args.key, dataset: node, revision: args.dataset } : {}),
        },
      ],
      result: { ok: true, value: { kind: "command", invocationId } },
    });
    if (row)
      actionIpc.push({
        channel: "plugins:ui:data-read",
        at: at - 6,
        finishedAt: at - 5,
        args: [{ binding, dataset: node, revision: 2 }],
        result: {
          ok: true,
          value: { revision: 2, chunk: { entries: [{ key: args.key, version: args.version }] } },
        },
      });
  }
  // Actual SDK disposal uses events/unsubscribe for devices/subscribe identities.
  for (const [index, topic] of [
    "catalog",
    "connectionRecovery",
    "session",
    "telemetry",
    "authority",
  ].entries()) {
    const subscriptionId = `device-observer-${index}`;
    pair("devices/subscribe", { topic }, 450 + index).response.message.result.value = {
      subscriptionId,
      sequence: 0,
      snapshot: {},
    };
    pair("events/unsubscribe", { subscriptionId }, 820 + index).response.message.result.value = {
      removed: true,
    };
  }
  // A later, unrelated stale shutdown disposal is not hide proof or a global failure.
  pair("events/unsubscribe", { subscriptionId: "ui-retired" }, 950).response.message.result = {
    ok: false,
    error: { code: "PLUGIN_E_STALE_RESOURCE", message: "Resource is unavailable." },
  };
  wire.sort((a, b) => a.at - b.at).forEach((row, index) => (row.sequence = index + 1));
  for (const name of ["hiding", "hidden"])
    checkpoints[name].sequence = Math.max(
      ...wire.filter((row) => row.at <= checkpoints[name].at).map((row) => row.sequence),
    );
  return {
    schema: 1,
    stage: "complete",
    failures: [],
    versions: { electron: "test-only" },
    mainPid: 1,
    launches: [{ owner, at: 150 }],
    exits: [{ owner, at: 990 }],
    logs: ["DEVICE_PID:2"],
    wire,
    native,
    inputs,
    legacyAudit: [
      {
        kind: "seed",
        at: 1,
        entries: [
          { key: "kobrixa.connectionMode", raw: "usb" },
          { key: "kobrixa.rememberWifiAddress", raw: "true" },
          { key: "kobrixa.lastWifiAddress", raw: " 192.0.2.9 " },
        ],
      },
    ],
    checkpoints,
    navigation: [{ at: 10, retiredAt: 20, committedAt: 30, previous, next: committed, committed }],
    gate: ["constructed-frozen", "gate-freeze", "gate-settled"].map((phase) => ({ phase, at: 1 })),
    ipc: [
      ...actionIpc,
      {
        channel: "persistence:legacy-preferences-submit",
        at: 50,
        result: { state: "accepted" },
        args: [
          {
            scope: committed,
            entries: [
              { key: "kobrixa.connectionMode", raw: "usb" },
              { key: "kobrixa.rememberWifiAddress", raw: "true" },
              { key: "kobrixa.lastWifiAddress", raw: " 192.0.2.9 " },
            ],
          },
        ],
      },
      ...["open", "watch", "unwatch"].map((method) => ({ channel: `plugins:settings:${method}` })),
      ...["update", "reset"].map((method, i) => ({
        channel: `plugins:settings:${method}`,
        args: [
          {},
          {
            expectedRevision: `revision-${i}`,
            ...(i === 0
              ? { changes: [{ key: "skipUnchangedAssets", value: false }] }
              : { keys: ["skipUnchangedAssets"] }),
          },
        ],
        result: {
          ok: true,
          value: {
            snapshot: {
              revision: `revision-${i + 1}`,
              values: [{ key: "skipUnchangedAssets", value: i === 1 }],
            },
          },
        },
      })),
      { channel: "plugins:settings:changed", direction: "publish" },
    ],
    cleanup: { workers: 0, bridge: { subscriptions: 0 }, worker: { requests: 0 } },
  };
}
test("oracle accepts internally correlated synthetic fixture (not native evidence)", () =>
  assert.equal(verifyDeviceReceipt(fixture()).synthetic, true));
const corruptions = {
  "incomplete producer": (r) => {
    r.stage = "cleanup";
  },
  "missing migration": (r) => {
    delete r.checkpoints.migrated;
  },
  "fabricated defaults": (r) => {
    r.checkpoints.migrated.settings.values.usbAutoReconnect = true;
  },
  "unrotated document scope": (r) => {
    r.navigation[0].previous = r.navigation[0].next;
  },
  "stale capture scope": (r) => {
    r.ipc.find((row) => row.channel === "persistence:legacy-preferences-submit").args[0].scope =
      r.navigation[0].previous;
  },
  "capture before commit": (r) => {
    r.navigation[0].committedAt = 1000;
  },
  "unfinished document retirement": (r) => {
    delete r.navigation[0].retiredAt;
  },
  "missing capture": (r) => {
    r.ipc = r.ipc.filter((row) => row.channel !== "persistence:legacy-preferences-submit");
  },
  "late freeze": (r) => {
    r.gate[0].at = 10000;
  },
  "same main PID": (r) => {
    r.logs = ["DEVICE_PID:1"];
  },
  "missing utility PID": (r) => {
    r.logs = [];
  },
  "replacement owner": (r) => {
    r.wire[0].owner = { ...r.wire[0].owner, generation: 2 };
  },
  "missing original reply": (r) => {
    r.wire.splice(1, 1);
  },
  "forged success checkpoint": (r) => {
    r.wire = r.wire.filter((row) => row.message.method !== "devices/inputModes/set");
  },
  "failed RPC": (r) => {
    r.wire.find((row) => row.message.result).message.result = {
      ok: false,
      error: { code: "failed" },
    };
  },
  "automatic connect": (r) => {
    r.wire.find((row) => row.message.method === "devices/connect").at = 150;
  },
  "untrusted renderer input": (r) => {
    r.native.forEach((row) => (row.isTrusted = false));
  },
  "no CAS revision": (r) => {
    delete r.ipc.find((row) => row.channel === "plugins:settings:update").args[1].expectedRevision;
  },
  "missing watch publication": (r) => {
    r.ipc = r.ipc.filter((row) => row.direction !== "publish");
  },
  "re-enable launched process": (r) => {
    r.checkpoints.reenabled.launches = 2;
  },
  "forged reset revision": (r) => {
    r.ipc.find((row) => row.channel === "plugins:settings:reset").result.value.snapshot.revision =
      "revision-1";
  },
  "one unrelated click for all commands": (r) => {
    r.native = [{ type: "pointerdown", isTrusted: true, at: 349, node: "unrelated", targetId: 99 }];
  },
  "reused exact trusted click": (r) => {
    r.native = r.native.slice(0, 2);
  },
  "wrong action node": (r) => {
    r.native[0].node = "unrelated";
  },
  "wrong selected row": (r) => {
    r.native.find((e) => e.node === "candidates").ariaLabel = "Select: foreign";
  },
  "operation before its invocation": (r) => {
    r.wire.find((e) => e.message.method === "devices/inputModes/set").at = 360;
  },
  "legacy write after seeding": (r) => {
    r.legacyAudit.push({
      kind: "write",
      at: 2,
      key: "kobrixa.lastWifiAddress",
      raw: " 192.0.2.9 ",
    });
  },
  "missing cleanup": (r) => {
    r.cleanup.workers = 1;
  },
};
for (const [name, corrupt] of Object.entries(corruptions))
  test(`rejects ${name}`, () => {
    const report = fixture();
    corrupt(report);
    assert.throws(() => verifyDeviceReceipt(report));
  });

for (const address of ["192.0.2.9", " 192.0.2.9 "])
  test(`actual bootstrap freezes original bytes before any settings write: ${JSON.stringify(address)}`, async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const deps = process.env.KOBRIXA_E6_DEPS ?? root;
    const require = createRequire(path.join(deps, "package.json"));
    const { build } = createRequire(require.resolve("vitest/package.json"))("esbuild");
    const directory = await mkdtemp("/private/tmp/e6-freeze-test-");
    try {
      const output = path.join(directory, "actual.mjs");
      await build({
        stdin: {
          contents: `export {SettingsStore} from ${JSON.stringify(path.join(root, "apps/desktop/src/renderer/settings/settings.ts"))}; export {createDevicePreferencesMigration} from ${JSON.stringify(path.join(root, "apps/desktop/src/renderer/settings/legacy-preferences-bridge.ts"))};`,
          loader: "ts",
          resolveDir: root,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: output,
      });
      const { SettingsStore, createDevicePreferencesMigration } = await import(
        pathToFileURL(output).href
      );
      const originals = [
        { key: "kobrixa.connectionMode", raw: "usb" },
        { key: "kobrixa.rememberWifiAddress", raw: "true" },
        { key: "kobrixa.lastWifiAddress", raw: address },
      ];
      const stored = new Map(originals.map((e) => [e.key, e.raw])),
        writes = [];
      const storage = {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => {
          writes.push({ key, raw: value });
          stored.set(key, value);
        },
      };
      const settingsStore = new SettingsStore(() => storage, "en");
      let migration, submitted;
      const pluginUiWindow = () =>
        (migration = createDevicePreferencesMigration({
          settings: settingsStore,
          storage: () => storage,
          api: {
            challenge: async () => ({
              descriptorId: "kobrixa.device-preferences",
              nonce: "00000000-0000-4000-8000-000000000001",
              scope: {
                hostEpoch: "00000000-0000-4000-8000-000000000002",
                workbenchInstance: "00000000-0000-4000-8000-000000000003",
              },
              keys: originals.map((e) => e.key),
            }),
            submit: async (snapshot) => {
              submitted = snapshot;
              return { state: "accepted" };
            },
          },
        }));
      // Execute the exact small bootstrap block, not a test-authored reordering.
      const renderer = await readFile(
        path.join(root, "tests/desktop/device-ui-public-renderer.tsx"),
        "utf8",
      );
      const start = renderer.indexOf("// These controls never");
      const end = renderer.indexOf("const query =", start);
      assert.ok(start >= 0 && end > start);
      Function(
        "settingsStore",
        "pluginUiWindow",
        renderer.slice(start, end),
      )(settingsStore, pluginUiWindow);
      assert.equal(await migration.retry(), "accepted");
      assert.deepEqual(
        writes.filter((e) => originals.some((o) => o.key === e.key)),
        [],
      );
      assert.deepEqual(submitted.entries, originals);
      assert.ok(
        writes.some((e) => e.key === "kobrixa.layout.rightPanel"),
        "Unrelated settings still saved",
      );
      migration.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

for (const [name, corrupt] of [
  [
    "obsolete device unsubscribe method",
    (r) => {
      for (const row of r.wire)
        if (row.message.method === "events/unsubscribe") row.message.method = "devices/unsubscribe";
    },
  ],
  [
    "wrong disposed subscription",
    (r) => {
      r.wire.find(
        (row) => row.message.method === "events/unsubscribe",
      ).message.params.subscriptionId = "other";
    },
  ],
  [
    "reused subscription identity",
    (r) => {
      const rows = r.wire.filter((row) => row.message.result?.value?.subscriptionId);
      rows[1].message.result.value.subscriptionId = rows[0].message.result.value.subscriptionId;
    },
  ],
  [
    "unsuccessful removal",
    (r) => {
      const q = r.wire.find((row) => row.message.method === "events/unsubscribe");
      r.wire.find(
        (row) => !row.message.method && row.message.id === q.message.id,
      ).message.result.value.removed = false;
    },
  ],
  [
    "missing original disposal reply",
    (r) => {
      const q = r.wire.find((row) => row.message.method === "events/unsubscribe");
      r.wire = r.wire.filter((row) => row.message.method || row.message.id !== q.message.id);
    },
  ],
  [
    "disposal only after hidden",
    (r) => {
      r.checkpoints.hidden.sequence = r.checkpoints.hiding.sequence + 1;
    },
  ],
])
  test(`rejects ${name}`, () => {
    const report = fixture();
    corrupt(report);
    assert.throws(() => verifyDeviceReceipt(report));
  });
