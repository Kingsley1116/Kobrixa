# Five-sample average / 五次取樣平均

[English index](../../README.md) · [繁中索引](../../README.zh-TW.md)

Average a finite set of samples with a floating-point accumulator.／使用浮點累加器計算有限次取樣的平均。

## Run / 執行

Open this directory or `kobrixa.json` in Kobrixa and build.／在 Kobrixa 開啟此資料夾或 `kobrixa.json` 後建置。

EV3 color sensor on input 1, reflected-light mode 0.／輸入埠 1 的 EV3 顏色感測器，反射光模式 0。

## Expected result / 預期結果

Constant input 42 → `Average: 42`; inputs 10,20,30,40,50 → `Average: 30`. Exactly five samples and five 20 ms waits.／固定輸入 42 顯示 42；遞增輸入顯示 30；取樣五次，每次等待 20 毫秒。

Bytecode is checked with deterministic device inputs; physical execution is a separate acceptance step.／字節碼使用固定裝置輸入驗證；實機執行需另外驗收。
