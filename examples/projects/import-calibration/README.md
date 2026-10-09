# Imported calibration / 匯入校正函式

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

An imported function keeps values inside 0–100 with early returns while preserving valid fractions.／匯入函式以提早回傳將值限制於 0–100，同時保留有效的小數值。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 display; no external hardware.／EV3 螢幕；不需外接硬體。

## Expected result / 預期結果

`Clamp: 0`, `Clamp: 42.5`, `Clamp: 100`

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
