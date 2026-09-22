import { AppLink } from "../../components/app-link.js";
import { useSearchParams } from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  EV3_OPERATION_CATALOG,
  type EV3OperationSignature,
  type EV3ParameterType,
} from "@kobrixa/ir";
import type { DocsLocale } from "./docs-content.js";

type Props = { locale: DocsLocale; apiName?: string | undefined; syntaxSlug?: string | undefined };
type Syntax = {
  slug: string;
  title: Record<DocsLocale, string>;
  code: string;
  body: Record<DocsLocale, string>;
  lesson: string;
};
const t = {
  "zh-TW": {
    title: "Basic Plus 參考",
    intro: "所有 API 直接來自 Kobrixa 編譯器接受的 operation catalog。選擇一項以閱讀完整用法。",
    syntax: "語法與結構",
    api: "函數與屬性 catalog",
    search: "依名稱或分類篩選",
    all: "全部分類",
    empty: "沒有符合的項目。",
    description: "說明",
    returns: "回傳值",
    params: "參數",
    usage: "範例",
    copy: "複製",
    copied: "已複製",
    lesson: "相關課程",
    example: "可建置範例",
    clev3rHelp: "參考 Clev3r English Help",
    back: "返回 Basic Plus 索引",
    previous: "上一項",
    next: "下一項",
    related: "相關連結",
    missing: "找不到這個 Basic Plus 項目。",
  },
  en: {
    title: "Basic Plus reference",
    intro:
      "Every API comes directly from the operation catalog accepted by the Kobrixa compiler. Choose an item for its complete usage.",
    syntax: "Syntax and structure",
    api: "Function and property catalog",
    search: "Filter by name or category",
    all: "All categories",
    empty: "No items match.",
    description: "Description",
    returns: "Return value",
    params: "Parameters",
    usage: "Examples",
    copy: "Copy",
    copied: "Copied",
    lesson: "Related lesson",
    example: "Runnable example",
    clev3rHelp: "Reference: Clev3r English Help",
    back: "Back to Basic Plus index",
    previous: "Previous",
    next: "Next",
    related: "See also",
    missing: "This Basic Plus item could not be found.",
  },
} as const;
const labels = {
  motor: ["馬達", "Motors"],
  sensor: ["感測器", "Sensors"],
  display: ["顯示", "Display"],
  speaker: ["聲音", "Speaker"],
  button: ["按鍵", "Buttons"],
  file: ["檔案", "Files"],
  mailbox: ["信箱", "Mailboxes"],
  program: ["本體與執行期", "Brick and runtime"],
  math: ["數學", "Math"],
  utility: ["文字、資料與工具", "Text, data, and utilities"],
} as const;
const lesson = {
  motor: ["motors", "motors/motor-move"],
  sensor: ["sensors", "sensors/sensor-threshold"],
  display: ["feedback", "display/display-write"],
  speaker: ["feedback", "sound/speaker-scale"],
  button: ["feedback", "buttons/button-feedback"],
  file: ["data-files", "files/file-round-trip"],
  mailbox: ["communication", "mailboxes/mailbox-local"],
  program: ["brick-runtime", "program/brick-status"],
  math: ["values-and-logic", "language/text-and-math"],
  utility: ["data-files", "collections/row-vector"],
} as const;
export const syntaxEntries: readonly Syntax[] = [
  {
    slug: "variables-arrays",
    title: { "zh-TW": "變數與陣列", en: "Variables and arrays" },
    code: "Number count\nString name\nNumber[] readings",
    body: {
      "zh-TW": "使用 Number 或 String 宣告值；加上 [] 宣告陣列。",
      en: "Declare values with Number or String; add [] for an array.",
    },
    lesson: "values-and-logic",
  },
  {
    slug: "dim",
    title: { "zh-TW": "Dim", en: "Dim" },
    code: "Dim total\ntotal = 42",
    body: {
      "zh-TW": "Dim 是數值變數的可選宣告形式。",
      en: "Dim is an optional declaration form for a number variable.",
    },
    lesson: "values-and-logic",
  },
  {
    slug: "property",
    title: { "zh-TW": "Property", en: "Property" },
    code: "Property speed\nspeed = 35",
    body: {
      "zh-TW": "Property 宣告數值屬性；它不是 EV3 硬體 API。",
      en: "Property declares a numeric property; it is not an EV3 hardware API.",
    },
    lesson: "functions-projects",
  },
  {
    slug: "conditionals",
    title: { "zh-TW": "If / ElseIf / Else", en: "If / ElseIf / Else" },
    code: "If value > 0 Then\n  Speaker.Tone(25, 440, 80)\nElse\n  Speaker.Stop()\nEndIf",
    body: { "zh-TW": "依布林條件選擇分支。", en: "Choose a branch from a boolean condition." },
    lesson: "control-flow",
  },
  {
    slug: "loops",
    title: { "zh-TW": "For / While / Break / Continue", en: "For / While / Break / Continue" },
    code: "For step = 1 To 4\n  Program.Delay(50)\nEndFor",
    body: {
      "zh-TW": "重複有限工作；在迴圈內可使用 Break 或 Continue。",
      en: "Repeat bounded work; use Break or Continue inside a loop.",
    },
    lesson: "control-flow",
  },
  {
    slug: "functions",
    title: { "zh-TW": "Sub / Function / Return", en: "Sub / Function / Return" },
    code: "Function Double(In Number value)\n  Return value * 2\nEndFunction",
    body: {
      "zh-TW": "以 Sub 執行動作，以 Function 回傳計算結果。",
      en: "Use Sub for actions and Function for computed results.",
    },
    lesson: "functions-projects",
  },
  {
    slug: "project-files",
    title: { "zh-TW": "Include / Import / Module", en: "Include / Import / Module" },
    code: 'Include "settings"\nImport "helpers"',
    body: {
      "zh-TW": "載入專案相對的共用宣告或 .bpm 模組。",
      en: "Load project-relative shared declarations or a .bpm module.",
    },
    lesson: "functions-projects",
  },
  {
    slug: "labels",
    title: { "zh-TW": "Goto 與 Label", en: "Goto and Label" },
    code: "start:\nGoto finish\nfinish:",
    body: {
      "zh-TW": "可使用 Label 與 Goto，但通常以結構化流程更清楚。",
      en: "Labels and Goto are available, though structured flow is usually clearer.",
    },
    lesson: "control-flow",
  },
  {
    slug: "thread-run",
    title: { "zh-TW": "Thread.Run", en: "Thread.Run" },
    code: "Thread.Run = Update\nSub Update()\n  Thread.Yield()\nEndSub",
    body: {
      "zh-TW": "在背景啟動沒有參數的 Sub。",
      en: "Starts a parameterless Sub in the background.",
    },
    lesson: "communication",
  },
];
export const apiEntries = [...EV3_OPERATION_CATALOG.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);
export const apiRoute = (op: EV3OperationSignature) =>
  `/docs/reference/basic-plus/api/${op.name.toLocaleLowerCase("en-US")}`;
const clev3rHelpBase = "https://github.com/iCheh/Clev3r-1/blob/main/Clever/bin/Release/Help/en";
function clev3rHelpUrl(op: EV3OperationSignature): string {
  const namespace = op.name.split(".")[0] ?? "";
  const file = namespace === "Button" ? "Buttons" : namespace;
  return `${clev3rHelpBase}/${file}.xml`;
}
export const findApi = (name?: string) =>
  name ? EV3_OPERATION_CATALOG.get(decodeURIComponent(name).toLocaleLowerCase("en-US")) : undefined;
