# Kobrixa 範例

這 119 個專案均為 Kobrixa 原創範例，從只使用顯示器的入門程式，逐步進展到本機機器人模擬及需要連接 EV3 硬體的程式。

<a href="./algorithms/">演算法</a> · <a href="./getting-started/">入門</a> · <a href="./capstones/">整合專題</a> · <a href="./display/">顯示</a> · <a href="./sound/">聲音</a> · <a href="./media/">媒體</a> · <a href="./time/">時間</a> · <a href="./buttons/">按鍵</a> · <a href="./control-flow/">控制流程</a> · <a href="./language/">語言</a> · <a href="./collections/">集合</a> · <a href="./concurrency/">並行</a> · <a href="./files/">檔案</a> · <a href="./mailboxes/">信箱</a> · <a href="./program/">程式</a> · <a href="./projects/">專案</a> · <a href="./motors/">馬達</a> · <a href="./sensors/">感測器</a>

| 分類     | 範例                                                       | 學習內容                              | 硬體需求                |
| -------- | ---------------------------------------------------------- | ------------------------------------- | ----------------------- |
| 入門     | [hello-ev3](getting-started/hello-ev3/)                    | 文字、線條、音調與等待                | 顯示器與喇叭            |
| 顯示     | [display-write](display/display-write/)                    | 使用 `LCD.Write` 顯示簡單黑色文字     | 顯示器                  |
| 顯示     | [display-fonts](display/display-fonts/)                    | Tiny、Small 與 Big 三種字型           | 顯示器                  |
| 顯示     | [display-shapes](display/display-shapes/)                  | 線條、同心圓與座標                    | 顯示器                  |
| 聲音     | [speaker-scale](sound/speaker-scale/)                      | 以算術產生四個遞升音調                | 喇叭                    |
| 聲音     | [speaker-interrupt](sound/speaker-interrupt/)              | 提前停止長音調                        | 喇叭                    |
| 聲音     | [speaker-melody](sound/speaker-melody/)                    | 具名音符與 `Speaker.Wait`             | 喇叭                    |
| 按鍵     | [button-feedback](buttons/button-feedback/)                | 清除、等待並辨識按鍵                  | EV3 本體按鍵            |
| 控制流程 | [control-flow](control-flow/control-flow/)                 | 變數、算術、`For` 與繪圖              | 顯示器與喇叭            |
| 控制流程 | [while-loop](control-flow/while-loop/)                     | 有限次數的 `While` 迴圈               | 顯示器                  |
| 控制流程 | [if-elseif](control-flow/if-elseif/)                       | `If`／`ElseIf`／`Else`                | 顯示器與喇叭            |
| 控制流程 | [boolean-logic](control-flow/boolean-logic/)               | 布林值、`And` 與 `Not`                | 顯示器與喇叭            |
| 控制流程 | [comparison-operators](control-flow/comparison-operators/) | 括號、`>=`、`<>` 與複合條件           | 顯示器                  |
| 控制流程 | [nested-control](control-flow/nested-control/)             | 在 `For` 中使用巢狀 `If`              | 顯示器                  |
| 控制流程 | [labels-and-goto](control-flow/labels-and-goto/)           | Label、向前 `Goto` 與 relocation      | 顯示器與喇叭            |
| 控制流程 | [break-and-continue](control-flow/break-and-continue/)     | 提早結束或略過迴圈迭代                | 顯示器                  |
| 語言     | [case-insensitive](language/case-insensitive/)             | 混合大小寫的關鍵字、變數與 API        | 顯示器                  |
| 語言     | [text-and-math](language/text-and-math/)                   | 文字組合與數學函式                    | 顯示器                  |
| 語言     | [byte-logic](language/byte-logic/)                         | 位元遮罩與十六進位格式化              | 顯示器                  |
| 集合     | [row-vector](collections/row-vector/)                      | 固定 Row 與數字 Vector                | 顯示器                  |
| 並行     | [thread-mutex](concurrency/thread-mutex/)                  | 背景 Sub、mutex 與讓出執行權          | 顯示器與 LED            |
| 檔案     | [file-round-trip](files/file-round-trip/)                  | 寫入並讀取 EV3 專案檔案               | 顯示器；會寫入 EV3 檔案 |
| 信箱     | [mailbox-local](mailboxes/mailbox-local/)                  | 建立具名收件匣並輪詢                  | 可選第二台 EV3          |
| 程式     | [program-end](program/program-end/)                        | 明確結束 EV3 程式                     | 顯示器                  |
| 程式     | [brick-status](program/brick-status/)                      | 主機名稱、電池、時間與 LED            | 顯示器與 EV3 本體       |
| 專案     | [include-settings](projects/include-settings/)             | 單一省略副檔名的 `Include` 與共用數值 | A、D 馬達須能安全轉動   |
| 專案     | [include-multiple](projects/include-multiple/)             | 多個專案相對 `.bpi` 檔案              | A 馬達須能安全轉動      |
| 專案     | [import-functions](projects/import-functions/)             | 匯入 `.bpm` Function 回傳值           | 顯示器                  |
| 馬達     | [motor-move](motors/motor-move/)                           | 阻塞式移動、等待與煞車                | A、D 馬達               |
| 馬達     | [motor-start-stop](motors/motor-start-stop/)               | 持續啟動馬達後安全停止                | A、D 馬達               |
| 馬達     | [motor-reverse](motors/motor-reverse/)                     | 負速度與反向移動                      | A 馬達                  |
| 馬達     | [motor-sequence](motors/motor-sequence/)                   | 依序執行兩次阻塞式移動                | A、D 馬達               |
| 馬達     | [motor-counter](motors/motor-counter/)                     | 讀取馬達編碼器並以 `If` 分支          | A 馬達                  |
| 馬達     | [motor-steer-sync](motors/motor-steer-sync/)               | 協調轉向與同步移動                    | A、D 馬達               |
| 感測器   | [sensor-threshold](sensors/sensor-threshold/)              | 等待、讀取百分比並選擇回饋            | 輸入埠 1 的觸碰感測器   |
| 感測器   | [sensor-sampling](sensors/sensor-sampling/)                | 在有限迴圈內重複取樣感測器            | 輸入埠 1 的觸碰感測器   |
| 感測器   | [color-sensor](sensors/color-sensor/)                      | 在 Color 模式讀取辨識到的顏色代號     | 輸入埠 1 的顏色感測器   |
| 感測器   | [gyro-sensor](sensors/gyro-sensor/)                        | 在 Angle 模式讀取旋轉角度             | 輸入埠 1 的陀螺儀       |
| 感測器   | [sensor-details](sensors/sensor-details/)                  | 感測器身分、模式與原始讀值            | 輸入埠 1 的感測器       |

