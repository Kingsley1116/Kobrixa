# Text search and slicing / 文字搜尋與擷取

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Text positions are one-based; a missing search returns zero. Array positions in other lessons are zero-based.／文字位置從 1 起算，找不到時回傳 0；其他課程的陣列索引則從 0 起算。

An oversized slice stops at the end; an out-of-range or zero start returns empty text.／過長擷取範圍會限制於字串尾端；超出範圍或為零的起點回傳空字串。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 display; no external hardware.／EV3 螢幕；不需外接硬體。

## Expected result / 預期結果

`EV3 ready`, `Colon: 4`, `Missing: 0`, `Pattern matched`, `Edge: dy/0`, `Zero: 0`

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
