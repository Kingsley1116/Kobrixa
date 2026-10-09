# RGB function inputs / RGB 函式輸入

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

RGB mode and three output channels／RGB 模式與三通道輸出

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Color sensor input 1, RGB mode 4.／顏色感測器接輸入 1，RGB 模式 4。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"rawValues": [24, 48, 96]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["R: 24", "G: 48", "B: 96"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
