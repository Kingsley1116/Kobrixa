import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { assertContentionEvidence } from "./plugin-persistence-harness.mjs";
import { selectFoundationCases } from "./plugin-persistence-run.mjs";
import { contentionOracle } from "./fixtures/plugin-persistence/contention-oracle.mjs";
import {
  produceContention,
  registerContentionCheckpoint,
} from "./plugin-persistence-contention.ts";

test("contention releases the original reservation when setup or cleanup fails", async () => {
  // Exercise the registration helper itself: a failed broker probe must unblock
  // its outstanding registration before restoring the real engine methods.
  const cp = contentionOracle().contention.checkpoint;
  const failure = new Error("probe failed while original worker paused");
  let resume,
    reached,
    pending,
    paused = false,
    settled = false;
  const trace = [];
  const engine = {
    reserve: async () => {},
    append: async (_ticket, offset, bytes) => offset + bytes.length,
    publish: async () => {
      paused = true;
      trace.push({ point: "before-publish", ticket: cp.publication.ticket.id });
      reached();
      await new Promise((resolve) => {
        resume = resolve;
      });
      paused = false;
      return cp.publication.result;
    },
    reconcile: async () => cp.recordOutcome,
  };
  const originalPublish = engine.publish,
    originalReserve = engine.reserve;
  const input = {
    now: () => 1,
    recording: { principal: () => ({ kind: "plugin", owner: cp.recordTicket.owner }) },
    backend: {
      engine,
      evidence: {
        capture: () => ({}),
        tickets: () => [cp.recordTicket],
        flush: async () => ({ state: "saved" }),
      },
    },
    fault: {
      trace: () => trace.slice(),
      reached: () =>
        new Promise((resolve) => {
          reached = resolve;
        }),
      arm() {},
      release() {
        resume?.();
      },
    },
    host: {
      async request(_principal, method) {
        if (method === "storage/beginWrite") return { ok: true, value: { write: "write" } };
        if (method === "storage/commitWrite")
          return { ok: true, value: { record: cp.record, receipt: cp.receipt } };
        if (method === "storage/registerCheckpoint") {
          pending = (async () => {
            const bytes = Buffer.from(JSON.stringify(cp.document));
            await engine.reserve(cp.publication.ticket, bytes.length);
            await engine.append(cp.publication.ticket, 0, bytes);
            await engine.publish(cp.publication.ticket);
            settled = true;
            return { ok: true, value: { checkpoint: cp.checkpoint } };
          })();
          return pending;
        }
        return { ok: true, value: {} };
      },
    },
  };
  await assert.rejects(
    registerContentionCheckpoint(input, cp.document.binding, async () => {
      assert.equal(paused, true);
      assert.equal(settled, false);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(paused, false);
  assert.equal(settled, true);
  assert.equal(engine.publish, originalPublish);
  assert.equal(engine.reserve, originalReserve);
  await pending;
  for (const stage of ["session", "second-scope", "form-and-revoke"]) {
    const failure = new Error(`Injected ${stage} failure`);
    const cleanupFailure = new Error("Injected revoke failure");
    const released = [],
      revoked = [];
    const principals = [0, 1].map((n) => ({
      kind: "plugin",
      owner: { sourceKey: `builtin:owner${n}` },
      authorityContext: { ref: `context${n}` },
    }));
    const reservation = {
      reservationId: "original-reservation",
      sessionId: "original-session",
      state: "active",
    };
    let scopes = 0;
    let drainSettled = false;
    const participant = {
      async drain() {
        await new Promise((resolve) => setTimeout(resolve, 10));
        drainSettled = true;
        return { state: "saved", blocker: false };
      },
    };
    const originalDrain = participant.drain;
    const input = {
      host: { participant },
      recording: { principal: () => principals[0] },
      settings: { principal: () => principals[1] },
      reserveRecording: async () => reservation,
      now: () => 2,
      checkpoint: async (_reservation, whilePaused) => {
        await whilePaused();
        return contentionOracle().contention.checkpoint;
      },
      winner: {
        prepare: async () => {
          throw failure;
        },
      },
      scope: () => ({ workbenchInstance: "original-window" }),
      broker: {
        intent: {
          bindMotionScope() {
            if (stage === "second-scope" && scopes === 1) throw failure;
            return `scope${scopes++}`;
          },
          pulsePanel() {},
          revokeScope(scope) {
            revoked.push(scope);
            if (stage === "form-and-revoke") throw cleanupFailure;
          },
        },
        async request(principal, method, params) {
          if (method === "devices/recording/release") {
            released.push({ principal, params });
            // Production lifecycle schedules reservation-end dispatch this way.
            queueMicrotask(() => {
              void participant.drain();
            });
            return { ok: true, value: { reservation } };
          }
          if (method === "devices/list")
            return {
              ok: true,
              value: { sessions: [{ sessionId: reservation.sessionId, state: "connected" }] },
            };
          if (method === "devices/session") {
            if (stage === "session") throw failure;
            return {
              ok: true,
              value: { sources: { actuators: [{ state: "ready", actuatorId: "test-actuator" }] } },
            };
          }
          if (method === "devices/recording/query") return { ok: true, value: { reservation } };
          if (method === "devices/motion/prepare")
            return { ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } };
          throw new Error(`Unexpected call ${method}`);
        },
      },
      form: {
        async prepare() {
          throw failure;
        },
      },
    };
    await assert.rejects(produceContention(input), (error) => {
      if (stage !== "form-and-revoke") return error === failure;
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], failure);
      assert.deepEqual(error.errors.slice(1), [cleanupFailure, cleanupFailure]);
      return true;
    });
    assert.equal(drainSettled, true, "Returning the failure must not race consumer retirement");
    assert.equal(participant.drain, originalDrain);
    assert.deepEqual(
      released,
      [{ principal: principals[0], params: { reservationId: reservation.reservationId } }],
      stage,
    );
    assert.deepEqual(
      revoked,
      Array.from({ length: scopes }, (_, n) => `scope${n}`),
      stage,
    );
  }
});