每個分類現在都是 `examples/` 下的實體資料夾；上表每個連結都會開啟對應的專案資料夾。可在 Kobrixa 開啟專案目錄、`kobrixa.json` 或 `src/main.bp`。連接 EV3 前請先建置；第一次執行馬達範例時，請先架高機器人，確保輪子可安全轉動。

## 延伸課程

### 本機 2D 模擬

<a href="./simulation/">模擬課程</a>附有儲存好的練習場景，不需要 EV3：

- [differential-route](simulation/differential-route/) — 編碼器控制直行與 90° 轉彎。
- [omni-lateral](simulation/omni-lateral/) — 四輪全向底盤的橫移與直行。
- [vision-search](simulation/vision-search/) — 合成視覺搜尋，使用前明確檢查感測器身分。
- [pixy2-search](simulation/pixy2-search/) — Pixy2 LEGO I2C 色碼數量和影像色塊，含相機設定場景。
- [motor-shooter](simulation/motor-shooter/) — 用馬達行程發射附近的球。
- [mailbox-cooperation](simulation/mailbox-cooperation/) — 同專案兩個入口交換目標與完成回覆。

### 其他課程

- [button-car](capstones/button-car/)、[sensor-dashboard](capstones/sensor-dashboard/)、[obstacle-rover](capstones/obstacle-rover/)
- [drawing-primitives](display/drawing-primitives/)、[double-buffer-animation](display/double-buffer-animation/)、[timer-slots](time/timer-slots/)、[original-media](media/original-media/)
- [local-functions](language/local-functions/)、[vector-workbench](collections/vector-workbench/)、[binary-record](files/binary-record/)、[import-module](projects/import-module/)
- [motor-schedule](motors/motor-schedule/)、[raw-and-mode](sensors/raw-and-mode/)、[i2c-registers](sensors/i2c-registers/)

