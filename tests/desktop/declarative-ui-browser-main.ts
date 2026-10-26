import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { app, crashReporter, type BrowserWindow, type KeyboardInputEvent } from "electron";
import type * as Presentation from "./declarative-ui-presentation.js";

const output = app.commandLine.getSwitchValue("ui-browser-output");
const probe = app.commandLine.getSwitchValue("ui-browser-probe");
const diagnostics = app.commandLine.hasSwitch("ui-browser-diagnostics");
app.setPath("crashDumps", path.join(path.dirname(output), "crashes"));
crashReporter.start({ uploadToServer: false });
let failing = false;
const fail = (error: unknown) => {
  if (failing) return;
  failing = true;
  console.error(error);
  void writeFile(`${output}.failure.json`, JSON.stringify({ error: String(error) })).finally(() =>
    app.exit(1),
  );
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
setTimeout(
  () => fail(new Error("UI browser acceptance timed out")),
  diagnostics ? 170_000 : 90_000,
).unref();
let started = false;
app.on("browser-window-created", (_event, window) => {
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("UI_RENDERER_EXIT", JSON.stringify(details));
    if (details.reason !== "clean-exit")
      fail(new Error(`Actual renderer exited: ${JSON.stringify(details)}`));
  });
  window.webContents.on("console-message", (details) =>
    console.error(`renderer: ${details.message}`),
  );
  window.webContents.once("did-finish-load", () => {
    if (started) return;
    started = true;
    void (async () => {
      await window.webContents.executeJavaScript(await readFile(probe, "utf8"));
      const report = await window.webContents.executeJavaScript(
        "declarativeProbe.run().catch(error => { console.error(error.stack); throw error; })",
      );
      assert.equal(report.kind, "ui-browser-baseline");
      const legacy = app.commandLine.hasSwitch("ui-browser-legacy")
        ? await window.webContents.executeJavaScript("declarativeProbe.runLegacy()")
        : undefined;
      console.error("UI_PHASE browser-probe-complete");
      await window.webContents.executeJavaScript(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      console.error("UI_PHASE painted");
      console.error(
        "UI_RENDERER_METRICS",
        JSON.stringify({
          pid: window.webContents.getOSProcessId(),
          metrics: app.getAppMetrics(),
          focused: window.isFocused(),
          visible: window.isVisible(),
        }),
      );
      const bounds = await window.webContents.executeJavaScript("declarativeProbe.noteBounds()");
      console.error("UI_NATIVE_TARGET", JSON.stringify({ bounds, size: window.getContentSize() }));
      await writeFile(
        `${output}.before-input.png`,
        (await window.webContents.capturePage()).toPNG(),
      );
      console.error("UI_PHASE captured");
      window.focus();
      console.error("UI_PHASE focus-requested");
      const focusDeadline = performance.now() + 5000;
      while (!window.isFocused() && performance.now() < focusDeadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(window.isFocused(), true, "native workbench never focused");
      console.error("UI_PHASE native-window-focused");
      window.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        x: bounds.x,
        y: bounds.y,
        clickCount: 1,
      });
      window.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        x: bounds.x,
        y: bounds.y,
        clickCount: 1,
      });
      let focus = false;
      const inputDeadline = performance.now() + 2000;
      while (!focus && performance.now() < inputDeadline) {
        focus = await window.webContents.executeJavaScript("declarativeProbe.noteBounds().focused");
        if (!focus) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(focus, true, "native mouse input did not focus the real note control");
      console.error("UI_PHASE native-input-complete");
      const presentation = app.commandLine.hasSwitch("ui-browser-presentation")
        ? await presentationMatrix(window)
        : undefined;
      const secondInstance = app.commandLine.hasSwitch("ui-browser-second-instance")
        ? await observeSecondInstance(window)
        : undefined;
      const heap = async () => {
        const samples: Record<string, number>[] = [];
        for (let n = 0; n < 3; n++) {
          await window.webContents.debugger.sendCommand("HeapProfiler.collectGarbage");
          await new Promise((resolve) => setTimeout(resolve, 50));
          const sample = (await window.webContents.debugger.sendCommand(
            "Runtime.getHeapUsage",
          )) as Record<string, number>;
          assert.ok(Number.isFinite(sample.usedSize) && sample.usedSize! > 0);
          samples.push(sample);
        }
        return samples;
      };
      if (diagnostics) window.webContents.debugger.attach("1.3");
      const heapBefore = diagnostics ? await heap() : undefined;
      const rendererDiagnostics = diagnostics
        ? await window.webContents.executeJavaScript("window.declarativeDiagnostics.run(1000)")
        : undefined;
      if (rendererDiagnostics) {
        assert.equal(rendererDiagnostics.cycles, 1000);
        assert.ok(Object.values(rendererDiagnostics.final.counters).every((value) => value === 0));
        console.error("UI_PHASE renderer-diagnostics-complete");
      }
      const heapAfter = diagnostics ? await heap() : undefined;
      const rendererHeap =
        heapBefore && heapAfter
          ? {
              method:
                "CDP HeapProfiler.collectGarbage + Runtime.getHeapUsage, three settled collections",
              scope: "renderer-isolate-only",
              before: heapBefore,
              after: heapAfter,
              retainedBytes:
                Math.max(...heapAfter.map((sample) => sample.usedSize!)) -
                Math.min(...heapBefore.map((sample) => sample.usedSize!)),
            }
          : undefined;
      if (rendererHeap)
        assert.ok(
          rendererHeap.retainedBytes < 2 * 1024 * 1024,
          `renderer retained ${rendererHeap.retainedBytes} bytes`,
        );
      if (diagnostics) window.webContents.debugger.detach();
      await writeFile(
        output,
        JSON.stringify(
          {
            ...report,
            nativeInput: true,
            productionMain: true,
            productionPreload: true,
            productionRenderer: true,
            ...(rendererDiagnostics ? { rendererDiagnostics } : {}),
            ...(rendererHeap ? { rendererHeap } : {}),
            ...(legacy ? { legacy } : {}),
            ...(presentation ? { presentation } : {}),
            ...(secondInstance ? { secondInstance } : {}),
            versions: process.versions,
            childPids: [
              ...new Set([
                ...report.pluginPids,
                ...(legacy?.pluginPids ?? []),
                ...app
                  .getAppMetrics()
                  .map((item) => item.pid)
                  .filter((pid) => pid !== process.pid),
              ]),
            ],
          },
          null,
          2,
        ),
      );
      if (app.commandLine.hasSwitch("ui-browser-reopen")) {
        assert.equal(
          process.platform,
          "darwin",
          "last-window activation is a macOS acceptance case",
        );
        const replacement = new Promise<BrowserWindow>((resolve) => {
          app.once("browser-window-created", (_event, next) =>
            next.webContents.once("did-finish-load", () => resolve(next)),
          );
        });
        window.once("closed", () => {
          app.emit("activate");
        });
        window.close();
        const next = await replacement;
        next.show();
        next.focus();
        const focusedAt = performance.now();
        while (
          (!next.isFocused() ||
            !(await next.webContents.executeJavaScript("document.hasFocus()"))) &&
          performance.now() - focusedAt < 5000
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(next.isFocused(), true, "replacement workbench focus");
        await next.webContents.executeJavaScript(await readFile(probe, "utf8"));
        const reopened = await next.webContents.executeJavaScript(
          'declarativeProbe.run().catch(error => { console.error(JSON.stringify({focus:document.hasFocus(), pane:document.querySelector(".plugin-tools-pane")?.outerHTML})); throw error; })',
        );
        const receipt = JSON.parse(await readFile(output, "utf8"));
        assert.equal(reopened.currentBinding.hostEpoch, report.currentBinding.hostEpoch);
        assert.notEqual(reopened.currentBinding.processEpoch, report.currentBinding.processEpoch);
        assert.notEqual(reopened.currentBinding.panelInstance, report.currentBinding.panelInstance);
        const stale = await next.webContents.executeJavaScript(
          `window.kobrixa.plugins.ui.snapshot({binding:${JSON.stringify(report.currentBinding)}})`,
        );
        assert.equal(stale.ok, false, "old window binding survived replacement");
        receipt.reopened = { ...reopened, oldWindowBindingRejected: true };
        receipt.childPids.push(...reopened.pluginPids);
        await writeFile(output, JSON.stringify(receipt, null, 2));
        next.once("closed", () => app.quit());
        next.close();
      } else {
        window.once("closed", () => app.quit());
        window.close(); // Exercise the production handshake, flush and retirement path.
      }
    })().catch(fail);
  });
});

