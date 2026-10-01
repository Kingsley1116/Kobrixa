import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function checkLanguageFeatures({
  js,
  key,
  until,
  pause,
  mod,
  files,
  drafts,
  writes,
  win,
  temporary,
}) {
  const library =
    "Function Double(in number input)\nlocalValue = input * 2\nReturn localValue\nEndFunction\n";
  const source =
    'Import "second.bp"\nshared = 2\nanswer = second.Double(shared)\nanswer = Double(answer)\n\' Double in a comment\ncaption = "Double 中文😀"\n';
  await js(
    'smoke.settingsStore.set("autoSave","off");smoke.settingsStore.set("formatOnSave",false);smoke.keybindingsStore.reset();document.querySelector(\'[data-tree-path="second.bp"]\').click()',
  );
  await until('ed.getModel().uri.path === "/second.bp"');
  await js(`ed.setValue(${JSON.stringify(library)});ed.focus()`);
  await key("s", [mod]);
  await until('!document.querySelector(".tab.active i[aria-label]")');
  await key("w", [mod]);
  await js("document.querySelector('[data-tree-path=\"main.bp\"]').click()");
  await until('ed.getModel().uri.path === "/main.bp"');
  await js(
    `ed.setValue(${JSON.stringify(source)});ed.setPosition({lineNumber:3,column:20});ed.focus();window.languageCommand=(command,line,column,...args)=>ed._commandService.executeCommand(command,ed.getModel().uri,new smoke.monaco.Position(line,column),...args);void 0`,
  );

  const hover = await js('languageCommand("_executeHoverProvider",3,20)');
  assert(
    hover.some((item) =>
      item.contents.some((content) => content.value.includes("Double(in number input): number")),
    ),
  );
  const references = await js('languageCommand("_executeReferenceProvider",3,20)');
  assert.equal(references.length, 3);
  const signature = await js('languageCommand("_executeSignatureHelpProvider",3,29)');
  assert.equal(signature.signatures[0].label, "second.Double(in number input): number");
  const completions = await js('languageCommand("_executeCompletionItemProvider",3,19)');
  assert(completions.suggestions.some((item) => item.label === "second.double"));
  await js('ed.getAction("editor.action.showHover").run()');
  await until(
    'Array.from(document.querySelectorAll(".monaco-hover")).some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes("Double(in number input)"))',
  );
  await pause(100);
  fs.writeFileSync(
    path.join(temporary, "language-hover.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await key("Escape");

  await js("ed.focus()");
  await key("F12", ["shift"]);
  await until(
    'Array.from(document.querySelectorAll(".reference-zone-widget")).some(el => el.getBoundingClientRect().height > 0 && el.textContent.includes("Double"))',
  );
  await key("Escape");
  await js("ed.setPosition({lineNumber:3,column:20});ed.focus()");

  // Real F12 opens a previously closed dependency at its declaration.
  await key("F12");
  await until('ed.getModel().uri.path === "/second.bp"');
  assert.equal(await js("ed.getPosition().lineNumber"), 1);
  assert.equal(await js("ed.getValue()"), library);
  await until(
    'languageCommand("_executeCompletionItemProvider",3,10).then(result=>result.suggestions.some(item=>item.label === "localValue"))',
  );
  const local = await js('languageCommand("_executeCompletionItemProvider",3,10)');
  assert(
    local.suggestions.some(
      (item) => item.label === "localValue" && item.detail.includes("local number"),
    ),
  );
  await key("w", [mod]);
  await js("document.querySelector('[data-tree-path=\"main.bp\"]').click()");
  await until('ed.getModel().uri.path === "/main.bp"');
  await js("ed.setPosition({lineNumber:3,column:20});ed.focus()");

  // Resolving rename edits must not write or modify models; only accepting F2 does.
  const beforeWrites = writes.length;
  const plan = await js('languageCommand("_executeDocumentRenameProvider",3,20,"Twice")');
  assert.equal(plan.edits.length, 3);
  assert.equal(await js("ed.getValue()"), source);
  assert.equal(files["second.bp"], library);
  await key("F2");
  await until('document.activeElement?.matches(".rename-box input")');
  await js(
    'document.activeElement.value="Twice";document.activeElement.dispatchEvent(new Event("input",{bubbles:true}))',
  );
  await key("Enter");
  await until('ed.getValue().includes("second.Twice(shared)")');
  assert.equal(
    await js("ed.getValue()"),
    source.replace("second.Double", "second.Twice").replace("= Double(", "= Twice("),
  );
  assert.equal(files["second.bp"], library);
  assert.equal(writes.length, beforeWrites);
  await pause(350);
  assert.equal(drafts["second.bp"], library.replace("Function Double", "Function Twice"));
  await js("document.querySelector('[data-tree-path=\"second.bp\"]').click()");
  await until('ed.getModel().uri.path === "/second.bp"');
  await js('languageCommand("_executeHoverProvider",1,12)');
  await pause(100);
  fs.writeFileSync(
    path.join(temporary, "language-rename.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  assert.equal(await js('Boolean(document.querySelector(".tab.active i[aria-label]"))'), true);
  assert.equal(await js("ed.getValue()"), library.replace("Function Double", "Function Twice"));
  await js('ed.trigger("language-smoke","undo",null)');
  assert.equal(await js("ed.getValue()"), library);
  await js("document.querySelector('[data-tree-path=\"main.bp\"]').click()");
  await until('ed.getModel().uri.path === "/main.bp"');
  await js('ed.trigger("language-smoke","undo",null)');
  assert.equal(await js("ed.getValue()"), source);
  await pause(500);
  assert.equal(drafts["second.bp"], undefined);
  assert.equal(drafts["main.bp"], source);
  console.log(
    "real Monaco definitions, hover, signature help, scoped completion, references, cross-file rename and per-file undo pass",
  );
}
