import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { DeviceMonitorSnapshot } from "@kobrixa/device";
import { Ev3Catalog, physicalIdentity } from "./catalog.js";
export const reading = (): DeviceMonitorSnapshot => ({
  sampledAt: 100,
  battery: { percent: 80, voltage: 7.5 },
  program: { status: "stopped", rawStatus: 64, result: 0 },
  inputs: Array.from({ length: 4 }, (_, port) => ({
    port,
    type: 29,
    connection: 122,
    mode: 0,
    state: "ready",
    name: "Touch",
    modeName: "Touch",
    unit: "raw",
    decimals: 0,
    values: Array.from({ length: 8 }, (_, n) => n),
    switchable: false,
  })),
  outputs: Array.from({ length: 4 }, (_, port) => ({
    port,
    type: 7,
    state: "ready",
    name: "Motor",
    angle: port,
  })),
});
it("F11 serial is length-prefixed, case-sensitive and endpoint never becomes stable", () => {
  const serial = physicalIdentity({
    id: "usb:a",
    name: "EV3",
    transport: "usb",
    serialNumber: " A ",
  });
  expect(serial).toEqual(
    physicalIdentity({ id: "different-path", name: "Other", transport: "usb", serialNumber: "A" }),
  );
  expect(serial.digest).not.toBe(
    physicalIdentity({ id: "usb:b", name: "EV3", transport: "usb", serialNumber: "a" }).digest,
  );
  expect(
    physicalIdentity({ id: "wifi:a", name: "EV3", transport: "wifi", address: "192.0.2.1" }),
  ).toMatchObject({ basis: "endpoint", strength: "session-only" });
});
it("F12 maximum catalog is 38 channels, four actuators and stable identities until metadata changes", () => {
  const ids = new Map<string, string>();
  const catalog = new Ev3Catalog(
    {
      connectionPolicy: () =>
        ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: true,
          usbRetryInterval: "backoff",
          usbRetryLimit: "unlimited",
        }) as const,
      identify(value) {
        const key = JSON.stringify(value);
        if (!ids.has(key)) ids.set(key, randomUUID());
        return ids.get(key)!;
      },
    },
    randomUUID(),
  );
  const first = catalog.accept(reading()),
    same = catalog.accept(reading());
  expect(first.channels).toHaveLength(38);
  expect(first.actuators).toHaveLength(4);
  expect(same).toEqual(first);
  const changed = reading();
  changed.inputs[0]!.unit = "new";
  const second = catalog.accept(changed);
  expect(second.sourceRevision).toBe(first.sourceRevision + 1);
  expect(second.channels[0]!.channelId).not.toBe(first.channels[0]!.channelId);
  expect(catalog.frame(changed).values).toHaveLength(38);
  expect(catalog.frame(reading())).toMatchObject({ sequence: 0, sampledAt: 0, elapsedMs: 0 });
  expect(catalog.frame(changed)).toMatchObject({ sequence: 0, sampledAt: 0, elapsedMs: 0 });
});

it.each(["ready", "empty", "initializing", "unknown", "error"] as const)(
  "preserves actual %s metadata for zero-value inputs with null observation slots",
  (state) => {
    const ids = new Map<string, string>();
    const catalog = new Ev3Catalog(
      {
        connectionPolicy: () => ({
          wifiConnectTimeoutMs: 5000,
          wifiHandshakeTimeoutMs: 3000,
          usbAutoReconnect: false,
          usbRetryInterval: 1000,
          usbRetryLimit: 3,
        }),
        identify(tuple) {
          const key = JSON.stringify(tuple);
          if (!ids.has(key)) ids.set(key, randomUUID());
          return ids.get(key)!;
        },
      },
      randomUUID(),
    );
    const observed = reading();
    for (const port of observed.inputs) {
      port.values = [];
      port.state = state;
    }
    const sources = catalog.accept(observed),
      frame = catalog.frame(observed);
    expect(sources.channels).toHaveLength(10);
    for (const port of observed.inputs) {
      const channels = sources.channels.filter((c) => c.portId === `input:${port.port}`);
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({
        component: 0,
        state,
        name: port.name,
        typeId: `ev3:${port.type}`,
      });
      expect(frame.values.find((v) => v.channelId === channels[0]!.channelId)?.value).toBeNull();
    }
    const slot = sources.channels[0]!;
    observed.inputs[0]!.values = [12];
    const numeric = catalog.accept(observed);
    expect(numeric.sourceRevision).toBe(sources.sourceRevision);
    expect(numeric.channels[0]!.channelId).toBe(slot.channelId);
    expect(catalog.frame(observed).values[0]!.value).toBe(12);
    observed.inputs[0]!.values = [1, 2, 3];
    expect(catalog.accept(observed).channels.filter((c) => c.portId === "input:0")).toHaveLength(3);
    observed.inputs[0]!.values = [];
    expect(catalog.accept(observed).channels.filter((c) => c.portId === "input:0")).toHaveLength(1);
    observed.inputs.splice(0, 1);
    expect(catalog.accept(observed).channels.some((c) => c.portId === "input:0")).toBe(false);
  },
);
