# I2C register workbench / I2C 暫存器工作台

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Single/multiple register reads and writes with round trip／單一多筆暫存器讀寫與回讀

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Advanced: custom I2C register-memory test peripheral on input 1, 7-bit address 42, writable registers 0x10 and 0x20–0x22. Use a level-safe EV3 I2C interface; do not run on an unrelated sensor.／進階：輸入 1 接暫存器記憶體測試周邊，7-bit 位址 42，指定暫存器可寫入；使用符合 EV3 電氣規格的介面，不對無關感測器執行。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"i2cMemory": true}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Single: 175", "128,175,255"]`
- INPUT_DEVICE.SETUP request: `[[42, 16, 175], [42, 16], [42, 32, 128, 175, 255], [42, 32]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
