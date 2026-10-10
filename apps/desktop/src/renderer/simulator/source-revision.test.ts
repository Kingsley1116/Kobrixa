import { describe, expect, it } from "vitest";
import { trackSources } from "./source-revision.js";

const tab = (file: string, content: string, saved = content) => ({ file, content, saved });

describe("simulator source tracking", () => {
  it("ignores opening, reordering, saving and closing clean tabs", () => {
    let tracker = trackSources(undefined, [tab("src/a.bp", "a")]);
    expect(tracker.version).toBe(0);
    tracker = trackSources(tracker, [tab("README.md", "docs"), tab("src/a.bp", "a")]);
    tracker = trackSources(tracker, [tab("src/a.bp", "a"), tab("README.md", "docs")]);
    tracker = trackSources(tracker, [tab("src/a.bp", "a")]);
    expect(tracker.version).toBe(0);
    tracker = trackSources(tracker, [tab("src/a.bp", "b", "a")]);
    expect(tracker.version).toBe(1);
    // Saving changes only the baseline, not the compiled text.
    tracker = trackSources(tracker, [tab("src/a.bp", "b")]);
    expect(tracker.version).toBe(1);
  });

  it("counts edits, restored drafts and discarded edits, idempotently", () => {
    let tracker = trackSources(undefined, [tab("src/a.bp", "a")]);
    tracker = trackSources(tracker, [tab("src/a.bp", "a"), tab("src/b.bp", "draft", "disk")]);
    expect(tracker.version).toBe(1);
    const tabs = [tab("src/a.bp", "a2", "a"), tab("src/b.bp", "draft", "disk")];
    tracker = trackSources(tracker, tabs);
    expect(trackSources(tracker, tabs).version).toBe(tracker.version);
    expect(tracker.version).toBe(2);
    // Closing b without saving discards its draft, so disk text is compiled again.
    tracker = trackSources(tracker, [tab("src/a.bp", "a2", "a")]);
    expect(tracker.version).toBe(3);
  });
});
