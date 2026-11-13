import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  readFile,
  mkdtemp,
  writeFile,
  mkdir,
  cp,
  symlink,
  realpath,
  readdir,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { isDeepStrictEqual } from "node:util";
import { spawn } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { rawResourcePlugin } from "./raw-resource-plugin.mjs";

export const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const require = createRequire(import.meta.url);
// Reuse the installed toolchain; never install or resolve another checkout's source.
const toolRequire = createRequire(require.resolve("vitest/package.json"));
const { build } = toolRequire("esbuild");
export const alias = Object.fromEntries(
  [
    ["plugin-sdk", "plugin-sdk-js"],
    ["plugin-protocol", "plugin-protocol"],
    ["plugin-runtime", "plugin-runtime"],
  ].map(([name, folder]) => [
    `@kobrixa/${name}`,
    path.join(root, `packages/${folder}/src/index.ts`),
  ]),
);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export async function motorArtifacts() {
  const files = [
    "src/main.ts",
    "src/feature.ts",
    "src/model.ts",
    "kobrixa-plugin.json",
    "panel.json",
    "status.json",
  ];
  const sha256 = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        digest(await readFile(path.join(root, "plugins/motor-test", name))),
      ]),
    ),
  );
  const harnessSha256 = Object.fromEntries(
    await Promise.all(
      [
        "motor-test-public-main.ts",
        "motor-test-public-renderer.tsx",
        "motor-test-public-run.mjs",
        "motor-test-smoke.mjs",
        "motor-test-public.test.mjs",
        "motor-test-boundaries.test.mjs",
      ].map(async (name) => [name, digest(await readFile(path.join(root, "tests/desktop", name)))]),
    ),
  );
  const feature = await build({
    entryPoints: [path.join(root, "plugins/motor-test/src/main.ts")],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "cjs",
    alias,
  });
  return {
    code: feature.outputFiles[0].text,
    metadata: feature.metafile,
    identity: {
      harnessSha256,
      entry: "plugins/motor-test/src/main.ts",
      sha256,
      bundleSha256: digest(feature.outputFiles[0].contents),
    },
    manifest: JSON.parse(
      await readFile(path.join(root, "plugins/motor-test/kobrixa-plugin.json"), "utf8"),
    ),
    panel: JSON.parse(await readFile(path.join(root, "plugins/motor-test/panel.json"), "utf8")),
    status: JSON.parse(await readFile(path.join(root, "plugins/motor-test/status.json"), "utf8")),
  };
}
let hostModule;
async function loadDriver() {
  if (!hostModule) {
    const host = await build({
      entryPoints: [path.join(root, "tests/desktop/motor-test-public-main.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      alias,
      external: ["electron", "node-hid", "usb"],
      plugins: [rawResourcePlugin()],
    });
    const module = { exports: {} };
    new Function("require", "module", "exports", host.outputFiles[0].text)(
      (name) => (name === "electron" ? {} : require(name)),
      module,
      module.exports,
    );
    hostModule = module.exports;
  }
  return hostModule;
}
const driver = await loadDriver();
export const nativeClick = driver.nativeClick;
export const nativeTargetProbe = driver.nativeTargetProbe;
export const observePanelsBeforeOpen = driver.observePanelsBeforeOpen;
export const matchingHoldEnd = driver.matchingHoldEnd;
export const requireSustainedPause = driver.requireSustainedPause;
export const matchingFreezeActivation = driver.matchingFreezeActivation;
export const requireDeliberateResume = driver.requireDeliberateResume;
export const classifyNativeFailure = driver.classifyNativeFailure;
export const loadMotorRenderer = driver.loadMotorRenderer;
export const acknowledgeRendererPause = driver.acknowledgeRendererPause;
export const observeNativeIpc = driver.observeNativeIpc;
export const requireMotionJournalFilesystem = driver.requireMotionJournalFilesystem;
export async function compose() {
  const artifacts = await motorArtifacts();
  const composition = await driver.composeMotor({
    manifest: artifacts.manifest,
    panel: artifacts.panel,
    status: artifacts.status,
    launch(parentPort, owner) {
      const pluginProcess = Object.create(process);
      pluginProcess.parentPort = parentPort;
      pluginProcess.env = { ...process.env, KOBRIXA_RESOURCE_OWNER: JSON.stringify(owner) };
      pluginProcess.exit = (code) => {
        throw new Error(`Unexpected SDK exit ${code}`);
      };
      vm.runInNewContext(
        artifacts.code,
        {
          process: pluginProcess,
          require,
          console,
          setTimeout,
          clearTimeout,
          setInterval,
          clearInterval,
          AbortController,
          AbortSignal,
          TextEncoder,
          TextDecoder,
          Buffer,
          performance,
          structuredClone,
          queueMicrotask,
          module: { exports: {} },
          exports: {},
        },
        { filename: "actual-motor-main.cjs" },
      );
    },
  });
  return { ...composition, artifacts };
}
export async function until(check, label, timeout = 5000) {
  const deadline = performance.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    assert.ok(performance.now() < deadline, `Missing observation: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
// Timers may wake fractionally early. The observed monotonic duration, rather
// than the requested timeout, is the acceptance boundary.
export async function waitElapsed(ms, now = () => performance.now(), sleep = pause) {
  const started = now();
  let elapsed;
  while ((elapsed = now() - started) < ms) await sleep(Math.ceil(ms - elapsed));
  return elapsed;
}
export function validateCancellation(row, wire) {
  assert.equal(row.message.id, undefined, "Cancellation must be a notification");
  assert.deepEqual(Object.keys(row.message.params ?? {}), ["id"]);
  const request = wire.find(
    (r) =>
      r.direction === "plugin-host" &&
      r.message.id === row.message.params.id &&
      r.message.method !== "$/cancelRequest",
  );
  assert.ok(request && request.at <= row.at, "Cancellation requires an observed original request");
}
export function validateProviderTrace(report, scenario) {
  const cleanup = report.providerCleanup;
  let workload = report.trace;
  if (cleanup) {
    assert.equal(report.expectedBlockedClose, undefined);
    assert.ok(Number.isFinite(cleanup.startedAt) && Number.isFinite(cleanup.finishedAt));
    assert.ok(cleanup.startedAt >= report.stoppedAt && cleanup.finishedAt >= cleanup.startedAt);
    assert.ok(Number.isInteger(cleanup.traceStart) && Number.isInteger(cleanup.traceEnd));
    assert.ok(cleanup.traceStart >= 0 && cleanup.traceStart <= cleanup.traceEnd);
    assert.equal(cleanup.traceEnd, report.trace.length, "No provider work after awaited cleanup");
    const retired = report.trace.slice(cleanup.traceStart, cleanup.traceEnd);
    if (scenario.fault === "provider-disable")
      assert.equal(
        retired.length,
        0,
        "Provider-disable retirement must leave no cleanup disconnect",
      );
    for (const row of retired) {
      assert.equal(row.step, "disconnect", "Retirement cannot reconnect or move motors");
      assert.ok(row.time >= cleanup.startedAt && row.time <= cleanup.finishedAt);
    }
    if (retired.length) {
      assert.deepEqual(
        retired.map((row) => row.dispatch),
        ["not-sent", "sent"],
      );
      assert.ok(retired[0].operationId && retired[0].operationId !== report.operationId);
      assert.equal(retired[0].operationId, retired[1].operationId);
      assert.ok(
        !report.trace
          .slice(0, cleanup.traceStart)
          .some((row) => row.operationId === retired[0].operationId),
      );
      assert.ok(retired[1].time >= retired[0].time);
    }
    workload = report.trace.slice(0, cleanup.traceStart);
  }
  const connections = workload.filter((r) => ["connect", "disconnect"].includes(r.step));
  assert.ok(
    report.trace
      .filter((r) => !["connect", "disconnect"].includes(r.step))
      .every((r) => r.operationId === report.operationId),
    "Motor provider trace must belong to original operation",
  );
  if (scenario.fault === "provider-disable") {
    const retirement = report.lifecycleReceipt?.providerRetirement;
    assert.ok(
      retirement && Number.isFinite(retirement.startedAt) && Number.isFinite(retirement.finishedAt),
    );
    assert.ok(
      retirement.startedAt >= report.faultAt && retirement.finishedAt >= retirement.startedAt,
    );
    assert.ok(!cleanup || retirement.finishedAt <= cleanup.startedAt);
    assert.equal(report.lifecycleReceipt.error, undefined);
    assert.deepEqual(
      connections.map((row) => [row.step, row.dispatch]),
      [
        ["disconnect", "not-sent"],
        ["disconnect", "sent"],
      ],
    );
    const [admitted, sent] = connections;
    assert.ok(admitted.operationId && admitted.operationId !== report.operationId);
    assert.equal(sent.operationId, admitted.operationId);
    const readback = workload.findLast((row) => row.step === "readback" && row.dispatch === "sent");
    assert.ok(readback && readback.operationId === report.operationId);
    assert.ok(admitted.time >= readback.time && admitted.time >= retirement.startedAt);
    assert.ok(sent.time >= admitted.time && sent.time <= retirement.finishedAt);
    return;
  }
  if (scenario.fault !== "disconnect") return assert.deepEqual(connections, []);
  assert.equal(report.lifecycleReceipt?.error, undefined);
  const reconnected = report.lifecycleReceipt?.reconnected;
  assert.equal(reconnected?.ok, true);
  assert.notEqual(reconnected.value.session.sessionId, report.terminal.sessionId);
  assert.equal(reconnected.value.session.state, "connected");
  const ids = [];
  let previous = report.trace.findLast((r) => r.step === "readback" && r.dispatch === "sent");
  assert.ok(previous && previous.operationId === report.operationId);
  for (const step of ["disconnect", "connect"]) {
    const rows = connections.filter((r) => r.step === step);
    assert.deepEqual(
      rows.map((r) => r.dispatch),
      ["not-sent", "sent"],
    );
    assert.ok(rows[0].operationId && rows[0].operationId !== report.operationId);
    assert.equal(rows[0].operationId, rows[1].operationId);
    assert.ok(rows[0].time >= previous.time && rows[1].time >= rows[0].time);
    ids.push(rows[0].operationId);
    previous = rows[1];
  }
  assert.notEqual(ids[0], ids[1]);
}
export const lifecycleMatrix = ["prepare", "start", "arm", "pulse"].flatMap((boundary) =>
  ["before", "after"].flatMap((position) =>
    [
      "hide",
      "close",
      "blur",
      "authority-loss",
      "renderer-crash",
      "renderer-freeze",
      "plugin-kill",
    ].map((fault) => ({ boundary, position, fault })),
  ),
);
// A stop request is admission evidence, never hardware acknowledgement.
export function validateLifecycleBarrier(report, scenario) {
  if (
    scenario.boundary !== "pulse" ||
    scenario.position !== "after" ||
    !["motor-disable", "provider-disable", "suspend", "disconnect"].includes(scenario.fault)
  )
    return;
  const b = report.lifecycleReceipt?.stopBarrier;
  assert.ok(b, "Original held-exchange admission receipt required");
  assert.deepEqual(b.owner, report.owner);
  assert.ok(b.owner?.processEpoch && b.owner?.hostEpoch);
  assert.equal(b.originalFault.operationId, report.operationId);
  assert.equal(b.originalFault.sessionId, b.before.sessionId);
  assert.equal(b.originalFault.owner.kind, "plugin");
  assert.deepEqual(b.originalFault.owner.owner, b.owner);
  assert.equal(b.before.operationId, report.operationId);
  assert.equal(b.before.stopRequested, false);
  assert.equal(b.admitted.operationId, report.operationId);
  assert.equal(b.admitted.sessionId, b.before.sessionId);
  assert.equal(b.admitted.startAccepted, true);
  assert.equal(b.admitted.stopRequested, true);
  assert.equal(b.admitted.brakeRequired, true);
  assert.equal(b.admitted.phase, "stopping");
  assert.ok(report.faultAt <= b.admittedAt && b.admittedAt <= b.releasedAt);
  assert.ok(b.releasedAt < b.exchangeDeadline, "Timeout cannot satisfy the barrier");
  assert.ok(b.releasedAt <= report.stoppedAt);
  assert.equal(report.terminal.sessionId, b.before.sessionId);
  assert.equal(report.terminal.stopConfirmation, "confirmed");
  for (const operation of [b.before, b.admitted])
    assert.ok(
      report.hostQueries.some(
        (q) =>
          q.result?.ok && JSON.stringify(q.result.value.operation) === JSON.stringify(operation),
      ),
      "Actual host query required",
    );
  for (const step of ["stop", "readback"])
    assert.ok(
      report.trace.some(
        (r) =>
          r.operationId === report.operationId &&
          r.step === step &&
          r.dispatch === "sent" &&
          r.time >= b.releasedAt &&
          r.time <= report.stoppedAt,
      ),
      "Hardware acknowledgement before cleanup required",
    );
}
// Validate observed native sequencing separately so negative receipt samples stay Node-only.
export function validateBlurEvidence(report) {
  const native = report.native;
  const original = report.lifecycleReceipt?.blur;
  assert.ok(original?.binding && original.owner, "Original blur binding and owner required");
  assert.deepEqual(original.owner, report.owner);
  for (const field of ["generation", "hostEpoch", "processEpoch"])
    assert.equal(original.binding[field], original.owner[field]);
  const injection = native.find((r) => r.type === "blur-injection-start");
  const focus = native.find((r) => r.type === "initial-focus-observed");
  const blur = native.find((r) => r.type === "blur" && r.at >= injection?.at);
  const disposed = native.find((r) => r.type === "blur-intent-disposed" && r.at >= blur?.at);
  assert.ok(
    focus && injection && focus.at < injection.at && blur && disposed,
    "Observed native focus, blur and intent disposal required",
  );
  assert.equal(injection.detail?.focused, true);
  assert.equal(blur.detail?.focused, false);
  assert.ok(injection.detail?.intent?.timers > 0, "Original intent existed before focus transfer");
  assert.equal(disposed.detail?.after?.timers, 0, "Native blur disposed intent timers");
  // Native webContents blur may reach the renderer's cancellation path before
  // BrowserWindow emits blur. Both paths must revoke the original identity;
  // the injection marker alone never establishes that focus was actually lost.
  const firstBlur = native
    .filter(
      (r) => ["contents-blur", "blur"].includes(r.type) && r.at >= injection.at && r.at <= blur.at,
    )
    .sort((a, b) => a.at - b.at)[0];
  assert.ok(firstBlur, "Missing native focus-loss event");
  assert.ok(
    report.events.some(
      (e) =>
        e.kind === "revoke" &&
        e.time >= firstBlur.at &&
        e.time <= disposed.at &&
        isDeepStrictEqual(e.binding, original.binding) &&
        isDeepStrictEqual(e.owner, original.owner),
    ),
    "Native blur must produce host revocation",
  );
}
export function validateNativeInput(report, scenario) {
  if (scenario.fault === "blur") validateBlurEvidence(report);
  const mode = scenario.mode ?? (scenario.boundary === "arm" ? "relative-angle" : "jog");
  if (mode !== "jog") {
    const observed = report.native.filter((r) => r.type === "mode-observed");
    assert.deepEqual(
      observed.map((r) => r.detail),
      ["jog", "jog", mode].map((value) => ({ value, focused: true })),
      "Native closed-select focus/value observations required",
    );
    for (let i = 1; i < observed.length; i++)
      assert.ok(observed[i].at > observed[i - 1].at, "Mode observations must cross render turns");
  }
  if (scenario.fault === "close") {
    const close = report.lifecycleReceipt?.close;
    assert.ok(close?.binding?.panelInstance, "Original closed binding required");
    const ipc = report.ipc.find(
      (r) =>
        r.channel === "plugins:ui:close" &&
        r.at === close.ipcAt &&
        r.at >= close.clickAt &&
        r.args[0]?.binding?.panelInstance === close.binding.panelInstance,
    );
    assert.ok(ipc?.result?.ok && !ipc.error, "Actual successful close IPC required");
    const down = report.inputReceipts.find(
      (r) =>
        r.received > close.clickReceiptSequence &&
        r.type === "pointerdown" &&
        r.isTrusted &&
        r.close &&
        r.targetId === close.targetId,
    );
    const up = report.inputReceipts.find(
      (r) =>
        r.received > (down?.received ?? Infinity) &&
        r.type === "pointerup" &&
        r.isTrusted &&
        r.close &&
        r.targetId === close.targetId,
    );
    assert.ok(
      Number.isSafeInteger(close.targetId) && down && up && up.received < ipc.received,
      "Trusted close down/up on the same DOM target before close IPC required",
    );
    assert.ok(close.bindingGoneAt >= ipc.at, "Binding disappearance must follow close IPC");
    assert.ok(
      report.events.some(
        (e) =>
          e.kind === "revoke" &&
          e.binding?.panelInstance === close.binding.panelInstance &&
          e.time >= close.clickAt,
      ),
      "Close must revoke the original binding",
    );
    if (mode === "jog") {
      const original = close.originalHold;
      assert.ok(
        report.ipc.some((r) => isDeepStrictEqual(r, original)),
        "Observed original hold required",
      );
      assert.equal(original.channel, "plugins:ui:hold");
      assert.equal(original.args[0]?.phase, "begin");
      assert.equal(original.result?.ok, true);
      assert.ok(original.result?.value?.gesture && original.args[0]?.inputToken);
      assert.deepEqual(original.args[0].binding, close.binding);
      assert.equal(original.args[0].nodeId, "a-forward");
      assert.ok(original.received <= close.faultReceiptSequence);
      const matched = matchingHoldEnd(
        report.inputReceipts,
        report.ipc,
        close.faultReceiptSequence,
        original.args[0],
        scenario.key,
      );
      assert.ok(matched, "New trusted release and original-token hold-end IPC required");
      assert.deepEqual(matched, close.holdRelease);
      assert.ok(matched.end.received <= close.clickReceiptSequence);
      assert.ok(matched.end.received < ipc.received, "Hold-end must precede close IPC");
    }
  }
}
export function validateFreezeInjection(report, scenario = report.scenario) {
  const events = report.debuggerEvents ?? [];
  const through = report.freezeVerifiedThrough;
  assert.ok(
    Number.isSafeInteger(through) && through > 0 && through < events.length,
    "Invalid renderer-freeze injection: missing sustained pause interval",
  );
  requireSustainedPause(events, through);
  const expiry = events[through];
  assert.equal(expiry.event, "expiry-observed");
  assert.equal(expiry.detail?.kind, "revoke");
  assert.equal(expiry.detail.time, report.revokedAt);
  assert.ok(
    expiry.detail.time >= events.find((e) => e.event === "Debugger.paused").at,
    "Invalid renderer-freeze injection: expiry preceded acknowledged pause",
  );
  assert.ok(report.events.some((e) => isDeepStrictEqual(e, expiry.detail)));
  const activation = report.lifecycleReceipt?.freezeActivation;
  assert.ok(activation?.binding, "Original freeze activation binding required");
  const mode = scenario.mode ?? (scenario.boundary === "arm" ? "relative-angle" : "jog");
  const original = matchingFreezeActivation(
    report.inputReceipts,
    report.ipc,
    activation.binding,
    activation.after,
    activation.through,
    mode,
    scenario.key,
  );
  assert.ok(original, "Successful exact original native activation required");
  assert.deepEqual(original, activation.original);
  assert.ok(original.at <= report.faultAt, "Activation must precede fault");
  assert.deepEqual(expiry.detail.binding, original.args[0].binding);
  assert.ok(events.slice(through + 1).some((e) => e.event === "driver-resume-requested"));
  const requested = events.findIndex((e) => e.event === "driver-resume-requested");
  assert.ok(requested > through);
  assert.ok(
    events.slice(requested + 1).some((e) => e.event === "Debugger.resumed"),
    "Invalid renderer-freeze injection: actual deliberate resume acknowledgement required",
  );
  const ack = events.findIndex((e, i) => i > requested && e.event === "Debugger.resumed");
  assert.ok(
    !events.slice(requested + 1, ack).some((e) => e.event === "detach"),
    "Invalid renderer-freeze injection: detached awaiting deliberate resume",
  );
  assert.ok(
    !events
      .slice(through + 1, requested)
      .some((e) => ["Debugger.resumed", "detach"].includes(e.event)),
    "Invalid renderer-freeze injection: resumed before driver release",
  );
}
export function validateCoreStop(report) {
  const admission = report.lifecycleReceipt?.coreStop;
  const invocation = report.lifecycleReceipt?.coreStopInvocation;
  assert.equal(admission?.admitted?.operationId, report.operationId);
  assert.equal(admission.admitted.sessionId, report.terminal.sessionId);
  assert.equal(admission.admitted.stopRequested, true);
  assert.ok(admission.admittedAt >= report.faultAt);
  assert.equal(invocation?.channel, "plugins:ui:invoke");
  assert.ok(invocation.at >= report.faultAt);
  assert.equal(invocation.args[0]?.nodeId, "stop");
  assert.deepEqual(invocation.args[0]?.form, {});
  assert.equal(invocation.error, undefined);
  assert.equal(invocation.result?.ok, true);
  assert.deepEqual(invocation.result.value.fieldErrors, []);
  assert.ok(report.ipc.some((r) => JSON.stringify(r) === JSON.stringify(invocation)));
  assert.ok(
    report.inputReceipts.some(
      (r) =>
        r.isTrusted &&
        r.node === "stop" &&
        r.type === "pointerdown" &&
        r.at >= report.faultAt &&
        r.at <= invocation.at,
    ),
  );
  const prepared = report.wire.find(
    (r) =>
      r.direction === "host-plugin" &&
      r.message.result?.ok === true &&
      r.message.result.value?.operation?.operationId === report.operationId,
  )?.message.result.value.operation;
  assert.ok(prepared?.sessionId, "Original operation/session must be observed on the wire");
  assert.equal(admission.admitted.sessionId, prepared.sessionId);
  assert.equal(report.terminal.operationId, report.operationId);
  assert.equal(report.terminal.sessionId, prepared.sessionId);
  assert.equal(report.terminal.stopConfirmation, "confirmed");
  for (const snapshot of [admission.admitted, report.terminal])
    assert.ok(Number.isSafeInteger(snapshot.revision), "Observed snapshot revision required");

  // queryOriginal records its response before capturing admittedAt. Terminal
  // polling likewise records the exact snapshot before capturing stoppedAt.
  // Compare the whole snapshot, including revision; a later revision is not
  // evidence for the snapshot claimed by either receipt.
  const observed = (operation, from, through) =>
    report.hostQueries?.find(
      (q) =>
        q.operationId === report.operationId &&
        q.result?.ok === true &&
        Number.isFinite(q.at) &&
        q.at >= from &&
        q.at <= through &&
        isDeepStrictEqual(q.result.value?.operation, operation),
    );
  assert.ok(
    observed(admission.admitted, invocation.at, admission.admittedAt),
    "Core Stop admission requires its exact successful original-operation query",
  );
  const terminalQuery = observed(report.terminal, admission.admittedAt, report.stoppedAt);
  assert.ok(
    terminalQuery,
    "Core Stop terminal requires its exact successful original-operation query",
  );
  // IPC at is invocation entry, not completion. The stop can be sent before
  // admission is polled; both sent exchanges must precede terminal observation.
  let after = invocation.at;
  for (const step of ["stop", "readback"]) {
    const sent = report.trace.find(
      (r) =>
        r.operationId === report.operationId &&
        r.step === step &&
        r.dispatch === "sent" &&
        r.time >= after &&
        r.time <= terminalQuery.at,
    );
    assert.ok(
      sent,
      `Core Stop requires ordered sent original-operation ${step} before terminal query`,
    );
    after = sent.time;
  }
}
export function validateNative(report, identity, scenario) {
  assert.equal(report.kind, scenario.safeMode ? "motor-public-native-cold" : "motor-public-native");
  assert.deepEqual(report.artifact, identity, "Exact tested artifact required");
  assert.deepEqual(report.scenario, scenario);
  assert.equal(report.composition, "composeDesktopMain/createDesktopFoundation");
  assert.ok(report.stdout?.trim(), "Actual native output required");
  if (scenario.safeMode) {
    assert.equal(report.kind, "motor-public-native-cold");
    assert.equal(report.plugins.safeMode, true);
    assert.deepEqual(report.wire, []);
    assert.ok(report.recovery);
    assert.ok(report.native.some((e) => e.type === "cold-safe-mode-window"));
    assert.ok(
      Object.keys(report.final ?? {}).length === 10 &&
        Object.values(report.final).every((v) => v === 0),
    );
    assert.ok(report.orphanCheckMs >= 5000);
    assert.deepEqual(report.remainingPids, []);
    assert.deepEqual(report.failures, []);
    return report;
  }
  assert.ok(report.wire?.length && report.native?.length);
  validateNativeInput(report, scenario);
  validateLifecycleBarrier(report, scenario);
  if (scenario.fault === "renderer-freeze") validateFreezeInjection(report, scenario);
  assert.ok(Array.isArray(report.trace), "Actual provider trace required");
  if (report.trace.length === 0) {
    assert.equal(report.terminal?.dispatch, "not-sent");
    assert.equal(report.terminal?.movement, "not-started");
    assert.equal(report.terminal?.stopConfirmation, "not-required");
  }
  assert.ok(report.operationId);
  const preparedReply = report.wire.find(
    (r) =>
      r.direction === "host-plugin" &&
      r.message.result?.value?.operation?.operationId === report.operationId,
  );
  assert.ok(preparedReply, "Original ID must be observed on the actual wire");
  const effects = new Set(["helper-upload", "helper-run", "helper-arm", "motion-pulse"]);
  assert.deepEqual(
    report.trace.filter(
      (r) => r.time > report.revokedAt && effects.has(r.step) && r.dispatch === "sent",
    ),
    [],
    "No consequential write after revoke",
  );
  const allowed = new Set([
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
  for (const row of report.wire.filter((r) => r.direction === "plugin-host" && r.message.method)) {
    if (row.message.method === "$/cancelRequest") validateCancellation(row, report.wire);
    else assert.ok(allowed.has(row.message.method), `Forbidden motor RPC ${row.message.method}`);
  }
  const prepares = report.wire.filter(
    (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/prepare",
  );
  const starts = report.wire.filter(
    (r) => r.direction === "plugin-host" && r.message.method === "devices/motion/start",
  );
  assert.equal(prepares.length, 1);
  assert.ok(starts.length <= 1);
  for (const row of starts) assert.equal(row.message.params.operationId, report.operationId);
  assert.ok(Number.isFinite(report.revokedAt) && Number.isFinite(report.stoppedAt));
  assert.ok(report.stoppedAt >= report.revokedAt && report.stoppedAt - report.revokedAt <= 25000);
  assert.ok(
    ["stopped", "completed", "timeout", "failed", "unconfirmed"].includes(report.terminal?.phase),
  );
  assert.ok(
    ["confirmed", "unconfirmed"].includes(report.terminal.stopConfirmation) ||
      (report.terminal.stopConfirmation === "not-required" &&
        report.terminal.dispatch === "not-sent" &&
        report.terminal.movement === "not-started"),
  );
  assert.deepEqual(report.failures, []);
  assert.ok(report.orphanCheckMs >= 5000);
  assert.deepEqual(report.remainingPids, []);
  assert.equal(
    Object.keys(report.final ?? {}).length,
    10,
    "Ten observed foundation counters required",
  );
  assert.ok(Object.values(report.final).every((v) => Number.isSafeInteger(v) && v >= 0));
  if (
    scenario.stress === "withheld-readback" ||
    (scenario.fault === "source-loss" && report.terminal.stopConfirmation === "unconfirmed")
  ) {
    assert.equal(report.expectedBlockedClose?.name, "Error");
    assert.equal(report.terminal.phase, "unconfirmed");
    assert.equal(report.terminal.stopConfirmation, "unconfirmed");
    assert.ok(report.forcedTeardownAt >= report.stoppedAt);
    assert.ok(
      report.recoverySnapshot?.faults.some(
        (f) => f.operationId === report.operationId && f.state === "unconfirmed",
      ),
    );
  } else {
    assert.equal(report.expectedBlockedClose, undefined);
    assert.ok(
      Object.values(report.final).every((v) => v === 0),
      "Observed counters must return to zero",
    );
  }
  const traceAfter = report.trace.slice(report.traceAtRevoke);
  assert.deepEqual(
    traceAfter.filter((r) => effects.has(r.step) && r.dispatch !== "not-sent"),
    [],
  );
  if (
    ["motor-disable", "provider-disable", "suspend", "disconnect", "source-loss"].includes(
      scenario.fault,
    )
  ) {
    if (scenario.fault !== "source-loss")
      assert.ok(report.trace.some((r) => r.step === "stop" && r.dispatch === "sent"));
    assert.equal(report.lifecycleReceipt?.error, undefined);
  } else if (scenario.fault === "stop") validateCoreStop(report);
  else assert.ok(report.events.some((e) => e.kind === "revoke" || e.kind === "stop-dispatch"));
  assert.ok(report.native.some((e) => e.type === "mouseDown"));
  assert.ok(
    report.inputReceipts?.some((e) => e.type === "pointerdown" && e.isTrusted && e.node),
    "Trusted native browser delivery required",
  );
  if (scenario.key)
    assert.ok(
      report.inputReceipts.some(
        (e) =>
          e.type === "keydown" &&
          e.isTrusted &&
          e.repeat &&
          e.key === (scenario.key === "Space" ? " " : "Enter"),
      ),
      "Actual repeat event delivery required",
    );
  if (!report.expectedBlockedClose)
    assert.ok(report.providerCleanup, "Awaited provider cleanup receipt required");
  validateProviderTrace(report, scenario);
  assert.ok(
    report.hostQueries?.length &&
      report.hostQueries.every((r) => r.operationId === report.operationId),
  );
  assert.ok(report.presentationSamples?.length, "Observed generic UI presentation required");
  assert.ok(report.counterSamples?.some((r) => r.label === "boundary"));
  assert.deepEqual(report.counterSamples?.at(-1)?.counters, report.final);
  if (scenario.fault === "complete") {
    assert.equal(report.terminal.phase, "completed");
    assert.equal(report.terminal.stopConfirmation, "confirmed");
  }
  if (scenario.key) {
    assert.ok(
      report.native.some(
        (e) => e.type === "keyDown" && e.detail?.keyCode === scenario.key && e.detail.repeat,
      ),
    );
    assert.ok(report.native.some((e) => e.type === "keyUp" && e.detail?.keyCode === scenario.key));
  }
  if (scenario.parity === "drafts") {
    assert.deepEqual(
      report.parity?.defaults,
      ["a", "b", "c", "d"].map((port) => ({
        port,
        mode: "jog",
        power: "20",
        seconds: "1",
        degrees: "90",
        direction: "1",
        brake: true,
      })),
    );
    assert.equal(report.parity?.drafts?.a, "31");
    assert.equal(report.parity?.drafts?.bRaw, "bad");
  }
  if (scenario.parity === "layout") {
    assert.deepEqual(
      report.parity?.layouts?.map((r) => r.locale),
      ["en", "zh-TW"],
    );
    assert.ok(report.parity.layouts.every((r) => r.scroll <= r.client && r.screenshot));
  }
  if (scenario.parity === "invalid-stop") assert.equal(report.parity?.invalidStop?.raw, "bad");
  if (scenario.stress === "lost-start") {
    const start = starts[0];
    assert.ok(start);
    assert.ok(
      report.wire.some(
        (r) =>
          r.direction === "plugin-host" &&
          r.message.method === "devices/motion/query" &&
          r.message.params.operationId === report.operationId &&
          r.at >= start.at + 4500,
      ),
    );
  }
  return report;
}
async function main() {
  const [mode] = process.argv.slice(2);
  if (mode === "--node") {
    const c = await compose();
    try {
      await until(() => c.wire.some((r) => r.message.method === "devices/list"), "SDK list");
      const directory = await mkdtemp(path.join(tmpdir(), "motor-public-"));
      await writeFile(
        path.join(directory, "node-ready.json"),
        JSON.stringify(
          {
            kind: "motor-public-node-ready",
            artifact: c.artifacts.identity,
            wire: c.wire,
            routeErrors: c.routeErrors,
            scope: "Node readiness only, not native/product acceptance",
          },
          null,
          2,
        ),
      );
      console.log(`Actual motor SDK/MessagePort ready observation: ${directory}`);
    } finally {
      await c.dispose();
    }
    return;
  }
  return runNative(process.argv.slice(2));
}

export const nativeCases = [
  ...lifecycleMatrix,
  ...["jog", "timed", "relative-angle"].map((mode) => ({
    boundary: "start",
    position: "after",
    fault: "complete",
    mode,
  })),
  { boundary: "pulse", position: "after", fault: "source-loss" },
  ...["motor-disable", "provider-disable", "suspend", "disconnect", "second-launch"].map(
    (fault) => ({ boundary: "pulse", position: "after", fault }),
  ),
  { boundary: "prepare", position: "before", fault: "hide", safeMode: true },
  { boundary: "pulse", position: "after", fault: "release", mode: "jog" },
  { boundary: "pulse", position: "after", fault: "cancel", mode: "jog" },
  ...["Space", "Enter"].map((key) => ({
    boundary: "pulse",
    position: "after",
    fault: "release",
    mode: "jog",
    key,
  })),
  { boundary: "start", position: "after", fault: "hide", mode: "timed" },
  { boundary: "arm", position: "after", fault: "hide", mode: "relative-angle" },
  { boundary: "start", position: "before", fault: "hide", mode: "timed", stress: "lost-start" },
  { boundary: "pulse", position: "after", fault: "hide", stress: "withheld-readback" },
  { boundary: "prepare", position: "before", fault: "hide", parity: "drafts" },
  { boundary: "pulse", position: "after", fault: "hide", parity: "layout" },
  { boundary: "start", position: "before", fault: "stop", mode: "timed", parity: "invalid-stop" },
];
export const caseName = (s) =>
  [
    s.boundary,
    s.position,
    s.fault,
    s.mode,
    s.key,
    s.stress,
    s.parity,
    s.safeMode ? "safe-mode" : null,
  ]
    .filter(Boolean)
    .join(":");
export function selectNativeCases(args) {
  assert.equal(
    args.length,
    1,
    "Use --all, --build-only, or --case=boundary:position:fault[:mode[:key[:stress]]]",
  );
  if (args[0] === "--all" || args[0] === "--build-only") return nativeCases;
  const selected = nativeCases.filter((s) => args[0] === `--case=${caseName(s)}`);
  assert.equal(selected.length, 1, "Unknown or ambiguous native motor case");
  return selected;
}
export async function buildNative(directory) {
  const desktopRequire = createRequire(path.join(root, "apps/desktop/package.json"));
  const vite = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
  const template = path.join(directory, "template");
  await mkdir(path.join(template, "source"), { recursive: true });
  // Installed dependencies only. All workspace source aliases below point into this checkout.
  await symlink(
    await realpath(path.join(root, "apps/desktop/node_modules")),
    path.join(directory, "node_modules"),
    "dir",
  );
  const artifacts = await motorArtifacts();
  await writeFile(
    path.join(template, "source/main.cjs"),
    `console.error("MOTOR_PID:" + process.pid);\n${artifacts.code}`,
  );
  for (const name of ["kobrixa-plugin.json", "panel.json", "status.json"])
    await cp(path.join(root, "plugins/motor-test", name), path.join(template, "source", name));
  const tsconfig = JSON.parse(await readFile(path.join(root, "tsconfig.base.json"), "utf8"));
  const ownAliases = Object.fromEntries(
    Object.entries(tsconfig.compilerOptions.paths).map(([name, [file]]) => [
      name,
      path.join(root, file),
    ]),
  );
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    alias: ownAliases,
    external: ["electron", "node-hid", "usb"],
    plugins: [rawResourcePlugin()],
  };
  await build({
    ...common,
    stdin: {
      contents: `import {runNativeMotor} from ${JSON.stringify(path.join(root, "tests/desktop/motor-test-public-main.ts"))}; runNativeMotor();`,
      resolveDir: root,
      loader: "ts",
    },
    outfile: path.join(directory, "main.cjs"),
    metafile: true,
  }).then(async (result) => {
    for (const file of Object.keys(result.metafile.inputs)) {
      const resolved = path.resolve(root, file);
      assert.ok(
        resolved.startsWith(root + path.sep) ||
          resolved.includes(`${path.sep}node_modules${path.sep}`) ||
          file === "<stdin>",
        `Native workspace source escaped checkout: ${file}`,
      );
    }
    await writeFile(
      path.join(directory, "main-metafile.json"),
      JSON.stringify(result.metafile, null, 2),
    );
  });
  // The integrated desktop composition starts the real persistence worker even
  // when this motor-only case does not write records. Keep its executable beside
  // the main bundle, matching persistenceWorkerPath's development resolution.
  await build({
    ...common,
    stdin: {
      contents: `import {runShippedPersistenceWorker} from ${JSON.stringify(path.join(root, "apps/desktop/src/main/plugins/persistence/worker.ts"))}; runShippedPersistenceWorker();`,
      resolveDir: root,
      loader: "ts",
    },
    outfile: path.join(directory, "persistence-worker.cjs"),
  });
  // Build the existing production preload from this checkout when no built artifact exists.
  await build({
    ...common,
    entryPoints: [path.join(root, "apps/desktop/src/preload/index.ts")],
    outfile: path.join(template, "preload.cjs"),
  });
  await vite.build({
    configLoader: "runner",
    cacheDir: path.join(directory, "vite-cache"),
    root: path.join(root, "apps/desktop"),
    configFile: path.join(root, "apps/desktop/vite.renderer.config.ts"),
    base: "./",
    resolve: { alias: ownAliases, dedupe: ["react", "react-dom"] },
    plugins: [
      {
        name: "actual-motor-generic-pane",
        async generateBundle() {
          const modules = [...this.getModuleIds()];
          for (const id of modules)
            if (id.startsWith("/") && !id.includes("/node_modules/"))
              assert.ok(
                id.startsWith(root + path.sep),
                `Renderer workspace source escaped checkout: ${id}`,
              );
          await writeFile(
            path.join(directory, "renderer-modules.json"),
            JSON.stringify(modules, null, 2),
          );
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html.replace(
              'src="/src/renderer/index.tsx"',
              `src="/@fs/${path.join(root, "tests/desktop/motor-test-public-renderer.tsx")}"`,
            ),
        },
      },
    ],
    build: { outDir: path.join(template, "renderer"), emptyOutDir: true },
  });
  const identity = { ...artifacts.identity, nativeBuildSha256: {} };
  for (const file of [
    "main.cjs",
    "persistence-worker.cjs",
    "template/preload.cjs",
    "template/source/main.cjs",
    ...(await readdir(path.join(template, "renderer"), { recursive: true }))
      .filter((file) => /\.(html|js|css)$/.test(file))
      .map((file) => `template/renderer/${file}`),
  ])
    identity.nativeBuildSha256[file] = digest(await readFile(path.join(directory, file)));
  await writeFile(
    path.join(directory, "artifact-identity.json"),
    JSON.stringify(identity, null, 2),
  );
  return { template, identity, electron: desktopRequire("electron") };
}
async function runNative(args) {
  const selected = selectNativeCases(args);
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "kobrixa-motor-native-")));
  console.log(`Motor native artifacts: ${directory}`);
  const { template, identity, electron } = await buildNative(directory);
  if (args[0] === "--build-only") {
    console.log("Native bundles built; Electron was not run.");
    return;
  }
  const reports = [],
    failures = [];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  for (const scenario of selected) {
    const folder = path.join(directory, caseName(scenario).replaceAll(":", "-"));
    await cp(template, folder, { recursive: true });
    await mkdir(path.join(folder, "profile"));
    const input = path.join(folder, "input.json"),
      output = path.join(folder, "report.json");
    await writeFile(input, JSON.stringify(scenario));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron,
      [path.join(directory, "main.cjs"), `--motor-input=${input}`, `--motor-output=${output}`],
      {
        cwd: folder,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    const logs = [];
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        logs.push(data.toString());
        process.stderr.write(data);
      });
    const terminate = () => {
      if (child.pid)
        try {
          process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, 95_000);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(timedOut, false);
      assert.equal(result.code, 0, JSON.stringify(result));
      const report = JSON.parse(await readFile(output, "utf8"));
      assert.ok(
        scenario.safeMode || (Number.isInteger(report.pid) && report.pid > 0),
        "Observed utility PID required",
      );
      if (report.expectedBlockedClose) {
        terminate();
        report.forcedTeardownAt = performance.timeOrigin + performance.now();
      }
      report.orphanCheckMs = await waitElapsed(5000);
      report.remainingPids = [
        ...(report.childPids ?? []),
        report.pid,
        report.lifecycleReceipt?.secondInstance?.pid,
        child.pid,
      ]
        .filter((pid) => Number.isInteger(pid) && pid > 0)
        .filter(alive);
      report.artifact = identity;
      report.stdout = logs.join("");
      await writeFile(output, JSON.stringify(report, null, 2));
      validateNative(report, identity, scenario);
      reports.push({ scenario, path: output });
      console.log(`PASS native motor ${caseName(scenario)}: ${output}`);
    } catch (error) {
      failures.push({ scenario, error: String(error), path: folder });
      console.error(`FAIL native motor ${caseName(scenario)}: ${error}; ${folder}`);
    } finally {
      clearTimeout(timer);
      await writeFile(path.join(folder, "electron.log"), logs.join(""));
      // Entire isolated process group is retired even after malformed/missing receipts.
      terminate();
      const observed = [child.pid, ...logs.join("").matchAll(/MOTOR_PID:(\d+)/g)]
        .map((value) => (typeof value === "number" ? value : Number(value[1])))
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      const cleanupElapsed = await waitElapsed(5000);
      const remainingPids = [...new Set(observed)].filter(alive);
      await writeFile(
        path.join(folder, "cleanup.json"),
        JSON.stringify(
          {
            observedPids: [...new Set(observed)],
            remainingPids,
            orphanCheckMs: cleanupElapsed,
          },
          null,
          2,
        ),
      );
      if (remainingPids.length)
        failures.push({
          scenario,
          error: "Isolated process cleanup left observed PIDs",
          remainingPids,
          path: folder,
        });
    }
    await writeFile(
      path.join(directory, "matrix.json"),
      JSON.stringify(
        { kind: "motor-public-native-matrix", artifact: identity, selected, reports, failures },
        null,
        2,
      ),
    );
  }
  assert.equal(
    failures.length,
    0,
    `${reports.length}/${selected.length} passed; see ${directory}/matrix.json`,
  );
  console.log(
    `${reports.length}/${selected.length} actual motor native cases passed; product/physical gates remain separate.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
