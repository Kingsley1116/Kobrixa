import test from "node:test";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import {
  verifyDeviceReceipt,
  legacyDevice,
  verifyRestartReceipt,
  snapshotRestartProfile,
} from "./device-ui-public-run.mjs";

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
    const directory = await mkdtemp(path.join(tmpdir(), "e6-freeze-test-"));
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

function installedPidFixture() {
  const r = fixture();
  r.logs = [];
  Object.assign(r.launches[0], {
    pid: 2,
    parentPid: 1,
    processObservation: {
      pid: 2,
      ppid: 1,
      forkPid: 2,
      method: "utilityProcess.fork",
      serviceName: "Kobrixa plugin kobrixa.device-ev3",
    },
  });
  r.exits[0].exit = { code: 0 };
  return r;
}
test("installed receipt accepts OS-observed utility PID without instrumented leaf", () =>
  assert.equal(verifyDeviceReceipt(installedPidFixture(), { installed: true }).processId, 2));
for (const [name, mutate] of [
  ["foreign parent", (r) => (r.launches[0].processObservation.ppid = 99)],
  ["wrong service", (r) => (r.launches[0].processObservation.serviceName = "other")],
  ["unobserved fork", (r) => delete r.launches[0].processObservation.forkPid],
  ["wrong observation method", (r) => (r.launches[0].processObservation.method = "invented")],
  ["invented pid", (r) => (r.launches[0].pid = 3)],
  ["nonzero exit", (r) => (r.exits[0].exit.code = 1)],
])
  test("installed PID rejects " + name, () => {
    const r = installedPidFixture();
    mutate(r);
    assert.throws(() => verifyDeviceReceipt(r, { installed: true }));
  });

test("installed PID observation never delays transport and restores exact fork", async () => {
  const { observeUtilityLaunch } = await import("./sensor-lab-installed-artifacts.mjs");
  const nativeChild = { pid: 42 };
  const calls = [];
  const original = function (...args) {
    calls.push(args);
    assert.equal(this, utility);
    return nativeChild;
  };
  const utility = { fork: original };
  const plugin = { entry: "/leaf/main.cjs", id: "kobrixa.device-ev3" };
  let resolveProbe,
    listener = false;
  const transport = {
    onMessage() {
      listener = true;
    },
  };
  const observed = observeUtilityLaunch({
    utility,
    plugin,
    launch: () => {
      const actual = utility.fork(plugin.entry, [], { serviceName: "Kobrixa plugin " + plugin.id });
      assert.equal(actual, nativeChild);
      return Promise.resolve(transport);
    },
    observe: async (identity) => {
      assert.equal(identity.pid, 42);
      await new Promise((r) => (resolveProbe = r));
      assert.equal(listener, true);
      return identity;
    },
    timeoutMs: 1000,
  });
  assert.equal(utility.fork, original);
  (await observed.started).onMessage();
  await Promise.resolve();
  resolveProbe();
  assert.equal((await observed.observation).pid, 42);
  assert.equal(calls.length, 1);
});
test("installed PID observation timeout is explicit without blocking transport", async () => {
  const { observeUtilityLaunch } = await import("./sensor-lab-installed-artifacts.mjs");
  const utility = { fork: () => ({ pid: 42 }) };
  const plugin = { entry: "/leaf/main.cjs", id: "kobrixa.device-ev3" };
  const observed = observeUtilityLaunch({
    utility,
    plugin,
    launch: () => {
      utility.fork(plugin.entry, [], { serviceName: "Kobrixa plugin " + plugin.id });
      return Promise.resolve("transport");
    },
    observe: () => new Promise(() => {}),
    timeoutMs: 10,
  });
  const failure = assert.rejects(observed.observation, /Installed process observation timed out/);
  assert.equal(await observed.started, "transport");
  await failure;
});
test("installed PID observation rejects missing or foreign service without inventing identity", async () => {
  const { observeUtilityLaunch } = await import("./sensor-lab-installed-artifacts.mjs");
  for (const serviceName of [undefined, "wrong"]) {
    const utility = { fork: () => ({ pid: 42 }) },
      original = utility.fork,
      plugin = { entry: "/leaf/main.cjs", id: "kobrixa.device-ev3" };
    const observed = observeUtilityLaunch({
      utility,
      plugin,
      launch: () => {
        if (serviceName) utility.fork(plugin.entry, [], { serviceName });
        return Promise.resolve("transport");
      },
      observe: () => assert.fail(),
    });
    await assert.rejects(observed.observation);
    assert.equal(await observed.started, "transport");
    assert.equal(utility.fork, original);
  }
});

