# Raw channel dashboard / 原始通道儀表板

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Percent and multichannel raw values with explicit mode／百分比、多通道原始值與明確模式

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Color sensor input 1; reflected-light then RGB mode.／顏色感測器輸入 1，先反射光再 RGB 模式。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"rawValues": [24, 48, 96]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Percent: 42", "24,48,96"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
