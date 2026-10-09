# Row lifecycle / Row 完整生命週期

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Create, fill, resize, read, size and delete／建立填值、改變大小、讀取、大小與釋放

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Size: 4", "6,9,-3,12"]`
- arrays: `[]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
