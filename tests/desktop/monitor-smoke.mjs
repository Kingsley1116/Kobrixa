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
