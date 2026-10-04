/** Operation descriptions for the pinned Monaco and IDE catalog, indexed by stable command ID. */
export const COMMAND_DESCRIPTIONS: Record<string, readonly [en: string, zh: string]> = {
  _lastCursorMoveToSelect: [
    "Extend the last cursor's selection to a supplied position; requires position arguments.",
    "將最後一個游標的選取範圍延伸至指定位置；需要位置參數。",
  ],
  _lineSelect: [
    "Select the entire line at the supplied position; normally used by pointer gestures.",
    "選取指定位置的整行文字；通常由滑鼠操作傳入位置。",
  ],
  _lineSelectDrag: [
    "Extend a whole-line selection to the supplied drag position; requires position arguments.",
    "依拖曳位置延伸整行選取範圍；需要位置參數。",
  ],
  _moveTo: [
    "Place the cursor at a supplied position; a key binding alone does not supply that position.",
    "將游標放到指定位置；單純綁定按鍵不會提供位置參數。",
  ],
  _moveToSelect: [
    "Extend the selection to a supplied position; requires position arguments.",
    "將選取範圍延伸至指定位置；需要位置參數。",
  ],
  _wordSelect: [
    "Select the word at a supplied position; normally used by pointer gestures.",
    "選取指定位置的單字；通常由滑鼠操作傳入位置。",
  ],
  _wordSelectDrag: [
    "Extend a word-based selection to a supplied drag position; requires position arguments.",
    "依拖曳位置，以單字為單位延伸選取範圍；需要位置參數。",
  ],
  acceptAlternativeSelectedSuggestion: [
    "Insert the highlighted completion using the alternative insert/replace mode.",
    "使用替代的插入／取代模式，套用目前反白的補全建議。",
  ],
  acceptRenameInput: [
    "Apply the name entered in the active symbol-rename dialog.",
    "套用目前符號重新命名對話框中輸入的新名稱。",
  ],
  acceptRenameInputWithPreview: [
    "Request a preview of the rename edits before applying them, when preview is supported.",
    "支援預覽時，先檢視符號重新命名將修改的內容，再決定是否套用。",
  ],
  acceptSelectedCodeAction: [
    "Apply the highlighted fix or refactoring in the open code-action menu.",
    "套用已開啟的程式碼動作選單中，目前反白的修正或重構。",
  ],
  acceptSelectedSuggestion: [
    "Insert the highlighted completion into the document; requires an active suggestion.",
    "將目前反白的補全建議插入文件；需要作用中的建議項目。",
  ],
  acceptSnippet: [
    "Finish the active snippet session by advancing through its remaining placeholders.",
    "前進至程式碼片段的結尾，完成目前的欄位填寫工作階段。",
  ],
  "actions.find": [
    "Open the search box to find text in the current document.",
    "開啟搜尋欄，在目前文件中尋找文字。",
  ],
  "actions.findWithSelection": [
    "Open search with the selected text as the search query.",
    "開啟搜尋欄，並以目前選取的文字作為搜尋內容。",
  ],
  cancelLinkedEditingInput: [
    "Stop linked editing so subsequent changes no longer update related ranges together.",
    "停止連動編輯，後續修改不再同步更新相關範圍。",
  ],
  cancelRenameInput: [
    "Close the symbol-rename input without applying the proposed name.",
    "關閉符號重新命名輸入欄，不套用新名稱。",
  ],
  cancelSelection: [
    "Collapse selections to their active ends without deleting text.",
    "將選取範圍收合至作用端點，不刪除文字。",
  ],
  closeFindWidget: [
    "Close the search and replace interface and return focus to the editor.",
    "關閉搜尋與取代介面，將焦點移回編輯器。",
  ],
  closeMarkersNavigation: [
    "Close the diagnostic message popup and keep editing at the current location.",
    "關閉診斷訊息視窗，繼續在目前位置編輯。",
  ],
  closeParameterHints: [
    "Dismiss the function signature and parameter hint popup.",
    "關閉函式定義與參數提示視窗。",
  ],
  closeReferenceSearch: [
    "Close the inline references preview and return to editing.",
    "關閉文件內的參考預覽，返回文字編輯。",
  ],
  "codelens.showLensesInCurrentLine": [
    "Show actions supplied by CodeLens for the current line, when available.",
    "有 CodeLens 提供者時，顯示目前行可執行的 CodeLens 動作。",
  ],
  columnSelect: [
    "Create a rectangular selection from supplied pointer positions; requires position arguments.",
    "依指定的滑鼠位置建立矩形選取範圍；需要位置參數。",
  ],
  createCursor: [
    "Add a cursor at a supplied position while keeping existing cursors; requires position arguments.",
    "保留既有游標，並在指定位置新增游標；需要位置參數。",
  ],
  cursorBottom: ["Move the cursor to the end of the document.", "將游標移至文件結尾。"],
  cursorBottomSelect: [
    "Extend the current selection to the end of the document.",
    "將目前選取範圍延伸至文件結尾。",
  ],
  cursorColumnSelectDown: [
    "Move the active corner of the rectangular selection down one line.",
    "將矩形選取範圍的作用端點向下移動一行。",
  ],
  cursorColumnSelectLeft: [
    "Move the active corner of the rectangular selection left one column.",
    "將矩形選取範圍的作用端點向左移動一欄。",
  ],
  cursorColumnSelectPageDown: [
    "Move the active corner of the rectangular selection down one screenful.",
    "將矩形選取範圍的作用端點向下移動一個畫面。",
  ],
  cursorColumnSelectPageUp: [
    "Move the active corner of the rectangular selection up one screenful.",
    "將矩形選取範圍的作用端點向上移動一個畫面。",
  ],
  cursorColumnSelectRight: [
    "Move the active corner of the rectangular selection right one column.",
    "將矩形選取範圍的作用端點向右移動一欄。",
  ],
  cursorColumnSelectUp: [
    "Move the active corner of the rectangular selection up one line.",
    "將矩形選取範圍的作用端點向上移動一行。",
  ],
  cursorDown: ["Move the cursor to the next display line.", "將游標移至下一個顯示行。"],
  cursorDownSelect: [
    "Extend the current selection to the next display line.",
    "將目前選取範圍延伸至下一個顯示行。",
  ],
  cursorEnd: ["Move the cursor to the end of the display line.", "將游標移至目前顯示行的行尾。"],
  cursorEndSelect: [
    "Extend the current selection to the end of the display line.",
    "將目前選取範圍延伸至目前顯示行的行尾。",
  ],
  cursorHome: [
    "Move the cursor to the first non-whitespace character or start of the display line.",
    "將游標移至目前顯示行的第一個非空白字元或行首。",
  ],
  cursorHomeSelect: [
    "Extend the current selection to the first non-whitespace character or start of the display line.",
    "將目前選取範圍延伸至目前顯示行的第一個非空白字元或行首。",
  ],
  cursorLeft: ["Move the cursor to the previous character.", "將游標移至左側相鄰字元。"],
  cursorLeftSelect: [
    "Extend the current selection to the previous character.",
    "將目前選取範圍延伸至左側相鄰字元。",
  ],
  cursorLineEnd: [
    "Move the cursor to the end of the logical line, ignoring visual wrapping.",
    "將游標移至實際行尾，不受畫面自動換行影響。",
  ],
  cursorLineEndSelect: [
    "Extend the current selection to the end of the logical line, ignoring visual wrapping.",
    "將目前選取範圍延伸至實際行尾，不受畫面自動換行影響。",
  ],
  cursorLineStart: [
    "Move the cursor to the start of the logical line, ignoring visual wrapping.",
    "將游標移至實際行首，不受畫面自動換行影響。",
  ],
  cursorLineStartSelect: [
    "Extend the current selection to the start of the logical line, ignoring visual wrapping.",
    "將目前選取範圍延伸至實際行首，不受畫面自動換行影響。",
  ],
  cursorMove: [
    "Move cursors using supplied direction, unit and selection options; requires command arguments.",
    "依指定的方向、單位與選取選項移動游標；需要命令參數。",
  ],
  cursorPageDown: [
    "Move the cursor to the position one screenful below.",
    "將游標移至下方一個畫面的位置。",
  ],
  cursorPageDownSelect: [
    "Extend the current selection to the position one screenful below.",
    "將目前選取範圍延伸至下方一個畫面的位置。",
  ],
  cursorPageUp: [
    "Move the cursor to the position one screenful above.",
    "將游標移至上方一個畫面的位置。",
  ],
  cursorPageUpSelect: [
    "Extend the current selection to the position one screenful above.",
    "將目前選取範圍延伸至上方一個畫面的位置。",
  ],
  cursorRedo: [
    "Reapply cursor positions and selections undone by cursor undo.",
    "重做先前透過游標復原所還原的位置與選取範圍。",
  ],
  cursorRight: ["Move the cursor to the next character.", "將游標移至右側相鄰字元。"],
  cursorRightSelect: [
    "Extend the current selection to the next character.",
    "將目前選取範圍延伸至右側相鄰字元。",
  ],
  cursorTop: ["Move the cursor to the start of the document.", "將游標移至文件開頭。"],
  cursorTopSelect: [
    "Extend the current selection to the start of the document.",
    "將目前選取範圍延伸至文件開頭。",
  ],
  cursorUndo: [
    "Restore the previous cursor positions and selections without undoing text edits.",
    "還原上一組游標位置與選取範圍，不復原文字修改。",
  ],
  cursorUp: ["Move the cursor to the previous display line.", "將游標移至上一個顯示行。"],
  cursorUpSelect: [
    "Extend the current selection to the previous display line.",
    "將目前選取範圍延伸至上一個顯示行。",
  ],
  cursorWordAccessibilityLeft: [
    "Move the cursor to the previous word boundary using screen-reader word rules.",
    "將游標移至左側單字邊界，採用螢幕閱讀器適用的分詞規則。",
  ],
  cursorWordAccessibilityLeftSelect: [
    "Extend the current selection to the previous word boundary using screen-reader word rules.",
    "將目前選取範圍延伸至左側單字邊界，採用螢幕閱讀器適用的分詞規則。",
  ],
  cursorWordAccessibilityRight: [
    "Move the cursor to the next word boundary using screen-reader word rules.",
    "將游標移至右側單字邊界，採用螢幕閱讀器適用的分詞規則。",
  ],
  cursorWordAccessibilityRightSelect: [
    "Extend the current selection to the next word boundary using screen-reader word rules.",
    "將目前選取範圍延伸至右側單字邊界，採用螢幕閱讀器適用的分詞規則。",
  ],
  cursorWordEndLeft: ["Move the cursor to the previous word end.", "將游標移至左側單字結尾。"],
  cursorWordEndLeftSelect: [
    "Extend the current selection to the previous word end.",
    "將目前選取範圍延伸至左側單字結尾。",
  ],
  cursorWordEndRight: ["Move the cursor to the next word end.", "將游標移至右側單字結尾。"],
  cursorWordEndRightSelect: [
    "Extend the current selection to the next word end.",
    "將目前選取範圍延伸至右側單字結尾。",
  ],
  cursorWordLeft: [
    "Move the cursor to the previous word start using fast word navigation.",
    "將游標移至左側單字開頭，使用快速單字導覽。",
  ],
  cursorWordLeftSelect: [
    "Extend the current selection to the previous word start using fast word navigation.",
    "將目前選取範圍延伸至左側單字開頭，使用快速單字導覽。",
  ],
  cursorWordPartLeft: [
    "Move the cursor to the previous word-part boundary, such as a camelCase segment.",
    "將游標移至左側單字片段邊界，例如駝峰命名中的片段。",
  ],
  cursorWordPartLeftSelect: [
    "Extend the current selection to the previous word-part boundary, such as a camelCase segment.",
    "將目前選取範圍延伸至左側單字片段邊界，例如駝峰命名中的片段。",
  ],
  cursorWordPartRight: [
    "Move the cursor to the next word-part boundary, such as a camelCase segment.",
    "將游標移至右側單字片段邊界，例如駝峰命名中的片段。",
  ],
  cursorWordPartRightSelect: [
    "Extend the current selection to the next word-part boundary, such as a camelCase segment.",
    "將目前選取範圍延伸至右側單字片段邊界，例如駝峰命名中的片段。",
  ],
  cursorWordRight: ["Move the cursor to the next word end.", "將游標移至右側單字結尾。"],
  cursorWordRightSelect: [
    "Extend the current selection to the next word end.",
    "將目前選取範圍延伸至右側單字結尾。",
  ],
  cursorWordStartLeft: ["Move the cursor to the previous word start.", "將游標移至左側單字開頭。"],
  cursorWordStartLeftSelect: [
    "Extend the current selection to the previous word start.",
    "將目前選取範圍延伸至左側單字開頭。",
  ],
  cursorWordStartRight: ["Move the cursor to the next word start.", "將游標移至右側單字開頭。"],
  cursorWordStartRightSelect: [
    "Extend the current selection to the next word start.",
    "將目前選取範圍延伸至右側單字開頭。",
  ],
  deleteAllLeft: [
    "Delete selected text, or delete from the cursor to the start of the line.",
    "刪除選取文字；未選取時，刪除從游標到行首的內容。",
  ],
  deleteAllRight: [
    "Delete selected text, or delete from the cursor to the end of the line.",
    "刪除選取文字；未選取時，刪除從游標到行尾的內容。",
  ],
  deleteInsideWord: [
    "Remove the word containing the cursor without first selecting it.",
    "刪除游標所在的單字，不必先選取整個單字。",
  ],
  deleteLeft: [
    "Delete selected text, or delete from the cursor to the previous character boundary.",
    "刪除選取文字；未選取時，刪除從游標到左側字元邊界的內容。",
  ],
  deleteRight: [
    "Delete selected text, or delete from the cursor to the next character boundary.",
    "刪除選取文字；未選取時，刪除從游標到右側字元邊界的內容。",
  ],
  deleteWordEndLeft: [
    "Delete selected text, or delete from the cursor to the previous word end.",
    "刪除選取文字；未選取時，刪除從游標到左側單字結尾的內容。",
  ],
  deleteWordEndRight: [
    "Delete selected text, or delete from the cursor to the next word end.",
    "刪除選取文字；未選取時，刪除從游標到右側單字結尾的內容。",
  ],
  deleteWordLeft: [
    "Delete selected text, or delete from the cursor to the previous word boundary, accounting for whitespace.",
    "刪除選取文字；未選取時，依單字與空白邊界向左刪除。",
  ],
  deleteWordPartLeft: [
    "Delete selected text, or delete from the cursor to the previous word-part boundary, such as a camelCase segment.",
    "刪除選取文字；未選取時，向左刪除一個單字片段，例如駝峰命名中的片段。",
  ],
  deleteWordPartRight: [
    "Delete selected text, or delete from the cursor to the next word-part boundary, such as a camelCase segment.",
    "刪除選取文字；未選取時，向右刪除一個單字片段，例如駝峰命名中的片段。",
  ],
  deleteWordRight: [
    "Delete selected text, or delete from the cursor to the next word boundary, accounting for whitespace.",
    "刪除選取文字；未選取時，依單字與空白邊界向右刪除。",
  ],
  deleteWordStartLeft: [
    "Delete selected text, or delete from the cursor to the previous word start.",
    "刪除選取文字；未選取時，刪除從游標到左側單字開頭的內容。",
  ],
  deleteWordStartRight: [
    "Delete selected text, or delete from the cursor to the next word start.",
    "刪除選取文字；未選取時，刪除從游標到右側單字開頭的內容。",
  ],
  "diffEditor.exitCompareMove": [
    "Leave the moved-block comparison mode in an active diff editor.",
    "離開差異編輯器中目前的移動區塊比較模式。",
  ],
  "editor.action.accessibleDiffViewer.next": [
    "Show the next changed block in the diff editor's accessible text viewer.",
    "在差異編輯器的無障礙文字檢視中，顯示下一個修改區塊。",
  ],
  "editor.action.accessibleDiffViewer.prev": [
    "Show the previous changed block in the diff editor's accessible text viewer.",
    "在差異編輯器的無障礙文字檢視中，顯示上一個修改區塊。",
  ],
  "editor.action.addCommentLine": [
    "Add the current language's line-comment marker to the current or selected lines.",
    "在目前行或選取的行前加入目前語言的行註解符號。",
  ],
  "editor.action.addCursorsToBottom": [
    "Add a cursor on each line from the current cursor down to the document's end.",
    "從目前游標到文件結尾，在下方每一行新增游標。",
  ],
  "editor.action.addCursorsToTop": [
    "Add a cursor on each line from the current cursor up to the document's start.",
    "從目前游標到文件開頭，在上方每一行新增游標。",
  ],
  "editor.action.addSelectionToNextFindMatch": [
    "Keep existing selections and add the next occurrence of the selected text.",
    "保留既有選取範圍，並加入下一個相同文字的位置。",
  ],
  "editor.action.addSelectionToPreviousFindMatch": [
    "Keep existing selections and add the previous occurrence of the selected text.",
    "保留既有選取範圍，並加入上一個相同文字的位置。",
  ],
  "editor.action.autoFix": [
    "Apply or offer the preferred quick fix for the current problem when one is available.",
    "有建議的快速修正時，套用或顯示目前問題的優先修正方式。",
  ],
  "editor.action.blockComment": [
    "Wrap selected text in block-comment markers, or remove those markers when already commented.",
    "將選取文字包在區塊註解符號中，或移除既有的區塊註解符號。",
  ],
  "editor.action.cancelSelectionAnchor": [
    "Clear the stored selection anchor without changing document text.",
    "清除已記住的選取錨點，不修改文件文字。",
  ],
  "editor.action.changeAll": [
    "Create selections for matching occurrences of the word at the cursor so they can be edited together.",
    "為游標所在單字的相同項目建立選取範圍，以便一併修改。",
  ],
  "editor.action.changeTabDisplaySize": [
    "Choose how many columns a tab character occupies in the current document.",
    "選擇目前文件中每個定位字元顯示時佔用的欄數。",
  ],
  "editor.action.clipboardCopyAction": [
    "Copy selected text to the clipboard; line copying follows editor settings when nothing is selected.",
    "將選取文字複製到剪貼簿；未選取文字時依編輯器設定處理整行複製。",
  ],
  "editor.action.clipboardCopyWithSyntaxHighlightingAction": [
    "Copy selected code with syntax colors for destinations that support rich text.",
    "複製選取程式碼並附帶語法色彩，供支援格式文字的目的地使用。",
  ],
  "editor.action.clipboardCutAction": [
    "Copy selected text to the clipboard and remove it; an empty selection may cut the current line.",
    "將選取文字複製到剪貼簿並移除；未選取文字時可能剪下目前整行。",
  ],
  "editor.action.clipboardPasteAction": [
    "Insert clipboard contents at the cursor or replace the selected text.",
    "在游標位置插入剪貼簿內容，或取代目前選取的文字。",
  ],
  "editor.action.codeAction": [
    "Request language-provided code actions at the selection, optionally filtered by command arguments.",
    "要求語言服務提供目前選取位置的程式碼動作，可透過命令參數篩選。",
  ],
  "editor.action.commentLine": [
    "Comment or uncomment the current or selected lines using the language's line-comment syntax.",
    "使用目前語言的行註解語法，將目前行或選取行加上或取消註解。",
  ],
  "editor.action.copyLinesDownAction": [
    "Duplicate the current or selected lines directly below them.",
    "將目前行或選取的行複製一份，插入其下方。",
  ],
  "editor.action.copyLinesUpAction": [
    "Duplicate the current or selected lines directly above them.",
    "將目前行或選取的行複製一份，插入其上方。",
  ],
  "editor.action.decreaseHoverVerbosityLevel": [
    "Request more concise documentation from a hover provider that supports verbosity levels.",
    "向支援詳細程度調整的懸停提示提供者，要求更精簡的說明。",
  ],
  "editor.action.deleteLines": [
    "Remove the entire current line or all lines touched by the selection.",
    "刪除目前整行，或刪除選取範圍涵蓋的所有行。",
  ],
  "editor.action.detectIndentation": [
    "Infer tab size and space/tab indentation from the current document's contents.",
    "從目前文件內容推測縮排寬度，以及使用空格或定位字元縮排。",
  ],
  "editor.action.duplicateSelection": [
    "Insert a copy of the selection, or duplicate the current line when no text is selected.",
    "插入一份選取文字的副本；未選取文字時複製目前行。",
  ],
  "editor.action.fixAll": [
    "Run available source actions that fix all supported problems in the document.",
    "執行可用的原始碼動作，修正文件中所有支援批次修正的問題。",
  ],
  "editor.action.focusNextCursor": [
    "Make the next cursor the active cursor while keeping the other cursors.",
    "將下一個游標設為作用游標，同時保留其他游標。",
  ],
  "editor.action.focusPreviousCursor": [
    "Make the previous cursor the active cursor while keeping the other cursors.",
    "將上一個游標設為作用游標，同時保留其他游標。",
  ],
  "editor.action.fontZoomIn": [
    "Increase the text size inside Monaco without changing the rest of the interface.",
    "放大 Monaco 編輯器內的文字，不調整其他介面大小。",
  ],
  "editor.action.fontZoomOut": [
    "Decrease the text size inside Monaco without changing the rest of the interface.",
    "縮小 Monaco 編輯器內的文字，不調整其他介面大小。",
  ],
  "editor.action.fontZoomReset": [
    "Reset Monaco's temporary font zoom to the configured editor text size.",
    "清除 Monaco 的暫時字級縮放，回到設定的編輯器字級。",
  ],
  "editor.action.forceRetokenize": [
    "Recompute syntax tokens for the current model to refresh syntax highlighting.",
    "重新計算目前文件的語法標記，以更新語法醒目提示。",
  ],
  "editor.action.formatSelection": [
    "Format the selected range when the current language provides a range formatter.",
    "在目前語言提供範圍格式器時，格式化選取範圍。",
  ],
  "editor.action.goToBottomHover": [
    "Scroll the focused hover's content to the bottom; requires an open hover.",
    "將目前聚焦的懸停提示內容捲動至底部；需要已開啟的懸停提示。",
  ],
  "editor.action.goToFocusedStickyScrollLine": [
    "Jump from the focused sticky header line to that line in the document.",
    "從目前聚焦的頂部固定行，跳至文件中對應的行。",
  ],
  "editor.action.goToImplementation": [
    "Navigate to implementations of the symbol at the cursor; requires an implementation provider.",
    "前往游標處符號的實作位置；需要實作查詢提供者。",
  ],
  "editor.action.goToMatchFindAction": [
    "Enter a result number to jump directly to that search match.",
    "輸入搜尋結果編號，直接前往指定的相符項目。",
  ],
  "editor.action.goToReferences": [
    "Find usages of the symbol at the cursor using the language's reference provider.",
    "透過語言服務的參考提供者，尋找游標處符號的使用位置。",
  ],
  "editor.action.goToSelectionAnchor": [
    "Return the cursor to the previously stored selection anchor.",
    "將游標移回先前記住的選取錨點。",
  ],
  "editor.action.goToTopHover": [
    "Scroll the focused hover's content to the top; requires an open hover.",
    "將目前聚焦的懸停提示內容捲動至頂端；需要已開啟的懸停提示。",
  ],
  "editor.action.gotoLine": [
    "Enter a line number and optional column to move directly within the document.",
    "輸入行號及選用的欄號，直接定位到文件中的位置。",
  ],
  "editor.action.hideColorPicker": [
    "Close the standalone color picker without applying a new color.",
    "關閉獨立色彩選擇器，不套用新色彩。",
  ],
  "editor.action.inPlaceReplace.down": [
    "Cycle the selected value to its next supported alternative, such as the next number or keyword.",
    "將選取值換成下一個支援的替代值，例如下一個數值或關鍵字。",
  ],
  "editor.action.inPlaceReplace.up": [
    "Cycle the selected value to its previous supported alternative, such as the previous number or keyword.",
    "將選取值換成上一個支援的替代值，例如上一個數值或關鍵字。",
  ],
  "editor.action.increaseHoverVerbosityLevel": [
    "Request more detailed documentation from a hover provider that supports verbosity levels.",
    "向支援詳細程度調整的懸停提示提供者，要求更完整的說明。",
  ],
  "editor.action.indentLines": [
    "Increase indentation on the current or selected lines by one level.",
    "將目前行或選取行的縮排增加一層。",
  ],
  "editor.action.indentUsingSpaces": [
    "Choose an indentation width and use spaces for new indentation in this document.",
    "選擇縮排寬度，並在目前文件的新縮排中使用空格。",
  ],
  "editor.action.indentUsingTabs": [
    "Choose an indentation width and use tab characters for new indentation in this document.",
    "選擇縮排寬度，並在目前文件的新縮排中使用定位字元。",
  ],
  "editor.action.indentationToSpaces": [
    "Rewrite existing leading indentation as spaces using the current tab size.",
    "依目前定位字元寬度，將既有行首縮排改寫為空格。",
  ],
  "editor.action.indentationToTabs": [
    "Rewrite existing leading indentation using tab characters where possible.",
    "將既有行首縮排在可轉換處改寫為定位字元。",
  ],
  "editor.action.inlineEdit.accept": [
    "Apply the currently displayed inline edit proposed by an available provider.",
    "套用目前顯示、由可用提供者提出的行內編輯建議。",
  ],
  "editor.action.inlineEdit.jumpBack": [
    "Return to the cursor location from before jumping to an inline edit proposal.",
    "將游標移回跳至行內編輯建議之前的位置。",
  ],
  "editor.action.inlineEdit.jumpTo": [
    "Move the cursor to the location of the displayed inline edit proposal.",
    "將游標移至目前顯示的行內編輯建議位置。",
  ],
  "editor.action.inlineEdit.reject": [
    "Dismiss the current inline edit proposal without applying it to the document.",
    "關閉目前的行內編輯建議，不將修改套用到文件。",
  ],
  "editor.action.inlineEdit.trigger": [
    "Request an inline edit proposal; requires a registered inline-edit provider.",
    "要求提供行內編輯建議；需要已註冊的行內編輯提供者。",
  ],
  "editor.action.inlineEdits.accept": [
    "Apply the currently displayed inline edit proposed by an available provider.",
    "套用目前顯示、由可用提供者提出的行內編輯建議。",
  ],
  "editor.action.inlineEdits.hide": [
    "Dismiss the current inline edit proposal without applying it to the document.",
    "關閉目前的行內編輯建議，不將修改套用到文件。",
  ],
  "editor.action.inlineEdits.showNext": [
    "Display the next inline edit proposal from the current provider results.",
    "顯示目前提供者結果中的下一個行內編輯建議。",
  ],
  "editor.action.inlineEdits.showPrevious": [
    "Display the previous inline edit proposal from the current provider results.",
    "顯示目前提供者結果中的上一個行內編輯建議。",
  ],
  "editor.action.inlineEdits.trigger": [
    "Request an inline edit proposal; requires a registered inline-edit provider.",
    "要求提供行內編輯建議；需要已註冊的行內編輯提供者。",
  ],
  "editor.action.inlineSuggest.acceptNextLine": [
    "Insert only the next line of the displayed inline suggestion, keeping the remainder available.",
    "只插入目前行內建議的下一行，保留其餘建議供後續接受。",
  ],
  "editor.action.inlineSuggest.acceptNextWord": [
    "Insert only the next word of the displayed inline suggestion, keeping the remainder available.",
    "只插入目前行內建議的下一個單字，保留其餘建議供後續接受。",
  ],
  "editor.action.inlineSuggest.commit": [
    "Insert the entire currently displayed inline text suggestion.",
    "插入目前顯示的整段行內文字建議。",
  ],
  "editor.action.inlineSuggest.hide": [
    "Dismiss the displayed inline text suggestion without inserting it.",
    "關閉目前顯示的行內文字建議，不插入內容。",
  ],
  "editor.action.inlineSuggest.showNext": [
    "Cycle to the next available inline completion without accepting it.",
    "切換至下一個可用的行內補全建議，不立即接受。",
  ],
  "editor.action.inlineSuggest.showPrevious": [
    "Cycle to the previous available inline completion without accepting it.",
    "切換至上一個可用的行內補全建議，不立即接受。",
  ],
  "editor.action.inlineSuggest.trigger": [
    "Request an inline text completion at the cursor; requires an inline-completion provider.",
    "要求游標位置的行內文字補全；需要行內補全提供者。",
  ],
  "editor.action.insertColorWithStandaloneColorPicker": [
    "Apply the color selected in the open standalone color picker to the document.",
    "將已開啟的獨立色彩選擇器中選取的色彩套用到文件。",
  ],
  "editor.action.insertCursorAbove": [
    "Add a cursor on the display line above so both positions can be edited together.",
    "在上方顯示行新增游標，以便同時編輯多個位置。",
  ],
  "editor.action.insertCursorAtEndOfEachLineSelected": [
    "Place a cursor at the end of each selected line for simultaneous editing.",
    "在選取範圍內每一行的行尾放置游標，以便同時編輯。",
  ],
  "editor.action.insertCursorBelow": [
    "Add a cursor on the display line below so both positions can be edited together.",
    "在下方顯示行新增游標，以便同時編輯多個位置。",
  ],
  "editor.action.insertLineAfter": [
    "Create a new line below the current line and place the cursor there.",
    "在目前行下方插入新行，並將游標移到新行。",
  ],
  "editor.action.insertLineBefore": [
    "Create a new line above the current line and place the cursor there.",
    "在目前行上方插入新行，並將游標移到新行。",
  ],
  "editor.action.inspectTokens": [
    "Show token and language information at the cursor for debugging syntax highlighting.",
    "顯示游標位置的語法標記與語言資訊，協助除錯語法醒目提示。",
  ],
  "editor.action.joinLines": [
    "Join selected lines, or join the current line with the next, removing intervening line breaks.",
    "合併選取的行；未選取時合併目前行與下一行，移除中間的換行。",
  ],
  "editor.action.jumpToBracket": [
    "Move between the opening and closing brackets surrounding the cursor.",
    "在游標附近的成對開括號與閉括號之間移動。",
  ],
  "editor.action.linkedEditing": [
    "Edit related ranges together, such as matching tags, when the language supplies linked ranges.",
    "語言服務提供連動範圍時，同步編輯相關文字，例如成對標籤。",
  ],
  "editor.action.marker.next": [
    "Move to the next diagnostic in the current file and show its message.",
    "前往目前檔案中的下一個診斷，並顯示診斷訊息。",
  ],
  "editor.action.marker.prev": [
    "Move to the previous diagnostic in the current file and show its message.",
    "前往目前檔案中的上一個診斷，並顯示診斷訊息。",
  ],
  "editor.action.moveCarretLeftAction": [
    "Shift the selected text one character to the left within its line.",
    "將選取文字在同一行內向左移動一個字元。",
  ],
  "editor.action.moveCarretRightAction": [
    "Shift the selected text one character to the right within its line.",
    "將選取文字在同一行內向右移動一個字元。",
  ],
  "editor.action.moveLinesDownAction": [
    "Move the current or selected lines below the following line.",
    "將目前行或選取的行向下移動一行。",
  ],
  "editor.action.moveLinesUpAction": [
    "Move the current or selected lines above the preceding line.",
    "將目前行或選取的行向上移動一行。",
  ],
  "editor.action.moveSelectionToNextFindMatch": [
    "Move only the most recently added selection to the next matching occurrence.",
    "只將最近加入的選取範圍移至下一個相同文字的位置。",
  ],
  "editor.action.moveSelectionToPreviousFindMatch": [
    "Move only the most recently added selection to the previous matching occurrence.",
    "只將最近加入的選取範圍移至上一個相同文字的位置。",
  ],
  "editor.action.nextMatchFindAction": [
    "Move the selection to the next result of the current search.",
    "將選取範圍移至目前搜尋的下一個相符項目。",
  ],
  "editor.action.nextSelectionMatchFindAction": [
    "Use the selected text to jump to its next occurrence.",
    "以選取文字為條件，跳至下一個相同文字的位置。",
  ],
  "editor.action.openLink": [
    "Open the detected link at the cursor; requires link detection and host support.",
    "開啟游標處偵測到的連結；需要連結偵測與宿主介面支援。",
  ],
  "editor.action.organizeImports": [
    "Organize import statements using the language's source-action provider.",
    "透過目前語言的原始碼動作提供者，整理匯入陳述式。",
  ],
  "editor.action.outdentLines": [
    "Decrease indentation on the current or selected lines by one level.",
    "將目前行或選取行的縮排減少一層。",
  ],
  "editor.action.pageDownHover": [
    "Scroll the focused hover's content down one page; requires an open hover.",
    "將目前聚焦的懸停提示內容向下捲動一頁；需要已開啟的懸停提示。",
  ],
  "editor.action.pageUpHover": [
    "Scroll the focused hover's content up one page; requires an open hover.",
    "將目前聚焦的懸停提示內容向上捲動一頁；需要已開啟的懸停提示。",
  ],
  "editor.action.pasteAs": [
    "Choose an available paste transformation; requires a matching paste provider.",
    "選擇可用的貼上轉換方式；需要對應的貼上提供者。",
  ],
  "editor.action.pasteAsText": [
    "Paste clipboard contents as plain text without a specialized paste transformation.",
    "以純文字貼上剪貼簿內容，不使用特殊貼上轉換。",
  ],
  "editor.action.peekDefinition": [
    "Open an inline preview of the symbol's definition when supported by the language.",
    "目前語言支援時，在文件內開啟符號定義的預覽視窗。",
  ],
  "editor.action.peekImplementation": [
    "Preview implementations in an inline panel when supported by the language.",
    "目前語言支援時，在文件內的面板預覽符號實作。",
  ],
  "editor.action.previousMatchFindAction": [
    "Move the selection to the previous result of the current search.",
    "將選取範圍移至目前搜尋的上一個相符項目。",
  ],
  "editor.action.previousSelectionMatchFindAction": [
    "Use the selected text to jump to its previous occurrence.",
    "以選取文字為條件，跳至上一個相同文字的位置。",
  ],
  "editor.action.quickCommand": [
    "Open Monaco's command palette to search and run editor actions.",
    "開啟 Monaco 命令選單，搜尋並執行編輯器操作。",
  ],
  "editor.action.quickFix": [
    "Show fixes available for the problem at the cursor; requires a code-action provider.",
    "顯示游標位置問題的可用修正；需要程式碼動作提供者。",
  ],
  "editor.action.quickOutline": [
    "Search symbols in the current file and jump to a result; requires language support.",
    "搜尋目前檔案的符號並跳至結果；需要語言服務支援。",
  ],
  "editor.action.refactor": [
    "Choose a refactoring for the selected code when supported by the language.",
    "目前語言支援時，為選取程式碼選擇重構方式。",
  ],
  "editor.action.reindentlines": [
    "Recalculate indentation throughout the document using the language's indentation rules.",
    "依目前語言的縮排規則，重新計算整份文件的縮排。",
  ],
  "editor.action.reindentselectedlines": [
    "Recalculate indentation only for the selected lines using the language's rules.",
    "依目前語言的規則，重新計算選取行的縮排。",
  ],
  "editor.action.removeBrackets": [
    "Remove the matching bracket pair around the cursor while keeping the enclosed text.",
    "移除游標附近的成對括號，保留括號內的文字。",
  ],
  "editor.action.removeCommentLine": [
    "Remove line-comment markers from the current or selected lines.",
    "移除目前行或選取行的行註解符號。",
  ],
  "editor.action.removeDuplicateLines": [
    "Remove repeated lines from the selection, or the whole document when nothing is selected.",
    "移除選取範圍中的重複行；未選取時處理整份文件。",
  ],
  "editor.action.rename": [
    "Request a new name for the symbol at the cursor and update supported references; requires a rename provider.",
    "為游標處的符號輸入新名稱，並更新支援的參考位置；需要重新命名提供者。",
  ],
  "editor.action.replaceAll": [
    "Replace every match of the current search within its active search scope.",
    "在目前搜尋範圍內，取代所有符合搜尋條件的文字。",
  ],
  "editor.action.replaceOne": [
    "Replace the current search match and move on through the results.",
    "取代目前的搜尋結果，並繼續導覽相符項目。",
  ],
  "editor.action.resetSuggestSize": [
    "Restore the completion popup to its default size after resizing it.",
    "將調整過大小的補全清單視窗還原為預設尺寸。",
  ],
  "editor.action.revealDefinition": [
    "Navigate to the definition of the symbol at the cursor when a definition provider is available.",
    "有定義提供者時，前往游標處符號的定義位置。",
  ],
  "editor.action.revealDefinitionAside": [
    "Request the symbol's definition in a side editor; requires language and host support.",
    "要求在側邊編輯器開啟符號定義；需要語言服務與宿主介面支援。",
  ],
  "editor.action.scrollDownHover": [
    "Scroll the focused hover's content down; requires an open hover.",
    "將目前聚焦的懸停提示內容向下捲動；需要已開啟的懸停提示。",
  ],
  "editor.action.scrollLeftHover": [
    "Scroll the focused hover's content left; requires an open hover.",
    "將目前聚焦的懸停提示內容向左捲動；需要已開啟的懸停提示。",
  ],
  "editor.action.scrollRightHover": [
    "Scroll the focused hover's content right; requires an open hover.",
    "將目前聚焦的懸停提示內容向右捲動；需要已開啟的懸停提示。",
  ],
  "editor.action.scrollUpHover": [
    "Scroll the focused hover's content up; requires an open hover.",
    "將目前聚焦的懸停提示內容向上捲動；需要已開啟的懸停提示。",
  ],
  "editor.action.selectAll": [
    "Select all text in the current editor document.",
    "選取目前編輯器文件的全部文字。",
  ],
  "editor.action.selectAllMatches": [
    "Create a selection for every match of the current search query.",
    "為目前搜尋條件的每個相符項目建立選取範圍。",
  ],
  "editor.action.selectEditor": [
    "Move keyboard focus back into the editor's text area.",
    "將鍵盤焦點移回編輯器的文字區域。",
  ],
  "editor.action.selectFromAnchorToCursor": [
    "Select the text between the stored anchor and the current cursor.",
    "選取已記住的錨點與目前游標之間的文字。",
  ],
  "editor.action.selectHighlights": [
    "Select every occurrence of the selected text or current word for simultaneous editing.",
    "選取目前選取文字或單字的所有相同項目，以便同時編輯。",
  ],
  "editor.action.selectNextStickyScrollLine": [
    "Move focus to the next pinned scope line in the editor's sticky header.",
    "將焦點移至編輯器頂部固定區域中的下一個範圍行。",
  ],
  "editor.action.selectPreviousStickyScrollLine": [
    "Move focus to the previous pinned scope line in the editor's sticky header.",
    "將焦點移至編輯器頂部固定區域中的上一個範圍行。",
  ],
  "editor.action.selectToBracket": [
    "Select text up to the matching bracket around the cursor.",
    "選取游標附近至配對括號之間的文字。",
  ],
  "editor.action.setSelectionAnchor": [
    "Remember the current cursor position as the start of a later selection.",
    "記住目前游標位置，作為稍後選取文字的起點。",
  ],
  "editor.action.showContextMenu": [
    "Open the editor's context menu at the current cursor position.",
    "在目前游標位置開啟編輯器快顯選單。",
  ],
  "editor.action.showDefinitionPreviewHover": [
    "Show a hover preview of the definition at the cursor when supported by the language.",
    "目前語言支援時，以懸停提示預覽游標處的符號定義。",
  ],
  "editor.action.showHover": [
    "Show or focus documentation and diagnostics at the cursor when hover content is available.",
    "有懸停內容時，顯示或聚焦游標處的說明文件與診斷提示。",
  ],
  "editor.action.smartSelect.expand": [
    "Grow the selection to a larger surrounding syntax range, such as an expression or block.",
    "將選取範圍擴大至外層語法區域，例如運算式或程式區塊。",
  ],
  "editor.action.smartSelect.shrink": [
    "Return to the smaller range used before the last smart-selection expansion.",
    "將智慧選取範圍縮回前一次擴大之前的區域。",
  ],
  "editor.action.sortLinesAscending": [
    "Sort selected lines, or the whole document, in ascending text order.",
    "將選取的行或整份文件依文字遞增順序排列。",
  ],
  "editor.action.sortLinesDescending": [
    "Sort selected lines, or the whole document, in descending text order.",
    "將選取的行或整份文件依文字遞減順序排列。",
  ],
  "editor.action.sourceAction": [
    "Show language-provided actions that operate on the document as a whole.",
    "顯示語言服務提供、作用於整份文件的原始碼動作。",
  ],
  "editor.action.startFindReplaceAction": [
    "Open search with the replacement field visible to change matching text.",
    "開啟搜尋與取代欄位，以其他文字取代相符內容。",
  ],
  "editor.action.toggleHighContrast": [
    "Switch Monaco between its regular and high-contrast editor themes.",
    "在 Monaco 的一般編輯器主題與高對比主題之間切換。",
  ],
  "editor.action.toggleTabFocusMode": [
    "Switch whether Tab moves focus between controls or edits indentation in the editor.",
    "切換 Tab 鍵用來移動控制項焦點，或在編輯器中輸入縮排。",
  ],
  "editor.action.transformToCamelcase": [
    "Convert selected text, or the current word, to camel case, for example helloWorld.",
    "將選取文字或目前單字轉換為小駝峰命名，例如 helloWorld。",
  ],
  "editor.action.transformToKebabcase": [
    "Convert selected text, or the current word, to kebab case, for example hello-world.",
    "將選取文字或目前單字轉換為連字號命名，例如 hello-world。",
  ],
  "editor.action.transformToLowercase": [
    "Convert selected text, or the current word, to lowercase, for example hello world.",
    "將選取文字或目前單字轉換為小寫，例如 hello world。",
  ],
  "editor.action.transformToPascalcase": [
    "Convert selected text, or the current word, to Pascal case, for example HelloWorld.",
    "將選取文字或目前單字轉換為大駝峰命名，例如 HelloWorld。",
  ],
  "editor.action.transformToSnakecase": [
    "Convert selected text, or the current word, to snake case, for example hello_world.",
    "將選取文字或目前單字轉換為底線命名，例如 hello_world。",
  ],
  "editor.action.transformToTitlecase": [
    "Convert selected text, or the current word, to title case, for example Hello World.",
    "將選取文字或目前單字轉換為每字字首大寫，例如 Hello World。",
  ],
  "editor.action.transformToUppercase": [
    "Convert selected text, or the current word, to uppercase, for example HELLO WORLD.",
    "將選取文字或目前單字轉換為大寫，例如 HELLO WORLD。",
  ],
  "editor.action.transpose": [
    "Swap adjacent characters around each empty cursor; at a line end this can move a character across the line break.",
    "交換每個未選取文字的游標兩側字元；在行尾時可能將字元移過換行。",
  ],
  "editor.action.transposeLetters": [
    "Swap the letters around the cursor, using the last two letters when at the end of a line.",
    "交換游標附近的字母；位於行尾時交換最後兩個字母。",
  ],
  "editor.action.triggerParameterHints": [
    "Show function signatures and the active argument at the cursor when supported by the language.",
    "語言服務支援時，顯示游標處函式的參數定義及目前引數。",
  ],
  "editor.action.triggerSuggest": [
    "Request completion suggestions at the cursor from available language providers.",
    "向可用的語言提供者要求游標位置的補全建議。",
  ],
  "editor.action.trimTrailingWhitespace": [
    "Remove spaces and tabs at the ends of lines in the document.",
    "移除文件中各行末端多餘的空格與定位字元。",
  ],
  "editor.action.unicodeHighlight.disableHighlightingOfAmbiguousCharacters": [
    "Stop highlighting Unicode characters that can be confused with other characters.",
    "停止醒目提示容易與其他字元混淆的 Unicode 字元。",
  ],
  "editor.action.unicodeHighlight.disableHighlightingOfInvisibleCharacters": [
    "Stop highlighting invisible Unicode characters in the editor.",
    "停止醒目提示編輯器中的不可見 Unicode 字元。",
  ],
  "editor.action.unicodeHighlight.disableHighlightingOfNonBasicAsciiCharacters": [
    "Stop highlighting characters outside the basic ASCII character set.",
    "停止醒目提示基本 ASCII 字元集以外的字元。",
  ],
  "editor.action.unicodeHighlight.showExcludeOptions": [
    "Show exclusion choices for a highlighted Unicode character; requires character/context arguments.",
    "顯示指定 Unicode 字元的醒目提示排除選項；需要字元與情境參數。",
  ],
  "editor.action.wordHighlight.next": [
    "Move the cursor to the next highlighted occurrence of the current symbol.",
    "將游標移至目前符號的下一個醒目提示位置。",
  ],
  "editor.action.wordHighlight.prev": [
    "Move the cursor to the previous highlighted occurrence of the current symbol.",
    "將游標移至目前符號的上一個醒目提示位置。",
  ],
  "editor.action.wordHighlight.trigger": [
    "Highlight references to the symbol at the cursor when supported by the language.",
    "目前語言支援時，醒目顯示游標處符號的參考位置。",
  ],
  "editor.actions.findWithArgs": [
    "Start a search using supplied query and search options; requires command arguments.",
    "依指定的搜尋文字與選項開始搜尋；需要命令參數。",
  ],
  "editor.cancelOperation": [
    "Cancel an editor operation that registered a cancellation handler.",
    "取消目前有註冊取消處理程序的編輯器操作。",
  ],
  "editor.changeDropType": [
    "Choose another available interpretation of the most recent drop.",
    "為最近一次拖放操作，選擇其他可用的處理方式。",
  ],
  "editor.changePasteType": [
    "Choose another available interpretation of the most recent paste.",
    "為最近一次貼上操作，選擇其他可用的處理方式。",
  ],
  "editor.createFoldingRangeFromSelection": [
    "Create and collapse a manual folding region from the selected lines.",
    "依選取的行建立手動摺疊區域，並將該區域摺疊。",
  ],
  "editor.fold": [
    "Collapse the foldable region at the cursor, hiding its inner lines.",
    "摺疊游標所在的可摺疊區域，隱藏其內部行。",
  ],
  "editor.foldAll": [
    "Collapse every available folding region in the document.",
    "摺疊文件中所有可摺疊區域。",
  ],
  "editor.foldAllBlockComments": [
    "Collapse multi-line comment regions recognized by the current language.",
    "摺疊目前語言識別出的多行註解區域。",
  ],
  "editor.foldAllExcept": [
    "Collapse folding regions outside the selected regions, keeping selected regions in their current state.",
    "摺疊選取區域以外的其他區域，保留選取區域原有的摺疊狀態。",
  ],
  "editor.foldAllMarkerRegions": [
    "Collapse regions defined by the current language's folding markers.",
    "摺疊目前語言以區域標記定義的摺疊區域。",
  ],
  "editor.foldLevel1": [
    "Collapse folding regions at nesting level 1, keeping regions containing the cursor open.",
    "摺疊第 1 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldLevel2": [
    "Collapse folding regions at nesting level 2, keeping regions containing the cursor open.",
    "摺疊第 2 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldLevel3": [
    "Collapse folding regions at nesting level 3, keeping regions containing the cursor open.",
    "摺疊第 3 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldLevel4": [
    "Collapse folding regions at nesting level 4, keeping regions containing the cursor open.",
    "摺疊第 4 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldLevel5": [
    "Collapse folding regions at nesting level 5, keeping regions containing the cursor open.",
    "摺疊第 5 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldLevel6": [
    "Collapse folding regions at nesting level 6, keeping regions containing the cursor open.",
    "摺疊第 6 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldLevel7": [
    "Collapse folding regions at nesting level 7, keeping regions containing the cursor open.",
    "摺疊第 7 層的區域，保留包含游標的區域展開。",
  ],
  "editor.foldRecursively": [
    "Collapse the region at the cursor and all of its nested folding regions.",
    "摺疊游標所在區域及其內部所有巢狀摺疊區域。",
  ],
  "editor.gotoNextFold": [
    "Move the cursor to the start of the next folding region.",
    "將游標移至下一個摺疊區域的起始行。",
  ],
  "editor.gotoNextSymbolFromResult": [
    "Continue to the next symbol location from the last symbol navigation results.",
    "沿用最近一次符號查詢結果，前往下一個符號位置。",
  ],
  "editor.gotoNextSymbolFromResult.cancel": [
    "End navigation through the last symbol query's results.",
    "結束最近一次符號查詢結果的連續導覽。",
  ],
  "editor.gotoParentFold": [
    "Move the cursor to the start of the enclosing folding region.",
    "將游標移至包住目前區域的上層摺疊起始行。",
  ],
  "editor.gotoPreviousFold": [
    "Move the cursor to the start of the previous folding region.",
    "將游標移至上一個摺疊區域的起始行。",
  ],
  "editor.hideDropWidget": [
    "Dismiss the options shown after dropping content without undoing the drop.",
    "關閉拖放後顯示的選項，不復原已放入的內容。",
  ],
  "editor.hidePasteWidget": [
    "Dismiss the options shown after pasting without undoing the pasted text.",
    "關閉貼上後顯示的選項，不復原已貼上的文字。",
  ],
  "editor.removeManualFoldingRanges": [
    "Remove manually created folding ranges that intersect the selected lines.",
    "移除與選取行重疊的手動摺疊區域。",
  ],
  "editor.toggleFold": [
    "Switch the region at the cursor between collapsed and expanded.",
    "切換游標所在區域的摺疊或展開狀態。",
  ],
  "editor.toggleFoldRecursively": [
    "Toggle the region at the cursor and its nested regions together.",
    "一併切換游標所在區域及其內部巢狀區域的摺疊狀態。",
  ],
  "editor.unfold": [
    "Expand the collapsed region at the cursor to show its hidden lines.",
    "展開游標所在的摺疊區域，顯示被隱藏的行。",
  ],
  "editor.unfoldAll": [
    "Expand all collapsed regions so the entire document is visible.",
    "展開所有摺疊區域，讓整份文件內容可見。",
  ],
  "editor.unfoldAllExcept": [
    "Expand folding regions outside the selected regions.",
    "展開選取區域以外的其他摺疊區域。",
  ],
  "editor.unfoldAllMarkerRegions": [
    "Expand regions defined by the current language's folding markers.",
    "展開目前語言以區域標記定義的摺疊區域。",
  ],
  "editor.unfoldRecursively": [
    "Expand the region at the cursor and all of its nested folding regions.",
    "展開游標所在區域及其內部所有巢狀摺疊區域。",
  ],
  editorScroll: [
    "Scroll using supplied direction, unit and amount options; requires command arguments.",
    "依指定的方向、單位與數量捲動畫面；需要命令參數。",
  ],
  expandLineSelection: [
    "Select the current line, then extend the selection by additional whole lines.",
    "選取目前整行；再次執行時繼續以整行為單位擴大選取範圍。",
  ],
  focusAndAcceptSuggestion: [
    "Focus the completion list, then insert its selected suggestion.",
    "聚焦補全清單，再插入選取的建議內容。",
  ],
  focusNextRenameSuggestion: [
    "Move to the next proposed symbol name in the rename suggestions list, when available.",
    "有重新命名建議時，將焦點移至清單中的下一個符號名稱。",
  ],
  focusPreviousRenameSuggestion: [
    "Move to the previous proposed symbol name in the rename suggestions list, when available.",
    "有重新命名建議時，將焦點移至清單中的上一個符號名稱。",
  ],
  focusSuggestion: [
    "Move focus from typing into the completion list so its entries can be chosen.",
    "將焦點從文字輸入移至補全清單，以便選擇建議項目。",
  ],
  goToNextReference: [
    "Navigate to the next result in the open references preview.",
    "在已開啟的參考預覽中，前往下一個搜尋結果。",
  ],
  goToPreviousReference: [
    "Navigate to the previous result in the open references preview.",
    "在已開啟的參考預覽中，前往上一個搜尋結果。",
  ],
  hideCodeActionWidget: [
    "Close the code-action menu without applying a fix or refactoring.",
    "關閉程式碼動作選單，不套用修正或重構。",
  ],
  hideSuggestWidget: [
    "Close the completion list without inserting a suggestion.",
    "關閉補全清單，不插入建議內容。",
  ],
  "history.showNext": [
    "Replace the focused history-enabled input with its next history entry.",
    "在支援歷史紀錄且已聚焦的輸入欄中，帶入下一筆紀錄。",
  ],
  "history.showPrevious": [
    "Replace the focused history-enabled input with its previous history entry.",
    "在支援歷史紀錄且已聚焦的輸入欄中，帶入上一筆紀錄。",
  ],
  insertBestCompletion: [
    "Insert the best available completion at the cursor when tab completion is enabled.",
    "啟用 Tab 補全時，在游標位置插入最適合的補全項目。",
  ],
  insertNextSuggestion: [
    "Replace the inserted completion with the next available suggestion in the completion session.",
    "在目前補全工作階段中，將已插入的補全內容換成下一個建議。",
  ],
  insertPrevSuggestion: [
    "Replace the inserted completion with the previous available suggestion in the completion session.",
    "在目前補全工作階段中，將已插入的補全內容換成上一個建議。",
  ],
  jumpToNextSnippetPlaceholder: [
    "Move to the next editable placeholder in the active code snippet.",
    "移至目前程式碼片段中的下一個可編輯欄位。",
  ],
  jumpToPrevSnippetPlaceholder: [
    "Move to the previous editable placeholder in the active code snippet.",
    "移至目前程式碼片段中的上一個可編輯欄位。",
  ],
  "kobrixa.build": [
    "Save pending project changes, then compile the project and show diagnostics.",
    "先保存專案中尚未儲存的修改，再編譯專案並顯示診斷結果。",
  ],
  "kobrixa.closeTab": [
    "Close the active file or settings tab; ask how to handle unsaved file changes.",
    "關閉目前的檔案或設定分頁；檔案有未儲存修改時會詢問處理方式。",
  ],
  "kobrixa.device": [
    "Show or hide the EV3 tools panel for connections, remote files and activity.",
    "顯示或隱藏 EV3 工具面板，查看連線、遠端檔案與活動紀錄。",
  ],
  "kobrixa.files": [
    "Show or hide the project file tree beside the editor.",
    "顯示或隱藏編輯器旁的專案檔案樹。",
  ],
  "kobrixa.format": [
    "Format the active Basic Plus or JSON document using the configured indentation; the edit can be undone.",
    "依縮排設定格式化目前的 Basic Plus 或 JSON 文件；可使用復原還原修改。",
  ],
  "kobrixa.newProject": [
    "Open the new-project dialog to name a project and choose where to create it.",
    "開啟新增專案對話框，輸入名稱並選擇建立位置。",
  ],
  "kobrixa.nextProblem": [
    "Move to the next diagnostic and open its file at the reported position.",
    "前往下一個診斷，開啟對應檔案並定位到問題位置。",
  ],
  "kobrixa.nextTab": [
    "Activate the next open file or settings tab in tab order.",
    "依分頁順序切換至下一個已開啟的檔案或設定分頁。",
  ],
  "kobrixa.openProject": [
    "Choose an existing project folder and load its files into the workspace.",
    "選擇既有專案資料夾，將其中的檔案載入工作區。",
  ],
  "kobrixa.previousProblem": [
    "Move to the previous diagnostic and open its file at the reported position.",
    "前往上一個診斷，開啟對應檔案並定位到問題位置。",
  ],
  "kobrixa.previousTab": [
    "Activate the previous open file or settings tab in tab order.",
    "依分頁順序切換至上一個已開啟的檔案或設定分頁。",
  ],
  "kobrixa.problems": [
    "Show or hide the diagnostics panel containing errors and warnings.",
    "顯示或隱藏列出錯誤與警告的診斷面板。",
  ],
  "kobrixa.run": [
    "Save and compile the project, then deploy and start it on the connected EV3.",
    "保存並編譯專案，再部署到已連線的 EV3 上執行。",
  ],
  "kobrixa.quickOpen": [
    "Find a project file by name or path and open it, optionally at a specified line and column.",
    "依檔名或路徑尋找並開啟專案檔案，可指定跳轉的行號與欄號。",
  ],
  "kobrixa.save": [
    "Write the active file to disk, applying format on save when enabled.",
    "將目前檔案寫入磁碟；啟用儲存時格式化時會先整理格式。",
  ],
  "kobrixa.saveAll": [
    "Write all modified project files and recovered drafts to disk, applying format on save when enabled.",
    "將專案中所有修改的檔案與復原草稿寫入磁碟；啟用儲存時格式化時會先整理格式。",
  ],
  "kobrixa.settings": [
    "Open the settings tab to adjust appearance, editor behavior, saving and workspace layout.",
    "開啟設定分頁，調整外觀、編輯器、儲存方式與工作區布局。",
  ],
  "kobrixa.search": [
    "Search text across the active project's editable files, including unsaved changes.",
    "搜尋目前專案的可編輯檔案內容，包含尚未儲存的修改。",
  ],
  "kobrixa.shortcuts": [
    "Open the keyboard shortcuts category to search commands and edit their bindings.",
    "開啟設定中的快捷鍵分類，搜尋命令並修改按鍵綁定。",
  ],
  "kobrixa.stop": [
    "Cancel a build in progress, or request that the connected EV3 stop the running program.",
    "取消進行中的編譯，或要求已連線的 EV3 停止目前程式。",
  ],
  lastCursorLineSelect: [
    "Select the entire line at the last cursor's supplied position; requires position arguments.",
    "以最後一個游標選取指定位置的整行；需要位置參數。",
  ],
  lastCursorLineSelectDrag: [
    "Extend whole-line selection with the last cursor using a supplied drag position.",
    "依指定的拖曳位置，以最後一個游標延伸整行選取範圍。",
  ],
  lastCursorWordSelect: [
    "Select a word with the last cursor using a supplied position.",
    "依指定位置，以最後一個游標選取單字。",
  ],
  leaveEditorMessage: [
    "Dismiss the temporary message displayed near the editor cursor.",
    "關閉顯示在編輯器游標附近的暫時訊息。",
  ],
  leaveSnippet: [
    "Exit snippet placeholder navigation while keeping text already inserted.",
    "離開程式碼片段的欄位導覽，保留已插入的文字。",
  ],
  lineBreakInsert: [
    "Insert a line break without moving the cursor to the new line.",
    "插入換行，但讓游標留在原本的行。",
  ],
  openReferenceToSide: [
    "Request the focused reference in a side editor; requires host support.",
    "要求在側邊編輯器開啟目前聚焦的參考結果；需要宿主介面支援。",
  ],
  outdent: [
    "Reduce indentation on the current line or selected lines.",
    "減少目前行或選取行的縮排。",
  ],
  previewSelectedCodeAction: [
    "Show the edits proposed by the highlighted code action when a preview is available.",
    "可預覽時，顯示目前反白的程式碼動作將進行的修改。",
  ],
  "quickInput.acceptInBackground": [
    "Accept the focused quick-pick item while asking the picker to remain open, when supported.",
    "接受目前聚焦的快速選單項目；選單支援時會保持開啟。",
  ],
  "quickInput.first": [
    "Move focus to the first item in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至第一個項目，不立即執行。",
  ],
  "quickInput.last": [
    "Move focus to the last item in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至最後一個項目，不立即執行。",
  ],
  "quickInput.next": [
    "Move focus to the next item in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至下一個項目，不立即執行。",
  ],
  "quickInput.nextSeparator": [
    "Move focus to the next group in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至下一個群組，不立即執行。",
  ],
  "quickInput.nextSeparatorWithQuickAccessFallback": [
    "Move to the next group in a quick pick, or the next item when using quick access.",
    "在快速選單中移至下一個群組；使用快速存取模式時改為移至下一個項目。",
  ],
  "quickInput.pageNext": [
    "Move focus to the next page of items in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至下一頁項目，不立即執行。",
  ],
  "quickInput.pagePrevious": [
    "Move focus to the previous page of items in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至上一頁項目，不立即執行。",
  ],
  "quickInput.previous": [
    "Move focus to the previous item in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至上一個項目，不立即執行。",
  ],
  "quickInput.previousSeparator": [
    "Move focus to the previous group in the open quick pick without accepting it.",
    "在已開啟的快速選單中，將焦點移至上一個群組，不立即執行。",
  ],
  "quickInput.previousSeparatorWithQuickAccessFallback": [
    "Move to the previous group in a quick pick, or the previous item when using quick access.",
    "在快速選單中移至上一個群組；使用快速存取模式時改為移至上一個項目。",
  ],
  redo: ["Reapply the latest text edit that was undone.", "重新套用最近一次被復原的文字修改。"],
  removeSecondaryCursors: [
    "Keep the primary cursor and remove additional cursors and selections.",
    "保留主要游標，移除其他游標與選取範圍。",
  ],
  revealLine: [
    "Scroll a supplied line into view at a specified viewport position; requires line arguments.",
    "將指定行捲動至畫面中的指定位置；需要行號等參數。",
  ],
  revealReference: [
    "Open the focused reference result at its location in the editor.",
    "在編輯器中開啟目前聚焦的參考結果位置。",
  ],
  scrollEditorBottom: [
    "Scroll the editor viewport to the bottom of the document without editing text.",
    "將編輯器畫面捲動至文件底部，不修改文字。",
  ],
  scrollEditorTop: [
    "Scroll the editor viewport to the top of the document without editing text.",
    "將編輯器畫面捲動至文件頂端，不修改文字。",
  ],
  scrollLeft: [
    "Scroll the editor viewport horizontally to the left without editing text.",
    "將編輯器畫面向左水平捲動，不修改文字。",
  ],
  scrollLineDown: [
    "Scroll the editor viewport down one line without editing text.",
    "將編輯器畫面向下捲動一行，不修改文字。",
  ],
  scrollLineUp: [
    "Scroll the editor viewport up one line without editing text.",
    "將編輯器畫面向上捲動一行，不修改文字。",
  ],
  scrollPageDown: [
    "Scroll the editor viewport down one screenful without editing text.",
    "將編輯器畫面向下捲動一個畫面，不修改文字。",
  ],
  scrollPageUp: [
    "Scroll the editor viewport up one screenful without editing text.",
    "將編輯器畫面向上捲動一個畫面，不修改文字。",
  ],
  scrollRight: [
    "Scroll the editor viewport horizontally to the right without editing text.",
    "將編輯器畫面向右水平捲動，不修改文字。",
  ],
  selectFirstSuggestion: [
    "Highlight the first suggestion in the completion list without inserting it.",
    "在補全清單中選取第一個建議，不立即插入文字。",
  ],
  selectLastSuggestion: [
    "Highlight the last suggestion in the completion list without inserting it.",
    "在補全清單中選取最後一個建議，不立即插入文字。",
  ],
  selectNextCodeAction: [
    "Move to the next available item in the open code-action menu.",
    "在已開啟的程式碼動作選單中，移至下一個可用項目。",
  ],
  selectNextPageSuggestion: [
    "Highlight the next page of suggestions in the completion list without inserting it.",
    "在補全清單中選取下一頁建議，不立即插入文字。",
  ],
  selectNextSuggestion: [
    "Highlight the next suggestion in the completion list without inserting it.",
    "在補全清單中選取下一個建議，不立即插入文字。",
  ],
  selectPrevCodeAction: [
    "Move to the previous available item in the open code-action menu.",
    "在已開啟的程式碼動作選單中，移至上一個可用項目。",
  ],
  selectPrevPageSuggestion: [
    "Highlight the previous page of suggestions in the completion list without inserting it.",
    "在補全清單中選取上一頁建議，不立即插入文字。",
  ],
  selectPrevSuggestion: [
    "Highlight the previous suggestion in the completion list without inserting it.",
    "在補全清單中選取上一個建議，不立即插入文字。",
  ],
  setSelection: [
    "Set the editor selection to a supplied range; requires range arguments.",
    "將編輯器選取範圍設為指定區域；需要範圍參數。",
  ],
  showNextParameterHint: [
    "Display the next overload in the open function-signature popup.",
    "在已開啟的函式參數提示中顯示下一個多載版本。",
  ],
  showPrevParameterHint: [
    "Display the previous overload in the open function-signature popup.",
    "在已開啟的函式參數提示中顯示上一個多載版本。",
  ],
  tab: [
    "Insert a tab or spaces, or indent selected lines, according to editor indentation settings.",
    "依編輯器縮排設定插入定位字元或空格，或增加選取行的縮排。",
  ],
  toggleExplainMode: [
    "Toggle diagnostic explanations about how completion suggestions are ranked.",
    "切換顯示補全建議排序方式的除錯解說。",
  ],
  toggleFindCaseSensitive: [
    "Switch whether search distinguishes uppercase and lowercase letters.",
    "切換搜尋時是否區分英文字母的大小寫。",
  ],
  toggleFindInSelection: [
    "Limit search to selected text, or search the entire document.",
    "將搜尋限制在選取範圍，或改為搜尋整份文件。",
  ],
  toggleFindRegex: [
    "Switch between literal text and regular expression search patterns.",
    "切換一般文字搜尋與規則運算式搜尋。",
  ],
  toggleFindWholeWord: [
    "Switch whether search matches only complete words.",
    "切換搜尋時是否只比對完整單字。",
  ],
  togglePeekWidgetFocus: [
    "Switch focus between the results list and editor inside a peek preview.",
    "在預覽視窗的結果清單與編輯區之間切換焦點。",
  ],
  togglePreserveCase: [
    "Switch whether replacements follow the capitalization of each matched word.",
    "切換取代文字時是否沿用相符文字的大小寫形式。",
  ],
  toggleSuggestionDetails: [
    "Show or hide documentation for the highlighted completion item.",
    "顯示或隱藏目前反白補全項目的說明文件。",
  ],
  toggleSuggestionFocus: [
    "Switch focus between the completion list and its detailed documentation.",
    "在補全清單與建議的詳細說明之間切換焦點。",
  ],
  undo: ["Undo the latest text edit in the active editor.", "復原目前編輯器中最近一次文字修改。"],
};
