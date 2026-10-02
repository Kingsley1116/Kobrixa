import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function checkProjects({
  js,
  key,
  until,
  pause,
  win,
  mod,
  temporary,
  fixtures,
  choose,
  session,
  failWrite,
  setFailDraft,
  closeReply,
  resetCloseReply,
  completeBuild,
  update,
  installed,
}) {
  const id = (n) => `00000000-0000-4000-8000-00000000000${n}`;
  const editor = async () => {
    await until("smoke.monaco.editor.getEditors().length === 1");
    await js("window.ed=smoke.monaco.editor.getEditors()[0];ed.focus()");
  };
  const switchTo = async (name) => {
    await js(
      `Array.from(document.querySelectorAll('.project-tab-select')).find(b=>b.textContent.includes(${JSON.stringify(name)})).click()`,
    );
    await until(
      `document.querySelector('.project-tab.active').textContent.includes(${JSON.stringify(name)})`,
    );
    await editor();
  };
  const open = async (number) => {
    choose(id(number));
    await key("o", [mod]);
    await until(
      `document.querySelector('.project-tab.active').textContent.includes('Project ${number}')`,
    );
    await editor();
  };
  await js(
    "smoke.settingsStore.set('locale','en');smoke.settingsStore.set('autoSave','off');smoke.settingsStore.set('formatOnSave',false);smoke.keybindingsStore.reset();smoke.settingsStore.set('filesOpen',true)",
  );
  await switchTo("Keyboard test");
  await js("document.querySelector('[data-tree-path=\"main.bp\"]').click()");
  await editor();
  // Undo must survive A -> B -> C -> A, including the same relative filenames.
  const longSource = Array.from({ length: 100 }, (_, n) => `value = ${n}`).join("\n");
  await js(
    `ed.setValue(${JSON.stringify(longSource)});ed.setPosition({lineNumber:90,column:1});ed.revealLineInCenter(90);ed.pushUndoStop();ed.executeEdits('project-test',[{range:new smoke.monaco.Range(90,1,90,1),text:"' A "}]);ed.pushUndoStop()`,
  );
  const aText = await js("ed.getValue()");
  const aPosition = await js("ed.getPosition()");
  await pause(100);
  const aScroll = await js("ed.getScrollTop()");
  await open(2);
  await js("ed.setValue('value = 222\\n');ed.setPosition({lineNumber:1,column:5})");
  await open(3);
  assert.equal(await js("ed.getValue()"), "value = 3\n");
  await switchTo("Keyboard test");
  assert.equal(await js("ed.getValue()"), aText);
  assert.deepEqual(await js("ed.getPosition()"), aPosition);
  assert.ok(Math.abs((await js("ed.getScrollTop()")) - aScroll) < 2);
  await js("ed.trigger('keyboard','undo',null)");
  assert.equal(await js("ed.getValue()"), longSource);
  await js("ed.trigger('keyboard','redo',null)");
  assert.equal(await js("ed.getValue()"), aText);
  await switchTo("Project 2");
  assert.equal(await js("ed.getValue()"), "value = 222\n");
  await open(2);
  assert.equal(await js("document.querySelectorAll('.project-tab').length"), 3);

  // Arrow navigation retains focus on the project tab for repeated keyboard switching.
  await js("document.querySelector('.project-tab.active [role=tab]').focus()");
  await key("ArrowRight");
  await until("document.querySelector('.project-tab.active').textContent.includes('Project 3')");
  assert.equal(await js("document.activeElement.getAttribute('role')"), "tab");
  await key("ArrowLeft");
  await until("document.querySelector('.project-tab.active').textContent.includes('Project 2')");
  await editor();

  // In-flight source writes commit to B even after selecting C.
  await js("ed.setValue('value = 223\\n');ed.focus()");
  await key("s", [mod]);
  await switchTo("Project 3");
  await pause(300);
  assert.equal(fixtures.get(id(2)).files["main.bp"], "value = 223\n");
  assert.equal(await js("ed.getValue()"), "value = 3\n");
  // Delayed automatic saving continues for inactive projects.
  await js(
    "smoke.settingsStore.set('autoSave','afterDelay');smoke.settingsStore.set('autoSaveDelay',500);ed.setValue('value = 333\\n')",
  );
  await switchTo("Project 2");
  await pause(900);
  assert.equal(fixtures.get(id(3)).files["main.bp"], "value = 333\n");
  await js("smoke.settingsStore.set('autoSave','onFocusChange');ed.setValue('value = 224\\n')");
  await switchTo("Project 3");
  await pause(300);
  assert.equal(fixtures.get(id(2)).files["main.bp"], "value = 224\n");
  await switchTo("Project 2");
  await js("smoke.settingsStore.set('autoSave','off')");

  // Background compiler owns its lock and result while C remains editable.
  await key("b", [mod, "shift"]);
  await until("Boolean(document.querySelector('.project-phase'))");
  await switchTo("Project 3");
  assert.equal(await js("ed.getRawOptions().readOnly"), false);
  await js("ed.trigger('keyboard','type',{text:\"' editable \"})");
  assert.equal(await js("Boolean(document.querySelector('.project-operation'))"), true);
  completeBuild();
  await until("!document.querySelector('.project-phase')");
  assert.equal(
    await js("document.querySelector('.project-tab.active').textContent.includes('Project 3')"),
    true,
  );

  // Failed close-save retains the project and dirty buffer; cancel and discard are distinct.
  await js("document.querySelector('[aria-label=\"Close project: Project 3\"]').click()");
  await until("Boolean(document.querySelector('#close-project-title'))");
  failWrite();
  await js("document.querySelector('.modal-card .primary').click()");
  await until("document.querySelector('.operation-status').textContent.includes('Saving failed')");
  assert.equal(await js("document.querySelectorAll('.project-tab').length"), 3);
  await js(
    "Array.from(document.querySelectorAll('.modal-card button')).find(b=>b.textContent==='Cancel').click()",
  );
  await until("!document.querySelector('.modal-card')");

  // A normal close request must flush the newest edit, including within the draft debounce.
  await js("ed.setValue('value = 334\\n')");
  const requestId = "00000000-0000-4000-8000-000000000099";
  setFailDraft(true);
  resetCloseReply();
  win.webContents.send("workspace:before-close", requestId);
  for (let n = 0; n < 100 && !closeReply(); n++) await pause(30);
  assert.deepEqual(closeReply(), [requestId, false]);
  setFailDraft(false);
  resetCloseReply();
  win.webContents.send("workspace:before-close", requestId);
  for (let n = 0; n < 100 && !closeReply(); n++) await pause(30);
  assert.deepEqual(closeReply(), [requestId, true]);
  assert.equal(fixtures.get(id(3)).drafts["main.bp"], "value = 334\n");
  assert.equal(session().projects.length, 3);
  assert.equal(session().activeWorkspaceId, id(3));
  await win.reload();
  await until("Boolean(window.smoke && document.querySelector('.project-tab.active'))");
  await editor();
  assert.equal(await js("ed.getValue()"), "value = 334\n");
  assert.equal(await js("document.querySelectorAll('.project-tab').length"), 3);
  await switchTo("Keyboard test");
  assert.equal(await js("ed.getValue()"), aText);
  assert.deepEqual(await js("ed.getPosition()"), aPosition);
  await fs.writeFile(
    path.join(temporary, "projects-restored.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await switchTo("Project 2");
  await js("ed.setValue('value = 444')");
  await switchTo("Project 3");
  await js("ed.setValue('value = 445')");
  const installs = installed();
  update({ phase: "ready", version: "1.2.0" });
  await until("Boolean(document.querySelector('.update-notice'))");
  await js("document.querySelector('.update-notice button').click()");
  await until("Boolean(document.querySelector('.modal-card'))");
  await js("document.querySelector('.modal-actions button:last-child').click()");
  for (let n = 0; n < 100 && installed() === installs; n++) await pause(30);
  assert.equal(installed(), installs + 1);
  assert.equal(fixtures.get(id(2)).files["main.bp"], "value = 444");
  assert.equal(fixtures.get(id(3)).files["main.bp"], "value = 445");
  await until("!document.querySelector('.editor-lock')");
  await js("ed.setValue('value = 446')");

  await switchTo("Project 3");
  await js("document.querySelector('[aria-label=\"Close project: Project 3\"]').click()");
  await until("Boolean(document.querySelector('#close-project-title'))");
  await js("document.querySelector('.modal-card .danger').click()");
  await until("document.querySelectorAll('.project-tab').length === 2");
  assert.equal(fixtures.get(id(3)).drafts["main.bp"], undefined);
  assert.equal(
    await js("document.querySelector('.project-tab.active').textContent.includes('Project 2')"),
    true,
  );
  await editor();
  await js(
    "ed.pushUndoStop(); ed.executeEdits('test', [{ range: ed.getModel().getFullModelRange(), text: 'temporary change' }]); ed.pushUndoStop(); ed.trigger('test', 'undo', null)",
  );
  await until("!document.querySelector('.project-tab.active .dirty')");
  await js("document.querySelector('[aria-label=\"Close project: Project 2\"]').click()");
  await until("document.querySelectorAll('.project-tab').length === 1");
  await pause(500);
  assert.equal(fixtures.get(id(2)).drafts["main.bp"], undefined);
  assert.equal(await js("document.body.textContent.includes('Unknown workspace')"), false);
  await editor();
  await js("ed.setValue('value = 999')");
  await js("document.querySelector('[aria-label=\"Close project: Keyboard test\"]').click()");
  await until("Boolean(document.querySelector('#close-project-title'))");
  await js("document.querySelector('.modal-card .danger').click()");
  await until("!document.querySelector('.project-tab') && !document.querySelector('.workspace')");
  assert.equal(session().projects.length, 0);
  console.log(
    "PASS multi-project switching, undo, save ownership, background build, close and restore",
  );
}
