# Battery under load / 負載下的電池資料

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Level, voltage and current with a bounded load／有界負載下的電量、電壓與電流

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Motor A, raised wheels; voltage/current vary on hardware.／馬達 A 並架高輪子；實機電壓電流會變動。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Level: 75", "Volts: 7.5", "Amps: 0.25"]`
- OUTPUT_STOP args: `[[0, 1, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
