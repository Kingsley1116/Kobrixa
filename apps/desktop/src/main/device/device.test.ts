import { describe, expect, it } from "vitest";
import type { DeviceDescriptor } from "@kobrixa/device";
import { deploymentTargets, mergeDiscoveryResults } from "./device.js";

const usb: DeviceDescriptor = {
  id: "usb:test",
  name: "EV3",
  transport: "usb",
};

describe("device discovery", () => {
  it("returns devices when another transport fails", () => {
    expect(
      mergeDiscoveryResults([
        { status: "fulfilled", value: [usb] },
        { status: "rejected", reason: new Error("Wi-Fi unavailable") },
      ]),
    ).toEqual([usb]);
  });

  it("surfaces a transport error when no device can be returned", () => {
    const failure = new Error("USB support is unavailable");
    expect(() =>
      mergeDiscoveryResults([
        { status: "rejected", reason: failure },
        { status: "fulfilled", value: [] },
      ]),
    ).toThrow(failure);
  });
});

describe("device deployment", () => {
  it("keeps assets ahead of the executable and rejects traversal", () => {
    expect(
      deploymentTargets(
        [
          { path: "/tmp/image", remotePath: "assets/image.rgf" },
          { path: "/tmp/demo", remotePath: "demo.rbf" },
        ],
        "/home/root/lms2012/prjs/demo",
      ),
    ).toEqual([
      { path: "/tmp/image", remotePath: "/home/root/lms2012/prjs/demo/assets/image.rgf" },
      { path: "/tmp/demo", remotePath: "/home/root/lms2012/prjs/demo/demo.rbf" },
    ]);
    expect(() =>
      deploymentTargets([{ path: "/tmp/bad", remotePath: "../bad.rgf" }], "/project"),
    ).toThrow("Unsafe asset deployment path");
  });
});
import { expectTypeOf } from "vitest";
import { renewFilePlan } from "./device.js";
import type { CorePrincipal } from "../device-broker/broker-port.js";
import type { FileBatchRef } from "../../shared/api.js";
it("AM-12 renewal is a synchronous core-principal operation on a retained plan", () => {
  expectTypeOf<typeof renewFilePlan>().toEqualTypeOf<
    (ref: FileBatchRef, owner: CorePrincipal) => void
  >();
  const owner: CorePrincipal = {
    kind: "core",
    adapter: "remote-files",
    hostEpoch: "host",
    workbenchInstance: "window",
    authorityContext: { ref: "context", epoch: "epoch" },
  };
  expect(() =>
    renewFilePlan({ sessionId: "session", requestId: "request", planId: "forged" }, owner),
  ).toThrow("Unknown or expired");
});

