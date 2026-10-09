# 語言支援政策

## 共通規則

所有來源語言都透過前端編譯為已驗證的 `KobrixaIR`，再由同一個 EV3 後端產生原生 `.rbf`。前端不得靜默重新解釋不支援的功能，而必須產生穩定且可採取行動的編譯期診斷。

Basic Plus 是目前唯一已實作的來源前端，專案 manifest 只接受 `language: "bp"`；Python、TypeScript 與 C++ 仍屬路線圖項目。桌面程式碼簽章用來驗證應用程式的發布身分，不改變編譯器接受的語言，也不代表使用者程式已通過硬體行為驗收。

「盡可能完整」代表在語意能映射至 EV3 VM 時，廣泛接受原語言語法；不代表 Kobrixa 會在 `.rbf` 中嵌入完整 CPython、JavaScript、Node.js、瀏覽器、C++ 或作業系統 runtime。

## Basic Plus（`.bp`）— v1

Clean-room 前端的目標是與支援的舊版程式行為相容，包括：

- 變數、陣列、運算式、字串、數字與布林慣例
- `If`／`ElseIf`／`Else`、迴圈、標籤與支援的控制流程
- Sub、Function、參數與 `Return`
- Include、Module、Property 與支援的素材宣告
- 支援的 EV3 馬達、感測器、顯示、揚聲器、按鈕、檔案、Mailbox 與 Program API

相容代表原始碼不修改即可執行，並在參考 EV3 上呈現等價的可觀察行為。空白、產生的 listing、指令排列和 `.rbf` 位元組可以不同。

布林情境同時接受裸 `true`／`false` 常值與舊式帶引號的 `"True"`／`"False"`，而且不區分大小寫。只有 `If`／`While` 條件、`And`／`Or`／`Not` 或 EV3 API 布林參數等需要布林值的位置才會進行轉換；在文字情境中，`"True"` 仍是可顯示的一般文字。

來源語言前端接受 Clev3r 文件中的關鍵字形式，包括 `import`、`folder`、`private`、具型別的 `in`／`out` Function 參數，以及 `break`／`continue`；也接受文件所列的 `++`、`--`、`+=`、`-=`、`*=`、`/=` 指定運算子。Import 會解析專案內相對路徑的 `.bpm`，Include 則解析 `.bpi`。

相容性根據公開行為規格與獨立撰寫的案例建立。可查閱公開 Help 以確認外部可觀察的語法與行為，但不會把 CLEV3R 程式碼、文件文字、素材、產生的輸出或受保護的實作表達複製進 Kobrixa。

## Python — v1 之後規劃

前端會盡量解析標準 Python 語法，並靜態 lowering 具有明確 EV3 語意的能力。動態 import、執行期程式碼產生、大量依賴反射的行為、原生 extension 和多數桌面標準函式庫不屬於原生 EV3 目標。不支援的功能會產生診斷，指出能力名稱，並在可能時建議 EV3 相容替代方案。

## TypeScript — Python 之後規劃

前端會使用 TypeScript 語法及可取得的靜態型別資訊。它不提供瀏覽器 DOM、Node.js API、動態 module 載入、`eval` 或不受限的 JavaScript runtime。支援的結構會直接 lowering 為具型別 IR，而不是附帶 JavaScript 引擎。

## C++ — TypeScript 之後規劃

這是供使用者編寫程式的來源語言前端，不是 Kobrixa 的實作語言；編譯器與桌面服務使用 Node.js 與 TypeScript 實作。

前端以文件化的 freestanding EV3 profile 為目標。不保證支援主機作業系統 API、動態函式庫、inline assembly、exception、RTTI 與不受限的動態配置。支援的原始碼會 lowering 為 IR，而不是將任意 ARM 原生碼隱藏在 `.rbf` 中。

## 診斷政策

診斷代碼在同一 major version 內保持穩定，使用 `BP`、`PY`、`TS`、`CPP`、`IR`、`EV3` 等命名空間。診斷至少涵蓋語法錯誤、未解析名稱、型別錯誤、不支援功能、無效 EV3 API 呼叫、資源限制和後端失敗。

不支援功能必須是 error，不能在發出 warning 後改變執行語意。診斷包含精確來源範圍，並在可能時提供修正說明。

## 相容測試政策

- 有效 fixture 驗證可觀察輸出、馬達命令、感測器互動、檔案、顯示操作和結束行為。
- 無效 fixture 驗證穩定代碼和來源範圍。
- 每個回歸都使用能重現問題的最小獨立撰寫 fixture。
- 模擬不足時，以參考 EV3 實機測試定義行為。
- 確定性編譯測試可以比較不同 Kobrixa 建置的輸出，但不要求與第三方編譯器位元組相同。

## 數值回傳與文字邊界

除法（`/`）即使使用整數運算元也會產生浮點結果，例如 `7 / 2` 為 `3.5`。同一函式的數值回傳分支共用推論出的表示方式；含浮點回傳分支時，整數分支會提升為浮點。整數與布林回傳值使用對應的 EV3 呼叫參數寬度；不相容的回傳型別會回報 `BP2010`。

文字搜尋與擷取的位置從 1 起算。`Text.GetIndexOf` 找不到時回傳 0；`Text.GetSubText` 會將過長的擷取範圍限制於來源尾端，起點無效或長度不為正數時回傳空字串。搜尋成功的分支依照韌體的字串相等結果判斷。可執行案例請見[文字搜尋範例](https://github.com/Kingsley1116/Kobrixa/tree/main/examples/language/text-search)。

## 範例驗證的執行支援

[隨附範例](https://github.com/Kingsley1116/Kobrixa/blob/main/examples/README.zh-TW.md)涵蓋以下行為：

- 遞迴群組支援同時 32 層，超限明確停止；原生函式物件不可重入。
- 互斥鎖取得透過共用原生子呼叫序列化。
- Basic Plus 三角函數使用弧度，並與 EV3 原生角度單位互相轉換。
- Byte、I²C 與檔案位元組保留 0–255 範圍。
- 入口來源的 `Folder` 設定內建或 SD 部署與執行路徑。

自動編譯與字節碼檢查只驗證其涵蓋的項目；實際硬體行為仍需實機驗收確認。
