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
