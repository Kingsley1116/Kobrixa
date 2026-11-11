import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

// Test-only broker watch port for the retained battery demand. No private feature routes.
export function createMonitorFixture() {
  let calls = 0;
  let active = 0;
  let releases = 0;
  return {
    async watch(sessionId, _interval, receive) {
      calls++;
      active++;
      receive(
        {
          sessionId,
          status: "fresh",
          frame: {
            status: "ok",
            sampledAt: Date.now(),
            program: "stopped",
            values: [
              { channelId: "battery-percent", value: 76 },
              { channelId: "battery-voltage", value: 7.42 },
            ],
          },
        },
        {
          channels: [
            { channelId: "battery-percent", kind: "battery-percent" },
            { channelId: "battery-voltage", kind: "battery-voltage" },
          ],
        },
      );
      let released = false;
      return async () => {
        if (!released) {
          released = true;
          active--;
          releases++;
        }
      };
    },
    handles: (name) => ["deviceDisconnect", "deviceFiles"].includes(name),
    async handle(name, args) {
      if (name === "deviceDisconnect") return;
      if (name === "deviceFiles")
        return {
          sessionId: args[0].sessionId,
          requestId: args[0].requestId,
          ok: true,
          entries: [],
        };
      throw new Error(`Unknown core device fixture call: ${name}`);
    },
    stats: () => ({ calls, active, releases }),
  };
}

export async function checkMonitor({ js, key, until, pause, win, temporary, monitor }) {
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalContent = await js("ed.getValue()");
  const initialCalls = monitor.stats().calls;
  await js(
    'smoke.settingsStore.set("rightPanel","ev3");smoke.settingsStore.set("ev3Tab","connection");smoke.settingsStore.set("locale","en");smoke.settingsStore.set("autoSave","off")',
  );
  await until('Boolean(document.querySelector("#tool-tab-monitor"))');
  assert.deepEqual(
    await js('Array.from(document.querySelectorAll(".tools-tabs [role=tab]")).map(tab=>tab.id)'),
    ["tool-tab-connection", "tool-tab-monitor", "tool-tab-files"],
  );
  await js('document.querySelector("#tool-tab-connection").focus()');
  for (const [pressed, expected] of [
    ["ArrowRight", "monitor"],
    ["ArrowRight", "files"],
    ["End", "files"],
    ["ArrowRight", "connection"],
    ["ArrowLeft", "files"],
    ["Home", "connection"],
  ]) {
    await key(pressed);
    assert.equal(await js("document.activeElement.id"), `tool-tab-${expected}`);
    assert.equal(
      await js(`document.querySelector('#tool-tab-${expected}').getAttribute('aria-selected')`),
      "true",
    );
  }
  assert.equal(monitor.stats().calls, initialCalls, "Disconnected tab visits do not request data");
  assert.equal(
    await js(
      'document.querySelector(".connection-method, #tool-panel-connection input, #tool-panel-connection .primary")',
    ),
    null,
  );
  assert.equal(await js('document.querySelector("[data-testid=ev3-monitor]")'), null);
  await js('document.querySelector("#tool-tab-monitor").click()');
  await until('document.querySelectorAll("[data-plugin-destination]").length===2');
  for (const feature of ["device-ev3", "sensor-lab"]) {
    await js(`document.querySelector('[data-plugin-destination="${feature}"] button').click()`);
    await until('smoke.settingsStore.getSnapshot().values.rightPanel==="plugins"');
    await js('smoke.settingsStore.set("rightPanel","ev3")');
  }
  // Public feature behavior is a separate required native acceptance run. This
  // checks only the retired destination and retained workbench navigation.
  await js('smoke.settingsStore.set("deviceWidth",320);smoke.settingsStore.set("uiScale",125)');
  win.setSize(980, 650);
  for (const locale of ["en", "zh-TW"])
    for (const theme of ["dark", "light"]) {
      await js(
        `smoke.settingsStore.set("locale",${JSON.stringify(locale)});smoke.settingsStore.set("theme",${JSON.stringify(theme)})`,
      );
      await pause(120);
      assert.equal(
        await js(
          'document.querySelector("#tool-panel-monitor").scrollWidth <= document.querySelector("#tool-panel-monitor").clientWidth',
        ),
        true,
      );
      assert.equal(
        await js(
          'document.querySelector(".monitor-panel, .monitor-subtabs, #tool-panel-monitor input, #tool-panel-monitor select")',
        ),
        null,
      );
      await fs.writeFile(
        path.join(temporary, `monitor-retirement-${locale}-${theme}-320px-125.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
  assert.equal(monitor.stats().calls, initialCalls, "Redirects do not start private sampling");
  assert.equal(await js("ed.getValue()"), originalContent);
  await js(`for (const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) {
    if (!["connectionMode","rememberWifiAddress"].includes(key)) smoke.settingsStore.set(key,value);
  }`);
  win.setSize(1420, 900);
  await js("ed.focus()");
  console.log(
    "EV3 retirement: navigation, public-tool redirects, absent legacy controls and bilingual 320px/125% layout pass; replacement device parity is NOT RUN by this check",
  );
}
