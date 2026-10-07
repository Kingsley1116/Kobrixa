import { expect, it } from "vitest";
import { ChatDraftStore } from "./chat-drafts.js";
it("persists retry IDs across restarts and does not clear text typed during sending", () => {
  const data = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  });
  const first = new ChatDraftStore(storage);
  first.set("room", "hello");
  const id = first.prepare("room", "hello");
  const restarted = new ChatDraftStore(storage);
  expect(restarted.get("room").text).toBe("hello");
  expect(restarted.prepare("room", "hello")).toBe(id);
  restarted.set("room", "next message");
  restarted.sent("room", "hello", id);
  expect(restarted.get("room").text).toBe("next message");
  const next = restarted.prepare("room", "next message");
  expect(next).not.toBe(id);
  restarted.sent("room", "next message", next);
  expect(data.size).toBe(0);
});
it("retains draft text and blocks exit when persistence fails", () => {
  let fail = true;
  const data = new Map<string, string>();
  const drafts = new ChatDraftStore(() => ({
    getItem: () => null,
    setItem: (key, value) => {
      if (fail) throw new Error("Disk unavailable");
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  }));
  expect(() => drafts.set("room", "keep me")).toThrow("Disk unavailable");
  expect(drafts.get("room").text).toBe("keep me");
  expect(() => drafts.flush()).toThrow("Disk unavailable");
  fail = false;
  drafts.flush();
  expect(JSON.parse(data.get("room")!).text).toBe("keep me");
});
