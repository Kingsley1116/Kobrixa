import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceSummary } from "../../shared/api.js";
import {
  findSearchMatches,
  type WorkspaceSearchRequest,
  type WorkspaceSearchResult,
} from "../../shared/workspace-search.js";
import { Documents } from "../editor/documents.js";
import { SearchController } from "./search-controller.js";

const workspace = (id = "one"): WorkspaceSummary => ({
  id,
  name: id,
  rootLabel: id,
  files: ["main.bp", "closed.bpi", "kobrixa.json"],
  entries: [],
  implicit: true,
  entryCandidates: ["main.bp"],
  drafts: { "closed.bpi": "draft needle", "main.bp": "old draft" },
});
const result = (request: WorkspaceSearchRequest): WorkspaceSearchResult => {
  const content = request.overlays["main.bp"] ?? "needle";
  const matches = findSearchMatches(content, request);
  return {
    files: [{ path: "main.bp", content, revision: "disk", matches }],
    matchCount: matches.length,
    truncated: false,
    skipped: [],
  };
};
const controllers: SearchController[] = [];
function setup(
  search = vi.fn(async (_id: string, request: WorkspaceSearchRequest) => result(request)),
) {
  const documents = new Documents();
  documents.replace([{ file: "main.bp", content: "unsaved needle", saved: "saved" }]);
  const controller = new SearchController(documents, search);
  controllers.push(controller);
  controller.attach();
  controller.configure(workspace(), true);
  controller.setOptions({ query: "needle" });
  return { documents, controller, search };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.useRealTimers();
});

it("searches current open content and closed drafts without reading on every edit", async () => {
  const h = setup();
  expect(h.search).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  expect(h.search).toHaveBeenCalledWith(
    "one",
    expect.objectContaining({
      overlays: { "main.bp": "unsaved needle", "closed.bpi": "draft needle" },
    }),
  );
  expect(h.controller.getSnapshot().result?.matchCount).toBe(1);
  h.documents.replace([{ file: "main.bp", content: "changed needle", saved: "saved" }]);
  expect(h.controller.getSnapshot()).toMatchObject({ busy: true });
  expect(h.controller.getSnapshot().result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(250);
  expect(h.controller.getSnapshot().result?.files[0]?.content).toBe("changed needle");
});

it("discards old replies and coalesces edits into one following request", async () => {
  let release!: (value: WorkspaceSearchResult) => void;
  const search = vi.fn(async (_id: string, request: WorkspaceSearchRequest) => result(request));
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = setup(search);
  await vi.advanceTimersByTimeAsync(250);
  h.controller.setOptions({ query: "unsaved" });
  await vi.advanceTimersByTimeAsync(250);
  h.controller.setOptions({ query: "changed" });
  h.documents.replace([{ file: "main.bp", content: "changed", saved: "saved" }]);
  await vi.advanceTimersByTimeAsync(250);
  expect(search).toHaveBeenCalledTimes(1);
  release({ files: [], matchCount: 99, truncated: false, skipped: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(search).toHaveBeenCalledTimes(2);
  expect(search.mock.calls[1]![1].query).toBe("changed");
  expect(h.controller.getSnapshot().result?.matchCount).toBe(1);
});

it("never displays a result from a previous workspace", async () => {
  let release!: (value: WorkspaceSearchResult) => void;
  const search = vi.fn(async (_id: string, request: WorkspaceSearchRequest) => result(request));
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = setup(search);
  await vi.advanceTimersByTimeAsync(250);
  h.controller.configure(workspace("two"), true);
  await vi.advanceTimersByTimeAsync(250);
  release({ files: [], matchCount: 99, truncated: false, skipped: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(search.mock.calls[1]![0]).toBe("two");
  expect(h.controller.getSnapshot().result?.matchCount).toBe(1);
});

it("pauses while hidden and discards an in-flight result", async () => {
  let release!: (value: WorkspaceSearchResult) => void;
  const search = vi.fn(async (_id: string, request: WorkspaceSearchRequest) => result(request));
  search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = setup(search);
  await vi.advanceTimersByTimeAsync(250);
  h.controller.configure(workspace(), false);
  release({ files: [], matchCount: 99, truncated: false, skipped: [] });
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.controller.getSnapshot()).toMatchObject({ busy: false });
  expect(h.controller.getSnapshot().result).toBeUndefined();
  expect(search).toHaveBeenCalledTimes(1);
  h.controller.configure(workspace(), true);
  await vi.advanceTimersByTimeAsync(250);
  expect(h.controller.getSnapshot().result?.matchCount).toBe(1);
});

it("supports the StrictMode attach/cleanup/attach lifecycle and a retry after failure", async () => {
  const h = setup();
  h.controller.dispose();
  h.controller.attach();
  h.search.mockRejectedValueOnce(new Error("unavailable"));
  await vi.advanceTimersByTimeAsync(250);
  expect(h.controller.getSnapshot().error).toBe("unavailable");
  h.controller.refresh(0);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.controller.getSnapshot().error).toBeUndefined();
  expect(h.controller.getSnapshot().result?.matchCount).toBe(1);
});

it("clearing the query immediately invalidates results without another scan", async () => {
  const h = setup();
  await vi.advanceTimersByTimeAsync(250);
  h.controller.setOptions({ query: "" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(h.controller.getSnapshot()).toEqual({
    options: { query: "", caseSensitive: false, wholeWord: false },
    busy: false,
  });
  expect(h.search).toHaveBeenCalledTimes(1);
});
