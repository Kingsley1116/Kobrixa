# Byte sequence round trip / 位元組序列讀寫

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Verify three sequential reads, including a zero byte; close both file handles.／驗證包含零位元組的三次循序讀取，並關閉讀寫檔案控制代碼。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 display and filesystem; overwrites `byte-sequence.bin` under `/home/root/lms2012/prjs/`.／EV3 螢幕與檔案系統；覆寫`/home/root/lms2012/prjs/` 中的 `byte-sequence.bin`。

## Expected result / 預期結果

`Bytes: 0,42,127`

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
