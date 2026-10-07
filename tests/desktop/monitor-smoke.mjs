import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export const monitorDescriptor = {
  id: "monitor-usb",
  name: "Monitor EV3",
  transport: "usb",
  serialNumber: "MONITOR-SMOKE",
};
const input = (port, patch) => ({
  port,
  type: 0,
  connection: 0,
  mode: 0,
  state: "empty",
  name: "",
  modeName: "",
  unit: "",
  decimals: 0,
  values: [],
  switchable: false,
  ...patch,
});
const snapshot = () => ({
  sampledAt: Date.now(),
  battery: { percent: 76, voltage: 7.42 },
  program: { status: "stopped", rawStatus: 0x40, result: 0 },
  inputs: [
    input(0, {
      type: 29,
      connection: 122,
      state: "ready",
      name: "EV3 Color",
      modeName: "COL-REFLECT",
      unit: "%",
      values: [42],
      switchable: true,
    }),
    input(1, { type: 32, connection: 122, state: "initializing", name: "EV3 Gyro" }),
    input(2, {
      type: 33,
      connection: 122,
      mode: 1,
      state: "ready",
      name: "EV3 Infrared",
      modeName: "IR-SEEK",
      values: [-10, 0, 25, null, 40, 4, 5, 7],
      switchable: true,
    }),
    input(3, { type: 100, connection: 120, state: "unknown", name: "Third-party sensor" }),
  ],
  outputs: [
    { port: 0, type: 7, state: "ready", name: "EV3 Large motor", angle: -120 },
    { port: 1, type: 126, state: "empty", name: "", angle: null },
    { port: 2, type: 100, state: "unknown", name: "Unknown motor", angle: null },
    { port: 3, type: 125, state: "error", name: "", angle: null },
  ],
});

// All state and controls stay in the smoke main process, outside the shipped API.
export function createMonitorFixture(send) {
  const descriptor = monitorDescriptor;
  let current = snapshot();
  let sessionId = "00000000-0000-4000-8000-000000000101";
  let nextReply;
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const requests = [];
  const changes = [];
  return {
    handles: (name) =>
      [
        "deviceMonitor",
        "deviceInputModes",
        "deviceSetInputMode",
        "deviceDiscover",
        "deviceConnect",
        "deviceConnectWifi",
        "deviceDisconnect",
        "deviceFiles",
      ].includes(name),
    async handle(name, args) {
      if (name === "deviceDiscover") return [descriptor];
      if (name === "deviceConnect" || name === "deviceConnectWifi") return sessionId;
      if (name === "deviceDisconnect") return;
      if (name === "deviceFiles")
        return {
          sessionId: args[0].sessionId,
          requestId: args[0].requestId,
          ok: true,
          entries: [],
        };
      if (name === "deviceInputModes")
        return {
          status: "ok",
          value: {
            port: args[1],
            type: args[2],
            modes: [
              { mode: 0, name: "COL-REFLECT" },
              { mode: 1, name: "COL-AMBIENT" },
              { mode: 2, name: "COL-COLOR" },
            ],
          },
        };
      if (name === "deviceSetInputMode") {
        changes.push(args);
        if (args[0] !== sessionId || current.program.status !== "stopped")
          return { status: "error", category: "protocol", message: "Program must be stopped." };
        current.inputs[args[1]].mode = args[3];
        current.inputs[args[1]].modeName = ["COL-REFLECT", "COL-AMBIENT", "COL-COLOR"][args[3]];
        return { status: "ok", value: structuredClone({ ...current, sampledAt: Date.now() }) };
      }
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      requests.push(args[0]);
      const reply = nextReply;
      nextReply = undefined;
      const value = structuredClone({ ...current, sampledAt: Date.now() });
      try {
        if (reply) return await reply(value);
        return { status: "ok", value };
      } finally {
        active--;
      }
    },
    patch(update) {
      update(current);
    },
    snapshot: () => structuredClone({ ...current, sampledAt: Date.now() }),
    sessionId: () => sessionId,
    stats: () => ({
      calls,
      active,
      maxActive,
      requests: [...requests],
      changes: structuredClone(changes),
    }),
    respondOnce(result) {
      nextReply = async () => result;
    },
    holdNext() {
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      nextReply = async (value) => {
        await gate;
        return { status: "ok", value };
      };
      return release;
    },
    recover() {
      const previousSessionId = sessionId;
      send({ type: "usb-recovery", state: "waiting", previousSessionId, descriptor });
      sessionId = "00000000-0000-4000-8000-000000000102";
      return () =>
        send({
          type: "usb-recovery",
          state: "restored",
          previousSessionId,
          sessionId,
          descriptor,
          deployment: "none",
        });
    },
  };
}

