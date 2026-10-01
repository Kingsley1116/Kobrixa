import { expect, it } from "vitest";
import { applyCompletionUpdates } from "./completion-sync.js";

it("applies ordered UTF-16 events, simultaneous edits, CRLF and replacement atomically", () => {
  const original = new Map([["main.bp", { version: 1, text: "' 中文😀\r\nvalue = 1\r\n" }]]);
  const next = applyCompletionUpdates(original, [
    {
      kind: "edit",
      file: "main.bp",
      before: 1,
      version: 2,
      changes: [
        { offset: 16, length: 1, text: "22" },
        { offset: 8, length: 5, text: "count" },
      ],
    },
  ]);
  // Use a separate, unambiguous Unicode replacement to verify UTF-16 indexing.
  const unicode = applyCompletionUpdates(original, [
    {
      kind: "edit",
      file: "main.bp",
      before: 1,
      version: 2,
      changes: [{ offset: 4, length: 2, text: "X" }],
    },
  ]);
  expect(unicode?.get("main.bp")?.text).toBe("' 中文X\r\nvalue = 1\r\n");
  expect(next?.get("main.bp")).toEqual({ version: 2, text: "' 中文😀\r\ncount = 22\r\n" });
  expect(original.get("main.bp")?.version).toBe(1);
  expect(
    applyCompletionUpdates(original, [
      { kind: "remove", file: "main.bp" },
      { kind: "reset", file: "renamed.bp", document: { version: 1, text: "next = 2" } },
    ])?.has("main.bp"),
  ).toBe(false);
});

it("rejects stale or overlapping edits without modifying the previous mirror", () => {
  const previous = new Map([["main.bp", { version: 2, text: "abc" }]]);
  expect(
    applyCompletionUpdates(previous, [
      { kind: "edit", file: "main.bp", before: 1, version: 3, changes: [] },
    ]),
  ).toBeUndefined();
  expect(
    applyCompletionUpdates(previous, [
      {
        kind: "edit",
        file: "main.bp",
        before: 2,
        version: 3,
        changes: [
          { offset: 1, length: 2, text: "" },
          { offset: 0, length: 2, text: "" },
        ],
      },
    ]),
  ).toBeUndefined();
  expect(previous.get("main.bp")?.text).toBe("abc");
});
