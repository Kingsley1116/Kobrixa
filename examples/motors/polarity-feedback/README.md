# Motor polarity and feedback / 馬達極性與回饋

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Invert twice, read speed/count and restore polarity／反轉兩次、讀取速度角度並恢復極性

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Motor A; inversion persists until restored. Wheels must be raised.／馬達 A，反轉設定需恢復；先架高輪子。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"motorSpeed": -20, "motorCount": -30}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Speed: -20", "Count: -30"]`
- OUTPUT_POLARITY args: `[[0, 1, 0], [0, 1, 0]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
