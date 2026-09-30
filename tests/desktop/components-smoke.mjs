import assert from "node:assert/strict";

export async function checkSharedComponents({ js, key, until, pause, mod, mutations }) {
  // Exercise the same menu navigation through both trigger and context menus.
  await js('document.querySelector(".topbar .more-button").click()');
  await until('document.activeElement?.getAttribute("role") === "menuitem"');
  await key("End");
  assert.equal(await js("document.activeElement.textContent.trim()"), "Build");
  await key("ArrowDown");
  assert.equal(await js("document.activeElement.textContent.trim()"), "Save all");
  await key("ArrowUp");
  assert.equal(await js("document.activeElement.textContent.trim()"), "Build");
  await key("Home");
  await key("Escape");
  assert.equal(await js('document.activeElement.matches(".topbar .more-button")'), true);

  await js(`document.querySelector('[data-tree-path=""]').closest('[role=treeitem]').focus()`);
  await key("F10", ["shift"]);
  await until('Boolean(document.querySelector(".tree-context-menu"))');
  await key("End");
  assert.equal(await js("document.activeElement.textContent.trim()"), "New folder");
  await key("Home");
  assert.equal(await js("document.activeElement.textContent.trim()"), "New file");
  await key("Escape");
  assert.equal(
    await js("document.activeElement.querySelector('[data-tree-path]').dataset.treePath"),
    "",
  );

  // Form dialogs retain initial focus, trap Tab, submit once and return to the editor.
  await js(`document.querySelector('button[aria-label="New file"]').click()`);
  await until('Boolean(document.querySelector("#create-entry-title"))');
  assert.equal(await js('document.activeElement.matches(".modal-card input")'), true);
  await js(`const input = document.querySelector('.modal-card input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'component-smoke.bp');
    input.dispatchEvent(new Event('input',{bubbles:true}));`);
  await pause(80);
  await key("Tab", ["shift"]);
  assert.equal(await js('document.activeElement.matches(".modal-actions .primary")'), true);
  await key("Tab");
  assert.equal(await js('document.activeElement.matches(".modal-card input")'), true);
  await key("Enter");
  await until(
    '!document.querySelector(".modal-card") && ed.getModel().uri.path === "/component-smoke.bp"',
  );
  assert.deepEqual(mutations, ["createEntry"]);
  await js("ed.setValue('unsaved component test')");
  await until('Boolean(document.querySelector(".tab.active i[aria-label]"))');
  await js(
    "const close=document.querySelector('.tab.active .tab-close');close.focus();close.click()",
  );
  await until('Boolean(document.querySelector("#close-tab-title"))');
  assert.equal(
    await js('document.querySelector(".modal-card").getAttribute("role")'),
    "alertdialog",
  );
  assert.equal(await js('document.activeElement.matches(".modal-actions .primary")'), true);
  assert.equal(
    await js('document.querySelector(".modal-card").getAttribute("aria-describedby")'),
    "close-tab-description",
  );
  await key("Escape");
  assert.equal(await js('document.activeElement.matches(".tab.active .tab-close")'), true);
  await key("Enter");
  await until('Boolean(document.querySelector("#close-tab-title"))');
  await js('document.querySelector(".modal-actions .danger").click()');
  await until('!document.querySelector(".modal-card") && ed.getModel().uri.path === "/main.bp"');
  await js(
    `document.querySelector('[data-tree-path="component-smoke.bp"]').closest('[role=treeitem]').focus()`,
  );
  await key("Delete");
  await until('Boolean(document.querySelector("#trash-entry-title"))');
  assert.equal(
    await js('document.activeElement.matches(".modal-actions button:first-child")'),
    true,
  );
  await js('document.querySelector(".modal-actions .danger").click()');
  await until(
    `!document.querySelector('[data-tree-path="component-smoke.bp"]') && !document.querySelector('.modal-card')`,
  );
  assert.deepEqual(mutations, ["createEntry", "trashEntry"]);

  // All three separators share keyboard, pointer, bounds and interruption handling.
  await js(
    'smoke.settingsStore.set("deviceOpen",true);smoke.settingsStore.set("problemsOpen",true)',
  );
  await pause(100);
  for (const [name, increase, axis, sign, defaultValue] of [
    ["files", "ArrowRight", "clientX", 1, 220],
    ["device", "ArrowLeft", "clientX", -1, 360],
    ["problems", "ArrowUp", "clientY", -1, 180],
  ]) {
    const selector = `.resize-${name}`;
    const value = () =>
      js(`Number(document.querySelector('${selector}').getAttribute('aria-valuenow'))`);
    const before = await value();
    await js(`document.querySelector('${selector}').focus()`);
    await key(increase);
    assert.equal(await value(), before + 16);
    await js(`document.querySelector('${selector}').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:7,${axis}:100}));
      window.dispatchEvent(new PointerEvent('pointermove',{pointerId:7,${axis}:${100 + sign * 3000}}));`);
    await pause(80);
    assert.equal(
      await value(),
      await js(`Number(document.querySelector('${selector}').getAttribute('aria-valuemax'))`),
    );
    await js(`window.dispatchEvent(new PointerEvent('pointerup',{pointerId:7}));
      document.querySelector('${selector}').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));`);
    await pause(80);
    assert.equal(await value(), defaultValue);
  }
  for (const interruption of ["blur", "hide", "pointercancel"]) {
    await js(
      `document.querySelector('.resize-files').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,pointerId:7,clientX:100}));`,
    );
    assert.equal(await js('document.body.classList.contains("is-resizing-horizontal")'), true);
    await js(
      interruption === "hide"
        ? 'smoke.settingsStore.set("filesOpen",false)'
        : interruption === "blur"
          ? 'window.dispatchEvent(new Event("blur"))'
          : 'window.dispatchEvent(new PointerEvent("pointercancel",{pointerId:7}))',
    );
    await pause(80);
    await js('window.dispatchEvent(new PointerEvent("pointermove",{pointerId:7,clientX:190}))');
    assert.equal(await js('document.body.classList.contains("is-resizing-horizontal")'), false);
    assert.equal(
      await js('Number(document.querySelector(".resize-files").getAttribute("aria-valuenow"))'),
      220,
    );
    await js('smoke.settingsStore.set("filesOpen",true)');
    await pause(80);
  }
  await js(
    'smoke.settingsStore.set("deviceOpen",false);smoke.settingsStore.set("problemsOpen",false);ed.focus()',
  );

  // Labels and hints remain connected, and the extracted controls work by keyboard.
  await key(",", [mod]);
  await until('!document.querySelector("#settings-page").hidden');
  assert.equal(
    await js('document.querySelector("label[for=setting-motion]").control.id'),
    "setting-motion",
  );
  assert.equal(
    await js('document.querySelector("#setting-motion").getAttribute("aria-describedby")'),
    "motion-hint",
  );
  await js('document.querySelector("#setting-motion").focus()');
  await key("Enter");
  await key("End");
  await key("Enter");
  assert.equal(await js("smoke.settingsStore.getSnapshot().values.motion"), "reduce");
  await js(
    `Array.from(document.querySelectorAll('.settings-categories button')).find(b=>b.textContent==='Editor').click()`,
  );
  await js('document.querySelector("#setting-wordWrap").focus()');
  const wrap = await js("smoke.settingsStore.getSnapshot().values.wordWrap");
  await key("Enter");
  assert.equal(await js("smoke.settingsStore.getSnapshot().values.wordWrap"), !wrap);
  await key("Enter");
  await js(
    'document.querySelector(".settings-tab .tab-close").click();smoke.settingsStore.set("motion","system");ed.focus()',
  );
  await until('document.querySelector("#settings-page").hidden');
  assert.equal(await js('document.querySelector(".tab.active .tab-select").title'), "main.bp");
  console.log("shared dialogs, tabs, settings controls, menu navigation and panel resizing pass");
}
