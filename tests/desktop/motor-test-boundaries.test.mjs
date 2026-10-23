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
  validateLifecycleBarrier,
  nativeCases,
  validateProviderTrace,
  validateNative,
  validateCancellation,
  waitElapsed,
  matchingHoldEnd,
  requireSustainedPause,
  validateFreezeInjection,
  matchingFreezeActivation,
  requireDeliberateResume,
  classifyNativeFailure,
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
    native: ["jog", "jog", "relative-angle"].map((value, at) => ({
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
  const begin = {
    at: 8,
    received: 1,
    channel: "plugins:ui:hold",
    args: [{ binding, nodeId: "a-forward", phase: "begin", inputToken: "original-token" }],
    result: { ok: true, value: { gesture: "original-gesture" } },
  };
  // Renderer clock is slightly before the main marker, as in YN6goJ.
  const release = {
    at: 9.994873046875,
    received: 3,
    type: "pointerup",
    node: "a-forward",
    isTrusted: true,
  };
  const end = {
    at: 10.1,
    received: 4,
    channel: "plugins:ui:hold",
    args: [{ ...begin.args[0], phase: "end" }],
    result: { ok: true },
  };
  const report = {
    native: [],
    faultAt: 10,
    inputReceipts: [release],
    lifecycleReceipt: {
      close: {
        binding,
        clickAt: 12,
        ipcAt: 13,
        bindingGoneAt: 14,
        originalHold: begin,
        holdRelease: { release, end },
        faultReceiptSequence: 2,
        clickReceiptSequence: 4,
      },
    },
    ipc: [
      begin,
      end,
      {
        at: 13,
        received: 5,
        channel: "plugins:ui:close",
        args: [{ binding }],
        result: { ok: true },
      },
    ],
    events: [{ kind: "revoke", time: 13, binding }],
  };
  validateNativeInput(report, scenario);
  for (const mutate of [
    (r) => {
      r.ipc = [];
    },
    (r) => {
      r.ipc[2].args[0].binding.panelInstance = "other-panel";
    },
    (r) => {
      r.events[0].kind = "stop-dispatch";
    },
    (r) => {
      r.lifecycleReceipt.close.bindingGoneAt = 12;
    },
    (r) => {
      r.inputReceipts[0].received = 2;
    },
  ]) {
    // JSON serialization also separates shared sample binding objects.
    const invalid = JSON.parse(JSON.stringify(report));
    mutate(invalid);
    assert.throws(() => validateNativeInput(invalid, scenario));
  }
});

test("close release matching rejects stale, wrong-token/binding and nonmatching hold-end", () => {
  const binding = { panelInstance: "original", processEpoch: "process" };
  const original = { binding, inputToken: "original-token", nodeId: "a-forward", phase: "begin" };
  const release = {
    at: 9.994873046875,
    received: 3,
    type: "pointerup",
    node: "a-forward",
    isTrusted: true,
  };
  const end = {
    at: 10.1,
    received: 4,
    channel: "plugins:ui:hold",
    args: [{ ...original, phase: "end" }],
    result: { ok: true },
  };
  assert.deepEqual(matchingHoldEnd([release], [end], 2, original), { release, end });
  for (const mutate of [
    (r) => {
      r.release.received = 2;
    },
    (r) => {
      r.release.isTrusted = false;
    },
    (r) => {
      r.end.received = 2;
    },
    (r) => {
      r.end.args[0].inputToken = "stale-token";
    },
    (r) => {
      r.end.args[0].binding.processEpoch = "other-process";
    },
    (r) => {
      r.end.args[0].nodeId = "b-forward";
    },
    (r) => {
      r.end.args[0].phase = "cancel";
    },
    (r) => {
      r.end.result.ok = false;
    },
  ]) {
    const sample = structuredClone({ release, end });
    mutate(sample);
    assert.equal(matchingHoldEnd([sample.release], [sample.end], 2, original), undefined);
  }
  assert.equal(
    matchingHoldEnd([{ ...release, type: "keyup", key: "Enter" }], [end], 2, original, "Space"),
    undefined,
  );
});

test("freeze requires actual sustained paused acknowledgement and original-binding expiry", () => {
  const binding = { panelInstance: "original", processEpoch: "process" };
  const revoke = { kind: "revoke", time: 350, binding };
  const report = {
    scenario: { boundary: "pulse" },
    faultAt: 10,
    inputReceipts: [
      { at: 0, received: 1, type: "pointerdown", isTrusted: true, node: "a-forward" },
    ],
    revokedAt: 350,
    events: [revoke],
    freezeVerifiedThrough: 2,
    ipc: [
      {
        at: 1,
        received: 2,
        channel: "plugins:ui:hold",
        args: [
          {
            binding,
            nodeId: "a-forward",
            form: { "a-mode": "jog" },
            phase: "begin",
            inputToken: "token",
          },
        ],
        result: { ok: true, value: { gesture: "gesture" } },
      },
    ],
    debuggerEvents: [
      { at: 0, event: "pause-command-returned" },
      { at: 1, event: "Debugger.paused" },
      { at: 351, event: "expiry-observed", detail: revoke },
      { at: 352, event: "driver-resume-requested" },
      { at: 353, event: "Debugger.resumed" },
      { at: 354, event: "detach" },
    ],
  };
  report.lifecycleReceipt = {
    freezeActivation: { binding, after: 0, through: 2, original: structuredClone(report.ipc[0]) },
  };
  requireSustainedPause(report.debuggerEvents, 2);
  validateFreezeInjection(report);
  for (const mutate of [
    (r) => {
      r.debuggerEvents[1].event = "pause-command-returned";
    },
    (r) => {
      r.debuggerEvents.splice(2, 0, { at: 2, event: "Debugger.resumed" });
      r.freezeVerifiedThrough++;
    },
    (r) => {
      r.debuggerEvents.splice(2, 0, { at: 2, event: "detach" });
      r.freezeVerifiedThrough++;
    },
    (r) => {
      r.debuggerEvents.splice(
        2,
        0,
        { at: 2, event: "Debugger.resumed" },
        { at: 3, event: "Debugger.paused" },
      );
      r.freezeVerifiedThrough += 2;
    },
    (r) => {
      r.debuggerEvents[2].detail = { ...revoke, binding: { ...binding, panelInstance: "other" } };
    },
    (r) => {
      r.debuggerEvents[4].event = "command-returned";
    },
    (r) => {
      r.debuggerEvents[1].at = 351;
    },
    (r) => {
      r.debuggerEvents.splice(4, 0, { at: 352.5, event: "detach" });
    },
    (r) => {
      r.debuggerEvents.splice(3, 0, { at: 351, event: "Debugger.resumed" });
    },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateFreezeInjection(invalid));
  }
  assert.throws(
    () => requireSustainedPause([{ event: "pause-command-returned", at: 0 }], 1),
    /Invalid renderer-freeze injection/,
  );
  assert.throws(
    () =>
      requireSustainedPause(
        [
          { event: "Debugger.paused", at: 0 },
          { event: "Debugger.resumed", at: 1 },
        ],
        2,
      ),
    /Invalid renderer-freeze injection/,
  );
});

// These are predicate samples only; they are never emitted as native receipts.
for (const mode of ["relative-angle", "jog"]) {
  test(`freeze exact original activation: ${mode}`, () => {
    const hold = mode === "jog";
    const binding = { panelInstance: "original", processEpoch: "process", generation: 3 };
    const input = {
      at: 1,
      received: 11,
      type: hold ? "pointerdown" : "pointerup",
      isTrusted: true,
      node: hold ? "a-forward" : "a-start",
    };
    const original = {
      at: 2,
      received: 12,
      channel: hold ? "plugins:ui:hold" : "plugins:ui:invoke",
      args: [
        {
          binding,
          nodeId: input.node,
          form: { "a-mode": mode },
          ...(hold ? { phase: "begin", inputToken: "original-token" } : {}),
        },
      ],
      result: { ok: true, value: hold ? { gesture: "original-gesture" } : { fieldErrors: [] } },
    };
    const revoke = { kind: "revoke", time: 350, binding };
    const report = {
      scenario: { boundary: hold ? "pulse" : "arm" },
      faultAt: 3,
      revokedAt: 350,
      inputReceipts: [input],
      ipc: [original],
      events: [revoke],
      freezeVerifiedThrough: 1,
      lifecycleReceipt: {
        freezeActivation: { binding, after: 10, through: 12, original: structuredClone(original) },
      },
      debuggerEvents: [
        { at: 4, event: "Debugger.paused" },
        { at: 351, event: "expiry-observed", detail: revoke },
        { at: 352, event: "driver-resume-requested" },
        { at: 353, event: "Debugger.resumed" },
      ],
    };
    assert.deepEqual(
      matchingFreezeActivation([input], [original], binding, 10, 12, mode),
      original,
    );
    for (const position of ["before", "after"])
      validateFreezeInjection(report, { ...report.scenario, position });
    for (const mutate of [
      (r) => {
        r.ipc[0].args[0].binding.generation++;
      },
      (r) => {
        r.ipc[0].args[0].nodeId = "other-action";
      },
      (r) => {
        r.ipc[0].args[0].form["a-mode"] = "timed";
      },
      (r) => {
        r.ipc[0].channel = hold ? "plugins:ui:invoke" : "plugins:ui:hold";
      },
      (r) => {
        r.ipc[0].result.ok = false;
      },
      (r) => {
        r.ipc[0].error = "failed";
      },
      (r) => {
        r.ipc[0].received = 10;
      },
      (r) => {
        r.ipc[0].received = 13;
      },
      (r) => {
        r.ipc[0].at = 5;
      },
      (r) => {
        r.inputReceipts[0].isTrusted = false;
      },
      (r) => {
        r.inputReceipts[0].node = "other-action";
      },
      (r) => {
        r.inputReceipts[0].type = "pointercancel";
      },
      (r) => {
        r.inputReceipts[0].received = 9;
      },
      (r) => {
        r.inputReceipts[0].received = 13;
      },
      ...(hold
        ? [
            (r) => {
              delete r.ipc[0].args[0].inputToken;
            },
            (r) => {
              r.ipc[0].args[0].inputToken = "other-token";
            },
            (r) => {
              r.ipc[0].args[0].phase = "end";
            },
            (r) => {
              delete r.ipc[0].result.value.gesture;
            },
            (r) => {
              r.ipc[0].result.value.gesture = "other-gesture";
            },
          ]
        : [
            (r) => {
              r.ipc[0].result.value.fieldErrors = [{ field: "a-power" }];
            },
          ]),
    ]) {
      const invalid = structuredClone(report);
      mutate(invalid);
      assert.throws(() => validateFreezeInjection(invalid));
    }
    if (hold) {
      const keyboard = { ...input, type: "keydown", key: " ", repeat: false };
      assert.ok(matchingFreezeActivation([keyboard], [original], binding, 10, 12, mode, "Space"));
      for (const changed of [{ key: "Enter" }, { repeat: true }, { type: "keyup" }])
        assert.equal(
          matchingFreezeActivation(
            [{ ...keyboard, ...changed }],
            [original],
            binding,
            10,
            12,
            mode,
            "Space",
          ),
          undefined,
        );
    }
  });
}

test("freeze resume failures classify before cleanup and preserve safety failures", async () => {
  const timeout = new Error("Timed out: Debugger.resumed after deliberate driver release");
  for (const failure of ["timeout", "detach", "detach-then-ack", "command"]) {
    const events = [{ at: 0, event: "driver-resume-requested" }];
    await assert.rejects(
      requireDeliberateResume(
        events,
        0,
        async () => {
          if (failure === "command") throw new Error("resume command failed");
        },
        async (predicate) => {
          if (["detach", "detach-then-ack"].includes(failure))
            events.push({ at: 1, event: "detach" });
          if (failure === "detach-then-ack") events.push({ at: 2, event: "Debugger.resumed" });
          if (!predicate()) throw timeout;
        },
      ),
      (error) => {
        assert.equal(classifyNativeFailure(error), "invalid-fault-injection");
        assert.match(String(error), /Invalid renderer-freeze injection: deliberate resume failed/);
        if (failure === "timeout") assert.equal(error.cause, timeout);
        return true;
      },
    );
  }
  const events = [{ at: 0, event: "driver-resume-requested" }];
  await requireDeliberateResume(
    events,
    0,
    async () => {
      events.push({ at: 1, event: "Debugger.resumed" }, { at: 2, event: "detach" });
    },
    async (predicate) => assert.equal(predicate(), true),
  );
  const safety = new Error("No late consequential write");
  const classification = classifyNativeFailure(safety);
  events.push({ at: 3, event: "cleanup-resume-failed" });
  assert.equal(classification, "safety-or-driver-assertion");
  assert.equal(classifyNativeFailure(safety), classification);
  assert.equal(
    classifyNativeFailure(safety, "Invalid renderer-freeze injection: detached"),
    "invalid-fault-injection",
  );
  assert.equal(safety.message, "No late consequential write");
});

// Real broker and fake transport: all lifecycle routes must admit stop while the
// original exchange is held, then acknowledge only after that exchange releases.
for (const fault of ["motor-disable", "provider-disable", "suspend", "disconnect"]) {
  test(`held pulse lifecycle barrier: ${fault}`, { timeout: 15000 }, async () => {
    const c = await compose();
    let held = false;
    let disposition;
    try {
      await until(() => c.states.state(c.owner, c.panel.binding).value?.data.available, "catalog");
      await c.invoke("select-current");
      c.fake.control.block("after-exchange", "motion-pulse");
      held = true;
      await c.invoke("jog", { ...c.panel.form, "a-mode": "jog" }, "begin");
      await c.fake.control.reached("after-exchange", "motion-pulse");
      const pulse = c.fake.control
        .trace()
        .find((r) => r.step === "motion-pulse" && r.dispatch === "sent");
      assert.ok(pulse);
      const query = async () => {
        const result = await c.broker.request(
          c.principal,
          "devices/motion/query",
          { operationId: pulse.operationId },
          new AbortController().signal,
        );
        assert.ok(result.ok);
        return result.value.operation;
      };
      const before = await query();
      assert.equal(before.stopRequested, false);
      if (fault === "motor-disable")
        disposition = c.broker.resources.retire(c.owner, "disabled").settled;
      else if (fault === "provider-disable") {
        const session = await c.broker.request(
          c.principal,
          "devices/session",
          { sessionId: before.sessionId },
          new AbortController().signal,
        );
        assert.ok(session.ok);
        disposition = c.broker.resources.retireProvider(
          c.fake.provider.id,
          session.value.session.providerGeneration,
        );
      } else
        disposition = c.quiesceForTest(
          before.sessionId,
          fault === "suspend" ? "suspended" : "core-disconnect",
        ).settled;
      const admitted = await query();
      assert.equal(admitted.operationId, pulse.operationId);
      assert.equal(admitted.sessionId, before.sessionId);
      assert.equal(admitted.stopRequested, true);
      assert.equal(admitted.brakeRequired, true);
      assert.equal(admitted.phase, "stopping");
      assert.equal(
        c.fake.control.trace().some((r) => r.step === "stop"),
        false,
        "Hardware stop cannot enter the occupied original lane",
      );
      assert.ok(performance.now() < pulse.time + 2000, "No exchange timeout accepted");
      c.fake.control.release("after-exchange", "motion-pulse");
      held = false;
      const result = await disposition;
      assert.equal(result.stopConfirmed, true);
      assert.equal(result.journalCommitted, true);
      const terminal = await query();
      assert.equal(terminal.stopConfirmation, "confirmed");
      assert.equal(terminal.sessionId, before.sessionId);
      for (const step of ["stop", "readback"])
        assert.ok(
          c.fake.control
            .trace()
            .some(
              (r) =>
                r.operationId === pulse.operationId && r.step === step && r.dispatch === "sent",
            ),
        );
      assert.deepEqual(
        c.fake.control
          .trace()
          .filter(
            (r) =>
              r.time > pulse.time &&
              ["helper-upload", "helper-run", "helper-arm", "motion-pulse"].includes(r.step) &&
              r.dispatch !== "not-sent",
          ),
        [],
      );
    } finally {
      if (held) c.fake.control.release("after-exchange", "motion-pulse");
      await disposition;
      await c.dispose();
    }
  });
}

test("lifecycle receipt rejects wrong original identity, timeout, and cleanup-only acknowledgement", () => {
  const before = { operationId: "original", sessionId: "session", stopRequested: false };
  const admitted = {
    ...before,
    stopRequested: true,
    startAccepted: true,
    brakeRequired: true,
    phase: "stopping",
  };
  const owner = { hostEpoch: "host", processEpoch: "process" };
  const report = {
    owner,
    operationId: "original",
    faultAt: 10,
    stoppedAt: 16,
    terminal: { sessionId: "session", stopConfirmation: "confirmed" },
    lifecycleReceipt: {
      stopBarrier: {
        owner,
        originalFault: {
          operationId: "original",
          sessionId: "session",
          owner: { kind: "plugin", owner },
        },
        before,
        admitted,
        admittedAt: 11,
        releasedAt: 12,
        exchangeDeadline: 20,
      },
    },
    hostQueries: [before, admitted].map((operation) => ({
      result: { ok: true, value: { operation } },
    })),
    trace: ["stop", "readback"].map((step, i) => ({
      operationId: "original",
      step,
      dispatch: "sent",
      time: 13 + i,
    })),
  };
  const scenario = { boundary: "pulse", position: "after", fault: "suspend" };
  validateLifecycleBarrier(report, scenario);
  for (const mutate of [
    (r) => {
      r.lifecycleReceipt.stopBarrier.owner.processEpoch = "other";
    },
    (r) => {
      r.lifecycleReceipt.stopBarrier.admitted.operationId = "other";
    },
    (r) => {
      r.lifecycleReceipt.stopBarrier.admitted.sessionId = "other";
    },
    (r) => {
      r.lifecycleReceipt.stopBarrier.admitted.stopRequested = false;
    },
    (r) => {
      r.lifecycleReceipt.stopBarrier.admitted.phase = "timeout";
    },
    (r) => {
      r.lifecycleReceipt.stopBarrier.releasedAt = 20;
    },
    (r) => {
      r.lifecycleReceipt.stopBarrier.originalFault.owner.owner.processEpoch = "other";
    },
    (r) => {
      r.hostQueries = [];
    },
    (r) => {
      r.trace[0].operationId = "other";
    },
    (r) => {
      r.trace[1].time = 17;
    },
    (r) => {
      r.trace[1].time = 11;
    },
    (r) => {
      r.terminal.stopConfirmation = "unconfirmed";
    },
  ]) {
    const invalid = JSON.parse(JSON.stringify(report));
    mutate(invalid);
    assert.throws(() => validateLifecycleBarrier(invalid, scenario));
  }
});

// Validator samples only; never emitted as execution receipts.
test("orphan observation waits through an early timer wake without rounding the evidence", async () => {
  let time = 0;
  const waits = [];
  const elapsed = await waitElapsed(
    5000,
    () => time,
    async (ms) => {
      waits.push(ms);
      time += waits.length === 1 ? 4999.5 : ms;
    },
  );
  assert.deepEqual(waits, [5000, 1]);
  assert.equal(elapsed, 5000.5);
});
test("transport cancellation is only valid for an observed request", () => {
  const request = {
    at: 1,
    direction: "plugin-host",
    message: { id: 3, method: "devices/motion/start" },
  };
  const cancel = {
    at: 2,
    direction: "plugin-host",
    message: { method: "$/cancelRequest", params: { id: 3 } },
  };
  validateCancellation(cancel, [request, cancel]);
  for (const invalid of [
    { ...cancel, at: 0 },
    { ...cancel, message: { ...cancel.message, id: 5 } },
    { ...cancel, message: { ...cancel.message, params: { id: 8 } } },
    { ...cancel, message: { ...cancel.message, params: { id: 3, other: true } } },
  ])
    assert.throws(() => validateCancellation(invalid, [request, invalid]));
});
test("disconnect trace retains original motor identity and ordered separate connection operations", () => {
  const report = {
    operationId: "motion",
    terminal: { sessionId: "old" },
    lifecycleReceipt: {
      reconnected: { ok: true, value: { session: { sessionId: "new", state: "connected" } } },
    },
    trace: [
      { step: "stop", dispatch: "sent", operationId: "motion", time: 1 },
      { step: "readback", dispatch: "sent", operationId: "motion", time: 2 },
      { step: "disconnect", dispatch: "not-sent", operationId: "disconnect", time: 3 },
      { step: "disconnect", dispatch: "sent", operationId: "disconnect", time: 4 },
      { step: "connect", dispatch: "not-sent", operationId: "connect", time: 5 },
      { step: "connect", dispatch: "sent", operationId: "connect", time: 6 },
    ],
  };
  validateProviderTrace(report, { fault: "disconnect" });
  assert.throws(() => validateProviderTrace(report, { fault: "hide" }));
  for (const mutate of [
    (r) => {
      r.trace[0].operationId = "foreign";
    },
    (r) => {
      r.trace[4].time = 1;
    },
    (r) => {
      r.trace.push({ ...r.trace[5] });
    },
    (r) => {
      r.trace[3].operationId = "other";
    },
    (r) => {
      r.lifecycleReceipt.reconnected.value.session.sessionId = "old";
    },
    (r) => {
      r.lifecycleReceipt.error = "failed";
    },
  ]) {
    const invalid = structuredClone(report);
    mutate(invalid);
    assert.throws(() => validateProviderTrace(invalid, { fault: "disconnect" }));
  }
});

test("core Stop binds native IPC, queried snapshots and sent hardware evidence", async (t) => {
  // Selected records/fields from retained kRcDR0/start-before-stop-timed-invalid-stop/report.json.
  // Exact observed values, including revisions and fractional timestamps; presentation
  // samples retain timestamps only. This is a validator fixture, not a new execution receipt.
  const report = {
    kind: "motor-public-native",
    composition: "composeDesktopMain/createDesktopFoundation",
    scenario: {
      boundary: "start",
      position: "before",
      fault: "stop",
      mode: "timed",
      parity: "invalid-stop",
    },
    artifact: {
      harnessSha256: {
        "motor-test-public-main.ts":
          "688b768de566b24e18340378eb6ed7eda1b9a62ef22eef2ec361cc13a0d19266",
        "motor-test-public-renderer.tsx":
          "514990073a7450f203a44f054e993b6f50d2849a5d04202353f4b9bf7a13c30c",
        "motor-test-public-run.mjs":
          "3982fffa8348b213bbc45dbcb008ff72f732fb88f2dadfb1fa56e029f299ef79",
        "motor-test-smoke.mjs": "33e63fa1bcadf52ca67c437dd6bba32a0aa50f17bdd603ada713800461a4e39a",
        "motor-test-public.test.mjs":
          "4472a2ce16a2687789211916ee865bf804ee5557486d0a8f66355ac58938c1cb",
        "motor-test-boundaries.test.mjs":
          "4f8c03baff67bd1750679db6becc187f1695ae893a9c1c67a8c8dfcd52cae66d",
      },
      entry: "plugins/motor-test/src/main.ts",
      sha256: {
        "src/main.ts": "bc244191eaa95fa0830431ce852ccbacb6906e05eb08429f2dc05d44f1ffcc55",
        "src/feature.ts": "b494c0aeea5c450e2b954c5fad27a78184db8e416e01ed2ca8f1975dd7b404dd",
        "src/model.ts": "a36e5bd43a72ad91c74bbf09052ffaa9c0056accb79787bd4841b4e05e84316c",
        "kobrixa-plugin.json": "f556a7fbdf65eeee6f26e0c233c80b8f0c1e6712050d547204795a5fdc1792d6",
        "panel.json": "1a68d65232df2b559e53ad80fe708439121ef6cbb8800da366733cf6fd815c9b",
        "status.json": "644d91d7c69295bf072e6e4846e17fd4618135e71dcfbfafc7436557134e4781",
      },
      bundleSha256: "ca05882d4543c7292486c35075b66fc5fba5b1087992b134ddf6d721a163be0c",
      nativeBuildSha256: {
        "main.cjs": "c7535ce6c2388594bdd68bd43fc339798d8afa6cb1033d6e4782c70bbef1fd1a",
        "template/preload.cjs": "b61153c2b9bb2c2f9cdcd22779ba7bee9d641d95cd5885412511c73ce2732e80",
        "template/source/main.cjs":
          "2f37e54218d91f96d1a6163653dcda49939edcf3df6043bed4d877e5e2d147ab",
        "template/renderer/index.html":
          "e8fc5468837a297ebe3448605851d37803982203ecec3bdd006a413733736b8c",
        "template/renderer/assets/index-Ctv-p2WS.css":
          "35b19a04601f52a29ec5472c63ac8fe5b97c1ef863157b2bfa48bdb15271ec83",
        "template/renderer/assets/index-DWmIIMqB.js":
          "e081884b28c6755f589bc17ce5b32c4f583228519269f6a4c3cc6e5a414475c5",
      },
    },
    stdout:
      'Motor native case {"boundary":"start","position":"before","fault":"stop","mode":"timed","parity":"invalid-stop"}\n[plugin kobrixa.motor-test] MOTOR_PID:76295\n',
    faultAt: 1792712907854.564,
    revokedAt: 1792712907854.564,
    stoppedAt: 1792712908017.3796,
    operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
    terminal: {
      operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
      sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
      revision: 5,
      phase: "stopped",
      stage: "terminal",
      startAccepted: true,
      stopRequested: true,
      dispatch: "unknown",
      movement: "interrupted",
      stopConfirmation: "confirmed",
      brakeRequired: true,
      elapsedMs: 0,
      angle: null,
      displacement: null,
      preparedRemainingMs: 0,
    },
    trace: [
      {
        step: "stop",
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        time: 1792712907995.8372,
        dispatch: "not-sent",
      },
      {
        step: "stop",
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        time: 1792712907995.8535,
        dispatch: "sent",
      },
      {
        step: "readback",
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        time: 1792712907995.895,
        dispatch: "not-sent",
      },
      {
        step: "readback",
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        time: 1792712907995.9717,
        dispatch: "sent",
      },
    ],
    traceAtRevoke: 0,
    lifecycleReceipt: {
      coreStop: {
        admitted: {
          operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
          sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
          revision: 3,
          phase: "stopping",
          stage: "readback",
          startAccepted: true,
          stopRequested: true,
          dispatch: "unknown",
          movement: "not-started",
          stopConfirmation: "pending",
          brakeRequired: true,
          elapsedMs: 0,
          angle: null,
          displacement: null,
          preparedRemainingMs: 0,
        },
        admittedAt: 1792712907995.371,
      },
      coreStopInvocation: {
        at: 1792712907961.6553,
        channel: "plugins:ui:invoke",
        args: [
          {
            binding: {
              contributionId: "kobrixa.motor-test.panel",
              panelInstance: "4cf1fda9-2195-4c0b-b7ad-f0fe91096de8",
              kind: "panel",
              uiResourceGeneration: 4,
              generation: 0,
              hostEpoch: "33c33306-0ca3-4640-9bfc-8bdfca111547",
              processEpoch: "8e545e6b-239d-4c7a-b3de-c53397fc14b4",
            },
            formRevision: 2,
            form: {},
            nodeId: "stop",
          },
        ],
        result: {
          ok: true,
          value: {
            output: {},
            fieldErrors: [],
          },
        },
      },
    },
    hostQueries: [
      {
        at: 1792712907995.358,
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        result: {
          ok: true,
          value: {
            operation: {
              operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
              sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
              revision: 3,
              phase: "stopping",
              stage: "readback",
              startAccepted: true,
              stopRequested: true,
              dispatch: "unknown",
              movement: "not-started",
              stopConfirmation: "pending",
              brakeRequired: true,
              elapsedMs: 0,
              angle: null,
              displacement: null,
              preparedRemainingMs: 0,
            },
          },
        },
      },
      {
        at: 1792712907995.682,
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        result: {
          ok: true,
          value: {
            operation: {
              operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
              sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
              revision: 3,
              phase: "stopping",
              stage: "readback",
              startAccepted: true,
              stopRequested: true,
              dispatch: "unknown",
              movement: "not-started",
              stopConfirmation: "pending",
              brakeRequired: true,
              elapsedMs: 0,
              angle: null,
              displacement: null,
              preparedRemainingMs: 0,
            },
          },
        },
      },
      {
        at: 1792712908006.6802,
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        result: {
          ok: true,
          value: {
            operation: {
              operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
              sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
              revision: 4,
              phase: "stopped",
              stage: "terminal",
              startAccepted: true,
              stopRequested: true,
              dispatch: "unknown",
              movement: "interrupted",
              stopConfirmation: "confirmed",
              brakeRequired: true,
              elapsedMs: 0,
              angle: null,
              displacement: null,
              preparedRemainingMs: 0,
            },
          },
        },
      },
      {
        at: 1792712908017.3523,
        operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
        result: {
          ok: true,
          value: {
            operation: {
              operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
              sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
              revision: 5,
              phase: "stopped",
              stage: "terminal",
              startAccepted: true,
              stopRequested: true,
              dispatch: "unknown",
              movement: "interrupted",
              stopConfirmation: "confirmed",
              brakeRequired: true,
              elapsedMs: 0,
              angle: null,
              displacement: null,
              preparedRemainingMs: 0,
            },
          },
        },
      },
    ],
    final: {
      owners: 0,
      bindings: 0,
      subscriptions: 0,
      queuedEvents: 0,
      queuedBytes: 0,
      timers: 0,
      pendingInvocations: 0,
      actionTokens: 0,
      resourceReaders: 0,
      workerJobs: 0,
    },
    failures: [],
    orphanCheckMs: 5002.091709,
    remainingPids: [],
    counterSamples: [
      {
        at: 1792712906846.346,
        label: "composed",
        counters: {
          owners: 0,
          bindings: 0,
          subscriptions: 0,
          queuedEvents: 0,
          queuedBytes: 0,
          timers: 0,
          pendingInvocations: 0,
          actionTokens: 0,
          resourceReaders: 0,
          workerJobs: 0,
        },
      },
      {
        at: 1792712907854.5105,
        label: "boundary",
        counters: {
          owners: 0,
          bindings: 0,
          subscriptions: 0,
          queuedEvents: 0,
          queuedBytes: 0,
          timers: 2,
          pendingInvocations: 0,
          actionTokens: 2,
          resourceReaders: 0,
          workerJobs: 0,
        },
      },
      {
        at: 1792712908528.1018,
        label: "disposed",
        counters: {
          owners: 0,
          bindings: 0,
          subscriptions: 0,
          queuedEvents: 0,
          queuedBytes: 0,
          timers: 0,
          pendingInvocations: 0,
          actionTokens: 0,
          resourceReaders: 0,
          workerJobs: 0,
        },
      },
    ],
    parity: {
      invalidStop: {
        raw: "bad",
        fieldErrorVisible: true,
      },
    },
    ipc: [
      {
        at: 1792712907961.6553,
        channel: "plugins:ui:invoke",
        args: [
          {
            binding: {
              contributionId: "kobrixa.motor-test.panel",
              panelInstance: "4cf1fda9-2195-4c0b-b7ad-f0fe91096de8",
              kind: "panel",
              uiResourceGeneration: 4,
              generation: 0,
              hostEpoch: "33c33306-0ca3-4640-9bfc-8bdfca111547",
              processEpoch: "8e545e6b-239d-4c7a-b3de-c53397fc14b4",
            },
            formRevision: 2,
            form: {},
            nodeId: "stop",
          },
        ],
        result: {
          ok: true,
          value: {
            output: {},
            fieldErrors: [],
          },
        },
      },
    ],
    inputReceipts: [
      {
        at: 1792712907929.2,
        type: "pointerdown",
        isTrusted: true,
        node: "stop",
        key: null,
        repeat: null,
      },
      {
        at: 1792712907961.4001,
        type: "pointerup",
        isTrusted: true,
        node: "stop",
        key: null,
        repeat: null,
      },
    ],
    native: [
      {
        at: 1792712907028.8179,
        type: "mouseDown",
        detail: {
          x: 40,
          y: 134,
        },
      },
      {
        at: 1792712907278.5996,
        type: "mouseDown",
        detail: {
          x: 320,
          y: 362,
        },
      },
      {
        at: 1792712907412.2327,
        type: "mouseDown",
        detail: {
          x: 320,
          y: 366,
        },
      },
      {
        at: 1792712907512.8481,
        type: "mode-observed",
        detail: {
          value: "jog",
          focused: true,
        },
      },
      {
        at: 1792712907548.2375,
        type: "mode-observed",
        detail: {
          value: "jog",
          focused: true,
        },
      },
      {
        at: 1792712907612.4495,
        type: "mode-observed",
        detail: {
          value: "timed",
          focused: true,
        },
      },
      {
        at: 1792712907680.1516,
        type: "mouseDown",
        detail: {
          x: 320,
          y: 366,
        },
      },
      {
        at: 1792712907778.9412,
        type: "mouseDown",
        detail: {
          x: 320,
          y: 366,
        },
      },
      {
        at: 1792712907928.9014,
        type: "mouseDown",
        detail: {
          x: 320,
          y: 366,
        },
      },
    ],
    wire: [
      {
        at: 1792712907700.8135,
        direction: "plugin-host",
        message: {
          jsonrpc: "2.0",
          id: 43,
          method: "devices/motion/prepare",
          params: {
            sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
            contextRef: "39645382-a237-4417-989a-190461a727c7",
            motionScopeRef: "e9e36378-9bfd-4cf0-bb37-128f783e798c",
            motion: {
              actuatorId: "00000000-0000-4000-8000-000000000002",
              power: 20,
              direction: 1,
              brake: true,
              mode: "timed",
              durationMs: 1000,
            },
          },
        },
      },
      {
        at: 1792712907703.0547,
        direction: "host-plugin",
        message: {
          jsonrpc: "2.0",
          id: 43,
          result: {
            ok: true,
            value: {
              operation: {
                operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
                sessionId: "f463908f-87a7-47bd-b02f-327392c97878",
                revision: 1,
                phase: "preparing",
                stage: "prepared",
                startAccepted: false,
                stopRequested: false,
                dispatch: "not-sent",
                movement: "not-started",
                stopConfirmation: "not-required",
                brakeRequired: true,
                elapsedMs: 0,
                angle: null,
                displacement: null,
                preparedRemainingMs: 4999,
              },
            },
          },
        },
      },
      {
        at: 1792712907706.455,
        direction: "plugin-host",
        message: {
          jsonrpc: "2.0",
          id: 47,
          method: "devices/motion/start",
          params: {
            operationId: "868b57db-4faa-4b86-a55b-221fa6c5b015",
          },
        },
      },
    ],
    presentationSamples: [
      {
        at: 1792712907195.629,
      },
      {
        at: 1792712907196.401,
      },
      {
        at: 1792712907298.578,
      },
      {
        at: 1792712907298.833,
      },
      {
        at: 1792712907403.82,
      },
      {
        at: 1792712907404.153,
      },
      {
        at: 1792712907697.2217,
      },
      {
        at: 1792712907698.6365,
      },
      {
        at: 1792712907798.9302,
      },
      {
        at: 1792712907799.4233,
      },
      {
        at: 1792712907965.8542,
      },
      {
        at: 1792712907966.0994,
      },
      {
        at: 1792712908069.6343,
      },
      {
        at: 1792712908070.209,
      },
    ],
  };
  validateNative(report, report.artifact, report.scenario);
  for (const mutate of [
    (r) => {
      r.lifecycleReceipt.coreStop.admitted.operationId = "other";
    },
    (r) => {
      r.lifecycleReceipt.coreStop.admitted.stopRequested = false;
    },
    (r) => {
      r.ipc = [];
    },
    (r) => {
      r.inputReceipts[0].isTrusted = false;
    },
    (r) => {
      r.lifecycleReceipt.coreStopInvocation.result.ok = false;
    },
    (r) => {
      r.lifecycleReceipt.coreStopInvocation.args[0].form = { power: 20 };
    },
  ]) {
    const invalid = JSON.parse(JSON.stringify(report));
    mutate(invalid);
    assert.throws(() => validateNative(invalid, report.artifact, report.scenario));
  }
  for (const [name, mutate] of [
    [
      "reject every host query failing",
      (r) => {
        for (const q of r.hostQueries) q.result = { ok: false };
      },
    ],
    ...[3, 5].map((revision) => [
      `reject failed revision ${revision} queries despite other successful queries`,
      (r) => {
        for (const q of r.hostQueries)
          if (q.result.value.operation.revision === revision) q.result.ok = false;
      },
    ]),
    [
      "reject foreign terminal operation",
      (r) => {
        r.terminal.operationId = "foreign";
      },
    ],
    [
      "reject only not-sent stop/readback rows",
      (r) => {
        r.trace = r.trace.filter((row) => row.dispatch !== "sent");
      },
    ],
    [
      "reject unobserved admission revision",
      (r) => {
        r.lifecycleReceipt.coreStop.admitted.revision = 999;
      },
    ],
    ...["admission", "terminal"].map((which) => [
      `reject missing ${which} revision even in matching queries`,
      (r) => {
        const snapshot = which === "admission" ? r.lifecycleReceipt.coreStop.admitted : r.terminal;
        for (const q of r.hostQueries)
          if (q.result.value.operation.revision === snapshot.revision)
            delete q.result.value.operation.revision;
        delete snapshot.revision;
      },
    ]),
    [
      "reject unobserved terminal revision",
      (r) => {
        r.terminal.revision = 999;
      },
    ],
    [
      "reject admission queries for another operation",
      (r) => {
        for (const q of r.hostQueries)
          if (q.result.value.operation.revision === 3)
            q.result.value.operation.operationId = "foreign";
      },
    ],
    [
      "reject query session differing from admission",
      (r) => {
        for (const q of r.hostQueries) q.result.value.operation.sessionId = "foreign";
      },
    ],
    [
      "reject consistently foreign session relative to preparation",
      (r) => {
        r.terminal.sessionId = "foreign";
        r.lifecycleReceipt.coreStop.admitted.sessionId = "foreign";
        for (const q of r.hostQueries) q.result.value.operation.sessionId = "foreign";
      },
    ],
    [
      "reject admission queried before Stop IPC",
      (r) => {
        for (const q of r.hostQueries)
          if (q.result.value.operation.revision === 3)
            q.at = r.lifecycleReceipt.coreStopInvocation.at - 1;
      },
    ],
    [
      "reject admission recorded before its query",
      (r) => {
        r.lifecycleReceipt.coreStop.admittedAt = r.hostQueries[0].at - 1;
      },
    ],
    [
      "reject terminal query before admission capture",
      (r) => {
        r.hostQueries.at(-1).at = r.lifecycleReceipt.coreStop.admittedAt - 1;
      },
    ],
    [
      "reject terminal query after stoppedAt",
      (r) => {
        r.hostQueries.at(-1).at = r.stoppedAt + 1;
      },
    ],
    ...["stop", "readback"].flatMap((step) => [
      [
        `reject missing sent ${step}`,
        (r) => {
          r.trace = r.trace.filter((row) => row.step !== step || row.dispatch !== "sent");
        },
      ],
      [
        `reject sent ${step} before Stop IPC`,
        (r) => {
          r.trace.find((row) => row.step === step && row.dispatch === "sent").time =
            r.lifecycleReceipt.coreStopInvocation.at - 1;
        },
      ],
      [
        `reject sent ${step} after terminal query`,
        (r) => {
          r.trace.find((row) => row.step === step && row.dispatch === "sent").time =
            r.hostQueries.at(-1).at + 1;
        },
      ],
      [
        `reject foreign sent ${step}`,
        (r) => {
          r.trace.find((row) => row.step === step && row.dispatch === "sent").operationId =
            "foreign";
        },
      ],
    ]),
    [
      "reject readback preceding stop",
      (r) => {
        r.trace.find((row) => row.step === "readback" && row.dispatch === "sent").time =
          r.trace.find((row) => row.step === "stop" && row.dispatch === "sent").time - 1;
      },
    ],
  ])
    await t.test(name, () => {
      const invalid = structuredClone(report);
      mutate(invalid);
      assert.throws(() => validateNative(invalid, report.artifact, report.scenario));
    });
});
