import { describe, expect, it, vi } from "vitest";
import { CursorStore, Documents, type DocumentBuffer } from "./documents.js";

function harness() {
  const documents = new Documents();
  documents.replace([{ file: "main.bp", content: "saved", saved: "saved" }]);
  let text = "saved",
    version = 1,
    alternative = 1;
  const buffer: DocumentBuffer = {
    getValue: vi.fn(() => text),
    getValueLength: () => text.length,
    getVersionId: () => version,
    getAlternativeVersionId: () => alternative,
    setValue: vi.fn((value) => {
      text = value;
      alternative = ++version;
    }),
  };
  documents.bind("main.bp", buffer);
  vi.mocked(buffer.getValue).mockClear();
  const metadata = vi.fn(),
    change = vi.fn();
  documents.subscribe(metadata);
  documents.onChange(change);
  const edit = (value: string, undoVersion?: number, notify = true) => {
    text = value;
    version++;
    alternative = undoVersion ?? version;
    if (notify) documents.changed("main.bp");
  };
  return { documents, buffer, metadata, change, edit };
}

describe("document buffers independent of React", () => {
  it("publishes only the dirty transition and reads large text lazily once per version", () => {
    const { documents, buffer, metadata, change, edit } = harness();
    const paths = documents.getOpenFiles();
    const reader = documents.reader("main.bp");
    edit("saved1");
    const snapshot = documents.getSnapshot();
    for (let i = 0; i < 100; i++) edit("saved" + "x".repeat(i + 2));
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(101);
    expect(documents.getSnapshot()).toBe(snapshot);
    expect(documents.getOpenFiles()).toBe(paths);
    expect(buffer.getValue).not.toHaveBeenCalled();
    expect(reader()).toBe("saved" + "x".repeat(101));
    expect(snapshot[0]!.content).toBe(reader());
    expect(buffer.getValue).toHaveBeenCalledTimes(1);
    expect(buffer.setValue).not.toHaveBeenCalled();
  });

  it("tracks same-length changes, clean undo and manual saves without replacing the model", () => {
    const { documents, buffer, edit } = harness();
    edit("other");
    expect(documents.getSnapshot()[0]!.dirty).toBe(true);
    edit("saved", 1);
    expect(documents.getSnapshot()[0]!.dirty).toBe(false);
    edit("new value");
    documents.replace([{ file: "main.bp", content: "new value", saved: "new value" }]);
    expect(documents.getSnapshot()[0]!.dirty).toBe(false);
    edit("new value!");
    edit("new value", 4);
    expect(documents.getSnapshot()[0]!.dirty).toBe(false);
    expect(buffer.setValue).not.toHaveBeenCalled();
  });

  it("detects bulk edits already applied to a model and synchronizes external content once", () => {
    const { documents, buffer, edit, change } = harness();
    const revision = documents.revision;
    edit("renamed", undefined, false);
    documents.replace([{ file: "main.bp", content: "renamed", saved: "saved" }]);
    expect(documents.revision).toBeGreaterThan(revision);
    expect(change).toHaveBeenCalledTimes(1);
    expect(buffer.setValue).not.toHaveBeenCalled();
    documents.replace([{ file: "main.bp", content: "external", saved: "external" }]);
    expect(buffer.setValue).toHaveBeenCalledExactlyOnceWith("external");
    expect(documents.getSnapshot()[0]!.dirty).toBe(false);
  });

  it("retains pending draft text after removal and explicitly rebinds renamed paths", () => {
    const { documents, buffer, edit } = harness();
    const reader = documents.reader("main.bp");
    edit("latest draft");
    documents.unbind("main.bp");
    documents.replace(documents.getSnapshot().map((tab) => ({ ...tab, file: "renamed.bp" })));
    documents.bind("renamed.bp", buffer);
    expect(documents.reader("renamed.bp")()).toBe("latest draft");
    expect(documents.getOpenFiles()).toEqual(["renamed.bp"]);
    documents.replace([]);
    expect(reader()).toBe("latest draft");
    expect(buffer.setValue).not.toHaveBeenCalled();
  });

  it("publishes cursor changes separately and ignores repeated positions", () => {
    const cursor = new CursorStore(),
      listener = vi.fn();
    cursor.subscribe(listener);
    cursor.update({ line: 2, column: 3 });
    const snapshot = cursor.getSnapshot();
    cursor.update({ line: 2, column: 3 });
    expect(cursor.getSnapshot()).toBe(snapshot);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

it("keeps pinned tabs first and preserves pin state when callers omit it", () => {
  const documents = new Documents();
  documents.replace([
    { file: "a.bp", content: "", saved: "" },
    { file: "b.bp", content: "", saved: "" },
    { file: "c.bp", content: "", saved: "" },
  ]);
  documents.replace(
    documents.getSnapshot().map((tab) => (tab.file === "c.bp" ? { ...tab, pinned: true } : tab)),
  );
  expect(documents.getOpenFiles()).toEqual(["c.bp", "a.bp", "b.bp"]);
  expect(documents.getPinnedFiles()).toEqual(["c.bp"]);
  // A rename or content update without `pinned` keeps the tab pinned.
  documents.replace([
    { file: "c.bp", content: "x", saved: "" },
    { file: "a.bp", content: "", saved: "" },
    { file: "b.bp", content: "", saved: "" },
  ]);
  expect(documents.getSnapshot()[0]).toMatchObject({ file: "c.bp", pinned: true, dirty: true });
  // Moving an unpinned tab ahead of a pinned one is clamped to its own group.
  documents.replace([
    { file: "b.bp", content: "", saved: "" },
    ...documents.getSnapshot().filter((tab) => tab.file !== "b.bp"),
  ]);
  expect(documents.getOpenFiles()).toEqual(["c.bp", "b.bp", "a.bp"]);
  documents.replace(documents.getSnapshot().map((tab) => ({ ...tab, pinned: false })));
  expect(documents.getPinnedFiles()).toEqual([]);
});
