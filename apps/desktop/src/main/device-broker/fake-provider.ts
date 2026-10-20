import type {
  CapabilityId,
  ChannelDefinition,
  TelemetryFrame,
  SourceCatalog,
} from "@kobrixa/plugin-protocol";
import type { Principal, FaultJournalDocument, PhysicalIdentity } from "@kobrixa/plugin-runtime";
import type { OperationDependencies, MotionAdmission } from "./operations.js";
import {
  ExchangeLane,
  type BuiltinDeviceProvider,
  type ProviderCandidateKey,
  type ProviderSessionKey,
  type ProviderOperationContext,
  type ProviderCleanupContext,
  type ProviderOutcome,
  type MotionCompletion,
  type ProviderConnection,
  type LegacyProviderRequest,
  type LegacyProviderValue,
} from "./provider.js";
export const ID = "00000000-0000-4000-8000-000000000001";
export const ACTUATOR = "00000000-0000-4000-8000-000000000002";
export function pluginPrincipal(generation = 1): Extract<Principal, { kind: "plugin" }> {
  return {
    kind: "plugin",
    owner: {
      sourceKey: "builtin:acme.test",
      pluginId: "acme.test",
      generation,
      hostEpoch: ID,
      processEpoch: `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`,
    },
    authorityContext: { ref: ID, epoch: ID },
  };
}
export const channel = (): ChannelDefinition => ({
  channelId: ID,
  kind: "input",
  portId: "1",
  typeId: "29",
  modeId: "0",
  component: 0,
  name: "Light",
  modeName: "Reflect",
  unit: "%",
  decimals: 0,
  state: "ready",
});
export const frame = (): TelemetryFrame => ({
  sequence: 1,
  sampledAt: 0,
  elapsedMs: 0,
  sourceRevision: 1,
  status: "ok",
  values: [{ channelId: ID, value: 42 }],
  program: "stopped",
});
const success = <T>(value: T): ProviderOutcome<T> => ({
  value,
  dispatch: "not-sent",
  stopConfirmation: "not-required",
  error: null,
});
export class FakeProvider implements BuiltinDeviceProvider {
  readonly id = "kobrixa.device-ev3";
  readonly capabilities: readonly CapabilityId[] = [
    "connection.v1",
    "telemetry.v1",
    "inputModes.v1",
    "finiteMotion.v1",
    "recordingReservation.v1",
  ];
  readonly calls: string[] = [];
  readonly session = {} as ProviderSessionKey;
  readonly candidate = {} as ProviderCandidateKey;
  readonly physical: PhysicalIdentity = {
    providerId: this.id,
    family: "ev3",
    basis: "serial",
    digest: "a".repeat(64),
    strength: "stable",
  };
  readonly descriptor = {
    providerId: this.id,
    name: "Test EV3",
    transport: "mock" as const,
    identity: "stable" as const,
  };
  #sourceRevision = 1;
  #modeId = "0";
  #lost = new Set<Parameters<BuiltinDeviceProvider["onDisconnect"]>[0]>();
  motion: (ctx: ProviderOperationContext) => Promise<MotionCompletion> = async (ctx) => {
    await ctx.exchange("motion-pulse", async () => {});
    return { movement: "completed", angle: 90, displacement: 90 };
  };
  async discover(ctx: ProviderOperationContext): ReturnType<BuiltinDeviceProvider["discover"]> {
    this.calls.push("discover");
    return ctx.exchange("discover", async () =>
      success([{ key: this.candidate, descriptor: this.descriptor, physical: this.physical }]),
    );
  }
  async connect(
    _target: ProviderCandidateKey | { wifiAddress: string },
    ctx: ProviderOperationContext,
  ) {
    this.calls.push("connect");
    return ctx.exchange("connect", async () => {
      this.#sourceRevision = 1;
      this.#modeId = "0";
      return success(this.describe(this.session));
    });
  }
  describe(_key: ProviderSessionKey): ProviderConnection {
    return {
      key: this.session,
      descriptor: this.descriptor,
      physical: this.physical,
      capabilities: [...this.capabilities],
    };
  }
  async disconnect(_session: ProviderSessionKey, ctx: ProviderCleanupContext) {
    return ctx.exchange("disconnect", async () => {
      this.calls.push("disconnect");
      return success(null);
    });
  }
  async sources(
    _session: ProviderSessionKey,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<SourceCatalog>> {
    ctx.assertContinuation("read");
    return success({
      sessionId: ctx.sessionId ?? ID,
      sourceRevision: this.#sourceRevision,
      channels: [{ ...channel(), modeId: this.#modeId }],
      actuators: [
        { actuatorId: ACTUATOR, portId: "A", name: "Motor", typeId: "7", state: "ready" },
      ],
    });
  }
  async read(_session: ProviderSessionKey, ctx: ProviderOperationContext) {
    this.calls.push("read");
    return success(
      await ctx.exchange("read", async () => ({
        ...frame(),
        sourceRevision: this.#sourceRevision,
        sequence: 0,
        sampledAt: 0,
        elapsedMs: 0,
      })),
    );
  }
  async inputModes(
    _session: ProviderSessionKey,
    request: { portId: string; expectedSourceRevision: number },
    ctx: ProviderOperationContext,
  ) {
    ctx.assertContinuation("read");
    return success({
      sourceRevision: this.#sourceRevision,
      portId: request.portId,
      typeId: "29",
      currentModeId: this.#modeId,
      modes: [{ modeId: "0", name: "Reflect" }],
    });
  }
  async setInputMode(
    session: ProviderSessionKey,
    _request: { portId: string; expectedSourceRevision: number; modeId: string },
    ctx: ProviderOperationContext,
  ) {
    await ctx.exchange("mode-write", async () => {
      this.#sourceRevision++;
      this.#modeId = _request.modeId;
    });
    const sources = (await this.sources(session, ctx)).value!;
    return success({
      sources,
      snapshot: {
        sessionId: sources.sessionId,
        revision: 1,
        status: "fresh" as const,
        ageMs: 0,
        frame: {
          ...frame(),
          sourceRevision: this.#sourceRevision,
          values: sources.channels.map((c) => ({ channelId: c.channelId, value: 42 })),
          sequence: 0,
          sampledAt: 0,
          elapsedMs: 0,
        },
      },
    });
  }
  async executeFiniteMotion(
    _session: ProviderSessionKey,
    _motion: MotionAdmission["motion"],
    ctx: ProviderOperationContext,
  ) {
    this.calls.push("motion");
    const value = await this.motion(ctx);
    return { ...success(value), dispatch: "sent" as const };
  }
  async stopAndReadback(
    _session: ProviderSessionKey,
    _target: { kind: "operation"; operationId: string } | { kind: "current-device" },
    ctx: ProviderCleanupContext,
  ) {
    await ctx.exchange("stop", async () => {
      this.calls.push("stop");
    });
    return ctx.exchange("readback", async () => ({
      value: {
        programStopped: true,
        outputs: Array.from({ length: 4 }, () => ({
          actuatorId: ACTUATOR,
          known: true,
          busy: false,
          speed: 0,
        })),
        observedAt: 0,
      },
      dispatch: "sent" as const,
      stopConfirmation: "confirmed" as const,
      error: null,
    }));
  }
  async observeIdle(session: ProviderSessionKey, ctx: ProviderOperationContext) {
    return ctx.exchange("readback", async () =>
      success({
        programStopped: true,
        outputs: Array.from({ length: 4 }, () => ({
          actuatorId: ACTUATOR,
          known: true,
          busy: false,
          speed: 0,
        })),
        observedAt: 0,
      }),
    );
  }
  async legacy(
    _session: ProviderSessionKey,
    request: LegacyProviderRequest,
    ctx: ProviderOperationContext,
  ): Promise<ProviderOutcome<LegacyProviderValue>> {
    ctx.assertContinuation(
      request.kind === "list" || request.kind === "download" ? "read" : "file-begin",
    );
    this.calls.push(request.kind);
    if (request.kind === "list") return success({ kind: "entries", entries: [] });
    if (request.kind === "download") {
      await request.sink(new Uint8Array());
      return success({ kind: "transfer", transferred: 0 });
    }
    if (request.kind === "upload") {
      let transferred = 0;
      try {
        for await (const chunk of request.chunks) {
          await ctx.exchange("file-chunk", async () => {
            transferred += chunk.length;
          });
          request.progress(transferred, request.size);
        }
      } finally {
        await ctx.exchange("file-close", async () => {
          this.calls.push("close");
        });
      }
      return success({ kind: "transfer", transferred });
    }
    if (request.kind === "run")
      return { ...success({ kind: "launch", sent: true } as const), dispatch: "sent" };
    return success({ kind: "mutation", verified: true });
  }
  onDisconnect(listener: Parameters<BuiltinDeviceProvider["onDisconnect"]>[0]) {
    this.#lost.add(listener);
    return () => {
      this.#lost.delete(listener);
    };
  }
  lose(): void {
    for (const listener of this.#lost) listener(this.session, "connection-lost");
  }
  releaseOperation(_id: string): void {
    this.calls.push("release");
  }
  async dispose(ctx: ProviderCleanupContext) {
    ctx.assertCleanup("disconnect");
    this.calls.push("dispose");
  }
}
export function operationHarness() {
  let now = 0;
  let document: FaultJournalDocument = {
    schemaVersion: 1,
    revision: 0,
    entries: [],
    integrity: { algorithm: "sha256", digest: "0".repeat(64) },
  };
  const provider = new FakeProvider();
  const dependencies: OperationDependencies = {
    now: () => now,
    profile: { hostEpoch: ID, assertHeld() {} },
    check: () => {},
    journal: {
      load: async () => structuredClone(document),
      commit: async (next) => {
        document = structuredClone(next);
      },
      snapshot: () => ({
        revision: document.revision,
        journalHealth: "ready",
        faults: document.entries,
        blockers: document.entries.filter((e) => e.state !== "resolved").map((e) => e.id),
      }),
      subscribe: () => () => {},
    },
  };
  const admission: MotionAdmission = {
    principal: pluginPrincipal(),
    sessionId: ID,
    generation: 1,
    physical: provider.physical,
    provider,
    key: provider.session,
    lane: new ExchangeLane(() => now),
    motion: {
      mode: "timed",
      actuatorId: ACTUATOR,
      power: 10,
      direction: 1,
      brake: true,
      durationMs: 100,
    },
    contextRef: ID,
    motionScopeRef: ID,
  };
  return {
    provider,
    dependencies,
    admission,
    setNow(value: number) {
      now = value;
    },
  };
}

import type { Handle, DispatchOutcome } from "@kobrixa/plugin-protocol";
import type { ProviderCatalogPort, ProviderStep } from "./provider.js";
export type FakeProviderPoint = "before-exchange" | "after-exchange" | "before-stop-readback";
export interface FakeProviderControl {
  block(point: FakeProviderPoint, step: ProviderStep): void;
  reached(point: FakeProviderPoint, step: ProviderStep): Promise<void>;
  release(point: FakeProviderPoint, step: ProviderStep): void;
  trace(): readonly {
    step: ProviderStep;
    operationId: Handle;
    time: number;
    dispatch: DispatchOutcome;
  }[];
}
export function createFakeDeviceProvider(input: {
  catalog: ProviderCatalogPort;
  now: () => number;
}): { provider: BuiltinDeviceProvider; control: FakeProviderControl } {
  type Barrier = { hit: Promise<void>; mark: () => void; wait: Promise<void>; release: () => void };
  const barriers = new Map<string, Barrier>();
  const trace: Array<{
    step: ProviderStep;
    operationId: Handle;
    time: number;
    dispatch: DispatchOutcome;
  }> = [];
  const key = (point: FakeProviderPoint, step: ProviderStep) => `${point}:${step}`;
  const control: FakeProviderControl = {
    block(point, step) {
      const id = key(point, step);
      if (barriers.has(id)) throw new Error("Barrier already blocked");
      let mark!: () => void, release!: () => void;
      const hit = new Promise<void>((resolve) => {
          mark = resolve;
        }),
        wait = new Promise<void>((resolve) => {
          release = resolve;
        });
      barriers.set(id, { hit, mark, wait, release });
    },
    reached(point, step) {
      const barrier = barriers.get(key(point, step));
      if (!barrier) throw new Error("Barrier not blocked");
      return barrier.hit;
    },
    release(point, step) {
      const id = key(point, step),
        barrier = barriers.get(id);
      if (!barrier) throw new Error("Barrier not blocked");
      barrier.release();
      barriers.delete(id);
    },
    trace() {
      return structuredClone(trace);
    },
  };
  const pause = async (point: FakeProviderPoint, step: ProviderStep) => {
    const barrier = barriers.get(key(point, step));
    if (barrier) {
      barrier.mark();
      await barrier.wait;
    }
  };
  const invokeGuarded = async <T>(
    ctx: ProviderOperationContext | ProviderCleanupContext,
    step: ProviderStep,
    invoke: (signal: AbortSignal, timeoutMs: number) => Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> => {
    await pause("before-exchange", step);
    if ("assertContinuation" in ctx) ctx.assertContinuation(step);
    else if (
      step === "stop" ||
      step === "readback" ||
      step === "file-close" ||
      step === "disconnect"
    )
      ctx.assertCleanup(step);
    else throw new Error("Invalid cleanup step");
    trace.push({ step, operationId: ctx.operationId, time: input.now(), dispatch: "not-sent" });
    const value = await invoke(signal, timeoutMs);
    trace.push({ step, operationId: ctx.operationId, time: input.now(), dispatch: "sent" });
    await pause("after-exchange", step);
    return value;
  };
  const work = (ctx: ProviderOperationContext): ProviderOperationContext => ({
    ...ctx,
    exchange: (step, invoke) =>
      ctx.exchange(step, (signal, timeout) => invokeGuarded(ctx, step, invoke, signal, timeout)),
  });
  const cleanup = (ctx: ProviderCleanupContext): ProviderCleanupContext => ({
    ...ctx,
    get deadlineMonotonicMs() {
      return ctx.deadlineMonotonicMs;
    },
    exchange: (step, invoke) =>
      ctx.exchange(step, (signal, timeout) => invokeGuarded(ctx, step, invoke, signal, timeout)),
  });
  class ControlledProvider extends FakeProvider {
    override discover(ctx: ProviderOperationContext) {
      return super.discover(work(ctx));
    }
    override connect(
      target: ProviderCandidateKey | { wifiAddress: string },
      ctx: ProviderOperationContext,
    ) {
      return super.connect(target, work(ctx));
    }
    override disconnect(session: ProviderSessionKey, ctx: ProviderCleanupContext) {
      return super.disconnect(session, cleanup(ctx));
    }
    override async sources(session: ProviderSessionKey, ctx: ProviderOperationContext) {
      const result = await super.sources(session, work(ctx));
      if (result.value) {
        for (const channel of result.value.channels)
          channel.channelId = input.catalog.identify({
            sessionId: result.value.sessionId,
            portId: channel.portId,
            typeId: channel.typeId,
            modeId: channel.modeId,
            component: channel.component,
            unit: channel.unit,
          });
      }
      return result;
    }
    override async read(session: ProviderSessionKey, ctx: ProviderOperationContext) {
      const result = await super.read(session, work(ctx));
      if (result.value) {
        const sources = await this.sources(session, ctx);
        result.value.values = result.value.values.map((value, index) => ({
          ...value,
          channelId: sources.value!.channels[index]!.channelId,
        }));
      }
      return result;
    }
    override inputModes(
      session: ProviderSessionKey,
      request: { portId: string; expectedSourceRevision: number },
      ctx: ProviderOperationContext,
    ) {
      return super.inputModes(session, request, work(ctx));
    }
    override setInputMode(
      session: ProviderSessionKey,
      request: { portId: string; expectedSourceRevision: number; modeId: string },
      ctx: ProviderOperationContext,
    ) {
      return super.setInputMode(session, request, work(ctx));
    }
    override executeFiniteMotion(
      session: ProviderSessionKey,
      motion: MotionAdmission["motion"],
      ctx: ProviderOperationContext,
    ) {
      return super.executeFiniteMotion(session, motion, work(ctx));
    }
    override async stopAndReadback(
      session: ProviderSessionKey,
      target: { kind: "operation"; operationId: string } | { kind: "current-device" },
      ctx: ProviderCleanupContext,
    ) {
      await pause("before-stop-readback", "stop");
      return super.stopAndReadback(session, target, cleanup(ctx));
    }
    override observeIdle(session: ProviderSessionKey, ctx: ProviderOperationContext) {
      return super.observeIdle(session, work(ctx));
    }
    override legacy(
      session: ProviderSessionKey,
      request: LegacyProviderRequest,
      ctx: ProviderOperationContext,
    ) {
      return super.legacy(session, request, work(ctx));
    }
    override dispose(ctx: ProviderCleanupContext) {
      return super.dispose(cleanup(ctx));
    }
  }
  return { provider: new ControlledProvider(), control };
}