async function observeSecondInstance(window: BrowserWindow) {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  window.minimize();
  const deadline = performance.now() + 5000;
  while (!window.isMinimized() && performance.now() < deadline) await pause(20);
  assert.equal(window.isMinimized(), true, "primary did not minimize before second launch");
  let receivedAt = 0;
  const onSecond = () => {
    receivedAt = performance.now();
  };
  app.on("second-instance", onSecond);
  const receipt = path.join(path.dirname(output), "secondary.json");
  const child = spawn(
    process.execPath,
    [
      path.join(__dirname, "ui-secondary.cjs"),
      `--ui-secondary-output=${receipt}`,
      `--user-data-dir=${app.getPath("userData")}`,
      `--plugin-dev-dir=${app.commandLine.getSwitchValue("plugin-dev-dir")}`,
    ],
    { cwd: path.dirname(output), stdio: ["ignore", "pipe", "pipe"] },
  );
  const logs: string[] = [];
  let logBytes = 0;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data: Buffer) => {
      if (logBytes < 524288) {
        logs.push(data.toString());
        logBytes += data.length;
      }
    });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
        timer = setTimeout(() => reject(new Error("secondary did not exit normally")), 10000);
      },
    );
    assert.deepEqual(result, { code: 0, signal: null });
    const state = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(state.pid, child.pid);
    assert.equal(state.lockRequests, 1);
    assert.equal(state.lockGranted, false);
    assert.equal(state.whenReadyCalls, 0);
    assert.equal(state.windows, 0);
    assert.equal(state.utilityForks, 0);
    assert.equal(state.quit, true);
    const focusDeadline = performance.now() + 5000;
    while (
      (!receivedAt || window.isMinimized() || !window.isFocused()) &&
      performance.now() < focusDeadline
    )
      await pause(20);
    assert.ok(receivedAt > 0);
    assert.equal(window.isMinimized(), false);
    assert.equal(window.isFocused(), true);
    return {
      ...state,
      receivedAt,
      primaryRestored: true,
      primaryFocused: true,
      profile: app.getPath("userData"),
      exit: result,
      productionGuard: true,
      scope:
        "Actual secondary production entry registers no startup callback, window or utility process; software guard tests identify writers/providers inside that callback.",
    };
  } finally {
    if (timer) clearTimeout(timer);
    app.removeListener("second-instance", onSecond);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await writeFile(path.join(path.dirname(output), "secondary.log"), logs.join(""));
  }
}

