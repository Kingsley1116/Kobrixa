import { expect, it, vi } from "vitest";
import { createContexts } from "./provider.js";
import { operationHarness, ID } from "./fake-provider.js";
it("F09 fake provider exercises the same exchange boundary, without transport", async () => {
  const h = operationHarness();
  h.admission.lane.reserve(ID);
  const c = createContexts({
    id: ID,
    sessionId: ID,
    generation: 1,
    operationClass: "finite-motion",
    deadline: 30000,
    now: h.dependencies.now,
    lane: h.admission.lane,
    check: () => {},
    progress: () => {},
    onStop: () => {},
  });
  const result = await h.provider.executeFiniteMotion(
    h.provider.session,
    h.admission.motion,
    c.work,
  );
  expect(result.dispatch).toBe("sent");
  expect(result.value?.movement).toBe("completed");
  c.stop("cancelled", true);
  expect(
    (
      await h.provider.stopAndReadback(
        h.provider.session,
        { kind: "operation", operationId: ID },
        c.cleanup,
      )
    ).stopConfirmation,
  ).toBe("confirmed");
});

import { createFakeDeviceProvider, pluginPrincipal } from "./fake-provider.js";
import { createProviderCatalog, EventLedger } from "./registry.js";
import { IntentRegistry } from "./intent.js";
it.each(["before-exchange", "after-exchange"] as const)(
  "formal fake %s cancellation has single dispatch and original cleanup",
  async (point) => {
    const h = operationHarness(),
      fake = createFakeDeviceProvider({
        catalog: createProviderCatalog(),
        now: h.dependencies.now,
      });
    h.admission.lane.reserve(ID);
    const c = createContexts({
      id: ID,
      sessionId: ID,
      generation: 1,
      operationClass: "finite-motion",
      deadline: 30000,
      now: h.dependencies.now,
      lane: h.admission.lane,
      check: () => {},
      progress: () => {},
      onStop: () => {},
    });
    fake.control.block(point, "motion-pulse");
    const pending = fake.provider.executeFiniteMotion(
      h.provider.session,
      h.admission.motion,
      c.work,
    );
    const rejected = expect(pending).rejects.toThrow();
    await fake.control.reached(point, "motion-pulse");
    c.stop("cancelled", true);
    fake.control.release(point, "motion-pulse");
    await rejected;
    fake.control.block("before-stop-readback", "stop");
    const cleanup = fake.provider.stopAndReadback(
      h.provider.session,
      { kind: "operation", operationId: ID },
      c.cleanup,
    );
    await fake.control.reached("before-stop-readback", "stop");
    expect(c.cleanup.brakeRequired()).toBe(true);
    fake.control.release("before-stop-readback", "stop");
    expect((await cleanup).stopConfirmation).toBe("confirmed");
    const sent = fake.control.trace().filter((row) => row.dispatch === "sent");
    expect(sent.filter((row) => row.step === "motion-pulse")).toHaveLength(
      point === "before-exchange" ? 0 : 1,
    );
    expect(sent.filter((row) => row.step === "stop")).toHaveLength(1);
  },
);
it("control pressure immediately revokes motion intent before any ACK", () => {
  const owner = pluginPrincipal().owner,
    intent = new IntentRegistry(
      () => 0,
      () => {},
    ),
    scope = intent.bindMotionScope({
      owner,
      contextRef: ID,
      panelInstance: ID,
      uiResourceGeneration: 1,
      workbenchInstance: ID,
    });
  intent.pulsePanel(scope, 1);
  const events = new EventLedger(
      () => 0,
      () => {},
      (owner) => intent.retire(owner),
    ),
    row = events.create(owner);
  if (!row.ok) throw new Error("subscription");
  for (let i = 0; i < 8; i++)
    events.publish(
      owner,
      row.value.subscriptionId,
      { kind: "devices.catalog", data: { revision: i, providers: [], sessions: [] } },
      "control",
    );
  expect(() => intent.assert(owner, scope, ID)).toThrow();
  // Resync replaces superseded control entries and retains its own ACK deadline.
  expect(events.diagnostics().queuedEvents).toBe(1);
  events.disposeOwner(owner);
});

