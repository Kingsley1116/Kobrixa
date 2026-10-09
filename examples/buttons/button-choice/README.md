# Button choice / 按鍵選擇

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Read button state without an unbounded wait.／直接讀取按鍵狀態，不使用無限等待。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 brick buttons; hold the desired button before starting.／EV3 本體按鍵；啟動前按住所需按鍵。

## Expected result / 預期結果

Hold Left → `Left`; hold Right → `Right`; neither → `Neither`. Left has priority if both are pressed.／按住左鍵顯示 Left、右鍵顯示 Right，皆未按下顯示 Neither；同時按下時左鍵優先。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
