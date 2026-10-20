import type { DeviceDescriptor, DeviceInputModes, DeviceMonitorSnapshot } from "@kobrixa/device";
import type {
  Counter,
  Handle,
  DeviceCandidate,
  ReadSnapshot,
  SourceCatalog,
  TelemetryFrame,
} from "@kobrixa/plugin-protocol";
import type { Principal } from "@kobrixa/plugin-runtime";
import type {
  CoreTelemetrySubscription,
  DeviceBrokerPort,
  DeviceMethod,
  DeviceParams,
  DeviceResult,
} from "./broker-port.js";
import type { DeviceEvent, MonitorResult } from "../../shared/api.js";
import { observeBrokerLifecycle, observeCoreTelemetryClosed } from "./broker.js";
export interface LegacyMonitorFeed {
  subscribe(input: {
    principal: Principal;
    sessionId: string;
    intervalMs: 500 | 30000;
    receive: (snapshot: ReadSnapshot, sources: SourceCatalog) => void;
    onClosed?: (reason: string) => void;
  }): Promise<() => Promise<void>>;
}
export interface LegacyDeviceDependencies {
  broker: DeviceBrokerPort;
  principal(): Principal;
  disconnect(sessionId: Handle): Promise<void>;
  stop(sessionId: Handle): Promise<void>;
  feed: LegacyMonitorFeed;
}
export function createLegacyDevice(deps: LegacyDeviceDependencies): LegacyDevice {
  return new LegacyDevice(deps);
}
export function createLegacyMonitorFeed(broker: DeviceBrokerPort): LegacyMonitorFeed {
  // Shared budget for all demands belonging to the same core identity.
  const bytesByOwner = new Map<string, number>();
  return {
    async subscribe(input) {
      const principal = structuredClone(input.principal);
      if (principal.kind !== "core") throw new Error("Core telemetry requires a core principal.");
      const ownerKey = JSON.stringify([
        principal.hostEpoch,
        principal.workbenchInstance,
        principal.adapter,
      ]);
      const catalog = await broker.request(
        principal,
        "devices/session",
        { sessionId: input.sessionId },
        new AbortController().signal,
      );
      if (!catalog.ok) throw new Error(catalog.error.message);
      type Queued = {
        sequence: Counter;
        snapshot: ReadSnapshot;
        sources: SourceCatalog;
        bytes: number;
      };
      const queue: Queued[] = [];
      let subscription: CoreTelemetrySubscription | undefined;
      let removeClosure = () => {};
      let closed = false,
        scheduled = false;
      let replacement: Promise<void> | undefined;
      let disposal: Promise<void> | undefined;
      const release = (bytes: number) => {
        const next = (bytesByOwner.get(ownerKey) ?? 0) - bytes;
        if (next > 0) bytesByOwner.set(ownerKey, next);
        else bytesByOwner.delete(ownerKey);
      };
      const dispose = (): Promise<void> => {
        closed = true;
        removeClosure();
        for (const value of queue.splice(0)) release(value.bytes);
        return (disposal ??= (async () => {
          await subscription?.dispose();
          await replacement;
        })());
      };
      const close = (reason: string) => {
        if (closed) return;
        void dispose().catch(() => {});
        try {
          input.onClosed?.(reason);
        } catch {
          /* Closure must still release the demand. */
        }
      };
      const drain = () => {
        scheduled = false;
        if (closed) return;
        const value = queue.shift();
        if (!value) return;
        release(value.bytes);
        try {
          input.receive(value.snapshot, value.sources);
        } catch {
          close("consumer-error");
          return;
        }
        if (queue.length) {
          scheduled = true;
          setImmediate(drain);
        }
      };
      const attach = async (sources: SourceCatalog, initial: boolean): Promise<void> => {
        let last = 0,
          registered = false;
        const revision = sources.sourceRevision;
        const demand = await broker.subscribeCoreTelemetry({
          principal,
          sessionId: input.sessionId,
          channelIds: sources.channels.map((channel) => channel.channelId),
          intervalMs: input.intervalMs,
          receive(value) {
            if (closed || !registered || subscription !== demand) return;
            if (
              !Number.isSafeInteger(value.sequence) ||
              value.sequence <= last ||
              value.snapshot.sessionId !== input.sessionId ||
              value.sources.sessionId !== input.sessionId
            ) {
              close("invalid-sequence");
              return;
            }
            const copy = structuredClone(value);
            const bytes = Buffer.byteLength(JSON.stringify(copy), "utf8");
            const used = bytesByOwner.get(ownerKey) ?? 0;
            if (bytes > 65536 || used + bytes > 262144 || queue.length >= 64) {
              close("overflow");
              return;
            }
            queue.push({ ...copy, bytes });
            bytesByOwner.set(ownerKey, used + bytes);
            last = value.sequence;
            demand.ack(value.sequence);
            if (!scheduled) {
              scheduled = true;
              setImmediate(drain);
            }
            if (value.sources.sourceRevision !== revision && !replacement) {
              const old = demand;
              subscription = undefined;
              removeClosure();
              replacement = (async () => {
                await old.dispose();
                if (!closed) await attach(value.sources, false);
              })()
                .catch(() => {
                  close("broker-ended");
                })
                .finally(() => {
                  replacement = undefined;
                });
            }
          },
        });
        registered = true;
        if (closed) {
          await demand.dispose();
          return;
        }
        subscription = demand;
        removeClosure = observeCoreTelemetryClosed(demand, () => close("broker-ended"));
        if (closed) return;
        try {
          if (initial) input.receive(demand.initial.snapshot, demand.initial.sources);
          demand.activate();
        } catch (error) {
          close("consumer-error");
          throw error;
        }
      };
      await attach(catalog.value.sources, true);
      return dispose;
    },
  };
}
export function monitorProjection(
  sources: SourceCatalog,
  frame: TelemetryFrame,
): DeviceMonitorSnapshot {
  const value = (id: string): number | null =>
    frame.status === "ok" ? (frame.values.find((v) => v.channelId === id)?.value ?? null) : null;
  const inputs: DeviceMonitorSnapshot["inputs"] = [],
    outputs: DeviceMonitorSnapshot["outputs"] = [];
  for (let port = 0; port < 4; port++) {
    const channels = sources.channels
      .filter((c) => c.kind === "input" && c.portId === `input:${port}`)
      .sort((a, b) => a.component - b.component);
    const first = channels[0];
    if (first)
      inputs.push({
        port,
        type: Number(first.typeId.split(":")[1]),
        connection: 122,
        mode: first.modeId ? Number(first.modeId.split(":")[1]) : -1,
        state: first.state,
        name: first.name,
        modeName: first.modeName,
        unit: first.unit,
        decimals: first.decimals,
        values: channels.map((c) => value(c.channelId)),
        switchable: first.state === "ready",
      });
    const output = sources.channels.find(
      (c) => c.kind === "output-angle" && c.portId === `output:${port}`,
    );
    if (output)
      outputs.push({
        port,
        type: Number(output.typeId.split(":")[1]),
        state: output.state,
        name: output.name,
        angle: value(output.channelId),
      });
  }
  const battery = (kind: "battery-percent" | "battery-voltage") => {
    const channel = sources.channels.find((c) => c.kind === kind);
    return channel ? value(channel.channelId) : null;
  };
  return {
    sampledAt: frame.sampledAt,
    battery: { percent: battery("battery-percent"), voltage: battery("battery-voltage") },
    program: {
      status: frame.program,
      rawStatus: frame.program === "stopped" ? 64 : frame.program === "running" ? 16 : 0,
      result: 0,
    },
    inputs,
    outputs,
  };
}
export class LegacyDevice {
  private candidates = new Map<string, DeviceCandidate>();
  private descriptors = new Map<string, DeviceDescriptor>();
  private lost = new Map<string, DeviceDescriptor>();
  private listeners = new Set<(event: DeviceEvent) => void>();
  constructor(readonly dependencies: LegacyDeviceDependencies) {
    observeBrokerLifecycle(dependencies.broker, (event) => {
      if (event.kind === "lost") {
        const id = event.session.sessionId;
        const descriptor = this.descriptors.get(id);
        if (!descriptor) return;
        this.descriptors.delete(id);
        this.lost.clear();
        this.lost.set(id, descriptor);
        if (descriptor.transport !== "usb")
          this.emit({
            type: "state",
            state: "disconnected",
            sessionId: id,
            message: event.message,
          });
        return;
      }
      const descriptor = this.lost.get(event.previousSessionId);
      if (!descriptor) return;
      if (event.state === "restored" && event.session) {
        const session = event.session;
        this.descriptors.set(session.sessionId, {
          id: session.sessionId,
          name: session.name,
          transport: session.transport,
        });
        this.emit({
          type: "usb-recovery",
          state: "restored",
          previousSessionId: event.previousSessionId,
          sessionId: session.sessionId,
          descriptor: this.descriptor(session.sessionId),
          deployment: "none",
        });
        this.lost.delete(event.previousSessionId);
      } else if (event.state !== "restored") {
        this.emit({
          type: "usb-recovery",
          state: event.state,
          previousSessionId: event.previousSessionId,
          descriptor,
        });
        if (event.state === "cancelled" || event.state === "exhausted")
          this.lost.delete(event.previousSessionId);
      }
    });
  }
  private emit(event: DeviceEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  subscribe(listener: (event: DeviceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  sessionIds(): string[] {
    return [...this.descriptors.keys()];
  }
  async request<M extends DeviceMethod>(
    method: M,
    params: DeviceParams<M>,
    signal = new AbortController().signal,
  ): Promise<Extract<DeviceResult<M>, { ok: true }>["value"]> {
    const result = await this.dependencies.broker.request(
      this.dependencies.principal(),
      method,
      params,
      signal,
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value as Extract<DeviceResult<M>, { ok: true }>["value"];
  }
  descriptor(id: string): DeviceDescriptor {
    const value = this.descriptors.get(id);
    if (!value) throw new Error("Unknown EV3 session.");
    return { ...value };
  }
  async discover(signal?: AbortSignal): Promise<DeviceDescriptor[]> {
    const result = await this.request(
      "devices/discover",
      { providerId: "kobrixa.device-ev3" },
      signal,
    );
    this.candidates.clear();
    return result.candidates.map((candidate) => {
      this.candidates.set(candidate.candidateId, candidate);
      return {
        id: candidate.candidateId,
        name: candidate.name,
        transport: candidate.transport,
        ...(candidate.address ? { address: candidate.address } : {}),
      };
    });
  }
  async connect(value: DeviceDescriptor, signal?: AbortSignal): Promise<string> {
    const candidate = this.candidates.get(value.id);
    if (!candidate || value.metadata || value.serialNumber)
      throw new Error("Rediscover this EV3 candidate.");
    const { session } = await this.request(
      "devices/connect",
      { target: { kind: "candidate", candidateId: candidate.candidateId } },
      signal,
    );
    this.descriptors.set(session.sessionId, {
      id: session.sessionId,
      name: session.name,
      transport: session.transport,
    });
    return session.sessionId;
  }
  async connectWifi(address: string, signal?: AbortSignal): Promise<string> {
    const { session } = await this.request(
      "devices/connect",
      { target: { kind: "wifi-address", providerId: "kobrixa.device-ev3", address } },
      signal,
    );
    this.descriptors.set(session.sessionId, {
      id: session.sessionId,
      name: session.name,
      transport: session.transport,
      address,
    });
    return session.sessionId;
  }
  async reconnectForRecovery(previousSessionId: Handle, signal: AbortSignal): Promise<Handle> {
    const result = await this.dependencies.broker.reconnectForRecovery({
      previousSessionId,
      signal,
    });
    if (!result.ok) throw new Error(result.error.message);
    const { session } = await this.request(
      "devices/session",
      { sessionId: result.value.sessionId },
      signal,
    );
    this.descriptors.delete(previousSessionId);
    this.descriptors.set(session.sessionId, {
      id: session.sessionId,
      name: session.name,
      transport: session.transport,
    });
    return session.sessionId;
  }
  async disconnect(id: string): Promise<void> {
    await this.dependencies.disconnect(id);
    this.descriptors.delete(id);
  }
  async reset(): Promise<void> {
    await Promise.allSettled(this.sessionIds().map((id) => this.disconnect(id)));
  }
  stop(id: string): Promise<void> {
    return this.dependencies.stop(id);
  }
  async monitor(id: string): Promise<MonitorResult<DeviceMonitorSnapshot>> {
    try {
      const { sources } = await this.request("devices/session", { sessionId: id });
      if (!sources.channels.length) return { status: "busy" };
      const snapshot = await this.request("devices/read", {
        sessionId: id,
        channelIds: sources.channels.map((c) => c.channelId),
        freshness: "fresh",
      });
      return snapshot.status === "fresh" && snapshot.frame
        ? { status: "ok", value: monitorProjection(sources, snapshot.frame) }
        : { status: "busy" };
    } catch (error) {
      return {
        status: "error",
        category: "device",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async inputModes(
    id: string,
    port: number,
    type: number,
  ): Promise<MonitorResult<DeviceInputModes>> {
    try {
      const { sources } = await this.request("devices/session", { sessionId: id });
      const source = sources.channels.find(
        (c) => c.portId === `input:${port}` && c.typeId === `ev3:${type}`,
      );
      if (!source) throw new Error("Sensor source changed.");
      const value = await this.request("devices/inputModes/query", {
        sessionId: id,
        portId: source.portId!,
        expectedSourceRevision: sources.sourceRevision,
      });
      return {
        status: "ok",
        value: {
          port,
          type,
          modes: value.modes.map((m) => ({ mode: Number(m.modeId.split(":")[1]), name: m.name })),
        },
      };
    } catch (error) {
      return {
        status: "error",
        category: "device",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  async setInputMode(
    id: string,
    port: number,
    type: number,
    mode: number,
  ): Promise<MonitorResult<DeviceMonitorSnapshot>> {
    try {
      const { sources } = await this.request("devices/session", { sessionId: id });
      const source = sources.channels.find(
        (c) => c.portId === `input:${port}` && c.typeId === `ev3:${type}`,
      );
      const context = this.dependencies.principal().authorityContext;
      if (!source || !context) throw new Error("Device authority unavailable.");
      const result = await this.request("devices/inputModes/set", {
        sessionId: id,
        portId: source.portId!,
        modeId: `mode:${mode}`,
        expectedSourceRevision: sources.sourceRevision,
        contextRef: context.ref,
      });
      if (!result.snapshot.frame) return { status: "busy" };
      return { status: "ok", value: monitorProjection(result.sources, result.snapshot.frame) };
    } catch (error) {
      return {
        status: "error",
        category: "device",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  watch(
    id: string,
    intervalMs: 500 | 30000,
    receive: Parameters<LegacyMonitorFeed["subscribe"]>[0]["receive"],
    onClosed?: (reason: string) => void,
  ): Promise<() => Promise<void>> {
    return this.dependencies.feed.subscribe({
      principal: this.dependencies.principal(),
      sessionId: id,
      intervalMs,
      receive,
      ...(onClosed ? { onClosed } : {}),
    });
  }
}
