import assert from "node:assert/strict";

export async function checkIndentation({ js, key, until, win }) {
  await js(`smoke.settingsStore.set('autoSave','off');smoke.settingsStore.set('formatOnSave',false);
    smoke.keybindingsStore.reset();document.querySelector('[data-tree-path="main.bp"]').click()`);
  await until('ed.getModel().uri.path === "/main.bp"');
  await until(
    "smoke.monaco.editor.tokenize('If True Then','basic-plus')[0][0].type === 'keyword.control.basic-plus'",
  );
  await js(
    "ed.updateOptions({quickSuggestions:false,suggestOnTriggerCharacters:false});ed.focus()",
  );
  const reset = async (
    text,
    line = text.split("\n").length,
    column = text.split("\n")[line - 1].length + 1,
  ) => {
    await js(
      `ed.setValue(${JSON.stringify(text)});ed.setPosition({lineNumber:${line},column:${column}});ed.focus()`,
    );
    await until(`ed.getModel().tokenization.isCheapToTokenize(${line})`);
  };
  const type = async (text) => {
    await until("ed.getModel().tokenization.isCheapToTokenize(ed.getPosition().lineNumber)");
    await js(
      `(async()=>{for(const character of ${JSON.stringify(text)}){ed.trigger('keyboard','type',{text:character});await new Promise(requestAnimationFrame)}})()`,
    );
  };
  const enter = () => js("ed.trigger('keyboard','type',{text:'\\n'})");
  const expectText = async (text, line, column) => {
    const actual = await js("ed.getValue()");
    if (actual !== text)
      console.error(
        "indentation state",
        await js(
          "({language:ed.getModel().getLanguageId(),autoIndent:ed.getRawOptions().autoIndent,position:ed.getPosition(),tokens:smoke.monaco.editor.tokenize(ed.getValue(),'basic-plus')})",
        ),
      );
    assert.equal(actual, text);
    if (line !== undefined) {
      assert.deepEqual(
        await js("({line:ed.getPosition().lineNumber,column:ed.getPosition().column})"),
        { line, column },
      );
    }
  };

  for (const size of [2, 4]) {
    const spaces = " ".repeat(size);
    await js(
      `smoke.settingsStore.set('indentSize',${size});smoke.settingsStore.set('formatOnPaste',true)`,
    );
    await until(
      `ed.getModel().getOptions().indentSize === ${size} && ed.getRawOptions().formatOnPaste === true`,
    );
    for (const header of [
      "If True Then ' comment",
      "If True",
      "For i = 1 To 3",
      "While True",
      "Sub Clear()",
      "Function Value()",
      "Module Helpers",
    ]) {
      await reset(header);
      await enter();
      await expectText(`${header}\n${spaces}`, 2, size + 1);
    }

    const nested = `If True Then\n${spaces}While True\n${spaces.repeat(2)}LCD.Clear()\n${spaces.repeat(2)}`;
    await reset(nested);
    await js("ed.pushUndoStop()");
    await type("EndWhil");
    await js("ed.pushUndoStop()");
    await type("e");
    await expectText(nested.slice(0, -size) + "EndWhile", 4, size + 9);
    await js("ed.pushUndoStop();ed.trigger('indentation-smoke','undo',null)");
    await expectText(nested + "EndWhil", 4, size * 2 + 8);
    await js("ed.trigger('indentation-smoke','redo',null)");
    await expectText(nested.slice(0, -size) + "EndWhile", 4, size + 9);
    await enter();
    await type("ElseIf False Then ' branch");
    assert.equal(await js("ed.getModel().getLineContent(5)"), "ElseIf False Then ' branch");
    await enter();
    await type("Else ' fallback");
    assert.equal(await js("ed.getModel().getLineContent(6)"), "Else ' fallback");
    await enter();
    await type("EndIf");
    assert.equal(await js("ed.getModel().getLineContent(7)"), "EndIf");
    await enter();
    assert.equal(await js("ed.getPosition().column"), 1);

    // Accept a real keyword suggestion before typing its last characters.
    await reset(`If True\n${spaces}While True\n${spaces.repeat(2)}EndWh`);
    await js("ed.trigger('indentation-smoke','editor.action.triggerSuggest',{})");
    await until('document.querySelector(".suggest-widget")?.textContent.includes("EndWhile")');
    await key("Tab");
    await expectText(`If True\n${spaces}While True\n${spaces}EndWhile`, 3, size + 9);
    await js("ed.trigger('indentation-smoke','undo',null)");
    await expectText(`If True\n${spaces}While True\n${spaces.repeat(2)}EndWh`, 3, size * 2 + 6);
    await js("ed.trigger('indentation-smoke','redo',null)");
    await expectText(`If True\n${spaces}While True\n${spaces}EndWhile`, 3, size + 9);
    await key("Escape");

    // Native block indentation commands and smart Backspace retain their selections/caret.
    const selected = `If True\n${spaces}first = 1\n${spaces}second = 2\nEndIf`;
    await reset(selected);
    await js("ed.setSelection(new smoke.monaco.Selection(2,1,4,1))");
    await key("Tab");
    await expectText(`If True\n${spaces.repeat(2)}first = 1\n${spaces.repeat(2)}second = 2\nEndIf`);
    await key("Tab", ["shift"]);
    await expectText(selected);
    await reset(`If True\n${spaces.repeat(2)}`);
    await key("Backspace");
    await expectText(`If True\n${spaces}`, 2, size + 1);
    await key("Tab");
    await type("value = 1");
    await enter();
    assert.equal(await js("ed.getPosition().column"), size * 2 + 1);

    const beforePaste = `If True Then\n${spaces}\nEndIf\n      untouched = 1`;
    const paste = "While True ' paste\nLCD.Clear()\nEndWhile\n";
    await reset(beforePaste, 2, size + 1);
    await js(`ed.pushUndoStop();ed.trigger('keyboard','paste',{text:${JSON.stringify(paste)}})`);
    const pasted = `If True Then\n${spaces}While True ' paste\n${spaces.repeat(2)}LCD.Clear()\n${spaces}EndWhile\n\nEndIf\n      untouched = 1`;
    await until(`ed.getValue() === ${JSON.stringify(pasted)}`);
    await expectText(pasted, 5, 1);
    // Monaco keeps the automatic formatting and the paste as separate undo steps.
    await js("ed.pushUndoStop();ed.trigger('indentation-smoke','undo',null)");
    await expectText(`If True Then\n${spaces}${paste}\nEndIf\n      untouched = 1`, 5, 1);
    await js("ed.trigger('indentation-smoke','undo',null)");
    await expectText(beforePaste, 2, size + 1);
    await js("ed.trigger('indentation-smoke','redo',null)");
    await js("ed.trigger('indentation-smoke','redo',null)");
    await expectText(pasted, 5, 1);

    await reset('If True\ncaption = "prefix suffix"\nEndIf', 2, 19);
    await js("ed.trigger('keyboard','paste',{text:'pasted '})");
    await until(
      `ed.getModel().getLineContent(2) === ${JSON.stringify(spaces + 'caption = "prefix pasted suffix"')}`,
    );
    assert.equal(await js("ed.getPosition().column"), size + 26);

    const unformatted = "If True ' context\nWhile True\nLCD.Clear()\nEndWhile\n      EndIf";
    await reset(unformatted);
    await js(
      "ed.setSelection(new smoke.monaco.Selection(2,3,5,1));ed.getAction('editor.action.formatSelection').run()",
    );
    await expectText(
      `If True ' context\n${spaces}While True\n${spaces.repeat(2)}LCD.Clear()\n${spaces}EndWhile\n      EndIf`,
    );
  }

  // Format-on-paste off retains relative spacing instead of running our formatter.
  await js("smoke.settingsStore.set('formatOnPaste',false)");
  await until("ed.getRawOptions().formatOnPaste === false");
  await reset("If True\n    \nEndIf", 2, 5);
  await js("ed.trigger('keyboard','paste',{text:'While True\\nLCD.Clear()\\nEndWhile'})");
  const pastedLines = await js("[2,3,4].map(line=>ed.getModel().getLineContent(line))");
  assert.equal(pastedLines[1].match(/^ */)[0].length, pastedLines[2].match(/^ */)[0].length);

  // IME composition in a comment must not treat its contents as block keywords.
  await reset("If True\n    ' ");
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
  await expectText("If True\n    ' 中文", 2, 9);
  await type(" EndIf");
  await enter();
  await expectText("If True\n    ' 中文 EndIf\n    ", 3, 5);

  await js(
    "smoke.settingsStore.set('indentSize',2);smoke.settingsStore.set('formatOnPaste',true);ed.updateOptions({quickSuggestions:true,suggestOnTriggerCharacters:true})",
  );
  console.log(
    "real Monaco indentation, keyword completion, range formatting, paste, undo/redo and IME pass",
  );
}
