import { checkCompletionPerformance } from "./completion-performance-smoke.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Exercise the whole edit -> IPC -> analysis -> UI cycle, beyond the typing loop. */
export async function checkInteractionPerformance({
  js,
  until,
  pause,
  temporary,
  syncMetrics,
  files,
  win,
  key,
}) {
  await checkCompletionPerformance({ js, until, key, pause, temporary });
  const measurements = {};
  await js(`ed.updateOptions({wordBasedSuggestions:'off'});smoke.settingsStore.set('autoSave','off');
    window.stageStart=performance.now();window.stageApplied=smoke.metrics.applied.length;
    ed.setValue('LCDValue = 1\\nLC');ed.setPosition({lineNumber:2,column:3});ed.focus();void 0;`);
  const immediate =
    await js(`(async()=>{const started=performance.now();const result=await languageCommand('_executeCompletionItemProvider',2,3);
    return {ms:performance.now()-started,labels:result.suggestions.map(s=>s.label)};})()`);
  assert(immediate.labels.includes("LCD.Clear"));
  assert(immediate.ms < 100, `built-in completion waited ${immediate.ms} ms`);
  measurements.builtinCompletionMs = immediate.ms;
  await js("ed.trigger('performance-smoke','editor.action.triggerSuggest',{})");
  await until('Boolean(document.querySelector(".suggest-widget.visible"))');
  try {
    await until(
      'document.querySelector(".suggest-widget.visible")?.textContent.includes("LCDValue")',
    );
  } catch (error) {
    console.error(
      "completion refresh state",
      await js(`({focus:ed.hasTextFocus(),position:ed.getPosition(),widget:document.querySelector('.suggest-widget.visible')?.textContent,
      inside:!!document.querySelector('.editor .suggest-widget.visible'),applied:smoke.metrics.applied.length})`),
      await js(
        `languageCommand('_executeCompletionItemProvider',2,3).then(r=>r.suggestions.map(s=>s.label))`,
      ),
    );
    throw error;
  }
  measurements.semanticCompletionMs = await js("performance.now()-stageStart");
  assert(measurements.semanticCompletionMs < 5000);
  await key("Escape");
  // A later analysis must not reopen a suggestion list dismissed by the user.
  await js(
    `window.stageApplied=smoke.metrics.applied.length;ed.executeEdits('performance-smoke',[{range:new smoke.monaco.Range(1,13,1,13),text:' '}]);ed.setPosition({lineNumber:2,column:3});ed.trigger('performance-smoke','editor.action.triggerSuggest',{});void 0;`,
  );
  await until('Boolean(document.querySelector(".suggest-widget.visible"))');
  await key("Escape");
  await until("smoke.metrics.applied.length > stageApplied");
  assert.equal(await js('Boolean(document.querySelector(".suggest-widget.visible"))'), false);

  // Count reads while accepting a result, then while querying hover repeatedly.
  const large = "value = 1\n" + "LCD.Clear()\n".repeat(30000);
  await js(
    `ed.setValue(${JSON.stringify(large)});ed.setPosition({lineNumber:1,column:6});window.stageApplied=smoke.metrics.applied.length;void 0`,
  );
  await until("smoke.metrics.applied.length > stageApplied");
  assert((await js("smoke.metrics.merged.length")) > 0, "merge timing probe must be active");
  const hover =
    await js(`(async()=>{const model=ed.getModel(),read=model.getValue;let reads=0;model.getValue=function(...args){reads++;return read.apply(this,args)};
    const durations=[];try{for(let i=0;i<20;i++){const start=performance.now();const result=await languageCommand('_executeHoverProvider',1,2);if(!result.length)throw new Error('No hover');durations.push(performance.now()-start)}return {reads,durations};}finally{model.getValue=read}})()`);
  assert.equal(hover.reads, 0, "hover must validate versions without reading the buffer");
  measurements.hoverP95Ms = hover.durations.sort((a, b) => a - b)[18];
  assert(measurements.hoverP95Ms < 50);

  // Isolate a comment-only edit: source text changes, token and symbol payloads do not.
  const syncStart = syncMetrics.length;
  await js(`window.stageApplied=smoke.metrics.applied.length;window.stageStart=performance.now();
    ed.executeEdits('performance-smoke',[{range:new smoke.monaco.Range(1,10,1,10),text:" ' comment"}]);void 0;`);
  await until("smoke.metrics.applied.length > stageApplied");
  measurements.editToAnalysisMs = await js("smoke.metrics.applied.at(-1).time-stageStart");
  const delta = syncMetrics.slice(syncStart).at(-1);
  assert(delta);
  assert.deepEqual(delta.sentFiles, ["main.bp"]);
  assert.deepEqual(delta.changedSources, ["main.bp"]);
  assert.deepEqual(delta.changedTokens, []);
  assert.equal(delta.reset, false);
  measurements.commentDelta = {
    requestBytes: delta.requestBytes,
    responseBytes: delta.responseBytes,
    workerAndIoMs: delta.ms,
  };
  assert(measurements.editToAnalysisMs < 5000);

  // Large paste, including token application and main-thread frame gaps.
  const paste = "LCD.Clear()\n".repeat(2000);
  await js(`window.stageApplied=smoke.metrics.applied.length;window.stageStart=performance.now();window.pasteFrames=[];window.lastFrame=performance.now();
    window.frameProbe=()=>{const now=performance.now();pasteFrames.push(now-lastFrame);lastFrame=now;window.frameId=requestAnimationFrame(frameProbe)};window.frameId=requestAnimationFrame(frameProbe);
    ed.setPosition({lineNumber:2,column:1});ed.pushUndoStop();const pasteStart=performance.now();ed.trigger('keyboard','paste',{text:${JSON.stringify(paste)}});window.pasteMs=performance.now()-pasteStart;ed.pushUndoStop();void 0;`);
  await until("smoke.metrics.applied.length > stageApplied");
  const pasteResult =
    await js(`({inputMs:pasteMs,completeMs:smoke.metrics.applied.at(-1).time-stageStart,frames:pasteFrames,
    applyMs:smoke.metrics.applied.at(-1).duration,mergeMs:smoke.metrics.merged.at(-1).duration})`);
  await js("cancelAnimationFrame(frameId)");
  measurements.paste = {
    inputMs: pasteResult.inputMs,
    completeMs: pasteResult.completeMs,
    applyMs: pasteResult.applyMs,
    mergeMs: pasteResult.mergeMs,
    maxFrameMs: Math.max(...pasteResult.frames),
  };
  console.log(
    "paste stage",
    JSON.stringify(measurements.paste),
    "reply",
    JSON.stringify(syncMetrics.at(-1)),
  );
  assert(pasteResult.inputMs < 250, `paste input took ${pasteResult.inputMs} ms`);
  assert(pasteResult.completeMs < 5000);
  assert(pasteResult.applyMs < 150, `token application took ${pasteResult.applyMs} ms`);
  assert(pasteResult.mergeMs < 100);
  assert(
    measurements.paste.maxFrameMs < 300,
    `paste frame stalled ${measurements.paste.maxFrameMs} ms`,
  );
  await js("ed.trigger('performance-smoke','undo',null)");
  assert.equal(await js("ed.getModel().getLineCount()"), 30002);

  // Chromium IME protocol exercises Monaco's real composition input handling.
  await js(
    `ed.setPosition({lineNumber:1,column:ed.getModel().getLineMaxColumn(1)});ed.focus();window.imeStart=performance.now();void 0;`,
  );
  win.webContents.debugger.attach("1.3");
  try {
    await win.webContents.debugger.sendCommand("Input.imeSetComposition", {
      text: "中",
      selectionStart: 1,
      selectionEnd: 1,
    });
    await win.webContents.debugger.sendCommand("Input.imeSetComposition", {
      text: "中文",
      selectionStart: 2,
      selectionEnd: 2,
    });
    await win.webContents.debugger.sendCommand("Input.insertText", { text: "中文" });
  } finally {
    win.webContents.debugger.detach();
  }
  await until('ed.getModel().getLineContent(1).endsWith("中文")');
  measurements.imeCommitMs = await js("performance.now()-imeStart");
  assert(measurements.imeCommitMs < 1000);

  // Input while a large buffer is being saved must preserve the latest text.
  await js(`smoke.settingsStore.set('autoSave','afterDelay');smoke.settingsStore.set('autoSaveDelay',500);window.saveStart=performance.now();
    ed.trigger('performance-smoke','type',{text:' first'});void 0;`);
  await pause(580);
  await js(
    `ed.trigger('performance-smoke','type',{text:' latest'});window.latestSaveStart=performance.now();void 0;`,
  );
  await until('!document.querySelector(".tab.active i[aria-label]")');
  assert.equal(files["main.bp"], await js("ed.getValue()"));
  assert(files["main.bp"].split("\n")[0].endsWith("中文 first latest"));
  measurements.latestEditToSaveMs = await js("performance.now()-latestSaveStart");
  assert(measurements.latestEditToSaveMs < 5000);
  await js(
    "smoke.settingsStore.set('autoSave','off');ed.updateOptions({wordBasedSuggestions:'matchingDocuments'})",
  );
  fs.writeFileSync(
    path.join(temporary, "interaction-performance.json"),
    JSON.stringify(measurements, null, 2),
  );
  console.log("full editor interaction performance", JSON.stringify(measurements));
}
