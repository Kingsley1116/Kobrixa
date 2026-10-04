import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const revision = (content) => createHash("sha256").update(content).digest("hex");

// The matcher is bundled from production. These controls stay in the smoke main
// process so delayed replies exercise the normal sandboxed preload boundary.
export function createSearchFixture(fixtures, { isSearchableFile, findSearchMatches }) {
  const requests = [];
  let hold;
  let externalRead;
  return {
    requests,
    changeOnNextRead(workspaceId, file, change) {
      externalRead = { workspaceId, file, change };
    },
    beforeRead([workspaceId, file]) {
      if (externalRead?.workspaceId === workspaceId && externalRead.file === file) {
        const { change } = externalRead;
        externalRead = undefined;
        change();
      }
    },
    holdNext(workspaceId, query) {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      hold = { workspaceId, query, wait };
      return release;
    },
    async handle([workspaceId, request]) {
      requests.push({ workspaceId, ...structuredClone(request) });
      const fixture = fixtures.get(workspaceId);
      if (!fixture) throw new Error("Unknown search workspace");
      const files = [];
      for (const file of [
        ...new Set([...Object.keys(fixture.files), ...Object.keys(request.overlays)]),
      ].sort()) {
        if (!isSearchableFile(file)) continue;
        const content = request.overlays[file] ?? fixture.files[file];
        const matches = findSearchMatches(content, request);
        if (matches.length)
          files.push({
            path: file,
            content,
            revision: file in fixture.files ? revision(fixture.files[file]) : null,
            matches,
          });
      }
      const result = {
        files,
        matchCount: files.reduce((count, file) => count + file.matches.length, 0),
        truncated: false,
        skipped: [],
      };
      if (hold?.workspaceId === workspaceId && hold.query === request.query) {
        const pending = hold;
        hold = undefined;
        await pending.wait;
      }
      return result;
    },
  };
}

