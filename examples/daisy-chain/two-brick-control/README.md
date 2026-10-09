# Two-brick control / 雙本體串接控制

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Layer-aware input 5 and motor A2; start/stop branches／輸入 5 與馬達 A2 的分層定址與啟停分支

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Two EV3 bricks configured for USB daisy chain; touch sensor input 1 and motor A on second brick.／兩台 EV3 設定 USB daisy chain，觸碰感測器與馬達接第二台的輸入 1、輸出 A。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"sensor": 100}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Remote: 100"]`
- INPUT_READ args: `[[1, 0, 0, -1]]`
- OUTPUT_SPEED args: `[[1, 1, 20]]`
- OUTPUT_STOP args: `[[1, 1, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"sensor": 0}`。
