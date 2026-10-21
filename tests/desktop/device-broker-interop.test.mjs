import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import * as harness from "./device-broker-harness.mjs";
import { assertMatrix, assertParity, matrix, runOwnedMatrix } from "./device-broker-harness.mjs";

test("F01–F21: every owned negative case executes and none is skipped", async () => {
  const report = await runOwnedMatrix();
  assertMatrix(report);
});

test("matrix evidence cannot be replaced by an empty, skipped or failed suite", () => {
  assert.throws(() => assertMatrix({ cases: [] }));
  for (const status of ["pending", "skipped", "failed", "todo"]) {
    const cases = Object.keys(matrix).map((id) => ({ id, status: "passed", assertions: 1 }));
    cases[0].status = status;
    assert.throws(() => assertMatrix({ cases }));
  }
});

test("matrix invokes the installed Vitest CLI with Node and preserves spaced arguments", async () => {
  const output = path.join(harness.root, "directory with spaces", "report.json");
  const invocation = harness.matrixInvocation(output);
  assert.equal(invocation.command, process.execPath);
  assert.ok(path.isAbsolute(invocation.args[0]));
  assert.equal(invocation.args.at(-1), `--outputFile=${output}`);
  assert.ok(!invocation.command.endsWith(".cmd"));
  await harness.run(invocation.command, [invocation.args[0], "--version"], { stdio: "pipe" });
});

test("F09/F21 matrix requires provider quarantine evidence and rejects skipped fault cases", () => {
  const broker = "apps/desktop/src/main/device-broker/";
  assert.ok(matrix.F09.includes(broker + "broker.test.ts"));
  assert.ok(matrix.F09.includes(broker + "provider.test.ts"));
  assert.ok(matrix.F09.includes("packages/device/src/io-boundary.test.ts"));
  assert.ok(matrix.F21.includes(broker + "provider.test.ts"));
  const suites = new Map();
  for (const [id, files] of Object.entries(matrix))
    for (const file of files) {
      const suite = suites.get(file) ?? {
        name: path.join(harness.root, file),
        assertionResults: [],
      };
      suite.assertionResults.push({ fullName: `${id} assigned evidence`, status: "passed" });
      suites.set(file, suite);
    }
  const fault = {
    fullName: "F09 finish bounds stalled provider cleanup and subsequent cancel",
    status: "passed",
  };
  suites.get(broker + "broker.test.ts").assertionResults.push(fault);
  const result = { success: true, testResults: [...suites.values()] };
  assertMatrix(harness.matrixFromResults(result));
  for (const status of ["pending", "skipped", "failed", "todo"]) {
    fault.status = status;
    assert.throws(() => harness.matrixFromResults(result), /F09.*stalled provider/);
  }
});

test("F16: parity requires actual MessagePort and Content-Length consumers", () => {
  const scenario = [
    "negotiate",
    "list",
    "session",
    "read",
    "subscribe",
    "mode-query",
    "mode-set",
    "reserve",
    "recording-read",
    "release",
    "prepare",
    "start",
    "stop",
    "query",
    "unsubscribe",
  ];
  const result = {
    transports: [
      { language: "js", transport: "electron-message-port", scenario, ok: true },
      { language: "python", transport: "content-length", scenario, ok: true },
    ].map((row) => ({
      ...row,
      eventReceipt: {
        kind: "devices.telemetry",
        subscriptionId: "subscription",
        sessionId: "session",
        sequence: 1,
      },
      acknowledged: { subscriptionId: "subscription", sequence: 1 },
    })),
  };
  assertParity(result);
  assert.throws(() => assertParity({ transports: result.transports.slice(0, 1) }));
  assert.throws(() =>
    assertParity({ transports: result.transports.map((x) => ({ ...x, transport: "memory" })) }),
  );
  assert.throws(() =>
    assertParity({
      transports: result.transports.map((x) => ({ ...x, scenario: scenario.slice(0, -1) })),
    }),
  );
  assert.throws(() =>
    assertParity({
      transports: result.transports.map((row) => ({ ...row, eventReceipt: undefined })),
    }),
  );
  assert.throws(() =>
    assertParity({
      transports: result.transports.map((row) => ({
        ...row,
        acknowledged: { ...row.acknowledged, sequence: 2 },
      })),
    }),
  );
  assert.throws(() =>
    assertParity({
      transports: result.transports.map((row) => ({
        ...row,
        acknowledged: { ...row.acknowledged, subscriptionId: "foreign" },
      })),
    }),
  );
});

