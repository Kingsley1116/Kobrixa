import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cpus, totalmem, platform, arch } from "node:os";
import { app } from "electron";
import {
  RpcPeer,
  createMemoryChannelPair,
  PLUGIN_API_VERSION,
  jsonRpcMessageSchema,
  deviceRequestSchemas,
  deviceEventDataSchemas,
  eventEnvelopeSchema,
  type JsonRpcMessage,
} from "@kobrixa/plugin-protocol";
import type { ResourceOwner } from "@kobrixa/plugin-protocol";
import { loadPlugins, type Principal, type FaultJournalDocument } from "@kobrixa/plugin-runtime";
import type { JournalPort } from "../../apps/desktop/src/main/device-broker/journal-port.js";
import type { BuiltinDeviceProvider } from "../../apps/desktop/src/main/device-broker/provider.js";
import {
  createDeviceBroker,
  type DeviceBrokerPort,
  type DeviceRequirement,
} from "../../apps/desktop/src/main/device-broker/broker-port.js";
import type { DeviceConnectionPolicy } from "../../apps/desktop/src/main/device-broker/provider.js";
import {
  createFakeDeviceProvider,
  type FakeProviderControl,
} from "../../apps/desktop/src/main/device-broker/fake-provider.js";
import { createCoreActionLedger } from "../../apps/desktop/src/main/plugins/core-recovery.js";
import { attachDeviceRpc } from "../../apps/desktop/src/main/device-broker/rpc-router.js";
import { createProviderCatalog } from "../../apps/desktop/src/main/device-broker/registry.js";
import { createDesktopLauncher } from "../../apps/desktop/src/main/plugins/launchers.js";

const [directory, python] = process.argv.slice(-2) as [string, string];
type ArtifactIdentity = {
  commit: string;
  artifact: { dirty: boolean; sha256: Record<string, string> };
};
type EventReceipt = {
  kind: "devices.telemetry";
  subscriptionId: string;
  sessionId: string;
  sequence: number;
  owner: ResourceOwner;
};
const hostEpoch = randomUUID();
const workbenchInstance = randomUUID();
const ref = randomUUID(),
  epoch = randomUUID();
const hostPrincipal: Principal = {
  kind: "core",
  adapter: "recovery",
  hostEpoch,
  workbenchInstance,
  authorityContext: { ref, epoch },
};
const authorities = new Set<(ref: string, epoch: string) => void>();
const stopAdmissionTimes = new Map<string, number>();
const journalMeasurements: number[] = [];
const historicalOwner: ResourceOwner = {
  sourceKey: "dev:0123456789abcdef",
  pluginId: "kobrixa-fixture.devices",
  generation: 0,
  hostEpoch,
  processEpoch: randomUUID(),
};
let document: FaultJournalDocument = {
  schemaVersion: 1,
  revision: 0,
  entries: Array.from({ length: 64 }, () => {
    const sessionId = randomUUID();
    return {
      id: randomUUID(),
      revision: 0,
      owner: { kind: "plugin", owner: historicalOwner },
      providerId: "kobrixa.device-ev3",
      providerGeneration: 0,
      physical: {
        providerId: "kobrixa.device-ev3",
        family: "fixture",
        basis: "serial",
        digest: "a".repeat(64),
        strength: "stable",
      },
      sessionId,
      operationId: randomUUID(),
      operationClass: "finite-motion",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: "resolved",
      dispatch: "not-sent",
      movement: "not-started",
      stopRequested: false,
      stopConfirmation: "not-required",
      cause: "none",
      resolution: {
        kind: "not-issued",
        at: Date.now(),
        sessionId,
        identityEvidence: "same-session",
      },
    };
  }),
  integrity: {
    algorithm: "sha256",
    digest: createHash("sha256").update("fixture-empty").digest("hex"),
  },
};
const journal: JournalPort = {
  async load() {
    return structuredClone(document);
  },
  async commit(next) {
    const started = performance.now();
    document = structuredClone(next);
    if (journalMeasurements.length === 256) journalMeasurements.shift();
    journalMeasurements.push(performance.now() - started);
  },
  snapshot() {
    return {
      revision: document.revision,
      journalHealth: "ready",
      faults: document.entries,
      blockers: document.entries
        .filter((entry) => entry.state !== "resolved")
        .map((entry) => entry.id),
    };
  },
  subscribe() {
    return () => {};
  },
};
const signal = new AbortController().signal;
function successful<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

