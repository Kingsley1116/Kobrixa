# Scheduled action loop / 排程動作迴圈

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Finite sensor-driven motor actions plus periodic LED feedback／有限感測馬達動作與週期 LED 回饋

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Touch sensor input 1, motor A with raised wheels.／觸碰感測器輸入 1、馬達 A，先架高輪子。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"sensorValues": [0, 100, 100, 0]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Elapsed: 100"]`
- OUTPUT_SPEED args: `[[0, 1, 18], [0, 1, 18]]`
- OUTPUT_STOP args: `[[0, 1, 1], [0, 1, 1], [0, 1, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
