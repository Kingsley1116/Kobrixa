import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function checkCompletionPerformance({ js, until, key, pause, temporary }) {
  const source =
    "sharedValue = 1\nFunction Work(in number parameterValue)\nlocalValue = parameterValue\n\nEndFunction\n";
  await js(`ed.updateOptions({wordBasedSuggestions:'off'});smoke.settingsStore.set('autoSave','off');
    window.completionApplied=smoke.metrics.completed.length;window.completionColdStart=performance.now();
    ed.setValue(${JSON.stringify(source)});ed.setPosition({lineNumber:4,column:1});ed.focus();

    window.waitForVariable=name=>new Promise((resolve,reject)=>{const start=performance.now();const poll=()=>{
      if([...document.querySelectorAll('.suggest-widget .monaco-list-row')].some(row=>row.getBoundingClientRect().height>0&&getComputedStyle(row).visibility!=='hidden'&&row.textContent.includes(name)))return resolve(performance.now());
      if(performance.now()-start>2000)return languageCommand('_executeCompletionItemProvider',ed.getPosition().lineNumber,ed.getPosition().column).then(r=>reject(new Error('Variable not displayed: '+name+' '+JSON.stringify({labels:r.suggestions.map(s=>s.label),completed:smoke.metrics.completed.slice(-3),now:performance.now(),widget:[...document.querySelectorAll('.suggest-widget .monaco-list-row')].map(r=>r.textContent),position:ed.getPosition(),quick:ed.getRawOptions().quickSuggestions,focus:ed.hasTextFocus()}))));requestAnimationFrame(poll)};poll()});void 0;`);
  await until("smoke.metrics.completed.length > completionApplied");
  const measurements = {
    coldMs: await js("smoke.metrics.completed.at(-1).time-completionColdStart"),
  };
  const warm = [];
  for (let i = 0; i < 11; i++) {
    await key("Escape");
    warm.push(
      await js(`(async()=>{
      ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(4,1,4,ed.getModel().getLineMaxColumn(4)),text:''}]);
      ed.setPosition({lineNumber:4,column:1});ed.focus();const started=performance.now();
      ed.trigger('keyboard','type',{text:'loc'});
      const shown=await waitForVariable('localValue');return shown-started;
    })()`),
    );
  }
  measurements.coldWidgetMs = warm.shift();
  measurements.warmP95Ms = warm.sort((a, b) => a - b)[9];
  assert(measurements.warmP95Ms <= 100, `warm variable p95 ${measurements.warmP95Ms} ms`);
  await key("Escape");
  measurements.newVariableMs = await js(`(async()=>{
    const started=performance.now();
    ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(4,1,4,ed.getModel().getLineMaxColumn(4)),text:'ZebraFresh = 3\\n'}]);
    ed.setPosition({lineNumber:5,column:1});ed.focus();ed.trigger('keyboard','type',{text:'ZebraF'});
    return (await waitForVariable('ZebraFresh'))-started;
  })()`);
  assert(measurements.newVariableMs <= 200, `new variable ${measurements.newVariableMs} ms`);

  // Keep an explicitly selected candidate when a fresh index refreshes the list.
  await key("Escape");
  await js(
    `ed.setPosition({lineNumber:5,column:1});ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(5,1,5,ed.getModel().getLineMaxColumn(5)),text:'lo'}]);ed.setPosition({lineNumber:5,column:3});ed.trigger('completion-smoke','editor.action.triggerSuggest',{});void 0;`,
  );
  await js("waitForVariable('localValue')");
  await js(`window.completionApplied=smoke.metrics.completed.length;window.selectedCompletion=ed.getContribution('editor.contrib.suggestController').widget.value.getFocusedItem()?.item.completion.label;
    ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(3,ed.getModel().getLineMaxColumn(3),3,ed.getModel().getLineMaxColumn(3)),text:' + 0'}]);void 0;`);
  await until("smoke.metrics.completed.length > completionApplied");
  assert.equal(
    await js(
      "ed.getContribution('editor.contrib.suggestController').widget.value.getFocusedItem()?.item.completion.label",
    ),
    await js("selectedCompletion"),
  );
  await js(
    `ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(5,1,5,3),text:'ZebraF'}]);void 0;`,
  );

  // Scope ranges move through edits; locals must not leak outside the function.
  await key("Escape");
  await js(
    `ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(1,1,1,1),text:"' 中文😀\\n\\n"}]);void 0;`,
  );
  const inside = await js(
    "languageCommand('_executeCompletionItemProvider',7,7).then(r=>r.suggestions.map(s=>s.label))",
  );
  assert(inside.includes("ZebraFresh"));
  const outside = await js(
    "languageCommand('_executeCompletionItemProvider',9,1).then(r=>r.suggestions.map(s=>s.label))",
  );
  assert(!outside.includes("ZebraFresh") && !outside.includes("parameterValue"));

  // Large buffer, with diagnostics running on its independent lane.
  const large = "knownValue = 1\n\n" + "LCD.Clear()\n".repeat(30000);
  await js(
    `window.completionApplied=smoke.metrics.completed.length;ed.setValue(${JSON.stringify(large)});ed.focus();void 0;`,
  );
  await until("smoke.metrics.completed.length > completionApplied");
  await pause(550);
  await key("Escape");
  measurements.largeNewVariableMs = await js(`(async()=>{
    const started=performance.now();ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(2,1,2,1),text:'ZebraLarge = 2\\n'}]);
    ed.setPosition({lineNumber:3,column:1});ed.focus();ed.trigger('keyboard','type',{text:'ZebraL'});
    return (await waitForVariable('ZebraLarge'))-started;
  })()`);
  assert(
    measurements.largeNewVariableMs <= 300,
    `large new variable ${measurements.largeNewVariableMs} ms`,
  );
  await key("Escape");
  // Escape must also cancel intent when the initial result list was empty.
  await js(
    `ed.executeEdits('completion-smoke',[{range:new smoke.monaco.Range(3,1,3,7),text:'AbsentNew = 1\\n'}]);ed.setPosition({lineNumber:4,column:1});ed.trigger('keyboard','type',{text:'AbsentN'});void 0;`,
  );
  await key("Escape");
  await pause(350);
  assert.equal(await js('Boolean(document.querySelector(".suggest-widget.visible"))'), false);
  fs.writeFileSync(
    path.join(temporary, "completion-performance.json"),
    JSON.stringify(measurements, null, 2),
  );
  console.log("variable completion performance", JSON.stringify(measurements));
}
