# Encoder profile / 編碼器曲線

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Reset count, schedule power, record encoder samples and draw／歸零、功率排程、記錄編碼器與繪圖

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Motor A with clear mechanism.／馬達 A 機構保持可自由轉動。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"motorCounts": [0, 20, 40, 60]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Last count: 60"]`
- UI_DRAW.PIXEL args: `[[1, 10, 90], [1, 30, 80], [1, 50, 70], [1, 70, 60]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
