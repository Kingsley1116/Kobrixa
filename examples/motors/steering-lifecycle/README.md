# Steering lifecycle / 轉向控制週期

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Continuous, blocking and scheduled steering／連續、阻塞與排程轉向

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Matched motors A and D, wheels raised.／同型馬達 A、D，架高輪子。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Steering complete"]`
- OUTPUT_STEP_SYNC args: `[[0, 9, 20, 25, 0, 0], [0, 9, 20, -25, 90, 1], [0, 9, 15, 0, 90, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
