# Sensor mode inspector / 感測模式檢視器

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Identity, busy flag, mode switching and percentage／身分、忙碌、切換模式與百分比

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Color sensor input 1; switches to ambient-light mode.／輸入 1 接顏色感測器，切換環境光模式。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["EV3-COLOR", "Type: 29", "Mode: 1", "Percent: 42"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
