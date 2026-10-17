import * as monaco from "monaco-editor";
import { createStaticLanguageStore } from "../../apps/desktop/src/renderer/editor/static-language-store.js";
import { createStaticLanguageRegistrar } from "../../apps/desktop/src/renderer/editor/static-language-registration.js";
import { bootstrapStaticLanguages } from "../../apps/desktop/src/renderer/editor/static-language-bootstrap.js";
import {
  CORE_LANGUAGE_IDS,
  CORE_EXTENSION_ROUTES,
} from "../../apps/desktop/src/renderer/editor/core-language-routes.js";
import { resolveLexicalLanguage } from "../../apps/desktop/src/renderer/editor/static-language-routing.js";
import { initializeEditorThemes } from "../../apps/desktop/src/renderer/editor/editor-theme.js";
import type { PluginsApi } from "../../apps/desktop/src/shared/plugins.js";
import type { StaticLanguagesCatalog } from "../../apps/desktop/src/shared/static-languages.js";

declare global {
  interface Window {
    staticAcceptance: Promise<void>;
  }
}
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(a: unknown, b: unknown, message: string): void {
  assert(
    JSON.stringify(a) === JSON.stringify(b),
    `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
  );
}
async function until(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!check()) {
    assert(performance.now() < deadline, "Timed out waiting for catalog/model reconciliation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function container(): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = "width:600px;height:240px";
  document.body.append(element);
  return element;
}

export async function runStaticLanguagesBrowserChecks(): Promise<void> {
  equal(
    monaco.languages
      .getLanguages()
      .map((language) => language.id)
      .sort(),
    [...CORE_LANGUAGE_IDS].sort(),
    "Installed Monaco core ids before plugin registration",
  );
  initializeEditorThemes(monaco.editor);
  const api = window.kobrixa.plugins;
  const pending: {
    resolve?: (catalog: StaticLanguagesCatalog) => void;
    catalog?: StaticLanguagesCatalog;
  } = {};
  let holdNext = false;
  const storeApi: Pick<PluginsApi, "state" | "staticLanguages" | "onEvent"> = {
    state: () => api.state(),
    onEvent: (listener) => api.onEvent(listener),
    staticLanguages: async () => {
      const catalog = await api.staticLanguages();
      if (!holdNext) return catalog;
      holdNext = false;
      pending.catalog = catalog;
      return new Promise((resolve) => {
        pending.resolve = resolve;
      });
    },
  };
  const store = createStaticLanguageStore(storeApi);
  const counts = new Map<string, number>();
  let failToyConfiguration = false;
  let failToyTokenizer = false;
  const reports: { accepted: boolean; detail: string }[] = [];
  let configurations = 0;
  const observedMonaco = {
    ...monaco,
    languages: {
      ...monaco.languages,
      register: (language: { id: string }) => {
        counts.set(language.id, (counts.get(language.id) ?? 0) + 1);
        monaco.languages.register(language);
      },
      setMonarchTokensProvider: (id: string, tokenizer: monaco.languages.IMonarchLanguage) => {
        if (id === "toy" && failToyTokenizer) {
          failToyTokenizer = false;
          // Compile failure only, inside the parent-terminable Electron process.
          return monaco.languages.setMonarchTokensProvider(id, {
            ...tokenizer,
            tokenizer: { root: [["(?<x", "identifier"]] },
          });
        }
        return monaco.languages.setMonarchTokensProvider(id, tokenizer);
      },
      setLanguageConfiguration: (
        id: string,
        configuration: monaco.languages.LanguageConfiguration,
      ) => {
        if (id === "toy") {
          configurations++;
          if (failToyConfiguration) {
            failToyConfiguration = false;
            throw new Error("Integration fixture: second-half registration failure");
          }
        }
        return monaco.languages.setLanguageConfiguration(id, configuration);
      },
    },
  };
  const registrar = createStaticLanguageRegistrar({
    monaco: observedMonaco,
    store,
    api: {
      reportLanguageRegistrationFailure: async (report) => {
        const result = await api.reportLanguageRegistrationFailure(report);
        reports.push({ accepted: result.accepted, detail: report.detail });
        return result;
      },
    },
    coreExtensionRoutes: CORE_EXTENSION_ROUTES,
  });
  const models: monaco.editor.ITextModel[] = [];
  const disposables: { dispose(): void }[] = [];
  const elements: HTMLElement[] = [];
  try {
    equal(
      (await bootstrapStaticLanguages({ store, registrar })).kind,
      "ready",
      "Real IPC bootstrap",
    );
    const catalog = await api.staticLanguages();
    const toy = catalog.languages.find((language) => language.id === "toy");
    assert(toy, "Real toy language missing");
    const make = (file: string) => {
      const model = monaco.editor.createModel(
        "value 1\n",
        "plaintext",
        monaco.Uri.parse(`file:///integration/${file}`),
      );
      models.push(model);
      disposables.push(registrar.trackModel(model, () => ({ file })));
      return model;
    };
    const main = make("main.toy");
    const hidden = make("hidden.toy");
    const original = make("original.toy");
    const modified = make("modified.toy");
    const host = container(),
      splitHost = container(),
      diffHost = container();
    elements.push(host, splitHost, diffHost);
    const editor = monaco.editor.create(host, { model: main, maxTokenizationLineLength: 10000 });
    const split = monaco.editor.create(splitHost, {
      model: main,
      maxTokenizationLineLength: 10000,
    });
    const diff = monaco.editor.createDiffEditor(diffHost, { maxTokenizationLineLength: 10000 });
    disposables.push(editor, split, diff);
    diff.setModel({ original, modified });
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.executeEdits("integration", [{ range: new monaco.Range(1, 1, 1, 1), text: "draft " }]);
    editor.pushUndoStop();
    const edited = main.getValue();
    const position = editor.getPosition();
    const selection = editor.getSelection();
    const view = editor.saveViewState();

    holdNext = true;
    const staleRequest = store.refresh();
    await until(() => pending.resolve !== undefined);
    assert((await api.setEnabled(toy.sourceKey, false)).ok, "Disable failed");
    await until(() => models.every((model) => model.getLanguageId() === "plaintext"));
    const late = make("late-review.toy");
    equal(late.getLanguageId(), "plaintext", "New model after revocation");
    assert(pending.catalog && pending.resolve, "No held response");
    pending.resolve(pending.catalog);
    await staleRequest;
    equal(
      models.map((model) => model.getLanguageId()),
      models.map(() => "plaintext"),
      "Stale response cannot revive models",
    );
    equal(main.getValue(), edited, "Text retained");
    equal(editor.getPosition(), position, "Cursor retained");
    equal(editor.getSelection(), selection, "Selection retained");
    equal(editor.saveViewState(), view, "View state retained");
    assert(
      editor.getModel() === main && split.getModel() === main,
      "Shared model identity retained",
    );
    assert(hidden === models[1], "Hidden model identity retained");
    assert((await api.setEnabled(toy.sourceKey, true)).ok, "Enable failed");
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    editor.trigger("integration", "undo", null);
    equal(main.getValue(), "value 1\n", "Undo stack retained through disable/enable");

    failToyConfiguration = true;
    assert((await api.reload(toy.sourceKey)).ok, "Reload failed");
    await until(() => registrar.resolve({ file: "main.toy" }).monacoLanguage === "plaintext");
    await until(
      () => !store.getSnapshot().catalog.languages.some((language) => language.id === "toy"),
    );
    const attempts = configurations;
    await store.refresh();
    await store.refresh();
    equal(configurations, attempts, "Quarantine cannot retry on catalog refresh");
    assert((await api.setEnabled(toy.sourceKey, false)).ok, "Disable quarantined source");
    assert((await api.setEnabled(toy.sourceKey, true)).ok, "Enable quarantined source");
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    equal(counts.get("toy"), 1, "Register one shell across failed generations");
    assert(
      (await api.staticLanguages()).languages.find((language) => language.id === "toy")!
        .generation > toy.generation,
      "Recovery must publish a fresh generation",
    );

    failToyTokenizer = true;
    assert((await api.reload(toy.sourceKey)).ok, "Reload for Monaco regex failure");
    await until(() =>
      reports.some(
        (report) =>
          report.accepted && report.detail === "Static language registration failed (SyntaxError).",
      ),
    );
    assert(
      (await api.state()).plugins
        .find((plugin) => plugin.sourceKey === toy.sourceKey)
        ?.problems.some((problem) => problem.code === "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION"),
      "Real IPC records the sanitized Monaco regex failure",
    );
    assert((await api.setEnabled(toy.sourceKey, false)).ok, "Disable compile-failed source");
    assert((await api.setEnabled(toy.sourceKey, true)).ok, "Recover compile-failed source");
    await until(() => models.every((model) => model.getLanguageId() === "toy"));
    equal(counts.get("toy"), 1, "Compile failure reuses its shell");

    const current = store.getSnapshot();
    const binding = {
      epoch: 1,
      pluginId: "kobrixa-smoke.missing",
      sourceKey: "builtin:kobrixa-smoke.missing",
      language: "missing",
      extensions: ["toy"],
      capabilities: ["analysis" as const],
      frontend: {
        language: "missing",
        entryExtensions: ["toy"],
        sourceExtensions: ["toy"],
        ir: { min: 1, max: 1 },
      },
    };
    equal(
      resolveLexicalLanguage({
        file: "main.toy",
        binding,
        catalog: current.catalog,
        activeOwners: current.owners,
        coreExtensionRoutes: CORE_EXTENSION_ROUTES,
      }).monacoLanguage,
      "plaintext",
      "Missing selected owner must not borrow the unique global toy route",
    );
    equal(registrar.resolve({ file: "main.JSON" }).monacoLanguage, "json", "Core route");
    equal(registrar.resolve({ file: "main.unknown" }).monacoLanguage, "plaintext", "Unknown route");

    // Pinned internal API: public editor.tokenize alone does not test tokenizeEncoded.
    // @ts-expect-error Monaco's pinned private JS module has no public declaration.
    const { TokenizationRegistry } = await import("monaco-editor/editor/common/languages.js");
    const support = await TokenizationRegistry.getOrCreate("bp");
    assert(support, "Basic Plus tokenizer support");
    const bp = make("long.bp");
    editor.setModel(bp);
    split.setModel(bp);
    monaco.editor.setModelLanguage(original, "bp");
    monaco.editor.setModelLanguage(modified, "bp");
    const editors = [editor, split, diff.getOriginalEditor(), diff.getModifiedEditor()];
    for (const pane of editors) {
      pane.updateOptions({ fontSize: 17, maxTokenizationLineLength: 10000 });
      const internal = pane as typeof pane & {
        _configurationService: {
          getValue(key: string, overrides: { overrideIdentifier: string }): number;
        };
      };
      equal(
        internal._configurationService.getValue("editor.maxTokenizationLineLength", {
          overrideIdentifier: "bp",
        }),
        10000,
        "Actual Monaco configuration after updateOptions",
      );
    }
    for (const length of [9999, 10000, 10001]) {
      const line = '"' + "x".repeat(length - 1);
      for (const model of [bp, original, modified]) model.setValue(line + "\nIf True Then");
      const state = support.getInitialState();
      const classic = support.tokenize(line, true, state);
      const encoded = support.tokenizeEncoded(line, true, state);
      equal(
        classic.tokens[0].type,
        length < 10000 ? "string.invalid.basic-plus" : "",
        "Classic >= boundary",
      );
      if (length >= 10000) {
        assert(classic.endState.equals(state), "Skipped line preserves incoming state");
        assert(encoded.endState.equals(state), "Encoded skipped line preserves incoming state");
        equal(encoded.tokens.length, 2, "One default encoded token on skipped line");
      }
      equal(
        support.tokenize("If True Then", true, classic.endState).tokens[0].type,
        "keyword.control.basic-plus",
        "Fixed root-state continuation fixture",
      );
      const expected = bp.getValue();
      editor.setPosition({ lineNumber: 2, column: 1 });
      editor.trigger("integration", "type", { text: "x" });
      editor.trigger("integration", "undo", null);
      equal(bp.getValue(), expected, "Long-line document remains editable and undoable");
    }
    const astral = '"' + "😀".repeat(4999) + "x";
    equal(astral.length, 10000, "UTF-16 boundary");
    equal(
      support.tokenize(astral, true, support.getInitialState()).tokens[0].type,
      "",
      "Astral line skips",
    );
    console.log("PASS real static IPC/store/registrar/Monaco integration");
  } finally {
    for (const disposable of disposables.reverse()) disposable.dispose();
    for (const model of models) model.dispose();
    registrar.dispose();
    store.dispose();
    for (const element of elements) element.remove();
  }
}
window.staticAcceptance = runStaticLanguagesBrowserChecks();