test("contention oracle requires both owners, live conflicts and the actual losing form", () => {
  assertContentionEvidence(contentionOracle());
  for (const mutate of [
    (e) => (e.contention.blockedSave.expectedTicket.owner = e.contention.owners[1]),
    (e) =>
      (e.contention.blockedSave.expectedTicket.owner.processEpoch =
        e.contention.beforeForm.binding.scope.workbenchInstance),
    (e) => (e.contention.motionProbes[0].startedAt = 0),
    (e) => (e.contention.motionProbes[1].endedAt = 5),
    (e) => (e.contention.checkpoint.pause.ticket.id = e.contention.sessionId),
    (e) =>
      e.contention.checkpoint.pause.traceBeforeRelease.push({
        point: "after-publish",
        ticket: e.contention.checkpoint.publication.ticket.id,
      }),
    (e) => (e.contention.checkpoint.publication.result.receipt.revision = "forged"),
    (e) => (e.contention.checkpoint.receipt.commitId = e.contention.sessionId),
    (e) => delete e.contention.checkpoint.document.binding.providerGeneration,
    (e) =>
      (e.contention.finalDrain.request = {
        checkpoints: e.contention.finalDrain.request.checkpoints,
      }),
    (e) => e.contention.finalDrain.ended.providerGeneration++,
    (e) => (e.contention.finalDrain.ended.drain.reservationId = e.contention.sessionId),
    (e) => e.contention.finalDrain.offer.deadlineMonotonicMs++,
    (e) => (e.contention.finalDrain.request.token = e.contention.sessionId),
    (e) => (e.contention.finalDrain.report.records[0].committedRevision = "forged"),
    (e) => (e.contention.finalPublication.ticket.target.expectedRevision = "forged"),
    (e) => (e.contention.finalWrites[0].params.drainToken = e.contention.sessionId),
    (e) => (e.contention.finalWrites[0].result.write = e.contention.sessionId),
    ...["kind", "schemaVersion", "label", "mediaType", "byteLength", "sha256"].flatMap((key) => [
      (e) => delete e.contention.finalWrites[0].params[key],
      (e) =>
        (e.contention.finalWrites[0].params[key] =
          typeof e.contention.finalWrites[0].params[key] === "number" ? 999999 : "forged"),
    ]),
    (e) => delete e.contention,
    (e) => delete e.contention.blockedSave,
    (e) => delete e.contention.checkpoint,
    (e) => (e.contention.checkpoint.recordTicket.target.id = e.contention.sessionId),
    (e) => (e.contention.finalDrain.request.checkpoints = []),
    (e) => (e.contention.finalDrain.report.state = "failed"),
    (e) => (e.contention.blockedSave.expectedTicket.id = e.contention.sessionId),
    (e) => (e.contention.checkpoint.document.binding.reservationId = e.contention.sessionId),
    (e) => (e.contention.checkpoint.document.checkpoint = e.contention.sessionId),
    (e) => (e.contention.checkpoint.payloadBase64 = "AA=="),
    (e) => (e.contention.checkpoint.publication.result.disposition = "unknown"),
    (e) => (e.contention.blockedSave.expectedTicket.target.kind = "recovery"),
    (e) => (e.contention.winnerBefore.binding.scope = e.contention.beforeForm.binding.scope),
    (e) => (e.contention.winnerAfter.inputEvents = []),
    (e) => (e.contention.blockedSave.writeSettledAtStop = true),
    (e) => (e.contention.blockedSave.saveReleasedAt = 1),
    (e) => (e.contention.blockedSave.traceAfterRelease = []),
    (e) =>
      (e.contention.blockedSave.motionDuringSave = {
        ...e.contention.blockedSave.motionDuringSave,
        phase: "stopped",
      }),
    (e) => e.contention.motionProbes.pop(),
    (e) => e.contention.recordingProbes.pop(),
    (e) => (e.contention.owners[1] = e.contention.owners[0]),
    (e) => (e.contention.motionProbes[1].owner = e.contention.owners[0]),
    (e) =>
      (e.contention.recordingProbes[0].before = {
        ...e.contention.recordingProbes[0].before,
        phase: "stopped",
      }),
    (e) =>
      (e.contention.motionProbes[0].after = {
        ...e.contention.motionProbes[0].after,
        state: "ended",
      }),
    (e) => (e.contention.recordingProbes[0].result = { ok: true, value: {} }),
    (e) => (e.contention.motionProbes[0].result.error.code = "PLUGIN_E_PERMISSION_DENIED"),
    (e) => (e.contention.stopped.stopConfirmation = "unconfirmed"),
    (e) => (e.contention.released.reason = "disconnected"),
    (e) => (e.contention.updates[1].params.expectedRevision = e.contention.persisted.revision),
    (e) => (e.contention.updates[1].result.error.code = "PLUGIN_E_STORAGE_IO"),
    (e) => (e.contention.updates[0].caller = "form"),
    (e) => e.contention.updates.pop(),
    (e) => (e.contention.afterForm.input.value = "Winning write"),
    (e) => (e.contention.afterForm.state.draft = e.contention.persisted.values),
    (e) => (e.contention.afterForm.state.errors = []),
    (e) =>
      (e.contention.afterForm.binding = {
        ...e.contention.afterForm.binding,
        owner: { ...e.contention.afterForm.binding.owner, uiResourceGeneration: 2 },
      }),
    (e) => (e.contention.afterForm.fieldIds["fixture.note"] = "field99"),
    (e) => (e.contention.afterForm.inputEvents = []),
    (e) => (e.contention.afterForm.inputEvents.at(-1).trusted = false),
    (e) => (e.checks.settingsSuccess = 2),
    (e) => (e.checks.concurrentActive = 1),
  ]) {
    const evidence = contentionOracle();
    mutate(evidence);
    assert.throws(() => assertContentionEvidence(evidence));
  }
});

