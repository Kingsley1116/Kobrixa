# Paired mailbox sender / 配對信箱發送端

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Connect then transmit matching text and numeric payloads／連線後傳送配對的文字與數字資料

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Run paired-receiver on a Bluetooth-paired brick named KobrixaPeer first.／先在名為 KobrixaPeer 的藍牙配對本體啟動接收端。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Messages sent"]`
- MAILBOX_WRITE args: `[["KobrixaPeer", 0, "KobrixaText", 4, 1, "Hello peer"], ["KobrixaPeer", 0, "KobrixaNumber", 3, 1, 12.5]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
