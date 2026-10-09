# Touch sensor port grid / 觸碰感測器埠格線

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Read all four physical ports and render each state／讀取四個實體埠並顯示狀態

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Four touch sensors on inputs 1–4.／輸入 1–4 各接觸碰感測器。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"sensorValues": [0, 100, 0, 100]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.FILLRECT args: `[[1, 46, 40, 32, 24], [1, 130, 40, 32, 24]]`
- UI_DRAW.RECT args: `[[1, 4, 40, 32, 24], [1, 88, 40, 32, 24]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