test("contention can be selected alone without opening the unfinished full matrix", () => {
  assert.deepEqual(selectFoundationCases({ caseId: "contention" }), ["contention"]);
  assert.throws(() => selectFoundationCases(), /BLOCKED: remaining observation-table producers/);
  assert.deepEqual(selectFoundationCases({ caseId: "suspend-wake" }), ["suspend-wake"]);
  assert.throws(
    () => selectFoundationCases({ referencesOnly: true, caseId: "contention" }),
    /mutually exclusive/,
  );
});

test("contention uses original ports and mapped native settings controls", async () => {
  const producer = await readFile(
    new URL("./plugin-persistence-contention.ts", import.meta.url),
    "utf8",
  );
  const main = await readFile(new URL("./plugin-persistence-main.ts", import.meta.url), "utf8");
  const renderer = await readFile(
    new URL("./plugin-persistence-renderer.tsx", import.meta.url),
    "utf8",
  );
  for (const call of [
    "input.broker.request",
    "input.host.request",
    "input.host.settings.update",
    "originalUpdate.call",
    'input.fault.arm("before-publish", "pause")',
  ])
    assert.ok(producer.includes(call), call);
  assert.match(main, /contention:\s*\(\) =>\s*produceContention/);
  assert.ok(main.includes("win.webContents.insertText(text)"));
  assert.ok(main.includes('keyCode: "Return"'));
  assert.ok(renderer.includes("settingsAttachment(control)?.fieldMap(view.resource)"));
  assert.ok(renderer.includes("event.isTrusted"));
  assert.ok(!main.includes(".click()"), "Do not synthesize DOM activation");
  assert.ok(!producer.includes("createPersistenceHost("));
  assert.ok(main.includes('url.searchParams.set("view", "settings-only")'));
  assert.ok(renderer.includes("!settingsOnly &&"));
  assert.ok(
    producer.indexOf("await input.checkpoint(") < producer.indexOf("await input.winner.prepare()"),
  );
});