export async function checkMonitor({ js, key, until, pause, win, temporary, monitor }) {
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalContent = await js("ed.getValue()");
  const text = (id) => `document.querySelector('[data-testid="${id}"]')?.textContent ?? ''`;
  const state = "document.querySelector('[data-testid=\"monitor-status\"]')?.dataset.state";
  const waitCalls = async (count) => {
    for (let i = 0; i < 100 && monitor.stats().calls < count; i++) await pause(50);
    assert.ok(monitor.stats().calls >= count, `Expected at least ${count} monitor calls`);
  };
  await js(
    'smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("toolTab","connection");smoke.settingsStore.set("locale","en");smoke.settingsStore.set("autoSave","off")',
  );
  await until('Boolean(document.querySelector("#tool-tab-monitor"))');
  assert.deepEqual(
    await js('Array.from(document.querySelectorAll(".tools-tabs [role=tab]")).map(tab=>tab.id)'),
    ["tool-tab-connection", "tool-tab-monitor", "tool-tab-files", "tool-tab-activity"],
  );
  await js('document.querySelector("#tool-tab-connection").focus()');
  for (const [pressed, expected] of [
    ["ArrowRight", "monitor"],
    ["ArrowRight", "files"],
    ["End", "activity"],
    ["ArrowRight", "connection"],
    ["ArrowLeft", "activity"],
    ["Home", "connection"],
  ]) {
    await key(pressed);
    assert.equal(await js("document.activeElement.id"), `tool-tab-${expected}`);
    assert.equal(
      await js(`document.querySelector('#tool-tab-${expected}').getAttribute('aria-selected')`),
      "true",
    );
  }
  assert.equal(monitor.stats().calls, 0, "Disconnected tab visits do not request data");
  await js(
    `Array.from(document.querySelectorAll('#tool-panel-connection button')).find(button=>button.textContent==='Find EV3').click()`,
  );
  await until('!document.querySelector("#tool-panel-connection .primary").disabled');
  await js('document.querySelector("#tool-panel-connection .primary").click()');
  await until('Boolean(document.querySelector(".connection-banner.is-connected"))');
  await js('document.querySelector("#tool-tab-monitor").click()');
  await until(`${state} === "live"`);
  assert.match(await js(text("monitor-battery")), /76%/);
  assert.match(await js('document.querySelector(".monitor-summary").textContent'), /7\.42 V/);
  assert.match(await js(text("monitor-input-0")), /EV3 color.*COL-REFLECT.*42/is);
  assert.match(await js(text("monitor-input-1")), /Initializing/i);
  assert.match(await js(text("monitor-input-2")), /IR-SEEK.*-10.*25.*40/s);
  assert.match(await js(text("monitor-input-3")), /Unknown/i);
  assert.match(await js(text("monitor-output-0")), /-120/);
  assert.match(await js(text("monitor-output-1")), /Not connected/i);
  assert.match(await js(text("monitor-output-3")), /Device error/i);
  assert.equal(
    await js(
      "document.querySelectorAll('[data-testid=\"monitor-input-2\"] .monitor-values dd').length",
    ),
    8,
  );
  assert.equal(
    await js(
      "document.querySelectorAll('[data-testid=\"monitor-input-2\"] .monitor-values dd')[3].textContent",
    ),
    "Invalid reading",
  );
  assert.equal(await js("document.querySelector('[data-testid=\"monitor-load-modes-3\"]')"), null);
  assert.doesNotMatch(await js(text("ev3-monitor")), /NaN|undefined/);

  await js("document.querySelector('[data-testid=\"monitor-load-modes-0\"]').click()");
  await until('Boolean(document.querySelector("#monitor-mode-0"))');
  await js('document.querySelector("#monitor-mode-0").focus()');
  await key("ArrowDown");
  await until('Boolean(document.querySelector(".picker-popup"))');
  await key("End");
  await key("Enter");
  await until('!document.querySelector(".picker-popup")');
  await until(`(${text("monitor-input-0")}).includes("COL-COLOR")`);
  assert.deepEqual(monitor.stats().changes, [["00000000-0000-4000-8000-000000000101", 0, 29, 2]]);
  for (const program of ["running", "unknown"]) {
    monitor.patch((sample) => {
      sample.program.status = program;
    });
    await until(`(${text("monitor-program")}).toLowerCase().includes(${JSON.stringify(program)})`);
    assert.equal(await js('document.querySelector("#monitor-mode-0").disabled'), true);
  }
  monitor.patch((sample) => {
    sample.program.status = "stopped";
    sample.inputs[0].values = [12, 24, 36];
  });
  await until(`(${text("monitor-input-0")}).includes("36")`);
  assert.equal(
    await js(
      "document.querySelectorAll('[data-testid=\"monitor-input-0\"] .monitor-values dd').length",
    ),
    3,
  );
  assert.equal(await js('document.querySelector("#monitor-mode-0").disabled'), false);

  // Independent monitor updates must not replace the editor or rerender the workbench.
  // Establish actual window focus after preceding settings/history smoke dialogs.
  win.focus();
  await js(
    "window.monitorEditor=ed;window.monitorModel=ed.getModel();ed.focus();ed.setPosition({lineNumber:1,column:1})",
  );
  await pause(700);
  await until("document.hasFocus() && ed.hasTextFocus()");
  const renders = await js("smoke.metrics.appRenders");
  const activity = await js('document.querySelector(".activity-list").textContent');
  const pollingStart = monitor.stats().calls;
  monitor.patch((sample) => {
    sample.inputs[0].values = [13, 25, 37];
  });
  await until(`(${text("monitor-input-0")}).includes("37")`);
  await waitCalls(pollingStart + 2);
  assert.equal(await js("smoke.metrics.appRenders"), renders);
  assert.equal(await js('document.querySelector(".activity-list").textContent'), activity);
  assert.equal(
    await js(
      "ed===window.monitorEditor && ed.getModel()===window.monitorModel && ed.hasTextFocus()",
    ),
    true,
  );
  win.webContents.sendInputEvent({ type: "char", keyCode: "'" });
  await pause(80);
  assert.equal(await js("ed.getValue()"), `'${originalContent}`);
  await js('ed.trigger("test","undo",null)');
  assert.equal(await js("ed.getValue()"), originalContent);

  // A busy foreground operation and recoverable read failure keep the last values.
  monitor.respondOnce({ status: "busy" });
  await until(`${state} === "waiting"`);
  assert.match(await js(text("monitor-input-0")), /37/);
  monitor.respondOnce({ status: "error", category: "protocol", message: "Simulated read failure" });
  await until(`${state} === "error"`);
  assert.match(await js(text("monitor-input-0")), /37/);
  await until(`${state} === "live"`);

  // Delayed data from a closed tab is discarded and does not cancel the exchange.
  monitor.patch((sample) => {
    sample.inputs[0].values = [999];
  });
  const releaseClosed = monitor.holdNext();
  await waitCalls(monitor.stats().calls + 1);
  assert.equal(monitor.stats().active, 1);
  await js('document.querySelector("#tool-tab-activity").click()');
  const closedCount = monitor.stats().calls;
  await pause(700);
  assert.equal(monitor.stats().active, 1);
  assert.equal(monitor.stats().calls, closedCount);
  releaseClosed();
  await pause(700);
  assert.equal(monitor.stats().calls, closedCount);
  assert.doesNotMatch(await js(text("monitor-input-0")), /999/);
  monitor.patch((sample) => {
    sample.inputs[0].values = [38];
  });
  await js('document.querySelector("#tool-tab-monitor").click()');
  await until(`(${text("monitor-input-0")}).includes("38")`);

  // Electron visibility changes exercise the production document visibility listener.
  win.hide();
  await until('document.visibilityState === "hidden"');
  await until(`${state} === "paused"`);
  await pause(150);
  const hiddenCount = monitor.stats().calls;
  await pause(700);
  assert.equal(monitor.stats().calls, hiddenCount);
  win.show();
  win.focus();
  await until('document.visibilityState === "visible"');
  await waitCalls(hiddenCount + 1);

  monitor.patch((sample) => {
    sample.inputs[0].values = [888];
  });
  const releaseOld = monitor.holdNext();
  await waitCalls(monitor.stats().calls + 1);
  const restore = monitor.recover();
  await pause(100);
  monitor.patch((sample) => {
    sample.inputs[0].values = [39];
  });
  restore();
  releaseOld();
  await until(`(${text("monitor-input-0")}).includes("39")`);
  assert.doesNotMatch(await js(text("monitor-input-0")), /888/);
  assert.equal(monitor.stats().requests.at(-1), "00000000-0000-4000-8000-000000000102");
  assert.equal(await js('document.querySelector("#monitor-mode-0")'), null);
  assert.equal(
    await js("Boolean(document.querySelector('[data-testid=\"monitor-load-modes-0\"]'))"),
    true,
    "A new session requires a fresh mode list",
  );
  assert.equal(
    monitor.stats().maxActive,
    1,
    "No overlapping sample requests, including session replacement",
  );

  win.setSize(980, 650);
  await js('smoke.settingsStore.set("deviceWidth",320);smoke.settingsStore.set("uiScale",125)');
  // Native resizing and the 220 ms workspace transition can outlast a fixed
  // delay. Wait for the requested dimensions and finite pane animations before
  // measuring; do not include the editor's repeating cursor animation.
  const layoutSettled = `(() => {
    const workspace = document.querySelector(".workspace");
    const panel = document.querySelector(".device-panel");
    if (!workspace || !panel || window.outerWidth !== 980 || window.outerHeight !== 650)
      return false;
    if (Math.abs(panel.getBoundingClientRect().width - 320) > 0.5)
      return false;
    if (getComputedStyle(document.documentElement).getPropertyValue("--ui-scale").trim() !== "1.25")
      return false;
    return [...workspace.getAnimations(), ...panel.getAnimations({ subtree: true })]
      .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
      .every(animation => !animation.pending && animation.playState !== "running");
  })()`;
  await until(layoutSettled);
  for (const locale of ["en", "zh-TW"])
    for (const theme of ["dark", "light"]) {
      await js(
        `smoke.settingsStore.set("locale",${JSON.stringify(locale)});smoke.settingsStore.set("theme",${JSON.stringify(theme)})`,
      );
      await until(
        `document.documentElement.lang === ${JSON.stringify(locale)} && document.documentElement.dataset.theme === ${JSON.stringify(theme)} && ${layoutSettled}`,
      );
      assert.equal(
        await js(
          'document.querySelector("#tool-panel-monitor").scrollWidth <= document.querySelector("#tool-panel-monitor").clientWidth',
        ),
        true,
        `${locale}/${theme} panel fits 320px at 125%`,
      );
      // Equal-width tabs intentionally truncate long translated labels at this
      // minimum width. Verify containment and accessible full labels rather than
      // requiring text scrollWidth to shrink with the clipped visual content.
      const tabLayout = await js(`(() => {
        const bar = document.querySelector(".tools-tabs");
        const bounds = bar.getBoundingClientRect();
        return {
          width: bounds.width, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
          tabs: Array.from(bar.querySelectorAll("button")).map(node => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return {
              text: node.textContent.trim(),
              name: node.getAttribute("aria-label") || node.textContent.trim(),
              title: node.title,
              left: box.left - bounds.left, right: box.right - bounds.left, width: box.width,
              scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
              scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
              display: style.display, whiteSpace: style.whiteSpace, overflowX: style.overflowX,
              textOverflow: style.textOverflow,
            };
          }),
        };
      })()`);
      const expectedTabs =
        locale === "en"
          ? ["Connection", "Monitor", "EV3 files", "Activity"]
          : ["連線", "監測", "EV3 檔案", "操作紀錄"];
      assert.equal(tabLayout.tabs.length, 4);
      assert.ok(tabLayout.scrollWidth <= tabLayout.clientWidth, `${locale}/${theme} tab bar fits`);
      tabLayout.tabs.forEach((tab, index) => {
        const context = `${locale}/${theme} ${expectedTabs[index]} tab`;
        assert.equal(tab.text, expectedTabs[index], `${context} retains its full text`);
        assert.equal(tab.name, expectedTabs[index], `${context} retains its accessible name`);
        assert.equal(tab.title, expectedTabs[index], `${context} exposes its full tooltip`);
        assert.ok(tab.left >= -1 && tab.right <= tabLayout.width + 1, `${context} stays in bounds`);
        assert.ok(Math.abs(tab.width - tabLayout.width / 4) <= 1, `${context} retains equal width`);
        assert.equal(tab.display, "block", `${context} uses a text box where ellipsis can render`);
        assert.equal(tab.whiteSpace, "nowrap", `${context} stays on one line`);
        assert.ok(tab.scrollHeight <= tab.clientHeight, `${context} is not vertically clipped`);
        if (tab.scrollWidth > tab.clientWidth) {
          assert.equal(tab.overflowX, "hidden", `${context} clips overflow safely`);
          assert.equal(tab.textOverflow, "ellipsis", `${context} visibly indicates truncation`);
        }
      });
      assert.equal(
        await js('document.querySelector("#tool-tab-monitor").textContent'),
        locale === "en" ? "Monitor" : "監測",
      );
      await fs.writeFile(
        path.join(temporary, `monitor-${locale}-${theme}-320px-125.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      for (const [section, selector] of [
        ["inputs", ".monitor-inputs"],
        ["outputs", ".monitor-outputs"],
      ]) {
        await js(
          `(() => { const panel=document.querySelector('#tool-panel-monitor');const section=document.querySelector(${JSON.stringify(selector)});panel.scrollTop+=section.getBoundingClientRect().top-panel.getBoundingClientRect().top; })()`,
        );
        await pause(80);
        await fs.writeFile(
          path.join(temporary, `monitor-${locale}-${theme}-${section}-320px-125.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
      await js('document.querySelector("#tool-panel-monitor").scrollTop=0');
    }
  await js('smoke.settingsStore.set("deviceOpen",false)');
  await pause(150);
  const panelClosed = monitor.stats().calls;
  await pause(700);
  assert.equal(monitor.stats().calls, panelClosed, "Closing the tools panel stops polling");
  await js(
    'smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("toolTab","connection")',
  );
  await until('Boolean(document.querySelector(".connection-banner.is-connected"))');
  await js('document.querySelector("#tool-panel-connection button.wide").click()');
  await until('!document.querySelector(".connection-banner.is-connected")');
  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(1420, 900);
  await js("ed.focus()");
  console.log(
    "EV3 monitor: four-tab keyboard navigation, values/modes, polling lifecycle, stale session replies, editor isolation and bilingual 320px/125% themes pass",
  );
}
