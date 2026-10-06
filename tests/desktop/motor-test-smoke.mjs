import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Only hardware is simulated. Renderer IPC, orchestration, cadence, owner checks,
// finite pulses and terminal states use the production MotorTestService.
export function createMotorFixture({ MotorTestService, monitor, recording, publish, deviceEvent }) {
  let busy = false;
  let drive;
  let helper;
  let request;
  let uploaded;
  const actions = [];
  const settle = () => {
    if (drive) {
      const elapsed = Math.min(Date.now(), drive.until) - drive.started;
      monitor.patch((snapshot) => {
        snapshot.outputs[drive.port].angle =
          drive.origin + Math.round((elapsed * drive.power) / 100);
      });
      if (Date.now() >= drive.until) drive = undefined;
    }
    if (helper?.state === 1) {
      const progress = Math.min(1, (Date.now() - helper.started) / 350);
      monitor.patch((snapshot) => {
        snapshot.outputs[helper.port].angle =
          helper.origin + Math.round(progress * helper.degrees * helper.direction);
      });
      if (progress === 1) {
        helper.state = 2;
        helper.result = 1;
      }
    }
  };
  const session = {
    connected: true,
    async readMotorTest() {
      settle();
      const snapshot = monitor.snapshot();
      return {
        sampledAt: Date.now(),
        programStopped: !helper,
        outputs: snapshot.outputs.map((output) => ({
          port: output.port,
          type: output.type,
          angle: output.angle,
          busy: drive?.port === output.port || (helper?.state === 1 && helper.port === output.port),
          speed:
            drive?.port === output.port
              ? drive.power
              : helper?.state === 1 && helper.port === output.port
                ? 20
                : 0,
        })),
      };
    },
    async motorTimed(port, power, durationMs, brake) {
      assert.equal(helper, undefined);
      assert.ok(durationMs >= 100 && durationMs <= 5000);
      settle();
      actions.push({ type: "timed", port, power, durationMs, brake });
      drive = {
        port,
        power,
        started: Date.now(),
        until: Date.now() + durationMs,
        origin: monitor.snapshot().outputs[port].angle,
      };
    },
    async motorStop(port, brake) {
      settle();
      drive = undefined;
      actions.push({ type: "stop", port, brake });
    },
    async upload(remotePath, image) {
      assert.equal(new TextDecoder().decode(image.subarray(0, 4)), "LEGO");
      uploaded = remotePath;
      actions.push({ type: "upload", remotePath });
    },
    async runMotorHelper(remotePath) {
      assert.equal(remotePath, uploaded);
      assert.equal(request.mode, "angle");
      helper = {
        state: 0,
        result: 0,
        token: undefined,
        port: request.port,
        degrees: request.degrees,
        direction: request.direction,
        origin: monitor.snapshot().outputs[request.port].angle,
      };
      actions.push({ type: "helper-start" });
    },
    async readMotorHelper(token) {
      settle();
      if (!helper) return { owned: false, state: 0, result: 0, angle: null };
      helper.token ??= token;
      return {
        owned: helper.token === token,
        state: helper.state,
        result: helper.result,
        angle: monitor.snapshot().outputs[helper.port].angle,
      };
    },
    async armMotorHelper(token) {
      assert.equal(helper.token, token);
      assert.equal(helper.state, 0);
      helper.state = 1;
      helper.started = Date.now();
      actions.push({ type: "helper-arm" });
    },
    async stopMotorHelper(token, port, brake) {
      if (!helper || helper.token !== token || helper.port !== port) return false;
      settle();
      helper = undefined;
      actions.push({ type: "helper-stop", port, brake });
      return true;
    },
    async delete(remotePath) {
      assert.equal(helper, undefined);
      assert.equal(remotePath, uploaded);
      actions.push({ type: "delete", remotePath });
      uploaded = undefined;
    },
  };
  const service = new MotorTestService({
    async run(id, work) {
      assert.equal(id, monitor.sessionId());
      if (busy) throw new Error("Another EV3 operation is in progress.");
      busy = true;
      deviceEvent({ type: "state", state: "busy", sessionId: id, transport: "usb" });
      try {
        while (monitor.stats().active) await delay(5);
        return await work(session, new AbortController().signal);
      } finally {
        busy = false;
        deviceEvent({ type: "state", state: "connected", sessionId: id, transport: "usb" });
      }
    },
    recording,
    publish,
  });
  return {
    service,
    get busy() {
      return busy;
    },
    start(value, owner) {
      request = value;
      return service.start(value, owner);
    },
    actions: () => structuredClone(actions),
  };
}

