import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { BasicPlusFrontend } from "../../frontends/basic-plus/dist/index.js";

export async function compileSimulationFixture(files, overlays, entries) {
  const programs = {};
  const diagnostics = [];
  for (const entry of new Set(entries)) {
    const result = await new BasicPlusFrontend().compile(
      {
        root: "/simulator",
        manifest: {
          schemaVersion: 1,
          name: "simulation",
          language: "bp",
          entry,
          target: "ev3-native",
          assets: [],
          outputDir: "build",
        },
        sources: Object.entries({ ...files, ...overlays })
          .filter(([file]) => /\.(bp|bpi|bpm)$/i.test(file))
          .map(([path, content]) => ({ path, content })),
        assets: [],
      },
      new AbortController().signal,
    );
    diagnostics.push(...result.diagnostics);
    if (result.ir) programs[entry] = { ir: result.ir, files: {} };
  }
  return diagnostics.some((item) => item.severity === "error") ||
    Object.keys(programs).length !== new Set(entries).size
    ? { success: false, diagnostics }
    : { success: true, diagnostics, prepared: { programs } };
}

/** Real workbench, Canvas, module worker and physics; only workspace/compiler IPC is a fixture. */
export async function checkSimulator({ js, until, pause, win, temporary, key, mod }) {
  const oldSize = win.getSize();
  const old = await js("window.ed.getValue()");
  const sourceFile = await js("document.querySelector('.tabs .tab.active .tab-select').title");
  const settings = await js("smoke.settingsStore.getSnapshot().values");
  const source =
    'LCD.Clear()\nLCD.Text(1, 8, 8, 1, "TENNIS")\nLCD.Update()\nMotor.Start("BC", 25)\nProgram.Delay(1500)\nMotor.Stop("BC", True)\n';
  const click = (id) => js(`document.querySelector('[data-testid="${id}"]').click()`);
  const state = (value) =>
    `document.querySelector('[data-testid="simulator-status"]')?.dataset.state===${JSON.stringify(value)}`;
  await js(
    'smoke.settingsStore.set("locale","en");smoke.settingsStore.set("filesOpen",false);smoke.settingsStore.set("rightPanel",null);smoke.settingsStore.set("problemsOpen",false)',
  );
  await js(`window.ed.setValue(${JSON.stringify(source)});window.ed.focus()`);
  await key("F5", ["alt"]);
  await until("Boolean(document.querySelector('.simulator-workspace'))");
  await until(state("ready"));
  assert.equal(await js("Boolean(document.querySelector('.monaco-editor'))"), true);
  const checkComfortableControls = async () => {
    const layout = await js(`(() => {
      const font = (selector) => parseFloat(getComputedStyle(document.querySelector(selector)).fontSize);
      const targets = [...document.querySelectorAll('.sim-transport button, .sim-tabs button, .sim-robot-settings input:not([type="checkbox"]), .sim-robot-settings .picker-trigger')];
      return {
        bodyFont: font('.simulator-workspace'),
        labelFont: font('.sim-field-group'),
        smallestTarget: Math.min(...targets.map((element) => element.getBoundingClientRect().height)),
        overflow: ['.sim-transport', '.sim-body', '.sim-side-content'].some((selector) => {
          const element = document.querySelector(selector);
          return element.scrollWidth > element.clientWidth + 1;
        }),
      };
    })()`);
    assert.ok(layout.bodyFont >= 15, "Simulator text must remain readable");
    assert.ok(layout.labelFont >= 14, "Setting labels must remain readable");
    assert.ok(layout.smallestTarget >= 40, "Controls must not shrink in smaller panes");
    assert.equal(layout.overflow, false, "Controls must reflow without horizontal clipping");
  };
  await checkComfortableControls();
  // Simulator controls share the workbench's keyboard and popup behavior.
  await js("document.querySelector('#sim-tab-setup').focus()");
  await key("Home");
  await until("document.activeElement?.id==='sim-tab-scene'");
  await key("ArrowRight");
  await until("document.activeElement?.id==='sim-tab-setup'");
  assert.equal(
    await js("document.querySelectorAll('.sim-tabs [role=tab][tabindex=\"0\"]').length"),
    1,
  );
  await js("document.querySelector('.picker-trigger[aria-label=\"Controller\"]').click()");
  await until("Boolean(document.querySelector('.picker-search'))");
  await js(
    `(()=>{const input=document.querySelector('.picker-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(sourceFile)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
  );
  await until("document.querySelectorAll('.picker-popup [role=option]').length===1");
  await key("Enter");
  await until("!document.querySelector('.picker-popup')");
  await js("document.querySelector('.sim-layers .picker-trigger').click()");
  await until("Boolean(document.querySelector('[role=listbox][aria-multiselectable=true]'))");
  await js("document.querySelector('[data-picker-value=collisions]').click()");
  assert.equal(
    await js(
      "document.querySelector('[data-picker-value=collisions]').getAttribute('aria-selected')",
    ),
    "false",
  );
  await key("Escape");
  await until("!document.querySelector('.picker-popup')");
  assert.equal(
    await js("document.activeElement===document.querySelector('.sim-layers .picker-trigger')"),
    true,
  );
  // Incomplete form edits remain correctable without editing the JSON by hand.
  await js(
    "(()=>{const input=document.querySelector('.sim-robot-settings input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  await pause(100);
  assert.equal(await js("document.querySelector('.sim-robot-settings').disabled"), false);
  assert.equal(await js("Boolean(document.querySelector('.simulation-scene-error'))"), false);
  await js(
    "(()=>{const input=document.querySelector('.sim-robot-settings input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'A1');input.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  await click("simulator-start");
  await until(state("running"));
  await until(
    "Number(document.querySelector('[data-testid=simulator-status]').dataset.timeMs)>=500",
  );
  await click("simulator-start");
  await until(state("paused"));
  const frozen = await js(
    "document.querySelector('[data-testid=simulator-status]').dataset.timeMs",
  );
  await pause(100);
  assert.equal(
    await js("document.querySelector('[data-testid=simulator-status]').dataset.timeMs"),
    frozen,
  );
  assert.equal(
    await js(
      "Number(document.querySelector('[data-testid=simulator-robot-distance]').textContent.match(/[\\d.]+/)[0])>20",
    ),
    true,
  );
  await click("simulator-step");
  await until(
    `Number(document.querySelector('[data-testid=simulator-status]').dataset.timeMs)===${Number(frozen) + 10}`,
  );
  assert.equal(await js("document.querySelector('.sim-lcd').width"), 178);
  assert.equal(
    await js(
      "Array.from(document.querySelector('.sim-lcd').getContext('2d').getImageData(0,0,178,128).data).some((value,index)=>index%4===0&&value<100)",
    ),
    true,
  );
  assert.equal(await js("document.querySelector('[data-testid=simulator-field]').width>100"), true);
  await fs.writeFile(
    path.join(temporary, "simulator-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  // Expanding preserves the live world and mounted editor; source navigation restores the editor.
  const fieldWidth = await js(
    "document.querySelector('[data-testid=simulator-field]').getBoundingClientRect().width",
  );
  const expandedTime = await js(
    "document.querySelector('[data-testid=simulator-status]').dataset.timeMs",
  );
  await click("simulator-expand");
  await until("getComputedStyle(document.querySelector('.editor-stage')).display==='none'");
  await until(
    `document.querySelector('[data-testid=simulator-field]').getBoundingClientRect().width>${fieldWidth}`,
  );
  await pause(200);
  assert.equal(
    await js("document.querySelector('[data-testid=simulator-status]').dataset.timeMs"),
    expandedTime,
  );
  assert.equal(await js("window.ed.getValue()"), source);
  await fs.writeFile(
    path.join(temporary, "simulator-expanded-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js("document.querySelector('.sim-location button').click()");
  await until("getComputedStyle(document.querySelector('.editor-stage')).display!=='none'");
  assert.equal(
    await js(
      "document.querySelector('[data-testid=simulator-expand]').getAttribute('aria-pressed')",
    ),
    "false",
  );
  // Hiding the work area pauses the existing world, and returning does not auto-run.
  await click("simulator-start");
  await until(state("running"));
  await key(",", [mod]);
  await until(state("paused"));
  const hiddenTime = await js(
    "document.querySelector('[data-testid=simulator-status]').dataset.timeMs",
  );
  await pause(100);
  assert.equal(
    await js("document.querySelector('[data-testid=simulator-status]').dataset.timeMs"),
    hiddenTime,
  );
  await js("document.querySelector('.settings-tab .tab-close').click()");
  await until("!document.querySelector('.settings-tab')");
  await click("simulator-reset");
  await until(state("ready"));
  assert.equal(
    await js("Number(document.querySelector('[data-testid=simulator-status]').dataset.timeMs)"),
    0,
  );
  // Invalid source must fail preparation without resuming the previous successful program.
  await js('window.ed.setValue("If Then\\n")');
  await click("simulator-recompile");
  await until(state("error"));
  assert.match(
    await js("document.querySelector('.sim-error').textContent"),
    /main.bp|If|Expected/i,
  );
  await js(`window.ed.setValue(${JSON.stringify(source)})`);
  await click("simulator-recompile");
  await until(state("ready"));
  // Scene is a normal versioned project file and survives closing the panel.
  await click("simulator-save");
  await until(
    "document.querySelector('[data-testid=simulator-scoreboard]').textContent.includes('Scene saved')",
  );
  // Invalid JSON blocks execution. Discarding its tab must also discard the live scene.
  await js("document.querySelector('.tab-select[title=\"kobrixa.simulator.json\"]').click()");
  await until("window.ed.getModel().uri.path.endsWith('kobrixa.simulator.json')");
  await js("window.ed.setValue('{ invalid scene')");
  await until("Boolean(document.querySelector('.simulation-scene-error'))");
  assert.equal(await js("document.querySelector('[data-testid=simulator-start]').disabled"), true);
  await js(
    "document.querySelector('.tab-select[title=\"kobrixa.simulator.json\"]').closest('.tab').querySelector('.tab-close').click()",
  );
  await until("Boolean(document.querySelector('[aria-labelledby=close-tab-title]'))");
  await js("document.querySelector('[aria-labelledby=close-tab-title] .danger').click()");
  await until("!document.querySelector('.simulator-workspace')");
  await key("F5", ["alt"]);
  await until(state("ready"));
  assert.equal(await js("Boolean(document.querySelector('.simulation-scene-error'))"), false);
  await js(
    `Array.from(document.querySelectorAll('.tabs .tab-select')).find(button=>button.title===${JSON.stringify(sourceFile)}).click()`,
  );
  await until(`window.ed.getModel().uri.path.endsWith(${JSON.stringify(sourceFile)})`);
  await js('smoke.settingsStore.set("locale","zh-TW")');
  win.setSize(980, 700);
  await pause(200);
  assert.equal(await js("document.documentElement.scrollWidth<=window.innerWidth"), true);
  await checkComfortableControls();
  assert.equal(
    await js(
      "(()=>{const body=document.querySelector('.sim-body').getBoundingClientRect();const field=document.querySelector('[data-testid=simulator-field]').getBoundingClientRect();return Math.min(body.bottom,field.bottom)-Math.max(body.top,field.top)>140})()",
    ),
    true,
    "Narrow view must show the playing field",
  );
  await fs.writeFile(
    path.join(temporary, "simulator-zh.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  const narrowFieldHeight = await js(
    "document.querySelector('[data-testid=simulator-field]').getBoundingClientRect().height",
  );
  await click("simulator-expand");
  await until("getComputedStyle(document.querySelector('.editor-stage')).display==='none'");
  await pause(200);
  const expandedFieldHeight = await js(
    "document.querySelector('[data-testid=simulator-field]').getBoundingClientRect().height",
  );
  assert.ok(
    expandedFieldHeight > narrowFieldHeight,
    `Expanding a short window must give the field more height (${narrowFieldHeight} → ${expandedFieldHeight})`,
  );
  await checkComfortableControls();
  await fs.writeFile(
    path.join(temporary, "simulator-expanded-zh.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await click("simulator-expand");
  await until("getComputedStyle(document.querySelector('.editor-stage')).display!=='none'");
  // Configure a Pixy2 through the shared Picker and run real I2C calls in the module Worker.
  win.setSize(1420, 900);
  await js('smoke.settingsStore.set("locale","en")');
  await js(
    "Array.from(document.querySelectorAll('.sim-robot-settings summary')).find(summary=>summary.textContent.includes('Sensors')).click()",
  );
  await js(
    "Array.from(document.querySelectorAll('.sim-robot-settings .picker-trigger[aria-label=Kind]')).at(-1).click()",
  );
  await until("Boolean(document.querySelector('[data-picker-value=pixy2]'))");
  await js("document.querySelector('[data-picker-value=pixy2]').click()");
  await until(
    "Boolean(document.querySelector('.picker-trigger[aria-label=\"Orange signature\"]'))",
  );
  await js(
    "document.querySelector('.picker-trigger[aria-label=\"Orange signature\"]').scrollIntoView({block:'center'})",
  );
  await pause(100);
  await fs.writeFile(
    path.join(temporary, "simulator-pixy2-setup.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  const pixySource =
    'block = Sensor.ReadI2CRegisters(4, 1, 80, 6)\nsignature = block[0]\nwidth = block[4]\nLCD.Clear()\nLCD.Text(1, 8, 8, 1, "Pixy2 " + signature)\nLCD.Update()\n';
  await js(`window.ed.setValue(${JSON.stringify(pixySource)})`);
  await click("simulator-recompile");
  await until(state("ready"));
  await click("simulator-start");
  await until("document.querySelector('.sim-readout dd')?.textContent==='completed'");
  assert.equal(await js("Boolean(document.querySelector('.sim-error'))"), false);
  assert.match(await js("document.querySelector('.sim-side-content').textContent"), /Pixy2/);
  assert.ok(
    await js(
      "Array.from(document.querySelectorAll('.sim-table tr')).some(row=>row.querySelector('th')?.textContent==='signature'&&Number(row.querySelector('td')?.textContent)>0)",
    ),
  );
  await click("simulator-start");
  await until(state("paused"));
  await click("simulator-close");
  await until("!document.querySelector('.simulator-workspace')");
  win.setSize(...oldSize);
  await js(
    `window.ed.setValue(${JSON.stringify(old)});smoke.settingsStore.set("locale",${JSON.stringify(settings.locale)});smoke.settingsStore.set("filesOpen",${settings.filesOpen});smoke.settingsStore.set("rightPanel",${JSON.stringify(settings.rightPanel)});smoke.settingsStore.set("problemsOpen",${settings.problemsOpen})`,
  );
}