export async function checkWorkspaceSearch({
  js,
  key,
  until,
  pause,
  win,
  mod,
  temporary,
  fixtures,
  choose,
  search,
  writes,
}) {
  const searchId = "00000000-0000-4000-8000-000000000004";
  const otherId = "00000000-0000-4000-8000-000000000005";
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalSize = win.getSize();
  const originalProject = await js(
    "document.querySelector('.project-tab.active [role=tab]')?.textContent",
  );
  const mainDisk = "diskOnly = 1\n";
  const mainDraft = 'needle = 2\nneedleLong = 3\nNEEDLE = 4\ncaption = "😀 needle"\n';
  const secondDisk = "' needle\nNeedle = 7\nneedleLong = 8\n";
  const recoveredDisk = "oldValue = 8\n";
  const recoveredDraft = "needle = 9\n";
  for (const [id, name, files, drafts] of [
    [
      searchId,
      "Search test",
      {
        "main.bp": mainDisk,
        "second.bp": secondDisk,
        "recovered.bp": recoveredDisk,
        "kobrixa.json": '{"name":"Search test"}',
      },
      { "recovered.bp": recoveredDraft },
    ],
    [
      otherId,
      "Search isolation",
      { "main.bp": "otherProject = 1\n", "second.bp": "otherProject = 2\n" },
      {},
    ],
  ]) {
    const root = path.join(temporary, id);
    await fs.mkdir(root, { recursive: true });
    fixtures.set(id, {
      name,
      files,
      drafts,
      root,
      draftRevisions: id === searchId ? { "recovered.bp": revision(recoveredDisk) } : {},
    });
  }
  const fixture = fixtures.get(searchId);
  const waitMain = async (check, message) => {
    for (let n = 0; n < 100; n++) {
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
  const setInput = (selector, value) =>
    js(`searchSmokeInput(${JSON.stringify(selector)},${JSON.stringify(value)})`);
  const query = async (value, count) => {
    await setInput("[data-search-query]", value);
    if (count !== undefined)
      await until(
        `document.querySelectorAll('[data-search-path][data-search-line]').length === ${count}`,
      );
  };
  const openFile = async (file) => {
    await key("p", [mod]);
    await until("Boolean(document.querySelector('[data-quick-open]'))");
    await setInput("[data-quick-open-query]", file);
    await until("document.querySelectorAll('[data-quick-open-path]').length === 1");
    await key("Enter");
    await until(`ed.getModel().uri.path === ${JSON.stringify(`/${file}`)}`);
  };
  const click = async (selector) => {
    await until(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const capture = async (name) => {
    await pause(200);
    await fs.writeFile(path.join(temporary, name), (await win.webContents.capturePage()).toPNG());
  };
  await js(
    "smoke.settingsStore.set('locale','en');smoke.settingsStore.set('autoSave','off');smoke.settingsStore.set('formatOnSave',false);smoke.settingsStore.set('theme','dark');smoke.settingsStore.set('filesOpen',true);smoke.keybindingsStore.reset();window.searchSmokeInput=(selector,value)=>{const input=document.querySelector(selector);input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));};void 0",
  );
  await open(searchId, "Search test");
  await js(`ed.setValue(${JSON.stringify(mainDraft)});ed.focus()`);

  // Native shortcut, keyboard selection and Escape use the real modal and editor.
  await key("p", [mod]);
  await until("Boolean(document.querySelector('[data-quick-open]'))");
  assert.equal(await js("document.activeElement.matches('[data-quick-open-query]')"), true);
  await setInput("[data-quick-open-query]", "second");
  await until("document.querySelectorAll('[data-quick-open-path]').length === 1");
  await key("ArrowDown");
  await key("Enter");
  await until(
    "ed.getModel().uri.path === '/second.bp' && !document.querySelector('[data-quick-open]')",
  );
  assert.equal(await js("ed.getValue()"), secondDisk);
  await key("w", [mod]);
  await until("ed.getModel().uri.path === '/main.bp'");
  assert.equal(await js("ed.getValue()"), mainDraft);
  await key("p", [mod]);
  await until("Boolean(document.querySelector('[data-quick-open]'))");
  await setInput("[data-quick-open-query]", "does-not-exist");
  await until("document.querySelectorAll('[data-quick-open-path]').length === 0");
  await key("Escape");
  await until("!document.querySelector('[data-quick-open]')");
  assert.equal(await js("ed.getModel().uri.path"), "/main.bp");
  await key("p", [mod]);
  await until("Boolean(document.querySelector('[data-quick-open]'))");
  await setInput("[data-quick-open-query]", "main:3:2");
  await until("document.querySelectorAll('[data-quick-open-path]').length === 1");
  await key("Enter");
  await until("!document.querySelector('[data-quick-open]') && ed.getPosition().lineNumber === 3");
  assert.equal(await js("ed.getPosition().column"), 2);
  assert.equal(await js("ed.getValue()"), mainDraft);

  await key("f", [mod, "shift"]);
  await until("Boolean(document.querySelector('[data-workspace-search]'))");
  assert.equal(await js("document.activeElement.matches('[data-search-query]')"), true);
  await query("needle", 8);
  assert.equal(fixture.files["main.bp"], mainDisk);
  assert.ok(search.requests.at(-1).overlays["main.bp"].includes("😀 needle"));
  assert.equal(search.requests.at(-1).overlays["recovered.bp"], recoveredDraft);
  assert.equal(
    await js("Boolean(document.querySelector('.tabs [title=\"recovered.bp\"]'))"),
    false,
  );
  await capture("workspace-search-en-dark.png");

  // Search honors unsaved buffers, closed recovery drafts, case and word boundaries.
  await click("[data-search-case]");
  await until("document.querySelectorAll('[data-search-path][data-search-line]').length === 6");
  await click("[data-search-word]");
  await until("document.querySelectorAll('[data-search-path][data-search-line]').length === 4");
  await click('[data-search-path="second.bp"][data-search-line="1"]');
  await until(
    "ed.getModel().uri.path === '/second.bp' && ed.getModel().getValueInRange(ed.getSelection()) === 'needle'",
  );
  assert.equal(await js("ed.getModel().getValueInRange(ed.getSelection())"), "needle");
  assert.equal(await js("ed.getSelection().startColumn"), 3);
  await click('[data-search-path="main.bp"][data-search-line="4"]');
  await until(
    "ed.getModel().uri.path === '/main.bp' && ed.getModel().getValueInRange(ed.getSelection()) === 'needle'",
  );
  assert.equal(await js("ed.getModel().getValueInRange(ed.getSelection())"), "needle");
  assert.equal(await js("ed.getSelection().startColumn"), 15);
  // Quick opening a file without a suffix must restore its latest cursor, even
  // when the file was previously opened at a selected search result.
  await js("ed.setPosition({lineNumber:2,column:5})");
  await openFile("second.bp");
  await openFile("main.bp");
  assert.equal(await js("ed.getPosition().lineNumber"), 2);
  assert.equal(await js("ed.getPosition().column"), 5);

  const beforeWrites = writes.length;
  await setInput("[data-search-replacement]", "$& replacement");
  await until("!document.querySelector('[data-search-preview]').disabled");
  await click("[data-search-preview]");
  await until("Boolean(document.querySelector('.search-replace-dialog [data-search-apply]'))");
  assert.equal(await js("ed.getValue()"), mainDraft);
  assert.equal(fixture.files["second.bp"], secondDisk);
  assert.equal(writes.length, beforeWrites);
  await capture("workspace-search-replace-en.png");
  await js(
    "ed.pushUndoStop();ed.executeEdits('search-smoke',[{range:new smoke.monaco.Range(1,1,1,1),text:\"' Changed during preview\\n\"}]);ed.pushUndoStop()",
  );
  await until("document.querySelector('[data-search-apply]').disabled");
  assert.equal(writes.length, beforeWrites);
  await key("Escape");
  await until("!document.querySelector('.search-replace-dialog')");
  await js("ed.focus();ed.trigger('search-smoke','undo',null)");
  assert.equal(await js("ed.getValue()"), mainDraft);
  await until(
    "document.querySelectorAll('[data-search-path][data-search-line]').length === 4 && !document.querySelector('[data-search-preview]').disabled",
  );
  await click("[data-search-preview]");
  await until("Boolean(document.querySelector('.search-replace-dialog [data-search-apply]'))");
  search.changeOnNextRead(searchId, "main.bp", () => {
    fixture.files["second.bp"] = secondDisk + "' External edit after preview\n";
  });
  await click("[data-search-apply]");
  await until("Boolean(document.querySelector('.search-replace-dialog [role=alert]'))");
  assert.equal(
    await js("ed.getValue()"),
    mainDraft,
    "A later file conflict must leave earlier targets untouched",
  );
  assert.equal(fixture.drafts["recovered.bp"], recoveredDraft);
  assert.equal(writes.length, beforeWrites);
  assert.equal(
    await js(
      "smoke.monaco.editor.getModels().filter(model=>model.uri.scheme!=='kobrixa-review').some(model=>model.getValue().includes('$& replacement'))",
    ),
    false,
  );
  fixture.files["second.bp"] = secondDisk;
  await until("document.querySelector('.search-replace-dialog').contains(document.activeElement)");
  await key("Escape");
  await until("!document.querySelector('.search-replace-dialog')");
  await click("[data-search-refresh]");
  await until(
    "document.querySelectorAll('[data-search-path][data-search-line]').length === 4 && !document.querySelector('[data-search-preview]').disabled",
  );
  await click("[data-search-preview]");
  await until("Boolean(document.querySelector('.search-replace-dialog [data-search-apply]'))");
  await click("[data-search-apply]");
  await until("!document.querySelector('.search-replace-dialog')");
  await openFile("main.bp");
  assert.equal(
    await js("ed.getValue()"),
    mainDraft.replaceAll(/\bneedle\b/g, () => "$& replacement"),
  );
  await openFile("second.bp");
  assert.equal(
    await js("ed.getValue()"),
    secondDisk.replace("' needle", () => "' $& replacement"),
  );
  await openFile("recovered.bp");
  assert.equal(await js("ed.getValue()"), "$& replacement = 9\n");
  assert.equal(writes.length, beforeWrites, "Applying a preview follows normal save policy");
  assert.equal(fixture.files["main.bp"], mainDisk);
  await js("ed.focus();ed.trigger('search-smoke','undo',null)");
  assert.equal(await js("ed.getValue()"), recoveredDraft);
  await openFile("second.bp");
  await js("ed.focus();ed.trigger('search-smoke','undo',null)");
  assert.equal(await js("ed.getValue()"), secondDisk);
  await openFile("main.bp");
  await js("ed.focus();ed.trigger('search-smoke','undo',null)");
  assert.equal(await js("ed.getValue()"), mainDraft);

  // A delayed old query may finish after a newer search without replacing it.
  const oldCalls = search.requests.length;
  const releaseQuery = search.holdNext(searchId, "NEEDLE");
  await query("NEEDLE");
  await waitMain(() => search.requests.length > oldCalls, "Held search did not start");
  await query("caption");
  await until("document.querySelectorAll('[data-search-path][data-search-line]').length === 0");
  releaseQuery();
  await until("document.querySelectorAll('[data-search-path][data-search-line]').length === 1");
  assert.equal(
    await js("document.querySelectorAll('[data-search-path][data-search-line]').length"),
    1,
  );
  assert.equal(
    await js("document.querySelector('[data-search-path][data-search-line]').dataset.searchLine"),
    "4",
  );

  await open(otherId, "Search isolation");
  await switchTo("Search test");
  await key("f", [mod, "shift"]);
  await click("[data-search-case]");
  await click("[data-search-word]");
  await query("needle", 4);
  const projectCalls = search.requests.length;
  const releaseProject = search.holdNext(searchId, "needle");
  await click("[data-search-refresh]");
  await waitMain(() => search.requests.length > projectCalls, "Project search did not start");
  await switchTo("Search isolation");
  await key("f", [mod, "shift"]);
  await query("otherProject", 2);
  releaseProject();
  await until("document.querySelectorAll('[data-search-path][data-search-line]').length === 2");
  assert.equal(
    await js("document.querySelectorAll('[data-search-path][data-search-line]').length"),
    2,
  );
  assert.equal(
    await js("document.querySelector('.workspace-search-results').textContent.includes('needle')"),
    false,
  );
  assert.equal(await js("ed.getValue()"), "otherProject = 1\n");
  await switchTo("Search test");
  await key("f", [mod, "shift"]);
  await click("[data-search-case]");
  await click("[data-search-word]");
  await query("needle", 4);

  win.setSize(980, 650);
  await js(
    "smoke.settingsStore.set('locale','zh-TW');smoke.settingsStore.set('theme','light');smoke.settingsStore.set('uiScale',125)",
  );
  await until("window.outerWidth === 980 && window.outerHeight === 650");
  assert.equal(
    await js(
      "document.querySelector('[data-workspace-search]').scrollWidth <= document.querySelector('[data-workspace-search]').clientWidth",
    ),
    true,
  );
  await capture("workspace-search-zh-TW-light.png");
  await key("p", [mod]);
  await until("Boolean(document.querySelector('[data-quick-open]'))");
  await capture("workspace-quick-open-zh-TW-light.png");
  await key("Escape");

  // Leave the shared smoke harness exactly as it was before the isolated projects.
  await js("smoke.settingsStore.set('locale','en')");
  // Sidebar mode belongs to App rather than settings or an individual project.
  // Reset it while the search fixture is still open so subsequent suites get
  // the file tree when they restore filesOpen.
  await click(".files-navigation > button:first-child");
  await until(
    "document.querySelector('.files-navigation > button:first-child').getAttribute('aria-pressed') === 'true' && Boolean(document.querySelector('[data-tree-path=\"main.bp\"]'))",
  );
  for (const name of ["Search test", "Search isolation"]) {
    await switchTo(name);
    await click(`[aria-label="Close project: ${name}"]`);
    await pause(100);
    if (await js("Boolean(document.querySelector('#close-project-title'))"))
      await click(".modal-card .danger");
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
  console.log(
    "PASS quick open keyboard/filter/escape, project search over dirty and closed files/drafts, case/word matching, exact selections, literal preview/replace with per-file undo, stale query/project replies and bilingual narrow layouts",
  );
}
