import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

// These controls only delay real language-service replies. They never generate
// quick fixes or open documentation URLs themselves.
export function createDiagnosticsFixture(language) {
  const requests = [];
  const documentation = [];
  const cancellations = [];
  let pending;
  let held = 0;
  return {
    requests,
    documentation,
    cancellations,
    held: () => held,
    holdNext(workspaceId) {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      pending = { workspaceId, wait };
      return release;
    },
    async quickFixes(args) {
      requests.push(structuredClone(args));
      const hold = pending?.workspaceId === args[0] ? pending : undefined;
      if (hold) pending = undefined;
      const result = await language.quickFixes(args[0], args[1]);
      if (hold) {
        held++;
        await hold.wait;
      }
      return result;
    },
    openDocumentation(request) {
      documentation.push(structuredClone(request));
    },
    cancelQuickFix(args) {
      cancellations.push(structuredClone(args));
      return language.cancelQuickFix(...args);
    },
  };
}

export async function checkDiagnostics({
  js,
  key,
  until,
  pause,
  win,
  mod,
  temporary,
  fixtures,
  choose,
  diagnostics,
  fileHistory,
  search,
  writes,
}) {
  const workspaceId = "00000000-0000-4000-8000-000000000006";
  const otherId = "00000000-0000-4000-8000-000000000007";
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalSize = win.getSize();
  const originalProject = await js(
    "document.querySelector('.project-tab.active [role=tab]')?.textContent",
  );
  const originalDisk = "diskValue = 1\n";
  for (const [id, name, content] of [
    [workspaceId, "Diagnostics test", originalDisk],
    [otherId, "Diagnostics isolation", "otherProject = 2\n"],
  ]) {
    const root = path.join(temporary, id);
    await fs.mkdir(root, { recursive: true });
    fixtures.set(id, { name, root, files: { "main.bp": content }, drafts: {} });
  }
  const fixture = fixtures.get(workspaceId);
  const waitMain = async (check, message) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await pause(50);
    }
    assert.fail(message);
  };
  const editor = async () => {
    await until(
      "smoke.monaco.editor.getEditors().filter(editor=>editor.getModel()?.uri.scheme!=='kobrixa-review').length === 1",
    );
    await js(
      "window.ed=smoke.monaco.editor.getEditors().find(editor=>editor.getModel()?.uri.scheme!=='kobrixa-review');ed.focus()",
    );
  };
  const switchTo = async (name) => {
    await js(
      `Array.from(document.querySelectorAll('.project-tab-select')).find(button=>button.textContent.includes(${JSON.stringify(name)})).click()`,
    );
    await until(
      `document.querySelector('.project-tab.active').textContent.includes(${JSON.stringify(name)})`,
    );
    await editor();
  };
  const open = async (id, name) => {
    choose(id);
    await js("ed.focus()");
    await key("o", [mod]);
    await until(
      `document.querySelector('.project-tab.active').textContent.includes(${JSON.stringify(name)})`,
    );
    await editor();
  };
  const select = async (code) => {
    await until(
      `Array.from(document.querySelectorAll('.problem-list button')).some(button=>button.querySelector('b')?.textContent===${JSON.stringify(code)})`,
    );
    await js(
      `Array.from(document.querySelectorAll('.problem-list button')).find(button=>button.querySelector('b')?.textContent===${JSON.stringify(code)}).click()`,
    );
    await until(
      `document.querySelector('.diagnostic-details h3')?.textContent.includes(${JSON.stringify(code)})`,
    );
  };
  const setSource = async (source, code) => {
    await js(
      `ed.setValue(${JSON.stringify(source)});ed.setPosition({lineNumber:1,column:1});ed.focus()`,
    );
    await pause(650);
    if (code) await select(code);
    else await until("document.querySelectorAll('.problem-list button').length === 0");
  };
  const readyFix = async () => {
    await until(
      "document.querySelector('.diagnostic-fixes button') && !document.querySelector('.diagnostic-fixes button').disabled && document.querySelector('.diagnostic-fixes').getAttribute('aria-busy')==='false'",
    );
  };
  const clickFix = async () => {
    await readyFix();
    await js("document.querySelector('.diagnostic-fixes button').click()");
  };
  await js(
    "smoke.settingsStore.set('locale','en');smoke.settingsStore.set('theme','dark');smoke.settingsStore.set('autoSave','off');smoke.settingsStore.set('formatOnSave',false);smoke.settingsStore.set('filesOpen',true);smoke.settingsStore.set('problemsOpen',true);smoke.keybindingsStore.reset()",
  );
  await open(workspaceId, "Diagnostics test");
  const beforeWrites = writes.length;

  // Monaco's native keyboard quick-fix menu reaches the same guarded workspace
  // edit path as the Problems details button.
  const missingParenthesis = "LCD.Clear(\n";
  await setSource(missingParenthesis, "BP1043");
  await readyFix();
  // A background analysis may invalidate the native action between opening the
  // menu and accepting it. Retry only that explicit stale-snapshot rejection;
  // an unexpected error or a missing action still fails this scenario.
  await js(`window.quickFixStale = false; window.captureQuickFixStale = event => {
    if (String(event.reason?.message).includes("workspace changed while preparing the edit")) window.quickFixStale = true;
  }; window.addEventListener("unhandledrejection", window.captureQuickFixStale)`);
  for (let attempt = 0; attempt < 2; attempt++) {
    await js("window.quickFixStale=false;ed.setPosition({lineNumber:1,column:11});ed.focus()");
    await key(".", [mod]);
    await until(
      "ed.getValue()==='LCD.Clear()\\n' || Array.from(document.querySelectorAll('.action-widget')).some(element=>element.getBoundingClientRect().height>0)",
    );
    if (await js("ed.getValue()!=='LCD.Clear()\\n'")) await key("Enter");
    await until("ed.getValue()==='LCD.Clear()\\n' || window.quickFixStale");
    if (await js("ed.getValue()==='LCD.Clear()\\n'")) break;
    assert.equal(
      await js("ed.getValue()"),
      missingParenthesis,
      "Stale actions must not modify text",
    );
    await key("Escape");
    await readyFix();
  }
  await js('window.removeEventListener("unhandledrejection", window.captureQuickFixStale)');
  assert.equal(await js("ed.getValue()"), "LCD.Clear()\n");
  await waitMain(
    () => fixture.drafts["main.bp"] === "LCD.Clear()\n",
    "Quick fix did not persist a recovery draft",
  );
  assert.equal(fixture.files["main.bp"], originalDisk);
  assert.equal(writes.length, beforeWrites);
  await js("ed.focus()");
  await key("z", [mod]);
  assert.equal(await js("ed.getValue()"), missingParenthesis);
  await key("z", [mod, "shift"]);
  assert.equal(await js("ed.getValue()"), "LCD.Clear()\n");

  for (const [source, code, expected] of [
    ["number[ values\n", "BP1024", "number[] values\n"],
    ["For i 1 To 3\nEndFor\n", "BP1033", "For i = 1 To 3\nEndFor\n"],
    ["For i = 1 3\nEndFor\n", "BP1034", "For i = 1 To 3\nEndFor\n"],
    [
      "If True Then\n  While True\n    LCD.Clear()\n",
      "BP1031",
      "If True Then\n  While True\n    LCD.Clear()\n  EndWhile\nEndIf\n",
    ],
  ]) {
    await setSource(source, code);
    await clickFix();
    await until(`ed.getValue()===${JSON.stringify(expected)}`);
    await js("ed.focus()");
    await key("z", [mod]);
    assert.equal(await js("ed.getValue()"), source);
    await key("z", [mod, "shift"]);
    assert.equal(await js("ed.getValue()"), expected);
    assert.equal(fixture.files["main.bp"], originalDisk);
    assert.equal(writes.length, beforeWrites);
  }

  // The documentation bridge receives code/locale selectors, never an arbitrary
  // renderer-controlled URL, and the smoke fixture never launches a browser.
  await setSource("For i = 1 3\nEndFor\n", "BP1034");
  await readyFix();
  await js("document.querySelector('.diagnostic-links button').click()");
  await waitMain(() => diagnostics.documentation.length > 0, "Documentation request was not sent");
  assert.deepEqual(diagnostics.documentation.at(-1), { code: "BP1034", locale: "en" });
  await js("document.querySelectorAll('.diagnostic-links button')[1].click()");
  await waitMain(
    () => diagnostics.documentation.at(-1)?.relatedIndex === 0,
    "Related documentation request was not sent",
  );

  const staleRequest = structuredClone(diagnostics.requests.at(-1));
  await setSource("LCD.Clear()\n");
  const staleReply = await js(
    `window.kobrixa.language.quickFixes(...${JSON.stringify(staleRequest)})`,
  );
  assert.equal(staleReply.kind, "stale");
  let held = diagnostics.held();
  let release = diagnostics.holdNext(workspaceId);
  await setSource("LCD.Clear( ' delayed\n", "BP1043");
  await waitMain(() => diagnostics.held() > held, "Quick-fix response was not held");
  await setSource("LCD.Clear() ' newer edit\n");
  release();
  await pause(200);
  assert.equal(await js("ed.getValue()"), "LCD.Clear() ' newer edit\n");
  assert.equal(await js("document.querySelectorAll('.diagnostic-fixes button').length"), 0);

  await open(otherId, "Diagnostics isolation");
  await switchTo("Diagnostics test");
  held = diagnostics.held();
  release = diagnostics.holdNext(workspaceId);
  await setSource("LCD.Clear( ' previous project\n", "BP1043");
  await waitMain(() => diagnostics.held() > held, "Project quick-fix response was not held");
  await switchTo("Diagnostics isolation");
  release();
  await pause(700);
  assert.equal(await js("ed.getValue()"), "otherProject = 2\n");
  assert.equal(await js("document.querySelectorAll('.diagnostic-fixes button').length"), 0);
  await switchTo("Diagnostics test");

  // Deletion or renaming between analysis and the final read also invalidates
  // the action; no replacement source file may be created by a quick fix.
  for (const moved of [false, true]) {
    const original = `LCD.Clear( ' ${moved ? "moved" : "deleted"}\n`;
    await setSource(original, "BP1043");
    await readyFix();
    search.changeOnNextRead(workspaceId, "main.bp", () => {
      if (moved) fileHistory.external(workspaceId, "moved.bp", fixture.files["main.bp"]);
      fileHistory.external(workspaceId, "main.bp", null);
    });
    await clickFix();
    await until("Boolean(document.querySelector('.diagnostic-error[role=alert]'))");
    assert.equal(await js("ed.getValue()"), original);
    assert.equal(fixture.files["main.bp"], undefined);
    if (moved) assert.equal(fixture.files["moved.bp"], originalDisk);
    assert.equal(writes.length, beforeWrites);
    fileHistory.external(workspaceId, "main.bp", originalDisk);
    if (moved) fileHistory.external(workspaceId, "moved.bp", null);
  }

  // An external edit during the final pre-apply read must leave the model and
  // source files untouched.
  const local = "LCD.Clear( ' conflict\n";
  await setSource(local, "BP1043");
  await readyFix();
  search.changeOnNextRead(workspaceId, "main.bp", () =>
    fileHistory.external(workspaceId, "main.bp", "externalValue = 99\n"),
  );
  await clickFix();
  await until("Boolean(document.querySelector('.diagnostic-error[role=alert]'))");
  assert.equal(await js("ed.getValue()"), local);
  assert.equal(fixture.files["main.bp"], "externalValue = 99\n");
  assert.equal(writes.length, beforeWrites);

  win.setSize(980, 650);
  await js(
    "smoke.settingsStore.set('uiScale',125);smoke.settingsStore.set('problemsHeight',320);smoke.settingsStore.set('rightPanel',null)",
  );
  await until("window.outerWidth===980 && window.outerHeight===650");
  for (const locale of ["en", "zh-TW"])
    for (const theme of ["dark", "light"]) {
      await js(
        `smoke.settingsStore.set('locale',${JSON.stringify(locale)});smoke.settingsStore.set('theme',${JSON.stringify(theme)})`,
      );
      await select("BP1043");
      await pause(300);
      assert.equal(
        await js(
          "document.querySelector('.diagnostic-details').scrollWidth <= document.querySelector('.diagnostic-details').clientWidth + 1",
        ),
        true,
        `${locale}/${theme} details fit the minimum-size window`,
      );
      assert.equal(
        await js(
          "document.querySelector('.diagnostic-original pre').textContent.includes(\"Expected ')' after arguments.\")",
        ),
        true,
      );
      await fs.writeFile(
        path.join(temporary, `diagnostics-${locale}-${theme}-980x650-125.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }

  await js("smoke.settingsStore.set('locale','en')");
  for (const name of ["Diagnostics test", "Diagnostics isolation"]) {
    await switchTo(name);
    await js(
      `document.querySelector(${JSON.stringify(`[aria-label="Close project: ${name}"]`)}).click()`,
    );
    await pause(100);
    if (await js("Boolean(document.querySelector('#close-project-title'))"))
      await js("document.querySelector('.modal-card .danger').click()");
    await until(
      `!Array.from(document.querySelectorAll('.project-tab-select')).some(button=>button.textContent.includes(${JSON.stringify(name)}))`,
    );
  }
  if (originalProject) await switchTo(originalProject);
  choose("00000000-0000-4000-8000-000000000001");
  await js(
    `for(const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) smoke.settingsStore.set(key,value)`,
  );
  win.setSize(...originalSize);
  // Native resize and React's restored scale/panel preferences settle after
  // setSize returns. Do not let the following suite measure an old viewport.
  await until(`window.outerWidth===${originalSize[0]} && window.outerHeight===${originalSize[1]}`);
  await pause(250);
  console.log(
    "PASS diagnostics: native keyboard quick fix, five repair families, panel apply, undo/redo, recovery drafts without source writes, documentation, stale replies, project isolation, deletion/move/conflicts and bilingual minimum-size themes",
  );
}
