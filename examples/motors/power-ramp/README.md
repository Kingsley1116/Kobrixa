# Power ramp / 功率漸增

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Bound continuous motor commands with finite delays and an explicit brake.／使用有限次等待及明確煞車，限制連續馬達命令。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

Motor A; raise the wheels and keep the mechanism clear before running. Power is open-loop and does not guarantee rotation at low settings.／連接馬達 A；執行前架高輪子並清空機構周圍。功率控制為開迴路，低設定不保證轉動。

## Expected result / 預期結果

Motor A receives power `10,20,30`, each followed by 100 ms; final command brakes A.／馬達 A 功率依序為 10、20、30，各持續 100 毫秒；最後煞車。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
