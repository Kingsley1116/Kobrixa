import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { checkStaticLanguageLifecycle } from "./static-languages-acceptance.mjs";

function apiFixture({ running = false, revoke = true } = {}) {
  let enabled = true,
    quarantined = false,
    revision = 1,
    generation = 1;
  const calls = [];
  const owner = { sourceKey: "dev:0123456789abcdef", pluginId: "acme.toy", languageId: "toy" };
  const api = {
    async state() {
      return {
        revision,
        diagnosticHelpRevision: 0,
        staticLanguagesRevision: revision,
        staticLanguageOwners:
          enabled && !quarantined ? [{ ...owner, generation, extensions: ["toy"] }] : [],
        safeMode: false,
        developmentMode: true,
        developer: { enabled: true, commandLine: false, linkedCount: 1 },
        origins: { [owner.sourceKey]: "linked" },
        python: { pendingReload: [] },
        inflight: [],
        plugins: [
          {
            id: owner.pluginId,
            sourceKey: owner.sourceKey,
            source: "development",
            runtime: "static",
            running,
            status: enabled ? "enabled" : "disabled",
            commands: [],
            problems: [],
          },
        ],
      };
    },
    async staticLanguages() {
      return {
        formatVersion: 1,
        limitsVersion: 1,
        revision,
        languages:
          (enabled || !revoke) && !quarantined
            ? [
                {
                  sourceKey: owner.sourceKey,
                  pluginId: owner.pluginId,
                  generation,
                  id: "toy",
                  extensions: ["toy"],
                  aliases: ["Toy"],
                  resourceDigest: "test-digest",
                  tokenizer: {
                    ignoreCase: false,
                    states: [
                      {
                        name: "root",
                        rules: [
                          { regex: { pattern: ".", flags: "" }, action: { token: "identifier" } },
                        ],
                      },
                    ],
                  },
                  configuration: {},
                  resourceBytes: { tokenizer: 150, configuration: 3 },
                  expandedRules: 1,
                },
              ]
            : [],
        extensionRoutes: enabled && !quarantined ? { toy: "toy" } : {},
        conflicts: [],
      };
    },
    async setEnabled(key, value) {
      calls.push(["setEnabled", key, value]);
      enabled = value;
      quarantined = false;
      revision++;
      if (value) generation++;
      return { ok: true, state: await api.state() };
    },
    async reload(key) {
      calls.push(["reload", key]);
      generation++;
      revision++;
      quarantined = false;
      return { ok: true, state: await api.state() };
    },
    async reportLanguageRegistrationFailure(input) {
      calls.push(["report", input]);
      const accepted =
        input.revision === revision && input.generation === generation && !quarantined;
      if (accepted) {
        quarantined = true;
        revision++;
      }
      return { accepted, revision };
    },
  };
  return { api, calls };
}

test("acceptance checks disable/enable/reload and generation quarantine using frozen APIs", async () => {
  const { api, calls } = apiFixture();
  await checkStaticLanguageLifecycle(api, "acme.toy", "toy");
  assert.deepEqual(
    calls.filter(([name]) => name === "setEnabled"),
    [
      ["setEnabled", "dev:0123456789abcdef", false],
      ["setEnabled", "dev:0123456789abcdef", true],
    ],
  );
  assert.equal(calls.filter(([name]) => name === "report").length, 2);
  assert.equal(calls.filter(([name]) => name === "reload").length, 2);
});

test("acceptance rejects an accidentally spawned static plugin", async () => {
  await assert.rejects(
    checkStaticLanguageLifecycle(apiFixture({ running: true }).api, "acme.toy", "toy"),
    /running/,
  );
});

test("acceptance rejects a catalog that retains a disabled language", async () => {
  await assert.rejects(
    checkStaticLanguageLifecycle(apiFixture({ revoke: false }).api, "acme.toy", "toy"),
    /disabled/,
  );
});

test("Electron acceptance entry is syntactically complete without executing T0 stubs", async () => {
  const source = await readFile(new URL("./static-languages-main.ts", import.meta.url), "utf8");
  const result = ts.transpileModule(source, {
    fileName: "static-languages-main.ts",
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  assert.deepEqual(result.diagnostics, []);
});

test("packaged assertion helper exports a callable acceptance entry", async () => {
  const module = await import("./static-languages-packaged.mjs");
  assert.equal(typeof module.checkPackagedStaticLanguages, "function");
});
