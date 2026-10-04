import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const root = { createInstance: vi.fn((_ctor, placement, instant) => ({ placement, instant })) };
  return {
    root,
    initialize: vi.fn(() => root),
    setHoverDelegateFactory: vi.fn(),
    WorkbenchHoverDelegate: class {},
  };
});
vi.mock("monaco-editor", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js", () => ({
  StandaloneServices: { initialize: mocks.initialize },
}));
vi.mock("monaco-editor/esm/vs/base/browser/ui/hover/hoverDelegateFactory.js", () => ({
  setHoverDelegateFactory: mocks.setHoverDelegateFactory,
}));
vi.mock("monaco-editor/esm/vs/platform/hover/browser/hover.js", () => ({
  WorkbenchHoverDelegate: mocks.WorkbenchHoverDelegate,
}));

import { restoreEditorHoverDelegate } from "./monaco-services.js";
import { workspaceEditService } from "./workspace-edits.js";

beforeEach(() => vi.clearAllMocks());

it("restores hover creation through the persistent root after a diff scope is disposed", () => {
  const disposedChildFactory = () => {
    throw new Error("InstantiationService has been disposed");
  };
  mocks.setHoverDelegateFactory(disposedChildFactory);
  restoreEditorHoverDelegate();
  const factory = mocks.setHoverDelegateFactory.mock.calls.at(-1)![0] as (
    placement: "mouse" | "element",
    instant: boolean,
  ) => unknown;
  expect(factory("element", true)).toEqual({ placement: "element", instant: true });
  expect(mocks.initialize).toHaveBeenCalledWith({ IWorkspaceEditService: workspaceEditService });
  expect(mocks.root.createInstance).toHaveBeenCalledWith(
    mocks.WorkbenchHoverDelegate,
    "element",
    true,
    {},
  );
  mocks.setHoverDelegateFactory(disposedChildFactory);
  restoreEditorHoverDelegate();
  const restored = mocks.setHoverDelegateFactory.mock.calls.at(-1)![0] as typeof factory;
  expect(restored("mouse", false)).toEqual({ placement: "mouse", instant: false });
});
