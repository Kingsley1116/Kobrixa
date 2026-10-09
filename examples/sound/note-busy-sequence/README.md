# Note and busy sequence / 音符與忙碌狀態序列

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Named note, numeric tone, busy polling and ready wait／音名、頻率、忙碌輪詢與等待

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 speaker.／EV3 揚聲器。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Melody complete"]`
- SOUND.TONE args: `[[15, 294, 120], [15, 440, 120]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
