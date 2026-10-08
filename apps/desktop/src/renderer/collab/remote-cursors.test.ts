import { afterEach, describe, expect, it, vi } from "vitest";

// The model APIs need only a few browser globals; `editor.api.js` avoids loading
// the workbench contributions that `monaco-editor` (editor.main) pulls in.
const created = vi.hoisted(() => {
  const elements: Array<object & { textContent?: string }> = [];
  const scope = globalThis as Record<string, unknown>;
  if (scope.window) return elements;
  const element = () => {
    const item = {
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      sheet: { insertRule() {}, cssRules: [] },
      setAttribute() {},
      appendChild() {},
      append() {},
      remove() {},
      addEventListener() {},
      removeEventListener() {},
    };
    elements.push(item);
    return item;
  };
  scope.window = globalThis;
  scope.location = { href: "file:///", origin: "file://", protocol: "file:" };
  scope.document = {
    createElement: element,
    head: element(),
    body: element(),
    documentElement: element(),
    addEventListener() {},
    removeEventListener() {},
    queryCommandSupported: () => false,
  };
  scope.addEventListener = () => {};
  scope.removeEventListener = () => {};
  scope.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  return elements;
});
vi.mock("monaco-editor", () => import("monaco-editor/esm/vs/editor/editor.api.js"));

import * as monaco from "monaco-editor";
import * as Y from "yjs";
import { PARTICIPANT_COLORS } from "@kobrixa/collab-protocol";
import { createLinkedSessions } from "./testing.js";
import { localPresence, sharedTypes } from "./types.js";
import {
  labelTextColor,
  REMOTE_CARET_ACTIVE_CLASS,
  REMOTE_CARET_BELOW_CLASS,
  REMOTE_CARET_CLASS,
  REMOTE_LABEL_MS,
  RemoteCursors,
} from "./remote-cursors.js";

const disposables: { dispose(): void }[] = [];
afterEach(() => {
  for (const item of disposables.splice(0).reverse()) item.dispose();
  vi.useRealTimers();
});

describe("labelTextColor", () => {
  it("picks dark text on light participant colors and light text on dark ones", () => {
    expect(labelTextColor("#ffc53d")).toBe("#000");
    expect(labelTextColor("#ffffff")).toBe("#000");
    expect(labelTextColor("#000000")).toBe("#fff");
    expect(labelTextColor("#3e63dd")).toBe("#fff");
    for (const color of PARTICIPANT_COLORS)
      expect(["#000", "#fff"]).toContain(labelTextColor(color));
  });
});

describe("RemoteCursors", () => {
  function setup() {
    const room = createLinkedSessions(["host", "editor"]);
    const [host, guest] = room.sessions;
    disposables.push({ dispose: () => room.sessions.forEach((session) => session.destroy()) });
    const text = new Y.Text("print 1\nprint 2\n");
    sharedTypes(host!.doc).files.set("main.bp", text);
    const shared = sharedTypes(guest!.doc).files.get("main.bp")!;
    const model = monaco.editor.createModel(shared.toString(), "plaintext");
    disposables.push(model);
    disposables.push(new RemoteCursors(guest!, "main.bp", shared, model));
    const at = (index: number) =>
      Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
    const move = (index: number) =>
      host!.awareness.setLocalState({
        ...localPresence(host!)!,
        file: "main.bp",
        selection: { anchor: at(index), head: at(index) },
      });
    const caret = () =>
      model
        .getAllDecorations()
        .find((item) => item.options.beforeContentClassName?.includes(REMOTE_CARET_CLASS))?.options
        .beforeContentClassName ?? "";
    return { host: host!, move, caret };
  }

  it("shows the name label briefly after the participant moves", () => {
    vi.useFakeTimers();
    const { host, move, caret } = setup();
    move(10);
    expect(caret()).toContain(REMOTE_CARET_ACTIVE_CLASS);
    expect(caret()).not.toContain(REMOTE_CARET_BELOW_CLASS);
    // Unrelated awareness updates do not restart the timer.
    vi.advanceTimersByTime(REMOTE_LABEL_MS - 500);
    host.awareness.setLocalState({ ...localPresence(host)! });
    expect(caret()).toContain(REMOTE_CARET_ACTIVE_CLASS);
    vi.advanceTimersByTime(600);
    expect(caret()).toContain(REMOTE_CARET_CLASS);
    expect(caret()).not.toContain(REMOTE_CARET_ACTIVE_CLASS);
    move(11);
    expect(caret()).toContain(REMOTE_CARET_ACTIVE_CLASS);
  });

  it("places the label below the caret on the first line", () => {
    const { move, caret } = setup();
    move(2);
    expect(caret()).toContain(REMOTE_CARET_BELOW_CLASS);
  });

  it("writes a readable label text color per participant", () => {
    const { host, move } = setup();
    host.awareness.setLocalState({ ...localPresence(host)!, color: "#ffc53d" });
    move(0);
    const rules = created.map((element) => element.textContent ?? "").join("\n");
    expect(rules).toContain("background-color:#ffc53d;color:#000;");
  });
});