test("unexpected recording admissions are retained before denial and released despite other cleanup failures", async () => {
  for (const admittedIndex of [0, 1]) {
    const e = contentionOracle().contention;
    const principals = e.owners.map((owner) => ({
      kind: "plugin",
      owner,
      authorityContext: { ref: owner.sourceKey },
    }));
    const reservation = { ...e.motionProbes[0].before, channels: [{ channelId: "channel" }] };
    const released = [];
    const barriers = new Set();
    const cleanupFailure = new Error("injected cleanup failure");
    let recordingActive = true,
      probes = 0;
    const participant = {
      endReservation() {
        return e.finalDrain.offer;
      },
      async drain(_offer, dispatch) {
        await dispatch(principals[0].owner, e.finalDrain.request);
        return e.finalDrain.report;
      },
    };
    const input = {
      now: () => 1,
      recording: { principal: () => principals[0] },
      settings: { principal: () => principals[1] },
      scope: () => e.beforeForm.binding.scope,
      reserveRecording: async () => reservation,
      checkpoint: async (_reservation, whilePaused) => {
        await whilePaused();
        return e.checkpoint;
      },
      winner: { prepare: async () => e.winnerBefore },
      form: { prepare: async () => e.beforeForm },
      backend: {
        engine: { reconcile: async () => e.finalPublication.result },
        evidence: {
          capture: () => {
            const barrier = {};
            barriers.add(barrier);
            return barrier;
          },
          tickets: (barrier) => {
            assert.ok(barriers.has(barrier), "stale barrier");
            return [e.finalPublication.ticket];
          },
          flush: async (barrier) => {
            assert.ok(barriers.delete(barrier), "stale barrier");
            return { state: "saved" };
          },
        },
      },
      host: {
        participant,
        settings: { read: async () => ({ ok: true, value: e.beforeForm.state.baseline }) },
        async request(_principal, method) {
          if (method === "settings/read") return { ok: true, value: e.beforeForm.state.baseline };
          if (method === "storage/stat") return { ok: true, value: { record: e.finalRecord } };
          throw new Error(`Unexpected host request ${method}`);
        },
      },
      broker: {
        intent: {
          bindMotionScope: () => "scope",
          pulsePanel() {},
          revokeScope() {
            throw cleanupFailure;
          },
        },
        async request(principal, method, params) {
          if (method === "devices/list")
            return {
              ok: true,
              value: { sessions: [{ sessionId: reservation.sessionId, state: "connected" }] },
            };
          if (method === "devices/session")
            return {
              ok: true,
              value: {
                sources: {
                  sourceRevision: 1,
                  actuators: [{ state: "ready", actuatorId: "actuator" }],
                },
              },
            };
          if (method === "devices/recording/query") return { ok: true, value: { reservation } };
          if (method === "devices/motion/prepare")
            return recordingActive
              ? { ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } }
              : { ok: true, value: { operation: e.recordingProbes[0].before } };
          if (method === "devices/motion/start") return { ok: true, value: {} };
          if (method === "devices/motion/query")
            return { ok: true, value: { operation: e.recordingProbes[0].before } };
          if (method === "devices/recording/reserve")
            return probes++ === admittedIndex
              ? {
                  ok: true,
                  value: { reservation: { ...reservation, reservationId: "unexpected" } },
                }
              : { ok: false, error: { code: "PLUGIN_E_DEVICE_BUSY" } };
          if (method === "devices/motion/stop") throw cleanupFailure;
          if (method === "devices/recording/release") {
            released.push({ principal, id: params.reservationId });
            if (recordingActive) {
              recordingActive = false;
              participant.endReservation(e.finalDrain.ended, e.finalDrain.deadline);
              await participant.drain(e.finalDrain.offer, async () => ({}));
              return { ok: true, value: { reservation: e.released } };
            }
            if (params.reservationId === reservation.reservationId) throw cleanupFailure;
            return { ok: true, value: { reservation: { ...reservation, state: "ended" } } };
          }
          throw new Error(`Unexpected broker request ${method}`);
        },
      },
    };
    await assert.rejects(produceContention(input), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.errors[0].message, /Recording admitted during motion/);
      assert.deepEqual(error.errors.slice(1), Array(4).fill(cleanupFailure));
      return true;
    });
    assert.deepEqual(
      released.map((row) => row.id),
      [reservation.reservationId, reservation.reservationId, "unexpected"],
    );
    assert.equal(released.at(-1).principal, principals[admittedIndex]);
  }
});

