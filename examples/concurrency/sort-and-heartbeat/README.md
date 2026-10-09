# Sort and heartbeat / 排序與背景心跳

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Concurrent finite worker while sorting, then join／排序時執行有限背景工作並等待完成

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Sorted: 1,9"]`
- UI_WRITE.LED args: `[[1], [1], [1]]`
- scheduler.contextSwitches ≥ 1
- scheduler.threadsStarted: `1`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"quantum": 1}`, `{"quantum": 2}`, `{"quantum": 11}`。
