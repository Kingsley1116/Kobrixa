import type { WebContents } from "electron";
import {
  KEYBOARD_DEFAULT,
  ignoreMenuShortcut,
  keyboardStroke,
  type KeyboardContext,
} from "../shared/keyboard.js";
const contexts = new WeakMap<WebContents, KeyboardContext>();
export function setKeyboardContext(contents: WebContents, context: KeyboardContext): void {
  contexts.set(contents, context);
}
export function attachKeyboard(contents: WebContents): void {
  contexts.set(contents, { ...KEYBOARD_DEFAULT });
  contents.on("before-input-event", (_event, input) => {
    const context = contexts.get(contents) ?? KEYBOARD_DEFAULT;
    const stroke = keyboardStroke({
      code: input.code,
      ctrlKey: input.control,
      metaKey: input.meta,
      altKey: input.alt,
      shiftKey: input.shift,
    });
    contents.setIgnoreMenuShortcuts(
      ignoreMenuShortcut(context, stroke, process.platform === "darwin"),
    );
  });
  contents.on("did-start-loading", () => {
    contexts.set(contents, { ...KEYBOARD_DEFAULT });
    contents.setIgnoreMenuShortcuts(false);
  });
}
