import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function checkSensorLab({
  js,
  key,
  until,
  pause,
  win,
  temporary,
  monitor,
  sensorLab,
}) {
  const settings = await js("smoke.settingsStore.getSnapshot().values");
  const click = async (text, root = "[data-testid=sensor-lab]") =>
    js(
      `Array.from(document.querySelectorAll(${JSON.stringify(`${root} button`)})).find(button => button.textContent.trim() === ${JSON.stringify(text)} && !button.disabled).click()`,
    );
  await js(
    'smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("toolTab","connection");smoke.settingsStore.set("locale","en")',
  );
  if (!(await js('Boolean(document.querySelector(".connection-banner.is-connected"))'))) {
    await click("Find EV3", "#tool-panel-connection");
    await until('!document.querySelector("#tool-panel-connection .primary").disabled');
    await js('document.querySelector("#tool-panel-connection .primary").click()');
    await until('Boolean(document.querySelector(".connection-banner.is-connected"))');
  }
  await js('document.querySelector("#tool-tab-monitor").click()');
  await until('!document.querySelector("#tool-panel-monitor").hidden');
  await js('document.querySelector("#monitor-view-readings").focus()');
  for (const [pressed, expected] of [
    ["ArrowRight", "lab"],
    ["ArrowRight", "readings"],
    ["ArrowLeft", "lab"],
    ["Home", "readings"],
    ["End", "lab"],
  ]) {
    await key(pressed);
    assert.equal(await js("document.activeElement.id"), `monitor-view-${expected}`);
    assert.equal(
      await js(`document.querySelector('#monitor-view-${expected}').getAttribute('aria-selected')`),
      "true",
    );
    assert.equal(
      await js(`document.querySelectorAll('.monitor-subtabs [tabindex="0"]').length`),
      1,
    );
  }
  await until('document.querySelectorAll(".sensor-lab-channel-list input").length >= 4');
  await js(
    'Array.from(document.querySelectorAll(".sensor-lab-channel-list input")).slice(0,4).forEach(input=>input.click())',
  );
  await until('document.querySelectorAll(".sensor-lab-channel-list input:checked").length === 4');
  assert.equal(
    await js(
      'Array.from(document.querySelectorAll(".sensor-lab-channel-list input:not(:checked)")).every(input=>input.disabled)',
    ),
    true,
  );
  await js('document.querySelector(".sensor-lab-view-controls .picker-trigger").focus()');
  await key("ArrowDown");
  await until('Boolean(document.querySelector(".picker-popup"))');
  await key("End");
  await key("Enter");
  assert.equal(
    await js('document.querySelector(".sensor-lab-view-controls .picker-trigger").textContent'),
    "Calibrated",
  );
  await key("Home");
  await key("Enter");
  assert.equal(
    await js('document.querySelector(".sensor-lab-view-controls .picker-trigger").textContent'),
    "Raw",
  );
  await js(
    `document.querySelector('.sensor-lab-calibration').closest('details').open=true;document.querySelector('.sensor-lab [aria-label="Channel to calibrate"]').focus()`,
  );
  await key("ArrowDown");
  await until('document.querySelectorAll(".picker-popup [role=option]").length === 4');
  const lastChannel = await js(
    'document.querySelectorAll(".picker-popup [role=option]")[3].getAttribute("aria-label")',
  );
  await key("End");
  await key("Enter");
  assert.equal(
    await js(
      `document.querySelector('.sensor-lab [aria-label="Channel to calibrate"]').textContent`,
    ),
    lastChannel,
  );
  await js('document.querySelector(".sensor-lab-calibration").closest("details").open=false');
  await js('document.querySelector("[data-testid=sensor-lab-start]").click()');
  await until('Boolean(document.querySelector("[data-testid=sensor-lab-stop]"))');
  await until(
    'document.querySelectorAll("#monitor-page-lab [data-testid=sensor-lab-chart]").length === 4',
  );
  assert.equal((await sensorLab.getState()).recording.channels.length, 4);
  assert.equal(await js('document.querySelector(".sensor-lab-channel-list").disabled'), true);
  assert.equal(
    await js(`document.querySelector('.sensor-lab [aria-label="Channel to calibrate"]').disabled`),
    true,
  );
  await js('document.querySelector("#monitor-view-readings").click()');
  assert.equal(
    await js(
      'document.querySelector("[data-testid=monitor-load-modes-0]")?.disabled ?? document.querySelector("#monitor-mode-0")?.disabled',
    ),
    true,
  );
  await js('document.querySelector("#monitor-view-lab").click();ed.focus()');
  await pause(200);
  const renders = await js("smoke.metrics.appRenders");
  const before = (await sensorLab.getState()).recording.frameCount;
  await pause(1100);
  assert.ok((await sensorLab.getState()).recording.frameCount > before);
  assert.equal(
    await js("smoke.metrics.appRenders"),
    renders,
    "Recording samples isolate editor renders",
  );
  assert.equal(await js("ed.hasTextFocus()"), true, "Recording samples preserve editor focus");

  await js('smoke.settingsStore.set("deviceOpen",false)');
  const hiddenFrames = (await sensorLab.getState()).recording.frameCount;
  win.hide();
  await until('document.visibilityState === "hidden"');
  await pause(1100);
  assert.ok(
    (await sensorLab.getState()).recording.frameCount > hiddenFrames,
    "Background recording continues when hidden",
  );
  win.show();
  win.focus();
  await until('document.visibilityState === "visible"');
  monitor.respondOnce({ status: "busy" });
  await until(
    'document.querySelector("[data-testid=sensor-recording-status]").textContent.includes("waiting")',
  );
  await js('document.querySelector(".sensor-recording-stop").click()');
  await until('!document.querySelector(".sensor-recording-stop")');
  const first = (await sensorLab.list())[0];
  const recording = await sensorLab.read(first.id);
  assert.equal(recording.reason, "manual");
  assert.ok(
    recording.frames.some(
      (frame) => frame.status === "busy" && frame.values.every((value) => value === null),
    ),
  );
  assert.equal((await sensorLab.getState()).saved, true);

  await js('smoke.settingsStore.set("deviceOpen",true)');
  await until('Boolean(document.querySelector("#monitor-view-lab"))');
  await js('document.querySelector("#monitor-view-lab").click()');
  await until('!document.querySelector("[data-testid=sensor-lab-start]").disabled');
  await js('document.querySelector("[data-testid=sensor-lab-start]").click()');
  await until('Boolean(document.querySelector("[data-testid=sensor-lab-stop]"))');
  await pause(1100);
  await js('document.querySelector("[data-testid=sensor-lab-stop]").click()');
  await until(
    'Boolean(document.querySelector("[data-testid=sensor-lab-start]")) && !document.querySelector("[data-testid=sensor-lab-start]").disabled',
  );
  await js(
    'Array.from(document.querySelectorAll(".sensor-lab-section")).find(node=>node.querySelector("summary").textContent.includes("Saved recordings")).open=true',
  );
  await until(
    'document.querySelectorAll(".sensor-lab-section > .sensor-lab-history > li").length === 2',
  );
  await click("Compare");
  await until('Boolean(document.querySelector(".sensor-lab-series-comparison"))');
  assert.ok(
    await js('document.querySelectorAll("#monitor-page-lab svg .is-comparison").length >= 4'),
  );
  await click("Expand charts");
  await until('Boolean(document.querySelector(".sensor-lab-expanded"))');
  assert.equal(
    await js(
      'document.querySelectorAll(".sensor-lab-expanded [data-testid=sensor-lab-chart]").length',
    ),
    4,
  );
  await until(`(() => {
    const dialog = document.querySelector(".sensor-lab-expanded");
    return dialog && dialog.getBoundingClientRect().width > 400 &&
      [...document.querySelectorAll(".modal-host *")].flatMap(node => node.getAnimations())
      .every(animation => !animation.pending && animation.playState !== "running");
  })()`);
  await js('document.querySelector(".sensor-lab-expanded .picker-trigger").focus()');
  await key("Home");
  await until('Boolean(document.querySelector(".modal-host .picker-popup"))');
  await key("Enter");
  assert.equal(
    await js('document.querySelector(".sensor-lab-expanded .picker-trigger").textContent'),
    "Latest 60 seconds",
  );
  await key("End");
  await until('Boolean(document.querySelector(".modal-host .picker-popup"))');
  await key("Escape");
  assert.equal(await js('Boolean(document.querySelector(".sensor-lab-expanded"))'), true);
  assert.equal(await js('document.activeElement.classList.contains("picker-trigger")'), true);
  await key("End");
  await key("Enter");
  assert.equal(
    await js('document.querySelector(".sensor-lab-expanded .picker-trigger").textContent'),
    "Full recording",
  );
  await pause(100);
  await fs.writeFile(
    path.join(temporary, "sensor-lab-expanded.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js('document.querySelector(".sensor-lab-expanded input[type=range]").focus()');
  await key("ArrowLeft");
  assert.ok(
    await js('Number(document.querySelector(".sensor-lab-expanded input[type=range]").value) >= 0'),
  );
  await key("Escape");
  await until('!document.querySelector(".sensor-lab-expanded")');
  await click("Export CSV"); // Native export dialog cancellation is tested independently.

  win.setSize(980, 650);
  await js('smoke.settingsStore.set("deviceWidth",320);smoke.settingsStore.set("uiScale",125)');
  await pause(400);
  for (const locale of ["en", "zh-TW"])
    for (const theme of ["dark", "light"]) {
      await js(
        `smoke.settingsStore.set("locale",${JSON.stringify(locale)});smoke.settingsStore.set("theme",${JSON.stringify(theme)})`,
      );
      await until(
        `document.documentElement.lang === ${JSON.stringify(locale)} && document.documentElement.dataset.theme === ${JSON.stringify(theme)}`,
      );
      await pause(300);
      assert.equal(
        await js(
          'document.querySelector("#tool-panel-monitor").scrollWidth <= document.querySelector("#tool-panel-monitor").clientWidth',
        ),
        true,
        `${locale}/${theme} charts fit 320px at 125%`,
      );
      await js('document.querySelector("#tool-panel-monitor").scrollTop=0');
      await fs.writeFile(
        path.join(temporary, `sensor-lab-${locale}-${theme}-320px-125.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await js('document.querySelector(".sensor-lab-charts").scrollIntoView({block:"start"})');
      await pause(100);
      await fs.writeFile(
        path.join(temporary, `sensor-lab-${locale}-${theme}-charts.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await js('document.querySelector(".sensor-lab-view-controls .picker-trigger").focus()');
      await key("ArrowDown");
      await until('Boolean(document.querySelector(".picker-popup"))');
      const popupLayout = await js(`(() => {
        const popup = document.querySelector('.picker-popup');
        const rect = popup.getBoundingClientRect();
        const trigger = document.querySelector('.sensor-lab-view-controls .picker-trigger');
        return {
          fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          rect: rect.toJSON(),
          overflows: popup.scrollWidth > popup.clientWidth,
          font: getComputedStyle(trigger).fontSize,
          expectedFont: getComputedStyle(popup.querySelector('.picker-option-label strong')).fontSize,
        };
      })()`);
      assert.equal(
        popupLayout.fits,
        true,
        `${locale}/${theme} picker stays within the window: ${JSON.stringify(popupLayout.rect)}`,
      );
      assert.equal(popupLayout.overflows, false, `${locale}/${theme} picker text fits`);
      assert.equal(popupLayout.font, popupLayout.expectedFont, "Picker keeps shared typography");
      await fs.writeFile(
        path.join(temporary, `sensor-lab-${locale}-${theme}-picker.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      await key("Escape");
      assert.equal(
        await js('document.activeElement.matches(".sensor-lab-view-controls .picker-trigger")'),
        true,
      );
    }
  await js('smoke.settingsStore.set("locale","en")');
  await click("Delete");
  await until('Boolean(document.querySelector("[role=alertdialog]"))');
  await click("Delete", "[role=alertdialog]");
  await until('!document.querySelector("[role=alertdialog]")');
  assert.equal((await sensorLab.list()).length, 1);
  assert.equal(monitor.stats().maxActive, 1, "UI and recording share one device exchange");
  await js('smoke.settingsStore.set("toolTab","connection")');
  await js('document.querySelector("#tool-panel-connection button.wide").click()');
  await until('!document.querySelector(".connection-banner.is-connected")');
  await js(
    `for(const [key,value] of Object.entries(${JSON.stringify(settings)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(1420, 900);
  console.log(
    "Sensor lab: four channels, mode lock, background capture/stop, gaps, persistence, comparison, expansion, keyboard, editor isolation and bilingual 320px/125% themes pass",
  );
}