test("production seam: distinct native scopes remain live on the same backend", async () => {
  const { build } = await import("esbuild");
  const { resolve } = await import("node:path");
  const compiled = await build({
    entryPoints: [resolve("apps/desktop/src/main/plugins/persistence/settings-service.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    alias: { "@kobrixa/plugin-protocol": resolve("packages/plugin-protocol/src/index.ts") },
  });
  const { createBoundSettingsService } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=contention-production-seam.mjs").toString("base64")}`
  );
  const e = contentionOracle().contention,
    owner = e.owners[1];
  const resource = {
    schemaVersion: 1,
    title: { en: "Settings" },
    fields: [
      {
        key: "fixture.note",
        type: "string",
        label: { en: "Note" },
        default: "",
        minLength: 0,
        maxLength: 100,
        maxBytes: 400,
      },
    ],
  };
  let stored = null;
  let publishes = 0;
  const pending = new Map();
  const input = {
    backend: {
      reads: { settings: async () => structuredClone(stored) },
      evidence: {
        settingsDigest: async () =>
          stored && {
            schemaVersion: 1,
            revision: stored.revision,
            validationDigest: "b".repeat(64),
          },
      },
      engine: {
        reserve: async () => {},
        append: async (ticket, _offset, bytes) => {
          pending.set(ticket.id, JSON.parse(new TextDecoder().decode(bytes)));
          return bytes.length;
        },
        seal: async () => {},
        publish: async (ticket) => {
          assert.equal(ticket.target.expectedRevision, stored?.revision ?? null);
          publishes++;
          const revision = `r_${String(publishes).padStart(32, "0")}`;
          stored = { schemaVersion: 1, revision, values: pending.get(ticket.id).values };
          return {
            disposition: "committed",
            receipt: {
              revision,
              commitId: ticket.id,
              durability: "file-and-directory-sync",
            },
          };
        },
        abort: async () => "aborted",
      },
    },
    sources: {
      current: () => true,
      settings: async () => ({
        owner: e.beforeForm.binding.owner,
        resource,
        validationDigest: "b".repeat(64),
      }),
      coreOwner: ({ scope }) =>
        [e.beforeForm, e.winnerBefore].some(
          (form) =>
            form.binding.scope.workbenchInstance === scope.workbenchInstance &&
            form.binding.scope.hostEpoch === scope.hostEpoch,
        )
          ? { ...owner, hostEpoch: scope.hostEpoch, processEpoch: scope.workbenchInstance }
          : null,
    },
    events: { onRemoved: () => () => {} },
    now: () => 0,
  };
  const service = createBoundSettingsService(input);
  assert.equal(createBoundSettingsService(input), service, "Backend owns one bound service");
  const open = (form) =>
    service.open({
      sourceKey: owner.sourceKey,
      scope: form.binding.scope,
      resourceDigest: "a".repeat(64),
    });
  const first = await open(e.winnerBefore);
  assert.equal((await service.read(first.binding)).ok, true);
  const second = await open(e.beforeForm);
  assert.notDeepEqual(first.binding.scope, second.binding.scope);
  assert.equal((await service.read(first.binding)).ok, true);
  assert.equal((await service.read(second.binding)).ok, true);
  const results = await Promise.all(
    [first, second].map((form, index) =>
      service.update(form.binding, {
        schemaVersion: 1,
        expectedRevision: form.snapshot.revision,
        changes: [{ key: "fixture.note", value: `window-${index}` }],
      }),
    ),
  );
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).error.code, "PLUGIN_E_SETTINGS_CONFLICT");
  assert.equal(publishes, 1);
  service.dispose(second.binding);
  assert.equal((await service.read(first.binding)).ok, true);
  service.dispose(first.binding);
});

