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
