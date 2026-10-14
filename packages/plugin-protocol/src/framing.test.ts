import { describe, expect, it } from "vitest";
import { ContentLengthDecoder, encodeContentLength, FramingError } from "./index.js";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("Content-Length framing", () => {
  it("round-trips UTF-8 messages split across arbitrary chunks", () => {
    const frame = new Uint8Array([
      ...encodeContentLength('{"a":"插件😀"}'),
      ...encodeContentLength("{}"),
    ]);
    const decoder = new ContentLengthDecoder();
    const received: string[] = [];
    for (const byte of frame) received.push(...decoder.push(new Uint8Array([byte])));
    expect(received).toEqual(['{"a":"插件😀"}', "{}"]);
  });
  it("accepts extra headers and case-insensitive names", () => {
    const decoder = new ContentLengthDecoder();
    expect(decoder.push(bytes("content-length: 2\r\nContent-Type: x\r\n\r\n{}"))).toEqual(["{}"]);
  });
  it.each([
    ["missing length", "Content-Type: x\r\n\r\n{}", "PLUGIN_E_FRAME_HEADER"],
    ["non-header text", "hello from print()\r\n\r\n", "PLUGIN_E_FRAME_HEADER"],
    // A single print("debug") never sends "\r\n\r\n"; the first complete line must already fail.
    ["a lone debug line", "debug\n", "PLUGIN_E_FRAME_HEADER"],
    [
      "duplicate length",
      "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
      "PLUGIN_E_FRAME_HEADER",
    ],
    ["oversized body", `Content-Length: ${1024 * 1024 + 1}\r\n\r\n`, "PLUGIN_E_FRAME_SIZE"],
  ])("rejects %s", (_name, input, code) => {
    expect(() => new ContentLengthDecoder().push(bytes(input))).toThrowError(
      expect.objectContaining({ code }) as Error,
    );
  });
  it("rejects a header that never ends and invalid UTF-8", () => {
    expect(() => new ContentLengthDecoder().push(bytes("x".repeat(1025)))).toThrow(FramingError);
    const invalid = new Uint8Array([...bytes("Content-Length: 1\r\n\r\n"), 0xff]);
    expect(() => new ContentLengthDecoder().push(invalid)).toThrowError(
      expect.objectContaining({ code: "PLUGIN_E_FRAME_UTF8" }) as Error,
    );
  });
  it("refuses to encode oversized messages", () => {
    expect(() => encodeContentLength("x".repeat(1024 * 1024 + 1))).toThrow(FramingError);
  });
});
