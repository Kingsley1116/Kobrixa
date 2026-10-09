# Finite countdown / 有限倒數

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Subtract two clock readings and distinguish requested waits from wall-clock duration.／以兩次時鐘讀值相減，區分要求的等待時間與實際經過時間。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 display; no external hardware.／EV3 螢幕；不需外接硬體。

## Expected result / 預期結果

`Count: 3`, `Count: 2`, `Count: 1`; simulated elapsed is `Elapsed: 750` ms. Real elapsed includes instruction and display time.／模擬耗時為 `Elapsed: 750` 毫秒；實機另包含指令與顯示耗時。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
