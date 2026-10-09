# Infrared direction and strength / 紅外線方向與強度

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

AC direction 0–9 and odd/even sector strength／AC 方向 0–9 與奇偶區段強度

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

HiTechnic IRSeeker V2 input 2 and modulated IR beacon; 7-bit address 8, AC direction register 0x49.／IRSeeker V2 接輸入 2，搭配調變紅外線信標；7-bit 位址 8，AC 方向暫存器 0x49。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"i2cReplies": [[4, 10, 40, 60, 20, 5]]}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Direction: 4", "Strength: 50"]`
- INPUT_DEVICE.SETUP request: `[[8, 73]]`
- INPUT_DEVICE.SETUP port: `[1]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"i2cReplies": [[0, 0, 0, 0, 0, 0]]}`, `{"i2cReplies": [[9, 10, 40, 60, 20, 85]]}`。