export async function checkMotorTests({ js, until, pause, win, temporary, monitor, motors }) {
  const settings = await js("smoke.settingsStore.getSnapshot().values");
  const snapshot = monitor.snapshot();
  const bounds = win.getBounds();
  monitor.patch((value) => {
    value.program = { status: "stopped", rawStatus: 64, result: 0 };
    value.outputs = [
      { port: 0, type: 7, state: "ready", name: "EV3 Large motor", angle: -120 },
      { port: 1, type: 8, state: "ready", name: "EV3 Medium motor", angle: 45 },
      { port: 2, type: 126, state: "empty", name: "", angle: null },
      { port: 3, type: 126, state: "empty", name: "", angle: null },
    ];
  });
  const toggle = (port) => `[data-testid="motor-test-toggle-${port}"]`;
  const control = (id) => `[data-testid="motor-test-0"] [data-testid="${id}"]`;
  const state = `document.querySelector(${JSON.stringify(control("motor-test-status"))})?.dataset.state`;
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const selectMode = async (index) => {
    await js(`document.querySelectorAll("#motor-mode-0 [role=radio]")[${index}].click()`);
    await until(
      `document.querySelectorAll("#motor-mode-0 [role=radio]")[${index}].getAttribute("aria-checked") === "true"`,
    );
  };
  const ready = () =>
    until(
      `!document.querySelector(${JSON.stringify(control("motor-test-start"))})?.disabled && document.querySelector('[data-testid="monitor-status"]')?.dataset.state === "live"`,
    );
  try {
    await js(
      'smoke.settingsStore.set("locale","en");smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("toolTab","connection");smoke.settingsStore.set("autoSave","off")',
    );
    await until('Boolean(document.querySelector("#tool-panel-connection"))');
    if (!(await js('Boolean(document.querySelector(".connection-banner.is-connected"))'))) {
      await js(
        `Array.from(document.querySelectorAll('#tool-panel-connection button')).find(button=>button.textContent==='Find EV3').click()`,
      );
      await until('!document.querySelector("#tool-panel-connection .primary").disabled');
      await click("#tool-panel-connection .primary");
      await until('Boolean(document.querySelector(".connection-banner.is-connected"))');
    }
    await click("#tool-tab-monitor");
    await click("#monitor-view-readings");
    await until(`Boolean(document.querySelector(${JSON.stringify(toggle(1))}))`);
    assert.deepEqual(
      await js('Array.from(document.querySelectorAll(".tools-tabs [role=tab]")).map(tab=>tab.id)'),
      ["tool-tab-connection", "tool-tab-monitor", "tool-tab-files", "tool-tab-activity"],
    );
    assert.deepEqual(
      await js(
        'Array.from(document.querySelectorAll(".monitor-subtabs [role=tab]")).map(tab=>tab.id)',
      ),
      ["monitor-view-readings", "monitor-view-lab"],
    );
    await click(toggle(0));
    await until(
      `document.querySelector(${JSON.stringify(toggle(0))}).getAttribute('aria-expanded') === 'true'`,
    );
    assert.equal(
      await js(`document.querySelector(${JSON.stringify(control("motor-test-power"))}).value`),
      "20",
    );
    assert.equal(
      await js(
        'Math.abs(document.querySelector(".monitor-outputs").getBoundingClientRect().width-document.querySelector(".motor-test-expanded").getBoundingClientRect().width)<1',
      ),
      true,
    );
    await click(toggle(1));
    assert.equal(await js('document.querySelectorAll(".motor-test-expanded").length'), 1);
    assert.equal(
      await js(
        `document.querySelector(${JSON.stringify(toggle(0))}).getAttribute('aria-expanded')`,
      ),
      "false",
    );
    await click(toggle(0));

    await selectMode(1);
    await ready();
    const beforeTimed = motors.actions().length;
    await click(control("motor-test-start"));
    await until(`${state} === 'running'`);
    assert.equal(await js(`document.querySelector(${JSON.stringify(toggle(1))}).disabled`), true);
    assert.equal(
      await js('document.querySelector("[data-testid=motor-test-0] fieldset").disabled'),
      true,
    );
    await until(`${state} === 'completed'`);
    const timed = motors.actions().slice(beforeTimed);
    assert.equal(timed.filter((action) => action.type === "timed").length, 1);
    assert.equal(timed.find((action) => action.type === "timed").durationMs, 1000);
    assert.ok(timed.some((action) => action.type === "stop"));

    await selectMode(2);
    await ready();
    const beforeAngle = motors.actions().length;
    await click(control("motor-test-start"));
    await until(
      `${state} === 'completed' && Boolean(document.querySelector('[data-testid="motor-test-0"] .motor-test-values'))`,
    );
    const angle = motors
      .actions()
      .slice(beforeAngle)
      .map((action) => action.type);
    assert.deepEqual(angle, ["upload", "helper-start", "helper-arm", "helper-stop", "delete"]);
    assert.equal(motors.service.getState().displacement, 90);

    await selectMode(0);
    await until(`!document.querySelector(${JSON.stringify(control("motor-test-jog"))}).disabled`);
    await js(`document.querySelector(${JSON.stringify(control("motor-test-jog"))}).focus()`);
    win.focus();
    win.webContents.focus();
    const beforeJog = motors.actions().length;
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until(`${state} === 'running'`);
    await pause(550);
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await until(`${state} === 'stopped'`);
    const jog = motors.actions().slice(beforeJog);
    assert.ok(
      jog.filter((action) => action.type === "timed").length >= 2,
      "Held keyboard jog is renewed by the real service",
    );
    assert.ok(
      jog.filter((action) => action.type === "timed").every((action) => action.durationMs === 400),
    );
    const stoppedCount = motors.actions().length;
    await pause(450);
    assert.equal(motors.actions().length, stoppedCount, "No pulse follows release");

    await js(
      `document.querySelector(${JSON.stringify(control("motor-test-jog-reverse"))}).focus()`,
    );
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    await until(`${state} === 'running'`);
    assert.equal(motors.service.getState().request.direction, -1, "Reverse jog runs backwards");
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await until(`${state} === 'stopped'`);

    await selectMode(1);
    await ready();
    await click(control("motor-test-start"));
    await until(`${state} === 'running'`);
    await click(toggle(0));
    await until(
      `document.querySelector(${JSON.stringify(toggle(0))}).getAttribute('aria-expanded') === 'false'`,
    );
    assert.equal(motors.service.getState().phase, "stopped");
    assert.equal(motors.actions().at(-1).type, "stop");
    await click(toggle(0));

    win.setSize(980, 650);
    await js('smoke.settingsStore.set("deviceWidth",320);smoke.settingsStore.set("uiScale",125)');
    for (const [locale, theme] of [
      ["en", "dark"],
      ["zh-TW", "light"],
    ]) {
      await js(
        `smoke.settingsStore.set('locale',${JSON.stringify(locale)});smoke.settingsStore.set('theme',${JSON.stringify(theme)})`,
      );
      await until(
        `document.documentElement.lang === ${JSON.stringify(locale)} && Math.abs(document.querySelector('.device-panel').getBoundingClientRect().width-320)<1`,
      );
      await pause(300);
      assert.equal(
        await js(
          'document.querySelector("#tool-panel-monitor").scrollWidth <= document.querySelector("#tool-panel-monitor").clientWidth',
        ),
        true,
        `${locale} motor controls fit the narrow sidebar`,
      );
      assert.equal(
        await js(
          `document.querySelector(${JSON.stringify(control("motor-test-start"))}).textContent`,
        ),
        locale === "en" ? "Start test" : "開始測試",
      );
      await js(
        `document.querySelector('[data-testid="monitor-output-0"]').scrollIntoView({block:'start'})`,
      );
      await pause(100);
      await fs.writeFile(
        path.join(temporary, `motor-test-${locale}-${theme}-320px-125.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await js(
        `document.querySelector(${JSON.stringify(control("motor-test-status"))}).scrollIntoView({block:'center'})`,
      );
      await pause(100);
      await fs.writeFile(
        path.join(temporary, `motor-test-${locale}-${theme}-results-320px-125.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    console.log(
      "Motor test: inline cards, single expansion, timed/angle completion, native held-key jog, release/collapse stop and bilingual narrow sidebar pass",
    );
  } catch (error) {
    console.error("Motor smoke state", motors.service.getState(), motors.actions());
    console.error(
      "Motor renderer state",
      await js(`document.querySelector('[data-testid="motor-test-0"]')?.outerHTML`),
    );
    await fs.writeFile(
      path.join(temporary, "motor-test-failure.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    throw error;
  } finally {
    await motors.service.stopAll();
    await js('smoke.settingsStore.set("toolTab","connection")');
    if (await js('Boolean(document.querySelector(".connection-banner.is-connected"))')) {
      await click("#tool-panel-connection button.wide");
      await until('!document.querySelector(".connection-banner.is-connected")');
    }
    monitor.patch((current) => Object.assign(current, snapshot));
    await js(
      `for (const [key,value] of Object.entries(${JSON.stringify(settings)})) smoke.settingsStore.set(key,value)`,
    );
    win.setBounds(bounds);
  }
}
