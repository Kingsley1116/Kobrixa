import { expect, it } from "vitest";
import type { WorkspaceSummary } from "../../shared/api.js";
import { ProjectSessions } from "./project-sessions.js";
const workspace = (id: string): WorkspaceSummary => ({
  id,
  name: id,
  rootLabel: id,
  files: ["main.bp"],
  entries: [{ path: "main.bp", kind: "file" }],
  implicit: true,
  entryCandidates: [],
  drafts: {},
});

it("keeps same-named documents isolated and retains delayed save ownership after switching", async () => {
  const sessions = new ProjectSessions();
  const a = sessions.add(workspace("a")),
    b = sessions.add(workspace("b"));
  a.documents.replace([{ file: "main.bp", content: "A draft", saved: "A" }]);
  b.documents.replace([{ file: "main.bp", content: "B draft", saved: "B" }]);
  sessions.activate("a");
  const commit = Promise.resolve().then(() =>
    a.documents.replace([{ file: "main.bp", content: "A newer", saved: "A draft" }]),
  );
  sessions.activate("b");
  await commit;
  expect(b.documents.getSnapshot()[0]).toMatchObject({
    content: "B draft",
    saved: "B",
    dirty: true,
  });
  sessions.activate("a");
  expect(a.documents.getSnapshot()[0]).toMatchObject({
    content: "A newer",
    saved: "A draft",
    dirty: true,
  });
  expect(sessions.add(workspace("a"))).toBe(a);
  expect(sessions.getSnapshot()).toHaveLength(2);
});

it("chooses the right neighbour, then the left, and includes closed recovery drafts in dirty state", () => {
  const sessions = new ProjectSessions();
  sessions.add(workspace("a"));
  const b = sessions.add({ ...workspace("b"), drafts: { "closed.bp": "recovery" } });
  sessions.add(workspace("c"));
  expect(b.dirty).toBe(true);
  sessions.activate("b");
  sessions.remove("b");
  expect(sessions.activeId).toBe("c");
  sessions.remove("c");
  expect(sessions.activeId).toBe("a");
  sessions.remove("a");
  expect(sessions.active).toBeUndefined();
  expect(sessions.snapshot()).toEqual({ projects: [] });
});

it("reorders open projects without changing the active project", () => {
  const sessions = new ProjectSessions();
  for (const id of ["a", "b", "c"]) sessions.add(workspace(id));
  sessions.activate("b");
  let notified = 0;
  sessions.subscribe(() => notified++);
  sessions.move("a", 2);
  expect(sessions.getSnapshot().map((item) => item.workspace.id)).toEqual(["b", "c", "a"]);
  expect(sessions.snapshot().projects.map((view) => view.workspaceId)).toEqual(["b", "c", "a"]);
  expect(sessions.activeId).toBe("b");
  expect(notified).toBe(1);
  sessions.move("missing", 0);
  expect(notified).toBe(1);
});

it("persists reordered document tabs as the open file order", () => {
  const session = new ProjectSessions().add(workspace("a"));
  session.documents.replace([
    { file: "a.bp", content: "A*", saved: "A" },
    { file: "b.bp", content: "B", saved: "B" },
  ]);
  const [first, second] = session.documents.getSnapshot();
  session.documents.replace([second!, first!]);
  expect(session.snapshot().files).toEqual(["b.bp", "a.bp"]);
  expect(session.documents.getSnapshot().map((tab) => [tab.file, tab.dirty])).toEqual([
    ["b.bp", false],
    ["a.bp", true],
  ]);
});

it("saves pinned files with the project view", () => {
  const session = new ProjectSessions().add(workspace("a"));
  session.documents.replace([
    { file: "a.bp", content: "", saved: "" },
    { file: "b.bp", content: "", saved: "", pinned: true },
  ]);
  expect(session.snapshot()).toMatchObject({ files: ["b.bp", "a.bp"], pinnedFiles: ["b.bp"] });
});
