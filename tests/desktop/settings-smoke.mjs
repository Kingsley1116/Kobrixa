import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function checkExpandedSettings({
  js,
  key,
  until,
  pause,
  win,
  mod,
  temporary,
  systemTheme,
}) {
  const original = await js("smoke.settingsStore.getSnapshot().values");
  const content = await js("ed.getValue()");
  await js(
    `window.settingsEditor = ed; ed.pushUndoStop(); ed.executeEdits('settings-smoke',[{range:new smoke.monaco.Range(1,1,1,1),text:"' settings smoke\\n"}]);ed.pushUndoStop();`,
  );
  await key(",", [mod]);
  await until('!document.querySelector("#settings-page").hidden');
  await js(
    `window.searchSettings = value => { const input=document.querySelector('.settings-search input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true})); };searchSettings('kobrixa.cursorStyle');`,
  );
  await until('Boolean(document.querySelector("#setting-cursorStyle"))');
  await js('document.querySelector("#setting-cursorStyle").focus()');
  await key("Enter");
  await key("End");
  await key("Enter");
  assert.equal(await js("ed.getRawOptions().cursorStyle"), "underline");
  await js('searchSettings("kobrixa.autoSuggestions")');
  await until('Boolean(document.querySelector("#setting-autoSuggestions"))');
  await js('document.querySelector("#setting-autoSuggestions").focus()');
  await key("Enter");
  assert.equal(await js("ed.getRawOptions().suggestOnTriggerCharacters"), false);
  await js('document.querySelector(".settings-search input[type=checkbox]").click()');
  await until('Boolean(document.querySelector(".setting-footer button"))');
  await js('document.querySelector(".setting-footer button").focus()');
  await key("Enter");
  await until('document.querySelectorAll(".setting-entry").length===0');
  assert.equal(
    await js('document.activeElement.matches(".settings-search input[type=search]")'),
    true,
  );
  assert.equal(await js("ed.getRawOptions().suggestOnTriggerCharacters"), true);
  await js(
    'document.querySelector(".settings-search input[type=checkbox]").click();searchSettings("USB 重試 interval")',
  );
  await until('Boolean(document.querySelector("#setting-usbRetryInterval"))');
  await js('document.querySelector("#setting-usbRetryInterval").focus()');
  await key("Enter");
  await key("End");
  await key("Enter");
  await until('!document.querySelector("#setting-usbRetryInterval").disabled');
  assert.equal(
    await js("window.kobrixa.device.getPreferences().then(p=>p.usbRetryInterval)"),
    10000,
  );
  await js('searchSettings("autoSaveDelay")');
  await until('Boolean(document.querySelector("#setting-autoSaveDelay"))');
  assert.equal(await js('document.querySelector("#setting-autoSaveDelay").disabled'), true);
  await js('smoke.settingsStore.set("theme","system")');
  systemTheme("light");
  await until('document.documentElement.dataset.theme==="light"');
  systemTheme("dark");
  await until('document.documentElement.dataset.theme==="dark"');
  assert.equal(await js("smoke.settingsStore.getSnapshot().values.theme"), "system");
  await js(
    'smoke.settingsStore.set("smoothScrolling",true);smoke.settingsStore.set("motion","reduce")',
  );
  await until('ed.getRawOptions().cursorBlinking==="solid"');
  assert.equal(await js("ed.getRawOptions().smoothScrolling"), false);
  await js('searchSettings("");smoke.settingsStore.set("uiScale",125)');
  win.setSize(980, 650);
  for (const locale of ["en", "zh-TW"])
    for (const theme of ["dark", "light"]) {
      await js(
        `smoke.settingsStore.set("locale",${JSON.stringify(locale)});smoke.settingsStore.set("theme",${JSON.stringify(theme)})`,
      );
      await pause(120);
      assert.equal(
        await js(
          'document.querySelector(".settings-content").scrollWidth <= document.querySelector(".settings-content").clientWidth',
        ),
        true,
      );
      assert.equal(
        await js(
          'document.querySelector(".settings-heading").scrollWidth <= document.querySelector(".settings-heading").clientWidth',
        ),
        true,
      );
      await fs.writeFile(
        path.join(temporary, `expanded-settings-${locale}-${theme}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
      const contentHeight = await js('document.querySelector(".settings-content").clientHeight');
      assert.ok(
        contentHeight >= 140,
        `Settings content height ${contentHeight} for ${locale}/${theme}`,
      );
    }
  await js(
    'document.querySelector(".settings-tab .tab-close").click();ed.trigger("test","undo",null)',
  );
  assert.equal(
    await js("ed===window.settingsEditor && smoke.monaco.editor.getEditors().length===1"),
    true,
  );
  assert.equal(await js("ed.getValue()"), content);
  await js(
    `for(const [key,value] of Object.entries(${JSON.stringify(original)})) smoke.settingsStore.set(key,value);`,
  );
  await js('window.kobrixa.device.setPreferences({usbRetryInterval:"backoff"})');
  systemTheme("system");
  win.setSize(1420, 900);
  await js("ed.focus()");
  console.log(
    "expanded settings: bilingual search, reset focus, live editor options, device presets, system theme, reduced motion and minimum-size screenshots pass",
  );
}
