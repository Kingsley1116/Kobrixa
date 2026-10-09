# Matrix multiplication / 矩陣乘法

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Row-major 2×2 matrices: [[1,2],[3,4]] × [[5,6],[7,8]]. The three dimensions are result rows, result columns, and shared inner dimension.／以列優先儲存 2×2 矩陣；三個維度參數依序為結果列數、結果欄數及共用內積維度。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 display; no external hardware.／EV3 螢幕；不需外接硬體。

## Expected result / 預期結果

`19,22`, `43,50`

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
