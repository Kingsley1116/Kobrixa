# Independent timer slots / 獨立計時槽

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Reset and read independent Time slots 1 and 9／重設讀取互相獨立的 Time 1 與 9

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Timer 1: 50", "Timer 9: 20"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