export const findSyntax = (slug?: string) => syntaxEntries.find((entry) => entry.slug === slug);
function typeName(value: EV3ParameterType | EV3OperationSignature["returns"]): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(" | ");
  return "element" in value ? `${value.element}[]` : value.join(" | ");
}
type Localized = Record<DocsLocale, string>;
const action = (zh: string, en: string): Localized => ({ "zh-TW": zh, en });
type ParameterInfo = { name: string; description: Localized; example: string };
const parameter = (name: string, zh: string, en: string, example: string): ParameterInfo => ({
  name,
  description: action(zh, en),
  example,
});
const parameterGlossary: Record<string, Omit<ParameterInfo, "name">> = {
  ports: {
    description: action(
      "要控制的馬達連接埠字串，例如 `A` 或 `AD`。",
      "Motor port string to control, such as `A` or `AD`.",
    ),
    example: '"AD"',
  },
  speed: {
    description: action(
      "馬達速度；負值代表反向。",
      "Motor speed; a negative value reverses direction.",
    ),
    example: "25",
  },
  power: {
    description: action(
      "馬達功率；負值代表反向。",
      "Motor power; a negative value reverses direction.",
    ),
    example: "25",
  },
  brake: {
    description: action("動作完成時是否煞車。", "Whether to brake when the action ends."),
    example: "True",
  },
  degrees: {
    description: action("馬達要轉動的角度。", "Motor rotation in degrees."),
    example: "360",
  },
  rampUp: {
    description: action("加速階段的馬達角度。", "Motor rotation used for the acceleration ramp."),
    example: "60",
  },
  rampDown: {
    description: action("減速階段的馬達角度。", "Motor rotation used for the deceleration ramp."),
    example: "60",
  },
  turn: {
    description: action("兩顆馬達之間的轉向比例。", "Steering ratio between the two motors."),
    example: "0",
  },
  leftSpeed: {
    description: action(
      "同步組合中第一顆馬達的速度。",
      "Speed for the first motor in a synchronized pair.",
    ),
    example: "25",
  },
  rightSpeed: {
    description: action(
      "同步組合中第二顆馬達的速度。",
      "Speed for the second motor in a synchronized pair.",
    ),
    example: "25",
  },
  port: {
    description: action("EV3 感測器連接埠，從 1 起算。", "EV3 sensor port, numbered from 1."),
    example: "1",
  },
  mode: { description: action("感測器讀取模式。", "Sensor reading mode."), example: "0" },
  valueIndex: {
    description: action("原始感測器資料通道索引。", "Raw sensor data channel index."),
    example: "0",
  },
  deviceAddress: { description: action("I²C 裝置位址。", "I²C device address."), example: "2" },
  register: { description: action("I²C 暫存器位址。", "I²C register address."), example: "0" },
  length: {
    description: action("要讀取或寫入的資料長度。", "Amount of data to read or write."),
    example: "1",
  },
  data: {
    description: action("要傳送、寫入或剖析的資料。", "Data to send, write, or parse."),
    example: "values",
  },
  handle: {
    description: action(
      "識別已開啟資源或資料結構的控制代號。",
      "Handle that identifies an open resource or data structure.",
    ),
    example: "handle",
  },
  fileName: {
    description: action("EV3 上的檔案名稱或路徑。", "File name or path on the EV3."),
    example: '"data.txt"',
  },
  text: {
    description: action(
      "要讀取、轉換或寫入的來源文字。",
      "Source text to read, transform, or write.",
    ),
    example: '"Hello"',
  },
  byte: {
    description: action("要讀取、寫入或處理的位元組值。", "Byte value to read, write, or process."),
    example: "42",
  },
  mailboxName: {
    description: action("本機 mailbox 的名稱。", "Name of the local mailbox."),
    example: '"status"',
  },
  target: {
    description: action(
      "訊息要傳送到的 mailbox 或目標名稱。",
      "Mailbox or target name that receives the message.",
    ),
    example: '"peer"',
  },
  message: {
    description: action("要傳送或驗證的文字訊息。", "Text message to send or verify."),
    example: '"Hello"',
  },
  number: {
    description: action(
      "作為運算或訊息內容傳入的數值。",
      "Number supplied as an operand or message payload.",
    ),
    example: "0",
  },
  milliseconds: {
    description: action("等待的毫秒數。", "Number of milliseconds to wait."),
    example: "100",
  },
  argumentIndex: {
    description: action(
      "程式啟動參數的零起始索引。",
      "Zero-based index of a program start argument.",
    ),
    example: "0",
  },
  color: {
    description: action(
      "繪製或狀態燈使用的顏色；LCD 通常 0 為白、1 為黑。",
      "Color for drawing or the status LED; LCD normally uses 0 for white and 1 for black.",
    ),
    example: "1",
  },
  x: { description: action("水平像素座標。", "Horizontal pixel coordinate."), example: "16" },
  y: { description: action("垂直像素座標。", "Vertical pixel coordinate."), example: "48" },
  width: { description: action("範圍寬度（像素）。", "Range width in pixels."), example: "42" },
  height: { description: action("範圍高度（像素）。", "Range height in pixels."), example: "20" },
  radius: { description: action("圓形半徑（像素）。", "Circle radius in pixels."), example: "20" },
  font: { description: action("EV3 字型索引。", "EV3 font index."), example: "1" },
  frequency: { description: action("音調頻率（Hz）。", "Tone frequency in Hz."), example: "440" },
  duration: {
    description: action(
      "播放或動作持續時間（毫秒）。",
      "Playback or action duration in milliseconds.",
    ),
    example: "200",
  },
  volume: { description: action("EV3 喇叭音量。", "EV3 speaker volume."), example: "25" },
  button: {
    description: action("要檢查的 EV3 按鍵名稱。", "Name of the EV3 button to check."),
    example: '"Enter"',
  },
  mutexHandle: {
    description: action(
      "由 `Thread.CreateMutex` 建立的 mutex 控制代號。",
      "Mutex handle created by `Thread.CreateMutex`.",
    ),
    example: "mutex",
  },
  row: {
    description: action("要操作的 Row 控制代號或資料。", "Row handle or data to operate on."),
    example: "row",
  },
  vector: {
    description: action("要操作的 Vector 資料。", "Vector data to operate on."),
    example: "values",
  },
  index: {
    description: action("資料集合的零起始索引。", "Zero-based index in a data collection."),
    example: "0",
  },
  size: {
    description: action("資料集合的目標大小。", "Target size of the data collection."),
    example: "4",
  },
  initialValue: {
    description: action(
      "新集合每個元素的初始數值。",
      "Initial value for each element in a new collection.",
    ),
    example: "0",
  },
  left: {
    description: action("比較或運算的第一個值。", "First value in a comparison or operation."),
    example: "1",
  },
  right: {
    description: action("比較或運算的第二個值。", "Second value in a comparison or operation."),
    example: "2",
  },
  tolerance: {
    description: action(
      "判定兩值接近時允許的誤差。",
      "Allowed difference when comparing near values.",
    ),
    example: "0.01",
  },
  factor: {
    description: action("向量運算使用的倍率或係數。", "Factor used by the vector operation."),
    example: "2",
  },
  value: {
    description: action(
      "要設定、寫入或計算的數值。",
      "Numeric value to set, write, or calculate with.",
    ),
    example: "0",
  },
  enabled: {
    description: action("控制這個操作的布林開關。", "Boolean switch controlling this operation."),
    example: "True",
  },
  values: {
    description: action("提供給 API 的數值陣列。", "Numeric array supplied to the API."),
    example: "values",
  },
};
function parameterByName(name: string): ParameterInfo {
  const item = parameterGlossary[name];
  if (!item) throw new Error(`Basic Plus parameter glossary is missing '${name}'.`);
  return { name, ...item };
}
const operationParameterDescriptions: Record<string, Localized> = {
  "Motor.GetCount.port": action(
    "要讀取編碼器計數的單一馬達連接埠，例如 `A`。",
    "Single motor port whose encoder count is read, such as `A`.",
  ),
  "Motor.GetSpeed.port": action(
    "要讀取目前速度的單一馬達連接埠，例如 `A`。",
    "Single motor port whose current speed is read, such as `A`.",
  ),
  "Sensor.ReadRaw.values": action(
    "要讀回的原始數值個數；結果會依這個數量組成陣列。",
    "Number of raw values to read; it determines the size of the returned array.",
  ),
  "Sensor.ReadRawValue.index": action(
    "要取出的原始資料通道索引，從 0 起算。",
    "Zero-based raw-data channel index to return.",
  ),
  "Sensor.SetMode.mode": action(
    "要切換至的感測器模式代碼；切換後應等待感測器完成設定。",
    "Sensor mode code to select; wait for the sensor after changing it.",
  ),
  "Sensor.CommunicateI2C.address": action(
    "7 位元 I²C 裝置位址，範圍為 0–127。",
    "7-bit I²C device address, in the range 0–127.",
  ),
  "Sensor.CommunicateI2C.writebytes": action(
    "先寫入裝置的位元組數，最多 31 個。",
    "Number of bytes to write first, up to 31.",
  ),
  "Sensor.CommunicateI2C.readbytes": action(
    "接著要從裝置讀回的位元組數。",
    "Number of bytes to read back from the device.",
  ),
  "Sensor.CommunicateI2C.writedata": action(
    "I²C 寫入階段的資料陣列；只會使用 `writebytes` 指定的前幾個元素。",
    "Data array for the I²C write phase; only the first `writebytes` elements are used.",
  ),
  "Sensor.ReadI2CRegisters.readbytes": action(
    "從起始暫存器連續讀取的位元組數。",
    "Number of consecutive bytes to read from the starting register.",
  ),
  "Sensor.WriteI2CRegisters.writebytes": action(
    "從起始暫存器開始連續寫入的位元組數。",
    "Number of consecutive bytes to write starting at the register.",
  ),
  "Sensor.WriteI2CRegisters.writedata": action(
    "要依序寫入暫存器的資料陣列。",
    "Data array written to consecutive registers in order.",
  ),
  "Sensor.SendUARTData.writebytes": action(
    "要透過 UART 傳送的位元組數，最多 32 個。",
    "Number of bytes to send over UART, up to 32.",
  ),
  "Sensor.SendUARTData.writedata": action(
    "UART 傳送資料；只會使用 `writebytes` 指定的前幾個元素。",
    "UART payload; only the first `writebytes` elements are sent.",
  ),
  "EV3File.WriteByte.data": action(
    "要寫入檔案的一個位元組資料值。",
    "Single byte value to write to the file.",
  ),
  "EV3File.WriteLine.text": action(
    "要寫入檔案的一整行文字；此操作會附加換行。",
    "One line of text to write to the file; the operation appends its line ending.",
  ),
  "EV3File.ReadNumberArray.size": action(
    "要從檔案讀出的數值個數。",
    "Number of numeric values to read from the file.",
  ),
  "EV3File.WriteNumberArray.size": action(
    "要從資料陣列寫入檔案的數值個數。",
    "Number of numeric values to write from the data array.",
  ),
  "EV3File.WriteNumberArray.data": action(
    "包含待寫入數值的陣列；只會寫入前 `size` 個元素。",
    "Array containing values to write; only its first `size` elements are written.",
  ),
  "EV3File.TableLookup.bytes_per_row": action(
    "表格檔案中每一列的固定位元組寬度。",
    "Fixed byte width of each row in the table file.",
  ),
  "EV3File.TableLookup.row": action("要查找的零起始列索引。", "Zero-based row index to look up."),
  "EV3File.TableLookup.column": action(
    "該列內的零起始位元組偏移。",
    "Zero-based byte offset within that row.",
  ),
  "Program.GetArgument.index": action(
    "要讀取的零起始命令列參數索引。",
    "Zero-based command-line argument index to read.",
  ),
  "Mailbox.SendNumber.number": action(
    "要傳到指定 mailbox 的數值訊息。",
    "Numeric message sent to the specified mailbox.",
  ),
  "Byte.NOT.value": action("要做位元反相的整數值。", "Integer value whose bits are inverted."),
  "Byte.ToLogic.value": action(
    "要轉成布林結果的數值；零為 False，非零為 True。",
    "Numeric value converted to Boolean; zero is False and non-zero is True.",
  ),
  "Byte.BIT.value": action(
    "要讀取其中一個位元的整數值。",
    "Integer value from which one bit is read.",
  ),
  "Byte.BIT.index": action("要讀取的零起始位元位置。", "Zero-based bit position to read."),
  "Byte.SHL.value": action("要向左移位的整數值。", "Integer value shifted left."),
  "Byte.SHR.value": action("要向右移位的整數值。", "Integer value shifted right."),
  "Text.GetCharacter.characterCode": action(
    "要轉成單一字元的數字字碼。",
    "Numeric character code to convert into one character.",
  ),
  "Text.GetLength.text": action("要計算長度的來源文字。", "Source text whose length is returned."),
  "Text.GetCharacterCode.character": action(
    "要取得字碼的單一字元。",
    "Single character whose numeric code is returned.",
  ),
  "Text.IsSubText.text": action("要搜尋的完整來源文字。", "Full source text to search."),
  "Text.IsSubText.subText": action(
    "要在來源文字中尋找的文字片段。",
    "Text fragment to search for in the source text.",
  ),
  "Text.EndsWith.text": action("要檢查結尾的來源文字。", "Source text whose ending is checked."),
  "Text.EndsWith.subText": action(
    "預期出現在結尾的文字片段。",
    "Text fragment expected at the end.",
  ),
  "Text.StartsWith.text": action(
    "要檢查開頭的來源文字。",
    "Source text whose beginning is checked.",
  ),
  "Text.StartsWith.subText": action(
    "預期出現在開頭的文字片段。",
    "Text fragment expected at the start.",
  ),
  "Text.GetIndexOf.text": action("要搜尋的完整來源文字。", "Full source text to search."),
  "Text.GetIndexOf.subText": action(
    "要找出位置的文字片段。",
    "Text fragment whose position is returned.",
  ),
  "Text.ConvertToLowerCase.text": action(
    "要轉成小寫的來源文字。",
    "Source text converted to lowercase.",
  ),
  "Text.ConvertToUpperCase.text": action(
    "要轉成大寫的來源文字。",
    "Source text converted to uppercase.",
  ),
  "Text.GetSubText.start": action(
    "要擷取文字的零起始開始位置。",
    "Zero-based starting position of the text to extract.",
  ),
  "Text.GetSubText.length": action(
    "從 `start` 開始要擷取的字元數。",
    "Number of characters to extract starting at `start`.",
  ),
  "Text.GetSubTextToEnd.start": action(
    "擷取到文字結尾前的零起始開始位置。",
    "Zero-based starting position for extraction through the end of the text.",
  ),
  "Row.Init.value": action(
    "新 Row 內每個元素的初始數值。",
    "Initial numeric value for every element of the new Row.",
  ),
  "Row.Delete.handle": action(
    "由 `Row.Init` 回傳、識別一維陣列的控制代號。",
    "Handle returned by `Row.Init` that identifies the one-dimensional array.",
  ),
  "Row.Read.handle": action(
    "由 `Row.Init` 回傳、要讀取的一維陣列控制代號。",
    "Handle returned by `Row.Init` for the one-dimensional array to read.",
  ),
  "Row.Write.handle": action(
    "由 `Row.Init` 回傳、要寫入的一維陣列控制代號。",
    "Handle returned by `Row.Init` for the one-dimensional array to write.",
  ),
  "Row.Size.handle": action(
    "由 `Row.Init` 回傳、要取得大小的一維陣列控制代號。",
    "Handle returned by `Row.Init` for the one-dimensional array whose size is returned.",
  ),
  "Row.Resize.handle": action(
    "由 `Row.Init` 回傳、要調整大小的一維陣列控制代號。",
    "Handle returned by `Row.Init` for the one-dimensional array to resize.",
  ),
  "Row.Resize.size": action(
    "調整後的一維陣列元素數。",
    "Number of elements in the resized one-dimensional array.",
  ),
  "Row.Write.value": action(
    "要寫入指定 Row 索引的數值或文字。",
    "Numeric or text value written at the specified Row index.",
  ),
  "Vector.Init.value": action(
    "新向量內每個元素的初始數值。",
    "Initial numeric value for every element of the new vector.",
  ),
  "Vector.Data.data": action(
    "以空白分隔的十進位數字文字，用來建立向量。",
    "Space-separated decimal-number text used to construct the vector.",
  ),
  "Vector.Add.size": action(
    "兩個輸入向量要相加的元素數。",
    "Number of elements added from the two input vectors.",
  ),
  "Vector.Sort.size": action("要排序的向量元素數。", "Number of vector elements to sort."),
  "Vector.Multiply.rows": action("左矩陣的列數。", "Number of rows in the left matrix."),
  "Vector.Multiply.columns": action("右矩陣的欄數。", "Number of columns in the right matrix."),
  "Vector.Multiply.k": action(
    "左矩陣欄數、也是右矩陣列數的共同內部維度。",
    "Shared inner dimension: columns of A and rows of B.",
  ),
  "Assert.Failed.message": action(
    "斷言失敗時顯示的診斷訊息。",
    "Diagnostic message reported when the assertion fails.",
  ),
  "Assert.Equal.a": action(
    "要比較的第一個（實際或左側）值。",
    "First (actual or left-hand) value to compare.",
  ),
  "Assert.Equal.b": action(
    "要比較的第二個（預期或右側）值。",
    "Second (expected or right-hand) value to compare.",
  ),
};
function describeParameterForOperation(
  op: EV3OperationSignature,
  info: ParameterInfo,
): ParameterInfo {
  const description = operationParameterDescriptions[`${op.name}.${info.name}`];
  return description ? { ...info, description } : info;
}
Object.assign(parameterGlossary, {
  upperBound: {
    description: action("隨機整數的包含上限。", "Inclusive upper bound for a random integer."),
    example: "100",
  },
  command: {
    description: action(
      "要交給 EV3 系統執行的命令文字。",
      "Command text for the EV3 system to execute.",
    ),
    example: '"command"',
  },
  ledColor: {
    description: action("EV3 狀態燈的顏色值。", "Color value for the EV3 status LED."),
    example: '"Green"',
  },
  ledMode: {
    description: action("EV3 狀態燈的顯示模式。", "Display mode for the EV3 status LED."),
    example: '"On"',
  },
  writeLength: {
    description: action("I²C 傳送階段的位元組數。", "Number of bytes in the I²C write phase."),
    example: "1",
  },
  readLength: {
    description: action("I²C 接收階段的位元組數。", "Number of bytes in the I²C read phase."),
    example: "1",
  },
  payload: {
    description: action(
      "要傳送給感測器的 I²C 或 UART 資料。",
      "I²C or UART data to send to the sensor.",
    ),
    example: "values",
  },
  rawValue1: {
    description: action("第一個原始感測器值。", "First raw sensor value."),
    example: "0",
  },
  rawValue2: {
    description: action("第二個原始感測器值。", "Second raw sensor value."),
    example: "0",
  },
  rawValue3: {
    description: action("第三個原始感測器值。", "Third raw sensor value."),
    example: "0",
  },
  soundFile: {
    description: action("EV3 上要播放的音效檔。", "Sound file to play on the EV3."),
    example: '"sound"',
  },
  note: { description: action("要播放的音符名稱。", "Name of the note to play."), example: '"C4"' },
  searchText: {
    description: action(
      "要在來源文字中尋找的文字片段。",
      "Text fragment to look for in the source text.",
    ),
    example: '"bot"',
  },
  sourceText: {
    description: action("要處理的來源文字。", "Source text to process."),
    example: '"Kobrixa"',
  },
  subText: {
    description: action(
      "要在來源文字中比對、尋找的文字片段。",
      "Text fragment compared with or searched for in source text.",
    ),
    example: '"bot"',
  },
  startIndex: {
    description: action(
      "文字或資料範圍的零起始開始位置。",
      "Zero-based start position of a text or data range.",
    ),
    example: "0",
  },
  itemCount: {
    description: action(
      "要讀取、寫入或擷取的項目數。",
      "Number of items to read, write, or extract.",
    ),
    example: "1",
  },
  byteIndex: { description: action("要讀取的位元位置。", "Bit position to read."), example: "0" },
  shiftCount: {
    description: action("位元要左移或右移的位數。", "Number of bit positions to shift."),
    example: "1",
  },
  base: {
    description: action(
      "資料格式或轉換使用的進位基底。",
      "Radix used by a data format or conversion.",
    ),
    example: "10",
  },
  characterCode: {
    description: action("要轉為字元的字碼。", "Character code to convert into a character."),
    example: "65",
  },
  rows: {
    description: action("左矩陣的列數。", "Number of rows in the left matrix."),
    example: "2",
  },
  columns: {
    description: action("右矩陣的欄數。", "Number of columns in the right matrix."),
    example: "2",
  },
  sharedSize: {
    description: action(
      "兩矩陣相乘時共用的內部維度。",
      "Shared inner dimension for matrix multiplication.",
    ),
    example: "2",
  },
  leftMatrix: {
    description: action("左側矩陣的展平數值陣列。", "Flattened numeric array for the left matrix."),
    example: "left",
  },
  rightMatrix: {
    description: action(
      "右側矩陣的展平數值陣列。",
      "Flattened numeric array for the right matrix.",
    ),
    example: "right",
  },
});
Object.assign(parameterGlossary, {
  effect: {
    description: action(
      "EV3 狀態燈效果：`NORMAL`、`FLASH` 或 `PULSE`。",
      "EV3 LED effect: `NORMAL`, `FLASH`, or `PULSE`.",
    ),
    example: '"NORMAL"',
  },
  commandline: {
    description: action(
      "交給 EV3 Linux 命令殼執行的完整命令列。",
      "Full command line executed by the EV3 Linux command shell.",
    ),
    example: '"ls"',
  },
  speed1: {
    description: action(
      "兩馬達中較低連接埠字母馬達的速度。",
      "Speed for the motor with the lower port letter.",
    ),
    example: "25",
  },
  speed2: {
    description: action(
      "兩馬達中較高連接埠字母馬達的速度。",
      "Speed for the motor with the higher port letter.",
    ),
    example: "25",
  },
  degrees1: {
    description: action("馬達加速階段的轉動角度。", "Rotation in the acceleration phase."),
    example: "60",
  },
  degrees2: {
    description: action("馬達等速階段的轉動角度。", "Rotation in the constant-speed phase."),
    example: "360",
  },
  degrees3: {
    description: action("馬達減速階段的轉動角度。", "Rotation in the deceleration phase."),
    example: "60",
  },
  address: { description: action("I²C 裝置位址。", "I²C device address."), example: "2" },
  writebytes: {
    description: action("傳送到感測器的位元組數。", "Number of bytes written to the sensor."),
    example: "1",
  },
  readbytes: {
    description: action("從感測器讀取的位元組數。", "Number of bytes read from the sensor."),
    example: "1",
  },
  writedata: {
    description: action(
      "要傳送到感測器的 I²C 或 UART 資料。",
      "I²C or UART data to send to the sensor.",
    ),
    example: "values",
  },
  registernumber: { description: action("I²C 暫存器編號。", "I²C register number."), example: "0" },
  filename: {
    description: action("EV3 上的檔案名稱或路徑。", "File name or path on the EV3."),
    example: '"data.txt"',
  },
  bytes_per_row: {
    description: action("表格每一列使用的位元組數。", "Number of bytes in each table row."),
    example: "4",
  },
  row: { description: action("要查找的表格列索引。", "Table row index to look up."), example: "0" },
  column: {
    description: action("要查找的表格欄偏移。", "Table column offset to look up."),
    example: "0",
  },
  boxname: {
    description: action("本機 mailbox 的名稱。", "Name of the local mailbox."),
    example: '"status"',
  },
  brickname: {
    description: action(
      "目標 EV3 本體或 mailbox 端點名稱。",
      "Name of the target EV3 brick or mailbox endpoint.",
    ),
    example: '"EV3"',
  },
  id: {
    description: action(
      "建立 mailbox 時取得的 mailbox 控制代號。",
      "Mailbox handle returned when the mailbox was created.",
    ),
    example: "mailbox",
  },
  milliSeconds: {
    description: action("程式要暫停的毫秒數。", "Number of milliseconds for the program to pause."),
    example: "100",
  },
  maxNumber: {
    description: action("隨機整數可取的最大值。", "Largest possible random integer."),
    example: "100",
  },
  number: {
    description: action(
      "數學函式使用的輸入數值。",
      "Input number used by the mathematical function.",
    ),
    example: "2",
  },
  angle: {
    description: action("以弧度表示的角度。", "Angle expressed in radians."),
    example: "1.57",
  },
  sinValue: {
    description: action("介於 -1 與 1 的正弦值。", "Sine value between -1 and 1."),
    example: "0.5",
  },
  cosValue: {
    description: action("介於 -1 與 1 的餘弦值。", "Cosine value between -1 and 1."),
    example: "0.5",
  },
  tanValue: {
    description: action("要取得反正切的正切值。", "Tangent value used to obtain an arctangent."),
    example: "1",
  },
  baseNumber: {
    description: action("冪次運算的底數。", "Base number for exponentiation."),
    example: "2",
  },
  exponent: {
    description: action("冪次運算的指數。", "Exponent for exponentiation."),
    example: "3",
  },
  number1: {
    description: action("比較或運算的第一個數值。", "First number in the comparison or operation."),
    example: "1",
  },
  number2: {
    description: action(
      "比較或運算的第二個數值。",
      "Second number in the comparison or operation.",
    ),
    example: "2",
  },
  dividend: { description: action("要被除的數值。", "Number to be divided."), example: "7" },
  divisor: {
    description: action("用來除的數值。", "Number that divides the dividend."),
    example: "3",
  },
  a: {
    description: action(
      "比較、位元運算或向量運算的第一個值。",
      "First value in a comparison, bitwise, or vector operation.",
    ),
    example: "1",
  },
  b: {
    description: action(
      "比較、位元運算或向量運算的第二個值。",
      "Second value in a comparison, bitwise, or vector operation.",
    ),
    example: "2",
  },
  distance: {
    description: action("要移動的位元距離。", "Number of bit positions to shift."),
    example: "1",
  },
  text1: {
    description: action("要串接的第一段文字。", "First text value to append."),
    example: '"Kob"',
  },
  text2: {
    description: action("要串接的第二段文字。", "Second text value to append."),
    example: '"rixa"',
  },
  character: {
    description: action("要取得字碼的單一字元。", "Single character whose code is returned."),
    example: '"A"',
  },
  start: {
    description: action("文字範圍的零起始開始位置。", "Zero-based start position of a text range."),
    example: "0",
  },
  mutex: {
    description: action(
      "由 `Thread.CreateMutex` 建立的 mutex 控制代號。",
      "Mutex handle created by `Thread.CreateMutex`.",
    ),
    example: "mutex",
  },
  A: {
    description: action(
      "向量或矩陣運算的第一個資料陣列。",
      "First data array in a vector or matrix operation.",
    ),
    example: "left",
  },
  B: {
    description: action(
      "向量或矩陣運算的第二個資料陣列。",
      "Second data array in a vector or matrix operation.",
    ),
    example: "right",
  },
  k: {
    description: action(
      "矩陣相乘時共用的內部維度。",
      "Shared inner dimension for matrix multiplication.",
    ),
    example: "2",
  },
  var1: {
    description: action(
      "寫入第一個感測器原始讀值的變數。",
      "Variable that receives the first raw sensor value.",
    ),
    example: "raw1",
  },
  var2: {
    description: action(
      "寫入第二個感測器原始讀值的變數。",
      "Variable that receives the second raw sensor value.",
    ),
    example: "raw2",
  },
  var3: {
    description: action(
      "寫入第三個感測器原始讀值的變數。",
      "Variable that receives the third raw sensor value.",
    ),
    example: "raw3",
  },
});
function parameterInfo(
  op: EV3OperationSignature,
  value: EV3ParameterType,
  index: number,
): ParameterInfo {
  const type = Array.isArray(value) ? value[0]! : value;
  const displayFields: Record<string, string[]> = {
    "LCD.Pixel": ["color", "x", "y"],
    "LCD.Write": ["x", "y", "text"],
    "LCD.Text": ["color", "x", "y", "font", "text"],
    "LCD.Line": ["color", "x1", "y1", "x2", "y2"],
    "LCD.Circle": ["color", "x", "y", "radius"],
    "LCD.FillCircle": ["color", "x", "y", "radius"],
    "LCD.Rect": ["color", "x", "y", "width", "height"],
    "LCD.FillRect": ["color", "x", "y", "width", "height"],
    "LCD.InverseRect": ["x", "y", "width", "height"],
    "LCD.BmpFile": ["color", "x", "y", "fileName"],
  };
  const displayField = displayFields[op.name]?.[index];
  if (displayField) {
    const details: Record<string, Localized> = {
      color: action(
        "繪製顏色；通常 0 為白、1 為黑。",
        "Drawing color; normally 0 is white and 1 is black.",
      ),
      x: action(
        "左上角、像素或圓心的水平座標。",
        "Horizontal coordinate of the point, top-left corner, or centre.",
      ),
      y: action(
        "左上角、像素或圓心的垂直座標。",
        "Vertical coordinate of the point, top-left corner, or centre.",
      ),
      x1: action("線段起點的水平座標。", "Line start horizontal coordinate."),
      y1: action("線段起點的垂直座標。", "Line start vertical coordinate."),
      x2: action("線段終點的水平座標。", "Line end horizontal coordinate."),
      y2: action("線段終點的垂直座標。", "Line end vertical coordinate."),
      width: action("矩形範圍的寬度（像素）。", "Rectangle width in pixels."),
      height: action("矩形範圍的高度（像素）。", "Rectangle height in pixels."),
      radius: action("圓形半徑（像素）。", "Circle radius in pixels."),
      font: action("EV3 字型索引。", "EV3 font index."),
      text: action("要顯示的文字或數值。", "Text or value to display."),
      fileName: action("EV3 上的 BMP 檔路徑。", "BMP path on the EV3."),
    };
    const examples: Record<string, string> = {
      color: "1",
      x: "16",
      y: "48",
      x1: "8",
      y1: "18",
      x2: "165",
      y2: "18",
      width: "42",
      height: "20",
      radius: "20",
      font: "1",
      text: '"Hello"',
      fileName: '"image"',
    };
    return {
      name: displayField,
      description: details[displayField]!,
      example: examples[displayField]!,
    };
  }
  const directNames: Record<string, string[]> = {
    "EV3.SetLEDColor": ["color", "effect"],
    "EV3.SystemCall": ["commandline"],
    "Motor.Start": ["ports", "speed"],
    "Motor.StartPower": ["ports", "power"],
    "Motor.StartSteer": ["ports", "speed", "turn"],
    "Motor.StartSync": ["ports", "speed1", "speed2"],
    "Motor.Stop": ["ports", "brake"],
    "Motor.Move": ["ports", "speed", "degrees", "brake"],
    "Motor.MovePower": ["ports", "power", "degrees", "brake"],
    "Motor.Schedule": ["ports", "speed", "degrees1", "degrees2", "degrees3", "brake"],
    "Motor.SchedulePower": ["ports", "power", "degrees1", "degrees2", "degrees3", "brake"],
    "Motor.ScheduleSteer": ["ports", "speed", "turn", "degrees", "brake"],
    "Motor.ScheduleSync": ["ports", "speed1", "speed2", "degrees", "brake"],
    "Motor.MoveSteer": ["ports", "speed", "turn", "degrees", "brake"],
    "Motor.MoveSync": ["ports", "speed1", "speed2", "degrees", "brake"],
    "Motor.ResetCount": ["ports"],
    "Motor.IsBusy": ["ports"],
    "Motor.Wait": ["ports"],
    "Motor.Invert": ["ports"],
    "Motor.GetCount": ["port"],
    "Motor.GetSpeed": ["port"],
    "Sensor.ReadPercent": ["port"],
    "Sensor.GetName": ["port"],
    "Sensor.GetType": ["port"],
    "Sensor.GetMode": ["port"],
    "Sensor.IsBusy": ["port"],
    "Sensor.ReadRaw": ["port", "values"],
    "Sensor.ReadRawValue": ["port", "index"],
    "Sensor.SetMode": ["port", "mode"],
    "Sensor.Wait": ["port"],
    "Sensor.CommunicateI2C": ["port", "address", "writebytes", "readbytes", "writedata"],
    "Sensor.ReadI2CRegister": ["port", "address", "registernumber"],
    "Sensor.ReadI2CRegisters": ["port", "address", "registernumber", "readbytes"],
    "Sensor.WriteI2CRegister": ["port", "address", "registernumber", "value"],
    "Sensor.WriteI2CRegisters": ["port", "address", "registernumber", "writebytes", "writedata"],
    "Sensor.SendUARTData": ["port", "writebytes", "writedata"],
    "Speaker.Tone": ["volume", "frequency", "duration"],
    "Speaker.Play": ["volume", "soundFile"],
    "Speaker.Note": ["volume", "note", "duration"],
    "Button.IsPressed": ["button"],
    "EV3File.OpenRead": ["filename"],
    "EV3File.OpenWrite": ["filename"],
    "EV3File.OpenAppend": ["filename"],
    "EV3File.Close": ["handle"],
    "EV3File.ReadLine": ["handle"],
    "EV3File.WriteLine": ["handle", "text"],
    "EV3File.ReadByte": ["handle"],
    "EV3File.WriteByte": ["handle", "data"],
    "EV3File.ConvertToNumber": ["text"],
    "EV3File.ReadNumberArray": ["handle", "size"],
    "EV3File.WriteNumberArray": ["handle", "size", "data"],
    "EV3File.TableLookup": ["filename", "bytes_per_row", "row", "column"],
    "Mailbox.Create": ["boxname"],
    "Mailbox.CreateForNumber": ["boxname"],
    "Mailbox.Send": ["brickname", "boxname", "message"],
    "Mailbox.SendNumber": ["brickname", "boxname", "number"],
    "Mailbox.Receive": ["id"],
    "Mailbox.ReceiveNumber": ["id"],
    "Mailbox.IsAvailable": ["id"],
    "Mailbox.Connect": ["brickname"],
    "Program.Delay": ["milliSeconds"],
    "Program.GetArgument": ["index"],
    "Math.GetRandomNumber": ["maxNumber"],
    "Math.Abs": ["number"],
    "Math.Ceiling": ["number"],
    "Math.Floor": ["number"],
    "Math.NaturalLog": ["number"],
    "Math.Log": ["number"],
    "Math.Cos": ["angle"],
    "Math.Sin": ["angle"],
    "Math.Tan": ["angle"],
    "Math.ArcSin": ["sinValue"],
    "Math.ArcCos": ["cosValue"],
    "Math.ArcTan": ["tanValue"],
    "Math.GetDegrees": ["angle"],
    "Math.GetRadians": ["angle"],
    "Math.SquareRoot": ["number"],
    "Math.Round": ["number"],
    "Math.DoubleToDecimal": ["number"],
    "Math.Power": ["baseNumber", "exponent"],
    "Math.Max": ["number1", "number2"],
    "Math.Min": ["number1", "number2"],
    "Math.Remainder": ["dividend", "divisor"],
    "Byte.NOT": ["value"],
    "Byte.ToLogic": ["value"],
    "Byte.AND_": ["a", "b"],
    "Byte.OR_": ["a", "b"],
    "Byte.XOR": ["a", "b"],
    "Byte.BIT": ["value", "index"],
    "Byte.SHL": ["value", "distance"],
    "Byte.SHR": ["value", "distance"],
    "Byte.H": ["value"],
    "Byte.B": ["value"],
    "Byte.L": ["value"],
    "Byte.ToHex": ["value"],
    "Byte.ToBinary": ["value"],
    "Text.Append": ["text1", "text2"],
    "Text.GetLength": ["text"],
    "Text.GetCharacter": ["characterCode"],
    "Text.GetCharacterCode": ["character"],
    "Text.IsSubText": ["text", "subText"],
    "Text.EndsWith": ["text", "subText"],
    "Text.StartsWith": ["text", "subText"],
    "Text.GetSubText": ["text", "start", "length"],
    "Text.GetSubTextToEnd": ["text", "start"],
    "Text.GetIndexOf": ["text", "subText"],
    "Text.ConvertToLowerCase": ["text"],
    "Text.ConvertToUpperCase": ["text"],
    "Thread.Lock": ["mutex"],
    "Thread.Unlock": ["mutex"],
    "Row.Init": ["size", "value"],
    "Row.Delete": ["handle"],
    "Row.Read": ["handle", "index"],
    "Row.Write": ["handle", "index", "value"],
    "Row.Size": ["handle"],
    "Row.Resize": ["handle", "size"],
    "Vector.Init": ["size", "value"],
    "Vector.Data": ["size", "data"],
    "Vector.Add": ["size", "A", "B"],
    "Vector.Sort": ["size", "A"],
    "Vector.Multiply": ["rows", "columns", "k", "A", "B"],
    "Assert.Failed": ["message"],
    "Assert.Equal": ["a", "b", "message"],
    "Assert.NotEqual": ["a", "b", "message"],
    "Assert.Less": ["a", "b", "message"],
    "Assert.Greater": ["a", "b", "message"],
    "Assert.LessEqual": ["a", "b", "message"],
    "Assert.GreaterEqual": ["a", "b", "message"],
    "Assert.Near": ["a", "b", "message"],
  };
  const directName = directNames[op.name]?.[index];
  if (directName) return describeParameterForOperation(op, parameterByName(directName));
  const sensorRaw = /^Sensor\d\.Raw3$/.test(op.name) ? ["var1", "var2", "var3"][index] : undefined;
  if (sensorRaw) return describeParameterForOperation(op, parameterByName(sensorRaw));
  if (op.name.startsWith("Motor.")) {
    const method = op.name.split(".")[1] ?? "";
    const names = method.includes("Power")
      ? ["ports", "power", "degrees", "brake"]
      : ["ports", "speed", "degrees", "brake"];
    const name = names[index] ?? `setting${index + 1}`;
    const details: Record<string, Localized> = {
      ports: action(
        "要控制的馬達連接埠字串，例如 `A` 或 `AD`。",
        "Motor port string to control, such as `A` or `AD`.",
      ),
      speed: action(
        "馬達速度；負值代表反向。",
        "Motor speed; a negative value reverses direction.",
      ),
      power: action(
        "馬達功率；負值代表反向。",
        "Motor power; a negative value reverses direction.",
      ),
      degrees: action("要移動的馬達角度。", "Motor rotation in degrees."),
      brake: action("動作完成時是否煞車。", "Whether to brake when the action ends."),
    };
    return {
      name,
      description:
        details[name] ??
        action("這個馬達操作所需的設定值。", "A setting required by this motor operation."),
      example:
        name === "ports"
          ? '"AD"'
          : name === "speed" || name === "power"
            ? "25"
            : name === "degrees"
              ? "360"
              : name === "brake"
                ? "True"
                : "60",
    };
  }
  if (/^Motor[ABCD]+\./.test(op.name))
    return parameter(
      op.name.includes("Power") ? "power" : "speed",
      op.name.includes("Power") ? "要套用的馬達功率。" : "要套用的馬達速度。",
      op.name.includes("Power") ? "Motor power to apply." : "Motor speed to apply.",
      "25",
    );
  if (op.name.startsWith("Sensor.")) {
    const names = [
      "port",
      op.name.includes("I2C") ? "deviceAddress" : op.name.includes("Raw") ? "index" : "mode",
      "register",
      "length",
      "data",
    ];
    const name = names[index] ?? `value${index + 1}`;
    const details: Record<string, Localized> = {
      port: action("EV3 感測器連接埠，從 1 起算。", "EV3 sensor port, numbered from 1."),
      mode: action("感測器讀取模式。", "Sensor reading mode."),
      index: action("原始資料通道索引。", "Raw data channel index."),
      deviceAddress: action("I²C 裝置位址。", "I²C device address."),
      register: action("I²C 暫存器位址。", "I²C register address."),
      length: action("要讀取或寫入的資料長度。", "Amount of data to read or write."),
      data: action("要傳送的資料或位元組陣列。", "Data or byte array to send."),
    };
    return {
      name,
      description:
        details[name] ?? action("感測器操作使用的數值。", "Value used by this sensor operation."),
      example: name === "port" ? "1" : name === "data" ? "0" : "0",
    };
  }
  if (op.name.startsWith("EV3File.")) {
    const name =
      index === 0
        ? op.name.startsWith("EV3File.Open")
          ? "fileName"
          : "handle"
        : op.name.includes("WriteLine")
          ? "text"
          : op.name.includes("WriteNumberArray")
            ? "values"
            : "count";
    return parameter(
      name,
      name === "fileName"
        ? "EV3 上的檔案名稱或路徑。"
        : name === "handle"
          ? "開啟檔案時取得的控制代號。"
          : name === "text"
            ? "要寫入檔案的一行文字。"
            : name === "values"
              ? "要寫入的數值陣列。"
              : "要讀取或處理的資料量。",
      name === "fileName"
        ? "File name or path on the EV3."
        : name === "handle"
          ? "Handle returned when the file was opened."
          : name === "text"
            ? "One line of text to write to the file."
            : name === "values"
              ? "Number array to write."
              : "Amount of data to read or process.",
      name === "fileName"
        ? '"data.txt"'
        : name === "handle"
          ? "handle"
          : name === "text"
            ? '"Hello"'
            : name === "values"
              ? "values"
              : "0",
    );
  }
  throw new Error(
    `Basic Plus parameter specification is missing for ${op.name} parameter ${index + 1} (${type}).`,
  );
}
function signature(op: EV3OperationSignature) {
  return `${op.name}(${op.parameters.map((p, i) => `${parameterInfo(op, p, i).name}: ${typeName(p)}`).join(", ")})${op.returns === "void" ? "" : `: ${typeName(op.returns)}`}`;
}
function usage(op: EV3OperationSignature) {
  const call = `${op.name}(${op.parameters.map((p, i) => parameterInfo(op, p, i).example).join(", ")})`;
  return op.returns === "void" ? call : `result = ${call}`;
}
const undocumentedParameters = apiEntries.flatMap((operation) =>
  operation.parameters.flatMap((value, index) => {
    const info = parameterInfo(operation, value, index);
    return /^value\d+$/.test(info.name) ? [`${operation.name} parameter ${index + 1}`] : [];
  }),
);
if (undocumentedParameters.length)
  throw new Error(`Basic Plus parameters need names: ${undocumentedParameters.join(", ")}`);
