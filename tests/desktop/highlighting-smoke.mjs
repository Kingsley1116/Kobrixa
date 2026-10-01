import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

export async function checkHighlighting({ js, until, files, win, temporary }) {
  const original = await js("ed.getValue()");
  const theme = await js("smoke.settingsStore.getSnapshot().values.theme");
  files["math.bpm"] = "Function Double(in number value)\nReturn value * 2\nEndFunction\n";
  const sample = [
    'Import "math"',
    "shared = 2",
    "answer = math.Double(shared)",
    "Thread.Run = Blink",
    "Function Local(in number input)",
    "Return input + Time.Get1",
    "EndFunction",
    "Sub Blink()",
    "LCD.Clear()",
    "EndSub",
    "' comment",
    'caption = "中文😀"',
  ].join("\n");
  await js(`window.highlightColor=(line,column)=>{
    const tokens=ed.getModel().tokenization.getLineTokens(line);
    const span=document.createElement('span');
    span.className=tokens.getClassName(tokens.findTokenIndexAtOffset(column-1));
    document.querySelector('.monaco-editor').append(span);
    const color=getComputedStyle(span).color;span.remove();return color;
  };smoke.settingsStore.set('theme','dark');ed.setValue(${JSON.stringify(sample)});ed.setPosition({lineNumber:3,column:1});`);
  try {
    await until('highlightColor(3,10) === "rgb(78, 201, 176)"');
    assert.equal(await js("highlightColor(3,15)"), "rgb(220, 220, 170)");
    assert.equal(await js("highlightColor(4,14)"), "rgb(220, 220, 170)");
    assert.equal(await js("highlightColor(6,8)"), "rgb(156, 220, 254)");
    assert.equal(await js("highlightColor(6,1)"), "rgb(197, 134, 192)");
    assert.equal(await js("highlightColor(11,1)"), "rgb(106, 153, 85)");
    fs.writeFileSync(
      path.join(temporary, "highlighting-dark.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await js('smoke.settingsStore.set("theme","light")');
    await until('highlightColor(3,10) === "rgb(38, 127, 153)"');
    assert.equal(await js("highlightColor(3,15)"), "rgb(121, 94, 38)");
    assert.equal(await js("highlightColor(6,8)"), "rgb(0, 16, 128)");
    fs.writeFileSync(
      path.join(temporary, "highlighting-light.png"),
      (await win.webContents.capturePage()).toPNG(),
    );

    // Real Monarch, including recovery at the next line and case-insensitive keywords.
    const lexical = await js(
      `smoke.monaco.editor.tokenize('rEgIoN Demo\\nIf True And count != @value Then\\ntext = "say ""hello"""\\ntext = "unfinished""\\nEndRegion', 'basic-plus').map(line=>line.map(t=>t.type))`,
    );
    assert(lexical[0].includes("keyword.basic-plus"));
    for (const token of [
      "keyword.control.basic-plus",
      "constant.language.basic-plus",
      "operator.word.basic-plus",
      "operator.basic-plus",
    ])
      assert(lexical[1].includes(token), token);
    assert(lexical[2].includes("string.basic-plus"));
    assert(lexical[3].includes("string.invalid.basic-plus"));
    assert(lexical[4].includes("keyword.basic-plus"));
    const json = await js(
      `smoke.monaco.editor.tokenize('{"name":"value","enabled":true}', 'json').flat().map(t=>t.type)`,
    );
    assert(json.every((type) => !type.endsWith("basic-plus")));

    // Changing a dependency must remove obsolete function semantics in the active file.
    files["math.bpm"] = "Sub Other()\nEndSub\n";
    await js(
      `ed.executeEdits('highlight-smoke',[{range:new smoke.monaco.Range(1,1,1,1),text:"' edited\\n"}])`,
    );
    await until('highlightColor(4,15) !== "rgb(121, 94, 38)"');
    assert.equal(await js("ed.getPosition().lineNumber"), 4);
    await js("ed.trigger('highlight-smoke','undo',null)");
    assert.equal(await js("ed.getValue()"), sample);
    await js(`window.highlightTicks=0;window.highlightTimer=setInterval(()=>window.highlightTicks++,1);
      ed.setValue('LCD.Clear()\\n'.repeat(30000))`);
    await until('highlightColor(1,1) === "rgb(38, 127, 153)"');
    assert.equal(await js("ed.getModel().getLineCount()"), 30001);
    assert((await js("window.highlightTicks")) > 2);
    console.log(
      "project semantic tokens, theme colors, lexical recovery, undo and large documents pass",
    );
  } finally {
    delete files["math.bpm"];
    await js(
      `clearInterval(window.highlightTimer);delete window.highlightTimer;delete window.highlightTicks;ed.setValue(${JSON.stringify(original)});smoke.settingsStore.set('theme',${JSON.stringify(theme)});ed.focus();delete window.highlightColor`,
    );
  }
}
