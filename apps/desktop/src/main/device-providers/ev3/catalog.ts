import { createHash } from "node:crypto";
import type { DeviceDescriptor, DeviceMonitorSnapshot } from "@kobrixa/device";
import type { PhysicalIdentity } from "@kobrixa/plugin-runtime";
import type { Handle, SourceCatalog, TelemetryFrame } from "@kobrixa/plugin-protocol";
import type { ProviderCatalogPort } from "../../device-broker/provider.js";
export const EV3_PROVIDER_ID = "kobrixa.device-ev3";
export function physicalIdentity(descriptor: DeviceDescriptor): PhysicalIdentity {
  const serial = descriptor.serialNumber?.trim();
  const basis = serial
    ? "serial"
    : descriptor.address || descriptor.metadata?.path
      ? "endpoint"
      : "unknown";
  const identity = serial || descriptor.address || descriptor.metadata?.path;
  const hash = createHash("sha256");
  for (const value of [EV3_PROVIDER_ID, "ev3", basis, identity ?? ""]) {
    const bytes = Buffer.from(value, "utf8"),
      length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return {
    providerId: EV3_PROVIDER_ID,
    family: "ev3",
    basis,
    strength: serial ? "stable" : "session-only",
    digest: basis === "unknown" ? null : hash.digest("hex"),
  };
}
export class Ev3Catalog {
  private signature = "";
  private value: SourceCatalog;
  constructor(
    private port: ProviderCatalogPort,
    private sessionId: Handle,
  ) {
    this.value = { sessionId, sourceRevision: 0, channels: [], actuators: [] };
  }
  get snapshot(): SourceCatalog {
    return structuredClone(this.value);
  }
  accept(reading: DeviceMonitorSnapshot): SourceCatalog {
    if (
      reading.inputs.length > 4 ||
      reading.outputs.length !== 4 ||
      reading.inputs.some((p) => p.values.length > 8)
    )
      throw new Error("provider-contract");
    const channels: SourceCatalog["channels"] = [],
      actuators: SourceCatalog["actuators"] = [];
    const add = (item: Omit<SourceCatalog["channels"][number], "channelId">) =>
      channels.push({
        ...item,
        channelId: this.port.identify({
          sessionId: this.sessionId,
          portId: item.portId,
          typeId: item.typeId,
          modeId: item.modeId,
          component: item.component,
          unit: item.unit,
        }),
      });
    for (const p of reading.inputs)
      for (let component = 0; component < p.values.length; component++)
        add({
          kind: "input",
          portId: `input:${p.port}`,
          typeId: `ev3:${p.type}`,
          modeId: p.mode >= 0 && p.mode < 8 ? `mode:${p.mode}` : null,
          component,
          name: p.name || `Input ${p.port + 1}`,
          modeName: p.modeName,
          unit: p.unit,
          decimals: p.decimals,
          state: p.state,
        });
    for (const p of reading.outputs) {
      const portId = `output:${p.port}`,
        typeId = `ev3:${p.type}`;
      add({
        kind: "output-angle",
        portId,
        typeId,
        modeId: null,
        component: 0,
        name: p.name || `Motor ${p.port}`,
        modeName: "",
        unit: "deg",
        decimals: 0,
        state: p.state,
      });
      actuators.push({
        actuatorId: this.port.identify({
          sessionId: this.sessionId,
          portId,
          typeId,
          modeId: null,
          component: 0,
          unit: "actuator",
        }),
        portId,
        typeId,
        name: p.name || `Motor ${p.port}`,
        state: p.state,
      });
    }
    add({
      kind: "battery-percent",
      portId: null,
      typeId: "ev3:battery-percent",
      modeId: null,
      component: 0,
      name: "Battery",
      modeName: "",
      unit: "%",
      decimals: 0,
      state: "ready",
    });
    add({
      kind: "battery-voltage",
      portId: null,
      typeId: "ev3:battery-voltage",
      modeId: null,
      component: 0,
      name: "Battery voltage",
      modeName: "",
      unit: "V",
      decimals: 2,
      state: "ready",
    });
    const signature = JSON.stringify({ channels, actuators });
    if (signature !== this.signature) {
      this.signature = signature;
      this.value = {
        sessionId: this.sessionId,
        sourceRevision: this.value.sourceRevision + 1,
        channels,
        actuators,
      };
    }
    return this.snapshot;
  }
  frame(reading: DeviceMonitorSnapshot): TelemetryFrame {
    const sources = this.accept(reading);
    return {
      sequence: 0,
      sampledAt: 0,
      elapsedMs: 0,
      sourceRevision: sources.sourceRevision,
      status: "ok",
      program: reading.program.status,
      values: sources.channels.map((c) => {
        const port = Number(c.portId?.split(":")[1]);
        const value =
          c.kind === "input"
            ? reading.inputs.find((p) => p.port === port)?.values[c.component]
            : c.kind === "output-angle"
              ? reading.outputs.find((p) => p.port === port)?.angle
              : c.kind === "battery-percent"
                ? reading.battery.percent
                : reading.battery.voltage;
        return {
          channelId: c.channelId,
          value: typeof value === "number" && Number.isFinite(value) ? value : null,
        };
      }),
    };
  }
}
