import assert from "node:assert/strict";
import { openSync, writeSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Session } from "node:inspector";
import { cpus, totalmem, platform, arch } from "node:os";
import { getHeapStatistics } from "node:v8";
import { app, type BrowserWindow } from "electron";
import type { FoundationDiagnostics } from "@kobrixa/plugin-runtime";
import type { DesktopMainComposition } from "../../apps/desktop/src/main/device-broker/lifecycle-coordinator.js";
import { desktopUi } from "../../apps/desktop/src/main/plugins/controller.js";
import { diagnosticsFor as mainDiagnostics } from "../../apps/desktop/src/main/plugins/ui-bridge.js";
import { diagnosticsFor as stateDiagnostics } from "../../packages/plugin-runtime/src/ui-state.js";
import { measureSlowRenderer, type SnapshotDelay } from "./declarative-ui-slow-main.js";
import {
  loadEvaluation,
  loadReadiness,
  loadResult,
  waitForLoad,
} from "./declarative-ui-load-fixture.js";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const wall = () => performance.timeOrigin + performance.now();
export async function runUiLoad(input: {
  window: BrowserWindow;
  composition: DesktopMainComposition;
  runtime: FoundationDiagnostics;
  directory: string;
  folders: string[];
  durationMs: number;
  cycles: number;
  slow?: boolean;
  workload?: {
    prepare(): Promise<void>;
    start(): Promise<void>;
    step(index: number, sample: unknown): Promise<void>;
    finish(): Promise<void>;
  };
  snapshotDelay: SnapshotDelay;
}) {
  const { window, composition, directory } = input;
  const ui = desktopUi(composition);
  const diag = [stateDiagnostics(ui.states), input.runtime, mainDiagnostics(ui.bridge)];
  const snapshots = () => diag.map((value, id) => ({ id, counters: value.snapshot() }));
  const js = async <T = unknown>(source: string): Promise<T> => {
    try {
      return loadResult<T>(await window.webContents.executeJavaScript(loadEvaluation(source)));
    } catch (error) {
      const state = await window.webContents
        .executeJavaScript(loadEvaluation("window.uiLoad?.inspect() ?? null"))
        .then((json: string) => loadResult(json))
        .catch(String);
      throw new Error(`${source}: ${String(error)}; load state: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
  };
  const wait = async (source: string, label: string) => {
    await waitForLoad(() => js(loadReadiness(source)), Boolean, label);
  };
  const requestForeground = () => {
    // BrowserWindow.focus alone does not activate a background macOS app.
    // This native-input fixture owns focus; preserve the real blur/revoke route.
    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    window.focus();
    window.webContents.focus();
  };
  const foreground = async () => {
    await waitForLoad(
      async () => {
        const ready = await js<boolean>("document.hasFocus() && !document.hidden");
        if (!ready) requestForeground();
        return ready;
      },
      Boolean,
      "native load window focus",
    );
  };
  // A renderer-side wait cannot bring a background app forward. Recover focus
  // even inside openAll/cycles, after the real blur event has been delivered.
  let focusRecovery: ReturnType<typeof setImmediate> | undefined;
  const regainFocus = () => {
    if (focusRecovery) return;
    focusRecovery = setImmediate(() => {
      focusRecovery = undefined;
      if (!window.isDestroyed()) requestForeground();
    });
  };
  const bounds = async (kind: "input" | "hold" | "hide") => {
    await foreground();
    return js<{ x: number; y: number }>(`window.uiLoad.bounds('${kind}')`);
  };
  const inspector = new Session();
  inspector.connect();
  const post = (method: string) =>
    new Promise<void>((resolve, reject) =>
      inspector.post(method, (error) => (error ? reject(error) : resolve())),
    );
  window.webContents.debugger.attach("1.3");
  const cdp = (method: string) => window.webContents.debugger.sendCommand(method);
  const heap = async (label: string) => {
    const main: number[] = [],
      renderer: number[] = [];
    for (let i = 0; i < 3; i++) {
      await post("HeapProfiler.collectGarbage");
      await cdp("HeapProfiler.collectGarbage");
      await pause(60);
      main.push(getHeapStatistics().used_heap_size);
      const data = (await cdp("Runtime.getHeapUsage")) as { usedSize: number };
      renderer.push(data.usedSize);
    }
    const mainFile = path.join(directory, `${label}-main.heapsnapshot`);
    const rendererFile = path.join(directory, `${label}-renderer.heapsnapshot`);
    const mainFd = openSync(mainFile, "w"),
      rendererFd = openSync(rendererFile, "w");
    const mainChunk = (message: { params: { chunk: string } }) =>
      writeSync(mainFd, message.params.chunk);
    const rendererChunk = (_event: unknown, method: string, params: { chunk?: string }) => {
      if (method === "HeapProfiler.addHeapSnapshotChunk") writeSync(rendererFd, params.chunk!);
    };
    inspector.on("HeapProfiler.addHeapSnapshotChunk", mainChunk);
    window.webContents.debugger.on("message", rendererChunk);
    try {
      await post("HeapProfiler.takeHeapSnapshot");
      await cdp("HeapProfiler.takeHeapSnapshot");
    } finally {
      inspector.off("HeapProfiler.addHeapSnapshotChunk", mainChunk);
      window.webContents.debugger.off("message", rendererChunk);
      closeSync(mainFd);
      closeSync(rendererFd);
    }
    return { main, renderer, mainFile, rendererFile };
  };
  const tracePath = path.join(directory, "main-events.jsonl");
  const traceFd = openSync(tracePath, "w");
  let recording = false;
  const off = mainDiagnostics(ui.bridge).onEvent((event) => {
    if (!recording) return;
    const current = event.binding && ui.states.state(event.owner, event.binding);
    writeSync(
      traceFd,
      JSON.stringify({ ...event, revision: current?.ok ? current.value.revision : null }) + "\n",
    );
  });
  try {
    window.on("blur", regainFocus);
    window.on("hide", regainFocus);
    window.on("minimize", regainFocus);
    await window.loadFile(path.join(directory, "renderer/index.html"));
    await foreground();
    await wait("window.uiLoad", "load shell ready");
    await js("window.uiLoad.ready.then(() => true)");
    assert.equal(await js("window.uiLoad.count()"), 0);
    const coldCounters = { main: snapshots(), renderer: await js("window.uiLoad.sample()") };
    const coldHeap = await heap("cold");
    assert.equal((await composition.plugins.setDeveloperMode(true)).ok, true);
    const linkAll = async () => {
      for (const folder of input.folders)
        assert.equal((await composition.plugins.linkFolder()).ok, true, folder);
      await wait("window.uiLoad.count() === 32", "32 maximum catalog entries");
    };
    const unlinkAll = async () => {
      for (const source of composition.plugins
        .state()
        .plugins.filter((plugin) => plugin.source === "development"))
        assert.equal((await composition.plugins.unlink(source.sourceKey)).ok, true);
      await wait("window.uiLoad.count() === 0", "empty catalog after actual unlink");
    };
    // Warm schemas/code through real lifecycles, then remove the real sources.
    // Retained-cycle comparison uses an empty, warmed catalog; cold setup is
    // measured separately, not subtracted as if it were a resource leak.
    await linkAll();
    await foreground();
    await js("window.uiLoad.openAll()");
    await js("window.uiLoad.cycles(16)");
    await unlinkAll();
    const warmedRetired = await js("window.uiLoad.pruneRetired()");
    const baselineCounters = { main: snapshots(), renderer: await js("window.uiLoad.sample()") };
    assert.ok(
      baselineCounters.main.every((row) =>
        Object.values(row.counters).every((value) => value === 0),
      ),
    );
    const baselineHeap = await heap("empty-warm");
    await linkAll();
    await wait("window.uiLoad.count() === 32", "32 maximum catalog entries");
    await foreground();
    await js("window.uiLoad.openAll()");
    await pause(500);
    const fullCounters = { main: snapshots(), renderer: await js("window.uiLoad.sample()") };
    assert.equal(fullCounters.main[0]!.counters.bindings, 32);
    assert.equal(fullCounters.main[1]!.counters.owners, 8);
    const fullHeap = await heap("full");
    // Heap snapshots deliberately stall both isolates. Resume via the real
    // visibility route before warmup, rather than measuring a revoked scope.
    await foreground();
    await js("window.uiLoad.show()");
    if (input.slow) {
      const observed = await measureSlowRenderer(window, input.snapshotDelay);
      const rendererFinal = await js("window.uiLoad.dispose()");
      for (const source of composition.plugins
        .state()
        .plugins.filter((plugin) => plugin.source === "development"))
        assert.equal((await composition.plugins.unlink(source.sourceKey)).ok, true);
      await composition.dispose();
      const final = snapshots();
      assert.ok(final.every((row) => Object.values(row.counters).every((value) => value === 0)));
      return {
        kind: "ui-slow-renderer-run",
        composition: "composeDesktopMain/createDesktopFoundation",
        ...observed,
        final,
        rendererFinal,
        fullCounters,
        baselineHeap,
        fullHeap,
        afterHeap: await heap("after"),
        normalClose: true,
        versions: process.versions,
      };
    }
    const calibration = [];
    for (let n = 0; n < 30; n++) {
      const send = wall();
      const renderer = await js<number>("performance.timeOrigin + performance.now()");
      const receive = wall();
      calibration.push({
        send,
        renderer,
        receive,
        offset: (send + receive) / 2 - renderer,
        uncertainty: (receive - send) / 2,
      });
    }
    const best = [...calibration].sort((a, b) => a.uncertainty - b.uncertainty)[0]!;
    await input.workload?.prepare();
    const warmupAt = wall();
    await pause(5000);
    await foreground();
    recording = true;
    await input.workload?.start();
    const start = await js<number>("window.uiLoad.start()");
    const native: Array<{ kind: string; at: number }> = [];
    const deadline = performance.now() + input.durationMs;
    let n = 0;
    while (performance.now() < deadline) {
      const inputBounds = await bounds("input");
      await pause(20);
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...inputBounds,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...inputBounds,
      });
      native.push({ kind: "input", at: wall() });
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: "BACKSPACE",
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: "BACKSPACE",
      });
      window.webContents.sendInputEvent({ type: "char", keyCode: n++ % 2 ? "x" : "y" });
      await pause(200);
      const hold = await bounds("hold");
      await pause(20);
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...hold,
      });
      await pause(150);
      native.push({ kind: "release", at: wall() });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...hold,
      });
      await pause(50);
      const hide = await bounds("hide");
      await pause(20);
      native.push({ kind: "hide", at: wall() });
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...hide,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...hide,
      });
      await pause(100);
      await js("window.uiLoad.show()");
      await pause(300);
      await input.workload?.step(n - 1, {
        at: wall(),
        main: snapshots(),
        renderer: await js("window.uiLoad.sample()"),
      });
    }
    const end = wall();
    await input.workload?.finish();
    recording = false;
    await pause(50);
    await writeFile(
      path.join(directory, "renderer-events.json"),
      JSON.stringify(await js("window.uiLoad.stop()")),
    );
    await js("window.uiLoad.clear()");
    await foreground();
    const cycleCounters = await js(`window.uiLoad.cycles(${input.cycles})`);
    const rendererFinal = await js("window.uiLoad.dispose()");
    // Renderer singleton is disposed, so its catalog no longer follows events.
    for (const source of composition.plugins
      .state()
      .plugins.filter((plugin) => plugin.source === "development"))
      assert.equal((await composition.plugins.unlink(source.sourceKey)).ok, true);
    await composition.dispose();
    const final = snapshots();
    assert.ok(final.every((row) => Object.values(row.counters).every((value) => value === 0)));
    const afterHeap = await heap("after");
    return {
      kind: "ui-maximum-load-run",
      composition: "composeDesktopMain/createDesktopFoundation",
      scope: "actual production pane/status/singleton with formal fake provider",
      warmupMs: start + best.offset - warmupAt,
      durationMs: end - start - best.offset,
      baselineCounters,
      coldCounters,
      coldHeap,
      warmedRetired,
      fullCounters,
      cycleCounters,
      rendererFinal,
      final,
      baselineHeap,
      fullHeap,
      afterHeap,
      calibration,
      clock: best,
      native,
      cycles: input.cycles,
      tracePath,
      versions: process.versions,
      os: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      ramBytes: totalmem(),
      method:
        "HeapProfiler.collectGarbage + V8 used_heap_size and CDP Runtime.getHeapUsage, three samples; raw heap snapshots",
      normalClose: true,
    };
  } finally {
    window.off("blur", regainFocus);
    window.off("hide", regainFocus);
    window.off("minimize", regainFocus);
    if (focusRecovery) clearImmediate(focusRecovery);
    off();
    closeSync(traceFd);
    inspector.disconnect();
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
  }
}
