import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  basicPlusSmokeCatalog,
  createStaticLanguagesHarness,
} from "./static-languages-harness.mjs";

const preload = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
const staticHarness = createStaticLanguagesHarness(await basicPlusSmokeCatalog());
function loadPreload(source = preload, platform = "win32") {
  let api;
  const calls = [];
  const ipcRenderer = new EventEmitter();
  const reply = { kind: "resync", epoch: 7 };
  ipcRenderer.invoke = async (...args) => {
    calls.push(args);
    if (args[0] === "plugins:state") return staticHarness.state();
    if (args[0] === "plugins:static-languages") return staticHarness.staticLanguages();
    if (args[0] === "plugins:report-language-registration-failure")
      return staticHarness.reportLanguageRegistrationFailure(args[1]);
    return reply;
  };
  runInNewContext(source, {
    exports: {},
    process: { platform },
    require: () => ({
      contextBridge: {
        exposeInMainWorld(name, value) {
          assert.equal(name, "kobrixa");
          api = value;
        },
      },
      ipcRenderer,
    }),
  });
  return { api, calls, ipcRenderer, reply };
}

test("smoke preload exposes diagnostic help with the snapshot's catalog revision", async () => {
  const { api } = loadPreload();
  const state = await api.plugins.state();
  const catalog = await api.plugins.diagnosticHelp();
  assert.equal(state.diagnosticHelpRevision, 0);
  assert.equal(catalog.revision, state.diagnosticHelpRevision);
  assert.equal(catalog.plugins["kobrixa.basic-plus"].displayName, "Basic Plus");
  assert.equal(catalog.plugins["kobrixa.basic-plus"].entries.length, 0);
  assert.equal(catalog.plugins["kobrixa.ev3"].entries.length, 0);
});

test("smoke preload forwards language requests and preserves epoch-carrying replies", async () => {
  const { api, calls, reply } = loadPreload();
  const request = { epoch: 7, requestId: "request" };
  for (const [method, name, args] of [
    ["status", "languageStatus", ["workspace", false]],
    ["status", "languageStatus", ["workspace", true]],
    ["feature", "languageFeature", ["workspace", request]],
    ["cancelFeature", "languageCancelFeature", ["workspace", "request"]],
    ["sync", "languageSync", ["workspace", request]],
    ["completionSync", "completionSync", ["workspace", request]],
    ["quickFixes", "diagnosticQuickFixes", ["workspace", request]],
    ["cancelQuickFix", "diagnosticCancelQuickFix", ["workspace", "request"]],
    ["diagnostics", "languageDiagnostics", ["workspace", {}]],
  ]) {
    assert.equal(await api.language[method](...args), reply);
    assert.deepEqual(structuredClone(calls.at(-1)), ["smoke", name, args]);
  }
  await api.language.status("workspace");
  assert.deepEqual(structuredClone(calls.at(-1)), [
    "smoke",
    "languageStatus",
    ["workspace", false],
  ]);
});

test("smoke preload forwards language status events and unsubscribes", () => {
  const { api, ipcRenderer } = loadPreload();
  const received = [];
  const unsubscribe = api.language.onStatus((event) => received.push(event));
  const event = { workspaceId: "workspace", status: { epoch: 7 } };
  ipcRenderer.emit("language:status-changed", {}, event);
  assert.deepEqual(received, [event]);
  unsubscribe();
  ipcRenderer.emit("language:status-changed", {}, event);
  assert.deepEqual(received, [event]);
  assert.equal(ipcRenderer.listenerCount("language:status-changed"), 0);
});

function assertApiKeys(actual, expected, prefix = "kobrixa") {
  for (const key of Object.keys(expected)) {
    const name = `${prefix}.${key}`;
    assert.ok(Object.hasOwn(actual, key), `Smoke preload is missing ${name}`);
    assert.equal(typeof actual[key], typeof expected[key], `${name} has a different type`);
    if (expected[key] && typeof expected[key] === "object")
      assertApiKeys(actual[key], expected[key], name);
  }
}

