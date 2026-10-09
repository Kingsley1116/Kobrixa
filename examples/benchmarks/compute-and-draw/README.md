# Compute and draw benchmark / 運算繪圖基準

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Arithmetic, trigonometry, arrays, sort, matrices and elapsed timing／算術、三角函數、陣列排序矩陣與計時

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display; no external devices.／EV3 螢幕，不需外接裝置。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"randomValues": [7, 3, 11, 2]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Score: 78", "Norm2: 30", "Sin: 1", "Random: 23", "Time: 0"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"randomValues": [1, 1, 1, 1]}`, `{"randomValues": [12, 12, 12, 12]}`。

The zero elapsed time is a model value; EV3 execution time and random totals vary. This is a small teaching benchmark, not a reproduction of another benchmark score.／0 毫秒是模型值；EV3 執行時間與隨機總和會改變。本例是小型教學基準，不重現其他基準的分數。
