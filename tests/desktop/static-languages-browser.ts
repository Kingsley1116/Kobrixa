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
import type {
  ReportLanguageRegistrationFailureInput,
  StaticLanguagesCatalog,
} from "../../apps/desktop/src/shared/static-languages.js";
import {
  HOSTILE_PATTERN,
  HOSTILE_COMPILED_PATTERN,
  HOSTILE_DOCUMENT,
  STRESS_EVENT_PREFIX,
} from "./static-languages-stress.mjs";

declare global {
  interface Window {
    staticAcceptance: Promise<unknown>;
    staticHostileTokenize: () => never;
    staticHostileRecover: () => Promise<unknown>;
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
  const reports: (ReportLanguageRegistrationFailureInput & {
    accepted: boolean;
    acceptedRevision: number;
  })[] = [];
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
        reports.push({ ...report, accepted: result.accepted, acceptedRevision: result.revision });
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

    const beforeReload = store
      .getSnapshot()
      .catalog.languages.find((language) => language.id === "toy");
    assert(beforeReload, "Missing toy before reload");
    const beforeFailure = configurations;
    failToyConfiguration = true;
    assert((await api.reload(toy.sourceKey)).ok, "Reload failed");
    // Reload first withdraws the old generation. Plaintext/absence alone can mean
    // the new generation's catalog is still in flight, before any failure occurred.
    const failedReload = () =>
      reports.find(
        (report) =>
          report.accepted &&
          report.sourceKey === toy.sourceKey &&
          report.languageId === toy.id &&
          report.generation > beforeReload.generation &&
          report.reason === "monaco",
      );
    await until(() => {
      const report = failedReload();
      const snapshot = store.getSnapshot();
      return (
        report !== undefined &&
        snapshot.phase === "ready" &&
        snapshot.catalog.revision === snapshot.targetRevision &&
        snapshot.catalog.revision >= report.acceptedRevision &&
        !snapshot.catalog.languages.some((language) => language.id === "toy") &&
        models.every((model) => model.getLanguageId() === "plaintext")
      );
    });
    equal(configurations, beforeFailure + 1, "Reload attempted its fresh generation once");
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
        .generation > failedReload()!.generation,
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
    // The runner prebundles this with monaco-editor to share the registrar's registry.
    // @ts-expect-error Monaco's pinned private JS module has no public declaration.
    const { TokenizationRegistry } = await import("monaco-editor/editor/common/languages.js");
    const support = await TokenizationRegistry.getOrCreate("bp");
    assert(support, "Basic Plus tokenizer support");
    const bp = make("long.bp");
    editor.setModel(bp);
    split.setModel(bp);
    monaco.editor.setModelLanguage(original, "bp");
    monaco.editor.setModelLanguage(modified, "bp");
    // Diff panes are StandaloneCodeEditors; their parent StandaloneDiffEditor
    // owns the configuration service and applies global tokenization options.
    diff.updateOptions({ fontSize: 17, maxTokenizationLineLength: 10000 });
    const editors = [
      [editor, editor],
      [split, split],
      [diff.getOriginalEditor(), diff],
      [diff.getModifiedEditor(), diff],
    ] as const;
    for (const [pane, configurationOwner] of editors) {
      pane.updateOptions({ fontSize: 17, maxTokenizationLineLength: 10000 });
      equal(pane.getOption(monaco.editor.EditorOption.fontSize), 17, "Pane options updated");
      const internal = configurationOwner as typeof configurationOwner & {
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
async function prepareHostileAcceptance(recover: boolean): Promise<unknown> {
  const api = window.kobrixa.plugins;
  const store = createStaticLanguageStore(api);
  const registrar = createStaticLanguageRegistrar({
    monaco,
    store,
    api,
    coreExtensionRoutes: CORE_EXTENSION_ROUTES,
  });
  equal((await bootstrapStaticLanguages({ store, registrar })).kind, "ready", "Stress bootstrap");
  // @ts-expect-error Monaco's pinned private JS module has no public declaration.
  const { TokenizationRegistry } = await import("monaco-editor/editor/common/languages.js");
  const model = monaco.editor.createModel(
    recover ? HOSTILE_DOCUMENT : "",
    "plaintext",
    monaco.Uri.parse("file:///stress/document.hostile"),
  );
  const tracked = registrar.trackModel(model, () => ({ file: "document.hostile" }));
  const host = container();
  const editor = monaco.editor.create(host, { model, maxTokenizationLineLength: 10000 });
  if (!recover) {
    equal(model.getLanguageId(), "toy-hostile", "Validated hostile language registered and routed");
    const language = (await api.staticLanguages()).languages.find(
      (item) => item.id === "toy-hostile",
    );
    assert(
      language && registrar.getActiveOwners().some((item) => item.languageId === language.id),
      "Hostile registrar owner",
    );
    assert(
      await TokenizationRegistry.getOrCreate(language.id),
      "Real hostile Monarch tokenizer loaded",
    );
    window.staticHostileTokenize = () => {
      const originalExec = RegExp.prototype.exec;
      // Observe the actual native regex call reached through Monaco's model
      // tokenization. Forward unchanged; no substitute loop or synthetic hang.
      RegExp.prototype.exec = function (text: string): RegExpExecArray | null {
        const hostile = this.source === HOSTILE_COMPILED_PATTERN && text === HOSTILE_DOCUMENT;
        if (hostile)
          console.log(
            STRESS_EVENT_PREFIX +
              JSON.stringify({
                type: "regex-entered",
                pattern: this.source,
                codeUnits: text.length,
                languageId: model.getLanguageId(),
                documentUri: model.uri.toString(),
              }),
          );
        const result = originalExec.call(this, text);
        if (hostile) console.log(STRESS_EVENT_PREFIX + JSON.stringify({ type: "regex-returned" }));
        return result;
      };
      try {
        model.setValue(HOSTILE_DOCUMENT);
        // Exercise the document's real synchronous tokenization, even in a hidden
        // BrowserWindow where background rendering can be throttled.
        (
          model as typeof model & { tokenization: { forceTokenization(line: number): void } }
        ).tokenization.forceTokenization(1);
      } finally {
        RegExp.prototype.exec = originalExec;
      }
      throw new Error("Hostile document tokenization returned instead of blocking");
    };
    return {
      languageId: language.id,
      pattern: HOSTILE_PATTERN,
      codeUnits: HOSTILE_DOCUMENT.length,
    };
  }
  window.staticHostileRecover = async () => {
    const builtinWorks = async () => {
      assert(
        await TokenizationRegistry.getOrCreate("bp"),
        "Builtin tokenizer available in recovery",
      );
      equal(
        monaco.editor.tokenize("If True Then", "bp")[0]![0]!.type,
        "keyword.control.basic-plus",
        "Builtin Basic Plus actually tokenizes",
      );
    };
    const hostileAbsent = () => {
      equal(model.getLanguageId(), "plaintext", "Hostile document restored as plaintext");
      assert(
        !registrar.getActiveOwners().some((owner) => owner.languageId === "toy-hostile"),
        "Hostile owner absent",
      );
      assert(
        !monaco.languages.getLanguages().some((language) => language.id === "toy-hostile"),
        "Hostile language never registered in recovery",
      );
      equal(model.getValue(), HOSTILE_DOCUMENT, "Recovered document content retained");
    };
    try {
      const state = await api.state();
      assert(state.safeMode && state.safeModeLock, "Recovery lock available through preload");
      assert(
        (await api.staticLanguages()).languages.every((language) =>
          language.sourceKey.startsWith("builtin:"),
        ),
        "Recovery catalog is builtin-only",
      );
      hostileAbsent();
      await builtinWorks();
      // Safe mode deliberately does not read manifests: identify the displayed
      // source directory, then use the same public actions as the settings UI.
      const directory = new URL(location.href).searchParams.get("hostileDirectory");
      const hostile = state.plugins.find((row) => row.directory === directory);
      assert(
        hostile?.disabledBy === "safe-mode",
        "Hostile source individually available in recovery",
      );
      const disabled = await api.setEnabled(hostile.sourceKey, false);
      assert(disabled.ok && disabled.persisted !== false, "Individual disable persisted");
      assert((await api.clearSafeModeLock()).ok, "Restore plugins succeeds through preload");
      await store.refresh();
      await until(() => registrar.getActiveOwners().some((owner) => owner.languageId === "toy"));
      const restored = await api.state();
      assert(!restored.safeMode && !restored.safeModeLock, "Restore leaves safe mode");
      const disabledHostile = restored.plugins.find((row) => row.id === "acme.hostile");
      assert(
        disabledHostile?.status === "disabled" && disabledHostile.disabledBy === "user",
        "Only hostile plugin remains disabled",
      );
      const catalog = await api.staticLanguages();
      assert(
        !catalog.languages.some((language) => language.id === "toy-hostile"),
        "Hostile absent after Restore",
      );
      assert(
        catalog.languages.some((language) => language.id === "toy"),
        "Unrelated third-party plugin restored",
      );
      hostileAbsent();
      await builtinWorks();
      editor.setPosition({ lineNumber: 1, column: 1 });
      editor.trigger("stress-recovery", "type", { text: "editable " });
      assert(model.getValue().startsWith("editable "), "Recovered document editable");
      editor.trigger("stress-recovery", "undo", null);
      equal(model.getValue(), HOSTILE_DOCUMENT, "Recovered document undo works");
      return {
        hostileSourceKey: disabledHostile.sourceKey,
        builtinToken: "keyword.control.basic-plus",
        hostileRegistered: false,
        safeMode: false,
        unrelatedRestored: true,
        editable: true,
      };
    } finally {
      editor.dispose();
      tracked.dispose();
      model.dispose();
      registrar.dispose();
      store.dispose();
      host.remove();
    }
  };
  return undefined;
}

const phase = new URL(location.href).searchParams.get("phase");
window.staticAcceptance =
  phase === "hostile-tokenization" || phase === "recover-hostile"
    ? prepareHostileAcceptance(phase === "recover-hostile")
    : runStaticLanguagesBrowserChecks();
