import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as monaco from "monaco-editor";
import {
  KEYBOARD_DEFAULT,
  keyboardStroke,
  validStroke,
  type KeyboardContext,
} from "../../shared/keyboard.js";
import {
  appCommandId,
  bindingHint,
  effectiveBindings,
  KeybindingsStore,
  WorkbenchKeyDispatcher,
  type AppCommand,
} from "./keybindings.js";
import {
  cancelEditorChord,
  editorChordPending,
  editorCommandCatalog,
  installKeybindings,
} from "./monaco-keybindings.js";
import { isModalOpen } from "../components/modal.js";
export const keybindingsStore = new KeybindingsStore(() => window.localStorage);
export function useKeyboard(run: (command: AppCommand) => void, blocked: boolean) {
  const mac = navigator.platform.toLowerCase().includes("mac");
  const commands = useMemo(() => editorCommandCatalog(mac), [mac]);
  const snapshot = useSyncExternalStore(keybindingsStore.subscribe, keybindingsStore.getSnapshot);
  const [capturing, setCapturing] = useState(false);
  const latest = useRef({ run, blocked, capturing });
  latest.current = { run, blocked, capturing };
  const instance = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const cancelPending = useRef(() => {});
  const context = useRef<KeyboardContext>({ ...KEYBOARD_DEFAULT });
  const sync = useCallback((patch: Partial<KeyboardContext>) => {
    context.current = { ...context.current, ...patch };
    void window.kobrixa.keyboard.updateContext(context.current).catch(() => undefined);
  }, []);
  const bindEditor = useCallback(
    (editor: monaco.editor.IStandaloneCodeEditor) => {
      instance.current = editor;
      const modal = editor.createContextKey<boolean>("kobrixa.modal", false);
      const focused = () => {
        modal.set(isModalOpen());
        sync({ editorFocused: editor.hasWidgetFocus() });
      };
      const subscriptions = [
        editor.onDidFocusEditorWidget(focused),
        editor.onDidBlurEditorWidget(() => {
          cancelEditorChord();
          sync({ editorFocused: false, chordPending: false });
        }),
      ];
      focused();
      return () => {
        subscriptions.forEach((item) => item.dispose());
        modal.reset();
        instance.current = undefined;
        cancelEditorChord();
        sync({ editorFocused: false, chordPending: false });
      };
    },
    [sync],
  );
  useEffect(() => {
    const registrations = commands
      .filter((command) => command.source === "workbench")
      .map((command) =>
        monaco.editor.addCommand({
          id: command.id,
          run: () => {
            if (!latest.current.blocked && !latest.current.capturing && !isModalOpen())
              latest.current.run(command.id.slice(8) as AppCommand);
          },
        }),
      );
    return () => registrations.forEach((registration) => registration.dispose());
  }, [commands]);
  useEffect(() => {
    const registration = installKeybindings(commands, snapshot.overrides, mac);
    return () => registration.dispose();
  }, [commands, snapshot.overrides, mac]);
  useEffect(() => {
    sync({ capturing });
  }, [capturing, sync]);
  useEffect(() => {
    const bindings = commands
      .filter((command) => command.source === "workbench")
      .flatMap((command) =>
        effectiveBindings(command, snapshot.overrides).map((binding) => ({
          command: command.id,
          keys: binding.keys,
        })),
      );
    sync({
      managedKeys: [
        ...new Set([
          ...bindings.map((binding) => binding.keys[0]!),
          ...commands
            .filter((command) => command.source === "workbench")
            .flatMap((command) => command.defaults.map((binding) => binding.keys[0]!)),
        ]),
      ],
    });
    let editorTimer: ReturnType<typeof setTimeout> | undefined;
    const dispatcher = new WorkbenchKeyDispatcher(
      (id) => latest.current.run(id.slice(8) as AppCommand),
      (pending) => sync({ chordPending: pending }),
    );
    const cancel = () => {
      dispatcher.cancel();
      clearTimeout(editorTimer);
      cancelEditorChord();
      sync({ chordPending: false });
    };
    cancelPending.current = cancel;
    const keydown = (event: KeyboardEvent) => {
      if (latest.current.capturing) return;
      if (latest.current.blocked || isModalOpen()) {
        cancel();
        return;
      }
      const stroke = keyboardStroke(event);
      const managed = bindings.some((binding) => binding.keys[0] === stroke);
      if (event.isComposing || event.keyCode === 229 || event.getModifierState("AltGraph")) {
        cancel();
        // Leave the browser's composition/text input intact, but do not let either
        // Monaco or the workbench interpret an IME/AltGraph key as a command.
        event.stopPropagation();
        return;
      }
      if (event.repeat && managed) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === "Escape" && context.current.chordPending) {
        cancel();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (instance.current?.hasWidgetFocus()) {
        // Let Monaco resolve the command and its native context, then impose our chord timeout.
        queueMicrotask(() => {
          const pending = editorChordPending();
          clearTimeout(editorTimer);
          sync({ chordPending: pending });
          if (pending) editorTimer = setTimeout(cancel, 2000);
        });
        return;
      }
      const editable =
        event.target instanceof HTMLElement &&
        Boolean(event.target.closest("input, textarea, [contenteditable=true]"));
      const available = editable
        ? bindings.filter((binding) =>
            ["kobrixa.settings", "kobrixa.shortcuts"].includes(binding.command),
          )
        : bindings;
      if (validStroke(stroke) && dispatcher.dispatch(stroke, available)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [commands, snapshot.overrides, sync]);
  useEffect(() => {
    if (blocked || capturing) cancelPending.current();
  }, [blocked, capturing, sync]);
  const hint = (id: AppCommand) =>
    bindingHint(
      commands.find((command) => command.id === appCommandId(id)),
      snapshot.overrides,
      mac,
    );
  return {
    ...snapshot,
    commands,
    mac,
    capturing,
    setCapturing,
    hint,
    bindEditor,
    store: keybindingsStore,
  };
}
export type KeyboardSettings = ReturnType<typeof useKeyboard>;
