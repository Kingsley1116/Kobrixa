import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { checkInteractionPerformance } from "./interaction-performance-smoke.mjs";

export async function checkEditorPerformance(context) {
  const { js, until, pause, temporary, analysisCount } = context;
  const source =
    "' typing\nshared = 2\nFunction Double(in number value)\nReturn value * 2\nEndFunction\nanswer = Double(shared)\n" +
    "LCD.Clear()\n".repeat(30000);
  await js(`smoke.settingsStore.set('theme','dark');smoke.settingsStore.set('autoSave','off');ed.setValue(${JSON.stringify(source)});ed.setPosition({lineNumber:1,column:9});ed.focus();
    window.perfColor=(line,column)=>{
      const tokens=ed.getModel().tokenization.getLineTokens(line);
      const span=document.createElement('span');span.className=tokens.getClassName(tokens.findTokenIndexAtOffset(column-1));
      document.querySelector('.monaco-editor').append(span);const color=getComputedStyle(span).color;span.remove();return color;
    };void 0;`);
  await until('perfColor(6,10) === "rgb(220, 220, 170)"');
  await pause(250);
  assert((await js("smoke.metrics.appRenders")) > 0, "App render probe must be active");
  const beforeAnalysis = analysisCount();
  const metrics = await js(`(async()=>{
    const model=ed.getModel(), read=model.getValue, write=model.setValue;
    const metrics={appRenders:0,textReads:0,contentResets:0,highlightLosses:0,durations:[],frames:[],lines:model.getLineCount()};
    model.getValue=function(...args){metrics.textReads++;return read.apply(this,args)};
    model.setValue=function(...args){metrics.contentResets++;return write.apply(this,args)};
    smoke.metrics.appRenders=0;
    let shifted=0;
    ed.pushUndoStop();
    try {
      for(let i=0;i<60;i++){
        const started=performance.now();
        const text=i===20||i===40 ? "\\n' " : "x";
        if(text.includes("\\n"))shifted++;
        ed.trigger('performance-smoke','type',{text});
        metrics.durations.push(performance.now()-started);
        if(perfColor(6+shifted,10)!=="rgb(220, 220, 170)")metrics.highlightLosses++;
        await new Promise(resolve=>requestAnimationFrame(resolve));
        metrics.frames.push(performance.now()-started);
      }
      // Cursor movement must update only the status position, not App.
      for(let i=0;i<20;i++)ed.setPosition({lineNumber:4+shifted,column:2+i%5});
      await new Promise(resolve=>requestAnimationFrame(resolve));
      metrics.appRenders=smoke.metrics.appRenders;
      ed.pushUndoStop();
      return metrics;
    } finally {model.getValue=read;model.setValue=write;}
  })()`);
  assert.equal(metrics.appRenders, 0, "typing/cursor movement must not rerender App");
  assert.equal(metrics.textReads, 0, "typing must not extract the entire buffer per key");
  assert.equal(metrics.contentResets, 0, "typing must not reset content/undo");
  assert.equal(
    metrics.highlightLosses,
    0,
    "semantic ranges must track edits while analysis is pending",
  );
  assert.equal(analysisCount(), beforeAnalysis, "continuous typing must keep analysis debounced");
  const percentile = (values, p) =>
    [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
  const measured = {
    ...metrics,
    durations: undefined,
    frames: undefined,
    inputP95Ms: percentile(metrics.durations, 0.95),
    frameP95Ms: percentile(metrics.frames, 0.95),
    maxInputMs: Math.max(...metrics.durations),
  };
  fs.writeFileSync(
    path.join(temporary, "editor-performance.json"),
    JSON.stringify(measured, null, 2),
  );
  assert(measured.inputP95Ms < 50, `input p95 was ${measured.inputP95Ms} ms`);
  assert(measured.frameP95Ms < 100, `frame p95 was ${measured.frameP95Ms} ms`);
  await until('perfColor(8,10) === "rgb(220, 220, 170)"');
  await pause(2000);
  assert.equal(analysisCount(), beforeAnalysis + 1, "one settled analysis after typing");
  assert.equal(await js("perfColor(8,10)"), "rgb(220, 220, 170)");
  await js("ed.trigger('performance-smoke','undo',null)");
  assert.equal(await js("ed.getValue()"), source, "one undo restores the typed batch");
  console.log("large-document input performance", JSON.stringify(measured));
  await js("delete window.perfColor");
  await checkInteractionPerformance(context);
}
