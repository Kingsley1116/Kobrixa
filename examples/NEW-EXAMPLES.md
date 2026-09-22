# New examples / 新增範例（2026-09-20）

This batch adds **20 independently authored projects** across 12 categories. Only these projects are included in this audit; the previous 53 examples and their recorded results are outside its scope.／本批新增 **20 個原創專案**，涵蓋 12 個分類。此次僅稽核這些專案；既有 53 個範例及其歷史結果不在本次範圍內。

Each project includes `kobrixa.json`, `src/main.bp`, and bilingual run notes with expected results. Open the project directory in Kobrixa to build it.／每個專案均附有 `kobrixa.json`、`src/main.bp`、雙語執行說明與預期結果，可直接在 Kobrixa 開啟並建置。

| Project / 專案                                                        | Topic / 主題                               |
| --------------------------------------------------------------------- | ------------------------------------------ |
| [algorithms/euclidean-gcd](algorithms/euclidean-gcd/)                 | Euclidean GCD／輾轉相除法                  |
| [algorithms/fibonacci-sequence](algorithms/fibonacci-sequence/)       | Fibonacci sequence／費氏數列               |
| [algorithms/prime-count](algorithms/prime-count/)                     | Prime counting／質數計數                   |
| [algorithms/insertion-sort](algorithms/insertion-sort/)               | Insertion sort／插入排序                   |
| [control-flow/for-step-boundaries](control-flow/for-step-boundaries/) | For loop boundaries／For 迴圈邊界          |
| [control-flow/nested-loop-exits](control-flow/nested-loop-exits/)     | Nested loop exits／巢狀迴圈跳出            |
| [language/compound-arithmetic](language/compound-arithmetic/)         | Compound arithmetic／複合賦值運算          |
| [language/function-outputs](language/function-outputs/)               | Function output parameters／函式輸出參數   |
| [language/text-search](language/text-search/)                         | Text search and slicing／文字搜尋與擷取    |
| [collections/row-statistics](collections/row-statistics/)             | Row statistics／Row 統計                   |
| [collections/matrix-product](collections/matrix-product/)             | Matrix multiplication／矩陣乘法            |
| [files/byte-sequence](files/byte-sequence/)                           | Byte sequence round trip／位元組序列讀寫   |
| [time/finite-countdown](time/finite-countdown/)                       | Finite countdown／有限倒數                 |
| [display/fractional-coordinates](display/fractional-coordinates/)     | Fractional coordinates／小數座標           |
| [sound/computed-arpeggio](sound/computed-arpeggio/)                   | Computed arpeggio／計算琶音                |
| [sensors/three-zone-light](sensors/three-zone-light/)                 | Three-zone reflected light／三段反射光分類 |
| [sensors/five-sample-average](sensors/five-sample-average/)           | Five-sample average／五次取樣平均          |
| [motors/power-ramp](motors/power-ramp/)                               | Power ramp／功率漸增                       |
| [buttons/button-choice](buttons/button-choice/)                       | Button choice／按鍵選擇                    |
| [projects/import-calibration](projects/import-calibration/)           | Imported calibration／匯入校正函式         |

## Learning order / 建議順序

1. Loop boundaries → compound arithmetic → GCD, Fibonacci, primes, and insertion sort.／迴圈邊界 → 複合運算 → 最大公因數、費氏數列、質數與插入排序。
2. Function outputs → imported calibration → text search → Row statistics and matrix product.／函式輸出 → 匯入校正函式 → 文字搜尋 → Row 統計與矩陣乘法。
3. Byte files → countdown → fractional drawing → computed sound.／位元組檔案 → 倒數 → 小數座標繪圖 → 計算音高。
4. Buttons → reflected-light thresholds and averaging → motor power ramp. Use the hardware listed in each README.／按鍵 → 反射光門檻與取樣平均 → 馬達功率漸增，依各 README 接上指定硬體。

## Reproduce the bytecode audit / 重跑字節碼稽核

Run from the repository root with dependencies installed. The firmware definitions are pinned to commit `78ebaf5b6f8fe31cc17aa5dce0f8e4916a4fc072`; download them once.／安裝依賴後，在專案根目錄執行；韌體定義固定於上述 commit，只需下載一次。

