# Kobrixa 範例

這 120 個專案均為 Kobrixa 原創範例，從只使用顯示器的入門程式，逐步進展到本機機器人模擬及需要連接 EV3 硬體的程式。

可在 Kobrixa 開啟專案目錄、`kobrixa.json` 或 `src/main.bp`。連接 EV3 前請先建置；第一次執行馬達範例時，請先架高機器人，確保輪子可安全轉動。建議的上課順序請見[學習路徑](LEARNING-PATH.md)。

<a href="./getting-started/README.zh-TW.md">入門</a> · <a href="./display/README.zh-TW.md">顯示</a> · <a href="./sound/README.zh-TW.md">聲音</a> · <a href="./media/README.zh-TW.md">媒體</a> · <a href="./time/README.zh-TW.md">時間</a> · <a href="./buttons/README.zh-TW.md">按鍵</a> · <a href="./control-flow/README.zh-TW.md">控制流程</a> · <a href="./language/README.zh-TW.md">語言</a> · <a href="./collections/README.zh-TW.md">集合</a> · <a href="./algorithms/README.zh-TW.md">演算法</a> · <a href="./concurrency/README.zh-TW.md">並行</a> · <a href="./files/README.zh-TW.md">檔案</a> · <a href="./mailboxes/README.zh-TW.md">信箱</a> · <a href="./program/README.zh-TW.md">程式</a> · <a href="./projects/README.zh-TW.md">專案</a> · <a href="./motors/README.zh-TW.md">馬達</a> · <a href="./sensors/README.zh-TW.md">感測器</a> · <a href="./hitechnic/README.zh-TW.md">HiTechnic</a> · <a href="./daisy-chain/README.zh-TW.md">串接</a> · <a href="./capstones/README.zh-TW.md">整合專題</a> · <a href="./simulation/README.zh-TW.md">模擬</a> · <a href="./benchmarks/README.zh-TW.md">基準測試</a>

## 入門

| 範例                                              | 學習內容               | 硬體需求     |
| ------------------------------------------------- | ---------------------- | ------------ |
| [hello-ev3](getting-started/hello-ev3/)           | 文字、線條、音調與等待 | 顯示器與喇叭 |
| [brick-greeting](getting-started/brick-greeting/) | 以本體名稱組成問候訊息 | 顯示器       |

## 顯示

| 範例                                                        | 學習內容                          | 硬體需求         |
| ----------------------------------------------------------- | --------------------------------- | ---------------- |
| [display-write](display/display-write/)                     | 使用 `LCD.Write` 顯示簡單黑色文字 | 顯示器           |
| [display-fonts](display/display-fonts/)                     | Tiny、Small 與 Big 三種字型       | 顯示器           |
| [display-shapes](display/display-shapes/)                   | 線條、同心圓與座標                | 顯示器           |
| [drawing-primitives](display/drawing-primitives/)           | 像素、矩形、反相與實心圓          | 顯示器           |
| [double-buffer-animation](display/double-buffer-animation/) | 整個畫面畫完才更新 LCD            | 顯示器           |
| [fractional-coordinates](display/fractional-coordinates/)   | 小數座標轉為整數參數              | 顯示器           |
| [button-cursor](display/button-cursor/)                     | 按鍵控制游標與雙緩衝動畫          | 顯示器與本體按鍵 |

## 聲音

| 範例                                            | 學習內容                  | 硬體需求 |
| ----------------------------------------------- | ------------------------- | -------- |
| [speaker-scale](sound/speaker-scale/)           | 以算術產生四音音階        | 喇叭     |
| [speaker-interrupt](sound/speaker-interrupt/)   | 提前停止長音              | 喇叭     |
| [speaker-melody](sound/speaker-melody/)         | 具名音符與 `Speaker.Wait` | 喇叭     |
| [computed-arpeggio](sound/computed-arpeggio/)   | 由迴圈變數計算音高        | 喇叭     |
| [note-busy-sequence](sound/note-busy-sequence/) | 音名、頻率與忙碌狀態輪詢  | 喇叭     |

## 媒體

