# Fractional coordinates / 小數座標

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Positive fractional coordinates are converted to integer operands; draw the complete frame before updating.／正小數座標會轉為整數參數；整幀繪製完成後才更新。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 display; no external hardware.／EV3 螢幕；不需外接硬體。

## Expected result / 預期結果

Line `(12,20)→(52,40)`; rectangle `(12,50,40,12)`; circle `(92,40,10)`; exactly one display update.／線段、矩形與圓形座標如左，且僅更新畫面一次。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