import { readFileSync as readStage3Source } from "node:fs";
it("F14 facade has no raw session, helper or transport ownership", () => {
  const source = readStage3Source(new URL("./device.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(
    /new (UsbTransport|WiFiTransport|EV3DeviceSession)|withMotorTest|createMotorTestImage|#sessions|#monitors/,
  );
  expect(source).toContain('"deployment"');
  expect(source).toContain('"program-launch"');
});

import { vi } from "vitest";
import { DeviceOperationError } from "@kobrixa/device";
import { DeviceService } from "./device.js";
import { DevicePreferencesStore } from "./preferences.js";
import { DEFAULT_DEVICE_PREFERENCES } from "../../shared/device-preferences.js";
import type { BuildService } from "../workspace/build.js";
import { LegacyDevice } from "../device-broker/legacy-device.js";
import { LegacyFiles } from "../device-broker/legacy-files.js";
import type { DeviceBrokerPort, LegacyOperation } from "../device-broker/broker-port.js";

function authoritativeFixture() {
  let value: typeof DEFAULT_DEVICE_PREFERENCES | undefined = {
    ...DEFAULT_DEVICE_PREFERENCES,
    skipUnchangedAssets: false,
  };
  const read = vi.fn(() => {
    if (!value) throw new Error("Device settings are not admitted.");
    return value;
  });
  const persist = vi.fn(async () => {});
  const old = new DevicePreferencesStore({ ...DEFAULT_DEVICE_PREFERENCES }, persist);
  const oldRead = vi.spyOn(old, "get");
  const owner: CorePrincipal = {
    kind: "core",
    adapter: "deployment",
    hostEpoch: "host",
    workbenchInstance: "window",
    authorityContext: { ref: "context", epoch: "epoch" },
  };
  const execute = vi.fn<LegacyOperation["execute"]>(async (request) => ({
    value:
      request.kind === "list"
        ? { kind: "entries", entries: [] }
        : { kind: "transfer", transferred: request.kind === "upload" ? request.size : 0 },
    dispatch: "sent",
    stopConfirmation: "not-required",
    error: null,
  }));
  const operation: LegacyOperation = {
    operationId: "original",
    execute,
    renewConfirmation() {},
    finish: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const disconnect = vi.fn(async () => {});
  const legacy = new LegacyDevice({
    broker: {} as DeviceBrokerPort,
    principal: () => owner,
    disconnect,
    stop: async () => {},
    feed: { subscribe: async () => async () => {} },
  });
  const builds = {
    deployableArtifacts: async () => [
      { path: "/asset", remotePath: "asset.rgf", role: "deploy-asset", bytes: Uint8Array.of(1) },
    ],
  } as unknown as BuildService;
  const service = new DeviceService(
    builds,
    () => undefined,
    old,
    {
      device: legacy,
      files: new LegacyFiles({ begin: async () => operation }, () => owner),
    },
    read,
  );
  return {
    service,
    old,
    oldRead,
    persist,
    execute,
    operation,
    disconnect,
    read,
    set: (next: typeof value) => {
      value = next;
    },
  };
}

it("E5 preserves the legacy preference fixture when no authoritative reader is attached", async () => {
  const old = new DevicePreferencesStore();
  const service = new DeviceService({} as BuildService, () => undefined, old);
  await service.setPreferences({ skipUnchangedAssets: false });
  expect(service.getPreferences().skipUnchangedAssets).toBe(false);
});

it("E5 reads current authoritative values and never falls back after withdrawal", () => {
  const f = authoritativeFixture();
  expect(f.service.getPreferences().skipUnchangedAssets).toBe(false);
  f.set({ ...DEFAULT_DEVICE_PREFERENCES, usbRetryLimit: 5 });
  expect(f.service.getPreferences().usbRetryLimit).toBe(5);
  f.set(undefined);
  expect(() => f.service.getPreferences()).toThrow(DeviceOperationError);
  expect(() => f.service.getPreferences()).toThrow("not admitted");
  expect(f.oldRead).not.toHaveBeenCalled();
});

it("E5 denies legacy preference IPC writes before and after readiness without touching the old writer", async () => {
  const f = authoritativeFixture();
  f.set(undefined);
  await expect(f.service.setPreferences({ usbAutoReconnect: false })).rejects.toMatchObject({
    name: "DeviceOperationError",
    category: "permission",
  });
  f.set({ ...DEFAULT_DEVICE_PREFERENCES });
  f.old.freezeAdmission();
  await expect(f.service.setPreferences({ usbAutoReconnect: false })).rejects.toMatchObject({
    name: "DeviceOperationError",
    category: "permission",
  });
  expect(f.persist).not.toHaveBeenCalled();
});

it.each([false, true])("E5 deploy uses authoritative skipUnchangedAssets=%s", async (skip) => {
  const f = authoritativeFixture();
  f.set({ ...DEFAULT_DEVICE_PREFERENCES, skipUnchangedAssets: skip });
  await f.service.deploy("session", "build", "/project");
  expect(f.execute.mock.calls.map(([request]) => request.kind)).toEqual(
    skip ? ["list", "upload"] : ["upload"],
  );
  expect(f.oldRead).not.toHaveBeenCalled();
});

it("E5 unavailable preferences abort deployment but do not gate original Disconnect cleanup", async () => {
  const f = authoritativeFixture();
  f.set(undefined);
  await expect(f.service.deploy("session", "build", "/project")).rejects.toThrow("not admitted");
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.operation.cancel).toHaveBeenCalledOnce();
  expect(f.operation.finish).toHaveBeenCalledOnce();
  expect(f.service.busy).toBe(false);
  f.read.mockClear();
  await f.service.disconnect("session");
  expect(f.disconnect).toHaveBeenCalledWith("session");
  expect(f.read).not.toHaveBeenCalled();
});