// Run the actual consumer, public SDK, router, broker and canonical provider over
// a Node MessagePort. Electron and Python use the same cases in the controller smoke.
let composition;
async function nodeComposition() {
  if (!composition) {
    const { build, transform } = await import("esbuild");
    const { createRequire } = await import("node:module");
    const { readFile } = await import("node:fs/promises");
    const require = createRequire(import.meta.url);
    const bundled = await build({
      stdin: {
        contents: `
          export { RpcPeer, deviceRequestSchemas } from '@kobrixa/plugin-protocol';
          export { runPlugin, definePlugin } from '@kobrixa/plugin-sdk';
          export { createDeviceBroker } from './apps/desktop/src/main/device-broker/broker-port.ts';
          export { attachDeviceRpc } from './apps/desktop/src/main/device-broker/rpc-router.ts';
          export { operationHarness, pluginPrincipal, createFakeDeviceProvider, ID } from './apps/desktop/src/main/device-broker/fake-provider.ts';`,
        resolveDir: harness.root,
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      alias: Object.fromEntries(
        [
          ["plugin-protocol", "plugin-protocol"],
          ["plugin-runtime", "plugin-runtime"],
          ["plugin-sdk", "plugin-sdk-js"],
        ].map(([name, folder]) => [
          `@kobrixa/${name}`,
          path.join(harness.root, `packages/${folder}/src/index.ts`),
        ]),
      ),
    });
    const module = { exports: {} };
    new Function("require", "module", "exports", bundled.outputFiles[0].text)(
      require,
      module,
      module.exports,
    );
    const consumer = await transform(
      await readFile(new URL("./fixtures/device-broker/consumer.ts", import.meta.url), "utf8"),
      { loader: "ts", format: "cjs" },
    );
    composition = { ...module.exports, consumer: consumer.code, require };
  }
  return composition;
}

for (const withheld of [false, true])
  test(
    `F16 real MessagePort consumer ${withheld ? "rejects withheld delivery" : "requires receipt and correlated ACK"}`,
    { timeout: 20_000 },
    async () => {
      const c = await nodeComposition();
      const { MessageChannel } = await import("node:worker_threads");
      const h = c.operationHarness(),
        principal = c.pluginPrincipal(),
        owner = principal.owner;
      const now = () => performance.now();
      const broker = c.createDeviceBroker({
        journal: h.dependencies.journal,
        profile: h.dependencies.profile,
        now,
        authority: {
          current: () => ({
            ref: c.ID,
            epoch: c.ID,
            workbenchInstance: c.ID,
            state: "local",
            roomBinding: null,
            connected: true,
            synced: true,
            role: null,
            isHolder: true,
          }),
          assertContinuation() {},
          subscribe: () => () => {},
        },
        coreActions: { claim: () => true, isClaimed: () => true, complete() {} },
        hasPermission: () => true,
        requirements: () => [],
        operationGate: () => ({ ok: true, value: null }),
        connectionPolicy: () => ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: false,
          usbRetryInterval: "backoff",
          usbRetryLimit: 3,
        }),
      });
      const fake = c.createFakeDeviceProvider({
        catalog: broker.providerCatalog("kobrixa.device-ev3"),
        now,
      });
      const unregister = broker.registerProvider(fake.provider);
      const connected = await broker.request(
        principal,
        "devices/connect",
        { target: { kind: "wifi-address", providerId: fake.provider.id, address: "127.0.0.1" } },
        new AbortController().signal,
      );
      assert.equal(connected.ok, true);
      const sessionId = connected.value.session.sessionId;
      const scope = broker.intent.bindMotionScope({
        owner,
        contextRef: c.ID,
        panelInstance: c.ID,
        uiResourceGeneration: 0,
        workbenchInstance: c.ID,
      });
      let pulse = 1;
      broker.intent.pulsePanel(scope, pulse++);
      const heartbeat = setInterval(() => broker.intent.pulsePanel(scope, pulse++), 100);
      const { port1, port2 } = new MessageChannel();
      const incoming = new Map(),
        published = [],
        acknowledged = [];
      let dropped = 0,
        notice;
      const host = new c.RpcPeer({
        onMessage(listener) {
          const receive = (text) => {
            const m = JSON.parse(text);
            if (m.method && m.id !== undefined) incoming.set(m.id, m);
            listener(text);
          };
          port1.on("message", receive);
          return () => port1.off("message", receive);
        },
        send(text) {
          const m = JSON.parse(text);
          if (incoming.get(m.id)?.method === "devices/subscribe" && m.result?.ok) {
            const snapshot = m.result.value.snapshot;
            assert.ok(snapshot.frame);
            const published = broker.events.publish(
              owner,
              m.result.value.subscriptionId,
              {
                kind: "devices.telemetry",
                data: { sessionId, frames: [snapshot.frame], snapshot },
              },
              "telemetry",
            );
            assert.equal(published.ok, true);
          }
          if (withheld && m.method === "events/deliver") {
            dropped++;
            return;
          }
          port1.postMessage(text);
          published.push(m);
          if (incoming.get(m.id)?.method === "events/ack" && m.result?.ok)
            acknowledged.push({
              ...incoming.get(m.id).params,
              acknowledged: m.result.value.acknowledged,
            });
        },
      });
      const detach = c.attachDeviceRpc({ peer: host, principal: () => principal, broker });
      host.handle("ui/showMessage", ({ message }) => {
        notice = JSON.parse(message);
        return null;
      });
      let pluginReady, plugin;
      try {
        const previousOwner = process.env.KOBRIXA_RESOURCE_OWNER;
        try {
          process.env.KOBRIXA_RESOURCE_OWNER = JSON.stringify(owner);
          new Function("require", c.consumer)((id) => {
            if (id === "node:fs")
              return {
                readFileSync: () =>
                  JSON.stringify({
                    contextRef: c.ID,
                    motionScopeRef: scope,
                    eventTimeoutMs: withheld ? 100 : 2000,
                  }),
              };
            if (id === "@kobrixa/plugin-sdk")
              return {
                definePlugin: c.definePlugin,
                runPlugin(definition) {
                  pluginReady = c.runPlugin(definition, {
                    channel: {
                      onMessage(listener) {
                        port2.on("message", listener);
                        return () => port2.off("message", listener);
                      },
                      send: (text) => port2.postMessage(text),
                    },
                    exit: (code) => assert.fail(`SDK exit ${code}`),
                  });
                  return pluginReady;
                },
              };
            return c.require(id);
          });
        } finally {
          if (previousOwner === undefined) delete process.env.KOBRIXA_RESOURCE_OWNER;
          else process.env.KOBRIXA_RESOURCE_OWNER = previousOwner;
        }
        plugin = await pluginReady;
        await host.request("initialize", {
          apiVersion: "1.5.0",
          pluginId: owner.pluginId,
          locale: "en",
          grantedPermissions: [
            "ui.notifications",
            "devices.read",
            "devices.connect",
            "devices.control",
          ],
        });
        const command = host.request(
          "command/execute",
          { command: "kobrixa-fixture.devices.probe" },
          { timeoutMs: 10_000 },
        );
        if (withheld) {
          await assert.rejects(command, /SDK telemetry event deadline/);
          assert.equal(notice, undefined);
          assert.ok(dropped > 0);
          assert.deepEqual(acknowledged, []);
        } else {
          assert.equal(await command, null);
          assert.ok(notice?.eventReceipt, "consumer must attest actual callback receipt");
          const receipt = notice.eventReceipt;
          assert.equal(receipt.sessionId, sessionId);
          assert.deepEqual(receipt.owner, owner);
          assert.equal(receipt.kind, "devices.telemetry");
          const matching = acknowledged.filter(
            (ack) =>
              ack.subscriptionId === receipt.subscriptionId && ack.sequence === receipt.sequence,
          );
          assert.equal(matching.length, 1);
          assert.equal(matching[0].acknowledged, receipt.sequence);
          const reply = published.findIndex(
            (m) => incoming.get(m.id)?.method === "devices/subscribe" && m.result?.ok,
          );
          const event = published.findIndex(
            (m) =>
              m.method === "events/deliver" &&
              m.params.subscriptionId === receipt.subscriptionId &&
              m.params.sequence === receipt.sequence,
          );
          assert.ok(reply >= 0 && event > reply);
        }
        assert.equal(broker.events.diagnostics().subscriptions, 0);
      } finally {
        clearInterval(heartbeat);
        broker.intent.revokeScope(scope, "closed");
        try {
          await broker.resources.retire(owner, "disabled").settled;
        } finally {
          detach();
          host.close();
          plugin?.close();
          port1.close();
          port2.close();
          unregister();
        }
      }
    },
  );