async function presentationMatrix(window: BrowserWindow) {
  const contents = window.webContents;
  type Probe = typeof Presentation;
  const js = <T>(expression: string): Promise<T> => contents.executeJavaScript(expression);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const key = (keyCode: string, modifiers: KeyboardInputEvent["modifiers"] = []) => {
    contents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
    contents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  };
  const click = async (selector: string) => {
    const point = await js<ReturnType<Probe["target"]>>(
      `declarativePresentation.target(${JSON.stringify(selector)})`,
    );
    const zoom = contents.getZoomFactor();
    for (const type of ["mouseDown", "mouseUp"] as const)
      contents.sendInputEvent({
        type,
        button: "left",
        clickCount: 1,
        x: Math.round(point.x * zoom),
        y: Math.round(point.y * zoom),
      });
    await pause(60);
  };
  const replaceNumber = async (text: string) => {
    await click('[data-ui-node="speed"] input');
    contents.selectAll(); // Native editing command; shortcut dispatch is platform/menu-dependent.
    await pause(20);
    key("Backspace");
    await pause(20);
    for (const char of text) {
      contents.sendInputEvent({ type: "char", keyCode: char });
      await pause(20);
    }
    await pause(120);
  };
  contents.setZoomFactor(1.25);
  assert.equal(contents.getZoomFactor(), 1.25);
  const cases = [];
  let draftReopen: Awaited<ReturnType<Probe["retainInvalidThroughClose"]>> | undefined;
  contents.debugger.attach("1.3");
  try {
    for (const locale of ["en", "zh-TW"])
      for (const theme of ["light", "dark"]) {
        const layout = await js<Awaited<ReturnType<Probe["configure"]>>>(
          `declarativePresentation.configure(${JSON.stringify(locale)},${JSON.stringify(theme)})`,
        );
        await replaceNumber("-");
        const invalid = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(invalid.value, "-");
        assert.equal(invalid.invalid, "true");
        assert.equal(invalid.focused, true);
        await pause(350);
        const afterPatches = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(afterPatches.value, "-");
        assert.equal(afterPatches.focused, true);
        const beforeRecovery = await js<ReturnType<Probe["recoveryRequest"]>>(
          "declarativePresentation.recoveryRequest()",
        );
        const beforeCoreForm = await js<Awaited<ReturnType<Probe["acceptedForm"]>>>(
          "declarativePresentation.acceptedForm()",
        );
        await click('[data-ui-node="recovery"] button');
        const recovery = await js<Awaited<ReturnType<Probe["recovered"]>>>(
          `declarativePresentation.recovered(${beforeRecovery})`,
        );
        assert.equal(recovery.formRevision, beforeCoreForm.formRevision);
        assert.equal(recovery.invalid, "true");
        if (!draftReopen)
          draftReopen = await js<Awaited<ReturnType<Probe["retainInvalidThroughClose"]>>>(
            "declarativePresentation.retainInvalidThroughClose()",
          );
        await replaceNumber("25");
        const corrected = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(corrected.draft.speed, 25);
        assert.equal(corrected.invalid, "false");
        key("Tab");
        await pause(60);
        const tabbed = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(tabbed.activeNode, "level", "native Tab did not advance to next field");
        key("Tab");
        await pause(60);
        const slider = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(slider.activeType, "range", "native Tab did not reach actual range input");
        key("Right");
        await pause(60);
        const range = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(
          range.draft.level,
          Number(tabbed.draft.level) + 1,
          "native range key did not change value",
        );
        await click('[data-ui-node="mode"] label:first-of-type input');
        const choice = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(choice.draft.mode, "coast");
        key("Right");
        await pause(60);
        const choiceKey = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(choiceKey.draft.mode, "brake");
        const beforeAction = await js<Awaited<ReturnType<Probe["acceptedForm"]>>>(
          "declarativePresentation.acceptedForm()",
        );
        await click('[data-ui-node="activate"] button');
        const accepted = await js<Awaited<ReturnType<Probe["acceptedAction"]>>>(
          `declarativePresentation.acceptedAction(${beforeAction.formRevision + 1},25)`,
        );
        assert.equal(accepted.form.level, range.draft.level);
        assert.equal(accepted.form.mode, "brake");
        await click('[data-ui-node="enabled"] input');
        const hidden = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(hidden.enabled, false);
        assert.equal(hidden.alertVisible, false);
        key("Space");
        await pause(60);
        const shown = await js<ReturnType<Probe["inputSnapshot"]>>(
          "declarativePresentation.inputSnapshot()",
        );
        assert.equal(shown.enabled, true);
        assert.equal(shown.alertVisible, true);
        const announcements = await js<Awaited<ReturnType<Probe["observeAnnouncements"]>>>(
          "declarativePresentation.observeAnnouncements()",
        );
        const ax = await contents.debugger.sendCommand("Accessibility.getFullAXTree");
        const stem = `presentation-${locale}-${theme}`;
        await writeFile(
          path.join(path.dirname(output), `${stem}.ax.json`),
          JSON.stringify(ax, null, 2),
        );
        await js('document.querySelector(".plugin-tools-pane").scrollTop = 0');
        await pause(80);
        await writeFile(
          path.join(path.dirname(output), `${stem}-top.png`),
          (await contents.capturePage()).toPNG(),
        );
        await js(
          'document.querySelector(".plugin-tools-pane").scrollTop = document.querySelector(".plugin-tools-pane").scrollHeight',
        );
        await pause(80);
        await writeFile(
          path.join(path.dirname(output), `${stem}-bottom.png`),
          (await contents.capturePage()).toPNG(),
        );
        cases.push({
          layout,
          scalePercent: 100 * contents.getZoomFactor(),
          invalid,
          afterPatches,
          corrected,
          tabbed,
          range,
          choice,
          choiceKey,
          hidden,
          shown,
          announcements,
          beforeAction,
          accepted,
          beforeCoreForm,
          recovery,
          accessibilityTree: `${stem}.ax.json`,
          screenshots: [`${stem}-top.png`, `${stem}-bottom.png`],
        });
      }
    const siblings = await js<Awaited<ReturnType<Probe["siblingPanes"]>>>(
      "declarativePresentation.siblingPanes()",
    );
    return {
      version: 3,
      cases,
      draftReopen,
      siblings,
      input: "native mouse/keyboard; production controls and preferences store",
      screenReaderSpeech: "unrun",
    };
  } finally {
    contents.debugger.detach();
    contents.setZoomFactor(1);
  }
}
// Execute the exact production bundle once. No mock IPC or alternative services.
// This observer is a sibling of the copied bundle so its preload/renderer paths stay intact.
createRequire(path.join(__dirname, "package.json"))("./main.cjs");
