import { app, BrowserWindow, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { checkSharedComponents } from "./components-smoke.mjs";
const [url, temporary] = process.argv.slice(2);
const { attachKeyboard, setKeyboardContext } = await import(
  pathToFileURL(path.join(temporary, "keyboard.cjs")).href
);
const mod = process.platform === "darwin" ? "meta" : "control";
const storedMod = process.platform === "darwin" ? "Meta" : "Ctrl";
app.setPath("userData", path.join(temporary, "profile"));
const timeout = setTimeout(() => {
  console.error("Electron smoke test timed out");
  app.exit(1);
}, 90000);
app.on("will-quit", () => clearTimeout(timeout));
const files = {
  "main.bp": "If True Then\nLCD.Clear()\nEndIf\n",
  "second.bp": "LCD.Clear()\n",
  "kobrixa.json": '{"name":"test"}',
};
const drafts = {};
const writes = [];
const mutations = [];
let failNextWrite = false;
let openCount = 0;
let win;
const workspace = () => ({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Keyboard test",
  rootLabel: "Keyboard test",
  files: Object.keys(files),
  entries: Object.keys(files).map((path) => ({ path, kind: "file" })),
  implicit: true,
  entryCandidates: ["main.bp"],
  drafts: { ...drafts },
});
ipcMain.handle("smoke", async (_e, name, args) => {
  if (name === "keyboard") {
    setKeyboardContext(win.webContents, args[0]);
    return;
  }
  if (name === "open") {
    openCount++;
    return workspace();
  }
  if (name === "read") return files[args[1]];
  if (name === "createEntry") {
    assert.equal(args[2], "file");
    const file = args[1] ? `${args[1]}/${args[3]}` : args[3];
    assert.equal(files[file], undefined);
    files[file] = "";
    mutations.push(name);
    return { workspace: workspace(), removed: [], moved: {} };
  }
  if (name === "trashEntry") {
    delete files[args[1]];
    delete drafts[args[1]];
    mutations.push(name);
    return { workspace: workspace(), removed: [args[1]], moved: {} };
  }
  if (name === "write") {
    await new Promise((r) => setTimeout(r, 150));
    if (failNextWrite) {
      failNextWrite = false;
      throw new Error("Simulated source write failure");
    }
    files[args[1]] = args[2];
    delete drafts[args[1]];
    writes.push({ file: args[1], content: args[2] });
    return;
  }
  if (name === "draft") {
    if (args[2] === undefined) delete drafts[args[1]];
    else drafts[args[1]] = args[2];
    return;
  }
  throw new Error("Unexpected smoke API: " + name);
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (code) => win.webContents.executeJavaScript(code);
async function until(code) {
  for (let i = 0; i < 100; i++) {
    if (await js(code)) return;
    await pause(100);
  }
  throw Error("Timed out: " + code);
}
async function key(code, modifiers = []) {
  // Electron names arrow key codes Up/Down/Left/Right (DOM uses Arrow*).
  const keyCode = code.replace(/^Arrow/, "");
  // Native undo/redo requires foreground web-contents focus, even with synthetic input.
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
  win.webContents.focus();
  await pause(40);
  win.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
  if (code === "Enter") win.webContents.sendInputEvent({ type: "char", keyCode: "\r", modifiers });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
  await pause(80);
}
app
  .whenReady()
  .then(async () => {
    win = new BrowserWindow({
      width: 1420,
      height: 900,
      show: true,
      webPreferences: {
        preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.on("console-message", (_event, _level, message) => {
      if (/Error|error/i.test(message)) console.log("renderer:", message);
    });
    attachKeyboard(win.webContents);
    win.show();
    win.focus();
    await win.loadURL(url);
    await until("Boolean(window.smoke)");
    await js(
      'localStorage.clear(); smoke.settingsStore.set("locale","en"); smoke.keybindingsStore.reset()',
    );
    await key("o", [mod]);
    await until("smoke.monaco.editor.getEditors().length === 1");
    await js("window.ed=smoke.monaco.editor.getEditors()[0];ed.focus()");
    await pause(200);
    await checkSharedComponents({ js, key, until, pause, mod, mutations });
    console.log("catalog", await js("smoke.editorCommandCatalog(true).length"));
    await key(",", [mod]);
    await until('!document.querySelector("#settings-page").hidden');
    await key("k", [mod]);
    await key("s", [mod]);
    await until('document.querySelector(".shortcut-list") !== null');
    fs.writeFileSync(
      path.join(temporary, "shortcuts.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    console.log("settings and shortcut chord pass");
    // Shortcut filters use the same themed, keyboard-operable pickers as settings.
    assert.equal(await js('document.querySelector(".shortcuts-panel select")'), null);
    await js('document.querySelector("#shortcut-source-filter").focus()');
    await key("Enter");
    await key("ArrowDown");
    await key("Enter");
    assert.equal(await js("document.activeElement.id"), "shortcut-source-filter");
    assert.equal(
      await js(
        `Array.from(document.querySelectorAll('[data-command-id]')).every(row=>row.dataset.commandId.startsWith('kobrixa.'))`,
      ),
      true,
    );
    await key("Tab");
    assert.equal(await js("document.activeElement.id"), "shortcut-status-filter");
    await key("Enter");
    await key("ArrowDown");
    await key("Enter");
    await until('Boolean(document.querySelector(".shortcut-empty"))');
    await key("Enter");
    await key("End");
    await key("Enter");
    await js('document.querySelector("#shortcut-source-filter").focus()');
    await key("Enter");
    await key("End");
    await key("Enter");
    await until('document.querySelectorAll("[data-command-id]").length > 0');
    assert.equal(
      await js(
        `Array.from(document.querySelectorAll('[data-command-id]')).every(row=>!row.dataset.commandId.startsWith('kobrixa.') && row.querySelector('.shortcut-status.unassigned'))`,
      ),
      true,
    );
    await key("Enter");
    await key("Escape");
    assert.equal(await js("document.activeElement.id"), "shortcut-source-filter");
    await js(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Clear filters').click()`,
    );
    assert.equal(
      await js(
        'document.querySelector("#shortcut-source-filter").textContent.includes("All sources")',
      ),
      true,
    );
    console.log("shortcut source/status pickers, combined filters and keyboard focus pass");
    // Full-catalog localization and live language changes keep filters intact.
    await js(`window.searchShortcuts = (value) => {
      const input = document.querySelector('.shortcut-search-line input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input,value);
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }; searchShortcuts('儲存 save all')`);
    await until('document.querySelectorAll("[data-command-id]").length === 1');
    assert.equal(
      await js('document.querySelector("[data-command-id]").dataset.commandId'),
      "kobrixa.saveAll",
    );
    await js('smoke.settingsStore.set("locale","zh-TW")');
    await until('document.querySelector("[data-command-id] summary").textContent === "全部儲存"');
    assert.equal(
      await js('document.querySelector(".shortcut-search-line input").value'),
      "儲存 save all",
    );
    await js('searchShortcuts("")');
    await pause(100);
    assert.equal(
      await js(
        'Array.from(document.querySelectorAll("[data-command-id] summary")).every(node=>/[\\u3400-\\u9fff]/.test(node.textContent))',
      ),
      true,
    );
    assert.equal(
      await js(
        'Array.from(document.querySelectorAll("[data-command-id]")).every(row=>/[\\u3400-\\u9fff]/.test(row.querySelector(".shortcut-description")?.textContent ?? ""))',
      ),
      true,
    );
    // Search descriptions in either language without losing the query on locale changes.
    await js('searchShortcuts("磁碟")');
    await until('document.querySelectorAll("[data-command-id]").length === 2');
    assert.deepEqual(
      await js(
        'Array.from(document.querySelectorAll("[data-command-id]")).map(row=>row.dataset.commandId)',
      ),
      ["kobrixa.save", "kobrixa.saveAll"],
    );
    await js('smoke.settingsStore.set("locale","en")');
    await until(
      'document.querySelector(".shortcut-description").textContent.startsWith("Write the active file")',
    );
    assert.equal(await js('document.querySelector(".shortcut-search-line input").value'), "磁碟");
    await js('searchShortcuts("DISK 磁碟")');
    await until('document.querySelectorAll("[data-command-id]").length === 2');
    await js('smoke.settingsStore.set("locale","zh-TW");searchShortcuts("")');
    await until('document.querySelectorAll("[data-command-id]").length > 300');
    fs.writeFileSync(
      path.join(temporary, "shortcuts-zh-dark.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    win.setSize(980, 650);
    await js('smoke.settingsStore.set("theme","light");smoke.settingsStore.set("uiScale",125)');
    await pause(200);
    assert.equal(
      await js(
        'document.querySelector(".settings-content").scrollWidth <= document.querySelector(".settings-content").clientWidth',
      ),
      true,
    );
    fs.writeFileSync(
      path.join(temporary, "shortcuts-zh-light-small.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js('document.querySelector("#shortcut-source-filter").click()');
    await until('Boolean(document.querySelector(".picker-popup"))');
    await pause(150);
    assert.equal(
      await js(`(() => {
      const popup=document.querySelector('.picker-popup');
      const rect=popup.getBoundingClientRect();
      return rect.left>=0 && rect.right<=innerWidth && rect.top>=0 && rect.bottom<=innerHeight && popup.textContent.includes('全部來源');
    })()`),
      true,
    );
    fs.writeFileSync(
      path.join(temporary, "shortcut-filter-zh-light-small.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await key("Escape");
    win.setSize(1420, 900);
    await js(
      'smoke.settingsStore.set("theme","dark");smoke.settingsStore.set("uiScale",100);smoke.settingsStore.set("locale","en")',
    );
    await pause(100);
    console.log("full Chinese catalog, search, language switching and responsive themes pass");
    const startRecording = async () => {
      await js('document.querySelector("[data-record-start]").click()');
      await pause(100);
    };
    const editSave = async () => {
      await js(
        `document.querySelector('button[aria-label="Edit Save"]').focus();document.querySelector('button[aria-label="Edit Save"]').click()`,
      );
      await until('Boolean(document.querySelector(".shortcut-recorder"))');
      assert.match(
        await js('document.querySelector(".shortcut-recorder .shortcut-description").textContent'),
        /active file.*disk/,
      );
    };
    const resetCommand = async (id) => {
      await js(`document.querySelector('[data-command-id="${id}"] .more-button').click()`);
      await pause(100);
      await js(`document.querySelectorAll('[data-command-id="${id}"] [role=menuitem]')[1].click()`);
      await pause(100);
    };
    // Explicit single-stroke capture blocks commands and immediately identifies conflicts.
    await editSave();
    await startRecording();
    await key("o", [mod]);
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), true);
    assert.match(
      await js('document.querySelector(".shortcut-conflicts").textContent'),
      /Open project.*Same shortcut/s,
    );
    await js(
      `document.querySelector('button[aria-label="Edit conflicting shortcut Open project"]').click()`,
    );
    await until('document.querySelector("#shortcut-record-title").textContent === "Open project"');
    await key("Escape");
    await until('document.querySelector("#shortcut-record-title").textContent === "Save"');
    assert.match(
      await js('document.querySelector(".shortcut-record-output").textContent'),
      /Recording complete/,
    );
    await js(
      `document.querySelector('button[aria-label="Edit conflicting shortcut Open project"]').click()`,
    );
    await startRecording();
    await key("o", [mod, "alt", "shift"]);
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), false);
    await js('document.querySelector(".shortcut-recorder .primary").click()');
    await until('document.querySelector("#shortcut-record-title").textContent === "Save"');
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), false);
    await js('smoke.settingsStore.set("locale","zh-TW")');
    await until('document.querySelector("#shortcut-record-title").textContent === "儲存"');
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), false);
    await js(
      'smoke.settingsStore.set("locale","en");document.querySelector(".shortcut-recorder .primary").click()',
    );
    await pause(100);
    assert.deepEqual(await js('smoke.keybindingsStore.getSnapshot().overrides["kobrixa.save"]'), [
      [`${storedMod}+KeyO`],
    ]);
    await resetCommand("kobrixa.save");
    await resetCommand("kobrixa.openProject");
    assert.equal(
      await js('smoke.keybindingsStore.getSnapshot().overrides["kobrixa.save"]'),
      undefined,
    );
    assert.equal(openCount, 1);
    // Two-stroke capture cannot silently become a single binding on timeout.
    await editSave();
    await js('document.querySelectorAll(".shortcut-mode input")[1].click()');
    await startRecording();
    await key("k", [mod, "alt", "shift"]);
    await pause(2100);
    assert.match(
      await js('document.querySelector(".shortcut-record-output").textContent'),
      /timed out/,
    );
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), true);
    await startRecording();
    await key("k", [mod, "alt", "shift"]);
    await key("s", [mod, "alt", "shift"]);
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), false);
    // After recording, Tab and Enter operate normal dialog controls.
    await key("Tab");
    await key("Tab");
    assert.equal(await js('document.activeElement.classList.contains("primary")'), true);
    await key("Enter");
    await until('!document.querySelector(".shortcut-recorder")');
    assert.deepEqual(await js('smoke.keybindingsStore.getSnapshot().overrides["kobrixa.save"]'), [
      [`${storedMod}+Alt+Shift+KeyK`, `${storedMod}+Alt+Shift+KeyS`],
    ]);
    await editSave();
    assert.equal(await js('document.querySelectorAll(".shortcut-mode input")[1].checked'), true);
    await key("Escape");
    assert.equal(await js('document.activeElement.getAttribute("aria-label")'), "Edit Save");
    await resetCommand("kobrixa.save");
    // Search capture uses the same recorder without saving a binding or running commands.
    await js(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Search by shortcut').click()`,
    );
    await startRecording();
    await key("s", [mod]);
    await js('document.querySelector(".shortcut-recorder .primary").click()');
    await until('document.querySelectorAll("[data-command-id]").length === 2');
    assert.deepEqual(
      await js(
        'Array.from(document.querySelectorAll("[data-command-id]")).map(node=>node.dataset.commandId)',
      ),
      ["kobrixa.save", "kobrixa.shortcuts"],
    );
    assert.deepEqual(await js("smoke.keybindingsStore.getSnapshot().overrides"), {});
    assert.equal(writes.length, 0);
    await js(
      `Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Clear filters').click()`,
    );
    console.log(
      "shortcut recording, conflict round trips, timeout, keyboard navigation and key search pass",
    );
    // Restoring a default must also resolve conflicts explicitly.
    await js(
      `smoke.keybindingsStore.set("kobrixa.save",[]);smoke.keybindingsStore.set("kobrixa.openProject",[["${storedMod}+KeyS"]])`,
    );
    await pause(100);
    await resetCommand("kobrixa.save");
    await until('document.querySelector("#shortcut-record-title").textContent === "Reset: Save"');
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), true);
    await js(
      `document.querySelector('button[aria-label="Unbind conflicting shortcut Open project"]').click()`,
    );
    await pause(100);
    assert.equal(await js('document.querySelector(".shortcut-recorder .primary").disabled'), false);
    await js('document.querySelector(".shortcut-recorder .primary").click()');
    await pause(100);
    assert.equal(
      await js('smoke.keybindingsStore.getSnapshot().overrides["kobrixa.save"]'),
      undefined,
    );
    assert.deepEqual(
      await js('smoke.keybindingsStore.getSnapshot().overrides["kobrixa.openProject"]'),
      [],
    );
    await resetCommand("kobrixa.openProject");
    console.log("reset conflict resolution and explicit unbinding pass");

    await js('document.querySelector("[data-command-id] summary").focus()');
    await key("w", [mod]);
    await until('document.querySelector("#settings-page").hidden');
    await js("ed.focus()");
    await js(`smoke.keybindingsStore.set("actions.find",[["${storedMod}+Alt+KeyF"]])`);
    await pause(100);
    await key("f", [mod]);
    assert.equal(await js('Boolean(document.querySelector(".find-widget.visible"))'), false);
    await key("f", [mod, "alt"]);
    await until('Boolean(document.querySelector(".find-widget.visible"))');
    await key("Escape");
    await js('ed.getContribution("editor.contrib.findController").closeFindWidget();ed.focus()');
    await pause(120);
    await js(
      `ed.focus(); ed.setValue("original"); ed.setPosition({lineNumber:1,column:9}); ed.trigger("test","type",{text:" changed"}); smoke.keybindingsStore.set("undo",[["${storedMod}+Alt+KeyZ"]])`,
    );
    await pause(100);
    await js("ed.focus()");
    await pause(100);
    await key("z", [mod, "alt"]);
    assert.equal(await js("ed.getValue()"), "original");
    await key("z", [mod, "shift"]);
    assert.equal(await js("ed.getValue()"), "original changed");
    await js(
      `ed.getDomNode().querySelector("textarea").dispatchEvent(new KeyboardEvent("keydown",{key:"z",code:"KeyZ",keyCode:90,bubbles:true,cancelable:true,isComposing:true,${storedMod === "Meta" ? "metaKey" : "ctrlKey"}:true,altKey:true}))`,
    );
    assert.equal(await js("ed.getValue()"), "original changed");
    console.log("real Monaco remapping, undo and redo pass");
    await js(
      `ed.setValue("first line\\nsecond line");ed.setPosition({lineNumber:1,column:1});smoke.keybindingsStore.set("editor.action.insertCursorBelow",[["${storedMod}+Alt+Shift+KeyI"]]);smoke.keybindingsStore.set("editor.action.commentLine",[["${storedMod}+Alt+Shift+KeyL"]]);ed.focus()`,
    );
    await pause(100);
    await key("i", [mod, "alt", "shift"]);
    assert.equal(await js("ed.getSelections().length"), 2);
    await js("ed.setPosition({lineNumber:1,column:1});ed.updateOptions({readOnly:true})");
    await key("l", [mod, "alt", "shift"]);
    assert.equal(await js("ed.getValue()"), "first line\nsecond line");
    await js("ed.updateOptions({readOnly:false})");
    await key("l", [mod, "alt", "shift"]);
    assert.notEqual(await js("ed.getValue()"), "first line\nsecond line");
    console.log("real Monaco multi-cursor and read-only command contexts pass");
    await js(
      'smoke.settingsStore.set("lineNumbers","relative"); smoke.settingsStore.set("minimap",true);smoke.settingsStore.set("renderWhitespace","all");smoke.settingsStore.set("formatOnPaste",false)',
    );
    await pause(100);
    assert.equal(await js("ed.getRawOptions().lineNumbers"), "relative");
    assert.equal(await js("ed.getRawOptions().minimap.enabled"), true);
    await js(
      'smoke.settingsStore.set("formatOnSave",true);smoke.settingsStore.set("autoSave","afterDelay");smoke.settingsStore.set("autoSaveDelay",500);ed.setValue("If True Then\\nLCD.Update()\\nEndIf\\n")',
    );
    await pause(850);
    assert.equal(files["main.bp"], "If True Then\nLCD.Update()\nEndIf\n");
    await js('smoke.settingsStore.set("formatOnSave",true);ed.focus()');
    await key("s", [mod]);
    await pause(500);
    assert.equal(files["main.bp"], "If True Then\n  LCD.Update()\nEndIf\n");
    await js('ed.trigger("test","undo",null)');
    assert.equal(await js("ed.getValue()"), "If True Then\nLCD.Update()\nEndIf\n");
    console.log("settings, auto save, format on manual save and undo pass");
    // Let a write begin, then type again before its IPC promise resolves.
    await js('smoke.settingsStore.set("formatOnSave",false);ed.setValue("first snapshot")');
    await pause(580);
    await js('ed.setValue("second snapshot")');
    await pause(1000);
    assert.equal(files["main.bp"], "second snapshot");
    assert.equal(await js('Boolean(document.querySelector(".tab.active i[aria-label]"))'), false);
    // Automatic focus saves cover tab changes and settings without formatting.
    await js(
      `smoke.settingsStore.set("autoSave","onFocusChange");ed.setValue("focus snapshot");document.querySelector('[data-tree-path="second.bp"]').click()`,
    );
    await until('ed.getModel().uri.path === "/second.bp"');
    await pause(500);
    assert.equal(files["main.bp"], "focus snapshot");
    // JSON uses the shipped Monaco formatter, not JSON.parse/stringify.
    await js(
      `smoke.settingsStore.set("autoSave","off");smoke.settingsStore.set("formatOnSave",true);document.querySelector('[data-tree-path="kobrixa.json"]').click()`,
    );
    await until('ed.getModel().uri.path === "/kobrixa.json"');
    await js(`ed.setValue('{"name":"changed","array":[1,2]}');ed.focus()`);
    await key("s", [mod]);
    await pause(800);
    assert.match(files["kobrixa.json"], /\n/);
    assert.equal(JSON.parse(files["kobrixa.json"]).name, "changed");
    console.log("concurrent input, focus auto save and JSON format pass");
    failNextWrite = true;
    await js(
      'smoke.settingsStore.set("formatOnSave",false);ed.setValue("failed save draft");ed.focus()',
    );
    await key("s", [mod]);
    await js('ed.setValue("new input during failed save")');
    await pause(350);
    assert.equal(drafts["kobrixa.json"], "new input during failed save");
    assert.equal(await js('Boolean(document.querySelector(".tab.active i[aria-label]"))'), true);
    assert.equal(JSON.parse(files["kobrixa.json"]).name, "changed");
    console.log("failed save retains latest dirty buffer and recovery draft pass");
    console.log("PASS", JSON.stringify({ writes: writes.length, drafts }));
    app.exit(0);
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
