# Paired mailbox receiver / 配對信箱接收端

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Create text and numeric mailboxes, poll and receive both／建立文字與數字信箱、輪詢並接收

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Two Bluetooth-paired EV3 bricks; name this receiver KobrixaPeer, start it before paired-sender.／兩台 EV3 先完成藍牙配對；接收端命名 KobrixaPeer，先啟動此程式再啟動 paired-sender。

## Expected result / 預期結果

Audit inputs / 稽核輸入：`{"mailboxes": {"KobrixaText": "Hello peer", "KobrixaNumber": 12.5}}`。Actual readings follow the connected hardware.／實際讀值隨連接的硬體而變化。

- UI_DRAW.TEXT args.3: `["Hello peer", "Number: 12.5"]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。

Additional scenarios / 額外情境：`{"mailboxes": {}}`。
