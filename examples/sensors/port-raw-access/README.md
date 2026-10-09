# Port-specific raw access / 指定埠原始值存取

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Sensor1–4 Raw1/Raw3 and numeric outputs／Sensor1–4 Raw1、Raw3 與數字輸出

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Color sensor input 1; raw-capable sensors on inputs 2–4.／輸入 1 接顏色感測器，2–4 接支援原始讀值的感測器。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"rawValues": [24, 48, 96]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["24,48,96", "One: 24", "Two: 24", "Three: 24", "Four: 24"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