| 範例                                                  | 學習內容                                  | 硬體需求                  |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------- |
| [original-media](media/original-media/)               | 部署並播放原創圖像與音效素材              | 顯示器與喇叭；會部署素材  |
| [graphic-sound-card](media/graphic-sound-card/)       | 附帶的 RGF／RSF 素材與播放                | 顯示器與喇叭；會部署素材  |
| [internal-media-folder](media/internal-media-folder/) | `Folder` 選擇內部儲存的部署位置與媒體路徑 | 部署到 `prjs/KobrixaCard` |
| [sd-media-folder](media/sd-media-folder/)             | `Folder` 選擇 SD 卡的部署位置與媒體路徑   | 可寫入的 EV3 SD 卡        |

## 時間

| 範例                                           | 學習內容                     | 硬體需求 |
| ---------------------------------------------- | ---------------------------- | -------- |
| [timer-slots](time/timer-slots/)               | 重設並讀取計時槽 1           | 顯示器   |
| [finite-countdown](time/finite-countdown/)     | 時鐘差值與要求等待時間的差別 | 顯示器   |
| [elapsed-intervals](time/elapsed-intervals/)   | 重複測量經過時間             | 顯示器   |
| [independent-timers](time/independent-timers/) | 互相獨立的計時槽 1 與 9      | 顯示器   |

## 按鍵

| 範例                                            | 學習內容                     | 硬體需求         |
| ----------------------------------------------- | ---------------------------- | ---------------- |
| [button-feedback](buttons/button-feedback/)     | 清除、等待並辨識按鍵         | 本體按鍵         |
| [button-choice](buttons/button-choice/)         | 不無限等待，直接讀取按鍵狀態 | 本體按鍵         |
| [click-stepper](buttons/click-stepper/)         | 消耗點擊並定距移動           | 本體按鍵與馬達 A |
| [held-button-drive](buttons/held-button-drive/) | 按住的按鍵決定馬達功率       | 本體按鍵與馬達 A |

## 控制流程

| 範例                                                       | 學習內容                                    | 硬體需求     |
| ---------------------------------------------------------- | ------------------------------------------- | ------------ |
| [control-flow](control-flow/control-flow/)                 | 變數、算術、`For` 迴圈與繪圖                | 顯示器與喇叭 |
| [while-loop](control-flow/while-loop/)                     | 有限次的 `While` 迴圈                       | 顯示器       |
| [if-elseif](control-flow/if-elseif/)                       | `If`／`ElseIf`／`Else` 分支                 | 顯示器與喇叭 |
| [boolean-logic](control-flow/boolean-logic/)               | 布林值、`And` 與 `Not`                      | 顯示器與喇叭 |
| [comparison-operators](control-flow/comparison-operators/) | 括號、`>=`、`<>` 與組合條件                 | 顯示器       |
| [nested-control](control-flow/nested-control/)             | `For` 迴圈內的 `If`                         | 顯示器       |
| [labels-and-goto](control-flow/labels-and-goto/)           | Label 與向前 `Goto`                         | 顯示器與喇叭 |
| [break-and-continue](control-flow/break-and-continue/)     | 離開與略過迴圈迭代                          | 顯示器       |
| [for-step-boundaries](control-flow/for-step-boundaries/)   | 正負 `Step` 的迴圈邊界                      | 顯示器       |
| [nested-loop-exits](control-flow/nested-loop-exits/)       | `Break` 與 `Continue` 只影響內層迴圈        | 顯示器       |
| [loop-exit-matrix](control-flow/loop-exit-matrix/)         | `For` 與 `While` 中的 `Break` 與 `Continue` | 顯示器       |

## 語言

| 範例                                                 | 學習內容                             | 硬體需求 |
| ---------------------------------------------------- | ------------------------------------ | -------- |
| [case-insensitive](language/case-insensitive/)       | 混用大小寫的關鍵字、變數與 API       | 顯示器   |
| [text-and-math](language/text-and-math/)             | 文字組合與數學函式                   | 顯示器   |
| [text-search](language/text-search/)                 | 從 1 起算的文字搜尋與擷取            | 顯示器   |
| [compound-arithmetic](language/compound-arithmetic/) | 複合賦值與保留小數的除法             | 顯示器   |
| [byte-logic](language/byte-logic/)                   | 位元遮罩與十六進位格式               | 顯示器   |
| [byte-workbench](language/byte-workbench/)           | 十六進位／二進位轉換、位元測試與位移 | 顯示器   |
| [local-functions](language/local-functions/)         | 定義並呼叫本地 Function              | 顯示器   |
| [display-function](language/display-function/)       | 型別化的數字與文字輸入參數           | 顯示器   |
| [function-outputs](language/function-outputs/)       | 型別化輸出參數                       | 顯示器   |
| [output-pipeline](language/output-pipeline/)         | 輸出參數傳給另一個 Function          | 顯示器   |

