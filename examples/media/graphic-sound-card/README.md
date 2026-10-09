# Graphic and sound card / 圖形音效卡

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Bundled original RGF/RSF assets and playback／原創 RGF、RSF 素材與播放

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

EV3 display/speaker; deploy both bundled assets.／EV3 螢幕與揚聲器，需部署附帶的兩項素材。

## Expected result / 預期結果

- UI_DRAW.BMPFILE args: `[[1, 0, 0, "/home/root/lms2012/prjs/assets/card.rgf"]]`
- SOUND.PLAY args: `[[20, "assets/ping"]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

The card and sound are reused from Kobrixa’s independently authored original-media assets. Deploy the entire project, including `assets/`.／圖卡與音效沿用 Kobrixa 原創素材；請部署完整專案及 `assets/`。