import { randomUUID } from "node:crypto";
import { ExchangeLane } from "./provider.js";
import type { ProviderSessionKey } from "./provider.js";
function fixtureContext(sessionId = randomUUID()) {
  return createContexts({
    id: randomUUID(),
    sessionId,
    generation: 1,
    operationClass: "finite-motion",
    deadline: 30000,
    now: () => 0,
    lane: new ExchangeLane(() => 0),
    check: () => {},
    progress: () => {},
    onStop: () => {},
  });
}
it("maximum profile provides eight named providers with stable distinct physical candidates", async () => {
  const catalog = createProviderCatalog(),
    physical = new Set<string>(),
    providers = new Set<string>();
  for (let index = 0; index < 8; index++) {
    const providerId = index === 0 ? "kobrixa.device-ev3" : `kobrixa.fixture${index + 1}`;
    const fake = createFakeDeviceProvider({
        catalog,
        now: () => 0,
        profile: "maximum",
        providerId,
      }),
      ctx = fixtureContext();
    providers.add(fake.provider.id);
    expect(fake.provider.id).toBe(providerId);
    const candidates = (await fake.provider.discover(ctx.work)).value!;
    expect(candidates).toHaveLength(32);
    expect(new Set(candidates.map((c) => c.key)).size).toBe(32);
    expect((await fake.provider.discover(ctx.work)).value).toEqual(candidates);
    for (const candidate of candidates) {
      expect(candidate.descriptor.providerId).toBe(providerId);
      expect(candidate.physical.providerId).toBe(providerId);
      expect(candidate.physical.digest).toMatch(/^[0-9a-f]{64}$/);
      physical.add(candidate.physical.digest!);
    }
    const connected = (await fake.provider.connect(candidates[7]!.key, ctx.work)).value!;
    expect(connected.physical).toEqual(candidates[7]!.physical);
    expect(fake.provider.describe(connected.key)).toEqual(connected);
    const recreated = createFakeDeviceProvider({
      catalog,
      now: () => 0,
      profile: "maximum",
      providerId,
    });
    expect((await recreated.provider.discover(ctx.work)).value?.map((c) => c.physical)).toEqual(
      candidates.map((c) => c.physical),
    );
  }
  expect(providers.size).toBe(8);
  expect(physical.size).toBe(256);
});
it("maximum channels and actuators are stable and mode changes agree with reads", async () => {
  const fake = createFakeDeviceProvider({
      catalog: createProviderCatalog(),
      now: () => 0,
      profile: "maximum",
    }),
    ctx = fixtureContext();
  const candidate = (await fake.provider.discover(ctx.work)).value![0]!,
    connection = (await fake.provider.connect(candidate.key, ctx.work)).value!;
  const sources = (await fake.provider.sources(connection.key, ctx.work)).value!;
  expect(sources.channels).toHaveLength(38);
  expect(new Set(sources.channels.map((c) => c.channelId)).size).toBe(38);
  expect(sources.actuators).toHaveLength(4);
  expect(new Set(sources.actuators.map((a) => a.actuatorId)).size).toBe(4);
  expect((await fake.provider.sources(connection.key, ctx.work)).value).toEqual(sources);
  const modes = (
    await fake.provider.inputModes(
      connection.key,
      { portId: "1", expectedSourceRevision: 1 },
      ctx.work,
    )
  ).value!;
  expect(modes.modes.map((m) => m.modeId)).toEqual(["0", "1"]);
  const changed = (
    await fake.provider.setInputMode(
      connection.key,
      { portId: "1", expectedSourceRevision: 1, modeId: "1" },
      ctx.work,
    )
  ).value!;
  expect(changed.sources.sourceRevision).toBe(2);
  expect(
    changed.sources.channels.filter((c) => c.portId === "1").every((c) => c.modeId === "1"),
  ).toBe(true);
  expect(changed.sources.channels.filter((c) => c.portId !== "1")).toEqual(
    sources.channels.filter((c) => c.portId !== "1"),
  );
  expect(
    changed.sources.channels
      .filter((c) => c.portId === "1")
      .every((c) => !sources.channels.some((old) => old.channelId === c.channelId)),
  ).toBe(true);
  const read = (await fake.provider.read(connection.key, ctx.work)).value!;
  expect(read.sourceRevision).toBe(2);
  expect(read.values.map((v) => v.channelId)).toEqual(
    changed.sources.channels.map((c) => c.channelId),
  );
  expect(changed.snapshot.frame).not.toBeNull();
  expect(read.values).toEqual(changed.snapshot.frame!.values);
  const idle = (await fake.provider.observeIdle(connection.key, ctx.work)).value!;
  expect(idle.outputs.map((o) => o.actuatorId)).toEqual(sources.actuators.map((a) => a.actuatorId));
  const stopped = (
    await fake.provider.stopAndReadback(connection.key, { kind: "current-device" }, ctx.cleanup)
  ).value!;
  expect(stopped.outputs).toEqual(idle.outputs);
});
it("maximum diagnostics retain recent bounded rows and reset without releasing a control barrier", async () => {
  const fake = createFakeDeviceProvider({
      catalog: createProviderCatalog(),
      now: () => 0,
      profile: "maximum",
    }),
    ctx = fixtureContext(),
    session = {} as ProviderSessionKey;
  for (let i = 0; i < 1200; i++) await fake.provider.read(session, ctx.work);
  expect(fake.control.trace()).toHaveLength(1024);
  const snapshot = fake.control.trace();
  expect(snapshot.at(-1)?.dispatch).toBe("sent");
  fake.control.block("before-exchange", "read");
  const read = fake.provider.read(session, ctx.work);
  await fake.control.reached("before-exchange", "read");
  fake.control.resetTrace();
  expect(fake.control.trace()).toEqual([]);
  expect(snapshot).toHaveLength(1024);
  fake.control.release("before-exchange", "read");
  await read;
  expect(fake.control.trace().map((r) => r.dispatch)).toEqual(["not-sent", "sent"]);
});
it("default fixture keeps its scale and returns four distinct safe idle output IDs", async () => {
  const fake = createFakeDeviceProvider({ catalog: createProviderCatalog(), now: () => 0 }),
    ctx = fixtureContext(),
    session = {} as ProviderSessionKey;
  expect(fake.provider.id).toBe("kobrixa.device-ev3");
  expect((await fake.provider.discover(ctx.work)).value).toHaveLength(1);
  const sources = (await fake.provider.sources(session, ctx.work)).value!;
  expect(sources.channels).toHaveLength(1);
  expect(sources.actuators).toHaveLength(1);
  const outputs = (await fake.provider.observeIdle(session, ctx.work)).value!.outputs;
  expect(new Set(outputs.map((o) => o.actuatorId)).size).toBe(4);
  expect(outputs[0]!.actuatorId).toBe(sources.actuators[0]!.actuatorId);
});

