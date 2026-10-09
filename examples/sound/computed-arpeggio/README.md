# Computed arpeggio / 計算琶音

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Derive tone parameters from a loop variable and wait for each note to complete.／從迴圈變數計算音高，等待每個音符播放完成。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 speaker.／EV3 揚聲器。

## Expected result / 預期結果

Tone frequencies `220,440,660` Hz at volume 15 for 100 ms each; three waits, then stop.／音高依序為 220、440、660 Hz，音量 15、每音 100 毫秒；等待三次後停止。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
