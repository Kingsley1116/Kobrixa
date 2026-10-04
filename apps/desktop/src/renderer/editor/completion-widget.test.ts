import { afterEach, expect, it, vi } from "vitest";
import type { editor, Position } from "monaco-editor";
import { completionWidget } from "./completion-widget.js";

afterEach(() => vi.unstubAllGlobals());
it("keeps empty completion intent, honors dismissal and composition, and preserves selection", () => {
  const callbacks = new Map<string, (value?: unknown) => void>();
  const listen = (name: string) => (callback: (value?: unknown) => void) => {
    callbacks.set(name, callback);
    return { dispose: vi.fn() };
  };
  let visible = false,
    composing = false;
  const item = { label: "chosen", insertText: "chosen", kind: 4 };
  const controller = {
    model: { onDidTrigger: listen("trigger") },
    widget: { value: { getFocusedItem: () => ({ item: { completion: item } }) } },
    triggerSuggest: vi.fn(),
    registerSelector: vi.fn(() => ({ dispose: vi.fn() })),
  };
  const model = {} as editor.ITextModel;
  const position = { lineNumber: 2, column: 4 } as Position;
  const instance = {
    trigger: vi.fn(() => {
      visible = false;
    }),
    getContribution: () => controller,
    getPosition: () => position,
    getModel: () => model,
    hasTextFocus: () => true,
    getDomNode: () => ({
      querySelector: () => ({ getBoundingClientRect: () => ({ height: visible ? 50 : 0 }) }),
    }),
    onKeyDown: listen("key"),
    onDidBlurEditorWidget: listen("blur"),
    onDidChangeCursorPosition: listen("cursor"),
  } as unknown as editor.IStandaloneCodeEditor;
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  const manual = vi.fn();
  const widget = completionWidget(instance, () => composing, manual);
  widget.refresh(model, position);
  expect(controller.triggerSuggest).not.toHaveBeenCalled();
  callbacks.get("trigger")!({ auto: false });
  expect(manual).toHaveBeenCalledOnce();
  widget.refresh(model, position);
  expect(controller.triggerSuggest).toHaveBeenCalledTimes(1);
  callbacks.get("key")!({ browserEvent: { key: "Escape" } });
  widget.refresh(model, position);
  expect(controller.triggerSuggest).toHaveBeenCalledTimes(1);
  callbacks.get("trigger")!({ auto: true });
  composing = true;
  widget.refresh(model, position);
  expect(controller.triggerSuggest).toHaveBeenCalledTimes(1);
  composing = false;
  visible = true;
  widget.refresh(model, position);
  const selector = (
    controller.registerSelector.mock.calls as unknown as Array<
      [{ select(m: editor.ITextModel, p: Position, items: unknown[]): number }]
    >
  )[0]![0];
  expect(
    selector.select(model, position, [{ completion: { label: "new" } }, { completion: item }]),
  ).toBe(1);
  visible = false;
  callbacks.get("blur")!();
  widget.refresh(model, position);
  expect(controller.triggerSuggest).toHaveBeenCalledTimes(2);
  callbacks.get("trigger")!({ auto: true });
  widget.setAutomaticSuggestions(false);
  controller.triggerSuggest.mockClear();
  widget.refresh(model, position);
  expect(controller.triggerSuggest).not.toHaveBeenCalled();
  callbacks.get("trigger")!({ auto: false });
  widget.refresh(model, position);
  expect(controller.triggerSuggest).toHaveBeenCalledOnce();
  widget.dispose();
});