import { FakeProvider } from "./fake-provider.js";
it("maximum call diagnostics are capped and reset with trace, while default call history is unchanged", async () => {
  for (const maximum of [false, true]) {
    const fake = createFakeDeviceProvider({
        catalog: createProviderCatalog(),
        now: () => 0,
        ...(maximum ? { profile: "maximum" as const } : {}),
      }),
      ctx = fixtureContext();
    expect(fake.provider).toBeInstanceOf(FakeProvider);
    if (!(fake.provider instanceof FakeProvider)) throw new Error("fixture type");
    for (let i = 0; i < 1100; i++) await fake.provider.read(fake.provider.session, ctx.work);
    expect(fake.provider.calls).toHaveLength(maximum ? 1024 : 1100);
    expect(fake.control.trace()).toHaveLength(maximum ? 1024 : 2200);
    fake.control.resetTrace();
    expect(fake.provider.calls).toEqual([]);
    expect(fake.control.trace()).toEqual([]);
  }
});
it("maximum mode rejects invalid/stale edits without changing its catalog and reconnect resets modes", async () => {
  const fake = createFakeDeviceProvider({
      catalog: createProviderCatalog(),
      now: () => 0,
      profile: "maximum",
    }),
    ctx = fixtureContext();
  const candidates = (await fake.provider.discover(ctx.work)).value!,
    connection = (await fake.provider.connect(candidates[0]!.key, ctx.work)).value!;
  const before = (await fake.provider.sources(connection.key, ctx.work)).value!;
  for (const request of [
    { portId: "5", expectedSourceRevision: 1, modeId: "1" },
    { portId: "1", expectedSourceRevision: 2, modeId: "1" },
    { portId: "1", expectedSourceRevision: 1, modeId: "unknown" },
  ])
    await expect(fake.provider.setInputMode(connection.key, request, ctx.work)).rejects.toThrow(
      "Invalid fake mode request",
    );
  expect((await fake.provider.sources(connection.key, ctx.work)).value).toEqual(before);
  await fake.provider.setInputMode(
    connection.key,
    { portId: "1", expectedSourceRevision: 1, modeId: "1" },
    ctx.work,
  );
  expect(
    (
      await fake.provider.inputModes(
        connection.key,
        { portId: "1", expectedSourceRevision: 2 },
        ctx.work,
      )
    ).value?.currentModeId,
  ).toBe("1");
  await fake.provider.connect(candidates[0]!.key, ctx.work);
  expect((await fake.provider.sources(connection.key, ctx.work)).value).toEqual(before);
  await expect(
    fake.provider.connect({} as Parameters<typeof fake.provider.connect>[0], ctx.work),
  ).rejects.toThrow("Unknown fake candidate");
});
it.each(["before-exchange", "after-exchange"] as const)(
  "maximum profile retains real exchange cancellation at %s and permits original cleanup",
  async (point) => {
    const fake = createFakeDeviceProvider({
        catalog: createProviderCatalog(),
        now: () => 0,
        profile: "maximum",
      }),
      ctx = fixtureContext(),
      session = {} as ProviderSessionKey;
    fake.control.block(point, "read");
    const reading = fake.provider.read(session, ctx.work),
      rejected = expect(reading).rejects.toThrow();
    await fake.control.reached(point, "read");
    ctx.stop("cancelled", true);
    fake.control.release(point, "read");
    await rejected;
    const dispatched = fake.control
      .trace()
      .filter((r) => r.step === "read" && r.dispatch === "sent");
    expect(dispatched).toHaveLength(point === "before-exchange" ? 0 : 1);
    const result = await fake.provider.stopAndReadback(
      session,
      { kind: "current-device" },
      ctx.cleanup,
    );
    expect(result.stopConfirmation).toBe("confirmed");
    expect(new Set(result.value!.outputs.map((o) => o.actuatorId)).size).toBe(4);
  },
);
it("provider identity validation fails closed without changing production registration policy", () => {
  for (const providerId of ["", "../provider", "provider", "kobrixa." + "a".repeat(129)])
    expect(() =>
      createFakeDeviceProvider({
        catalog: createProviderCatalog(),
        now: () => 0,
        profile: "maximum",
        providerId,
      }),
    ).toThrow("Invalid fake provider ID");
});

