import { expect, it } from "vitest";
import { FileVersions } from "./file-versions.js";
const disk = (content: string | null) => ({ content, revision: content });

it("reloads a clean file but preserves local edits and the original save baseline", () => {
  const state = new FileVersions();
  state.accept("main.bp", disk("old"));
  expect(state.observe("main.bp", disk("external"), { content: "old", saved: "old" })).toBe(
    "reload",
  );
  expect(state.observe("main.bp", disk("next"), { content: "local", saved: "external" })).toBe(
    "conflict",
  );
  expect(state.baseline("main.bp")).toEqual(disk("external"));
  expect(state.known()).toEqual({ "main.bp": "next" });
  expect(state.observe("main.bp", disk("newer"), { content: "external", saved: "external" })).toBe(
    "conflict",
  );
  expect(state.conflicts.get("main.bp")).toEqual(disk("newer"));
});

it("requires explicit resolution for deletions, including an empty clean file", () => {
  const state = new FileVersions();
  state.accept("empty.bp", disk(""));
  expect(state.observe("empty.bp", disk(null), { content: "", saved: "" })).toBe("conflict");
  expect(state.baseline("empty.bp")?.revision).toBe("");
  state.accept("empty.bp", disk("recreated"));
  expect(state.conflicts.size).toBe(0);
});

it("keeps a clean buffer's baseline until review when automatic reload is disabled", () => {
  const state = new FileVersions();
  state.accept("main.bp", disk("old"));
  const local = { content: "old", saved: "old" };
  expect(state.observe("main.bp", disk("old"), local, false)).toBe("unchanged");
  expect(state.observe("main.bp", disk("external"), local, false)).toBe("conflict");
  expect(state.baseline("main.bp")).toEqual(disk("old"));
  expect(state.known()).toEqual({ "main.bp": "external" });
  // Re-enabling reload must not silently resolve an already surfaced review.
  expect(state.observe("main.bp", disk("next"), local, true)).toBe("conflict");
  state.accept("main.bp", disk("next"));
  expect(state.conflicts.size).toBe(0);
});

it("accepts an external save identical to current edits without changing text", () => {
  const state = new FileVersions();
  state.accept("main.bp", disk("old"));
  expect(state.observe("main.bp", disk("local"), { content: "local", saved: "old" })).toBe(
    "reload",
  );
});

it("recovers matching drafts normally and marks stale or legacy drafts for review", () => {
  const state = new FileVersions();
  state.recover("a.bp", disk("disk"), "draft", "disk");
  state.recover("b.bp", disk("new"), "draft", "old");
  state.recover("c.bp", disk("disk"), "legacy", undefined);
  state.recover("d.bp", disk(null), "", null);
  expect([...state.conflicts.keys()]).toEqual(["b.bp", "c.bp", "d.bp"]);
  expect(state.baseline("b.bp")?.revision).toBe("old");
});

it("invalidates pending refreshes on saves and keeps rename/forget state consistent", () => {
  const state = new FileVersions();
  state.accept("a.bp", disk("old"));
  const generation = state.generation;
  state.accept("a.bp", disk("saved"));
  expect(state.generation).not.toBe(generation);
  state.reject("a.bp", disk("external"));
  state.remap({ "a.bp": "b.bp" });
  expect(state.known()).toEqual({ "b.bp": "external" });
  expect(state.baseline("b.bp")).toEqual(disk("saved"));
  state.forget("b.bp");
  expect(state.known()).toEqual({});
  expect(state.conflicts.size).toBe(0);
});
