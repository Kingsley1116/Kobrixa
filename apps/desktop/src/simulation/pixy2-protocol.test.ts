import { describe, expect, it } from "vitest";
import type { Pixy2Block } from "../shared/simulator.js";
import { Pixy2Protocol } from "./pixy2-protocol.js";

const blocks: Pixy2Block[] = [
  { signature: 2, x: 201, y: 181, width: 21, height: 31 },
  { signature: 1, x: 120, y: 100, width: 15, height: 24 },
  { signature: 2, x: 240, y: 190, width: 10, height: 20 },
];

describe("Pixy2 LEGO CCC register protocol", () => {
  it("returns the largest visible block and per-signature counts in unsigned wire order", () => {
    const camera = new Pixy2Protocol();
    expect(camera.exchange([0x50], 6, blocks)).toEqual([2, 0, 201, 181, 21, 31]);
    expect(camera.exchange([0x52], 5, blocks)).toEqual([2, 201, 181, 21, 31]);
    expect(camera.exchange([0x51], 5, blocks)).toEqual([1, 120, 100, 15, 24]);
    expect(camera.exchange([0x57], 5, blocks)).toEqual([0, 0, 0, 0, 0]);
    expect(camera.exchange([0x42], 1, blocks)).toEqual([201]);
    expect(camera.exchange([0x60], 1, blocks)).toEqual([0]);
  });

  it("returns zero fields for absent targets and allows reply prefixes", () => {
    const camera = new Pixy2Protocol();
    expect(camera.exchange([0x50], 6, [])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(camera.exchange([0x52], 5, [])).toEqual([0, 0, 0, 0, 0]);
    expect(camera.exchange([0x42], 1, [])).toEqual([0]);
    expect(camera.exchange([0x52], 2, blocks)).toEqual([2, 201]);
    const reply = camera.exchange([0x50], 6, blocks);
    reply[2] = 0;
    expect(camera.exchange([0x50], 3, blocks)).toEqual([2, 0, 201]);
  });

  it("provides the manufacturer LEGO identification strings including their terminators", () => {
    const camera = new Pixy2Protocol();
    expect(camera.exchange([0], 5, [])).toEqual([86, 48, 46, 52, 0]);
    for (const register of [8, 16])
      expect(camera.exchange([register], 6, [])).toEqual([80, 105, 120, 121, 50, 0]);
    expect(camera.exchange([8], 1, [])).toEqual([80]);
  });

  it("keeps lamp commands local and leaves state intact after malformed requests", () => {
    const first = new Pixy2Protocol();
    const second = new Pixy2Protocol();
    expect(first.lamp).toBe(false);
    expect(first.exchange([0x62, 255], 1, [])).toEqual([1]);
    expect(first.lamp).toBe(true);
    expect(second.lamp).toBe(false);
    expect(() => first.exchange([0x62, 0], 2, [])).toThrow("returns one byte");
    expect(first.lamp).toBe(true);
    expect(first.exchange([0x62, 0], 0, [])).toEqual([]);
    expect(first.lamp).toBe(false);
    expect(new Pixy2Protocol().lamp).toBe(false);
  });

  it("rejects unsupported protocols, surplus bytes, invalid lengths and read-only writes", () => {
    const camera = new Pixy2Protocol();
    for (const register of [0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0xae, 0xaf, 0xff])
      expect(() => camera.exchange([register], 1, blocks)).toThrow("unavailable");
    for (const request of [[], [-1], [256], [NaN], [0.5], Array<number>(32).fill(0)])
      expect(() => camera.exchange(request, 1, blocks)).toThrow("unsigned bytes");
    for (const count of [-1, 33, NaN, 1.5])
      expect(() => camera.exchange([0x50], count, blocks)).toThrow("read length");
    expect(() => camera.exchange([0x50], 7, blocks)).toThrow("returns 6 bytes");
    expect(() => camera.exchange([0x52], 6, blocks)).toThrow("returns 5 bytes");
    expect(() => camera.exchange([8], 32, blocks)).toThrow("returns 6 bytes");
    expect(() => camera.exchange([0x50, 1], 6, blocks)).toThrow("read-only");
    expect(() => camera.exchange([0x50], 0, blocks)).toThrow("read-only");
    expect(() => camera.exchange([0x62], 1, blocks)).toThrow("requires one data byte");
  });
});