// The formal fake and its controls are defined only by A-T2.
const controls = new Map<string, FakeProviderControl>();
function fakeProvider(
  broker: DeviceBrokerPort,
  id = "kobrixa.device-ev3",
  maximum = false,
): BuiltinDeviceProvider {
  const { provider, control } = createFakeDeviceProvider({
    // Only EV3 connects. Extra canonical fixtures exercise discovery capacity;
    // their local catalogs do not widen the production EV3 factory allowlist.
    catalog: id === "kobrixa.device-ev3" ? broker.providerCatalog(id) : createProviderCatalog(),
    now: () => performance.now(),
    providerId: id,
    ...(maximum ? { profile: "maximum" as const } : {}),
  });
  assert.equal(provider.id, id);
  controls.set(id, control);
  return provider;
}
const admitted = new Map<ResourceOwner, readonly DeviceRequirement[]>();
function requirements(owner: ResourceOwner): readonly DeviceRequirement[] | null {
  for (const [current, list] of admitted) {
    if (
      current.sourceKey === owner.sourceKey &&
      current.pluginId === owner.pluginId &&
      current.generation === owner.generation &&
      current.hostEpoch === owner.hostEpoch &&
      current.processEpoch === owner.processEpoch
    )
      return list;
  }
  return null;
}
const configuredPolicy: DeviceConnectionPolicy = Object.freeze({
  wifiConnectTimeoutMs: 10000,
  wifiHandshakeTimeoutMs: 5000,
  usbAutoReconnect: true,
  usbRetryInterval: 2000,
  usbRetryLimit: 3,
});

