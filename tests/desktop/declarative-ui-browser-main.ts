import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { app, crashReporter } from "electron";

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
            versions: process.versions,
            childPids: [
              ...new Set([
                ...report.pluginPids,
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
      window.once("closed", () => app.quit());
      window.close(); // Exercise the production handshake, flush and retirement path.
    })().catch(fail);
  });
});
// Execute the exact production bundle once. No mock IPC or alternative services.
// This observer is a sibling of the copied bundle so its preload/renderer paths stay intact.
createRequire(path.join(__dirname, "package.json"))("./main.cjs");
