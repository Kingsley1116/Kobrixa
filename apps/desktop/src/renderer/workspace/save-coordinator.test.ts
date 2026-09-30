import { describe, expect, it, vi } from "vitest";
import { FileWriteQueue, saveSnapshot } from "./save-coordinator.js";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("serialized source and draft writes", () => {
  it("serializes each file, permits independent files and waits for source/draft barriers", async () => {
    const queue = new FileWriteQueue(),
      gate = deferred(),
      events: string[] = [];
    const first = queue.enqueue("w", "a", async () => {
      events.push("source");
      await gate.promise;
    });
    const second = queue.enqueue("w", "a", async () => {
      events.push("draft");
    });
    await queue.enqueue("w", "b", async () => {
      events.push("other");
    });
    expect(events).toEqual(["source", "other"]);
    let idle = false;
    const barrier = queue.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.resolve();
    await Promise.all([first, second, barrier]);
    expect(events).toEqual(["source", "other", "draft"]);
  });
  it("recovers from a failed write without dropping the next draft", async () => {
    const queue = new FileWriteQueue();
    const first = queue.enqueue("w", "a", async () => {
      throw new Error("disk full");
    });
    const next = queue.enqueue("w", "a", async () => "draft");
    await expect(first).rejects.toThrow("disk full");
    await expect(next).resolves.toBe("draft");
    await queue.idle();
  });
});
describe("save snapshots", () => {
  it("keeps input arriving during a write dirty and retains its draft", async () => {
    const gate = deferred();
    let buffer = { content: "first", saved: "old" };
    let disk = "old";
    const retained = vi.fn(async () => undefined);
    const save = saveSnapshot({
      read: () => buffer,
      apply: vi.fn(),
      write: async (content) => {
        await gate.promise;
        disk = content;
      },
      commit: (content) => {
        buffer = { ...buffer, saved: content };
      },
      retainDraft: retained,
    });
    buffer = { ...buffer, content: "second" };
    gate.resolve();
    await save;
    expect(disk).toBe("first");
    expect(buffer).toEqual({ content: "second", saved: "first" });
    expect(retained).toHaveBeenCalledWith("second");
  });
  it("rejects stale asynchronous formatting without applying or writing", async () => {
    const gate = deferred();
    let content = "before";
    const write = vi.fn(),
      apply = vi.fn();
    const save = saveSnapshot({
      read: () => ({ content, saved: "" }),
      format: async () => {
        await gate.promise;
        return "formatted";
      },
      apply,
      write,
      commit: vi.fn(),
      retainDraft: vi.fn(),
    });
    content = "new input";
    gate.resolve();
    await expect(save).rejects.toThrow("Contents changed");
    expect(write).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("applies formatting before writing, but does not format automatic saves", async () => {
    let buffer = { content: "raw", saved: "" };
    const format = vi.fn(async () => "formatted"),
      write = vi.fn(async () => undefined);
    const options = {
      read: () => buffer,
      apply: (_before: string, after: string) => {
        buffer = { ...buffer, content: after };
      },
      write,
      commit: (saved: string) => {
        buffer = { ...buffer, saved };
      },
      retainDraft: vi.fn(async () => undefined),
    };
    await saveSnapshot({ ...options, format });
    expect(write).toHaveBeenCalledWith("formatted");
    expect(buffer).toEqual({ content: "formatted", saved: "formatted" });
    buffer = { ...buffer, content: "more input" };
    await saveSnapshot(options);
    expect(format).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith("more input");
  });
  it("preserves dirty state on source, formatting or draft-retention failure", async () => {
    for (const failure of ["format", "write", "retainDraft"] as const) {
      const commit = vi.fn();
      const fail = async () => {
        throw new Error(failure);
      };
      await expect(
        saveSnapshot({
          read: () => ({ content: "dirty", saved: "old" }),
          format: failure === "format" ? fail : undefined,
          apply: vi.fn(),
          write: failure === "write" ? fail : async () => undefined,
          retainDraft: failure === "retainDraft" ? fail : async () => undefined,
          commit,
        }),
      ).rejects.toThrow(failure);
      expect(commit).not.toHaveBeenCalled();
    }
  });
  it("preserves the newest recovery draft when a delayed source write fails", async () => {
    const gate = deferred();
    let content = "first snapshot";
    const retainDraft = vi.fn(async () => undefined),
      commit = vi.fn();
    const save = saveSnapshot({
      read: () => ({ content, saved: "old" }),
      apply: vi.fn(),
      write: async () => {
        await gate.promise;
        throw new Error("source is read-only");
      },
      commit,
      retainDraft,
    });
    content = "input during failed write";
    gate.resolve();
    await expect(save).rejects.toThrow("source is read-only");
    expect(retainDraft).toHaveBeenCalledWith("input during failed write");
    expect(commit).not.toHaveBeenCalled();
  });
});