## 集合

| 範例                                              | 學習內容                             | 硬體需求 |
| ------------------------------------------------- | ------------------------------------ | -------- |
| [row-vector](collections/row-vector/)             | 固定 Row 與數字 Vector               | 顯示器   |
| [row-statistics](collections/row-statistics/)     | Row 的平均、最小與最大值             | 顯示器   |
| [row-lifecycle](collections/row-lifecycle/)       | 建立、填值、改變大小、讀取與釋放 Row | 顯示器   |
| [vector-workbench](collections/vector-workbench/) | 初始化、排序並乘算 Vector            | 顯示器   |
| [vector-toolkit](collections/vector-toolkit/)     | 文字初始化、加法、排序與矩陣乘法     | 顯示器   |
| [matrix-product](collections/matrix-product/)     | 列優先 2×2 矩陣乘法                  | 顯示器   |

## 演算法

| 範例                                                 | 學習內容                                | 硬體需求 |
| ---------------------------------------------------- | --------------------------------------- | -------- |
| [euclidean-gcd](algorithms/euclidean-gcd/)           | 以可重用函式實作輾轉相除法              | 顯示器   |
| [fibonacci-sequence](algorithms/fibonacci-sequence/) | 透過暫存變數更新狀態                    | 顯示器   |
| [prime-count](algorithms/prime-count/)               | 以巢狀迴圈與提早離開試除                | 顯示器   |
| [insertion-sort](algorithms/insertion-sort/)         | 從 0 起算索引的插入排序，含重複值與負數 | 顯示器   |
| [recursive-hanoi](algorithms/recursive-hanoi/)       | 在圖形棋盤上遞迴分治                    | 顯示器   |

## 並行

| 範例                                                  | 學習內容                          | 硬體需求     |
| ----------------------------------------------------- | --------------------------------- | ------------ |
| [thread-mutex](concurrency/thread-mutex/)             | 背景 Sub、mutex 與讓出執行        | 顯示器與 LED |
| [shared-counters](concurrency/shared-counters/)       | 兩個工作執行緒與 mutex 保護的寫入 | 顯示器       |
| [sort-and-heartbeat](concurrency/sort-and-heartbeat/) | 排序時執行背景工作                | 顯示器       |

## 檔案

| 範例                                      | 學習內容                   | 硬體需求               |
| ----------------------------------------- | -------------------------- | ---------------------- |
| [file-round-trip](files/file-round-trip/) | 寫入並讀取 EV3 文字檔      | 顯示器；會寫入一個檔案 |
| [binary-record](files/binary-record/)     | 寫入並讀取一個二進位位元組 | 顯示器；會寫入一個檔案 |
| [byte-sequence](files/byte-sequence/)     | 包含零位元組的循序讀取     | 顯示器；會寫入一個檔案 |
| [typed-record](files/typed-record/)       | 文字、位元組與數字陣列往返 | 顯示器；會寫入一個檔案 |

## 信箱

| 範例                                          | 學習內容                 | 硬體需求           |
| --------------------------------------------- | ------------------------ | ------------------ |
| [mailbox-local](mailboxes/mailbox-local/)     | 建立具名收件匣並輪詢     | 可選用第二台 EV3   |
| [paired-receiver](mailboxes/paired-receiver/) | 接收文字與數字訊息       | 兩台藍牙配對的 EV3 |
| [paired-sender](mailboxes/paired-sender/)     | 連線並傳送文字與數字訊息 | 兩台藍牙配對的 EV3 |

## 程式

