# Button-controlled cursor / 按鍵控制游標

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Button-driven state, double-buffered animation and exit／按鍵狀態、雙緩衝動畫與離開

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"buttons": [4]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.FILLCIRCLE args: `[[1, 45, 50, 8], [1, 50, 50, 8], [1, 55, 50, 8]]`
- UI_DRAW.UPDATE args: `[[], [], []]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