完整教材地圖請見[核心 API 覆蓋](API-COVERAGE.md)，建議的上課順序請見[學習路徑](LEARNING-PATH.md)。

## 新增課程（2026-09-20）

這 20 個新範例有獨立的[字節碼驗證範圍與指令](NEW-EXAMPLES.md)，各自附上雙語執行說明與預期結果。

- [euclidean-gcd](algorithms/euclidean-gcd/) — 輾轉相除法.
- [fibonacci-sequence](algorithms/fibonacci-sequence/) — 費氏數列.
- [prime-count](algorithms/prime-count/) — 質數計數.
- [insertion-sort](algorithms/insertion-sort/) — 插入排序.
- [for-step-boundaries](control-flow/for-step-boundaries/) — For 迴圈邊界.
- [nested-loop-exits](control-flow/nested-loop-exits/) — 巢狀迴圈跳出.
- [compound-arithmetic](language/compound-arithmetic/) — 複合賦值運算.
- [function-outputs](language/function-outputs/) — 函式輸出參數.
- [text-search](language/text-search/) — 文字搜尋與擷取.
- [row-statistics](collections/row-statistics/) — Row 統計.
- [matrix-product](collections/matrix-product/) — 矩陣乘法.
- [byte-sequence](files/byte-sequence/) — 位元組序列讀寫.
- [finite-countdown](time/finite-countdown/) — 有限倒數.
- [fractional-coordinates](display/fractional-coordinates/) — 小數座標.
- [computed-arpeggio](sound/computed-arpeggio/) — 計算琶音.
- [three-zone-light](sensors/three-zone-light/) — 三段反射光分類.
- [five-sample-average](sensors/five-sample-average/) — 五次取樣平均.
- [power-ramp](motors/power-ramp/) — 功率漸增.
- [button-choice](buttons/button-choice/) — 按鍵選擇.
- [import-calibration](projects/import-calibration/) — 匯入校正函式.

## 驗證狀態