```sh
curl -fLsS https://raw.githubusercontent.com/mindboards/ev3sources/78ebaf5b6f8fe31cc17aa5dce0f8e4916a4fc072/lms2012/lms2012/source/bytecodes.h -o /tmp/kobrixa-new-bytecodes.h
curl -fLsS https://raw.githubusercontent.com/mindboards/ev3sources/78ebaf5b6f8fe31cc17aa5dce0f8e4916a4fc072/lms2012/lms2012/source/bytecodes.c -o /tmp/kobrixa-new-bytecodes.c
pnpm examples:audit /tmp/kobrixa-new-bytecodes.h /tmp/kobrixa-new-bytecodes.c /tmp/kobrixa-new-examples
pnpm test:examples:audit
```

On Windows, substitute existing temporary-directory paths for `/tmp/...` (and use `curl.exe`).／Windows 請將 `/tmp/...` 換成現有暫存資料夾路徑，並使用 `curl.exe`。

`examples:audit` builds the required compiler packages, compiles only [new-examples.json](new-examples.json), independently decodes the emitted RBF, and executes its bytes using fixed device inputs. Explicit expectations compare display values, arrays, file bytes, drawing operands, tone and motor command order, delays, and termination. It checks six light-threshold inputs, three additional sample sequences, and four button combinations. Missing projects, missing scenarios, execution errors, bounded execution, or wrong results fail verification.／`examples:audit` 會建置所需編譯套件，僅編譯清單內的新範例，獨立解碼並執行輸出的 RBF 位元組。明確的預期值涵蓋顯示、陣列、檔案位元組、繪圖參數、音效與馬達命令順序、等待及正常結束，另測試六組光線門檻輸入、三組額外取樣序列與四組按鍵組合；缺少專案、情境，或執行錯誤、超限、結果不符皆會失敗。

Expected summary: **20 new examples, 33 runs, 107 assertions, 0 mismatches**.／預期結果：**20 個新範例、33 次執行、107 項檢查、0 項不符**。

The output directory contains each `.rbf`, decoded instructions, IR and execution traces, plus `checked-results.json` with source and RBF hashes. Reusing an output directory overwrites the selected projects' artifacts.／輸出目錄包含各 `.rbf`、指令解碼、IR、執行軌跡及含原始碼與 RBF 雜湊的 `checked-results.json`；重用輸出目錄會覆寫所選範例的產物。

See [audit findings and limits](https://github.com/Kingsley1116/Kobrixa/blob/2d5c6f7cd6a67e4dff9493166852aa860b4c19b5/docs/audits/new-examples-bytecode-2026-09-20.md) and the [recorded results](https://github.com/Kingsley1116/Kobrixa/blob/2d5c6f7cd6a67e4dff9493166852aa860b4c19b5/docs/audits/new-examples-bytecode-2026-09-20.json).／詳細發現與限制請見上述稽核報告與結果。

## Reference and limits / 參考與限制

The topic selection was informed by the public [Clev3r Examples directory](https://github.com/iCheh/Clev3r-1/tree/main/Clever/bin/Release/Examples/) (functions, loop exits, Row collections, sensors, includes, and time). No Clev3r example code or assets were copied.／主題選擇參考公開目錄中的函式、迴圈跳出、Row、感測器、include 與時間分類；未複製 Clev3r 範例程式或素材。

These are bytecode logic checks, not physical EV3 acceptance results. Device input, time, audio, motor and file operations use deterministic models. The examples do not claim coverage of every firmware feature or hardware configuration; cross-brick mailboxes, thread interleavings, third-party devices and I²C protocols are outside this new batch.／本次為字節碼邏輯檢查，未進行 EV3 實機驗收。裝置輸入、時間、聲音、馬達及檔案操作使用固定模型；不宣稱涵蓋全部韌體功能與硬體組態，跨機 mailbox、執行緒交錯、第三方裝置及 I²C 協定不屬於本批範圍。

## Expanded curriculum / 擴充課程

See [Clev3r curriculum parity](CLEV3R-PARITY.md): 41 further projects cover every reference main program and helper/media role. Together with the first 20 lessons, 61 new projects cover all 122 reference API names. Original 53-example results remain outside the audit.／另 41 個新專案完整對照參考主程式、輔助檔與素材角色；加上首批 20 個，共 61 個新專案涵蓋 122 個參考 API。原有 53 個範例結果不在稽核範圍。
