import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
export async function checkUpdates({
  js,
  key,
  until,
  pause,
  win,
  temporary,
  update,
  setBusy,
  failWrite,
  installed,
  files,
}) {
  await js(
    'smoke.settingsStore.set("locale","en");smoke.settingsStore.set("autoSave","off");smoke.settingsStore.set("formatOnSave",false);document.querySelector(".settings-trigger").click()',
  );
  await until('Boolean(document.querySelector(".settings-page:not([hidden])"))');
  await js(
    'Array.from(document.querySelectorAll(".settings-categories button")).find(b=>b.textContent==="Updates").click()',
  );
  await until('Boolean(document.querySelector("#updates-enabled"))');
  assert.equal(
    await js('document.querySelector("#updates-enabled").getAttribute("aria-checked")'),
    "true",
  );
  await js('document.querySelector("#updates-preview").focus()');
  await key("Enter");
  await until('document.querySelector("#updates-preview").getAttribute("aria-checked")==="true"');
  update({ phase: "downloading", version: "1.1.0", progress: 42 });
  await until('document.querySelector("progress")?.value===42');
  await pause(300);
  await fs.writeFile(
    path.join(temporary, "updates-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js('smoke.settingsStore.set("locale","zh-TW")');
  await until('document.querySelector("#settings-updates").textContent==="更新"');
  assert.match(
    await js('document.querySelector("#settings-updates").parentElement.textContent'),
    /正在下載 1.1.0：42%/,
  );
  update({ phase: "ready", progress: 100 });
  await until('Boolean(document.querySelector(".update-notice"))');
  await js(
    'Array.from(document.querySelectorAll(".update-notice button")).find(b=>b.textContent==="稍後").click()',
  );
  await until('!document.querySelector(".update-notice")');
  assert.equal(installed(), 0);
  // Edit a real Monaco buffer, then exercise cancel, failed save and busy rejection.
  await js(
    'document.querySelector(".settings-tab .tab-close").click();document.querySelector(\'[data-tree-path="main.bp"]\').click()',
  );
  await until('ed.getModel()?.uri.path === "/main.bp"');
  await js(
    'ed.setValue("LCD.Clear() // before update");document.querySelector(".settings-trigger").click()',
  );
  const restart =
    'Array.from(document.querySelectorAll(".update-actions button")).find(b=>b.textContent==="重新啟動並更新").click()';
  await js(restart);
  await until('Boolean(document.querySelector(".modal-card"))');
  await js('document.querySelector(".modal-actions button:first-child").click()');
  assert.equal(installed(), 0);
  failWrite();
  await js(restart);
  await until('Boolean(document.querySelector(".modal-card"))');
  await js('document.querySelector(".modal-actions button:last-child").click()');
  await pause(600);
  assert.equal(installed(), 0);
  assert.notEqual(files["main.bp"], "LCD.Clear() // before update");
  setBusy(true);
  await js(restart);
  await until('Boolean(document.querySelector(".modal-card"))');
  await js('document.querySelector(".modal-actions button:last-child").click()');
  await pause(200);
  assert.equal(installed(), 0);
  setBusy(false);
  await js(restart);
  await until('Boolean(document.querySelector(".modal-card"))');
  await js('document.querySelector(".modal-actions button:last-child").click()');
  await pause(1000);
  assert.equal(installed(), 1);
  assert.equal(files["main.bp"], "LCD.Clear() // before update");
  console.log(
    "update UI: bilingual progress, preview preference, later, cancel, failed save, busy guard and explicit install pass",
  );
}
