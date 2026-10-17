import { expect, it, vi } from "vitest";
import { PluginManager } from "@kobrixa/plugin-runtime";
import type { IpcMainInvokeEvent } from "electron";
import { registerPluginIpc, type PluginIpcTarget } from "../../main/plugins/ipc.js";
import type { IpcHandle } from "../../main/ipc.js";
import { BUILTIN_PLUGIN_SOURCES } from "../../main/plugins/builtin.js";
import { createStaticLanguageRegistrar } from "./static-language-registration.js";
import { CORE_EXTENSION_ROUTES } from "./core-language-routes.js";
import type { StaticLanguageStoreSnapshot } from "./static-language-store.js";
import type { ReportLanguageRegistrationFailureResult } from "../../shared/static-languages.js";

vi.mock("monaco-editor", () => ({
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
}));

it.each(["monaco", "validation"] as const)(
  "accepts a sanitized %s regex-compile failure through IPC and records its problem",
  async (failure) => {
    const compilerPath = "monaco-editor/editor/standalone/common/monarch/monarchCompile.js";
    const { compile } = await import(compilerPath);
    const manager = await PluginManager.create({
      sources: BUILTIN_PLUGIN_SOURCES,
      store: {
        load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
        save: async () => {},
      },
      safeMode: false,
      locale: "en",
      launcher: async () => {
        throw new Error("Unexpected launch");
      },
    });
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const handle: IpcHandle = (channel, action) => {
      handlers.set(channel, action as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown);
    };
    const off = registerPluginIpc(
      handle,
      {
        reportLanguageRegistrationFailure: (
          report: Parameters<PluginIpcTarget["reportLanguageRegistrationFailure"]>[0],
        ) => manager.reportLanguageRegistrationFailure(report),
        onEvent: () => () => {},
      } as unknown as PluginIpcTarget,
      () => {},
    );
    const catalog = manager.staticLanguages();
    const value = catalog.languages[0]!;
    expect(() =>
      handlers.get("plugins:report-language-registration-failure")!({} as IpcMainInvokeEvent, {
        sourceKey: value.sourceKey,
        generation: value.generation,
        languageId: value.id,
        revision: catalog.revision,
        reason: "monaco",
        detail: "Invalid regular expression: /(?<x/: Unterminated group",
      }),
    ).toThrow("physical path");
    if (failure === "validation") {
      value.tokenizer = {
        ignoreCase: false,
        states: [
          {
            name: "root",
            rules: [{ regex: { pattern: "(?<x", flags: "" }, action: { token: "identifier" } }],
          },
        ],
      };
      value.expandedRules = 1;
      value.resourceBytes.tokenizer = Buffer.byteLength(JSON.stringify(value.tokenizer));
    }
    const snapshot: StaticLanguageStoreSnapshot = {
      phase: "ready",
      targetRevision: catalog.revision,
      catalog,
      owners: manager.state().staticLanguageOwners,
    };
    const reports: Promise<ReportLanguageRegistrationFailureResult>[] = [];
    const details: string[] = [];
    const registrar = createStaticLanguageRegistrar({
      store: {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        ready: async () => {},
        refresh: async () => {},
        dispose() {},
      },
      coreExtensionRoutes: CORE_EXTENSION_ROUTES,
      api: {
        reportLanguageRegistrationFailure: async (report) => {
          details.push(report.detail);
          const result = Promise.resolve().then(() =>
            handlers.get("plugins:report-language-registration-failure")!(
              {} as IpcMainInvokeEvent,
              report,
            ),
          ) as Promise<ReportLanguageRegistrationFailureResult>;
          reports.push(result);
          return result;
        },
      },
      monaco: {
        languages: {
          register() {},
          setMonarchTokensProvider(id) {
            // Fault injection at the Monaco boundary; the DTO and shared validator are real.
            // Compile only: no document pattern execution occurs in this process.
            compile(id, { tokenizer: { root: [["(?<x", "identifier"]] } });
            throw new Error("Expected native regex compilation to fail");
          },
          setLanguageConfiguration() {
            return { dispose() {} };
          },
        },
        editor: {
          getModels: () => [],
          onDidCreateModel: () => ({ dispose() {} }),
          onWillDisposeModel: () => ({ dispose() {} }),
          setModelLanguage() {},
        },
      },
    });
    try {
      expect(await Promise.all(reports)).toEqual([expect.objectContaining({ accepted: true })]);
      expect(details).toEqual([
        `Static language registration failed (${failure === "monaco" ? "SyntaxError" : "StaticLanguageAdapterError"}).`,
      ]);
      expect(
        manager.state().plugins.find((row) => row.id === "kobrixa.basic-plus")?.problems,
      ).toContainEqual(
        expect.objectContaining({
          code: "PLUGIN_E_STATIC_LANGUAGE_REGISTRATION",
          detail: expect.objectContaining({ languageId: "bp" }),
        }),
      );
      expect(manager.staticLanguages().languages).toEqual([]);
    } finally {
      registrar.dispose();
      off();
      await manager.shutdown();
    }
  },
);
