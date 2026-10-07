import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const defaultPreferences = {
  externalChangesEnabled: true,
  externalChangeInterval: 2000,
  externalChangeAutoReload: true,
  localHistoryEnabled: true,
  localHistoryDays: 30,
  localHistoryVersions: 50,
  localHistorySnapshotMiB: 2,
  localHistoryWorkspaceMiB: 50,
};

const snapshot = (files, file) => {
  const content = files[file] ?? null;
  return {
    content,
    revision: content === null ? null : createHash("sha256").update(content).digest("hex"),
  };
};

// Controls are confined to the smoke main process; the renderer receives only
// the same snapshot/history API that production exposes.
export function createFileHistoryFixture(fixtures, workspace) {
  let preferences = { ...defaultPreferences };
  const observed = new Map();
  const histories = new Map();
  const signature = (id) => JSON.stringify(fixtures.get(id).files);
  const signatures = new Map([...fixtures.keys()].map((id) => [id, signature(id)]));
  let sequence = 0;
  let nextRefresh;
  let refreshCalls = 0;
  let nextHistoryContent;
  let historyContentCalls = 0;
  let nextDraft;
  let draftCalls = 0;
  let heldDrafts = 0;
  let delayedRead;
  let heldReads = 0;
  let savedWrites = 0;
  const identity = (id, file) => `${id}:${file}`;
  const prune = (id) => {
    const cutoff = Date.now() - preferences.localHistoryDays * 86400000;
    const entries = [];
    for (const [key, versions] of histories) {
      if (!key.startsWith(`${id}:`)) continue;
      const keep = versions
        .filter((entry) => entry.timestamp >= cutoff)
        .slice(0, preferences.localHistoryVersions);
      histories.set(key, keep);
      entries.push(...keep.map((entry) => ({ key, entry })));
    }
    let remaining = preferences.localHistoryWorkspaceMiB * 1048576;
    for (const { key, entry } of entries.sort((a, b) => b.entry.timestamp - a.entry.timestamp)) {
      if (entry.size <= remaining) remaining -= entry.size;
      else
        histories.set(
          key,
          histories.get(key).filter((version) => version.id !== entry.id),
        );
    }
  };
  const archive = (id, file, content, reason) => {
    if (
      !preferences.localHistoryEnabled ||
      content === null ||
      Buffer.byteLength(content) > preferences.localHistorySnapshotMiB * 1048576
    )
      return;
    const key = identity(id, file);
    const versions = histories.get(key) ?? [];
    if (versions[0]?.content === content) return;
    versions.unshift({
      id: `history-${++sequence}`,
      timestamp: Date.now() + sequence,
      reason,
      size: Buffer.byteLength(content),
      content,
    });
    histories.set(key, versions);
    prune(id);
  };
  const observe = (id, file) => {
    const key = identity(id, file);
    const current = snapshot(fixtures.get(id).files, file);
    const previous = observed.get(key);
    if (previous && previous.revision !== current.revision)
      archive(id, file, previous.content, current.content === null ? "delete" : "external");
    observed.set(key, current);
    return current;
  };
  return {
    handles: (name) =>
      [
        "filePreferences",
        "setFilePreferences",
        "readFile",
        "refresh",
        "history",
        "historyContent",
      ].includes(name),
    async handle(name, args) {
      if (name === "filePreferences") return { ...preferences };
      if (name === "setFilePreferences") {
        preferences = { ...preferences, ...args[0] };
        return { ...preferences };
      }
      const [id, file] = args;
      if (name === "readFile") {
        if (delayedRead?.workspaceId === id && delayedRead.file === file) {
          delayedRead.remaining--;
          if (delayedRead.remaining === 0) {
            const plan = delayedRead;
            delayedRead = undefined;
            fixtures.get(id).files[file] = plan.content;
            const current = observe(id, file);
            heldReads++;
            await plan.wait;
            return current;
          }
        }
        return observe(id, file);
      }
      if (name === "history") {
        observe(id, file);
        prune(id);
        return (histories.get(identity(id, file)) ?? []).map(({ id, timestamp, reason, size }) => ({
          id,
          timestamp,
          reason,
          size,
        }));
      }
      if (name === "historyContent") {
        const entry = (histories.get(identity(id, file)) ?? []).find(({ id }) => id === args[2]);
        if (!entry) throw new Error("Missing history entry");
        historyContentCalls++;
        const hold = nextHistoryContent;
        nextHistoryContent = undefined;
        if (hold) await hold;
        return entry.content;
      }
      refreshCalls++;
      const currentSignature = signature(id);
      const result = {
        workspace: workspace(id),
        files: {},
        changed: signatures.get(id) !== currentSignature,
      };
      signatures.set(id, currentSignature);
      for (const [file, revision] of Object.entries(args[1])) {
        const current = observe(id, file);
        if (current.revision !== revision) result.files[file] = current;
      }
      const hold = nextRefresh;
      nextRefresh = undefined;
      if (hold) await hold;
      return result;
    },
    write(id, file, content, expectedRevision) {
      const current = observe(id, file);
      if (current.revision !== expectedRevision) return { status: "conflict", snapshot: current };
      if (current.content !== content) archive(id, file, current.content, "save");
      const fixture = fixtures.get(id);
      fixture.files[file] = content;
      delete fixture.drafts[file];
      delete fixture.draftRevisions?.[file];
      const saved = snapshot(fixture.files, file);
      observed.set(identity(id, file), saved);
      signatures.set(id, signature(id));
      savedWrites++;
      return { status: "saved", snapshot: saved };
    },
    external(id, file, content) {
      const files = fixtures.get(id).files;
      if (content === null) delete files[file];
      else files[file] = content;
    },
    entries: (id, file) => structuredClone(histories.get(identity(id, file)) ?? []),
    preferences: () => ({ ...preferences }),
    async beforeDraft(args) {
      draftCalls++;
      if (nextDraft && args[2] !== undefined) {
        const hold = nextDraft;
        nextDraft = undefined;
        heldDrafts++;
        await hold;
      }
    },
    stats: () => ({
      refreshCalls,
      historyContentCalls,
      draftCalls,
      heldDrafts,
      heldReads,
      savedWrites,
    }),
    holdSecondRead(workspaceId, file, content) {
      let release;
      const wait = new Promise((resolve) => {
        release = resolve;
      });
      delayedRead = { workspaceId, file, content, remaining: 2, wait };
      return release;
    },
    holdNextRefresh() {
      let release;
      nextRefresh = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdNextHistoryContent() {
      let release;
      nextHistoryContent = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    holdNextDraft() {
      let release;
      nextDraft = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

export async function checkFileHistory({
  js,
  key,
  until,
  pause,
  win,
  mod,
  temporary,
  fixtures,
  choose,
  fileHistory,
  analysisCount,
}) {
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const first = fixtures.get(firstId);
  const second = fixtures.get(secondId);
  const originalFiles = { ...first.files };
  const originalSecond = { ...second.files };
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalSize = win.getSize();
  const dialog = ".file-conflict-dialog";
  const historyDialog = ".local-history-dialog";
  const diffContents =
    "smoke.monaco.editor.getModels().filter(model=>model.uri.scheme==='kobrixa-review').map(model=>model.getValue())";
  const waitMain = async (check, message) => {
    for (let n = 0; n < 100; n++) {
      if (check()) return;
      await pause(50);
    }
    assert.fail(message);
  };
  const focusRefresh = () => js("window.dispatchEvent(new Event('focus'))");
  const action = (name) =>
    js(`document.querySelector('[data-file-review-action="${name}"]').click()`);
  const getEditor = async () => {
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
    await getEditor();
  };
  const save = async (text, fixture = first, file = "main.bp") => {
    await js(`ed.setValue(${JSON.stringify(text)});ed.focus()`);
    await key("s", [mod]);
    await waitMain(() => fixture.files[file] === text, "Source save did not complete");
    await until("!document.querySelector('.tab.active i[aria-label]')");
  };
  const compare = async () => {
    await js("document.querySelector('.file-change-banner button').click()");
    await until(`Boolean(document.querySelector('${dialog}'))`);
  };
  const closeReview = async () => {
    await action("close");
    await until("!document.querySelector('.file-conflict-dialog, .local-history-dialog')");
  };
  await js(
    "smoke.settingsStore.set('locale','en');smoke.settingsStore.set('autoSave','off');smoke.settingsStore.set('formatOnSave',false);smoke.settingsStore.set('filesOpen',true)",
  );
  await save("value = 10\n");
  await js("window.fileHistoryModel=ed.getModel();void 0");

  // Clean buffers follow disk changes while retaining the live Monaco model.
  fileHistory.external(firstId, "main.bp", "value = 20\n");
  await focusRefresh();
  await until("ed.getValue() === 'value = 20\\n'");
  assert.equal(await js("ed.getModel()===window.fileHistoryModel"), true);
  assert.equal(await js("Boolean(document.querySelector('.file-change-banner'))"), false);
  assert.equal(await js("Boolean(document.querySelector('.tab.active i[aria-label]'))"), false);

  // Reload cleanup must preserve edits made while an older recovery write is pending.
  const heldDrafts = fileHistory.stats().heldDrafts;
  const releaseDraft = fileHistory.holdNextDraft();
  await js("ed.setValue('value = 19\\n')");
  await waitMain(() => fileHistory.stats().heldDrafts > heldDrafts, "Recovery write did not start");
  await js("ed.setValue('value = 20\\n')");
  fileHistory.external(firstId, "main.bp", "value = 20\n' reloaded\n");
  await focusRefresh();
  await until(`ed.getValue() === ${JSON.stringify("value = 20\n' reloaded\n")}`);
  const latestAfterReload = "value = 20\n' typed during cleanup\n";
  await js(`ed.setValue(${JSON.stringify(latestAfterReload)})`);
  const pendingDraftCalls = fileHistory.stats().draftCalls;
  releaseDraft();
  await waitMain(
    () => fileHistory.stats().draftCalls > pendingDraftCalls,
    "Reload recovery cleanup did not settle",
  );
  assert.equal(first.drafts["main.bp"], latestAfterReload);
  assert.equal(await js("ed.getValue()"), latestAfterReload);
  await save("value = 20\n");

  // A dirty file keeps both versions; automatic saving must never overwrite disk.
  await js("ed.setValue('value = 21\\n')");
  fileHistory.external(firstId, "main.bp", "value = 22\n");
  await focusRefresh();
  await until("Boolean(document.querySelector('.file-change-banner'))");
  assert.equal(await js("ed.getValue()"), "value = 21\n");
  await js(
    `smoke.settingsStore.set('autoSave','afterDelay');smoke.settingsStore.set('autoSaveDelay',500);ed.setValue(${JSON.stringify("value = 21\n' still local\n")})`,
  );
  await pause(1000);
  assert.equal(first.files["main.bp"], "value = 22\n");
  assert.match(await js("ed.getValue()"), /still local/);
  assert.equal(await js("Boolean(document.querySelector('.file-conflict-dialog'))"), false);
  await js("smoke.settingsStore.set('autoSave','off')");
  await compare();
  await until(`(${diffContents}).includes('value = 22\\n')`);
  assert.ok((await js(diffContents)).some((content) => content.includes("still local")));
  await key("Escape");
  await until("!document.querySelector('.file-conflict-dialog')");
  assert.match(await js("ed.getValue()"), /still local/);
  assert.equal(first.files["main.bp"], "value = 22\n");
  await compare();
  await pause(250);
  await fs.writeFile(
    path.join(temporary, "file-conflict-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await action("reload");
  await until(
    "!document.querySelector('.file-conflict-dialog') && ed.getValue() === 'value = 22\\n'",
  );
  assert.equal(await js("Boolean(document.querySelector('.file-change-banner'))"), false);

  // A manual save opens review, and a second unreviewed disk edit re-conflicts.
  await js("ed.setValue('value = 24\\n');ed.focus()");
  fileHistory.external(firstId, "main.bp", "value = 23\n");
  await key("s", [mod]);
  await until(`Boolean(document.querySelector('${dialog}'))`);
  await until(`(${diffContents}).includes('value = 23\\n')`);
  fileHistory.external(firstId, "main.bp", "value = 25\n");
  await action("save");
  await until(`(${diffContents}).includes('value = 25\\n')`);
  assert.equal(first.files["main.bp"], "value = 25\n");
  assert.equal(await js("ed.getValue()"), "value = 24\n");
  await action("save");
  await waitMain(() => first.files["main.bp"] === "value = 24\n", "Explicit local save failed");
  await until("!document.querySelector('.file-conflict-dialog, .file-change-banner')");

  // A refresh uses current dirty state when it finally returns, not request-time state.
  fileHistory.external(firstId, "main.bp", "value = 30\n");
  let calls = fileHistory.stats().refreshCalls;
  const releaseDirtyRefresh = fileHistory.holdNextRefresh();
  await focusRefresh();
  await waitMain(() => fileHistory.stats().refreshCalls > calls, "Refresh did not start");
  await js("ed.setValue('value = 31\\n')");
  releaseDirtyRefresh();
  await until("Boolean(document.querySelector('.file-change-banner'))");
  assert.equal(await js("ed.getValue()"), "value = 31\n");
  await compare();
  await action("reload");
  await until(
    "!document.querySelector('.file-conflict-dialog') && ed.getValue() === 'value = 30\\n'",
  );

  // An older refresh cannot roll back a later successful explicit save.
  fileHistory.external(firstId, "main.bp", "value = 32\n");
  calls = fileHistory.stats().refreshCalls;
  const releaseOldRefresh = fileHistory.holdNextRefresh();
  await focusRefresh();
  await waitMain(() => fileHistory.stats().refreshCalls > calls, "Delayed refresh did not start");
  await js("ed.setValue('value = 33\\n');ed.focus()");
  await key("s", [mod]);
  await until(`Boolean(document.querySelector('${dialog}'))`);
  await action("save");
  await waitMain(() => first.files["main.bp"] === "value = 33\n", "Save during refresh failed");
  await until("!document.querySelector('.file-conflict-dialog')");
  releaseOldRefresh();
  await pause(300);
  assert.equal(await js("ed.getValue()"), "value = 33\n");
  assert.equal(await js("Boolean(document.querySelector('.file-change-banner'))"), false);

  // External deletion retains the open text until the user explicitly recreates it.
  fileHistory.external(firstId, "main.bp", null);
  fileHistory.external(firstId, "external-added.bp", "value = 99\n");
  await focusRefresh();
  await until("Boolean(document.querySelector('.file-change-banner'))");
  await until("Boolean(document.querySelector('[data-tree-path=\"external-added.bp\"]'))");
  assert.equal(await js("ed.getValue()"), "value = 33\n");
  await compare();
  assert.equal(
    await js("document.querySelector('[data-file-review-action=\"save\"]').textContent"),
    "Recreate file",
  );
  await action("save");
  await waitMain(() => first.files["main.bp"] === "value = 33\n", "Deleted file was not recreated");
  await until("!document.querySelector('.file-conflict-dialog, .file-change-banner')");

  // History is previewed without a write; restoration is an ordinary undoable edit.
  const oldVersion = fileHistory
    .entries(firstId, "main.bp")
    .find((entry) => entry.content === "value = 10\n");
  assert.ok(oldVersion, "An external edit archives the last observed disk version");
  await js("document.querySelector('.local-history-trigger').click()");
  await until(`Boolean(document.querySelector('${historyDialog}'))`);
  await until(`Boolean(document.querySelector('[data-history-id="${oldVersion.id}"]'))`);
  await js(`document.querySelector('[data-history-id="${oldVersion.id}"]').click()`);
  await until(`(${diffContents}).includes('value = 10\\n')`);
  assert.equal(first.files["main.bp"], "value = 33\n");
  assert.equal(await js("ed.getValue()"), "value = 33\n");
  await pause(250);
  await fs.writeFile(
    path.join(temporary, "file-history-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await action("restore");
  await until(
    "!document.querySelector('.local-history-dialog') && ed.getValue() === 'value = 10\\n'",
  );
  assert.equal(first.files["main.bp"], "value = 33\n");
  // Dialog teardown restores focus on the next frame; undo routes through the focused editor.
  win.focus();
  await js("ed.focus()");
  await until("ed.hasTextFocus()");
  await js("ed.trigger('test','undo',null)");
  await until("ed.getValue() === 'value = 33\\n'");

  // Two pending opens must not accept a later baseline beneath the first buffer.
  calls = fileHistory.stats().refreshCalls;
  const releaseReadRefresh = fileHistory.holdNextRefresh();
  await focusRefresh();
  await waitMain(() => fileHistory.stats().refreshCalls > calls, "Read-race refresh did not start");
  const heldReads = fileHistory.stats().heldReads;
  const releaseSecondRead = fileHistory.holdSecondRead(firstId, "second.bp", "value = 901\n");
  await js(`(() => {
    const file=document.querySelector('[data-tree-path="second.bp"]');
    file.click();file.click();
  })()`);
  await waitMain(
    () => fileHistory.stats().heldReads > heldReads,
    "The overlapping read did not start",
  );
  await until("ed.getModel().uri.path === '/second.bp'");
  assert.equal(await js("ed.getValue()"), originalFiles["second.bp"]);
  await js("ed.setValue('value = 902\\n');ed.focus()");
  releaseSecondRead();
  await pause(100);
  await key("s", [mod]);
  await until(`Boolean(document.querySelector('${dialog}'))`);
  assert.equal(first.files["second.bp"], "value = 901\n");
  assert.equal(await js("ed.getValue()"), "value = 902\n");
  await action("reload");
  await until(
    "!document.querySelector('.file-conflict-dialog') && ed.getValue() === 'value = 901\\n'",
  );
  releaseReadRefresh();
  await save(originalFiles["second.bp"], first, "second.bp");
  await key("w", [mod]);
  await until("ed.getModel().uri.path === '/main.bp'");

  // A discarded refresh still invalidates a changed, unopened dependency next time.
  fileHistory.external(
    firstId,
    "historydep.bpm",
    "Function Known(in number input)\nReturn input\nEndFunction\n",
  );
  await focusRefresh();
  await until("Boolean(document.querySelector('[data-tree-path=\"historydep.bpm\"]'))");
  const dependencySource = 'Import "historydep"\nanswer = historydep.Known(1)\n';
  await save(dependencySource);
  await until(
    `ed._commandService.executeCommand('_executeHoverProvider',ed.getModel().uri,new smoke.monaco.Position(2,23)).then(result=>result.some(item=>item.contents.some(content=>content.value.includes('Known(in number input)'))))`,
  );
  await until("smoke.monaco.editor.getModelMarkers({resource:ed.getModel().uri}).length === 0");
  await pause(600);
  fileHistory.external(
    firstId,
    "historydep.bpm",
    "Function Renamed(in number input)\nReturn input\nEndFunction\n",
  );
  calls = fileHistory.stats().refreshCalls;
  const releaseDependencyRefresh = fileHistory.holdNextRefresh();
  await focusRefresh();
  await waitMain(
    () => fileHistory.stats().refreshCalls > calls,
    "Dependency refresh did not start",
  );
  const savedWrites = fileHistory.stats().savedWrites;
  await js("ed.focus()");
  await key("s", [mod]);
  await waitMain(
    () => fileHistory.stats().savedWrites > savedWrites,
    "Clean save did not complete",
  );
  await pause(100);
  releaseDependencyRefresh();
  await pause(100);
  const analyzedBeforeRetry = analysisCount();
  await focusRefresh();
  await waitMain(
    () => analysisCount() > analyzedBeforeRetry,
    "Discarded dependency invalidation was lost",
  );
  await until(
    "smoke.monaco.editor.getModelMarkers({resource:ed.getModel().uri}).some(marker=>marker.message.toLowerCase().includes('known'))",
  );
  assert.equal(await js("ed.getValue()"), dependencySource);
  await save("value = 33\n");
  fileHistory.external(firstId, "historydep.bpm", null);
  await focusRefresh();
  await until("!document.querySelector('[data-tree-path=\"historydep.bpm\"]')");

  // Identical relative filenames retain separate histories and refresh ownership.
  choose(secondId);
  await key("o", [mod]);
  await until("document.querySelector('.project-tab.active').textContent.includes('Project 2')");
  await getEditor();
  await save("value = 202\n", second);
  fileHistory.external(secondId, "main.bp", "value = 203\n");
  await focusRefresh();
  await until("ed.getValue() === 'value = 203\\n'");
  assert.equal(first.files["main.bp"], "value = 33\n");
  await switchTo("Keyboard test");
  assert.equal(await js("ed.getValue()"), "value = 33\n");

  // A closed dialog cannot deliver its delayed history content to another project.
  const historyCalls = fileHistory.stats().historyContentCalls;
  const releaseHistory = fileHistory.holdNextHistoryContent();
  await js("document.querySelector('.local-history-trigger').click()");
  await waitMain(
    () => fileHistory.stats().historyContentCalls > historyCalls,
    "History preview did not start",
  );
  await closeReview();
  await switchTo("Project 2");
  await js("document.querySelector('.local-history-trigger').click()");
  await until(`(${diffContents}).includes('value = 202\\n')`);
  releaseHistory();
  await pause(200);
  const projectTwoPreview = await js(diffContents);
  assert.ok(projectTwoPreview.includes("value = 202\n"));
  assert.ok(projectTwoPreview.includes("value = 203\n"));
  assert.equal(projectTwoPreview.includes("value = 33\n"), false);
  win.setSize(980, 650);
  await js(
    "smoke.settingsStore.set('locale','zh-TW');smoke.settingsStore.set('theme','light');smoke.settingsStore.set('uiScale',125)",
  );
  await until(
    "document.querySelector('.local-history-dialog').textContent.includes('還原到編輯器')",
  );
  assert.deepEqual(win.getSize(), [980, 650]);
  const [contentWidth, contentHeight] = win.getContentSize();
  await until(`innerWidth === ${contentWidth} && innerHeight === ${contentHeight}`);
  await pause(250);
  assert.equal(
    await js(`(() => {
      const box=document.querySelector('.local-history-dialog').getBoundingClientRect();
      return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1;
    })()`),
    true,
    "History dialog fits the minimum window at 125% scale",
  );
  await fs.writeFile(
    path.join(temporary, "file-history-zh-TW-light.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await closeReview();

  // Restore the shared fixture and UI state so the complete smoke can follow.
  await js("smoke.settingsStore.set('locale','en')");
  await save(originalSecond["main.bp"], second);
  await js("document.querySelector('[aria-label=\"Close project: Project 2\"]').click()");
  await until("document.querySelectorAll('.project-tab').length === 1");
  await getEditor();
  await save(originalFiles["main.bp"]);
  fileHistory.external(firstId, "external-added.bp", null);
  await focusRefresh();
  await until("!document.querySelector('[data-tree-path=\"external-added.bp\"]')");
  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) smoke.settingsStore.set(key,value);ed.focus()`,
  );
  win.setSize(...originalSize);
  choose(firstId);
  await checkFileHistoryPreferences({
    js,
    key,
    until,
    pause,
    win,
    mod,
    temporary,
    fileHistory,
    fixture: first,
    workspaceId: firstId,
    getEditor,
  });
  console.log(
    "PASS external file reload/conflicts, safe autosave, repeated conflicts, stale replies, overlapping reads, closed-dependency invalidation, deletion/recreation, tree refresh, project-scoped history and undoable restore",
  );
}

async function checkFileHistoryPreferences({
  js,
  key,
  until,
  pause,
  win,
  mod,
  temporary,
  fileHistory,
  fixture,
  workspaceId,
  getEditor,
}) {
  const originalContent = await js("ed.getValue()");
  const originalSettings = await js("smoke.settingsStore.getSnapshot().values");
  const originalFilePreferences = fileHistory.preferences();
  const originalSize = win.getSize();
  const waitMain = async (check, message) => {
    for (let n = 0; n < 100; n++) {
      if (check()) return;
      await pause(50);
    }
    assert.fail(message);
  };
  const defineSearch = () =>
    js(`window.searchFileSettings = value => {
    const input=document.querySelector('.settings-search input[type=search]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
    input.dispatchEvent(new Event('input',{bubbles:true}));
  };void 0`);
  const settings = async () => {
    await key(",", [mod]);
    await until('!document.querySelector("#settings-page").hidden');
    await defineSearch();
  };
  const search = async (field) => {
    await js(`searchFileSettings(${JSON.stringify(`files.${field}`)})`);
    await until(`Boolean(document.querySelector('#setting-${field}'))`);
    await until(`!document.querySelector('#setting-${field}').disabled`);
  };
  const toggle = async (field, expected) => {
    await search(field);
    await js(`document.querySelector('#setting-${field}').focus()`);
    await key("Enter");
    await waitMain(() => fileHistory.preferences()[field] === expected, `${field} was not saved`);
    await until(
      `document.querySelector('#setting-${field}').getAttribute('aria-checked') === '${expected}'`,
    );
  };
  const select = async (field, position, expected) => {
    await search(field);
    await js(`document.querySelector('#setting-${field}').focus()`);
    await key("Enter");
    await key(position);
    await key("Enter");
    await waitMain(() => fileHistory.preferences()[field] === expected, `${field} was not saved`);
    await until(`!document.querySelector('#setting-${field}').disabled`);
  };
  const closeSettings = () =>
    js("document.querySelector('.settings-tab .tab-close').click();ed.focus()");
  const resolveDisk = async () => {
    await until("Boolean(document.querySelector('.file-conflict-dialog'))");
    await js("document.querySelector('[data-file-review-action=\"reload\"]').click()");
    await until("!document.querySelector('.file-conflict-dialog, .file-change-banner')");
  };
  await js(
    "smoke.settingsStore.set('locale','en');smoke.settingsStore.set('autoSave','off');smoke.settingsStore.set('formatOnSave',false)",
  );
  await settings();
  await select("localHistoryVersions", "End", 200);
  await js("document.querySelector('.setting-footer button').click()");
  await waitMain(
    () => fileHistory.preferences().localHistoryVersions === 50,
    "Reset did not persist the default",
  );
  await js("searchFileSettings('本機歷史')");
  await until("Boolean(document.querySelector('#setting-localHistoryEnabled'))");
  assert.equal(
    await js("document.querySelector('#settings-fileHistory').textContent"),
    "Files & history",
  );

  // Disabling detection stops both periodic and focus scans; saving still checks disk.
  await select("externalChangeInterval", "Home", 1000);
  const refreshBeforeDisable = fileHistory.stats().refreshCalls;
  const releaseDisabledRefresh = fileHistory.holdNextRefresh();
  fileHistory.external(workspaceId, "main.bp", "value = 699\n");
  await js("window.dispatchEvent(new Event('focus'))");
  await waitMain(
    () => fileHistory.stats().refreshCalls > refreshBeforeDisable,
    "Refresh before disabling did not start",
  );
  await toggle("externalChangesEnabled", false);
  releaseDisabledRefresh();
  await js("searchFileSettings('files.externalChangeInterval')");
  await until("document.querySelector('#setting-externalChangeInterval')?.disabled === true");
  await js("searchFileSettings('files.externalChangeAutoReload')");
  await until("document.querySelector('#setting-externalChangeAutoReload')?.disabled === true");
  await closeSettings();
  await pause(100);
  assert.equal(await js("ed.getValue()"), originalContent, "Disabling rejects in-flight reloads");
  const pausedCalls = fileHistory.stats().refreshCalls;
  fileHistory.external(workspaceId, "main.bp", "value = 700\n");
  await js("window.dispatchEvent(new Event('focus'))");
  await pause(1200);
  assert.equal(fileHistory.stats().refreshCalls, pausedCalls);
  assert.equal(await js("ed.getValue()"), originalContent);
  await key("s", [mod]);
  await until("Boolean(document.querySelector('.file-conflict-dialog'))");
  assert.equal(fixture.files["main.bp"], "value = 700\n");
  await resolveDisk();
  assert.equal(await js("ed.getValue()"), "value = 700\n");

  // Changing the interval takes effect immediately; clean files can require review.
  await settings();
  await toggle("externalChangesEnabled", true);
  await select("externalChangeInterval", "End", 10000);
  await toggle("externalChangeAutoReload", false);
  await pause(100);
  fileHistory.external(workspaceId, "main.bp", "value = 701\n");
  const changeStarted = Date.now();
  await select("externalChangeInterval", "Home", 1000);
  await closeSettings();
  await until("Boolean(document.querySelector('.file-change-banner'))");
  assert.ok(Date.now() - changeStarted < 3000, "Interval change replaced the old ten-second timer");
  assert.equal(await js("ed.getValue()"), "value = 700\n");
  await js("document.querySelector('.file-change-banner button').click()");
  await resolveDisk();
  assert.equal(await js("ed.getValue()"), "value = 701\n");

  // Retention choices persist across a renderer restart, and pausing new history keeps browsing.
  await settings();
  await toggle("localHistoryEnabled", false);
  await select("localHistoryDays", "Home", 7);
  await select("localHistoryVersions", "Home", 20);
  await select("localHistorySnapshotMiB", "Home", 1);
  await select("localHistoryWorkspaceMiB", "Home", 20);
  const expectedPreferences = fileHistory.preferences();
  await closeSettings();
  await pause(500);
  await win.reload();
  await until("Boolean(window.smoke && document.querySelector('.project-tab.active'))");
  await getEditor();
  await settings();
  await search("localHistoryEnabled");
  assert.equal(
    await js("document.querySelector('#setting-localHistoryEnabled').getAttribute('aria-checked')"),
    "false",
  );
  assert.deepEqual(await js("window.kobrixa.workspace.getPreferences()"), expectedPreferences);
  await closeSettings();
  const historyBeforeSave = await js(
    `window.kobrixa.workspace.history('${workspaceId}','main.bp')`,
  );
  assert.ok(historyBeforeSave.length > 0);
  await js("ed.setValue('value = 702\\n');ed.focus()");
  await key("s", [mod]);
  await waitMain(
    () => fixture.files["main.bp"] === "value = 702\n",
    "Save with history disabled failed",
  );
  assert.equal(fileHistory.entries(workspaceId, "main.bp").length, historyBeforeSave.length);
  await js("document.querySelector('.local-history-trigger').click()");
  await until("Boolean(document.querySelector('.local-history-dialog [data-history-id]'))");
  const footer = await js(
    "document.querySelector('.local-history-dialog .file-review-note').textContent",
  );
  assert.match(footer, /7 days/);
  assert.match(footer, /20 versions/);
  assert.match(footer, /1 MiB/);
  assert.match(footer, /20 MiB/);
  assert.match(
    await js("document.querySelector('.local-history-dialog').textContent"),
    /New local history versions are disabled/,
  );
  await pause(250);
  await fs.writeFile(
    path.join(temporary, "file-history-preferences-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js("document.querySelector('[data-file-review-action=\"close\"]').click()");

  await settings();
  for (const field of Object.keys(defaultPreferences)) {
    await js(`searchFileSettings(${JSON.stringify(`files.${field}`)})`);
    await until(`Boolean(document.querySelector('#setting-${field}'))`);
    if (await js("Boolean(document.querySelector('.setting-footer button'))")) {
      await js("document.querySelector('.setting-footer button').click()");
      await waitMain(
        () => fileHistory.preferences()[field] === defaultPreferences[field],
        `${field} reset failed`,
      );
    }
  }
  assert.deepEqual(fileHistory.preferences(), defaultPreferences);
  await js(
    "searchFileSettings('');Array.from(document.querySelectorAll('.settings-categories button')).find(button=>button.textContent==='Files & history').click();smoke.settingsStore.set('theme','dark')",
  );
  await until("document.querySelectorAll('.setting-entry').length === 8");
  await pause(250);
  await fs.writeFile(
    path.join(temporary, "file-history-settings-en.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  win.setSize(980, 650);
  await js(
    "smoke.settingsStore.set('locale','zh-TW');smoke.settingsStore.set('theme','light');smoke.settingsStore.set('uiScale',125)",
  );
  await until("document.querySelector('#settings-page').textContent.includes('檔案與歷史')");
  assert.deepEqual(win.getSize(), [980, 650]);
  const [contentWidth, contentHeight] = win.getContentSize();
  await until(`innerWidth === ${contentWidth} && innerHeight === ${contentHeight}`);
  assert.equal(
    await js(
      "document.querySelector('.settings-content').scrollWidth <= document.querySelector('.settings-content').clientWidth",
    ),
    true,
  );
  await pause(250);
  await fs.writeFile(
    path.join(temporary, "file-history-settings-zh-TW.png"),
    (await win.webContents.capturePage()).toPNG(),
  );
  await js("searchFileSettings('');document.querySelector('.settings-categories button').click()");
  await closeSettings();
  await js(`ed.setValue(${JSON.stringify(originalContent)});ed.focus()`);
  await key("s", [mod]);
  await waitMain(
    () => fixture.files["main.bp"] === originalContent,
    "Preference test did not restore source",
  );
  await js(
    `for (const [key,value] of Object.entries(${JSON.stringify(originalSettings)})) smoke.settingsStore.set(key,value);ed.focus()`,
  );
  win.setSize(...originalSize);
  const findOverride = await js("smoke.keybindingsStore.getSnapshot().overrides['actions.find']");
  await js(
    `smoke.keybindingsStore.set('actions.find',[[${JSON.stringify(`${mod === "meta" ? "Meta" : "Ctrl"}+Alt+KeyF`)}]]);ed.focus()`,
  );
  await pause(100);
  await key("f", [mod, "alt"]);
  await until("Boolean(document.querySelector('.find-widget.visible'))");
  await key("Escape");
  await js(
    `ed.getContribution('editor.contrib.findController').closeFindWidget();smoke.keybindingsStore.set('actions.find',${JSON.stringify(findOverride) ?? "undefined"});ed.focus()`,
  );
  // File preferences have their own persisted store; restoring settingsStore alone
  // leaves review-only external changes and the short polling interval active in
  // later suites. Restore through the real controls so the renderer and host agree.
  await settings();
  for (const [field, value] of Object.entries(originalFilePreferences)) {
    if (fileHistory.preferences()[field] === value) continue;
    if (typeof value === "boolean") await toggle(field, value);
    else {
      await search(field);
      await js(`document.querySelector('#setting-${field}').click()`);
      await until(`Boolean(document.querySelector('[data-picker-value="${value}"]'))`);
      await js(`document.querySelector('[data-picker-value="${value}"]').click()`);
      await waitMain(() => fileHistory.preferences()[field] === value, `${field} was not restored`);
      await until(`!document.querySelector('#setting-${field}').disabled`);
    }
  }
  await closeSettings();
  assert.deepEqual(fileHistory.preferences(), originalFilePreferences);
  console.log(
    "PASS file/history preference search, reset, restart persistence, polling controls, save conflict protection, paused history and dynamic retention",
  );
}
