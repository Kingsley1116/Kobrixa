import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import {
  compose,
  motorArtifacts,
  root,
  until,
  validateNativeInput,
  nativeCases,
} from "./motor-test-public-run.mjs";
const require = createRequire(import.meta.url);
const ts = require("typescript");
const featureRoot = "plugins/motor-test/src/";
const forbidden =
  /window\s*(?:\.|\[)|kobrixa\s*(?:\.|\[)|ipcRenderer|MotorTestService|MotorTestController|MotorApi|motor-test:(?:start|stop|state|keepalive)|devices?:[^/]|(?:node:)?(?:fs|net|tls|http|https|child_process|worker_threads)|node-hid|(?:^|\/)usb(?:\/|$)|electron|react|desktop\/|backend-ev3|helper/i;
export function auditSource(source, filename) {
  const sdk = filename === "packages/plugin-sdk-js/src/index.ts";
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const name = node.moduleSpecifier?.text;
      if (name) assert.ok(!forbidden.test(name), `Forbidden import ${filename}: ${name}`);
      if (filename.startsWith(featureRoot) && name)
        assert.ok(
          name.startsWith("./") ||
            ["@kobrixa/plugin-sdk", "@kobrixa/plugin-protocol"].includes(name),
          `Nonpublic import ${name}`,
        );
    }
    if (ts.isCallExpression(node)) {
      const target = node.expression.getText(tree);
      assert.ok(
        !["import", "require", "eval", "Function"].includes(target),
        `Dynamic/external loading in ${filename}: ${target}`,
      );
    }
    if (ts.isNewExpression(node)) assert.notEqual(node.expression.getText(tree), "Function");
    if (ts.isStringLiteralLike(node))
      assert.ok(
        !/window\.kobrixa|motor-test:(?:start|stop|state|keepalive)|ipcRenderer|MotorTestService|MotorTestController/.test(
          node.text,
        ),
        `Forbidden facade/channel literal ${filename}: ${node.text}`,
      );
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      let expression = node.expression;
      while (
        ts.isParenthesizedExpression(expression) ||
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) ||
        ts.isNonNullExpression(expression)
      )
        expression = expression.expression;
      const base = expression.getText(tree);
      assert.ok(!["window", "globalThis", "global"].includes(base), `Global facade ${filename}`);
      if (base === "process") {
        const member = ts.isPropertyAccessExpression(node)
          ? node.name.text
          : node.argumentExpression?.text;
        // Exact existing SDK transport/launch lifecycle only, never feature exemption.
        assert.ok(
          sdk && ["parentPort", "env", "exit"].includes(member),
          `Process access ${filename}: ${member}`,
        );
      }
    }
    if (filename.startsWith(featureRoot) && ts.isIdentifier(node))
      assert.ok(
        ![
          "window",
          "globalThis",
          "global",
          "ipcRenderer",
          "MotorApi",
          "MotorTestService",
          "MotorTestController",
        ].includes(node.text),
        `Forbidden facade identifier ${node.text}`,
      );
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
export function auditBundle(metadata, code) {
  assert.ok(
    Object.keys(metadata.inputs ?? {}).some((name) =>
      name.endsWith("plugins/motor-test/src/main.ts"),
    ),
  );
  assert.ok(
    Object.keys(metadata.inputs).some((name) =>
      name.endsWith("packages/plugin-sdk-js/src/index.ts"),
    ),
  );
  for (const name of Object.keys(metadata.inputs)) {
    const normalized = name.replaceAll("\\", "/");
    assert.ok(
      normalized.startsWith(featureRoot) ||
        normalized.startsWith("packages/plugin-sdk-js/src/") ||
        normalized.startsWith("packages/plugin-protocol/src/") ||
        /(?:^|\/)node_modules\/.*(?:zod|@eslint-community\/regexpp)\//.test(normalized),
      `Forbidden transitive module ${name}`,
    );
  }
  assert.ok(Object.keys(metadata.outputs ?? {}).length);
  for (const output of Object.values(metadata.outputs))
    assert.deepEqual(output.imports, [], "No runtime externals");
  assert.ok(code.trim().length > 1000);
  assert.ok(
    !/window\.kobrixa|motor-test:(?:start|stop|state|keepalive)|ipcRenderer|MotorTestService|MotorTestController/.test(
      code,
    ),
  );
}
const allowedRpc = new Set([
  "devices/negotiate",
  "devices/list",
  "devices/session",
  "devices/context",
  "devices/subscribe",
  "devices/motion/prepare",
  "devices/motion/start",
  "devices/motion/query",
  "devices/motion/stop",
  "events/ack",
  "events/unsubscribe",
  "ui/instances",
  "ui/state",
  "ui/subscribe",
  "ui/snapshot",
  "ui/patch",
]);
export function auditTrace(wire) {
  const observed = wire.filter((r) => r.direction === "plugin-host" && r.message.method);
  assert.ok(observed.length > 0, "Actual observed requests required");
  for (const row of observed)
    assert.ok(allowedRpc.has(row.message.method), `Forbidden RPC ${row.message.method}`);
  for (const method of [
    "devices/negotiate",
    "devices/list",
    "ui/instances",
    "ui/subscribe",
    "ui/patch",
    "devices/motion/prepare",
    "devices/motion/start",
    "devices/motion/query",
    "devices/motion/stop",
  ])
    assert.ok(
      observed.some((r) => r.message.method === method),
      `Missing actual ${method}`,
    );
}
test(
  "actual motor source graph, transitive bundle and observed SDK RPC agree",
  { timeout: 15000 },
  async () => {
    const artifact = await motorArtifacts();
    auditBundle(artifact.metadata, artifact.code);
    for (const name of Object.keys(artifact.metadata.inputs).filter(
      (name) => !name.includes("node_modules"),
    ))
      auditSource(await readFile(path.join(root, name), "utf8"), name);
    const c = await compose();
    try {
      await until(() => c.wire.some((r) => r.message.method === "ui/patch"), "real presentation");
      await until(
        () => c.states.state(c.owner, c.panel.binding).value?.data.available,
        "session catalog",
      );
      await c.invoke("select-current");
      c.fake.control.block("after-exchange", "motion-pulse");
      try {
        await c.invoke("jog", { ...c.panel.form, "a-mode": "jog" }, "begin");
        await c.fake.control.reached("after-exchange", "motion-pulse");
        await c.invoke("refresh");
        await c.invoke("jog", { ...c.panel.form, "a-mode": "jog" }, "cancel");
        await until(
          () => c.wire.some((r) => r.message.method === "devices/motion/query"),
          "actual query",
        );
        await until(
          () => c.wire.some((r) => r.message.method === "devices/motion/stop"),
          "actual stop",
        );
        auditTrace(c.wire);
      } finally {
        c.fake.control.release("after-exchange", "motion-pulse");
      }
    } finally {
      await c.dispose();
    }
  },
);
test("negative source samples reject private facade, dynamic imports and hidden channels", () => {
  for (const source of [
    'import x from "../../apps/desktop/src/shared/api";',
    'import("@kobrixa/plugin-sdk");',
    'require("node:fs");',
    'window["kobrixa"]["motorTest"].start();',
    'const channel = "motor-test:start";',
    'import React from "react";',
    'process.parentPort.postMessage("start");',
    'globalThis["window"]["kobrixa"].start();',
    "(process as unknown as {parentPort: object}).parentPort;",
  ])
    assert.throws(() => auditSource(source, `${featureRoot}negative.ts`), source);
  assert.throws(() => auditSource('import("node:fs")', "packages/plugin-sdk-js/src/index.ts"));
});
test("negative transitive metadata, external and private RPC samples fail closed", async () => {
  const artifact = await motorArtifacts();
  for (const name of [
    "apps/desktop/src/shared/api.ts",
    "node:fs",
    "packages/backend-ev3/src/index.ts",
  ]) {
    const metadata = structuredClone(artifact.metadata);
    metadata.inputs[name] = {};
    assert.throws(() => auditBundle(metadata, artifact.code));
  }
  const metadata = structuredClone(artifact.metadata);
  Object.values(metadata.outputs)[0].imports.push({ path: "@kobrixa/plugin-sdk", external: true });
  assert.throws(() => auditBundle(metadata, artifact.code));
  assert.throws(() => auditTrace([]));
  for (const method of [
    "motor-test:start",
    "device:execute",
    "devices/connect",
    "devices/private/write",
  ])
    assert.throws(() => auditTrace([{ direction: "plugin-host", message: { method } }]));
});