語法與參數順序已逐項對照公開的 [CLEV3R English Help](https://github.com/iCheh/Clev3r-1/tree/main/Clever/bin/Release/Help/en)。範例現在使用 `LCD.Text(color, x, y, font, text)`、顏色在前的繪圖呼叫、`Motor.Move(ports, speed, degrees, brake)`、裸寫與舊式帶引號的兩種布林值、從 1 起算的感測器連接埠，以及省略副檔名的 `Include` 路徑。自動測試會解析所有範例、lowering 成 version 1 IR、驗證 IR，並產生結構有效的 `.rbf`；後端回歸測試也依 [LEGO EV3 Firmware Developer Kit](https://assets.education.lego.com/v3/assets/blt293eea581807678a/blt469be1e11ad37696/5f880384f71916144453a49f/lego-mindstorms-ev3-firmware-developer-kit.pdf?locale=en-us)檢查整數 operand、感測器連接埠轉換，以及 `Motor.Move` 的阻塞行為。

因此目前可稱為已通過編譯器與 bytecode 驗證的 v1 candidate；USB／Wi-Fi 上傳及實機執行仍需在指定硬體上完成驗收，尚不宣稱已通過硬體認證。

主題分類參考公開的 CLEV3R 範例目錄（控制流程、函式、include、感測器、馬達、時間、圖形、聲音、檔案、mailbox 與 thread），但此處未納入任何 CLEV3R 程式碼、文件、素材或產生的輸出。每個隨附範例都會經過解析、lowering、IR 驗證及原生 bytecode 編譯；裝置間 mailbox 傳遞與實機驗收仍是另外的執行期檢查。

## Clev3r curriculum expansion / Clev3r 課程擴充

[41-topic coverage and bytecode verification / 41 主題對照與字節碼驗證](CLEV3R-PARITY.md)

<a href="./benchmarks/">Benchmarks / 基準測試</a> · <a href="./daisy-chain/">Daisy chain / 串接</a> · <a href="./hitechnic/">HiTechnic</a>

- [control-flow/loop-exit-matrix](control-flow/loop-exit-matrix/) — 迴圈跳出矩陣
- [language/display-function](language/display-function/) — 顯示函式
- [language/output-pipeline](language/output-pipeline/) — 輸出參數串接
- [sensors/rgb-function](sensors/rgb-function/) — RGB 函式輸入
- [hitechnic/compass-heading](hitechnic/compass-heading/) — 羅盤方位誤差
- [hitechnic/infrared-direction](hitechnic/infrared-direction/) — 紅外線方向與強度
- [projects/include-behaviors](projects/include-behaviors/) — 引用機器人行為
- [projects/nested-imports](projects/nested-imports/) — 巢狀匯入與引用
- [capstones/scheduled-action-loop](capstones/scheduled-action-loop/) — 排程動作迴圈
- [program/battery-under-load](program/battery-under-load/) — 負載下的電池資料
- [concurrency/sort-and-heartbeat](concurrency/sort-and-heartbeat/) — 排序與背景心跳
- [benchmarks/compute-and-draw](benchmarks/compute-and-draw/) — 運算繪圖基準
- [buttons/held-button-drive](buttons/held-button-drive/) — 按住按鍵驅動
- [language/byte-workbench](language/byte-workbench/) — 完整位元組工作台
- [buttons/click-stepper](buttons/click-stepper/) — 點擊步進控制
- [daisy-chain/two-brick-control](daisy-chain/two-brick-control/) — 雙本體串接控制
- [files/typed-record](files/typed-record/) — 混合型別檔案記錄
- [media/graphic-sound-card](media/graphic-sound-card/) — 圖形音效卡
- [getting-started/brick-greeting](getting-started/brick-greeting/) — 本體問候
- [sensors/i2c-register-workbench](sensors/i2c-register-workbench/) — I2C 暫存器工作台
- [mailboxes/paired-receiver](mailboxes/paired-receiver/) — 配對信箱接收端
- [mailboxes/paired-sender](mailboxes/paired-sender/) — 配對信箱發送端
- [media/internal-media-folder](media/internal-media-folder/) — 媒體儲存：prjs
- [media/sd-media-folder](media/sd-media-folder/) — 媒體儲存：sd
- [sound/note-busy-sequence](sound/note-busy-sequence/) — 音符與忙碌狀態序列
- [motors/encoder-profile](motors/encoder-profile/) — 編碼器曲線
- [motors/polarity-feedback](motors/polarity-feedback/) — 馬達極性與回饋
- [motors/steering-lifecycle](motors/steering-lifecycle/) — 轉向控制週期
- [motors/sync-lifecycle](motors/sync-lifecycle/) — 同步控制週期
- [display/button-cursor](display/button-cursor/) — 按鍵控制游標
- [sensors/mode-inspector](sensors/mode-inspector/) — 感測模式檢視器
- [sensors/raw-channel-dashboard](sensors/raw-channel-dashboard/) — 原始通道儀表板
- [concurrency/shared-counters](concurrency/shared-counters/) — 並行共享計數器
- [time/elapsed-intervals](time/elapsed-intervals/) — 經過時間區間
- [sensors/touch-port-grid](sensors/touch-port-grid/) — 觸碰感測器埠格線
- [algorithms/recursive-hanoi](algorithms/recursive-hanoi/) — 遞迴河內塔
- [motors/paired-trajectories](motors/paired-trajectories/) — 雙馬達軌跡
- [collections/vector-toolkit](collections/vector-toolkit/) — 向量工具組
- [collections/row-lifecycle](collections/row-lifecycle/) — Row 完整生命週期
- [sensors/port-raw-access](sensors/port-raw-access/) — 指定埠原始值存取
- [time/independent-timers](time/independent-timers/) — 獨立計時槽
