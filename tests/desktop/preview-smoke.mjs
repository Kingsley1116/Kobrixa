import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";

export function compilePreview(source) {
  return new BasicPlusFrontend().compile(
    {
      root: "/offline-preview",
      manifest: {
        schemaVersion: 1,
        name: "preview",
        language: "bp",
        entry: "main.bp",
        target: "ev3-native",
        assets: [],
        outputDir: "build",
      },
      sources: [{ path: "main.bp", content: source }],
      assets: [],
    },
    new AbortController().signal,
  );
}

/** Real React, module worker and raster display; only project/build IPC is a fixture. */
export async function checkOfflinePreview({ js, until, pause, win, temporary, key }) {
  const oldSize = win.getSize();
  const old = await js("window.ed.getValue()");
  const settings = await js("smoke.settingsStore.getSnapshot().values");
  const source =
    'LCD.Clear()\nLCD.Text(1, 8, 8, 1, "OFFLINE")\nLCD.Update()\nWhile Not Button.IsPressed("ENTER")\nProgram.Delay(20)\nEndWhile\nvalue = Sensor.ReadPercent(1)\nMotor.Move("A", 30, 90, True)\nLCD.Write(0, 2, value)\nLCD.Update()\n';
  const click = async (testid) => js(`document.querySelector('[data-testid=${testid}]').click()`);
  let launches = 0;
  const launch = async (text) => {
    await js(`window.ed.setValue(${JSON.stringify(text)});window.ed.focus()`);
    if (++launches === 1) await key("F5", ["alt"]);
    else
      await js(
        "Array.from(document.querySelectorAll('.run-actions button')).find(b=>b.textContent==='Offline preview').click()",
      );
    await until("Boolean(document.querySelector('.offline-preview'))");
    await until("document.querySelector('.preview-status')?.dataset.state==='ready'");
  };
  await js('smoke.settingsStore.set("locale","en")');
  await launch(source);
  assert.equal(await js("document.querySelector('.preview-lcd').width"), 178);
  await click("preview-step");
  await until("document.querySelector('.preview-status')?.dataset.state==='paused'");
  await click("preview-run");
  await until("document.querySelector('.preview-events').textContent.includes('OFFLINE')");
  await until("document.querySelector('.preview-status')?.dataset.state==='running'");
  await click("preview-run");
  await until("document.querySelector('.preview-status')?.dataset.state==='paused'");
  const frozen = await js("document.querySelector('.preview-status-row').textContent");
  await pause(100);
  assert.equal(await js("document.querySelector('.preview-status-row').textContent"), frozen);
  // Native keyboard interaction with virtual button while paused, then resume.
  await js("document.querySelector('[data-preview-button=enter]').focus()");
  await win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  await until(
    "document.querySelector('[data-preview-button=enter]').getAttribute('aria-pressed')==='true'",
  );
  await click("preview-run");
  await until("document.querySelector('.preview-status')?.dataset.state==='completed'");
  await win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  assert.match(
    await js(
      "document.querySelector('.preview-motor[data-port=A]')?.textContent || document.querySelector('.preview-motors').textContent",
    ),
    /90/,
  );
  assert.equal(
    await js(
      "Array.from(document.querySelector('.preview-lcd').getContext('2d').getImageData(0,0,178,128).data).some((value,index)=>index%4===0&&value<100)",
    ),
    true,
  );
  await click("preview-reset");
  await until("document.querySelector('.preview-status')?.dataset.state==='ready'");
  await js(
    "Array.from(document.querySelectorAll('.preview-toolbar button')).find(b=>b.textContent==='Rebuild preview').click()",
  );
  await until("document.querySelector('.preview-status')?.dataset.state==='ready'");
  await click("preview-stop");
  await until("document.querySelector('.preview-status')?.dataset.state==='stopped'");
  await key("Escape");
  await until("!document.querySelector('.offline-preview')");
  await launch('EV3.SystemCall("echo forbidden")\n');
  await click("preview-run");
  await until("document.querySelector('.preview-status')?.dataset.state==='error'");
  assert.match(await js("document.querySelector('.preview-error').textContent"), /SystemCall/);
  await key("Escape");
  await until("!document.querySelector('.offline-preview')");
  await launch(source);
  await click("preview-run");
  await until("document.querySelector('.preview-events').textContent.includes('OFFLINE')");
  await click("preview-run");
  await until("document.querySelector('.preview-status')?.dataset.state==='paused'");
  await fs.writeFile(
    path.join(temporary, "offline-preview-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js('smoke.settingsStore.set("locale","zh-TW");smoke.settingsStore.set("theme","light")');
  win.setSize(980, 650);
  await pause(150);
  assert.match(await js("document.querySelector('.offline-preview h2').textContent"), /離線預演/);
  assert.equal(
    await js(
      "document.querySelector('.offline-preview').scrollWidth <= document.querySelector('.offline-preview').clientWidth",
    ),
    true,
  );
  await fs.writeFile(
    path.join(temporary, "offline-preview-zh.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await key("Escape");
  await until("!document.querySelector('.offline-preview')");
  await js(
    `smoke.settingsStore.set("locale",${JSON.stringify(settings.locale)});smoke.settingsStore.set("theme",${JSON.stringify(settings.theme)});window.ed.setValue(${JSON.stringify(old)});window.ed.focus()`,
  );
  win.setSize(...oldSize);
}