test("smoke UI observers use separate targeted channels and dispose once", async () => {
  const { api, calls, ipcRenderer } = loadPreload();
  const seen = [[], []];
  const first = api.plugins.ui.onEvent((value) => seen[0].push(value));
  const second = api.plugins.ui.onEvent((value) => seen[1].push(value));
  ipcRenderer.emit("plugins:ui:event:2", {}, { type: "catalog", revision: 4 });
  assert.deepEqual(seen, [[], [{ type: "catalog", revision: 4 }]]);
  first();
  first();
  second();
  assert.equal(ipcRenderer.listenerCount("plugins:ui:event:1"), 0);
  assert.equal(ipcRenderer.listenerCount("plugins:ui:event:2"), 0);
  assert.deepEqual(
    calls.filter((row) => row[0] === "plugins:ui:unsubscribe"),
    [
      ["plugins:ui:unsubscribe", 1],
      ["plugins:ui:unsubscribe", 2],
    ],
  );
  await api.plugins.ui.snapshot({ binding: "opaque" });
  assert.deepEqual(calls.at(-1), ["plugins:ui:snapshot", { binding: "opaque" }]);
});

test("smoke preload contains the real preload's complete API key tree", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src/preload/index.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const platform of ["win32", "darwin", "linux"]) {
    const real = loadPreload(compiled, platform).api;
    const smoke = loadPreload(preload, platform).api;
    assertApiKeys(smoke, real);
    assert.equal(Object.hasOwn(smoke, "windowChrome"), Object.hasOwn(real, "windowChrome"));
  }
  const real = loadPreload(compiled).api;
  const smoke = loadPreload().api;
  // Guard the comparison itself against the drift that prompted this test.
  delete smoke.language.onStatus;
  assert.throws(() => assertApiKeys(smoke, real), /kobrixa\.language\.onStatus/);
  const missingHelp = loadPreload().api;
  delete missingHelp.plugins.diagnosticHelp;
  assert.throws(() => assertApiKeys(missingHelp, real), /kobrixa\.plugins\.diagnosticHelp/);
});

for (const platform of ["win32", "darwin", "linux"]) {
  test(`N1 exposes windowChrome only on Windows (${platform})`, () => {
    const { api } = loadPreload(preload, platform);
    assert.equal(Object.hasOwn(api, "windowChrome"), platform === "win32");
  });
}

test("smoke preload forwards the frozen static-language IPC and disposes event listeners", async () => {
  const { api, calls, ipcRenderer } = loadPreload();
  const state = await api.plugins.state();
  const catalog = await api.plugins.staticLanguages();
  assert.equal(catalog.formatVersion, 1);
  assert.equal(catalog.limitsVersion, 1);
  assert.equal(catalog.revision, state.staticLanguagesRevision);
  assert.equal(state.staticLanguageOwners[0].languageId, "bp");
  assert.deepEqual(structuredClone(calls.slice(-2)), [
    ["plugins:state"],
    ["plugins:static-languages"],
  ]);
  const report = {
    sourceKey: "builtin:kobrixa.basic-plus",
    generation: 1,
    languageId: "bp",
    revision: catalog.revision,
    reason: "monaco",
    detail: "smoke report",
  };
  assert.deepEqual(await api.plugins.reportLanguageRegistrationFailure(report), {
    accepted: false,
    revision: catalog.revision,
  });
  assert.deepEqual(structuredClone(calls.at(-1)), [
    "plugins:report-language-registration-failure",
    report,
  ]);
  const received = [];
  const off = api.plugins.onEvent((event) => received.push(event));
  const event = { type: "state", state };
  ipcRenderer.emit("plugins:event", {}, event);
  off();
  ipcRenderer.emit("plugins:event", {}, event);
  assert.deepEqual(received, [event]);
  assert.equal(ipcRenderer.listenerCount("plugins:event"), 0);
});
