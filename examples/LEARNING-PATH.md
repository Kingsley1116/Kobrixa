# Kobrixa learning path / Kobrixa 學習路徑

Follow the lessons in this order for a complete EV3 course. Each project can be opened directly in Kobrixa and built independently.／依此順序完成完整 EV3 課程；每個專案皆可直接在 Kobrixa 開啟並獨立建置。

1. **Start safely / 安全入門:** [hello-ev3](getting-started/hello-ev3/), [display-write](display/display-write/), [speaker-scale](sound/speaker-scale/). Expected result: text, a line, and sound from the brick.／預期結果：本體顯示文字與線條，並播放聲音。
2. **Interact / 互動:** [button-feedback](buttons/button-feedback/), [double-buffer-animation](display/double-buffer-animation/), [timer-slots](time/timer-slots/). Challenge: animate only after Enter is pressed.／挑戰：僅在按下 Enter 後播放動畫。
3. **Think in Basic Plus / Basic Plus 思維:** [control-flow](control-flow/control-flow/), [break-and-continue](control-flow/break-and-continue/), [local-functions](language/local-functions/), [import-module](projects/import-module/).
4. **Read the robot / 讀取機器人:** [sensor-details](sensors/sensor-details/), [raw-and-mode](sensors/raw-and-mode/), [sensor-dashboard](capstones/sensor-dashboard/). Connect the documented sensor to input 1 before running.／執行前請依文件將感測器接至輸入埠 1。
5. **Move safely / 安全移動:** [motor-move](motors/motor-move/), [motor-schedule](motors/motor-schedule/), [button-car](capstones/button-car/), [obstacle-rover](capstones/obstacle-rover/). Lift the wheels for first execution.／第一次執行時請架高輪子。
6. **Persist, communicate, and extend / 保存、通訊與擴充:** [file-round-trip](files/file-round-trip/), [binary-record](files/binary-record/), [mailbox-local](mailboxes/mailbox-local/), [thread-mutex](concurrency/thread-mutex/), [original-media](media/original-media/).

## Common recovery / 常見排除

- If a motor lesson moves unexpectedly, stop the EV3 program, disconnect power, check ports, then retry with the wheels raised.／馬達行為異常時，停止 EV3 程式、斷電、確認連接埠，並在架高輪子後重試。
- If media is missing, run `pnpm assets:build`, rebuild the media project, then upload again; deployment sends assets before the `.rbf`.／媒體缺失時，執行 `pnpm assets:build`、重新建置媒體專案再上傳；部署會先傳送素材再傳送 `.rbf`。
- Cross-brick mailboxes, Daisy-chain, and third-party sensors are intentionally not part of this core course.／跨主機 mailbox、Daisy-chain 與第三方感測器刻意不列入本核心課程。

## Practice / 練習

The [examples index](README.md) groups every lesson by category. It covers boundary cases, algorithms, numeric and string data, and finite hardware programs. Start with loop boundaries, then algorithms, functions and collections; run sensor and motor lessons only with the listed devices.／[範例索引](README.zh-TW.md)依分類列出所有課程，其中包含邊界情況、演算法、數字與文字資料及有限次硬體程式。建議依序練習迴圈邊界、演算法、函式及集合，最後再接上指定裝置執行感測器與馬達課程。