it.each([100, 5000])(
  "maximum timed motion runs for durationMs=%i without extending exchange budgets",
  async (durationMs) => {
    vi.useFakeTimers();
    try {
      const fake = createFakeDeviceProvider({
        catalog: createProviderCatalog(),
        now: Date.now,
        profile: "maximum",
      });
      const ctx = fixtureContext();
      let completed = false;
      const pending = fake.provider
        .executeFiniteMotion(
          {} as ProviderSessionKey,
          { ...operationHarness().admission.motion, mode: "timed", durationMs },
          ctx.work,
        )
        .then((result) => {
          completed = true;
          return result;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(
        fake.control
          .trace()
          .filter((row) => row.step === "motion-pulse" && row.dispatch === "sent"),
      ).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(durationMs - 1);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await pending).value?.movement).toBe("completed");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  },
);

it("maximum timed motion remains active at 20ms and Stop interrupts it before original cleanup", async () => {
  vi.useFakeTimers();
  try {
    const fake = createFakeDeviceProvider({
      catalog: createProviderCatalog(),
      now: Date.now,
      profile: "maximum",
    });
    const ctx = fixtureContext();
    let settled = false;
    const pending = fake.provider
      .executeFiniteMotion({} as ProviderSessionKey, operationHarness().admission.motion, ctx.work)
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.advanceTimersByTimeAsync(20);
    expect(settled).toBe(false);
    expect(fake.control.trace().some((row) => row.step === "stop")).toBe(false);
    const stopAt = Date.now();
    ctx.stop("cancelled", true);
    expect((await pending).value?.movement).toBe("interrupted");
    expect(vi.getTimerCount()).toBe(0);
    const cleanup = await fake.provider.stopAndReadback(
      {} as ProviderSessionKey,
      { kind: "operation", operationId: ctx.work.operationId },
      ctx.cleanup,
    );
    expect(cleanup.stopConfirmation).toBe("confirmed");
    const stops = fake.control
      .trace()
      .filter((row) => row.step === "stop" && row.dispatch === "sent");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.time).toBeGreaterThanOrEqual(stopAt);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