// Independent fabricated restart oracle specimen, never native evidence.
function restartFixture() {
  const entries = [
    { key: "kobrixa.connectionMode", raw: "usb" },
    { key: "kobrixa.rememberWifiAddress", raw: "true" },
    { key: "kobrixa.lastWifiAddress", raw: " 192.0.2.9 " },
  ];
  const snap = (revision, value) => ({
    revision,
    schemaVersion: 1,
    values: Object.entries({
      connectionMode: "usb",
      lastWifiAddress: " 192.0.2.9 ",
      rememberWifiAddress: true,
      skipUnchangedAssets: value,
      usbAutoReconnect: false,
      usbRetryInterval: 2000,
      usbRetryLimit: 3,
      wifiConnectTimeout: 10000,
      wifiHandshakeTimeout: 5000,
    }).map(([key, value]) => ({ key, value })),
  });
  const row = (method, expected, value, revision, at) => ({
    channel: "plugins:settings:" + method,
    at,
    finishedAt: at + 1,
    args: [
      {},
      method === "reset"
        ? { expectedRevision: expected, keys: ["skipUnchangedAssets"] }
        : { expectedRevision: expected, changes: [{ key: "skipUnchangedAssets", value }] },
    ],
    result: {
      ok: true,
      value: {
        snapshot: snap(revision, value),
        receipt: {
          revision,
          commitId: "commit-" + revision,
          durability: "file-and-directory-sync",
        },
      },
    },
  });
  const phase = (n) => ({
    schema: 1,
    restartPhase: String(n),
    stage: "complete",
    mainPid: n,
    failures: [],
    launches: [],
    exits: [],
    wire: [],
    legacyAudit: [{ kind: n === 1 ? "seed" : "retained", entries }],
    cleanup: { workers: 0, bridge: { pending: 0 }, worker: { pending: 0 } },
    ipc:
      n === 1
        ? [
            row("update", "import", false, "a", 1),
            row("reset", "a", true, "b", 3),
            row("update", "b", false, "c", 5),
          ]
        : [
            {
              channel: "persistence:legacy-preferences-challenge",
              error: "Unavailable preference descriptor",
            },
          ],
    restart: {
      providerTrace: [],
      profile: "/profile",
      scope: { hostEpoch: "host" + n, workbenchInstance: "scope" + n },
      settings: {
        state: "ready",
        snapshot: snap("c", false),
        values: { skipUnchangedAssets: false },
      },
      renderer: { entries, migration: n === 1 ? "captured" : "pending", alerts: [] },
      formSnapshot: snap("c", false),
      challenge: n === 2 ? { rejected: true } : null,
    },
  });
  const first = phase(1),
    second = phase(2);
  first.restart.initialSettings = {
    state: "ready",
    snapshot: snap("import", true),
    values: { skipUnchangedAssets: true },
  };
  first.native = [
    { type: "pointerdown", isTrusted: true, at: 0 },
    { type: "pointerdown", isTrusted: true, at: 2.5 },
    { type: "pointerdown", isTrusted: true, at: 4.5 },
  ];
  for (const p of [first, second])
    p.ipc.unshift({
      channel: "plugins:settings:open",
      result: {
        binding: { scope: p.restart.scope },
        snapshot: p === first ? snap("import", true) : snap("c", false),
      },
    });
  const persisted = {
    originalSha256: "a".repeat(64),
    settings: {
      head: { receipt: { revision: "c", commitId: "commit-c" } },
      document: { values: snap("c", false).values },
    },
    imports: [
      {
        key: "import/id",
        document: {
          complete: true,
          plan: {
            id: "import/id",
            descriptorId: "kobrixa.device-preferences",
            preferencesEvidence: { nonce: "nonce" },
            devicePreferencesEvidence: { device: { sha256: "a".repeat(64) } },
          },
          items: [
            { state: "committed", receipt: { commitId: "import-commit", revision: "import" } },
          ],
        },
      },
      { key: "barrier/id", document: { kind: "barrier", state: "complete", barrier: "barrier" } },
      {
        key: "nonce/nonce",
        document: { kind: "nonce", state: "consumed", nonce: "nonce", raw: { entries } },
      },
    ],
    hashes: { "settings/head.json": "hash" },
  };
  return {
    first,
    second,
    outside: [
      { pid: 1, code: 0, signal: null, timedOut: false, survivors: [] },
      { pid: 2, code: 0, signal: null, timedOut: false, survivors: [] },
    ],
    originalSha256: "a".repeat(64),
    beforeSecond: structuredClone(persisted),
    afterSecond: structuredClone(persisted),
  };
}
test("same-profile restart oracle accepts distinct durable final CAS and unchanged completed import", () =>
  assert.equal(verifyRestartReceipt(restartFixture()).revision, "c"));
