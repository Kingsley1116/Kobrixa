import { describe, expect, it } from "vitest";
import { patchJumps } from "./jumps.js";

function readOffset(bytes: Uint8Array, at: number): { value: number; width: number } {
  const prefix = bytes[at]!;
  if (!(prefix & 0x80)) return { value: prefix & 0x20 ? prefix - 64 : prefix, width: 1 };
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  if (prefix === 0x81) return { value: view.getInt8(at + 1), width: 2 };
  if (prefix === 0x82) return { value: view.getInt16(at + 1, true), width: 3 };
  expect(prefix).toBe(0x83);
  return { value: view.getInt32(at + 1, true), width: 5 };
}

describe("jump relaxation", () => {
  it.each([
    [0, 1],
    [31, 1],
    [32, 2],
    [127, 2],
    [128, 3],
    [32767, 3],
    [32768, 5],
  ])("encodes forward distance %i in %i bytes", (distance, width) => {
    const original = [0x40, 0x83, 0, 0, 0, 0, ...Array<number>(distance).fill(1), 0x0a];
    const bytes = patchJumps(
      original,
      new Map([["end", original.length - 1]]),
      [{ at: 1, after: 6, target: "end" }],
      true,
      new AbortController().signal,
    );
    expect(readOffset(bytes, 1)).toEqual({ value: distance, width });
    expect(bytes.length).toBe(original.length - 5 + width);
    expect(bytes[1 + width + distance]).toBe(0x0a);
  });

  it.each([
    [0, 1],
    [30, 1],
    [31, 2],
    [125, 2],
    [126, 3],
    [32764, 3],
    [32765, 5],
  ])("includes its own shrinkage for a backwards jump after %i bytes", (padding, width) => {
    const original = [...Array<number>(padding).fill(1), 0x40, 0x83, 0, 0, 0, 0];
    const bytes = patchJumps(
      original,
      new Map([["start", 0]]),
      [{ at: padding + 1, after: original.length, target: "start" }],
      true,
      new AbortController().signal,
    );
    expect(readOffset(bytes, padding + 1)).toEqual({ value: -bytes.length, width });
  });

  it("revisits jumps after a neighbouring jump becomes shorter", () => {
    const original = [
      0x40,
      0x83,
      0,
      0,
      0,
      0,
      0x40,
      0x83,
      0,
      0,
      0,
      0,
      ...Array<number>(26).fill(1),
      0x0a,
    ];
    const bytes = patchJumps(
      original,
      new Map([["end", original.length - 1]]),
      [
        { at: 1, after: 6, target: "end" },
        { at: 7, after: 12, target: "end" },
      ],
      true,
      new AbortController().signal,
    );
    expect(readOffset(bytes, 1)).toEqual({ value: 28, width: 1 });
    expect(readOffset(bytes, 3)).toEqual({ value: 26, width: 1 });
    expect(bytes.length).toBe(original.length - 8);
  });

  it("retains fixed-width offsets when optimization is disabled", () => {
    expect(
      patchJumps(
        [0x40, 0x83, 0, 0, 0, 0, 0x0a],
        new Map([["start", 0]]),
        [{ at: 1, after: 6, target: "start" }],
        false,
        new AbortController().signal,
      ),
    ).toEqual(Uint8Array.from([0x40, 0x83, 250, 255, 255, 255, 0x0a]));
  });

  it("honours cancellation during relaxation", () => {
    expect(() => patchJumps([], new Map(), [], true, AbortSignal.abort())).toThrow();
  });
});
