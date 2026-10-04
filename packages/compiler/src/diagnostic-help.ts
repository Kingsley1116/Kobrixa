/** Browser-safe diagnostic documentation shared by the IDE and documentation site. */
export type DiagnosticLocale = "zh-TW" | "en";
export type Localized<T> = Record<DiagnosticLocale, T>;
export interface DiagnosticHelp {
  code: string;
  helpKey?: string;
  title: Localized<string>;
  cause: Localized<string>;
  steps: Localized<string[]>;
  example?: { before: string; after: string; language: "bp" | "json" };
  related: Array<{ path: string; label: Localized<string> }>;
  keywords: string[];
}

const localized = <T>(zh: T, en: T): Localized<T> => ({ "zh-TW": zh, en });
const references = {
  syntax: {
    path: "/docs/reference/basic-plus",
    label: localized("Basic Plus 參考", "Basic Plus reference"),
  },
  values: {
    path: "/docs/tutorial/values-and-logic",
    label: localized("值、文字與運算", "Values, text, and math"),
  },
  control: { path: "/docs/tutorial/control-flow", label: localized("控制流程", "Control flow") },
  functions: {
    path: "/docs/tutorial/functions-projects",
    label: localized("函式與專案", "Functions and projects"),
  },
  data: { path: "/docs/tutorial/data-files", label: localized("資料與檔案", "Data and files") },
  sensors: { path: "/docs/tutorial/sensors", label: localized("感測器", "Sensors") },
  motors: { path: "/docs/tutorial/motors", label: localized("馬達", "Motors") },
  feedback: {
    path: "/docs/tutorial/feedback",
    label: localized("互動回饋", "Interactive feedback"),
  },
  communication: {
    path: "/docs/tutorial/communication",
    label: localized("信箱與並行", "Mailboxes and concurrency"),
  },
  installation: {
    path: "/docs/reference/installation",
    label: localized("安裝與復原", "Installation and recovery"),
  },
  architecture: {
    path: "/docs/reference/architecture",
    label: localized("架構與公共契約", "Architecture and public contracts"),
  },
};

const referenceKeywords: Record<keyof typeof references, string[]> = {
  syntax: ["語法", "syntax", "API", "reference"],
  values: ["變數", "型別", "數值", "字串", "variable", "type", "number", "string"],
  control: ["迴圈", "條件", "區塊", "loop", "condition", "block"],
  functions: [
    "函式",
    "參數",
    "專案",
    "function",
    "parameter",
    "project",
    "Sub",
    "Include",
    "Import",
  ],
  data: ["陣列", "索引", "檔案", "array", "index", "file", "Row", "Vector"],
  sensors: ["感測器", "輸入埠", "sensor", "port", "I2C"],
  motors: ["馬達", "motor", "legacy"],
  feedback: ["按鍵", "燈號", "button", "LED"],
  communication: ["並行", "背景工作", "信箱", "thread", "mailbox", "concurrency"],
  installation: ["建置", "載入", "build", "load", "recovery"],
  architecture: ["編譯器", "中介表示", "compiler", "intermediate representation", "backend"],
};

type Pair = [zh: string, en: string];
function entry(
  code: string,
  title: Pair,
  cause: Pair,
  steps: Pair[],
  reference: keyof typeof references = "syntax",
  example?: [before: string, after: string],
  keywords: string[] = [],
): DiagnosticHelp {
  return {
    code,
    title: localized(...title),
    cause: localized(...cause),
    steps: localized(
      steps.map(([zh]) => zh),
      steps.map(([, en]) => en),
    ),
    related: [references[reference]],
    keywords: [...referenceKeywords[reference], ...keywords],
    ...(example
      ? { example: { before: example[0], after: example[1], language: "bp" as const } }
      : {}),
  };
}

const reportStep: Pair = [
  "若修正來源問題並重新建置後仍發生，請附上原始診斷、Kobrixa 版本與可重現的最小專案回報問題。",
  "If this persists after correcting source errors and rebuilding, report the original diagnostic, Kobrixa version, and a minimal reproducing project.",
];
const internal = (code: string, title: Pair, cause: Pair, step: Pair): DiagnosticHelp =>
  entry(code, title, cause, [step, reportStep], "architecture");

