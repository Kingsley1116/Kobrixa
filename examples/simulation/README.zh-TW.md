# 本地 2D 模擬器

<a href="../README.zh-TW.md">所有範例</a> · <a href="./README.md">English</a>

在 Kobrixa 開啟專案資料夾，選擇「**本地模擬器**」（Alt+F5），執行隨附的 `kobrixa.simulator.json`。這些練習場景在 WRO Double Tennis 2026 場地上分別示範一項技能，屬於教學配置，並非經認證的競賽作品。不需要 EV3 或網路連線。

預設差速輪為 **B 左輪 / C 右輪**，輪徑 56 mm、輪距 120 mm。合成視覺範例會先檢查 `Sensor.GetName(4)`，才使用模擬器專用感測器。一般馬達範例也可編譯供實機使用；使用「在 EV3 執行」前，需確認實際接線與幾何配置。

## 專案

| 範例                                          | 學習內容                       | 硬體需求         |
| --------------------------------------------- | ------------------------------ | ---------------- |
| [differential-route](./differential-route/)   | 編碼器控制直行與 90° 轉彎      | 模擬器，不需 EV3 |
| [omni-lateral](./omni-lateral/)               | 四輪全向底盤的橫移與直行       | 模擬器，不需 EV3 |
| [vision-search](./vision-search/)             | 合成視覺搜尋，並檢查感測器身分 | 模擬器，不需 EV3 |
| [pixy2-search](./pixy2-search/)               | Pixy2 LEGO I2C 色碼數量與色塊  | 模擬器，不需 EV3 |
| [motor-shooter](./motor-shooter/)             | 以馬達行程發射附近的球         | 模擬器，不需 EV3 |
| [mailbox-cooperation](./mailbox-cooperation/) | 兩個入口交換目標與回覆         | 模擬器，不需 EV3 |
