import { describe, expect, it } from "vitest";
import {
  DeviceOperationError,
  MockTransport,
  frameMessage,
  normalizeRemotePath,
  parseFrame,
  trimHidReply,
} from "./index.js";

describe("device protocol", () => {
  it("round-trips framed payloads", () => {
    const parsed = parseFrame(frameMessage(42, Uint8Array.from([1, 2, 3])));
    expect(parsed.counter).toBe(42);
    expect([...parsed.payload]).toEqual([1, 2, 3]);
  });

  it("rejects remote traversal before I/O", () => {
    expect(() => normalizeRemotePath("../bad.rbf")).toThrow(DeviceOperationError);
  });

  it("trims HID report padding and an optional report ID", () => {
    const padded = Uint8Array.from([3, 0, 42, 0, 2, 0, 0, 0]);
    const withReportId = Uint8Array.from([0, ...padded]);
    expect([...trimHidReply(padded)]).toEqual([3, 0, 42, 0, 2]);
    expect([...trimHidReply(withReportId)]).toEqual([3, 0, 42, 0, 2]);
  });

  it("supports upload over a deterministic mock", async () => {
    const commands: number[] = [];
    const transport = new MockTransport((payload) => {
      commands.push(payload[1]!);
      return payload[1] === 0x92
        ? Uint8Array.from([0x03, 0x92, 0x00, 7])
        : Uint8Array.from([0x03, payload[1]!, 0x08]);
    });
    const session = await transport.connect(transport.descriptor, new AbortController().signal);
    await session.upload(
      "/home/root/lms2012/prjs/demo/main.rbf",
      Uint8Array.from([1, 2]),
      new AbortController().signal,
    );
    expect(commands).toEqual([0x92, 0x93]);
  });

  it("rejects an end-of-file reply before the final upload chunk", async () => {
    const transport = new MockTransport((payload) =>
      payload[1] === 0x92
        ? Uint8Array.from([0x03, 0x92, 0x00, 7])
        : Uint8Array.from([0x03, payload[1]!, 0x08]),
    );
    const session = await transport.connect(transport.descriptor, new AbortController().signal);
    await expect(
      session.upload(
        "/home/root/lms2012/prjs/demo/main.rbf",
        new Uint8Array(901),
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unexpected end of file.");
  });

  it("reports rejection of a program control command", async () => {
    const commands: Uint8Array[] = [];
    const transport = new MockTransport((payload) => {
      commands.push(payload);
      return Uint8Array.from([0x04]);
    });
    const session = await transport.connect(transport.descriptor, new AbortController().signal);
    await expect(
      session.run("/home/root/lms2012/prjs/demo/main.rbf", new AbortController().signal),
    ).rejects.toMatchObject({ category: "device" });
    expect(commands).toHaveLength(1);
    expect(commands[0]![0]).toBe(0);
  });
});
