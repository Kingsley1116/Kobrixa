# Recursive Hanoi / 遞迴河內塔

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Recursive divide-and-conquer moves with a visual board／遞迴分治移動與圖形棋盤

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["0>2", "0>1", "2>1", "0>2", "1>0", "1>2", "0>2", "Moves: 7"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Recursive call groups support 32 simultaneous frames. Overflow displays `Recursion exceeds 32 frames` and stops. This three-disk lesson uses four frames.／遞迴呼叫群組支援同時 32 層；超限會顯示錯誤並停止。本例三個圓盤使用四層。
