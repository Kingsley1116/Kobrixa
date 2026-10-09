# Held-button drive / 按住按鍵驅動

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Current button string chooses power; finite polling and stop／以目前按鍵字串選擇功率，有限輪詢並停止

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Hold Up/Down; motor A must be clear.／按住上／下鍵，確保馬達 A 可自由轉動。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"buttons": [1]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Drive complete"]`
- OUTPUT_POWER args: `[[0, 1, 20], [0, 1, 20], [0, 1, 20]]`
- OUTPUT_STOP args: `[[0, 1, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
