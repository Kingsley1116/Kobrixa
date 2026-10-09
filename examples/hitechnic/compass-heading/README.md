# Compass heading error / 羅盤方位誤差

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Two-byte compass heading and signed wraparound／雙位元組方位與正負環繞誤差

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

HiTechnic NXT Compass input 1; 7-bit address 1, registers 0x42–0x43. Keep level and away from motors.／HiTechnic NXT 羅盤接輸入 1，7-bit 位址 1，暫存器 0x42–0x43；保持水平並遠離馬達。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"i2cReplies": [[175, 1]]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Heading: 351", "Error: 19"]`
- INPUT_DEVICE.SETUP request: `[[1, 66]]`
- INPUT_DEVICE.SETUP port: `[0]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"i2cReplies": [[10, 0]]}`。
