# Included robot behaviors / 引用機器人行為

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Two .bpi files share motor settings and RGB outputs／兩個 .bpi 共用馬達設定與 RGB 輸出

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Medium motors A and B clear to move; color sensor input 1.／中型馬達 A 與 B 保持可自由轉動；顏色感測器接輸入 1。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"rawValues": [24, 48, 96]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["RGB total: 168"]`
- OUTPUT_STEP_SPEED args: `[[0, 1, 15, 0, 90, 0, 1]]`
- OUTPUT_SET_TYPE args: `[[0, 0, 8], [0, 1, 8]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
