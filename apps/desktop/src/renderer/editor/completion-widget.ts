import type { editor, IDisposable, languages, Position } from "monaco-editor";

interface SuggestItem {
  completion: languages.CompletionItem;
}
interface SuggestController extends editor.IEditorContribution {
  model: { onDidTrigger(listener: (event: { auto: boolean }) => void): IDisposable };
  widget: { value: { getFocusedItem(): { item: SuggestItem } | undefined } };
  triggerSuggest(onlyFrom: undefined, auto: boolean, noFilter: undefined): void;
  registerSelector(selector: {
    priority: number;
    select(model: editor.ITextModel, position: Position, items: SuggestItem[]): number;
  }): IDisposable;
}
const key = (item: languages.CompletionItem) =>
  JSON.stringify([item.label, item.insertText, item.kind]);

/** Small adapter for pinned Monaco 0.52: its public action cannot refresh an open list. */
export function completionWidget(
  instance: editor.IStandaloneCodeEditor,
  composing: () => boolean,
  manual: () => void,
) {
  const controller = instance.getContribution<SuggestController>(
    "editor.contrib.suggestController",
  );
  let requested = false;
  let automatic = true;
  let preferred: string | undefined;
  const subscriptions = controller
    ? [
        controller.model.onDidTrigger((event) => {
          if (event.auto && !automatic) return;
          requested = true;
          if (!event.auto) manual();
        }),
        controller.registerSelector({
          priority: 1000,
          select: (_model, _position, items) => {
            const selected = preferred;
            preferred = undefined;
            return selected === undefined
              ? -1
              : items.findIndex((item) => key(item.completion) === selected);
          },
        }),
        instance.onKeyDown((event) => {
          if (event.browserEvent.key === "Escape") requested = false;
        }),
        instance.onDidBlurEditorWidget(() => {
          requested = false;
        }),
        instance.onDidChangeCursorPosition(() => {
          requested = false;
        }),
      ]
    : [];
  return {
    setAutomaticSuggestions(enabled: boolean): void {
      if (automatic === enabled) return;
      automatic = enabled;
      if (!enabled) {
        requested = false;
        preferred = undefined;
        instance.trigger("settings", "hideSuggestWidget", undefined);
      }
    },
    refresh(model: editor.ITextModel, position: Position): void {
      const cursor = instance.getPosition();
      if (
        !controller ||
        composing() ||
        !instance.hasTextFocus() ||
        instance.getModel() !== model ||
        cursor?.lineNumber !== position.lineNumber ||
        cursor.column !== position.column
      )
        return;
      const widget = instance.getDomNode()?.querySelector(".suggest-widget");
      const visible =
        widget &&
        widget.getBoundingClientRect().height > 0 &&
        getComputedStyle(widget).visibility !== "hidden";
      // An empty automatic list may hide itself. Keep the user's request alive
      // until Escape, blur, or a cursor move, so newly indexed names can appear.
      if ((!automatic || !visible) && !requested) return;
      const focused = visible && controller.widget.value.getFocusedItem();
      preferred = focused ? key(focused.item.completion) : undefined;
      controller.triggerSuggest(undefined, false, undefined);
    },
    dispose(): void {
      for (const subscription of subscriptions) subscription.dispose();
    },
  };
}
