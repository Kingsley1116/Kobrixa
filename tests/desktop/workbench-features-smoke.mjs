import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const tabFiles = `Array.from(document.querySelectorAll(".tabs .tab .tab-name")).map(t=>t.textContent)`;
const tabFor = (file) =>
  `Array.from(document.querySelectorAll(".tabs .tab")).find(t=>t.querySelector(".tab-name")?.textContent===${JSON.stringify(file)})`;

/** Pinned tabs, the tab menu, the split editor and the outline breadcrumb in the real workbench. */
export async function checkWorkbenchFeatures({ js, key, until, pause, mod, win, temporary }) {
  const original = await js("smoke.settingsStore.getSnapshot().values.autoSave");
  await js('smoke.settingsStore.set("autoSave","off")');
  const openMenu = async (file) => {
    await js(`(() => { const tab = ${tabFor(file)}; const box = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: box.left + 10, clientY: box.bottom })); })()`);
    await until('document.activeElement?.getAttribute("role") === "menuitem"');
  };
  const choose = (label) =>
    js(
      `Array.from(document.querySelectorAll(".tree-context-menu [role=menuitem]")).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`,
    );

  for (const file of ["main.bp", "second.bp"]) {
    await js(`document.querySelector('[data-tree-path="${file}"]').click()`);
    await until(`ed.getModel()?.uri.path === "/${file}"`);
  }
  const before = await js(tabFiles);
  assert.ok(before.indexOf("second.bp") > before.indexOf("main.bp"));

  // Pinning moves the tab ahead of the others, swaps × for a pin and survives Cmd/Ctrl+W.
  await openMenu("second.bp");
  await choose("Pin tab");
  await until(`${tabFor("second.bp")}.classList.contains("pinned")`);
  assert.equal((await js(tabFiles))[0], "second.bp");
  await js(`${tabFor("second.bp")}.querySelector(".tab-select").click()`);
  await until('ed.getModel()?.uri.path === "/second.bp"');
  await js("ed.focus()");
  await key("w", [mod]);
  await pause(150);
  assert.ok((await js(tabFiles)).includes("second.bp"), "Cmd/Ctrl+W closed a pinned tab");
  await openMenu("second.bp");
  assert.equal(
    await js(
      `Array.from(document.querySelectorAll(".tree-context-menu [role=menuitem]")).find(b=>b.textContent.trim()==="Close").disabled`,
    ),
    true,
  );
  await key("Escape");
  await until('!document.querySelector(".tree-context-menu")');

  // The split pane shows the main editor's model: edits on either side are one buffer.
  await openMenu("main.bp");
  await choose("Open to the side");
  await until('Boolean(document.querySelector(".split-editor .monaco-editor"))');
  assert.equal(await js('document.querySelector(".split-editor select").value'), "main.bp");
  const editors = "smoke.monaco.editor.getEditors()";
  await until(`${editors}.length === 2`);
  assert.equal(await js(`${editors}[0].getModel() === ${editors}[1].getModel()`), false);
  await js(`${tabFor("main.bp")}.querySelector(".tab-select").click()`);
  await until('ed.getModel()?.uri.path === "/main.bp"');
  assert.equal(await js(`${editors}[0].getModel() === ${editors}[1].getModel()`), true);
  const source = await js("ed.getValue()");
  const outlined = "number speed\nspeed = 40\nSub Drive\n  turns = 2\n  LCD.Clear()\nEndSub\n";
  await js(`${editors}[1].getModel().setValue(${JSON.stringify(outlined)})`);
  assert.equal(await js("ed.getValue()"), outlined);
  assert.equal(await js(`${tabFor("main.bp")}.querySelector("i") !== null`), true);

  // The toolbar breadcrumb follows the cursor into the Sub and lists the file's symbols.
  await js("ed.setPosition({ lineNumber: 5, column: 3 }); ed.focus()");
  await until(
    'Array.from(document.querySelectorAll(".breadcrumbs button")).some(b=>b.textContent==="Drive")',
  );
  await js('document.querySelector(".breadcrumb-symbols").click()');
  await until("document.querySelectorAll('.breadcrumb-menu [role=menuitem]').length === 3");
  assert.deepEqual(
    await js(
      "Array.from(document.querySelectorAll('.breadcrumb-menu [role=menuitem] span')).map(s=>s.textContent)",
    ),
    ["speed", "Drive", "turns"],
  );
  await fs.writeFile(
    path.join(temporary, "workbench-features.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js(
    "Array.from(document.querySelectorAll('.breadcrumb-menu [role=menuitem]')).find(b=>b.textContent.startsWith('speed')).click()",
  );
  await until("ed.getPosition().lineNumber === 1");
  await until(
    '!Array.from(document.querySelectorAll(".breadcrumbs button")).some(b=>b.textContent==="Drive")',
  );

  // Restore the buffer, close the split and unpin, leaving the workbench as found.
  await js(`ed.setValue(${JSON.stringify(source)})`);
  await until(`!${tabFor("main.bp")}.querySelector("i")`);
  await js('document.querySelector(".split-editor header button").click()');
  await until(`${editors}.length === 1`);
  await js(`${tabFor("second.bp")}.querySelector(".tab-close").click()`);
  await until(`!${tabFor("second.bp")}.classList.contains("pinned")`);
  await openMenu("second.bp");
  await choose("Close");
  await until(`!${tabFiles}.includes("second.bp")`);
  await js(`smoke.settingsStore.set("autoSave", ${JSON.stringify(original)})`);
  console.log("PASS pinned tabs, tab menu, shared-buffer split editor and outline breadcrumb");
}