test("production broker requires each owner to list the connected session before BUSY arbitration", async () => {
  const { build } = await import("esbuild");
  const { resolve } = await import("node:path");
  const compiled = await build({
    stdin: {
      contents: `export { createBroker } from './apps/desktop/src/main/device-broker/broker.ts';
      export { operationHarness, pluginPrincipal, ID } from './apps/desktop/src/main/device-broker/fake-provider.ts';`,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    alias: {
      "@kobrixa/plugin-protocol": resolve("packages/plugin-protocol/src/index.ts"),
      "@kobrixa/plugin-runtime": resolve("packages/plugin-runtime/src/index.ts"),
    },
  });
  const { createBroker, operationHarness, pluginPrincipal, ID } = await import(
    `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text + "\n//# sourceURL=contention-production-seam.mjs").toString("base64")}`
  );
  const h = operationHarness();
  const broker = createBroker(
    {
      ...h.dependencies,
      authority: {
        current: () => ({
          ref: ID,
          epoch: ID,
          workbenchInstance: ID,
          state: "local",
          roomBinding: null,
          connected: false,
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
    },
    {
      recovery: ({ journal }) => ({
        snapshot: () => journal.snapshot(),
        subscribe: () => () => {},
      }),
      participant: (driver) => ({
        retire: (owner, reason) => driver.revokeOwner(owner, reason),
        async retireProvider(id, generation) {
          const results = await Promise.all(driver.revokeProvider(id, generation));
          return {
            stopConfirmed: results.every((r) => r.stopConfirmed),
            journalCommitted: results.every((r) => r.journalCommitted),
            faultIds: results.flatMap((r) => r.faultIds),
          };
        },
      }),
    },
  );
  const unregister = broker.registerProvider(h.provider);
  const principals = [
    pluginPrincipal(),
    {
      ...pluginPrincipal(2),
      owner: {
        ...pluginPrincipal(2).owner,
        sourceKey: "builtin:other.test",
        pluginId: "other.test",
      },
    },
  ];
  const request = (index, method, params = {}) =>
    broker.request(principals[index], method, params, new AbortController().signal);
  const accepted = (result) => {
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  const scopes = [];
  let reservation;
  try {
    const { session } = accepted(
      await request(0, "devices/connect", {
        target: { kind: "wifi-address", providerId: h.provider.id, address: "127.0.0.1" },
      }),
    );
    const current = accepted(await request(0, "devices/session", { sessionId: session.sessionId }));
    reservation = accepted(
      await request(0, "devices/recording/reserve", {
        sessionId: session.sessionId,
        channelIds: current.sources.channels.map((row) => row.channelId),
        expectedSourceRevision: current.sources.sourceRevision,
      }),
    ).reservation;
    for (const principal of principals) {
      const scope = broker.intent.bindMotionScope({
        owner: principal.owner,
        contextRef: ID,
        panelInstance: crypto.randomUUID(),
        uiResourceGeneration: 0,
        workbenchInstance: ID,
      });
      scopes.push(scope);
      broker.intent.pulsePanel(scope, 1);
    }
    const prepare = (index) =>
      request(index, "devices/motion/prepare", {
        sessionId: session.sessionId,
        contextRef: ID,
        motionScopeRef: scopes[index],
        motion: {
          actuatorId: current.sources.actuators[0].actuatorId,
          mode: "timed",
          power: 1,
          direction: 1,
          brake: true,
          durationMs: 5000,
        },
      });
    const stale = await prepare(1);
    assert.equal(stale.error.code, "PLUGIN_E_STALE_RESOURCE");
    assert.deepEqual(stale.error.detail, {
      kind: "resource",
      reason: "stale",
      resource: "operation",
    });
    accepted(await request(1, "devices/list"));
    for (const index of [0, 1]) {
      const denied = await prepare(index);
      assert.equal(denied.error.code, "PLUGIN_E_DEVICE_BUSY");
      assert.equal(denied.error.detail.reason, "recording");
    }
    assert.equal(
      accepted(
        await request(0, "devices/recording/query", { reservationId: reservation.reservationId }),
      ).reservation.state,
      "active",
    );
  } finally {
    for (const scope of scopes) broker.intent.revokeScope(scope, "closed");
    if (reservation)
      accepted(
        await request(0, "devices/recording/release", { reservationId: reservation.reservationId }),
      );
    unregister();
  }
});
