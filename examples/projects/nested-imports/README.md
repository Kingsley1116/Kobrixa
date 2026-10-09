# Nested imports and includes / 巢狀匯入與引用

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Two includes and a module importing another module／兩個引用檔與模組相互匯入

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Range: 42"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
