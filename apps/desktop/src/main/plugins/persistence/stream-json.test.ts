import { describe, expect, it } from "vitest";
import { JsonFormatReader } from "./stream-json.js";

function read(bytes: Uint8Array, stride: number) {
  const reader = new JsonFormatReader("formatVersion");
  for (let i = 0; i < bytes.length; i += stride) reader.update(bytes.subarray(i, i + stride));
  return reader.finish();
}
describe("streamed formatVersion admission", () => {
  it("agrees with fatal UTF-8 decoding and JSON.parse across every token boundary", () => {
    const values = [
      '{"formatVersion":1,"p":"台灣😀"}',
      '\ufeff  {"formatVersion":false,"format\\u0056ersion":1.00e+0}',
      '{"formatVersion":1,"formatVersion":[2,{"formatVersion":1}]}',
      '{"formatVersion":{"formatVersion":1}}',
      '{"formatVersion":1.00000000000000001}',
      '{"formatVersion":1.' + "0".repeat(1800) + "1}",
      '{"formatVersion":10' + "0".repeat(1800) + "e-1801}",
      '{"formatVersionXXXX":1}',
      '{"x":["\\b\\t\\f\\n\\r\\/\\\\\\u0000",true,false,null,1e300]}',
      '{"formatVersion":1,"x":' + "[".repeat(2000) + "0" + "]".repeat(2000) + "}",
      '{"formatVersion":1,"text":"' + "x".repeat(2000) + '\\u0056"}',
    ];
    for (const text of values)
      for (const stride of [1, 7, 256]) {
        const bytes = Buffer.from(text);
        const raw = JSON.parse(new TextDecoder().decode(bytes)).formatVersion;
        expect(read(bytes, stride)).toEqual(typeof raw === "number" ? raw : undefined);
      }
  });
  it("rejects every truncated prefix of a versioned object", () => {
    const bytes = Buffer.from('{"formatVersion":1,"samples":["台灣😀",2.3e-4,null,true]}');
    for (let end = 0; end < bytes.length; end++)
      expect(() => read(bytes.subarray(0, end), 3)).toThrow();
  });
  it("rejects malformed structures, escapes, UTF-8 and numbers including failures after the version", () => {
    for (const tail of [
      '"unterminated',
      '"a\\u0x20"',
      '"a\\v"',
      '"\u0001"',
      "01",
      "1.",
      "1e+",
      "-",
      "[1,]",
      '{"a":0,}',
      "[}",
      "tru",
      "true false",
      "0} trailing",
    ]) {
      for (const size of [1, 8, 256])
        expect(() => read(Buffer.from('{"formatVersion":1,"late":' + tail + "}"), size)).toThrow();
    }
    const prefix = Buffer.from('{"formatVersion":1,"late":"');
    for (const bad of [
      [0xf0, 0x9f],
      [0xc0, 0xaf],
      [0xe0, 0x80, 0x80],
      [0xed, 0xa0, 0x80],
      [0xff],
    ]) {
      expect(() => read(Buffer.concat([prefix, Buffer.from(bad), Buffer.from('"}')]), 1)).toThrow();
    }
  });
});

it("agrees with JSON.parse for seeded byte mutations, splits and decimal exponents", () => {
  let seed = 0x16f7;
  function next(n: number) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 2 ** 32) * n);
  }
  const invalid = Symbol("invalid");
  const observe = (parse: () => unknown) => {
    try {
      return parse();
    } catch {
      return invalid;
    }
  };
  for (let i = 0; i < 2000; i++) {
    const bytes = Buffer.from(
      (i % 3 === 0 ? "\ufeff" : "") +
        '{"formatVersion":false,"format\\u0056ersion":-' +
        next(100000) +
        "." +
        next(100000) +
        "e" +
        (next(700) - 350) +
        ',"p":[0,1,2,true,false,null,"中😀\\u1234"]}',
    );
    if (i % 2) bytes[next(bytes.length)] = next(256);
    const expected = observe(() => {
      const value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      )?.formatVersion;
      return typeof value === "number" ? value : undefined;
    });
    for (const stride of [1, 2, 7, 1 + next(bytes.length)])
      expect(observe(() => read(bytes, stride))).toBe(expected);
  }
});

it("scans 32 numeric-array originals without per-scalar iterator steps", () => {
  const bytes = Buffer.from('{"formatVersion":1,"x":[' + "0,".repeat(2_000_000) + "0]}");
  expect(bytes.length).toBe(4_000_027);
  // Count nested generator dispatch directly. A machine-speed threshold would
  // also charge time spent waiting for unrelated test workers.
  const prototype = Object.getPrototypeOf(Object.getPrototypeOf((function* () {})()));
  const original = prototype.next;
  let steps = 0;
  prototype.next = function (...args: unknown[]) {
    if (++steps > 32 * 1024) throw new Error("scalar iterator step budget");
    return Reflect.apply(original, this, args);
  };
  try {
    for (let i = 0; i < 32; i++) expect(read(bytes, 262144)).toBe(1);
  } finally {
    prototype.next = original;
  }
});
