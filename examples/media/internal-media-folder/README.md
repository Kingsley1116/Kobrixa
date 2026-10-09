# Media storage: prjs / 媒體儲存：prjs

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Folder directive chooses deployment and relative media base／Folder 選擇部署路徑與相對媒體位置

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Deploy to /home/root/lms2012/prjs/KobrixaCard; internal EV3 project storage.／EV3 內建專案儲存區。

## Expected result / 預期結果

- UI_DRAW.BMPFILE args: `[[1, 0, 0, "/home/root/lms2012/prjs/KobrixaCard/assets/card.rgf"]]`
- SOUND.PLAY args: `[[20, "assets/ping"]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

The card and sound are reused from Kobrixa’s independently authored original-media assets. Deploy the entire project, including `assets/`.／圖卡與音效沿用 Kobrixa 原創素材；請部署完整專案及 `assets/`。

The Folder directive sets the build destination and the UI upload/run path. Keep that destination when deploying; the SD example requires an inserted SD card.／Folder 會設定建置目的地及介面的上傳／執行路徑。部署時保留此路徑；SD 範例需插入 SD 卡。
