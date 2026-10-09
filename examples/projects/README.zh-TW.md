# 專案與 Include

<a href="../README.zh-TW.md">所有範例</a> · <a href="./README.md">English</a>

將程式拆分為專案相對的 `.bpi` 引用檔與 `.bpm` 匯入模組；Include 與 Import 名稱依公開 Basic Plus 語法省略副檔名。

執行會驅動馬達的專案前，請架高機器人，確保馬達可以安全轉動。

## 專案

| 範例                                        | 學習內容                            | 硬體需求                      |
| ------------------------------------------- | ----------------------------------- | ----------------------------- |
| [include-settings](./include-settings/)     | 一個省略副檔名的 `Include` 與共用值 | 馬達 A 與 D                   |
| [include-multiple](./include-multiple/)     | 多個專案相對路徑的 `.bpi` 檔        | 馬達 A                        |
| [include-behaviors](./include-behaviors/)   | 兩個 `.bpi` 共用馬達設定與 RGB 輸出 | 中型馬達 A、B；顏色感測器接 1 |
| [import-functions](./import-functions/)     | 匯入 `.bpm` Function 的回傳值       | 顯示器                        |
| [import-module](./import-module/)           | 匯入模組中的 private helper         | 顯示器                        |
| [import-calibration](./import-calibration/) | 匯入函式將值限制在 0–100            | 顯示器                        |
| [nested-imports](./nested-imports/)         | 引用檔加上模組互相匯入              | 顯示器                        |
