# Paired trajectories / 雙馬達軌跡

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Schedule both motors before waiting; compute motion parameters／先排程雙馬達再等待，並計算移動參數

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Motors A and D with mechanisms clear to move.／馬達 A、D 周圍清空。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Path complete"]`
- OUTPUT_STEP_POWER args: `[[0, 1, 20, 0, 60, 0, 1], [0, 8, 25, 0, 120, 0, 1], [0, 1, 20, 0, 45, 0, 1], [0, 8, 25, 0, 90, 0, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