/** One default explanation for every diagnostic emitted by production code. */
export const DIAGNOSTIC_HELP: readonly DiagnosticHelp[] = [
  internal(
    "BP0000",
    ["程式分析未完成", "Program analysis could not finish"],
    [
      "語言分析遇到未預期的錯誤；本次診斷與補全結果可能不完整。",
      "The language analyzer encountered an unexpected error; diagnostics and completions may be incomplete.",
    ],
    [
      "先修正其他語法錯誤，再重新開啟檔案或重試分析。",
      "Correct other syntax errors, then reopen the file or retry analysis.",
    ],
  ),
  entry(
    "BP1000",
    ["找不到程式入口", "Program entry file is missing"],
    [
      "專案指定的入口檔案沒有載入到來源清單。",
      "The project's entry file is absent from its loaded sources.",
    ],
    [
      [
        "檢查 kobrixa.json 的 entry 路徑及檔案是否存在，再重新開啟專案。",
        "Check the entry path in kobrixa.json and that the file exists, then reopen the project.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP1001",
    ["無法辨識的字元", "Unrecognized character"],
    [
      "這個字元不是 Basic Plus 支援的語法。",
      "This character is not part of supported Basic Plus syntax.",
    ],
    [
      [
        "刪除該字元，或改用半形運算符號；文字內容請放在雙引號中。",
        "Remove the character or use an ASCII operator; put text inside double quotes.",
      ],
    ],
    "syntax",
    ["count = 1 $ 2", "count = 1 + 2"],
  ),
  entry(
    "BP1002",
    ["數字格式不正確", "Invalid number format"],
    [
      "數字含多個小數點，或超出可表示的範圍。",
      "The number has multiple decimal points or exceeds the representable range.",
    ],
    [
      [
        "使用有限的整數或只有一個小數點的數值。",
        "Use a finite integer or a decimal with only one decimal point.",
      ],
    ],
    "values",
    ["value = 1.2.3", "value = 1.23"],
  ),
  entry(
    "BP1003",
    ["字串缺少結尾引號", "String is missing its closing quote"],
    [
      "字串到行尾仍未出現結尾雙引號。",
      "The string reaches the end of the line without a closing double quote.",
    ],
    [
      [
        "在同一行補上雙引號；字串中的雙引號需寫成兩個雙引號。",
        "Close the string on the same line; represent a quote inside a string with two double quotes.",
      ],
    ],
    "values",
    ['message = "Hello', 'message = "Hello"'],
  ),
  entry(
    "BP1010",
    ["Include／Import 路徑需要引號", "Include or Import path needs quotes"],
    [
      "Include 或 Import 後面不是以雙引號括住的專案相對路徑。",
      "Include or Import is not followed by a quoted project-relative path.",
    ],
    [
      [
        "將路徑放入雙引號，並確認目標檔案位於專案內。",
        "Quote the path and confirm the target file is inside the project.",
      ],
    ],
    "functions",
    ["Include settings.bpi", 'Include "settings.bpi"'],
  ),
  entry(
    "BP1011",
    ["Sub／Function 缺少名稱", "Sub or Function name is missing"],
    ["宣告後面沒有合法的函式名稱。", "A declaration is missing a valid function name."],
    [
      [
        "在 Sub 或 Function 後面加上名稱，再列出參數。",
        "Add a name after Sub or Function, followed by any parameters.",
      ],
    ],
    "functions",
    ["Sub ()\nEndSub", "Sub Beep()\nEndSub"],
  ),
  entry(
    "BP1012",
    ["參數缺少名稱", "Parameter name is missing"],
    [
      "參數位置需要識別名稱，不能只有型別、逗號或數值。",
      "A parameter needs an identifier, not only a type, comma, or value.",
    ],
    [
      [
        "為每個參數提供名稱，並移除多餘的逗號。",
        "Give every parameter a name and remove extra commas.",
      ],
    ],
    "functions",
    ["Sub Set(Number)\nEndSub", "Sub Set(Number value)\nEndSub"],
  ),
  entry(
    "BP1013",
    ["參數清單缺少右括號", "Parameter list is missing a closing parenthesis"],
    [
      "Sub／Function 參數清單以 ( 開始，但沒有對應的 )。",
      "A Sub or Function parameter list starts with ( but has no matching ).",
    ],
    [
      [
        "在完整的最後一個參數後、行尾註解前補上 )。",
        "Add ) after the last complete parameter and before any line comment.",
      ],
    ],
    "functions",
    ["Sub Set(Number value\nEndSub", "Sub Set(Number value)\nEndSub"],
  ),
  entry(
    "BP1014",
    ["函式區塊缺少結尾", "Function block is missing its ending"],
    [
      "Sub 或 Function 區塊沒有相對應的 EndSub 或 EndFunction。",
      "A Sub or Function block is missing its matching EndSub or EndFunction.",
    ],
    [
      [
        "依原始診斷所指定的關鍵字補齊結尾，並先結束內層區塊。",
        "Add the ending named in the original diagnostic, closing inner blocks first.",
      ],
    ],
    "functions",
    [
      "Sub Beep()\n  Speaker.Tone(20, 440, 100)",
      "Sub Beep()\n  Speaker.Tone(20, 440, 100)\nEndSub",
    ],
  ),
  entry(
    "BP1015",
    ["陣列參數型別缺少 ]", "Array parameter type is missing ]"],
    ["參數的 Number[ 或 String[ 後面缺少 ]。", "A Number[ or String[ parameter type is missing ]."],
    [
      [
        "以 Number[] 或 String[] 表示型別，再接參數名稱。",
        "Write the type as Number[] or String[], followed by the parameter name.",
      ],
    ],
    "functions",
    ["Sub Read(Number[ items)\nEndSub", "Sub Read(Number[] items)\nEndSub"],
  ),
  entry(
    "BP1020",
    ["Goto 缺少標籤名稱", "Goto needs a label name"],
    ["Goto 後面沒有可跳往的標籤識別名稱。", "Goto is not followed by a label identifier."],
    [
      [
        "指定標籤名稱，並在可達範圍內宣告同名標籤。",
        "Provide a label name and declare the matching label in an accessible scope.",
      ],
    ],
    "control",
    ["Goto\ndone:", "Goto done\ndone:"],
  ),
  entry(
    "BP1021",
    ["Property 缺少名稱", "Property name is missing"],
    ["Property 宣告後面需要屬性名稱。", "A Property declaration needs a name."],
    [["在 Property 後加上合法識別名稱。", "Add a valid identifier after Property."]],
    "syntax",
    ["Property", "Property speed"],
  ),
  entry(
    "BP1022",
    ["名稱後需要指定或呼叫", "Expected assignment or call after a name"],
    [
      "這一行只有名稱，或名稱後面的語法不是支援的指定或呼叫。",
      "A name is followed by neither a supported assignment nor a call.",
    ],
    [
      [
        "指定值時加入 =；呼叫函式時使用完整的括號與參數。",
        "Use = to assign a value, or a complete parenthesized argument list to call a function.",
      ],
    ],
    "syntax",
    ["speed", "speed = 50"],
  ),
  entry(
    "BP1023",
    ["這裡不能使用此語法", "Unexpected token in this statement"],
    [
      "目前位置的符號無法開始合法陳述式，也可能是區塊結尾不匹配。",
      "The token cannot start a valid statement here; a block ending may also be mismatched.",
    ],
    [
      [
        "先檢查前一行及區塊的開頭／結尾，再移除多餘的符號。",
        "Check the previous line and block openings/endings, then remove any extra token.",
      ],
    ],
    "syntax",
    [")\nspeed = 50", "speed = 50"],
  ),
  entry(
    "BP1024",
    ["陣列宣告缺少 ]", "Array declaration is missing ]"],
    [
      "陣列型別的左中括號沒有對應的右中括號。",
      "The opening bracket in an array type has no matching closing bracket.",
    ],
    [
      [
        "將宣告寫成 Number[] 名稱或 String[] 名稱。",
        "Write the declaration as Number[] name or String[] name.",
      ],
    ],
    "data",
    ["Number[ values", "Number[] values"],
  ),
  entry(
    "BP1025",
    ["變數宣告缺少名稱", "Variable declaration needs a name"],
    [
      "型別宣告後面沒有合法的變數名稱。",
      "A type declaration is not followed by a valid variable name.",
    ],
    [
      [
        "在型別後加入名稱，並將指定初始值寫在另一行。",
        "Add a name after the type and assign an initial value on another line.",
      ],
    ],
    "values",
    ["Number", "Number speed"],
  ),
  entry(
    "BP1026",
    ["@ 後缺少全域變數名稱", "Global variable name is missing after @"],
    [
      "指定陳述式中的 @ 後面不是識別名稱。",
      "The @ in an assignment is not followed by an identifier.",
    ],
    [["在 @ 後面接上全域變數名稱。", "Put the global variable name after @."]],
    "functions",
    ["@ = 10", "@speed = 10"],
  ),
  entry(
    "BP1027",
    ["陣列寫入索引缺少 ]", "Array write index is missing ]"],
    [
      "陣列寫入的索引運算式沒有以 ] 結束。",
      "The index expression in an array assignment is missing its closing ].",
    ],
    [
      [
        "檢查完整索引運算式後補上 ]，再寫 = 與要指定的值。",
        "Close the complete index expression with ], then write = and the assigned value.",
      ],
    ],
    "data",
    ["Number[] values\nvalues[0 = 1", "Number[] values\nvalues[0] = 1"],
  ),
  entry(
    "BP1028",
    ["陣列指定缺少 =", "Array assignment is missing ="],
    [
      "陣列索引後面需要 =，才能指定新的元素值。",
      "An array index needs = after it to assign a new element value.",
    ],
    [["在 ] 與要指定的值之間加入 =。", "Add = between ] and the assigned value."]],
    "data",
    ["Number[] values\nvalues[0] 1", "Number[] values\nvalues[0] = 1"],
  ),
  entry(
    "BP1029",
    ["背景工作缺少 Sub 名稱", "Background task needs a Sub name"],
    [
      "Thread.Run 或 F.Start 指定式需要 Sub 名稱。",
      "A Thread.Run or F.Start assignment needs a Sub name.",
    ],
    [
      [
        "使用 Thread.Run = 名稱，並定義不帶參數的 Sub。",
        "Use Thread.Run = name and define a Sub without parameters.",
      ],
    ],
    "communication",
    ["Thread.Run =\nSub Work()\nEndSub", "Thread.Run = Work\nSub Work()\nEndSub"],
  ),
  entry(
    "BP1030",
    ["If 區塊缺少 EndIf", "If block is missing EndIf"],
    ["If 區塊沒有對應的 EndIf。", "An If block has no matching EndIf."],
    [
      [
        "先結束內層區塊，再在 If 區塊尾端加入 EndIf。",
        "Close any inner blocks, then add EndIf at the end of the If block.",
      ],
    ],
    "control",
    ["If true Then\n  value = 1", "If true Then\n  value = 1\nEndIf"],
  ),
  entry(
    "BP1031",
    ["While 區塊缺少 EndWhile", "While block is missing EndWhile"],
    ["While 迴圈沒有對應的 EndWhile。", "A While loop has no matching EndWhile."],
    [
      [
        "先結束內層區塊，再在迴圈尾端加入 EndWhile。",
        "Close any inner blocks, then add EndWhile at the end of the loop.",
      ],
    ],
    "control",
    ["While false\n  value = 1", "While false\n  value = 1\nEndWhile"],
  ),
  entry(
    "BP1032",
    ["For 缺少迴圈變數", "For loop variable is missing"],
    ["For 後面需要用來計數的變數名稱。", "For needs a counter variable name."],
    [["以 For 變數 = 起始值 To 結束值 的形式撰寫。", "Write For variable = start To end."]],
    "control",
    ["For = 1 To 3\nEndFor", "For i = 1 To 3\nEndFor"],
  ),
  entry(
    "BP1033",
    ["For 起始值前缺少 =", "For initializer is missing ="],
    [
      "迴圈變數與起始值之間缺少 =。",
      "The loop variable and start value are missing an = between them.",
    ],
    [
      [
        "在 For 的變數名稱後、起始值前加入 =。",
        "Add = after the For variable and before its start value.",
      ],
    ],
    "control",
    ["For i 1 To 3\nEndFor", "For i = 1 To 3\nEndFor"],
  ),
  entry(
    "BP1034",
    ["For 範圍缺少 To", "For range is missing To"],
    [
      "起始值與結束值之間需要 To 關鍵字。",
      "The start and end values need the To keyword between them.",
    ],
    [
      [
        "確認兩個運算式都完整，再在中間加入 To。",
        "Ensure both expressions are complete, then insert To between them.",
      ],
    ],
    "control",
    ["For i = 1 3\nEndFor", "For i = 1 To 3\nEndFor"],
  ),
  entry(
    "BP1035",
    ["For 區塊缺少 EndFor", "For block is missing EndFor"],
    ["For 迴圈沒有對應的 EndFor。", "A For loop has no matching EndFor."],
    [
      [
        "先結束內層區塊，再在迴圈尾端加入 EndFor。",
        "Close any inner blocks, then add EndFor at the end of the loop.",
      ],
    ],
    "control",
    ["For i = 1 To 3\n  value = i", "For i = 1 To 3\n  value = i\nEndFor"],
  ),
  entry(
    "BP1040",
    ["運算式缺少右括號", "Expression is missing a closing parenthesis"],
    ["以 ( 開始的運算式沒有對應的 )。", "An expression starting with ( has no matching )."],
    [
      [
        "先確認運算式完整，再於行尾註解前加入 )。",
        "Complete the expression, then add ) before any line comment.",
      ],
    ],
    "values",
    ["value = (1 + 2", "value = (1 + 2)"],
  ),
  entry(
    "BP1041",
    ["缺少運算式", "Expression is missing"],
    [
      "此處需要數值、字串、變數或可傳回值的呼叫。",
      "This position needs a value, string, variable, or call that returns a value.",
    ],
    [
      [
        "補上要計算或指定的值，並檢查是否有多餘的運算子或逗號。",
        "Supply the value to calculate or assign, and check for extra operators or commas.",
      ],
    ],
    "values",
    ["value =", "value = 1"],
  ),
  entry(
    "BP1042",
    ["呼叫缺少左括號", "Call is missing an opening parenthesis"],
    ["參數清單的開頭需要 (。", "The argument list needs an opening (."],
    [
      [
        "在函式名稱後加上 (，並以 ) 結束參數清單。",
        "Add ( after the function name and end the argument list with ).",
      ],
    ],
    "functions",
    ["value = Math.Abs 1)", "value = Math.Abs(1)"],
  ),
  entry(
    "BP1043",
    ["呼叫缺少右括號", "Call is missing a closing parenthesis"],
    [
      "函式呼叫的參數清單沒有對應的 )。",
      "A function call's argument list is missing its matching ).",
    ],
    [
      [
        "補齊最後一個參數，再於行尾註解前加入 )。",
        "Complete the last argument, then add ) before any line comment.",
      ],
    ],
    "functions",
    ["value = Math.Abs(-1", "value = Math.Abs(-1)"],
  ),
  entry(
    "BP1044",
    ["運算式的 @ 後缺少名稱", "Expression needs a name after @"],
    ["讀取全域變數時，@ 後面沒有識別名稱。", "A global variable read has no identifier after @."],
    [["在 @ 後接上要讀取的全域變數名稱。", "Add the global variable name to read after @."]],
    "functions",
    ["value = @", "@speed = 10\nvalue = @speed"],
  ),
  entry(
    "BP1045",
    ["陣列讀取索引缺少 ]", "Array read index is missing ]"],
    [
      "陣列讀取的索引運算式沒有以 ] 結束。",
      "An array read's index expression is not closed with ].",
    ],
    [
      [
        "確認索引範圍與完整運算式，然後補上 ]。",
        "Check the intended index expression and close it with ].",
      ],
    ],
    "data",
    ["Number[] values\nvalue = values[0", "Number[] values\nvalue = values[0]"],
  ),
  entry(
    "BP1050",
    ["Folder 指令缺少字串參數", "Folder directive needs string arguments"],
    [
      "Folder 需要以引號括住的儲存區及資料夾名稱。",
      "Folder needs quoted storage and directory names.",
    ],
    [
      [
        '使用 Folder "prjs" "名稱" 或 Folder "sd" "名稱"。',
        'Use Folder "prjs" "name" or Folder "sd" "name".',
      ],
    ],
    "functions",
    ["Folder prjs demo", 'Folder "prjs" "demo"'],
  ),
  entry(
    "BP1051",
    ["Folder 設定不合法", "Invalid Folder directive"],
    [
      "Folder 重複、儲存區不是 prjs／sd，或名稱不是有效的單一資料夾。",
      "Folder is repeated, storage is not prjs/sd, or the name is not a valid single directory.",
    ],
    [
      [
        "只保留一個 Folder；名稱不可為 . 或 ..，不可含斜線或控制字元，UTF-8 長度最多 48 bytes。",
        "Keep one Folder directive; the name cannot be . or .., contain slashes or control characters, or exceed 48 UTF-8 bytes.",
      ],
    ],
    "functions",
    ['Folder "prjs" "a/b"', 'Folder "prjs" "demo"'],
  ),
  entry(
    "BP1100",
    ["找不到引入的檔案", "Included file was not found"],
    [
      "Include／Import 指定的檔案不在已載入的專案來源中。",
      "An Include or Import target is absent from the loaded project sources.",
    ],
    [
      [
        "檢查相對路徑、檔名大小寫及副檔名，並確認檔案已建立且位於專案內。",
        "Check the relative path, filename case, and extension; ensure the file exists inside the project.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP1101",
    ["引入路徑超出專案", "Include path leaves the project"],
    [
      "Include／Import 的路徑解析後超出專案根目錄。",
      "An Include or Import path resolves outside the project root.",
    ],
    [
      [
        "將共用檔案放進專案，再使用專案內的相對路徑。",
        "Place the shared file inside the project and reference it with an in-project relative path.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP2001",
    ["函式名稱重複", "Duplicate function name"],
    [
      "有兩個 Sub／Function 使用同一個不區分大小寫的名稱。",
      "Two Subs or Functions have the same case-insensitive name.",
    ],
    [
      [
        "重新命名其中一個宣告及其呼叫，或移除重複引入的定義。",
        "Rename one declaration and its calls, or remove the duplicate included definition.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP2002",
    ["指定值的型別不相容", "Assignment types do not match"],
    [
      "指定值的型別與變數或陣列元素的型別不相容。",
      "The assigned value is incompatible with the variable or array element type.",
    ],
    [
      [
        "依原始訊息比對來源與目標型別；修正值或使用適當轉換。",
        "Compare source and target types in the original message; correct the value or use an appropriate conversion.",
      ],
    ],
    "values",
    ['Number speed\nspeed = "fast"', "Number speed\nspeed = 50"],
  ),
  entry(
    "BP2004",
    ["自訂函式的參數數量不符", "User function argument count does not match"],
    [
      "呼叫時提供的參數數量與 Sub／Function 宣告不同。",
      "The call supplies a different number of arguments than the Sub or Function declares.",
    ],
    [
      [
        "對照宣告，依順序補上缺少的參數或移除多餘的參數。",
        "Compare the declaration and supply missing arguments in order or remove extras.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP2005",
    ["Sub 不能當作值使用", "A Sub cannot be used as a value"],
    [
      "Sub 沒有傳回值，不能放在指定式或運算式中。",
      "A Sub has no return value and cannot be used in an assignment or expression.",
    ],
    [
      [
        "將 Sub 呼叫獨立成一行；若需要結果，明確設計傳回值的 Function。",
        "Call the Sub on its own line; if a result is needed, define a Function with a return value.",
      ],
    ],
    "functions",
    ["Sub Work()\nEndSub\nvalue = Work()", "Sub Work()\nEndSub\nWork()"],
  ),
  entry(
    "BP2006",
    ["迴圈控制或輸出參數不合法", "Invalid loop control or output argument"],
    [
      "此代碼代表迴圈外的 Break，或輸出參數型別不符；請依原始訊息確認原因。",
      "This code indicates Break outside a loop or an output argument type mismatch; consult the original message.",
    ],
    [
      [
        "檢查 Break 是否位於 For／While 內，或呼叫的 Out 參數是否具有完全相同的型別。",
        "Check that Break is inside For/While, or that an Out argument has exactly the declared type.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP2007",
    ["Continue 必須在迴圈內", "Continue must be inside a loop"],
    [
      "Continue 沒有可繼續下一次迭代的 For 或 While。",
      "Continue has no enclosing For or While iteration to continue.",
    ],
    [
      [
        "將 Continue 放入 For／While，或改寫該處的控制流程。",
        "Place Continue inside For/While or rewrite the control flow.",
      ],
    ],
    "control",
    ["Continue", "For i = 1 To 3\n  Continue\nEndFor"],
  ),
  entry(
    "BP2008",
    ["索引寫入需要陣列變數", "Indexed assignment requires an array"],
    ["被索引的變數不是陣列。", "The indexed variable is not an array."],
    [
      [
        "使用 Number[]／String[] 宣告陣列，並避免以單一值覆蓋同名變數。",
        "Declare the array with Number[]/String[] and avoid replacing that variable with a scalar.",
      ],
    ],
    "data",
  ),
  entry(
    "BP2009",
    ["背景工作需要無參數 Sub", "Background task requires a parameterless Sub"],
    [
      "Thread.Run 的目標是 Function 或帶參數的 Sub。",
      "The Thread.Run target is a Function or a Sub with parameters.",
    ],
    [
      [
        "建立不帶參數的 Sub 作為背景工作入口。",
        "Define a parameterless Sub as the background task entry.",
      ],
    ],
    "communication",
  ),
  entry(
    "BP2010",
    ["Return 型別不一致", "Return type does not match"],
    [
      "Return 的值與函式所需的傳回型別不相容。",
      "The Return value is incompatible with the function's expected return type.",
    ],
    [
      [
        "檢查所有 Return 分支，讓它們回傳相容型別；Sub 不應回傳值。",
        "Check every Return branch for compatible types; a Sub must not return a value.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP3001",
    ["找不到可呼叫的函式", "Function call could not be resolved"],
    [
      "名稱不是已定義的 Sub／Function，也不是支援的 EV3 API；背景 Sub 也可能尚未引入。",
      "The name is neither a declared Sub/Function nor a supported EV3 API; a background Sub may also be missing its import.",
    ],
    [
      [
        "檢查名稱拼寫、Include／Import 及 API 參考手冊。",
        "Check spelling, Include/Import directives, and the API reference.",
      ],
    ],
    "functions",
  ),
  entry(
    "BP3002",
    ["API 參數數量不符", "API argument count does not match"],
    [
      "EV3 API 呼叫提供的參數數量與定義不同。",
      "An EV3 API call supplies a different number of arguments than its definition.",
    ],
    [
      [
        "查閱該 API 的完整簽章，依順序提供所有參數。",
        "Check the API signature and supply all arguments in order.",
      ],
    ],
    "syntax",
    ["LCD.Clear(1)", "LCD.Clear()"],
  ),
  entry(
    "BP3003",
    ["這個 API 不傳回值", "This API does not return a value"],
    [
      "沒有傳回值的 EV3 操作被用在運算式中。",
      "An EV3 operation without a return value is used in an expression.",
    ],
    [
      [
        "將操作獨立成一行；若要讀值，改用對應的查詢 API。",
        "Call the operation on its own line; use a corresponding query API when a value is needed.",
      ],
    ],
    "syntax",
    ["value = LCD.Clear()", "LCD.Clear()"],
  ),
  entry(
    "BP3004",
    ["API 參數型別不符", "API argument type does not match"],
    ["某個參數的型別不在該 API 接受的型別內。", "An argument's type is not accepted by the API."],
    [
      [
        "依原始訊息中的參數位置查閱 API 簽章，修正數值、文字、布林或陣列的用法。",
        "Use the argument position in the original message to check the API signature and correct the value type.",
      ],
    ],
    "syntax",
  ),
  entry(
    "MAN1000",
    ["無法辨識專案入口", "Project selection is not supported"],
    [
      "選取的項目不是資料夾、kobrixa.json 或 .bp 檔案。",
      "The selected item is not a folder, kobrixa.json, or .bp file.",
    ],
    [
      [
        "重新選取專案資料夾、專案設定檔或 Basic Plus 來源檔。",
        "Select a project folder, project manifest, or Basic Plus source file.",
      ],
    ],
    "installation",
  ),
  entry(
    "MAN1001",
    ["專案設定欄位不合法", "Project manifest field is invalid"],
    [
      "kobrixa.json 的欄位格式或值不符合專案契約。",
      "A field in kobrixa.json has an invalid type or value.",
    ],
    [
      [
        "依原始訊息指出的欄位修正；schemaVersion 為 1、language 為 bp、target 為 ev3-native。",
        "Correct the field identified in the original message; use schemaVersion 1, language bp, and target ev3-native.",
      ],
      [
        "name 與 entry 不能為空，assets 必須是路徑字串陣列。",
        "name and entry cannot be empty; assets must be an array of path strings.",
      ],
    ],
    "architecture",
  ),
  entry(
    "MAN1002",
    ["無法載入專案檔案", "Project files could not be loaded"],
    [
      "讀取設定、來源或素材時發生檔案、JSON 或路徑錯誤。",
      "Loading the manifest, sources, or assets failed due to a file, JSON, or path error.",
    ],
    [
      [
        "檢查原始訊息、JSON 語法、entry／assets 路徑與檔案讀取權限。",
        "Check the original message, JSON syntax, entry/assets paths, and file read permissions.",
      ],
      [
        "將來源與素材放在專案內，再重新開啟專案。",
        "Keep sources and assets inside the project, then reopen it.",
      ],
    ],
    "installation",
  ),
  entry(
    "MAN1004",
    ["輸出資料夾會覆蓋來源", "Output directory would contain source files"],
    [
      "outputDir 等於來源根目錄，或是來源根目錄的父目錄。",
      "outputDir equals the source root or is an ancestor of it.",
    ],
    [
      [
        "將 outputDir 設為獨立的子資料夾，例如 build，避免建置輸出與來源重疊。",
        "Set outputDir to a separate child folder such as build so generated output cannot overlap sources.",
      ],
    ],
    "architecture",
  ),
  internal(
    "IR1000",
    ["中介格式版本不受支援", "Intermediate format version is unsupported"],
    [
      "編譯器收到非版本 1 的中介表示。",
      "The compiler received an intermediate representation other than version 1.",
    ],
    [
      "確認前端與後端使用相容的 Kobrixa 版本，再重新建置。",
      "Check that the frontend and backend use compatible Kobrixa versions, then rebuild.",
    ],
  ),
  internal(
    "IR1001",
    ["中介程式缺少入口函式", "Intermediate program has no entry function"],
    [
      "中介程式的入口名稱不對應任何函式。",
      "The intermediate program's entry name does not match any function.",
    ],
    [
      "確認專案 entry 指向正確的來源檔，先修正前端診斷。",
      "Confirm the project's entry points to the right source and resolve frontend diagnostics first.",
    ],
  ),
  internal(
    "IR1002",
    ["中介符號重複", "Duplicate intermediate symbol"],
    [
      "同一作用域內存在不區分大小寫的重複變數或參數名稱。",
      "A scope contains duplicate case-insensitive variable or parameter names.",
    ],
    [
      "檢查同一函式的參數／變數名稱是否重複，重新命名衝突項目。",
      "Check for duplicate parameter/variable names within the same function and rename conflicts.",
    ],
  ),
  internal(
    "IR1003",
    ["中介函式缺少入口區塊", "Intermediate function has no entry block"],
    ["函式指定的入口區塊沒有產生。", "A function's designated entry block was not generated."],
    [
      "先修正函式內的語法及控制流程錯誤，再重新建置。",
      "Correct syntax and control-flow errors inside the function, then rebuild.",
    ],
  ),
  internal(
    "IR1004",
    ["中介指定目標不存在", "Intermediate assignment target is missing"],
    [
      "指令要寫入的變數沒有中介符號定義。",
      "An instruction writes a variable without an intermediate symbol definition.",
    ],
    [
      "檢查來源中該變數的宣告與作用域，再重新建置。",
      "Check the variable declaration and scope in the source, then rebuild.",
    ],
  ),
  internal(
    "IR1005",
    ["中介運算值不存在", "Intermediate operand is missing"],
    [
      "運算式或分支條件引用了未定義的中介變數。",
      "An expression or branch condition references an undefined intermediate variable.",
    ],
    [
      "檢查原始訊息指出的名稱、條件與作用域，先修正來源錯誤。",
      "Check the name, condition, and scope from the original message and resolve source errors first.",
    ],
  ),
  internal(
    "IR1006",
    ["中介指定型別不相容", "Intermediate assignment types do not match"],
    [
      "中介程式的來源值與目標型別不相容。",
      "An intermediate assignment's source and target types are incompatible.",
    ],
    [
      "核對原始指定式的型別及陣列元素型別；不要混用字串與數字。",
      "Check the source assignment and array element types; avoid mixing strings and numbers.",
    ],
  ),
  internal(
    "IR1007",
    ["跳躍目標不存在", "Jump target is missing"],
    [
      "Goto 或產生的跳躍指向不存在的區塊。",
      "A Goto or generated jump points to a nonexistent block.",
    ],
    [
      "檢查 Goto 標籤是否存在於可達作用域，並檢查區塊結尾。",
      "Check that Goto labels exist in an accessible scope and verify block endings.",
    ],
  ),
  internal(
    "IR1008",
    ["條件分支目標不存在", "Conditional branch target is missing"],
    [
      "條件分支的成立或不成立區塊沒有產生。",
      "A conditional branch's true or false target was not generated.",
    ],
    [
      "檢查 If／Else／EndIf 及迴圈區塊是否完整，再重新建置。",
      "Check If/Else/EndIf and loop block completeness, then rebuild.",
    ],
  ),
  internal(
    "IR1100",
    ["中介 EV3 操作不受支援", "Intermediate EV3 operation is unsupported"],
    [
      "中介指令中的 EV3 操作不在 API 目錄中。",
      "An intermediate EV3 operation is absent from the API catalog.",
    ],
    [
      "使用參考手冊列出的 API，並確認編譯器套件版本一致。",
      "Use APIs listed in the reference and ensure compiler package versions are consistent.",
    ],
  ),
  internal(
    "IR1101",
    ["中介 EV3 參數數量不符", "Intermediate EV3 argument count does not match"],
    [
      "產生的 EV3 呼叫參數數量與 API 定義不同。",
      "A generated EV3 call has a different number of arguments than its API definition.",
    ],
    [
      "對照 API 簽章修正來源呼叫，並先處理 BP 類別診斷。",
      "Correct the source call against the API signature and resolve BP diagnostics first.",
    ],
  ),
  internal(
    "IR1102",
    ["中介 EV3 參數型別不符", "Intermediate EV3 argument type does not match"],
    [
      "產生的 EV3 呼叫包含不相容的參數型別。",
      "A generated EV3 call contains an incompatible argument type.",
    ],
    [
      "依原始訊息的參數位置檢查型別，先處理來源的型別診斷。",
      "Check the type at the argument position named in the message and resolve source type diagnostics first.",
    ],
  ),
  internal(
    "EV31003",
    ["EV3 位元碼標籤不存在", "EV3 bytecode label is missing"],
    [
      "後端在修補跳躍位置時找不到標籤。",
      "The backend could not find a label while patching jump offsets.",
    ],
    [
      "檢查 Goto 標籤及區塊結尾，修正前端診斷後重新建置。",
      "Check Goto labels and block endings, resolve frontend diagnostics, then rebuild.",
    ],
  ),
  internal(
    "EV31004",
    ["EV3 變數未配置儲存空間", "EV3 variable has no storage allocation"],
    [
      "指令目標沒有對應的 EV3 記憶體位置。",
      "An instruction target has no corresponding EV3 memory location.",
    ],
    [
      "檢查原始訊息中的變數宣告與作用域，再重新建置。",
      "Check the variable declaration and scope named in the original message, then rebuild.",
    ],
  ),
  internal(
    "EV31005",
    ["無法編碼 EV3 呼叫參數", "EV3 call argument could not be encoded"],
    [
      "後端無法將呼叫參數轉成 EV3 位元碼。",
      "The backend could not encode a call argument as EV3 bytecode.",
    ],
    [
      "對照 API 定義檢查參數型別與變數宣告，先修正其他診斷。",
      "Check argument types and declarations against the API definition and resolve other diagnostics first.",
    ],
  ),
  internal(
    "EV32001",
    ["無法編碼指定來源值", "Assignment source could not be encoded"],
    [
      "後端無法為指定式來源值產生 EV3 參數。",
      "The backend could not generate an EV3 parameter for an assignment source.",
    ],
    [
      "檢查指定式的值、變數宣告與型別相容性。",
      "Check the assignment value, variable declarations, and type compatibility.",
    ],
  ),
  internal(
    "EV32002",
    ["運算子尚未支援 EV3 編譯", "Operator has no EV3 implementation"],
    ["此運算子尚無對應的 EV3 位元碼實作。", "The operator has no EV3 bytecode implementation."],
    [
      "參考 Basic Plus 支援語法，將運算改寫為已支援的形式。",
      "Consult supported Basic Plus syntax and rewrite using a supported operation.",
    ],
  ),
  entry(
    "EV32003",
    ["函式呼叫無法編碼", "Function call could not be encoded"],
    [
      "函式、參數、輸出變數或回傳目標不符合 EV3 呼叫需求。",
      "A function, argument, output variable, or return target does not meet EV3 call requirements.",
    ],
    [
      [
        "查看原始訊息，核對函式名稱、參數數量及 Out 參數；修正前端診斷後重新建置。",
        "Read the original message and check the function name, argument count, and Out arguments; resolve frontend diagnostics and rebuild.",
      ],
      reportStep,
    ],
    "functions",
  ),
  internal(
    "EV32004",
    ["無法編碼函式回傳值", "Function return value could not be encoded"],
    [
      "Return 的值或型別無法轉成預期的 EV3 回傳格式。",
      "A Return value or type could not be encoded in the expected EV3 return format.",
    ],
    [
      "讓所有 Return 使用相容型別，並檢查回傳的變數是否有效。",
      "Use compatible types across Return statements and check that returned variables are valid.",
    ],
  ),
  entry(
    "EV32010",
    ["EV3 操作尚未支援", "EV3 operation is not implemented"],
    [
      "此舊式馬達呼叫或 API 操作沒有可用的 EV3 編譯實作。",
      "This legacy motor call or API operation has no available EV3 implementation.",
    ],
    [
      [
        "依原始訊息確認操作名稱，查閱參考手冊並改用已支援的 API。",
        "Check the operation named in the original message and use a supported API from the reference.",
      ],
      reportStep,
    ],
    "syntax",
  ),
  entry(
    "EV32011",
    ["感測器埠超出範圍", "Sensor port is out of range"],
    ["指定的感測器埠不在 1 到 16 之間。", "The sensor port is outside the range 1 through 16."],
    [
      [
        "單台 EV3 使用埠 1–4；串接設備時使用 API 規定的 1–16 埠編號。",
        "Use ports 1–4 on one EV3; for chained bricks, use the API's port numbering from 1 through 16.",
      ],
    ],
    "sensors",
  ),
  entry(
    "EV32012",
    ["感測器參數必須為數值", "Sensor arguments must be numeric"],
    [
      "感測器埠、模式或讀值索引使用了非數值型別。",
      "A sensor port, mode, or value index has a nonnumeric type.",
    ],
    [
      [
        "用數值或數值變數指定埠、模式與索引，不要使用含引號的文字。",
        "Use numeric values or variables for port, mode, and index instead of quoted text.",
      ],
    ],
    "sensors",
  ),
  entry(
    "EV32015",
    ["LED 顏色或效果不受支援", "LED color or effect is unsupported"],
    [
      "EV3.SetLEDColor 需要已支援的顏色與效果字串常數。",
      "EV3.SetLEDColor requires supported constant color and effect names.",
    ],
    [
      [
        "對照 API 參考的顏色與效果名稱，直接傳入字串常數。",
        "Check the API's color and effect names and pass string literals directly.",
      ],
    ],
    "feedback",
  ),
  entry(
    "EV32020",
    ["按鍵名稱必須為支援的常數", "Button name must be a supported constant"],
    [
      "Button.IsPressed 的按鍵名稱不是已支援的字串常數。",
      "Button.IsPressed received a button name other than a supported string literal.",
    ],
    [
      [
        '依 API 參考使用正確的固定按鍵名稱，例如 "Enter"。',
        'Use a supported fixed button name from the API reference, such as "Enter".',
      ],
    ],
    "feedback",
  ),
  entry(
    "EV32023",
    ["信箱數量超過限制", "Mailbox limit exceeded"],
    ["EV3 程式最多可使用 30 個信箱。", "An EV3 program supports at most 30 mailboxes."],
    [
      [
        "減少不同信箱名稱，或讓多種訊息共用同一個信箱。",
        "Reduce distinct mailbox names or share one mailbox between message types.",
      ],
    ],
    "communication",
  ),
  entry(
    "EV32024",
    ["通訊長度需要範圍內的整數常數", "Transfer length needs an in-range integer constant"],
    [
      "感測器通訊的資料長度不是編譯時可確定的整數，或超出該操作上限。",
      "A sensor transfer length is not a compile-time integer or exceeds the operation's limit.",
    ],
    [
      [
        "依原始訊息的上限提供 0 到上限的整數常數；每個操作的長度限制可能不同。",
        "Use an integer literal from 0 to the maximum in the original message; limits differ by operation.",
      ],
    ],
    "sensors",
  ),
  entry(
    "EV32026",
    ["Raw3 需要三個數值變數", "Raw3 requires three numeric variables"],
    [
      "Sensor.Raw3 必須把三個結果寫入數值變數，不能使用常數或其他型別。",
      "Sensor.Raw3 writes three results into numeric variables; constants or other types cannot receive them.",
    ],
    [
      [
        "宣告三個 Number 變數，再按順序傳入 Raw3。",
        "Declare three Number variables and pass them to Raw3 in order.",
      ],
    ],
    "sensors",
  ),
  entry(
    "EV32027",
    ["I2C 讀取長度至少為 1", "I2C read length must be at least 1"],
    [
      "I2C 讀取要求了 0 bytes，無法產生有效讀取。",
      "An I2C read requested zero bytes, which is not a valid read.",
    ],
    [
      [
        "依感測器協定選擇至少 1 byte 且不超出 API 上限的讀取長度。",
        "Choose at least one byte, within the API maximum, according to the sensor protocol.",
      ],
    ],
    "sensors",
  ),
  entry(
    "EV32028",
    ["陣列寫檔需要 Row／Vector 結果", "Array file write requires a Row or Vector result"],
    [
      "EV3File.WriteNumberArray 的資料來源不是可識別的 Row 或 Vector 結果變數。",
      "EV3File.WriteNumberArray did not receive a recognized Row or Vector result variable.",
    ],
    [
      [
        "先將 Row／Vector 建立的陣列存入變數，再把該變數傳給寫檔操作。",
        "Store an array created by Row/Vector in a variable, then pass that variable to the file write.",
      ],
    ],
    "data",
  ),
  internal(
    "EV32030",
    ["背景工作的 EV3 物件不存在", "EV3 background task object is missing"],
    [
      "Thread.Run 指向的 Sub 沒有對應的已產生 EV3 執行物件。",
      "The Sub targeted by Thread.Run has no generated EV3 execution object.",
    ],
    [
      "確認目標 Sub 存在、不帶參數且已引入；先處理 BP2009 或名稱相關診斷。",
      "Ensure the target Sub exists, is parameterless, and is included; resolve BP2009 or name diagnostics first.",
    ],
  ),
  internal(
    "EV39000",
    ["產生的 EV3 程式未通過驗證", "Generated EV3 program failed validation"],
    [
      "產生的 RBF 映像不符合 EV3 格式檢查，這次建置無法提供可部署程式。",
      "The generated RBF image failed EV3 format checks, so this build cannot provide a deployable program.",
    ],
    [
      "保留原始錯誤與專案並重試建置；不要使用這次不完整的輸出。",
      "Keep the original error and project, then retry the build; do not use this incomplete output.",
    ],
  ),
  entry(
    "BUILD0001",
    ["建置已取消", "Build was cancelled"],
    [
      "建置收到取消要求，未完成本次輸出。",
      "The build received a cancellation request and did not finish its output.",
    ],
    [
      [
        "如果仍需要結果，等待其他操作結束後重新建置。",
        "If the result is still needed, wait for other operations to finish and build again.",
      ],
    ],
    "installation",
  ),
  entry(
    "BUILD9000",
    ["建置因未預期錯誤中止", "Build stopped after an unexpected error"],
    [
      "讀取、編譯或輸出階段發生未預期錯誤。",
      "An unexpected error occurred while reading, compiling, or writing output.",
    ],
    [
      [
        "查看原始訊息，檢查檔案權限、可用儲存空間與專案路徑，再重試建置。",
        "Read the original message, check file permissions, free storage, and project paths, then retry.",
      ],
      reportStep,
    ],
    "installation",
  ),
];

function variant(
  code: string,
  helpKey: string,
  title: Pair,
  cause: Pair,
  steps: Pair[],
  reference: keyof typeof references,
  example?: [string, string],
): DiagnosticHelp {
  return { ...entry(code, title, cause, steps, reference, example), helpKey };
}

/** Producer-selected explanations for codes that historically describe multiple conditions. */
export const DIAGNOSTIC_HELP_VARIANTS: readonly DiagnosticHelp[] = [
  variant(
    "BP2006",
    "break-outside-loop",
    ["Break 必須在迴圈內", "Break must be inside a loop"],
    ["Break 沒有可離開的 For 或 While 迴圈。", "Break has no enclosing For or While loop to exit."],
    [
      [
        "將 Break 放在 For／While 內，或依需求改用 Return 結束函式。",
        "Place Break inside For/While, or use Return if the intention is to leave the function.",
      ],
    ],
    "control",
    ["Break", "While true\n  Break\nEndWhile"],
  ),
  variant(
    "BP2006",
    "out-type",
    ["Out 參數型別必須完全一致", "Out argument type must match exactly"],
    [
      "Out 參數會寫入呼叫者的變數，因此型別及陣列元素型別必須與宣告相同。",
      "An Out parameter writes the caller's variable, so its type and array element type must exactly match the declaration.",
    ],
    [
      [
        "依 Sub／Function 的 Out 型別宣告接收變數，再傳入該變數。",
        "Declare the receiving variable with the Out type from the Sub/Function and pass that variable.",
      ],
    ],
    "functions",
  ),
  variant(
    "BP1050",
    "folder-storage",
    ["Folder 缺少儲存區字串", "Folder storage string is missing"],
    [
      "Folder 的第一個參數必須是以引號括住的儲存區。",
      "Folder's first argument must be a quoted storage name.",
    ],
    [
      [
        '使用 "prjs" 表示內部儲存，或 "sd" 表示 SD 卡。',
        'Use "prjs" for internal storage or "sd" for the SD card.',
      ],
    ],
    "functions",
    ['Folder prjs "demo"', 'Folder "prjs" "demo"'],
  ),
  variant(
    "BP1050",
    "folder-directory",
    ["Folder 缺少資料夾名稱字串", "Folder directory string is missing"],
    [
      "Folder 的第二個參數必須是以引號括住的資料夾名稱。",
      "Folder's second argument must be a quoted directory name.",
    ],
    [
      [
        '在儲存區後加入單一資料夾名稱字串，例如 "demo"。',
        'After the storage name, add a quoted single directory name such as "demo".',
      ],
    ],
    "functions",
    ['Folder "prjs"', 'Folder "prjs" "demo"'],
  ),
  variant(
    "EV32003",
    "unknown-function",
    ["找不到要編譯的自訂函式", "User function to compile was not found"],
    [
      "呼叫引用的自訂函式未出現在後端的函式清單中。",
      "A called user function is absent from the backend's function list.",
    ],
    [
      [
        "檢查函式名稱、Include／Import 及宣告，再重新建置。",
        "Check the function name, Include/Import, and declaration, then rebuild.",
      ],
      reportStep,
    ],
    "functions",
  ),
  variant(
    "EV32003",
    "missing-argument",
    ["自訂函式缺少必要參數", "User function is missing a required argument"],
    [
      "後端呼叫沒有提供宣告中必要的參數。",
      "A backend call did not supply a parameter required by the declaration.",
    ],
    [
      [
        "依函式宣告補上所有參數，先修正 BP2004。",
        "Supply all declared arguments and resolve BP2004 first.",
      ],
      reportStep,
    ],
    "functions",
  ),
  variant(
    "EV32003",
    "out-variable",
    ["Out 參數必須是變數", "Out argument must be a variable"],
    [
      "Out 參數要寫入結果，不能使用常數或計算式作為接收位置。",
      "An Out parameter must write its result into a variable, not a constant or computed expression.",
    ],
    [
      [
        "宣告型別相符的變數，直接將變數名稱傳入 Out 參數。",
        "Declare a variable of the matching type and pass its name directly as the Out argument.",
      ],
    ],
    "functions",
  ),
  variant(
    "EV32003",
    "missing-return-target",
    ["函式結果缺少接收位置", "Function result has no destination"],
    [
      "會回傳值的函式呼叫沒有分配接收結果的位置。",
      "A value-returning function call has no allocated result destination.",
    ],
    [
      [
        "確認來源以有效方式使用函式結果，修正其他診斷後重新建置。",
        "Check that the source uses the function result correctly, resolve other diagnostics, and rebuild.",
      ],
      reportStep,
    ],
    "functions",
  ),
  variant(
    "EV32003",
    "unknown-retained-function",
    ["指定保留的函式不存在", "Requested retained function does not exist"],
    [
      "後端設定要求保留未出現在程式中的函式。",
      "Backend configuration requests retention of a function absent from the program.",
    ],
    [
      [
        "維護編譯整合時，修正 retainFunctions 的名稱或移除過期設定。",
        "When maintaining the compiler integration, correct retainFunctions names or remove stale entries.",
      ],
      reportStep,
    ],
    "architecture",
  ),
  variant(
    "EV32003",
    "unknown-entry-function",
    ["EV3 入口函式不存在", "EV3 entry function does not exist"],
    [
      "程式指定的入口函式沒有出現在後端輸入中。",
      "The designated program entry function is absent from the backend input.",
    ],
    [
      [
        "確認專案 entry 與前端輸出完整，修正其他診斷後重新建置。",
        "Check the project entry and complete frontend output, resolve other diagnostics, and rebuild.",
      ],
      reportStep,
    ],
    "architecture",
  ),
  variant(
    "EV32010",
    "legacy-motor-call",
    ["舊式馬達呼叫不受支援", "Legacy motor call is unsupported"],
    [
      "此舊式馬達名稱、埠組合或操作無法編譯為 EV3 指令。",
      "This legacy motor name, port combination, or operation cannot be compiled into EV3 instructions.",
    ],
    [
      [
        "對照馬達 API 的支援範圍，改用適當的 Motor 操作。",
        "Check supported motor APIs and use an appropriate Motor operation.",
      ],
    ],
    "motors",
  ),
  variant(
    "EV32010",
    "operation-not-lowered",
    ["API 尚無 EV3 實作", "API has no EV3 implementation"],
    [
      "操作雖已登錄在 API 目錄，但目前編譯路徑無法產生對應 EV3 指令。",
      "The operation is registered in the API catalog, but the current compilation path cannot generate EV3 instructions for it.",
    ],
    [
      [
        "查閱支援範圍並使用可編譯的替代操作；回報時附上操作名稱及最小範例。",
        "Check supported operations and use an implemented alternative; include the operation name and a minimal example when reporting.",
      ],
    ],
    "syntax",
  ),
];

const byCode = new Map(DIAGNOSTIC_HELP.map((help) => [help.code, help]));
const byVariant = new Map(
  DIAGNOSTIC_HELP_VARIANTS.map((help) => [`${help.code}:${help.helpKey}`, help]),
);

export function getDiagnosticHelp(code: string, helpKey?: string): DiagnosticHelp | undefined {
  return (helpKey ? byVariant.get(`${code}:${helpKey}`) : undefined) ?? byCode.get(code);
}

/** Accept known catalog identifiers only; callers cannot supply arbitrary external URLs. */
export function diagnosticDocumentationUrl(
  code: string,
  helpKey: string | undefined,
  locale: DiagnosticLocale,
): string | undefined {
  const help = getDiagnosticHelp(code, helpKey);
  if (!help || (locale !== "zh-TW" && locale !== "en")) return undefined;
  return `https://kobrixa.com/docs/diagnostics/${help.code}?lang=${locale}${help.helpKey ? `#${help.helpKey}` : ""}`;
}