| 範例                                              | 學習內容                   | 硬體需求     |
| ------------------------------------------------- | -------------------------- | ------------ |
| [program-end](program/program-end/)               | 明確結束 EV3 程式          | 顯示器       |
| [brick-status](program/brick-status/)             | 本體名稱、電量、時間與 LED | 顯示器與 LED |
| [battery-under-load](program/battery-under-load/) | 負載下的電量、電壓與電流   | 馬達 A       |

## 專案

| 範例                                               | 學習內容                            | 硬體需求                      |
| -------------------------------------------------- | ----------------------------------- | ----------------------------- |
| [include-settings](projects/include-settings/)     | 一個省略副檔名的 `Include` 與共用值 | 馬達 A 與 D                   |
| [include-multiple](projects/include-multiple/)     | 多個專案相對路徑的 `.bpi` 檔        | 馬達 A                        |
| [include-behaviors](projects/include-behaviors/)   | 兩個 `.bpi` 共用馬達設定與 RGB 輸出 | 中型馬達 A、B；顏色感測器接 1 |
| [import-functions](projects/import-functions/)     | 匯入 `.bpm` Function 的回傳值       | 顯示器                        |
| [import-module](projects/import-module/)           | 匯入模組中的 private helper         | 顯示器                        |
| [import-calibration](projects/import-calibration/) | 匯入函式將值限制在 0–100            | 顯示器                        |
| [nested-imports](projects/nested-imports/)         | 引用檔加上模組互相匯入              | 顯示器                        |

## 馬達

| 範例                                               | 學習內容                     | 硬體需求        |
| -------------------------------------------------- | ---------------------------- | --------------- |
| [motor-move](motors/motor-move/)                   | 阻塞式移動、等待與煞車       | 馬達 A 與 D     |
| [motor-start-stop](motors/motor-start-stop/)       | 持續啟動馬達後安全停止       | 馬達 A 與 D     |
| [motor-reverse](motors/motor-reverse/)             | 負速度與反向移動             | 馬達 A          |
| [motor-sequence](motors/motor-sequence/)           | 依序執行兩次阻塞式移動       | 馬達 A 與 D     |
| [motor-counter](motors/motor-counter/)             | 讀取馬達編碼器並以 `If` 分支 | 馬達 A          |
| [motor-steer-sync](motors/motor-steer-sync/)       | 協調轉向與同步移動           | 馬達 A 與 D     |
| [motor-schedule](motors/motor-schedule/)           | 帶加減速的排程移動           | 馬達 A 與 D     |
| [power-ramp](motors/power-ramp/)                   | 有限次的開迴路功率漸增       | 馬達 A          |
| [encoder-profile](motors/encoder-profile/)         | 功率排程中記錄編碼器取樣     | 馬達 A          |
| [polarity-feedback](motors/polarity-feedback/)     | 反轉極性、讀取回饋並恢復     | 馬達 A          |
| [steering-lifecycle](motors/steering-lifecycle/)   | 連續、阻塞與排程轉向         | 同型馬達 A 與 D |
| [sync-lifecycle](motors/sync-lifecycle/)           | 連續、阻塞與排程同步         | 同型馬達 A 與 D |
| [paired-trajectories](motors/paired-trajectories/) | 先排程兩顆馬達再等待         | 馬達 A 與 D     |

## 感測器

