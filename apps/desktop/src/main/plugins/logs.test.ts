import { describe, expect, it } from "vitest";
import { cleanLogLine, NOTICE_SOURCE_LIMIT, PluginLogs, PluginNotices } from "./logs.js";

const texts = (read: { lines: { text: string }[] }) => read.lines.map((line) => line.text);

describe("cleanLogLine", () => {
  it("strips ANSI sequences and control characters but keeps tabs and text", () => {
    expect(cleanLogLine("\u001b[31mred\u001b[0m\tok\u0007\u0000")).toEqual(["red\tok"]);
    expect(cleanLogLine("\u001b]0;title\u0007after")).toEqual(["after"]);
    expect(cleanLogLine("\u009b1mbold")).toEqual(["bold"]);
    expect(cleanLogLine("世界 \u007f")).toEqual(["世界 "]);
  });
  it("turns an inline carriage return into a new line but ignores a CRLF ending", () => {
    expect(cleanLogLine("10%\r20%")).toEqual(["10%", "20%"]);
    expect(cleanLogLine("done\r")).toEqual(["done"]);
  });
});

describe("PluginLogs", () => {
  it("reads lines after a cursor", () => {
    const logs = new PluginLogs();
    logs.append("dev:a", "one");
    logs.append("dev:a", "two\rthree");
    const first = logs.read("dev:a", 0);
    expect(texts(first)).toEqual(["one", "two", "three"]);
    expect(first.truncated).toBe(false);
    logs.append("dev:a", "four");
    const second = logs.read("dev:a", first.next);
    expect(texts(second)).toEqual(["four"]);
    expect(logs.read("dev:a", second.next)).toEqual({
      lines: [],
      next: second.next,
      truncated: false,
    });
    expect(logs.read("dev:missing", 0)).toEqual({ lines: [], next: 0, truncated: false });
  });
  it("drops the oldest lines of one source, reports the gap and reads in batches", () => {
    // Each "line-N" costs 7 bytes: 6 characters and a newline.
    const logs = new PluginLogs({ source: 40, total: 1000, read: 20 });
    for (let index = 0; index < 10; index++) logs.append("dev:a", `line-${index}`);
    const first = logs.read("dev:a", 0);
    expect(first.truncated).toBe(true);
    expect(texts(first)).toEqual(["line-5", "line-6"]);
    const second = logs.read("dev:a", first.next);
    expect(second.truncated).toBe(false);
    expect(texts(second)).toEqual(["line-7", "line-8"]);
  });
  it("evicts the oldest line across sources at the global limit", () => {
    // Each "x-lineN" costs 8 bytes.
    const logs = new PluginLogs({ source: 40, total: 60, read: 1000 });
    for (let index = 0; index < 5; index++) logs.append("dev:a", `a-line${index}`);
    for (let index = 0; index < 3; index++) logs.append("dev:b", `b-line${index}`);
    expect(logs.read("dev:a", 0).truncated).toBe(true);
    expect(texts(logs.read("dev:a", 0))).toEqual(["a-line1", "a-line2", "a-line3", "a-line4"]);
    expect(logs.read("dev:b", 0)).toMatchObject({ truncated: false });
    expect(texts(logs.read("dev:b", 0))).toEqual(["b-line0", "b-line1", "b-line2"]);
  });
  it("drops a single line larger than the source limit", () => {
    const logs = new PluginLogs({ source: 40, total: 60, read: 1000 });
    logs.append("dev:a", "x".repeat(100));
    expect(logs.read("dev:a", 0)).toEqual({ lines: [], next: 1, truncated: true });
    logs.append("dev:a", "ok");
    expect(texts(logs.read("dev:a", 0))).toEqual(["ok"]);
  });
  it("frees a cleared source's share of the global limit", () => {
    const logs = new PluginLogs({ source: 40, total: 60, read: 1000 });
    for (let index = 0; index < 5; index++) logs.append("dev:a", `a-line${index}`);
    logs.clear("dev:a");
    expect(logs.read("dev:a", 0)).toEqual({ lines: [], next: 0, truncated: false });
    for (let index = 0; index < 5; index++) logs.append("dev:b", `b-line${index}`);
    expect(logs.read("dev:b", 0).truncated).toBe(false);
  });
});

describe("PluginNotices", () => {
  const notice = (sourceKey: string, message: string) => ({
    pluginId: "acme.a",
    sourceKey,
    severity: "info" as const,
    message,
    at: 0,
  });
  it("assigns increasing ids, keeps 100 per source and lists newest first", () => {
    const notices = new PluginNotices();
    for (let index = 0; index <= NOTICE_SOURCE_LIMIT; index++)
      notices.add(notice("dev:a", `a${index}`));
    const b = notices.add(notice("dev:b", "b"));
    expect(b).toEqual({ ...notice("dev:b", "b"), id: NOTICE_SOURCE_LIMIT + 2 });
    const listed = notices.list();
    expect(listed).toHaveLength(NOTICE_SOURCE_LIMIT + 1);
    expect(listed[0]).toEqual(b);
    expect(listed.at(-1)!.message).toBe("a1");
    notices.clear("dev:a");
    expect(notices.list().map((item) => item.message)).toEqual(["b"]);
  });
});
