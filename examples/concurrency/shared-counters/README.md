# Concurrent shared counters / 並行共享計數器

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Two worker threads, main-thread join and mutex-protected shared writes／兩個工作執行緒、主程式等待與互斥共享写入

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Count: 7"]`
- scheduler.contextSwitches ≥ 1
- scheduler.threadsStarted: `2`
- scheduler.contendedCalls ≥ 1

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"quantum": 1}`, `{"quantum": 2}`, `{"quantum": 11}`。