for (const [name, mutate] of [
  ["same process", (r) => (r.second.mainPid = 1)],
  ["different profile", (r) => (r.second.restart.profile = "/other")],
  ["stale scope", (r) => (r.second.restart.scope = r.first.restart.scope)],
  ["reset value restored", (r) => (r.second.restart.settings.values.skipUnchangedAssets = true)],
  ["lost durable revision", (r) => (r.second.restart.formSnapshot.revision = "b")],
  ["new import publication", (r) => (r.afterSecond.imports[0].document.plan.id = "new")],
  ["changed original", (r) => (r.afterSecond.originalSha256 = "b".repeat(64))],
  ["reseed", (r) => (r.second.legacyAudit[0].kind = "seed")],
  ["old writer", (r) => r.second.legacyAudit.push({ kind: "write" })],
  ["auto activation", (r) => r.second.launches.push({})],
  ["auto I/O", (r) => r.second.wire.push({})],
  ["provider replay", (r) => r.second.restart.providerTrace.push({ step: "connect" })],
  ["new settings publish", (r) => r.second.ipc.push(r.first.ipc[1])],
  ["challenge accepted", (r) => (r.second.restart.challenge.rejected = false)],
  ["error UI", (r) => r.second.restart.renderer.alerts.push("error")],
  ["incomplete import", (r) => (r.beforeSecond.imports[0].document.complete = false)],
  ["unclean process", (r) => (r.outside[1].code = 1)],
])
  test("restart rejects " + name, () => {
    const r = restartFixture();
    mutate(r);
    assert.throws(() => verifyRestartReceipt(r));
  });

test("restart file observer verifies actual head/object bytes and detects corruption", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "e7-profile-unit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, "device-settings.json"), JSON.stringify(legacyDevice));
  const ns = path.join(directory, "plugins/persistence-v1/namespaces/unit");
  await mkdir(path.join(ns, "imports/objects"), { recursive: true });
  await mkdir(path.join(ns, "settings/objects"), { recursive: true });
  await writeFile(
    path.join(ns, "identity.json"),
    JSON.stringify({ sourceKey: "builtin:kobrixa.device-ev3" }),
  );
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  async function store(folder, name, key, document) {
    const bytes = Buffer.from(JSON.stringify(document)),
      object = `r_${name}.json`;
    await writeFile(path.join(ns, folder, "objects", object), bytes);
    await writeFile(
      path.join(ns, folder, folder === "settings" ? "head.json" : name + ".json"),
      JSON.stringify({
        object,
        byteLength: bytes.length,
        sha256: hash(bytes),
        target: { key },
        receipt: { revision: "c", commitId: "commit-c" },
      }),
    );
  }
  const data = restartFixture().beforeSecond;
  for (const [i, item] of data.imports.entries())
    await store("imports", String(i), item.key, item.document);
  await store("settings", "settings", "settings", data.settings.document);
  const before = await snapshotRestartProfile(directory);
  assert.equal(before.imports.length, 3);
  assert.equal(before.originalSha256, hash(Buffer.from(JSON.stringify(legacyDevice))));
  assert.deepEqual(await snapshotRestartProfile(directory), before);
  await writeFile(path.join(ns, "imports/objects/r_0.json"), "{}");
  await assert.rejects(snapshotRestartProfile(directory));
});

test("actual generated seed script leaves phase2 localStorage untouched", async () => {
  const source = await readFile(new URL("./device-ui-public-run.mjs", import.meta.url), "utf8");
  const script = /source: `([\s\S]*?)`,/.exec(source)?.[1];
  assert.ok(script);
  for (const phase of ["1", "2"]) {
    const entries = new Map([
      ["kobrixa.connectionMode", "wifi"],
      ["kobrixa.rememberWifiAddress", "false"],
      ["kobrixa.lastWifiAddress", "original raw"],
    ]);
    const before = [...entries],
      writes = [],
      logs = [];
    class Storage {
      getItem(key) {
        return entries.get(key) ?? null;
      }
      setItem(key, value) {
        writes.push([key, value]);
        entries.set(key, value);
      }
      removeItem(key) {
        entries.delete(key);
      }
      clear() {
        entries.clear();
      }
    }
    const storage = new Storage();
    Function(
      "Storage",
      "localStorage",
      "location",
      "console",
      "performance",
      script,
    )(
      Storage,
      storage,
      { search: "?restart=" + phase },
      { log: (line) => logs.push(JSON.parse(line.slice(13))) },
      { timeOrigin: 0, now: () => 1 },
    );
    if (phase === "2") {
      assert.deepEqual([...entries], before);
      assert.deepEqual(writes, []);
      assert.equal(logs[0].kind, "retained");
    } else {
      assert.equal(writes.length, 3);
      assert.equal(logs[0].kind, "seed");
    }
    storage.removeItem("kobrixa.connectionMode");
    assert.equal(logs.at(-1).operation, "remove");
  }
});
