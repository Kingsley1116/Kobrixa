# Local 2D simulator / 本地 2D 模擬器

<a href="../README.md">English index</a> · <a href="../README.zh-TW.md">繁中索引</a>

Open a project folder in Kobrixa, choose **Local simulator** (Alt+F5), and run its saved `kobrixa.simulator.json`. These practice scenes isolate one lesson on the WRO Double Tennis 2026 field. They are teaching configurations, not certified competition submissions. No EV3 or network connection is needed.

在 Kobrixa 開啟專案資料夾，選擇「**本地模擬器**」（Alt+F5），執行隨附的 `kobrixa.simulator.json`。這些練習場景在 WRO Double Tennis 2026 場地上分別示範一項技能，屬於教學配置，並非經認證的競賽作品。不需要 EV3 或網路連線。

- [differential-route](./differential-route/) — Encoder-based travel and an in-place turn.／編碼器控制直行與原地轉彎。
- [omni-lateral](./omni-lateral/) — Four-wheel lateral motion, forward motion, and rotation.／四輪全向橫移、直行與旋轉。
- [vision-search](./vision-search/) — Search for an orange ball using synthetic vision.／利用合成視覺搜尋橘球。
- [pixy2-search](./pixy2-search/) — Read Pixy2 LEGO I2C color blocks.／讀取 Pixy2 LEGO I2C 色塊。
- [motor-shooter](./motor-shooter/) — Launch a nearby ball with a positive motor stroke.／以正向馬達行程發射附近球體。
- [mailbox-cooperation](./mailbox-cooperation/) — Two program entries exchange a target and completion message.／兩個程式入口交換目標及完成訊息。

Default differential wheels are **B left / C right**, 56 mm diameter and 120 mm track width. The synthetic vision examples check `Sensor.GetName(4)` before using the simulator-only sensor. The ordinary motor examples can also compile for hardware; verify the actual robot's ports and geometry before using Run on EV3.

預設差速輪為 **B 左輪 / C 右輪**，輪徑 56 mm、輪距 120 mm。合成視覺範例會先檢查 `Sensor.GetName(4)`，才使用模擬器專用感測器。一般馬達範例也可編譯供實機使用；使用「在 EV3 執行」前，需確認實際接線與幾何配置。