test("native input contract retains all 77 cases and requires each select acknowledgement", () => {
  assert.equal(nativeCases.length, 77);
  const scenario = { boundary: "arm", fault: "hide" };
  // Validator samples only; these are never emitted as native receipts.
  const report = {
    native: ["jog", "jog", "timed", "relative-angle"].map((value, at) => ({
      at,
      type: "mode-observed",
      detail: { value, focused: true },
    })),
  };
  validateNativeInput(report, scenario);
  for (const mutate of [
    (r) => r.native.splice(2, 1),
    (r) => {
      r.native[2].detail.focused = false;
    },
    (r) => {
      r.native[2].at = r.native[1].at;
    },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateNativeInput(invalid, scenario));
  }
});

test("native close contract rejects pointer release without original-binding close and revoke", () => {
  const scenario = { boundary: "prepare", fault: "close" };
  const binding = { panelInstance: "original-panel" };
  const report = {
    native: [],
    faultAt: 10,
    inputReceipts: [{ at: 11, type: "pointerup", node: "a-forward", isTrusted: true }],
    lifecycleReceipt: { close: { binding, clickAt: 12, ipcAt: 13, bindingGoneAt: 14 } },
    ipc: [{ at: 13, channel: "plugins:ui:close", args: [{ binding }], result: { ok: true } }],
    events: [{ kind: "revoke", time: 13, binding }],
  };
  validateNativeInput(report, scenario);
  for (const mutate of [
    (r) => {
      r.ipc = [];
    },
    (r) => {
      r.ipc[0].args[0].binding.panelInstance = "other-panel";
    },
    (r) => {
      r.events[0].kind = "stop-dispatch";
    },
    (r) => {
      r.lifecycleReceipt.close.bindingGoneAt = 12;
    },
    (r) => {
      r.inputReceipts[0].at = 15;
    },
  ]) {
    // JSON serialization also separates shared sample binding objects.
    const invalid = JSON.parse(JSON.stringify(report));
    mutate(invalid);
    assert.throws(() => validateNativeInput(invalid, scenario));
  }
});