const fail = (error: unknown) => {
  console.error(error);
  app.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const negotiationCases = [
  { name: "absent", requires: [], satisfied: true },
  { name: "event-delivery-withheld", requires: [], satisfied: true },
  {
    name: "required-supported",
    requires: [{ capability: "telemetry.v1", required: true }],
    satisfied: true,
  },
  {
    name: "optional-supported",
    requires: [{ capability: "telemetry.v1", required: false }],
    satisfied: true,
  },
  {
    name: "required-unknown-version",
    requires: [{ capability: "telemetry.v99", required: true }],
    satisfied: false,
  },
  {
    name: "optional-unknown-version",
    requires: [{ capability: "telemetry.v99", required: false }],
    satisfied: true,
  },
  {
    name: "required-disabled",
    requires: [{ capability: "telemetry.v1", required: true }],
    satisfied: false,
  },
  { name: "hostile-requirements", requires: [], satisfied: true },
  ...[
    "subscribe-send-throws",
    "subscribe-invalid-result",
    "subscribe-cancel",
    "metadata-absent",
    "metadata-wrong",
    "metadata-retired",
  ].map((name) => ({ name, requires: [], satisfied: true })),
] satisfies readonly { name: string; requires: readonly DeviceRequirement[]; satisfied: boolean }[];
function assertNegotiation(
  row: (typeof negotiationCases)[number],
  value: {
    requirementsSatisfied: boolean;
    capabilities: { capability: string; state: string }[];
  },
) {
  assert.equal(value.requirementsSatisfied, row.satisfied);
  for (const requirement of row.requires) {
    const capability = value.capabilities.find(
      (entry) => entry.capability === requirement.capability,
    );
    assert.ok(capability, "Manifest capability omitted from union");
    if (requirement.capability.endsWith(".v99")) assert.equal(capability.state, "unsupported");
    if (row.name === "required-disabled") assert.equal(capability.state, "provider-unavailable");
  }
}

async function runMaximumLoad(
  broker: DeviceBrokerPort,
  identity: ArtifactIdentity,
): Promise<object> {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!gc) throw new Error("Load run requires Electron --js-flags=--expose-gc");
  const now = () => performance.now();
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const owner: ResourceOwner = {
    sourceKey: "dev:0123456789abcdef",
    pluginId: "kobrixa-fixture.devices",
    generation: 3,
    hostEpoch,
    processEpoch: randomUUID(),
  };
  const principal: Principal = { kind: "plugin", owner, authorityContext: { ref, epoch } };
  admitted.set(owner, Object.freeze([]));
  const removeProviders = Array.from({ length: 7 }, (_, i) =>
    broker.registerProvider(fakeProvider(broker, `kobrixa.fixture${i + 2}`, true)),
  );
  const [hostChannel, clientChannel] = createMemoryChannelPair();
  const hostPeer = new RpcPeer(hostChannel),
    clientPeer = new RpcPeer(clientChannel);
  const detach = attachDeviceRpc({ peer: hostPeer, principal: () => principal, broker });
  let deliveredBytes = 0;
  let peakQueuedBytes = 0;
  let overflowFrames = 0;
  const pendingAcks = new Map<string, number>();
  clientPeer.onNotification("events/deliver", (event) => {
    deliveredBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
    peakQueuedBytes = Math.max(peakQueuedBytes, broker.events.diagnostics().queuedBytes);
    if (event.kind === "devices.telemetry")
      overflowFrames += event.data.frames.filter(
        (frame) => frame.gap?.reason === "overflow",
      ).length;
    pendingAcks.set(event.subscriptionId, event.sequence);
  });
  // A slow but responsive consumer creates queue pressure without triggering
  // the separate ACK-timeout safety path that correctly revokes motion scopes.
  const acknowledgement = setInterval(() => {
    for (const [subscriptionId, sequence] of pendingAcks) {
      pendingAcks.delete(subscriptionId);
      void clientPeer.request("events/ack", { subscriptionId, sequence }).catch(fail);
    }
  }, 1000);
  const stopDispatchMs: number[] = [];
  const transport: number[] = [],
    readback: number[] = [],
    journalTimes = journalMeasurements;
  journalTimes.length = 0;
  const retainedHeap: { elapsedMs: number; bytes: number }[] = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let subscriptions: string[] = [];
  const measured = async <T>(work: () => Promise<T>, samples: number[]) => {
    const started = now();
    try {
      return await work();
    } finally {
      if (samples.length === 256) samples.shift();
      samples.push(now() - started);
    }
  };
  try {
    successful(await clientPeer.request("devices/negotiate", {}));
    const list = successful(await clientPeer.request("devices/list", {}));
    assert.equal(list.providers.length, 8);
    const first = successful(
      await clientPeer.request("devices/discover", { providerId: "kobrixa.device-ev3" }),
    );
    const second = successful(
      await clientPeer.request("devices/discover", { providerId: "kobrixa.fixture2" }),
    );
    assert.equal(first.candidates.length, 32);
    assert.equal(second.candidates.length, 32);
    const overflow = await clientPeer.request("devices/discover", {
      providerId: "kobrixa.fixture3",
    });
    assert.equal(overflow.ok, false);
    if (!overflow.ok) assert.equal(overflow.error.code, "PLUGIN_E_RESOURCE_LIMIT");
    const session = successful(
      await clientPeer.request("devices/connect", {
        target: { kind: "candidate", candidateId: first.candidates[0]!.candidateId },
      }),
    ).session;
    const sources = successful(
      await clientPeer.request("devices/session", { sessionId: session.sessionId }),
    ).sources;
    assert.equal(sources.channels.length, 38);
    assert.equal(sources.actuators.length, 4);
    // Startup loaded 64 resolved historical entries through the injected journal port.
    // Unresolved/full and replacement-space faults use F10's real filesystem adapter.
    assert.equal(document.entries.length, 64);
    const scope = broker.intent.bindMotionScope({
      owner,
      contextRef: ref,
      panelInstance: randomUUID(),
      uiResourceGeneration: 0,
      workbenchInstance,
    });
    let pulse = 1;
    broker.intent.pulsePanel(scope, pulse++);
    heartbeat = setInterval(() => broker.intent.pulsePanel(scope, pulse++), 100);
    const refill = async () => {
      for (const subscriptionId of subscriptions) {
        const removed = await clientPeer.request("events/unsubscribe", { subscriptionId });
        if (!removed.ok) assert.equal(removed.error.code, "PLUGIN_E_STALE_RESOURCE");
      }
      subscriptions = [];
      for (let index = 0; index < 32; index++) {
        const result = successful(
          await clientPeer.request("devices/subscribe", {
            topic: "telemetry",
            sessionId: session.sessionId,
            channelIds: sources.channels.map((channel) => channel.channelId),
            intervalMs: 500,
          }),
        );
        subscriptions.push(result.subscriptionId);
      }
      const excess = await clientPeer.request("devices/subscribe", { topic: "catalog" });
      assert.equal(excess.ok, false);
      if (!excess.ok) assert.equal(excess.error.code, "PLUGIN_E_RESOURCE_LIMIT");
    };
    await refill();
    // Five-second warmup is reported separately, not deducted from the ten-minute sample.
    await pause(5_000);
    const started = now();
    let sampleAt = started,
      refreshAt = started + 30_000;
    while (now() - started < 600_000) {
      if (now() >= sampleAt) {
        gc();
        retainedHeap.push({ elapsedMs: now() - started, bytes: process.memoryUsage().heapUsed });
        sampleAt += 60_000;
      }
      if (now() >= refreshAt) {
        await refill();
        refreshAt += 30_000;
      }
      successful(
        await measured(
          () =>
            clientPeer.request("devices/read", {
              sessionId: session.sessionId,
              channelIds: sources.channels.map((channel) => channel.channelId),
              freshness: "fresh",
            }),
          transport,
        ),
      );
      const prepared = successful(
        await clientPeer.request("devices/motion/prepare", {
          sessionId: session.sessionId,
          contextRef: ref,
          motionScopeRef: scope,
          motion: {
            actuatorId: sources.actuators[0]!.actuatorId,
            mode: "timed",
            power: 1,
            direction: 1,
            brake: true,
            durationMs: 100,
          },
        }),
      );
      const operationId = prepared.operation.operationId;
      successful(await clientPeer.request("devices/motion/start", { operationId }));
      await pause(20);
      controls.get("kobrixa.device-ev3")!.resetTrace();
      stopAdmissionTimes.set(operationId, now());
      successful(
        await clientPeer.request("devices/motion/stop", { operationId, stopMode: "brake" }),
      );
      await measured(async () => {
        const deadline = now() + 20_000;
        for (;;) {
          const { operation } = successful(
            await clientPeer.request("devices/motion/query", { operationId }),
          );
          if (!["preparing", "running", "stopping"].includes(operation.phase)) {
            assert.ok(
              operation.stopConfirmation === "confirmed" || operation.dispatch === "not-sent",
            );
            break;
          }
          if (now() >= deadline) throw new Error("Load stop disposition exceeded original bound");
          await pause(10);
        }
      }, readback);
      const dispatched = controls
        .get("kobrixa.device-ev3")!
        .trace()
        .find(
          (entry) =>
            entry.operationId === operationId &&
            entry.step === "stop" &&
            entry.dispatch !== "not-sent",
        );
      assert.ok(dispatched, "Missing real stop dispatch trace");
      stopDispatchMs.push(dispatched.time - stopAdmissionTimes.get(operationId)!);
      stopAdmissionTimes.delete(operationId);
      await pause(500);
    }
    gc();
    retainedHeap.push({ elapsedMs: now() - started, bytes: process.memoryUsage().heapUsed });
    assert.ok(
      deliveredBytes > 262_144,
      "Workload never generated one queue-budget worth of traffic",
    );
    assert.ok(peakQueuedBytes > 0 && peakQueuedBytes <= 262_144);
    assert.ok(overflowFrames > 0, "Workload must reach real telemetry queue pressure");
    return {
      durationMs: now() - started,
      retainedHeap,
      stopDispatchMs,
      scale: {
        channels: 38,
        actuators: 4,
        providers: 8,
        candidatesPerProvider: 32,
        candidatesGlobal: 64,
        subscriptions: 32,
        queueBytes: 262_144,
        journalEntries: 64,
      },
      measurements: { transport, readback, journal: journalTimes },
      environment: {
        commit: identity.commit,
        bundle: identity.artifact,
        artifact: "source-bundled synthetic-provider load",
        os: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        ramBytes: totalmem(),
        filesystem: "in-memory journal; no durability claim",
        node: process.version,
        electron: process.versions.electron,
        warmCold: "5s warmup then 600s measurement",
        memoryMethod:
          "forced GC retained heap, 60s samples; latency arrays retain last 256 observations",
      },
      traffic: {
        deliveredBytes,
        peakQueuedBytes,
        overflowFrames,
        acknowledgement: "batched at 1000 ms; ACK-timeout revocation tested by F13",
        queueBudgetAssertion: "F13 owner test",
      },
    };
  } finally {
    clearInterval(acknowledgement);
    clearInterval(heartbeat);
    for (const subscriptionId of subscriptions)
      await clientPeer.request("events/unsubscribe", { subscriptionId }).catch(() => undefined);
    admitted.delete(owner);
    await broker.resources.retire(owner, "disabled").settled;
    detach();
    hostPeer.close();
    clientPeer.close();
    for (const remove of removeProviders) remove();
    stopAdmissionTimes.clear();
  }
}

