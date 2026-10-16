import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const preload = await readFile(new URL("./preload.cjs", import.meta.url), "utf8");
function loadPreload(source = preload) {
  let api;
  const calls = [];
  const ipcRenderer = new EventEmitter();
  const reply = { kind: "resync", epoch: 7 };
  ipcRenderer.invoke = async (...args) => {
    calls.push(args);
    return reply;
  };
  runInNewContext(source, {
    exports: {},
    process: { platform: "win32" },
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

test("smoke preload contains the real preload's complete API key tree", async () => {
  const source = await readFile(
    new URL("../../apps/desktop/src/preload/index.ts", import.meta.url),
    "utf8",
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const real = loadPreload(compiled).api;
  const smoke = loadPreload().api;
  assertApiKeys(smoke, real);
  // Guard the comparison itself against the drift that prompted this test.
  delete smoke.language.onStatus;
  assert.throws(() => assertApiKeys(smoke, real), /kobrixa\.language\.onStatus/);
  const missingHelp = loadPreload().api;
  delete missingHelp.plugins.diagnosticHelp;
  assert.throws(() => assertApiKeys(missingHelp, real), /kobrixa\.plugins\.diagnosticHelp/);
});