| 範例                                                      | 學習內容                            | 硬體需求                                 |
| --------------------------------------------------------- | ----------------------------------- | ---------------------------------------- |
| [sensor-threshold](sensors/sensor-threshold/)             | 等待、讀取百分比並選擇回饋          | 觸碰感測器接 1                           |
| [sensor-sampling](sensors/sensor-sampling/)               | 在有限迴圈中重複取樣                | 觸碰感測器接 1                           |
| [color-sensor](sensors/color-sensor/)                     | 以 Color 模式讀取顏色               | 顏色感測器接 1                           |
| [gyro-sensor](sensors/gyro-sensor/)                       | 以 Angle 模式讀取旋轉角度           | 陀螺儀感測器接 1                         |
| [sensor-details](sensors/sensor-details/)                 | 感測器身分、模式與原始值            | 任一感測器接 4                           |
| [raw-and-mode](sensors/raw-and-mode/)                     | 選擇模式後讀取原始通道              | 顏色感測器接 4                           |
| [three-zone-light](sensors/three-zone-light/)             | 反射光的兩個門檻邊界                | 顏色感測器接 1                           |
| [five-sample-average](sensors/five-sample-average/)       | 以浮點累加器平均五次取樣            | 顏色感測器接 1                           |
| [mode-inspector](sensors/mode-inspector/)                 | 身分、忙碌旗標與模式切換            | 顏色感測器接 1                           |
| [raw-channel-dashboard](sensors/raw-channel-dashboard/)   | 百分比與多通道原始值                | 顏色感測器接 1                           |
| [rgb-function](sensors/rgb-function/)                     | RGB 模式與三個輸出通道              | 顏色感測器接 1                           |
| [port-raw-access](sensors/port-raw-access/)               | 指定埠 `Sensor1`–`Sensor4` 原始讀值 | 顏色感測器接 1；2–4 接支援原始值的感測器 |
| [touch-port-grid](sensors/touch-port-grid/)               | 讀取並顯示四個輸入埠                | 1–4 各接觸碰感測器                       |
| [i2c-registers](sensors/i2c-registers/)                   | 讀取文件化的 I2C 暫存器             | 接在 1 的已知 I2C 裝置                   |
| [i2c-register-workbench](sensors/i2c-register-workbench/) | 單筆與多筆暫存器讀寫                | 接在 1 的自製 I2C 測試裝置               |

## HiTechnic

| 範例                                                | 學習內容                   | 硬體需求                                |
| --------------------------------------------------- | -------------------------- | --------------------------------------- |
| [compass-heading](hitechnic/compass-heading/)       | 雙位元組方位與正負環繞誤差 | HiTechnic 羅盤接 1                      |
| [infrared-direction](hitechnic/infrared-direction/) | AC 方向與區段強度          | HiTechnic IRSeeker V2 接 2 與紅外線信標 |

## 串接

| 範例                                                | 學習內容                   | 硬體需求            |
| --------------------------------------------------- | -------------------------- | ------------------- |
| [two-brick-control](daisy-chain/two-brick-control/) | 分層定址的輸入 5 與馬達 A2 | 兩台 USB 串接的 EV3 |

## 整合專題

| 範例                                                      | 學習內容                        | 硬體需求                    |
| --------------------------------------------------------- | ------------------------------- | --------------------------- |
| [button-car](capstones/button-car/)                       | 用本體按鍵駕駛雙馬達小車        | 本體按鍵；馬達 A 與 D       |
| [sensor-dashboard](capstones/sensor-dashboard/)           | 視覺化的感測器百分比儀表板      | 顏色感測器接 1              |
| [obstacle-rover](capstones/obstacle-rover/)               | 觸碰感測器按下時停車            | 觸碰感測器接 1；馬達 A 與 D |
| [scheduled-action-loop](capstones/scheduled-action-loop/) | 感測器驅動的馬達動作與 LED 回饋 | 觸碰感測器接 1；馬達 A      |

## 模擬

| 範例                                                   | 學習內容                       | 硬體需求         |
| ------------------------------------------------------ | ------------------------------ | ---------------- |
| [differential-route](simulation/differential-route/)   | 編碼器控制直行與 90° 轉彎      | 模擬器，不需 EV3 |
| [omni-lateral](simulation/omni-lateral/)               | 四輪全向底盤的橫移與直行       | 模擬器，不需 EV3 |
| [vision-search](simulation/vision-search/)             | 合成視覺搜尋，並檢查感測器身分 | 模擬器，不需 EV3 |
| [pixy2-search](simulation/pixy2-search/)               | Pixy2 LEGO I2C 色碼數量與色塊  | 模擬器，不需 EV3 |
| [motor-shooter](simulation/motor-shooter/)             | 以馬達行程發射附近的球         | 模擬器，不需 EV3 |
| [mailbox-cooperation](simulation/mailbox-cooperation/) | 兩個入口交換目標與回覆         | 模擬器，不需 EV3 |

## 基準測試

| 範例                                             | 學習內容                         | 硬體需求 |
| ------------------------------------------------ | -------------------------------- | -------- |
| [compute-and-draw](benchmarks/compute-and-draw/) | 算術、三角函數、排序、矩陣與計時 | 顯示器   |
