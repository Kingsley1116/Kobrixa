# Three-zone reflected light / 三段反射光分類

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Read once and test both threshold boundaries; no motors move.／讀取一次並測試兩個門檻的邊界。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 color sensor on input 1, reflected-light mode 0.／輸入埠 1 的 EV3 顏色感測器，反射光模式 0。

## Expected result / 預期結果

`Dark` for 0–29, `Middle` for 30–69, `Bright` for 70–100.／依上述區間顯示暗、中、亮。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
