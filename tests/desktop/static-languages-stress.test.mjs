import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PluginManager } from "../../packages/plugin-runtime/dist/index.js";
import { writeStaticLanguageFixtures } from "./static-languages-fixtures.mjs";
import {
  HOSTILE_PATTERN,
  HOSTILE_COMPILED_PATTERN,
  STRESS_EVENT_PREFIX,
  waitForHostileTermination,
} from "./static-languages-stress.mjs";

// These children only stay idle. The Node tests validate resource data but never
// match the hostile pattern; tokenization belongs exclusively to Electron.
function childScript(body) {
  return spawn(
    process.execPath,
    [
      "-e",
      `
    const emit = (type) => console.log(${JSON.stringify(STRESS_EVENT_PREFIX)} + JSON.stringify({ type }));
    ${body}
  `,
    ],
    { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "inherit"] },
  );
}

test("stress supervisor kills independently and requires SIGKILL exit evidence", async () => {
  const child = childScript('emit("ready"); emit("regex-entered"); setInterval(() => {}, 1000);');
  const result = await waitForHostileTermination(child, { startupMs: 3000, killMs: 100 });
  assert.equal(result.code, null);
  assert.equal(result.signal, "SIGKILL");
  assert.equal(result.killAccepted, true);
  assert.equal(result.killReason, "tokenization-deadline");
  assert.ok(result.killedAfterReadyMs >= 90);
});

test("stress supervisor rejects a clean exit even after claimed regex entry", async () => {
  await assert.rejects(
    waitForHostileTermination(childScript('emit("ready"); emit("regex-entered");'), {
      startupMs: 3000,
      killMs: 500,
    }),
    /Missing parent SIGKILL/,
  );
});

test("stress supervisor kills a child stuck before readiness and fails acceptance", async () => {
  await assert.rejects(
    waitForHostileTermination(childScript("setInterval(() => {}, 1000);"), {
      startupMs: 100,
      killMs: 100,
    }),
    /startup-timeout/,
  );
});

test("stress supervisor rejects a self-kill instead of the parent's deadline", async () => {
  await assert.rejects(
    waitForHostileTermination(
      childScript(
        'emit("ready"); emit("regex-entered"); setTimeout(() => process.kill(process.pid, "SIGKILL"), 10);',
      ),
      { startupMs: 3000, killMs: 500 },
    ),
    /Missing parent SIGKILL/,
  );
});

test("stress supervisor rejects a killed child that never entered Monaco's regex", async () => {
  await assert.rejects(
    waitForHostileTermination(childScript('emit("ready"); setInterval(() => {}, 1000);'), {
      startupMs: 3000,
      killMs: 100,
    }),
    /Missing parent SIGKILL/,
  );
});

test("stress supervisor rejects a tokenizer that returns before the deadline", async () => {
  await assert.rejects(
    waitForHostileTermination(
      childScript(
        'emit("ready"); emit("regex-entered"); emit("regex-returned"); setInterval(() => {}, 1000);',
      ),
      { startupMs: 3000, killMs: 500 },
    ),
    /regex returned/,
  );
});

test("hostile fixture passes real resource validation without document-regex execution", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kobrixa-hostile-validation-"));
  const originalExec = RegExp.prototype.exec;
  let manager;
  try {
    RegExp.prototype.exec = function (text) {
      assert.notEqual(this.source, HOSTILE_PATTERN, "Validator must never match the hostile regex");
      assert.notEqual(this.source, HOSTILE_COMPILED_PATTERN, "Validator must never tokenize");
      return originalExec.call(this, text);
    };
    const paths = await writeStaticLanguageFixtures(directory);
    manager = await PluginManager.create({
      sources: [{ kind: "development", directory: paths.hostile }],
      store: {
        load: async () => ({ disabled: new Set(), legacyDisabledIds: new Set() }),
        save: async () => {},
      },
      safeMode: false,
      locale: "en",
      launcher: async () => {
        throw new Error("Static fixture attempted a process launch");
      },
    });
    assert.deepEqual(manager.state().plugins[0].problems, []);
    const language = manager.staticLanguages().languages[0];
    assert.equal(language.id, "toy-hostile");
    assert.equal(language.tokenizer.states[0].rules[0].regex.pattern, HOSTILE_PATTERN);
    assert.equal(manager.state().plugins[0].running, false);
  } finally {
    RegExp.prototype.exec = originalExec;
    await manager?.shutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
