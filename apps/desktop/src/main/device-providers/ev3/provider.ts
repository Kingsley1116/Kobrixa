import { isIP } from "node:net";
import {
  DeviceOperationError,
  UsbTransport,
  WiFiTransport,
  type DeviceDescriptor,
  type DeviceIoStep,
  type EV3DeviceSession,
} from "@kobrixa/device";
import type {
  CapabilityId,
  DeviceErrorReason,
  DispatchOutcome,
  Handle,
} from "@kobrixa/plugin-protocol";
import type {
  BuiltinDeviceProvider,
  DeviceConnectionPolicy,
  ProviderCandidateKey,
  ProviderSessionKey,
  ProviderCatalogPort,
  ProviderOperationContext,
  ProviderCleanupContext,
  ProviderStep,
  ProviderOutcome,
  ProviderConnection,
} from "../../device-broker/provider.js";
import { Ev3Catalog, EV3_PROVIDER_ID, physicalIdentity } from "./catalog.js";
import { executeLegacy } from "./legacy.js";
import { Ev3MotionEngine } from "./motion.js";
import type { IdleObservation } from "../../device-broker/provider.js";
import type { BrokerFailure } from "../../device-broker/registry.js";
function isIdle(value: IdleObservation): boolean {
  return (
    value.programStopped &&
    value.outputs.length === 4 &&
    new Set(value.outputs.map((o) => o.actuatorId)).size === 4 &&
    value.outputs.every((o) => o.known && o.busy === false && o.speed === 0)
  );
}
const capabilities: CapabilityId[] = [
  "connection.v1",
  "telemetry.v1",
  "inputModes.v1",
  "finiteMotion.v1",
  "recordingReservation.v1",
];
interface Transport {
  discover(signal: AbortSignal): Promise<DeviceDescriptor[]>;
  connect(
    target: DeviceDescriptor,
    signal: AbortSignal,
    options?: { connectTimeoutMs: number; handshakeTimeoutMs: number },
  ): Promise<EV3DeviceSession>;
}
interface RecordState {
  raw: EV3DeviceSession;
  connection: ProviderConnection;
  catalog?: Ev3Catalog;
  sessionId?: Handle;
  origin: number;
  motion: Ev3MotionEngine;
  removeListener: () => void;
}
function descriptor(value: DeviceDescriptor): ProviderConnection["descriptor"] {
  const name = value.name.trim();
  if (
    !name ||
    [...name].length > 200 ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("provider-contract");
  if (value.transport === "mock") throw new Error("provider-contract");
  return {
    providerId: EV3_PROVIDER_ID,
    name,
    transport: value.transport,
    ...(value.address ? { address: value.address } : {}),
    identity: value.serialNumber?.trim() ? "stable" : "session-only",
  };
}
function wireStep(payload: Uint8Array, fallback: ProviderStep): ProviderStep {
  if (payload[0] === 1) {
    switch (payload[1]) {
      case 0x98:
        return "file-close";
      case 0x92:
        return fallback === "helper-upload" ? "helper-upload" : "file-begin";
      case 0x93:
        return fallback === "helper-upload" ? "helper-upload" : "file-chunk";
      case 0x94:
      case 0x95:
      case 0x99:
      case 0x9a:
        return "read";
      case 0x9b:
        return "file-mkdir";
    }
  }
  if (payload[3] === 0xc0 && payload[4] === 31) return "file-copy";
  if (payload[3] === 0xc0 && payload[4] === 30) return "file-remove";
  return fallback;
}
export function createEv3Provider(catalog: ProviderCatalogPort): BuiltinDeviceProvider {
  return buildEv3Provider(catalog, { usb: new UsbTransport(), wifi: new WiFiTransport() });
}
// A module-local injectable factory for deterministic provider tests; host
// registration always uses createEv3Provider through K150's allowlist.
export function buildEv3Provider(
  ids: ProviderCatalogPort,
  transports: { usb: Transport; wifi: Transport },
): BuiltinDeviceProvider {
  const candidates = new WeakMap<
    ProviderCandidateKey,
    { descriptor: DeviceDescriptor; expires: number }
  >();
  const records = new Map<ProviderSessionKey, RecordState>();
  const listeners = new Set<(session: ProviderSessionKey, reason: DeviceErrorReason) => void>();
  const requireRecord = (
    key: ProviderSessionKey,
    ctx?: ProviderOperationContext | ProviderCleanupContext,
  ): RecordState => {
    const record = records.get(key);
    if (!record || !record.raw.connected) throw new Error("disconnected");
    if (ctx?.sessionId) {
      if (record.sessionId && record.sessionId !== ctx.sessionId)
        throw new Error("provider-contract");
      if (!record.sessionId) {
        record.sessionId = ctx.sessionId;
        record.catalog = new Ev3Catalog(ids, ctx.sessionId);
      }
    }
    return record;
  };
  const reason = (error: unknown): DeviceErrorReason => {
    // Session methods normalize exchange failures while preserving their cause.
    if (error instanceof DeviceOperationError && error.cause instanceof Error) error = error.cause;
    if (error instanceof Error && "result" in error) {
      const detail = (error as BrokerFailure).result.error.detail;
      if (detail?.kind === "device") return detail.reason;
    }
    const message = error instanceof Error ? error.message : "";
    const valid = [
      "authority-changed",
      "cancelled",
      "deadline",
      "disconnected",
      "provider-contract",
      "preflight-program-running",
      "preflight-output-unknown",
      "preflight-output-moving",
      "motor-unavailable",
      "source-changed",
      "mode-unavailable",
      "readback-failed",
      "stop-deadline",
    ] as const;
    return valid.find((value) => value === message) ?? "provider-failure";
  };
  const execute = async <T>(
    key: ProviderSessionKey,
    ctx: ProviderOperationContext,
    work: (record: RecordState, bind: (step: ProviderStep) => EV3DeviceSession) => Promise<T>,
  ): Promise<ProviderOutcome<T>> => {
    let dispatch: DispatchOutcome = "not-sent",
      late: unknown,
      closeFailure: unknown;
    try {
      const record = requireRecord(key, ctx);
      const bind = (fallback: ProviderStep): EV3DeviceSession => {
        const motor =
          ctx.operationClass === "finite-motion" ||
          ["preflight", "readback", "stop"].includes(fallback);
        const step: DeviceIoStep =
          fallback === "helper-upload" || fallback === "file-begin"
            ? "file-transfer"
            : motor
              ? "motor"
              : "ordinary";
        const signal = new AbortController().signal;
        return record.raw.bindIo({
          step,
          signal,
          boundary: {
            beforeExchange() {
              if (late) throw late;
              ctx.assertContinuation(fallback);
            },
            timeoutMs: (kind) =>
              Math.min(
                kind === "motor" ? 2000 : kind === "file-transfer" ? 10000 : 5000,
                ctx.deadlineMonotonicMs - ctx.now(),
              ),
            afterExchange() {
              try {
                ctx.assertContinuation(fallback);
              } catch (error) {
                late = error;
              }
            },
          },
          async exchange(payload, invoke) {
            const actual = wireStep(payload, fallback);
            if (actual !== "file-close" && late) throw late;
            if (actual !== "file-close") ctx.assertContinuation(actual);
            // AM-05: T2 binds this existing step to the retained cleanup context.
            // Its assertion, signal, handle whitelist and deadline are independent.
            if (actual === "file-close") ctx.assertContinuation("file-close");
            const result = await ctx
              .exchange(actual, async (transportSignal, timeout) => {
                if (dispatch !== "unknown") dispatch = "sent";
                try {
                  return await invoke(transportSignal, timeout);
                } catch (error) {
                  dispatch = "unknown";
                  if (actual === "file-close") closeFailure = error;
                  throw error;
                }
              })
              .catch((error: unknown) => {
                if (actual === "file-close") closeFailure = error;
                throw error;
              });
            // Preserve the reply long enough for session.ts to register its file
            // handle. A failed post-check blocks the very next ordinary exchange
            // and final publication, while original file-close can still run.
            if (actual !== "file-close") {
              try {
                ctx.assertContinuation(actual);
              } catch (error) {
                late = error;
              }
            }
            return result;
          },
        });
      };
      const value = await work(record, bind);
      if (late) throw late;
      ctx.assertContinuation("read");
      return { value, dispatch, stopConfirmation: "not-required", error: null };
    } catch (error) {
      return {
        value: null,
        dispatch,
        stopConfirmation: closeFailure ? "unconfirmed" : "not-required",
        error: {
          reason: reason(closeFailure ?? late ?? error),
          message: closeFailure
            ? "Original file close failed; cleanup remains unconfirmed."
            : dispatch === "not-sent"
              ? "EV3 operation did not start."
              : "EV3 operation did not complete; partial device changes may remain.",
        },
      };
    }
  };
  const cleanupBind = (
    record: RecordState,
    ctx: ProviderCleanupContext,
    step: "stop" | "readback",
  ) =>
    record.raw.bindIo({
      step: "motor",
      signal: ctx.signal,
      boundary: {
        beforeExchange() {
          ctx.assertCleanup(step);
        },
        afterExchange() {
          ctx.assertCleanup(step);
        },
        timeoutMs: () => Math.min(2000, ctx.deadlineMonotonicMs - ctx.now()),
      },
      exchange: (_payload, invoke) => ctx.exchange(step, invoke),
    });
  return {
    id: EV3_PROVIDER_ID,
    capabilities,
    async discover(ctx) {
      try {
        ctx.assertContinuation("discover");
        const result = await Promise.allSettled([
          ctx.exchange("discover", (signal) => transports.usb.discover(signal)),
          ctx.exchange("discover", (signal) => transports.wifi.discover(signal)),
        ]);
        ctx.assertContinuation("discover");
        const values = result.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
        if (!values.length && result.some((r) => r.status === "rejected"))
          throw new Error("provider-failure");
        if (values.length > 32) throw new Error("provider-contract");
        return {
          value: values.map((raw) => {
            const key = Object.freeze({}) as ProviderCandidateKey;
            candidates.set(key, { descriptor: raw, expires: ctx.now() + 30000 });
            return { key, descriptor: descriptor(raw), physical: physicalIdentity(raw) };
          }),
          dispatch: "not-sent",
          stopConfirmation: "not-required",
          error: null,
        };
      } catch (error) {
        return {
          value: null,
          dispatch: "not-sent",
          stopConfirmation: "not-required",
          error: { reason: reason(error), message: "EV3 discovery unavailable." },
        };
      }
    },
    async connect(target, ctx) {
      let raw: EV3DeviceSession | undefined;
      try {
        ctx.assertContinuation("connect");
        if (records.size) throw new Error("provider-contract");
        let selected: DeviceDescriptor;
        if ("wifiAddress" in target) {
          if (!isIP(target.wifiAddress) || target.wifiAddress.includes("%"))
            throw new Error("provider-contract");
          selected = {
            id: `wifi:${target.wifiAddress}`,
            name: `EV3 ${target.wifiAddress}`,
            transport: "wifi",
            address: target.wifiAddress,
          };
        } else {
          const candidate = candidates.get(target);
          if (!candidate || ctx.now() >= candidate.expires) throw new Error("provider-contract");
          selected = candidate.descriptor;
          candidates.delete(target);
        }
        const policy: DeviceConnectionPolicy = ids.connectionPolicy(); // broker-captured immutable policy for this attempt
        raw = await ctx.exchange("connect", (signal, remaining) => {
          const budget = Math.min(remaining, ctx.deadlineMonotonicMs - ctx.now());
          if (budget <= 0) throw new Error("deadline");
          return selected.transport === "usb"
            ? transports.usb.connect(selected, signal)
            : transports.wifi.connect(selected, signal, {
                connectTimeoutMs: Math.min(policy.wifiConnectTimeoutMs, budget),
                handshakeTimeoutMs: Math.min(policy.wifiHandshakeTimeoutMs, budget),
              });
        });
        ctx.assertContinuation("connect");
        if (!raw) throw new Error("provider-contract");
        const key = Object.freeze({}) as ProviderSessionKey;
        const connection: ProviderConnection = {
          key,
          descriptor: descriptor(selected),
          physical: physicalIdentity(selected),
          capabilities: [...capabilities],
        };
        const record: RecordState = {
          raw,
          connection,
          origin: ctx.now(),
          motion: new Ev3MotionEngine(),
          removeListener: () => {},
        };
        record.removeListener = raw.onDisconnect((_) => {
          for (const listener of listeners) listener(key, "connection-lost");
        });
        records.set(key, record);
        return {
          value: connection,
          dispatch: "sent",
          stopConfirmation: "not-required",
          error: null,
        };
      } catch (error) {
        await raw?.disconnect().catch(() => {});
        return {
          value: null,
          dispatch: raw ? "unknown" : "not-sent",
          stopConfirmation: "not-required",
          error: { reason: reason(error), message: "EV3 connection unavailable." },
        };
      }
    },
    describe: (key) => requireRecord(key).connection,
    async disconnect(key, ctx) {
      try {
        const record = requireRecord(key);
        ctx.assertCleanup("disconnect");
        await ctx.exchange("disconnect", () => record.raw.disconnect());
        record.removeListener();
        records.delete(key);
        return { value: null, dispatch: "sent", stopConfirmation: "not-required", error: null };
      } catch {
        return {
          value: null,
          dispatch: "unknown",
          stopConfirmation: "unconfirmed",
          error: { reason: "connection-lost", message: "Disconnect was not confirmed." },
        };
      }
    },
    sources: (key, ctx) =>
      execute(key, ctx, async (record, bind) => {
        const reading = await bind("read").readMonitor(ctx.cancellation, () => ctx.shouldYield());
        if (!reading || !record.catalog) throw new Error("provider-contract");
        return record.catalog.accept(reading);
      }),
    read: (key, ctx) =>
      execute(key, ctx, async (record, bind) => {
        const reading = await bind("read").readMonitor(ctx.cancellation, () => ctx.shouldYield());
        if (!reading || !record.catalog) throw new Error("provider-contract");
        return record.catalog.frame(reading);
      }),
    inputModes: (key, request, ctx) =>
      execute(key, ctx, async (record, bind) => {
        const catalog = record.catalog?.snapshot;
        if (!catalog || catalog.sourceRevision !== request.expectedSourceRevision)
          throw new Error("source-changed");
        const source = catalog.channels.find(
          (c) => c.portId === request.portId && c.kind === "input",
        );
        if (!source) throw new Error("source-changed");
        const value = await bind("read").readInputModes(
          Number(request.portId.split(":")[1]),
          Number(source.typeId.split(":")[1]),
          ctx.cancellation,
          () => ctx.shouldYield(),
        );
        if (!value) throw new Error("source-changed");
        return {
          sourceRevision: catalog.sourceRevision,
          portId: request.portId,
          typeId: source.typeId,
          currentModeId: source.modeId,
          modes: value.modes.map((m) => ({ modeId: `mode:${m.mode}`, name: m.name })),
        };
      }),
    setInputMode: (key, request, ctx) =>
      execute(key, ctx, async (record, bind) => {
        const catalog = record.catalog?.snapshot;
        if (!catalog || catalog.sourceRevision !== request.expectedSourceRevision)
          throw new Error("source-changed");
        const source = catalog.channels.find(
          (c) => c.kind === "input" && c.portId === request.portId,
        );
        if (!source) throw new Error("source-changed");
        const before = await bind("preflight").readMonitor(ctx.cancellation);
        ctx.assertContinuation("mode-write");
        if (!before || before.program.status !== "stopped")
          throw new Error("preflight-program-running");
        const current = record.catalog!.accept(before);
        if (current.sourceRevision !== catalog.sourceRevision) throw new Error("source-changed");
        const reading = await bind("mode-write").setInputMode(
          Number(request.portId.split(":")[1]),
          Number(source.typeId.split(":")[1]),
          Number(request.modeId.split(":")[1]),
          ctx.cancellation,
        );
        const frame = record.catalog!.frame(reading);
        return {
          sources: record.catalog!.snapshot,
          snapshot: {
            sessionId: catalog.sessionId,
            revision: frame.sourceRevision,
            status: "fresh",
            ageMs: 0,
            frame,
          },
        };
      }),
    executeFiniteMotion: (key, motion, ctx) =>
      execute(key, ctx, async (record, bind) => {
        const actuator = record.catalog?.snapshot.actuators.find(
          (a) => a.actuatorId === motion.actuatorId,
        );
        if (!actuator) throw new Error("motor-unavailable");
        return record.motion.execute(Number(actuator.portId.split(":")[1]), motion, ctx, bind);
      }),
    async stopAndReadback(key, target, ctx) {
      try {
        const record = requireRecord(key, ctx);
        const value = await record.motion.stop(
          target,
          ctx,
          (step) => cleanupBind(record, ctx, step),
          (port) => {
            const id = record.catalog?.snapshot.actuators.find(
              (a) => a.portId === `output:${port}`,
            )?.actuatorId;
            if (!id) throw new Error("provider-contract");
            return id;
          },
        );
        return {
          value,
          dispatch: "sent",
          stopConfirmation: isIdle(value) ? "confirmed" : "unconfirmed",
          error: isIdle(value)
            ? null
            : { reason: "readback-failed", message: "All outputs were not observed idle." },
        };
      } catch (error) {
        return {
          value: null,
          dispatch: "unknown",
          stopConfirmation: "unconfirmed",
          error: {
            reason: reason(error) === "stop-deadline" ? "stop-deadline" : "readback-failed",
            message: "EV3 stop remains unconfirmed.",
          },
        };
      }
    },
    observeIdle: (key, ctx) =>
      execute(key, ctx, async (record, bind) => {
        const reading = await bind("readback").readMotorTest(ctx.cancellation);
        return {
          programStopped: reading.programStopped,
          observedAt: reading.sampledAt,
          outputs: reading.outputs.map((o) => {
            const actuatorId = record.catalog?.snapshot.actuators.find(
              (a) => a.portId === `output:${o.port}`,
            )?.actuatorId;
            if (!actuatorId) throw new Error("provider-contract");
            return {
              actuatorId,
              known: [7, 8, 126].includes(o.type) && o.speed !== null,
              busy: o.busy,
              speed: o.speed,
            };
          }),
        };
      }),
    legacy: (key, request, ctx) =>
      execute(key, ctx, (_record, bind) => executeLegacy(bind, request, ctx.cancellation)),
    onDisconnect(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    releaseOperation(id) {
      for (const record of records.values()) record.motion.release(id);
    },
    async dispose(ctx) {
      for (const [key, record] of records) {
        ctx.assertCleanup("disconnect");
        await ctx.exchange("disconnect", () => record.raw.disconnect());
        record.removeListener();
        records.delete(key);
      }
      listeners.clear();
    },
  };
}
