# Click-driven stepper / 點擊步進控制

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Flush/wait/consume clicks, inspect held state and move a fixed distance／清除等待消耗點擊、讀目前狀態並定距移動

## Run / 執行

Open this folder in Kobrixa and build `kobrixa.json`.／在 Kobrixa 開啟此資料夾並建置 `kobrixa.json`。

Motor A with clear mechanism; press Enter.／馬達 A 周圍清空，按下確認鍵。

## Expected result / 預期結果

- UI_DRAW.TEXT args.3: `["Click: E", "Held: E"]`
- OUTPUT_STEP_POWER args: `[[0, 1, 20, 0, 90, 0, 1]]`

The audit executes the built RBF with deterministic device models.／稽核以固定裝置模型執行建置後的 RBF。