void app
  .whenReady()
  .then(async () => {
    assert.equal(app.requestSingleInstanceLock(), true);
    const identity: ArtifactIdentity = JSON.parse(
      await readFile(path.join(directory, "artifact-identity.json"), "utf8"),
    );
    assert.match(identity.commit, /^[0-9a-f]{40}$/);
    const broker = createDeviceBroker({
      authority: {
        current(principal, contextRef) {
          if (contextRef !== ref || principal.authorityContext?.ref !== ref) return null;
          return {
            ref,
            epoch,
            workbenchInstance,
            state: "local",
            roomBinding: null,
            connected: true,
            synced: true,
            role: null,
            isHolder: true,
          };
        },
        assertContinuation(principal, contextRef) {
          assert.equal(contextRef, ref);
          assert.equal(principal.authorityContext?.epoch, epoch);
        },
        subscribe(listener) {
          authorities.add(listener);
          return () => {
            authorities.delete(listener);
          };
        },
      },
      journal,
      profile: {
        hostEpoch,
        assertHeld() {
          assert.equal(app.hasSingleInstanceLock(), true);
        },
      },
      coreActions: createCoreActionLedger({
        now: () => performance.now(),
        current: (scope) =>
          scope.hostEpoch === hostEpoch && scope.workbenchInstance === workbenchInstance,
      }),
      requirements,
      connectionPolicy: () => configuredPolicy,
      operationGate: () => ({ ok: true, value: null }),
      now: () => performance.now(),
      hasPermission: () => true,
    });
    let unregister = broker.registerProvider(fakeProvider(broker));
    const launch = createDesktopLauncher({ python: () => ({ executable: python, args: [] }) });
    const transports: object[] = [];
    const negotiations: object[] = [];
    const channelChecks: object[] = [];
    let generation = 0;
    let retiredOwner: ResourceOwner | undefined;
    for (const language of ["js", "python"] as const)
      for (const row of negotiationCases) {
        const pluginDirectory = path.join(directory, language);
        const manifestPath = path.join(pluginDirectory, "kobrixa-plugin.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        delete manifest.requires;
        if (row.requires.length) manifest.requires = { devices: row.requires };
        await writeFile(manifestPath, JSON.stringify(manifest));
        const [registered] = await loadPlugins(
          [{ kind: "development", directory: pluginDirectory }],
          { disabled: new Set(), safeMode: false },
        );
        assert.ok(registered?.manifest);
        assert.equal(registered.status, "enabled");
        const owner: ResourceOwner = {
          sourceKey: registered.sourceKey,
          pluginId: registered.id,
          generation: generation++,
          hostEpoch,
          processEpoch: randomUUID(),
        };
        const principal: Principal = { kind: "plugin", owner, authorityContext: { ref, epoch } };
        const subscriptionProbe =
          row.name.startsWith("subscribe-") || row.name.startsWith("metadata-");
        admitted.set(
          owner,
          Object.freeze(
            (registered.manifest.requires?.devices ?? []).map(({ capability, required }) =>
              Object.freeze({ capability, required }),
            ),
          ),
        );
        successful(await broker.request(principal, "devices/negotiate", {}, signal));
        let connected: string | undefined;
        if (row.name === "required-disabled") unregister();
        else {
          const candidates = successful(
            await broker.request(
              hostPrincipal,
              "devices/discover",
              { providerId: "kobrixa.device-ev3" },
              signal,
            ),
          );
          connected = successful(
            await broker.request(
              hostPrincipal,
              "devices/connect",
              {
                target: { kind: "candidate", candidateId: candidates.candidates[0]!.candidateId },
              },
              signal,
            ),
          ).session.sessionId;
        }
        const scope = broker.intent.bindMotionScope({
          owner,
          contextRef: ref,
          panelInstance: randomUUID(),
          uiResourceGeneration: 0,
          workbenchInstance,
        });
        await writeFile(
          path.join(pluginDirectory, "fixture.json"),
          JSON.stringify({
            contextRef: ref,
            motionScopeRef: scope,
            negotiateOnly: row.name !== "absent" && row.name !== "event-delivery-withheld",
            eventTimeoutMs: row.name === "event-delivery-withheld" ? 250 : 5000,
            expectedSatisfied: row.satisfied,
            ...(subscriptionProbe ? { subscriptionProbe: row.name } : {}),
            ...(row.name === "hostile-requirements" ? { expectedRpcError: -32602 } : {}),
          }),
        );
        let sequence = 1;
        broker.intent.pulsePanel(scope, sequence++);
        const heartbeat = setInterval(() => broker.intent.pulsePanel(scope, sequence++), 100);
        if (row.name === "metadata-retired") assert.ok(retiredOwner);
        const metadataOwner =
          row.name === "metadata-retired"
            ? retiredOwner!
            : row.name === "metadata-wrong"
              ? { ...owner, generation: owner.generation + 1 }
              : owner;
        const child = await launch({
          id: owner.pluginId,
          sourceKey: owner.sourceKey,
          directory: pluginDirectory,
          entry: path.join(pluginDirectory, language === "js" ? "consumer.cjs" : "consumer.py"),
          runtime: language === "js" ? "node" : "python",
          ...(row.name === "metadata-absent" ? {} : { channelOwner: metadataOwner }),
          permissions: ["ui.notifications", "devices.read", "devices.connect", "devices.control"],
          commands: ["kobrixa-fixture.devices.probe"],
        });
        let notice:
          | {
              ok: true;
              rpcError?: number;
              businessError?: string;
              deliveries?: number;
              subscribed?: boolean;
              cancelled?: boolean;
              scenario?: string[];
              eventReceipt?: EventReceipt;
              negotiated?: {
                requirementsSatisfied: boolean;
                capabilities: { capability: string; state: string }[];
              };
            }
          | undefined;
        const outgoing: JsonRpcMessage[] = [];
        let withheldEvents = 0;
        const ackRequests = new Map<
          string | number,
          { subscriptionId: string; sequence: number }
        >();
        const successfulAcks: Array<{
          subscriptionId: string;
          sequence: number;
          acknowledged: number;
        }> = [];
        const requests = new Map<string | number, string>();
        let allocated!: () => void;
        const allocation = new Promise<void>((resolve) => {
          allocated = resolve;
        });
        const request = broker.request.bind(broker);
        broker.request = async (p, method, params, abort) => {
          const result = await request(p, method, params, abort);
          if (method === "devices/subscribe" && result.ok && "subscriptionId" in result.value) {
            allocated();
            if (row.name === "subscribe-cancel")
              await new Promise<void>((resolve) => {
                if (abort.aborted) resolve();
                else abort.addEventListener("abort", () => resolve(), { once: true });
              });
            if (row.name === "subscribe-invalid-result")
              return {
                ok: true,
                value: { subscriptionId: result.value.subscriptionId, sequence: 0 },
              } as never;
          }
          return result;
        };
        const peer = new RpcPeer({
          onMessage(listener) {
            return child.onMessage((text) => {
              const message = jsonRpcMessageSchema.parse(JSON.parse(text));
              if ("method" in message && "id" in message) {
                requests.set(message.id, message.method);
                if (message.method === "events/ack")
                  ackRequests.set(
                    message.id,
                    deviceRequestSchemas["events/ack"].params.parse(message.params),
                  );
              }
              if (
                row.name === "hostile-requirements" &&
                "method" in message &&
                message.method === "devices/negotiate"
              ) {
                message.params = {
                  requirements: [{ capability: "telemetry.v99", required: false }],
                };
                listener(JSON.stringify(message));
              } else listener(text);
            });
          },
          send(text) {
            const message = jsonRpcMessageSchema.parse(JSON.parse(text));
            if ("result" in message && requests.get(message.id) === "devices/subscribe") {
              const result = deviceRequestSchemas["devices/subscribe"].result.parse(message.result);
              if (result.ok) {
                if (subscriptionProbe) {
                  successful(
                    broker.events.publish(
                      owner,
                      result.value.subscriptionId,
                      {
                        kind: "devices.catalog",
                        data: deviceEventDataSchemas["devices.catalog"].parse(
                          result.value.snapshot,
                        ),
                      },
                      "control",
                    ),
                  );
                } else {
                  const data = deviceEventDataSchemas["devices.telemetry"].parse({
                    sessionId: connected,
                    frames: [],
                    snapshot: result.value.snapshot,
                  });
                  assert.ok(
                    data.snapshot.frame,
                    "Consumer must read the formal provider before subscribing",
                  );
                  data.frames = [data.snapshot.frame];
                  // Queue the formal provider's real sample while the reply is in flight.
                  successful(
                    broker.events.publish(
                      owner,
                      result.value.subscriptionId,
                      { kind: "devices.telemetry", data },
                      "telemetry",
                    ),
                  );
                }
                assert.equal(
                  outgoing.some((m) => "method" in m && m.method === "events/deliver"),
                  false,
                );
                if (row.name === "subscribe-send-throws")
                  throw new Error("Injected serialized subscription reply failure");
              }
            }
            if (
              row.name === "event-delivery-withheld" &&
              "method" in message &&
              message.method === "events/deliver"
            ) {
              withheldEvents++;
              return;
            }
            child.send(text);
            outgoing.push(message);
            if ("result" in message && ackRequests.has(message.id)) {
              const result = deviceRequestSchemas["events/ack"].result.parse(message.result);
              if (result.ok)
                successfulAcks.push({
                  ...ackRequests.get(message.id)!,
                  acknowledged: result.value.acknowledged,
                });
            }
          },
        });
        const detach = attachDeviceRpc({ peer, principal: () => principal, broker });
        assert.throws(
          () => attachDeviceRpc({ peer, principal: () => principal, broker }),
          /already attached/,
        );
        peer.handle("ui/showMessage", async ({ message }) => {
          const value = JSON.parse(message);
          if (value.readyToCancel) await allocation;
          else if (!value.eventBarrier) notice = value;
          return null;
        });
        try {
          await peer.request("initialize", {
            apiVersion: PLUGIN_API_VERSION,
            pluginId: owner.pluginId,
            locale: "en",
            grantedPermissions: [
              "ui.notifications",
              "devices.read",
              "devices.connect",
              "devices.control",
            ],
          });
          const command = peer.request(
            "command/execute",
            { command: "kobrixa-fixture.devices.probe" },
            { timeoutMs: 65_000 },
          );
          if (row.name === "event-delivery-withheld") {
            await assert.rejects(command, /SDK telemetry event deadline/);
            assert.equal(notice, undefined, "withheld event must not produce a success notice");
            assert.ok(withheldEvents > 0, "negative scenario must actually suppress real events");
            assert.equal(ackRequests.size, 0);
            assert.equal(broker.events.diagnostics().subscriptions, 0);
            channelChecks.push({ language, name: row.name, ok: true, withheldEvents });
          } else {
            assert.equal(await command, null);
            assert.ok(notice);
            const transport = language === "js" ? "electron-message-port" : "content-length";
            if (subscriptionProbe) {
              assert.equal(notice.deliveries, 0);
              if (row.name === "metadata-absent")
                assert.equal(notice.businessError, "PLUGIN_E_DEVICE_UNAVAILABLE");
              else if (row.name.startsWith("metadata-")) {
                assert.equal(notice.subscribed, true);
                assert.equal([...requests.values()].includes("events/ack"), false);
              } else if (row.name === "subscribe-cancel") {
                if (language === "js") assert.equal(notice.rpcError, -32800);
                else assert.equal(notice.cancelled, true);
              } else assert.equal(notice.rpcError, -32603);
              assert.equal(broker.events.diagnostics().subscriptions, 0);
              if (!row.name.startsWith("metadata-"))
                assert.equal(
                  outgoing.some((m) => "method" in m && m.method === "events/deliver"),
                  false,
                );
              channelChecks.push({ language, name: row.name, ok: true });
            } else if (row.name === "hostile-requirements") {
              assert.equal(notice.rpcError, -32602);
              assert.deepEqual(requirements(owner), []);
              channelChecks.push({ language, name: row.name, ok: true });
            } else if (row.name === "absent") {
              const receipt = notice.eventReceipt;
              assert.ok(receipt, "positive scenario must receive an SDK event");
              assert.equal(receipt.kind, "devices.telemetry");
              assert.equal(receipt.sessionId, connected);
              assert.deepEqual(receipt.owner, owner);
              const matchingEvents = outgoing
                .filter((m) => "method" in m && m.method === "events/deliver")
                .map((m) => eventEnvelopeSchema.parse("params" in m ? m.params : undefined))
                .filter(
                  (event) =>
                    event.subscriptionId === receipt.subscriptionId &&
                    event.sequence === receipt.sequence,
                );
              assert.equal(matchingEvents.length, 1);
              const matchingAcks = successfulAcks.filter(
                (ack) =>
                  ack.subscriptionId === receipt.subscriptionId &&
                  ack.sequence === receipt.sequence,
              );
              assert.equal(matchingAcks.length, 1, "receipt must correlate to one successful ACK");
              assert.equal(matchingAcks[0]!.acknowledged, receipt.sequence);
              const acknowledged = {
                subscriptionId: receipt.subscriptionId,
                sequence: receipt.sequence,
              };
              transports.push({ ...notice, acknowledged, language, transport });
              negotiations.push({ language, transport, name: row.name, ok: true });
              const replyAt = outgoing.findIndex(
                (m) => "result" in m && requests.get(m.id) === "devices/subscribe",
              );
              const eventsAt = outgoing.flatMap((m, index) =>
                "method" in m && m.method === "events/deliver" ? [index] : [],
              );
              assert.ok(replyAt >= 0 && eventsAt.length > 0);
              assert.ok(eventsAt.every((index) => index > replyAt));
              assert.equal(broker.events.diagnostics().subscriptions, 0);
              channelChecks.push({
                language,
                name: "reply-before-delivery",
                ok: true,
                events: eventsAt.length,
              });
            } else {
              assert.ok(notice.negotiated);
              assertNegotiation(row, notice.negotiated);
              negotiations.push({
                language,
                transport,
                name: row.name,
                ok: true,
                value: notice.negotiated,
              });
              if (row.name === "required-disabled")
                assert.deepEqual(
                  successful(await broker.request(hostPrincipal, "devices/list", {}, signal))
                    .providers,
                  [],
                );
            }
          }
          await peer.request("shutdown", {});
          const exited = new Promise<void>((resolve) => child.onExit(() => resolve()));
          peer.notify("exit", {});
          await Promise.race([
            exited,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("orphan consumer")), 5_000),
            ),
          ]);
        } finally {
          broker.request = request;
          clearInterval(heartbeat);
          broker.intent.revokeScope(scope, "closed");
          admitted.delete(owner);
          await broker.resources.retire(owner, "disabled").settled;
          detach();
          peer.close();
          child.forceKill();
        }
        const stale = await broker.request(principal, "devices/negotiate", {}, signal);
        assert.equal(stale.ok, false);
        if (!stale.ok) assert.equal(stale.error.code, "PLUGIN_E_STALE_RESOURCE");
        channelChecks.push({ language, name: `retired:${row.name}`, ok: true });
        retiredOwner = owner;
        if (connected)
          successful(
            await broker.request(
              hostPrincipal,
              "devices/disconnect",
              { sessionId: connected },
              signal,
            ),
          );
        if (row.name === "required-disabled")
          unregister = broker.registerProvider(fakeProvider(broker));
      }
    if (process.env.KOBRIXA_DEVICE_LOAD === "1") {
      unregister();
      unregister = broker.registerProvider(fakeProvider(broker, "kobrixa.device-ev3", true));
      await writeFile(
        path.join(directory, "load-result.json"),
        JSON.stringify(await runMaximumLoad(broker, identity), null, 2),
      );
    }
    unregister();
    await writeFile(
      path.join(directory, "transport-result.json"),
      JSON.stringify({ ...identity, transports, negotiations, channelChecks }, null, 2),
    );
    app.quit();
  })
  .catch(fail);