const exactDescriptions: Record<string, Localized> = {
  "LCD.Clear": action("清除 LCD 的繪圖緩衝區", "clears the LCD drawing buffer"),
  "LCD.Pixel": action(
    "在指定座標設定一個 LCD 像素",
    "sets one LCD pixel at the supplied coordinates",
  ),
  "LCD.Write": action(
    "在指定座標將數值或文字寫到 LCD",
    "writes a value or text to the LCD at the supplied coordinates",
  ),
  "LCD.Text": action(
    "以指定字型與座標在 LCD 繪製文字",
    "draws text on the LCD with the supplied font and coordinates",
  ),
  "LCD.Line": action(
    "在兩個指定座標之間繪製一條 LCD 線段",
    "draws an LCD line between the supplied coordinates",
  ),
  "LCD.Circle": action(
    "在 LCD 繪製指定中心與半徑的圓形外框",
    "draws an outlined circle on the LCD",
  ),
  "LCD.FillRect": action(
    "填滿 LCD 上指定的矩形範圍",
    "fills the supplied rectangular region on the LCD",
  ),
  "LCD.Rect": action("在 LCD 繪製指定的矩形外框", "draws an outlined rectangle on the LCD"),
  "LCD.InverseRect": action(
    "反轉 LCD 上指定矩形範圍內的像素",
    "inverts the pixels inside the supplied rectangular LCD region",
  ),
  "LCD.FillCircle": action("填滿 LCD 上指定中心與半徑的圓形", "fills a circle on the LCD"),
  "LCD.BmpFile": action(
    "將 EV3 上的 BMP 檔繪製到 LCD",
    "draws a BMP file from the EV3 onto the LCD",
  ),
  "LCD.Update": action(
    "將目前的 LCD 繪圖緩衝區送到螢幕",
    "copies the current LCD drawing buffer to the screen",
  ),
  "LCD.StopUpdate": action("暫停自動更新 LCD 螢幕", "stops automatic LCD screen updates"),
  "EV3.Time": action("回傳 EV3 目前的系統時間", "returns the EV3's current system time"),
  "EV3.BatteryLevel": action("回傳 EV3 的電池電量", "returns the EV3 battery level"),
  "EV3.BatteryVoltage": action("回傳 EV3 的電池電壓", "returns the EV3 battery voltage"),
  "EV3.BatteryCurrent": action("回傳 EV3 的電池電流", "returns the EV3 battery current"),
  "EV3.BrickName": action("回傳 EV3 本體名稱", "returns the EV3 brick name"),
  "EV3.SetLEDColor": action("設定 EV3 狀態燈的顏色", "sets the EV3 status LED color"),
  "EV3.SystemCall": action(
    "執行指定的 EV3 系統呼叫並回傳結果碼",
    "runs an EV3 system call and returns its result code",
  ),
  "EV3.QueueNextCommand": action("排定下一個 EV3 命令", "queues the next EV3 command"),
  "Buttons.GetClicks": action(
    "回傳累積的按鍵點擊資訊",
    "returns accumulated button-click information",
  ),
  "Buttons.Current": action(
    "回傳目前按下的按鍵資訊",
    "returns the currently pressed button information",
  ),
  "Program.GetArgument": action(
    "回傳指定索引的程式啟動參數",
    "returns a program start argument at the supplied index",
  ),
  "Program.ArgumentCount": action(
    "回傳程式啟動參數數量",
    "returns the number of program start arguments",
  ),
  "Program.Directory": action(
    "回傳程式目前工作目錄",
    "returns the program's current working directory",
  ),
  "Math.Pi": action("回傳數學常數 π", "returns the mathematical constant π"),
  "Math.GetRandomNumber": action(
    "回傳指定上限內的隨機整數",
    "returns a random integer within the supplied upper bound",
  ),
};
const methodDescriptions: Record<string, Localized> = {
  start: action("依目前設定開始驅動馬達", "starts the motor with its current settings"),
  startpower: action("以功率值開始驅動馬達", "starts the motor with a power value"),
  startspeed: action("以速度值開始驅動馬達", "starts the motor with a speed value"),
  startsteer: action("以轉向值開始同步驅動馬達", "starts coordinated motors with a steering value"),
  startsync: action(
    "以同步設定開始驅動馬達",
    "starts coordinated motors with synchronized settings",
  ),
  stop: action("停止目前的裝置動作", "stops the current device action"),
  off: action("關閉馬達輸出", "turns motor output off"),
  offandbrake: action("停止馬達並施加煞車", "stops the motor with braking"),
  move: action("完成一次阻塞式馬達移動", "performs one blocking motor move"),
  movepower: action("以功率完成一次阻塞式馬達移動", "performs one blocking motor move using power"),
  movesteer: action("以轉向完成一次阻塞式馬達移動", "performs one blocking steered motor move"),
  movesync: action(
    "以同步設定完成一次阻塞式馬達移動",
    "performs one blocking synchronized motor move",
  ),
  schedule: action("排定一段馬達動作", "schedules a motor action"),
  schedulepower: action("以功率排定一段馬達動作", "schedules a motor action using power"),
  schedulesteer: action("以轉向排定一段馬達動作", "schedules a steered motor action"),
  schedulesync: action("以同步設定排定一段馬達動作", "schedules a synchronized motor action"),
  getcount: action("回傳馬達編碼器計數", "returns a motor encoder count"),
  gettacho: action("回傳馬達轉速表計數", "returns a motor tacho count"),
  getspeed: action("回傳目前馬達速度", "returns the current motor speed"),
  resetcount: action("將馬達編碼器計數歸零", "resets the motor encoder count"),
  invert: action("切換指定馬達的方向", "inverts the selected motor direction"),
  setpower: action("設定馬達功率", "sets motor power"),
  setspeed: action("設定馬達速度", "sets motor speed"),
  setdirectpolarity: action("設定馬達的直接極性", "sets direct motor polarity"),
  setreverspolarity: action("設定馬達的反向極性", "sets reverse motor polarity"),
  islarge: action("判定連接的是否為大型馬達", "checks whether the connected motor is large"),
  ismedium: action("判定連接的是否為中型馬達", "checks whether the connected motor is medium"),
  readpercent: action("讀取感測器的百分比值", "reads a sensor percentage"),
  getname: action("回傳感測器名稱", "returns the sensor name"),
  gettype: action("回傳感測器類型", "returns the sensor type"),
  getmode: action("回傳目前感測器模式", "returns the current sensor mode"),
  readraw: action("讀取感測器原始資料陣列", "reads an array of raw sensor data"),
  readrawvalue: action("讀取一個感測器原始值", "reads one raw sensor value"),
  setmode: action("設定感測器模式", "sets a sensor mode"),
  communicatei2c: action("透過 I²C 與感測器交換資料", "exchanges data with a sensor over I²C"),
  readi2cregister: action("讀取一個 I²C 暫存器", "reads one I²C register"),
  readi2cregisters: action("讀取連續的 I²C 暫存器", "reads consecutive I²C registers"),
  writei2cregister: action("寫入一個 I²C 暫存器", "writes one I²C register"),
  writei2cregisters: action("寫入連續的 I²C 暫存器", "writes consecutive I²C registers"),
  senduartdata: action("透過 UART 傳送感測器資料", "sends sensor data over UART"),
  raw1: action("回傳感測器的第一個原始讀值", "returns the sensor's first raw reading"),
  raw3: action("寫入三個原始感測器值", "writes three raw sensor values"),
  tone: action("播放指定頻率與時長的音調", "plays a tone at the supplied frequency and duration"),
  play: action("播放 EV3 上指定的音效檔", "plays a named sound file on the EV3"),
  note: action("播放指定音符與時長", "plays the supplied note and duration"),
  wait: action("等待目前動作或輸入完成", "waits for the current action or input to complete"),
  isbusy: action("回傳裝置是否仍在忙碌", "returns whether the device is still busy"),
  flush: action("清除已累積的按鍵點擊資訊", "clears accumulated button-click information"),
  ispressed: action("回傳指定按鍵是否正被按下", "returns whether a named button is pressed"),
  openread: action(
    "以讀取模式開啟檔案並回傳控制代號",
    "opens a file for reading and returns its handle",
  ),
  openwrite: action(
    "以寫入模式開啟檔案並回傳控制代號",
    "opens a file for writing and returns its handle",
  ),
  openappend: action(
    "以附加模式開啟檔案並回傳控制代號",
    "opens a file for appending and returns its handle",
  ),
  close: action("關閉指定檔案控制代號", "closes the supplied file handle"),
  readline: action("讀取檔案中的下一行文字", "reads the next line of text from a file"),
  writeline: action("將一行文字寫入檔案", "writes one line of text to a file"),
  readbyte: action("讀取檔案中的下一個位元組", "reads the next byte from a file"),
  writebyte: action("將一個位元組寫入檔案", "writes one byte to a file"),
  converttonumber: action("將可轉換的文字轉為數值", "converts text that represents a number"),
  readnumberarray: action("從檔案讀取數值陣列", "reads a number array from a file"),
  writenumberarray: action("將數值陣列寫入檔案", "writes a number array to a file"),
  tablelookup: action("從檔案表格查找一個數值", "looks up one value in a file table"),
  send: action("傳送文字 mailbox 訊息", "sends a text mailbox message"),
  receive: action("接收文字 mailbox 訊息", "receives a text mailbox message"),
  create: action(
    "建立一個本機 mailbox 並回傳控制代號",
    "creates a local mailbox and returns its handle",
  ),
  createfornumber: action(
    "建立可收發數值的本機 mailbox",
    "creates a local mailbox for numeric values",
  ),
  sendnumber: action("傳送數值 mailbox 訊息", "sends a numeric mailbox message"),
  receivenumber: action("接收數值 mailbox 訊息", "receives a numeric mailbox message"),
  isavailable: action(
    "回傳 mailbox 是否有可接收的訊息",
    "returns whether a mailbox has a message available",
  ),
  connect: action("連接指定的 mailbox 端點", "connects to a named mailbox endpoint"),
  delay: action("暫停指定毫秒數", "pauses for the supplied number of milliseconds"),
  end: action("結束目前程式", "ends the current program"),
  yield: action("讓目前執行緒讓出執行權", "yields execution from the current thread"),
  createmutex: action("建立 mutex 並回傳控制代號", "creates a mutex and returns its handle"),
  lock: action("鎖定指定 mutex", "locks the supplied mutex"),
  unlock: action("解除指定 mutex 的鎖定", "unlocks the supplied mutex"),
  abs: action("計算絕對值", "calculates an absolute value"),
  ceiling: action("向上取整", "rounds a number up"),
  floor: action("向下取整", "rounds a number down"),
  naturallog: action("計算自然對數", "calculates a natural logarithm"),
  log: action("計算常用對數", "calculates a base-10 logarithm"),
  cos: action("計算餘弦", "calculates a cosine"),
  sin: action("計算正弦", "calculates a sine"),
  tan: action("計算正切", "calculates a tangent"),
  arcsin: action("計算反正弦", "calculates an arcsine"),
  arccos: action("計算反餘弦", "calculates an arccosine"),
  arctan: action("計算反正切", "calculates an arctangent"),
  getdegrees: action("將弧度轉為角度", "converts radians to degrees"),
  getradians: action("將角度轉為弧度", "converts degrees to radians"),
  squareroot: action("計算平方根", "calculates a square root"),
  round: action("將數值四捨五入", "rounds a number"),
  doubletodecimal: action(
    "將雙精度數值轉為十進位表示",
    "converts a double to its decimal representation",
  ),
  power: action("計算冪次", "calculates a power"),
  max: action("回傳兩個數值中較大者", "returns the greater of two values"),
  min: action("回傳兩個數值中較小者", "returns the smaller of two values"),
  remainder: action("回傳除法餘數", "returns a division remainder"),
  not: action("對位元值執行 NOT 運算", "performs a bitwise NOT operation"),
  tologic: action("將數值轉為布林邏輯值", "converts a number to a Boolean value"),
  and_: action("對兩個位元值執行 AND 運算", "performs bitwise AND on two values"),
  or_: action("對兩個位元值執行 OR 運算", "performs bitwise OR on two values"),
  xor: action("對兩個位元值執行 XOR 運算", "performs bitwise XOR on two values"),
  bit: action("讀取指定位置的位元", "reads a bit at the supplied position"),
  shl: action("將位元值左移", "shifts bits left"),
  shr: action("將位元值右移", "shifts bits right"),
  h: action("從文字取得高位元組", "gets the high byte from text"),
  b: action("從文字取得一個位元組", "gets a byte from text"),
  l: action("從文字取得低位元組", "gets the low byte from text"),
  tohex: action("將數值轉為十六進位文字", "converts a number to hexadecimal text"),
  tobinary: action("將數值轉為二進位文字", "converts a number to binary text"),
  append: action("將兩個值串接為文字", "joins two values as text"),
  getlength: action("回傳文字長度", "returns text length"),
  getcharacter: action("回傳指定位置的字元", "returns a character at the supplied position"),
  getcharactercode: action("回傳字元的字碼", "returns a character code"),
  issubtext: action("判斷文字是否包含指定片段", "checks whether text contains a supplied fragment"),
  endswith: action("判斷文字是否以指定內容結尾", "checks a text suffix"),
  startswith: action("判斷文字是否以指定內容開頭", "checks a text prefix"),
  getsubtext: action("擷取指定範圍的文字", "extracts a text range"),
  getsubtexttoend: action("從指定位置擷取到文字結尾", "extracts text from a position to the end"),
  getindexof: action(
    "回傳文字片段第一次出現的位置",
    "returns the first position of a text fragment",
  ),
  converttolowercase: action("將文字轉為小寫", "converts text to lowercase"),
  converttouppercase: action("將文字轉為大寫", "converts text to uppercase"),
  init: action("建立並初始化資料集合", "creates and initializes a data collection"),
  delete: action("刪除資料集合", "deletes a data collection"),
  read: action("讀取資料集合或裝置的目前值", "reads a current collection or device value"),
  write: action("寫入資料集合", "writes a data collection value"),
  size: action("回傳資料集合大小", "returns a data collection size"),
  resize: action("調整資料集合大小", "resizes a data collection"),
  data: action("從數值資料建立向量", "creates a vector from numeric data"),
  add: action("將兩個向量相加", "adds two vectors"),
  sort: action("排序向量資料", "sorts vector data"),
  multiply: action("計算向量乘法", "performs vector multiplication"),
  failed: action("使測試以指定訊息失敗", "fails a test with the supplied message"),
  equal: action("驗證兩個值相等", "asserts that two values are equal"),
  notequal: action("驗證兩個值不相等", "asserts that two values are not equal"),
  less: action("驗證第一個值小於第二個值", "asserts that the first value is less than the second"),
  greater: action(
    "驗證第一個值大於第二個值",
    "asserts that the first value is greater than the second",
  ),
  lessequal: action(
    "驗證第一個值小於或等於第二個值",
    "asserts that the first value is less than or equal to the second",
  ),
  greaterequal: action(
    "驗證第一個值大於或等於第二個值",
    "asserts that the first value is greater than or equal to the second",
  ),
  near: action("驗證兩個數值足夠接近", "asserts that two numeric values are sufficiently near"),
};
function describe(op: EV3OperationSignature, locale: DocsLocale) {
  const timer = /^Time\.(Get|Reset)(\d)$/.exec(op.name);
  if (timer)
    return timer[1] === "Get"
      ? locale === "zh-TW"
        ? `${op.name} 會回傳計時器 ${timer[2]} 的目前值。`
        : `${op.name} returns the current value of timer ${timer[2]}.`
      : locale === "zh-TW"
        ? `${op.name} 會將計時器 ${timer[2]} 歸零。`
        : `${op.name} resets timer ${timer[2]}.`;
  const exact = exactDescriptions[op.name];
  if (exact) return `${op.name} ${exact[locale]}。`;
  const method = op.name.split(".").at(-1)?.toLowerCase() ?? "";
  const meaning = methodDescriptions[method];
  if (meaning) return `${op.name} ${meaning[locale]}。`;
  throw new Error(`Basic Plus description is missing for ${op.name}.`);
}
function Copy({ value, locale }: { value: string; locale: DocsLocale }) {
  const [done, setDone] = useState(false);
  const c = t[locale];
  const action = async () => {
    await navigator.clipboard?.writeText(value);
    setDone(true);
    window.setTimeout(() => setDone(false), 1400);
  };
  return (
    <button className="copy-code" onClick={() => void action()}>
      {done ? "✓" : "⧉"} {done ? c.copied : c.copy}
    </button>
  );
}
function Pager({
  locale,
  current,
  entries,
  route,
}: {
  locale: DocsLocale;
  current: number;
  entries: readonly { title: Record<DocsLocale, string> }[];
  route: (i: number) => string;
}) {
  const c = t[locale],
    prev = entries[current - 1],
    next = entries[current + 1];
  return (
    <nav className="article-pager" aria-label="Reference pagination">
      {prev ? (
        <AppLink href={route(current - 1)}>
          <span>← {c.previous}</span>
          <strong>{prev.title[locale]}</strong>
        </AppLink>
      ) : (
        <span />
      )}
      {next ? (
        <AppLink href={route(current + 1)}>
          <span>{c.next} →</span>
          <strong>{next.title[locale]}</strong>
        </AppLink>
      ) : (
        <span />
      )}
    </nav>
  );
}
function Index({ locale }: { locale: DocsLocale }) {
  const c = t[locale];
  const [query, setQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const category = searchParams.get("category") ?? "all";
  const setCategory = (value: string) => {
    setSearchParams(
      (params) => {
        if (value === "all") params.delete("category");
        else params.set("category", value);
        return params;
      },
      { preventScrollReset: true },
    );
  };
  const rows = useMemo(
    () =>
      apiEntries.filter(
        (op) =>
          (category === "all" || op.category === category) &&
          `${op.name} ${op.category}`.toLowerCase().includes(query.toLowerCase()),
      ),
    [category, query],
  );
  useEffect(() => {
    document.title = `${c.title} — Kobrixa`;
  }, [c.title]);
  return (
    <section className="reference-page" aria-labelledby="reference-title">
      <nav className="reference-breadcrumb" aria-label="Breadcrumb">
        <AppLink href="/docs">Kobrixa</AppLink>
        <span>/</span>
        <span>Basic Plus</span>
      </nav>
      <header className="reference-header">
        <p className="eyebrow">
          <span className="eyebrow-marker" />
          Basic Plus
        </p>
        <h1 id="reference-title">{c.title}</h1>
        <p>{c.intro}</p>
      </header>
      <section className="syntax-reference">
        <h2>{c.syntax}</h2>
        <div>
          {syntaxEntries.map((entry) => (
            <AppLink
              className="syntax-index-card"
              href={`/docs/reference/basic-plus/syntax/${entry.slug}`}
              key={entry.slug}
            >
              <h3>{entry.title[locale]}</h3>
              <p>{entry.body[locale]}</p>
              <i>→</i>
            </AppLink>
          ))}
        </div>
      </section>
      <section className="api-reference">
        <div className="api-heading">
          <div>
            <h2>{c.api}</h2>
            <p>{apiEntries.length} APIs</p>
          </div>
          <label>
            <span>{c.search}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Motor.Start"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label={c.all}
          >
            <option value="all">{c.all}</option>
            {Object.entries(labels).map(([key, label]) => (
              <option value={key} key={key}>
                {locale === "zh-TW" ? label[0] : label[1]}
              </option>
            ))}
          </select>
        </div>
        {rows.length ? (
          <div className="api-index-list">
            {rows.map((op) => (
              <AppLink href={apiRoute(op)} key={op.name}>
                <span>{locale === "zh-TW" ? labels[op.category][0] : labels[op.category][1]}</span>
                <strong>{op.name}</strong>
                <code>{signature(op)}</code>
                <i>→</i>
              </AppLink>
            ))}
          </div>
        ) : (
          <p className="api-empty">{c.empty}</p>
        )}
      </section>
    </section>
  );
}
function ApiDetail({
  locale,
  operation,
}: {
  locale: DocsLocale;
  operation: EV3OperationSignature;
}) {
  const c = t[locale],
    index = apiEntries.findIndex((item) => item.name === operation.name),
    link = lesson[operation.category],
    pager = apiEntries.map((item) => ({ title: { "zh-TW": item.name, en: item.name } }));
  useEffect(() => {
    document.title = `${operation.name} — Basic Plus — Kobrixa`;
  }, [operation.name]);
  return (
    <article className="reference-page detail-page" aria-labelledby="api-title">
      <nav className="reference-breadcrumb" aria-label="Breadcrumb">
        <AppLink href="/docs">Kobrixa</AppLink>
        <span>/</span>
        <AppLink href="/docs/reference/basic-plus">Basic Plus</AppLink>
        <span>/</span>
        <span>{operation.name}</span>
      </nav>
      <AppLink className="back-link" href="/docs/reference/basic-plus">
        ← {c.back}
      </AppLink>
      <header className="reference-header" id="overview">
        <p className="eyebrow">
          <span className="eyebrow-marker" />
          {locale === "zh-TW" ? labels[operation.category][0] : labels[operation.category][1]}
        </p>
        <h1 id="api-title">{operation.name}</h1>
        <p className="api-description">{describe(operation, locale)}</p>
      </header>
      <section className="reference-detail">
        <section id="syntax">
          <h2>Syntax</h2>
          <div className="reference-signature">
            <code>{signature(operation)}</code>
          </div>
        </section>
        <section id="parameters">
          <h2>{c.params}</h2>
          {operation.parameters.length ? (
            <dl>
              {operation.parameters.map((p, i) => {
                const info = parameterInfo(operation, p, i);
                return (
                  <div key={i}>
                    <dt>{info.name}</dt>
                    <dd>
                      <code>{typeName(p)}</code>
                      <span>{info.description[locale]}</span>
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : (
            <p>—</p>
          )}
        </section>
        <section id="return-value">
          <h2>{c.returns}</h2>
          <p>
            <code>{typeName(operation.returns)}</code>
            {operation.returns === "void"
              ? locale === "zh-TW"
                ? " — 此操作不產生回傳值。"
                : " — This operation does not return a value."
              : locale === "zh-TW"
                ? " — 呼叫完成後可指派給變數。"
                : " — You can assign the result to a variable."}
          </p>
        </section>
        <section id="examples">
          <h2>{c.usage}</h2>
          <div className="reference-code">
            <Copy value={usage(operation)} locale={locale} />
            <pre>
              <code>{usage(operation)}</code>
            </pre>
          </div>
        </section>
        <section id="related">
          <h2>{c.related}</h2>
          <div className="detail-links">
            <AppLink href={`/docs/tutorial/${link[0]}`}>
              {c.lesson}: {link[0]}
            </AppLink>
            <AppLink
              href={`https://github.com/Kingsley1116/Kobrixa/tree/main/examples/${link[1]}`}
              target="_blank"
              rel="noreferrer"
            >
              {c.example} ↗
            </AppLink>
            <AppLink href={clev3rHelpUrl(operation)} target="_blank" rel="noreferrer">
              {c.clev3rHelp} ↗
            </AppLink>
          </div>
        </section>
      </section>
      <Pager
        locale={locale}
        current={index}
        entries={pager}
        route={(i) => apiRoute(apiEntries[i]!)}
      />
    </article>
  );
}
function SyntaxDetail({ locale, entry }: { locale: DocsLocale; entry: Syntax }) {
  const c = t[locale],
    index = syntaxEntries.findIndex((item) => item.slug === entry.slug);
  useEffect(() => {
    document.title = `${entry.title[locale]} — Basic Plus — Kobrixa`;
  }, [entry, locale]);
  return (
    <article className="reference-page detail-page" aria-labelledby="syntax-title">
      <nav className="reference-breadcrumb" aria-label="Breadcrumb">
        <AppLink href="/docs">Kobrixa</AppLink>
        <span>/</span>
        <AppLink href="/docs/reference/basic-plus">Basic Plus</AppLink>
        <span>/</span>
        <span>{entry.title[locale]}</span>
      </nav>
      <AppLink className="back-link" href="/docs/reference/basic-plus">
        ← {c.back}
      </AppLink>
      <header className="reference-header" id="overview">
        <p className="eyebrow">
          <span className="eyebrow-marker" />
          {c.syntax}
        </p>
        <h1 id="syntax-title">{entry.title[locale]}</h1>
        <p>{entry.body[locale]}</p>
      </header>
      <section className="reference-detail">
        <section id="syntax">
          <h2>Syntax</h2>
          <div className="reference-code">
            <Copy value={entry.code} locale={locale} />
            <pre>
              <code>{entry.code}</code>
            </pre>
          </div>
        </section>
        <section id="examples">
          <h2>{c.usage}</h2>
          <p>
            {locale === "zh-TW"
              ? "將這段程式貼到 Kobrixa 專案中，再依你的工作調整名稱與數值。"
              : "Paste this code into a Kobrixa project, then adapt its names and values for your work."}
          </p>
        </section>
        <section id="related">
          <h2>{c.related}</h2>
          <div className="detail-links">
            <AppLink href={`/docs/tutorial/${entry.lesson}`}>
              {c.lesson}: {entry.lesson}
            </AppLink>
          </div>
        </section>
      </section>
      <Pager
        locale={locale}
        current={index}
        entries={syntaxEntries}
        route={(i) => `/docs/reference/basic-plus/syntax/${syntaxEntries[i]!.slug}`}
      />
    </article>
  );
}
function Missing({ locale }: { locale: DocsLocale }) {
  const c = t[locale];
  return (
    <article className="reference-page detail-page">
      <AppLink className="back-link" href="/docs/reference/basic-plus">
        ← {c.back}
      </AppLink>
      <h1>{c.missing}</h1>
    </article>
  );
}
export function BasicPlusReference({ locale, apiName, syntaxSlug }: Props) {
  if (apiName) {
    const op = findApi(apiName);
    return op ? <ApiDetail locale={locale} operation={op} /> : <Missing locale={locale} />;
  }
  if (syntaxSlug) {
    const entry = findSyntax(syntaxSlug);
    return entry ? <SyntaxDetail locale={locale} entry={entry} /> : <Missing locale={locale} />;
  }
  return <Index locale={locale} />;
}
